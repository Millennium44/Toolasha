/**
 * The action bar's width policy puts `!important` sizing on the header's action name and its
 * ancestors. Everything it sets must be handed back exactly: turning the feature off, leaving
 * the wide state for the compact combat state, and a character change all restore what was
 * there before, and never wipe a value the game wrote.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const settings = vi.hoisted(() => ({ actionBar_compactWidth: false }));
const mobile = vi.hoisted(() => ({ on: false }));

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {} },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentActions: () => [],
        getActionDetails: () => null,
        getInventory: () => [],
        getInitClientData: () => ({ itemDetailMap: {} }),
        getActionDrinkSlots: () => [],
        getElapsedSecondsInCurrentUnit: () => 0,
        getSkills: () => [],
        getEquipment: () => [],
        on: () => () => {},
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => Boolean(settings[key]),
        getSettingValue: (_key, fallback) => fallback,
        COLOR_TEXT_SECONDARY: '#999',
        COLOR_TOOLTIP_INFO: '#abc',
    },
}));

vi.mock('../../utils/mobile.js', () => ({ isMobileMode: () => mobile.on }));

vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, getPrice: () => null, on: () => () => {} },
}));

vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: async () => null }));
vi.mock('../market/profit-calculator.js', () => ({ default: { calculate: async () => null } }));
vi.mock('../market/alchemy-profit-calculator.js', () => ({ default: { calculate: async () => null } }));

const { default: actionTimeDisplay } = await import('./action-time-display.js');

/** grandparent > parent > Header_actionName, as the game nests them. */
function header() {
    const grand = document.createElement('div');
    grand.className = 'Header_header__a';
    const parent = document.createElement('div');
    parent.className = 'Header_actionNameContainer__b';
    const name = document.createElement('div');
    name.className = 'Header_actionName__c';
    parent.appendChild(name);
    grand.appendChild(parent);
    document.body.appendChild(grand);
    return { grand, parent, name };
}

const style = (el) => el.getAttribute('style') || '';

beforeEach(() => {
    document.body.innerHTML = '';
    settings.actionBar_compactWidth = false;
    mobile.on = false;
    actionTimeDisplay.restoreActionBarWidth();
});

describe('action bar width is handed back', () => {
    test('wide state, then disable: every inline size is gone', () => {
        const { parent, name } = header();
        actionTimeDisplay.applyActionBarWidth(name, false);
        expect(name.style.getPropertyValue('width')).toBe('auto');
        expect(parent.style.getPropertyValue('max-width')).toBe('none');

        actionTimeDisplay.disable();

        expect(style(name)).toBe('');
        expect(style(parent)).toBe('');
    });

    test('a value the game had written comes back, not a blank', () => {
        const { parent, name } = header();
        parent.style.setProperty('width', '320px');
        actionTimeDisplay.applyActionBarWidth(name, false);
        expect(parent.style.getPropertyValue('width')).toBe('auto');

        settings.actionBar_compactWidth = true;
        actionTimeDisplay.applyActionBarWidth(name, false);

        expect(parent.style.getPropertyValue('width')).toBe('320px');
        expect(parent.style.getPropertyPriority('width')).toBe('');
    });

    test('compact combat clears only what this module set, never a game value on an ancestor', () => {
        const { grand, parent, name } = header();
        grand.style.setProperty('max-width', '900px');
        actionTimeDisplay.applyActionBarWidth(name, false);

        settings.actionBar_compactWidth = true;
        actionTimeDisplay.applyActionBarWidth(name, true);

        expect(style(name)).toBe('');
        expect(style(parent)).toBe('');
        expect(grand.style.getPropertyValue('max-width')).toBe('900px');
    });

    test('compact combat does not strip a size the game set while we were not touching it', () => {
        const { grand, name } = header();
        settings.actionBar_compactWidth = true;
        grand.style.setProperty('width', '500px');
        actionTimeDisplay.applyActionBarWidth(name, true);
        expect(grand.style.getPropertyValue('width')).toBe('500px');
    });

    test('a value the game rewrote after ours is left alone on restore', () => {
        const { parent, name } = header();
        actionTimeDisplay.applyActionBarWidth(name, false);
        parent.style.setProperty('width', '111px');

        actionTimeDisplay.disable();

        expect(parent.style.getPropertyValue('width')).toBe('111px');
    });

    test('compact, then wide, then compact: the clamp is not left behind', () => {
        const { name } = header();
        settings.actionBar_compactWidth = true;
        actionTimeDisplay.applyActionBarWidth(name, false);
        expect(name.style.getPropertyValue('max-width')).toBe('800px');

        settings.actionBar_compactWidth = false;
        actionTimeDisplay.applyActionBarWidth(name, false);
        expect(name.style.getPropertyValue('max-width')).toBe('none');
        expect(name.style.getPropertyValue('overflow')).toBe('visible');

        actionTimeDisplay.restoreActionBarWidth();
        expect(style(name)).toBe('');
    });

    test('disable while compact restores the clamp', () => {
        const { name } = header();
        settings.actionBar_compactWidth = true;
        actionTimeDisplay.applyActionBarWidth(name, false);
        actionTimeDisplay.disable();
        expect(style(name)).toBe('');
    });

    test('combat ending in wide mode re-opens the parents and leaves the name alone, then restores', () => {
        const { parent, name } = header();
        actionTimeDisplay.applyActionBarWidth(name, true);
        expect(style(name)).toBe('');
        expect(parent.style.getPropertyValue('width')).toBe('auto');
        actionTimeDisplay.applyActionBarWidth(name, false);
        expect(name.style.getPropertyValue('width')).toBe('auto');
        actionTimeDisplay.restoreActionBarWidth();
        expect(style(parent)).toBe('');
        expect(style(name)).toBe('');
    });

    test('a replaced header: restoring the old one is harmless, the new one is sized fresh', () => {
        const first = header();
        actionTimeDisplay.applyActionBarWidth(first.name, false);
        first.grand.remove();
        const second = header();

        actionTimeDisplay.applyActionBarWidth(second.name, false);
        expect(second.name.style.getPropertyValue('width')).toBe('auto');

        expect(() => actionTimeDisplay.restoreActionBarWidth()).not.toThrow();
        expect(style(second.name)).toBe('');
    });

    test('a phone stays compact whatever the setting says', () => {
        const { name } = header();
        mobile.on = true;
        settings.actionBar_compactWidth = false;
        actionTimeDisplay.applyActionBarWidth(name, false);
        expect(name.style.getPropertyValue('max-width')).toBe('800px');
    });

    test('default wide look is unchanged', () => {
        const { parent, name } = header();
        actionTimeDisplay.applyActionBarWidth(name, false);
        for (const el of [name]) {
            expect(el.style.getPropertyValue('overflow')).toBe('visible');
            expect(el.style.getPropertyValue('text-overflow')).toBe('clip');
            expect(el.style.getPropertyValue('white-space')).toBe('nowrap');
            expect(el.style.getPropertyValue('max-width')).toBe('none');
            expect(el.style.getPropertyValue('width')).toBe('auto');
            expect(el.style.getPropertyPriority('width')).toBe('important');
        }
        expect(parent.style.getPropertyValue('overflow')).toBe('visible');
    });
});
