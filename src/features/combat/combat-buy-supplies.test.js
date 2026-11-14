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

// The combat page's consumables block: a heading, then the grid (hashed class names, like the game's)
function makeBlock({ heading = 'Consumables' } = {}) {
    const wrapper = document.createElement('div');
    let label = null;
    if (heading !== null) {
        label = document.createElement('div');
        label.className = 'BattlePanel_label__x1y2z';
        label.textContent = heading;
        wrapper.appendChild(label);
    }
    const grid = document.createElement('div');
    grid.className = 'BattlePanel_combatConsumables__a1b2c';
    wrapper.appendChild(grid);
    document.body.appendChild(wrapper);
    return { wrapper, label, grid };
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

    test('the button sits beside the heading, on its line, and the heading stays as drawn', () => {
        const { wrapper, label, grid } = makeBlock();
        injectButton(grid);
        injectButton(grid);
        const buttons = wrapper.querySelectorAll('button');
        expect(buttons).toHaveLength(1);
        expect(buttons[0].textContent).toBe('Buy supplies');
        expect(buttons[0].title).toContain('Consumables panel');
        expect(buttons[0].parentElement).toBe(label);
        expect(label.style.display).toBe('');
        expect(label.nextElementSibling).toBe(grid);
    });

    test('a heading is found by shape, in any language', () => {
        const { grid } = makeBlock({ heading: '消耗品' });
        expect(findConsumablesHeading(grid)?.textContent).toBe('消耗品');
    });

    test('no heading before the grid: the button goes just before the grid', () => {
        const { wrapper, grid } = makeBlock({ heading: null });
        injectButton(grid);
        const button = wrapper.querySelector('button');
        expect(button).not.toBeNull();
        expect(button.nextElementSibling).toBe(grid);
    });

    test('a neighbor that is not a short label (icons, long text) is not taken for the heading', () => {
        const withIcon = makeBlock({ heading: 'x' });
        withIcon.label.appendChild(document.createElement('svg'));
        expect(findConsumablesHeading(withIcon.grid)).toBeNull();

        const long = makeBlock({ heading: 'a'.repeat(80) });
        expect(findConsumablesHeading(long.grid)).toBeNull();
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
