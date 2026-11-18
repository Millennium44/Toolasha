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
vi.mock('../../utils/bundle-bridge.js', () => ({
    consumablesPanel: () => game.panel,
    guildMemberSkills: () => null,
    marketUndercutAlerts: () => null,
}));

vi.mock('../../utils/toast.js', () => ({ showToast: vi.fn() }));

import config from '../../core/config.js';
import { showToast } from '../../utils/toast.js';
import feature, { injectButton, handleClick } from './labyrinth-missing-supplies.js';

// The entry screen: a wrapper holding the "Supplies" label and the supplies grid.
function makeSuppliesBlock() {
    const wrapper = document.createElement('div');
    wrapper.className = 'LabyrinthPanel_supplies__3n0yg';
    const label = document.createElement('div');
    label.className = 'LabyrinthPanel_label__2xYzA';
    label.textContent = 'Supplies';
    const grid = document.createElement('div');
    grid.className = 'LabyrinthPanel_suppliesGrid__9qPlm';
    wrapper.append(label, grid);
    document.body.appendChild(wrapper);
    return { wrapper, label, grid };
}

// The live entry screen (test server, 2026-11-17): bottomArea > infoContainer > [supplies (label + suppliesGrid),
// crates (label + cratesGrid), buttonsContainer (label + Enter)], beside entryScreen > instructionsPanel >
// instructionsText ("The Labyrinth consists of floors...")
function makeEntryScreen() {
    const tab = document.createElement('div');
    tab.className = 'LabyrinthPanel_labyrinthTab__3_b10';
    tab.innerHTML =
        '<div class="LabyrinthPanel_entryScreen__pOtpK"><div class="LabyrinthPanel_instructionsPanel__1a-j6">' +
        '<div class="LabyrinthPanel_label__2p7tI">Instructions</div>' +
        '<div class="LabyrinthPanel_instructionsText__1zfuT">The Labyrinth consists of floors of skilling and ' +
        'combat challenges.</div></div></div>' +
        '<div class="LabyrinthPanel_bottomArea__t8T1R"><div class="LabyrinthPanel_infoContainer__1LkYc">' +
        '<div class="LabyrinthPanel_supplies__3n0yg"><div class="LabyrinthPanel_label__2p7tI">Supplies</div>' +
        '<div class="LabyrinthPanel_suppliesGrid__30Vqz"></div></div></div></div>';
    document.body.appendChild(tab);
    return tab;
}

describe('labyrinth missing supplies', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        game.panel = { openTab: game.openTab };
        config.getSetting.mockReturnValue(true);
    });

    afterEach(() => {
        feature.disable();
        document.body.innerHTML = '';
    });

    test('live entry screen: the button replaces only the Supplies label, never the description section', () => {
        const tab = makeEntryScreen();
        injectButton(tab.querySelector('[class*="LabyrinthPanel_suppliesGrid"]'));
        const buttons = tab.querySelectorAll('button');
        expect(buttons).toHaveLength(1);
        expect(tab.querySelector('[class*="LabyrinthPanel_entryScreen"]').querySelector('button')).toBeNull();
        expect(buttons[0].closest('[class*="LabyrinthPanel_supplies__"]')).not.toBeNull();
    });

    test('a grid whose parent is not the supplies block is left alone, even with a label further down', () => {
        const tab = makeEntryScreen();
        const grid = tab.querySelector('[class*="LabyrinthPanel_suppliesGrid"]');
        const outer = document.createElement('div');
        outer.className = 'LabyrinthPanel_infoContainer__1LkYc';
        const label = tab.querySelector(
            '[class*="LabyrinthPanel_instructionsPanel"] > [class*="LabyrinthPanel_label"]'
        );
        outer.append(grid, label.cloneNode(true));
        tab.appendChild(outer);
        injectButton(grid);
        expect(document.querySelector('button')).toBeNull();
    });

    test('injectButton puts one button in place of the Supplies label, with the label hidden, not removed', () => {
        const { wrapper, label, grid } = makeSuppliesBlock();
        injectButton(grid);
        injectButton(grid);
        const buttons = wrapper.querySelectorAll('button');
        expect(buttons).toHaveLength(1);
        expect(buttons[0].textContent).toBe('Buy supplies');
        expect(buttons[0].title).toContain('Consumables panel');
        // The button's line takes the heading's own class, sits where it was, and the heading stays in the DOM
        const holder = buttons[0].parentElement;
        expect(holder.className).toBe(label.className);
        expect(label.nextElementSibling).toBe(holder);
        expect(holder.nextElementSibling).toBe(grid);
        expect(label.isConnected).toBe(true);
        expect(label.style.display).toBe('none');
    });

    test('pressing the button opens the Consumables panel on the Labyrinth tab', () => {
        const { grid } = makeSuppliesBlock();
        injectButton(grid);
        document.querySelector('button').click();
        expect(game.openTab).toHaveBeenCalledTimes(1);
        expect(game.openTab).toHaveBeenCalledWith('labyrinth');
    });

    test('pressing before the UI bundle has published the panel says the panel is still loading', () => {
        game.panel = null;
        expect(() => handleClick()).not.toThrow();
        expect(game.openTab).not.toHaveBeenCalled();
        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('still loading'));
    });

    test('a panel that throws is logged, not raised into the page', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        game.openTab.mockImplementationOnce(() => {
            throw new Error('boom');
        });
        const { grid } = makeSuppliesBlock();
        injectButton(grid);
        expect(() => document.querySelector('button').click()).not.toThrow();
        expect(error).toHaveBeenCalled();
    });

    test('initialize sweeps existing grids and watches new ones; disable removes the buttons', () => {
        makeSuppliesBlock();
        feature.initialize();
        expect(document.querySelectorAll('button')).toHaveLength(1);

        const later = makeSuppliesBlock();
        game.gridCallback(later.grid);
        expect(document.querySelectorAll('button')).toHaveLength(2);

        feature.disable();
        expect(game.unregister).toHaveBeenCalled();
        expect(document.querySelectorAll('button')).toHaveLength(0);
        // Every hidden heading shows again, and no empty holder is left behind
        for (const label of document.querySelectorAll('[class*="LabyrinthPanel_label"]')) {
            expect(label.style.display).toBe('');
        }
        expect(document.querySelectorAll('[class*="LabyrinthPanel_label"]')).toHaveLength(2);
    });

    test('does nothing when the setting is off', () => {
        config.getSetting.mockReturnValue(false);
        makeSuppliesBlock();
        feature.initialize();
        expect(document.querySelectorAll('button')).toHaveLength(0);
    });
});
