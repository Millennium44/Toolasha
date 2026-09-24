/**
 * The queued-actions annotations are their own settings group and must not depend on the action
 * bar display. With `actionBar_enabled` off, `initialize()` used to return before wiring anything,
 * so every "Queued actions" setting read as on in the settings panel and did nothing.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
    settings: {},
    listeners: new Map(),
    onClass: new Map(),
    tooltipSubs: new Map(),
    dmHandlers: new Map(),
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => Boolean(state.settings[key]),
        getSettingValue: (key, fallback) => (key in state.settings ? state.settings[key] : fallback),
        onSettingChange: (key, callback) => {
            if (!state.listeners.has(key)) state.listeners.set(key, []);
            state.listeners.get(key).push(callback);
        },
        characterSettingsLoaded: true,
        COLOR_TEXT_SECONDARY: '#999',
        COLOR_TOOLTIP_INFO: '#abc',
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentActions: () => [],
        getActionDetails: () => null,
        getInventory: () => [],
        getInitClientData: () => ({ itemDetailMap: {} }),
        getActionDrinkSlots: () => [],
        getSkills: () => [],
        getEquipment: () => [],
        getIsCharacterSwitching: () => false,
        on: (event, handler) => state.dmHandlers.set(event, handler),
        off: (event) => state.dmHandlers.delete(event),
    },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (name, _classes, callback) => {
            state.onClass.set(name, callback);
            return () => state.onClass.delete(name);
        },
    },
}));

vi.mock('../../core/tooltip-observer.js', () => ({
    default: {
        subscribe: (name, callback) => state.tooltipSubs.set(name, callback),
        unsubscribe: (name) => state.tooltipSubs.delete(name),
    },
}));

vi.mock('../networth/item-flow-recorder.js', () => ({
    default: { onChange: () => () => {} },
}));

vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, getPrice: () => null, on: () => () => {} },
}));

vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: async () => null }));
vi.mock('../market/profit-calculator.js', () => ({ default: { calculateProfit: async () => null } }));
vi.mock('../market/alchemy-profit-calculator.js', () => ({ default: { calculate: async () => null } }));

const { default: actionTimeDisplay } = await import('./action-time-display.js');

const QUEUE_OBSERVER = 'ActionTimeDisplay-Queue';
const ACTION_NAME_OBSERVER = 'ActionTimeDisplay-ActionName';
const QUEUE_TOOLTIP = 'queue-tooltip-timing';

/** Fire every listener registered for a setting, as config does on a change. */
function changeSetting(key, value) {
    state.settings[key] = value;
    for (const callback of state.listeners.get(key) || []) callback(value);
}

function editMenu() {
    const el = document.createElement('div');
    el.className = 'QueuedActions_queuedActionsEditMenu__a';
    document.body.appendChild(el);
    return el;
}

describe('queued-actions annotations with the action bar display off', () => {
    beforeEach(() => {
        state.settings = {};
        state.onClass.clear();
        state.tooltipSubs.clear();
        state.dmHandlers.clear();
        document.body.innerHTML = '<div><div class="Header_actionName_abc">Chop Tree (10)</div></div>';
    });

    afterEach(() => {
        actionTimeDisplay.disable();
    });

    test('the queue observers are wired and draw; the bar display is not created', async () => {
        state.settings = { actionBar_enabled: false, actionQueue: true };
        const inject = vi.spyOn(actionTimeDisplay, 'injectQueueTimes');

        await actionTimeDisplay.initialize();

        expect(state.onClass.has(QUEUE_OBSERVER)).toBe(true);
        expect(state.tooltipSubs.has(QUEUE_TOOLTIP)).toBe(true);
        expect(state.dmHandlers.has('character_initialized')).toBe(true);

        const menu = editMenu();
        state.onClass.get(QUEUE_OBSERVER)(menu);
        expect(inject).toHaveBeenCalledWith(menu);

        expect(state.onClass.has(ACTION_NAME_OBSERVER)).toBe(false);
        expect(state.dmHandlers.has('actions_updated')).toBe(false);
        expect(document.getElementById('mwi-action-time-display')).toBeNull();
        inject.mockRestore();
    });

    test('a character switch does not bring the bar display back', async () => {
        state.settings = { actionBar_enabled: false, actionQueue: true };
        await actionTimeDisplay.initialize();

        state.dmHandlers.get('character_initialized')();

        expect(document.getElementById('mwi-action-time-display')).toBeNull();
        expect(state.onClass.has(QUEUE_OBSERVER)).toBe(true);
    });

    test('turning the bar off at runtime removes the bar and keeps the queue observers', async () => {
        state.settings = { actionBar_enabled: true, actionQueue: true };
        await actionTimeDisplay.initialize();
        expect(document.getElementById('mwi-action-time-display')).not.toBeNull();
        expect(state.onClass.has(ACTION_NAME_OBSERVER)).toBe(true);

        changeSetting('actionBar_enabled', false);

        expect(document.getElementById('mwi-action-time-display')).toBeNull();
        expect(state.onClass.has(ACTION_NAME_OBSERVER)).toBe(false);
        expect(state.dmHandlers.has('actions_updated')).toBe(false);
        expect(state.onClass.has(QUEUE_OBSERVER)).toBe(true);
        expect(state.tooltipSubs.has(QUEUE_TOOLTIP)).toBe(true);

        changeSetting('actionBar_enabled', true);

        expect(document.getElementById('mwi-action-time-display')).not.toBeNull();
        expect(state.onClass.has(ACTION_NAME_OBSERVER)).toBe(true);
    });

    test('with the bar and the queue both off, nothing is wired', async () => {
        state.settings = {
            actionBar_enabled: false,
            actionQueue: false,
            actionQueue_showValue: false,
            actionQueue_zoneSimButton: false,
            actionQueue_showXp: false,
            actionPanel_enhanceMatLimitProtections: false,
        };

        expect(actionTimeDisplay.shouldEnable()).toBe(false);
        await actionTimeDisplay.initialize();

        expect(state.onClass.size).toBe(0);
        expect(state.tooltipSubs.size).toBe(0);
        expect(state.dmHandlers.size).toBe(0);
        expect(actionTimeDisplay.isInitialized).toBe(false);
    });

    test('turning off the last of the bar and the queue tears everything down', async () => {
        state.settings = { actionBar_enabled: true, actionQueue: true };
        await actionTimeDisplay.initialize();

        changeSetting('actionQueue', false);
        expect(state.onClass.has(QUEUE_OBSERVER)).toBe(true);

        changeSetting('actionBar_enabled', false);
        expect(state.onClass.size).toBe(0);
        expect(state.tooltipSubs.size).toBe(0);
        expect(actionTimeDisplay.isInitialized).toBe(false);

        changeSetting('actionQueue', true);
        await Promise.resolve();
        expect(state.onClass.has(QUEUE_OBSERVER)).toBe(true);
        expect(state.onClass.has(ACTION_NAME_OBSERVER)).toBe(false);
    });
});
