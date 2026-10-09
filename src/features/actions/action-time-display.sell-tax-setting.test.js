/**
 * Flipping the personal-use sell-tax setting must redraw an open queue edit menu, with the action
 * bar off or on, so queue rows do not keep figures from the old setting.
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

function changeSetting(key, value) {
    state.settings[key] = value;
    for (const callback of state.listeners.get(key) || []) callback(value);
}

describe('sell-tax setting change and the open queue menu', () => {
    beforeEach(() => {
        state.settings = {};
        state.onClass.clear();
        state.tooltipSubs.clear();
        state.dmHandlers.clear();
        document.body.innerHTML = '';
    });

    afterEach(() => {
        actionTimeDisplay.disable();
    });

    test('redraws the queue menu even when the action bar is off', async () => {
        state.settings = { actionBar_enabled: false, actionQueue: true };
        await actionTimeDisplay.initialize();
        const redraw = vi.spyOn(actionTimeDisplay, 'redrawQueueMenu').mockImplementation(() => {});

        changeSetting('profitCalc_excludeSellTax', true);

        expect(redraw).toHaveBeenCalledTimes(1);
        redraw.mockRestore();
    });

    test('redraws the queue menu and refreshes the bar when the bar is active', async () => {
        state.settings = { actionBar_enabled: true, actionQueue: true };
        await actionTimeDisplay.initialize();
        const redraw = vi.spyOn(actionTimeDisplay, 'redrawQueueMenu').mockImplementation(() => {});
        const update = vi.spyOn(actionTimeDisplay, 'updateDisplay').mockImplementation(() => {});
        actionTimeDisplay.barActive = true;

        changeSetting('profitCalc_excludeSellTax', true);

        expect(redraw).toHaveBeenCalledTimes(1);
        expect(update).toHaveBeenCalled();
        redraw.mockRestore();
        update.mockRestore();
    });
});
