/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const game = vi.hoisted(() => ({
    unregister: vi.fn(),
    gridCallback: null,
    openTab: vi.fn(),
    panel: null,
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: vi.fn(() => true) },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: vi.fn((_name, _cls, cb) => {
            game.gridCallback = cb;
            return game.unregister;
        }),
    },
}));
vi.mock('../../utils/bundle-bridge.js', () => ({ consumablesPanel: () => game.panel }));

import config from '../../core/config.js';
import feature, { injectButton, findConsumablesHeading, handleClick } from './combat-buy-supplies.js';

// The combat page's consumables block as the game draws it (2026-11-14, hashed class names):
// BattlePanel_combatConsumables > BattlePanel_label ("Consumables") + BattlePanel_combatConsumableGrid
function makeBlock({ heading = 'Consumables' } = {}) {
    const grid = document.createElement('div');
    grid.className = 'BattlePanel_combatConsumables__3Za2n';
    let label = null;
    if (heading !== null) {
        label = document.createElement('div');
        label.className = 'BattlePanel_label__x1y2z';
        label.textContent = heading;
        grid.appendChild(label);
    }
    const slots = document.createElement('div');
    slots.className = 'BattlePanel_combatConsumableGrid__q9w8e';
    grid.appendChild(slots);
    document.body.appendChild(grid);
    return { wrapper: grid, label, grid, slots };
}

describe('combat buy supplies button', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        game.panel = { openTab: game.openTab };
        config.getSetting.mockReturnValue(true);
    });

    afterEach(() => {
        feature.disable();
        document.body.innerHTML = '';
    });

    test('the button takes the heading’s place, on its line, and the heading is hidden not removed', () => {
        const { grid, label, slots } = makeBlock();
        injectButton(grid);
        injectButton(grid);
        const buttons = grid.querySelectorAll('button');
        expect(buttons).toHaveLength(1);
        expect(buttons[0].textContent).toBe('Buy supplies');
        expect(buttons[0].title).toContain('Consumables panel');
        const holder = buttons[0].parentElement;
        expect(holder.className).toBe(label.className);
        expect(label.style.display).toBe('none');
        expect(label.nextElementSibling).toBe(holder);
        expect(holder.nextElementSibling).toBe(slots);
    });

    test('a heading is found by class, in any language', () => {
        const { grid } = makeBlock({ heading: '消耗品' });
        expect(findConsumablesHeading(grid)?.textContent).toBe('消耗品');
    });

    test('no heading in the block: the button goes at its top', () => {
        const { grid, slots } = makeBlock({ heading: null });
        injectButton(grid);
        const button = grid.querySelector('button');
        expect(button).not.toBeNull();
        expect(button.nextElementSibling).toBe(slots);
    });

    test('disable takes the button out and shows the heading again', () => {
        config.getSetting.mockReturnValue(true);
        const { grid, label, slots } = makeBlock();
        feature.initialize();
        expect(grid.querySelector('button')).not.toBeNull();
        feature.disable();
        expect(grid.querySelector('button')).toBeNull();
        expect(label.style.display).toBe('');
        expect(label.hasAttribute('data-mwi-combat-supplies-label-hidden')).toBe(false);
        expect([...grid.children]).toEqual([label, slots]);
    });

    test('pressing the button opens the Consumables panel on the Combat tab', () => {
        const { grid } = makeBlock();
        injectButton(grid);
        document.querySelector('button').click();
        expect(game.openTab).toHaveBeenCalledTimes(1);
        expect(game.openTab).toHaveBeenCalledWith('combat');
    });

    test('pressing before the UI bundle has published the panel does nothing and does not throw', () => {
        game.panel = null;
        expect(() => handleClick()).not.toThrow();
        expect(game.openTab).not.toHaveBeenCalled();
    });

    test('a panel that throws is logged, not raised into the page', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        game.openTab.mockImplementationOnce(() => {
            throw new Error('boom');
        });
        const { grid } = makeBlock();
        injectButton(grid);
        expect(() => document.querySelector('button').click()).not.toThrow();
        expect(error).toHaveBeenCalled();
    });

    test('initialize sweeps existing grids and watches new ones; disable removes the buttons and leaves headings alone', () => {
        const first = makeBlock();
        feature.initialize();
        expect(document.querySelectorAll('button')).toHaveLength(1);

        const later = makeBlock();
        game.gridCallback(later.grid);
        expect(document.querySelectorAll('button')).toHaveLength(2);

        feature.disable();
        expect(game.unregister).toHaveBeenCalled();
        expect(document.querySelectorAll('button')).toHaveLength(0);
        expect(first.label.textContent).toBe('Consumables');
        expect(first.label.isConnected).toBe(true);
    });

    test('does nothing when the setting is off', () => {
        config.getSetting.mockReturnValue(false);
        makeBlock();
        feature.initialize();
        expect(document.querySelectorAll('button')).toHaveLength(0);
    });
});
