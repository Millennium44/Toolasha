/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const game = vi.hoisted(() => ({
    unregister: vi.fn(),
    openTab: vi.fn(),
    panel: null,
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: vi.fn(() => true) },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: vi.fn(() => game.unregister) },
}));
vi.mock('../../utils/bundle-bridge.js', () => ({ consumablesPanel: () => game.panel }));
vi.mock('../../utils/toast.js', () => ({ showToast: vi.fn() }));

import config from '../../core/config.js';
import { showToast } from '../../utils/toast.js';
import feature, { injectButton, findConsumablesHeading, handleClick } from './skilling-buy-supplies.js';

// A skill panel's consumables block as the game draws it (2026-11-14, Foraging; Alchemy has the same
// shape with AlchemyPanel_ classes): the heading holds the text and then the tea recommendation buttons
function makeBlock({ prefix = 'GatheringProductionSkillPanel', text = 'Consumables', teaButtons = true } = {}) {
    const container = document.createElement('div');
    container.className = `${prefix}_consumablesContainer__k3j2h`;
    const heading = document.createElement('div');
    heading.className = `${prefix}_label__p0o9i`;
    if (text !== null) heading.appendChild(document.createTextNode(text));
    if (teaButtons) {
        const tea = document.createElement('div');
        tea.className = 'mwi-tea-recommendation-buttons';
        tea.textContent = 'XP';
        heading.appendChild(tea);
    }
    container.appendChild(heading);
    const slots = document.createElement('div');
    slots.className = 'ActionTypeConsumableSlots_actionTypeConsumableSlots__z1x2c';
    container.appendChild(slots);
    document.body.appendChild(container);
    return { container, heading, slots };
}

describe('skilling buy supplies button', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        game.panel = { openTab: game.openTab };
        config.getSetting.mockReturnValue(true);
    });

    afterEach(() => {
        feature.disable();
        document.body.innerHTML = '';
    });

    test('the button stands where the heading’s text was, and the tea buttons stay beside it', () => {
        const { container, heading } = makeBlock();
        injectButton(container);
        injectButton(container);
        const buttons = container.querySelectorAll('button');
        expect(buttons).toHaveLength(1);
        expect(buttons[0].textContent).toBe('Buy supplies');
        expect(buttons[0].parentElement).toBe(heading);
        expect(heading.firstChild).toBe(buttons[0]);
        expect(heading.querySelector('.mwi-tea-recommendation-buttons')).not.toBeNull();
        expect(heading.textContent).toBe('Buy suppliesXP');
    });

    test('Alchemy’s block is handled the same way, and a Chinese heading is found by position', () => {
        const { container, heading } = makeBlock({ prefix: 'AlchemyPanel', text: '消耗品' });
        expect(findConsumablesHeading(container)).toBe(heading);
        injectButton(container);
        expect(heading.firstChild.textContent).toBe('Buy supplies');
    });

    test('disable puts the heading’s text back into the node React holds, and removes the button', () => {
        const { container, heading } = makeBlock();
        const textNode = heading.firstChild;
        feature.initialize();
        expect(textNode.nodeValue).toBe('');
        feature.disable();
        expect(container.querySelector('button')).toBeNull();
        expect(heading.firstChild).toBe(textNode);
        expect(textNode.nodeValue).toBe('Consumables');
        expect(heading.hasAttribute('data-mwi-skilling-supplies-text')).toBe(false);
    });

    test('a block with no heading text gets the button at its top', () => {
        const { container, heading } = makeBlock({ text: null, teaButtons: false });
        injectButton(container);
        expect(container.firstElementChild.textContent).toBe('Buy supplies');
        expect(container.firstElementChild).not.toBe(heading);
    });

    test('setting off: no button', () => {
        config.getSetting.mockReturnValue(false);
        const { container } = makeBlock();
        feature.initialize();
        expect(container.querySelector('button')).toBeNull();
    });

    test('a press opens the Skilling tab; with no readable skill it opens it without one', () => {
        const { container } = makeBlock();
        injectButton(container);
        container.querySelector('button').click();
        expect(game.openTab).toHaveBeenCalledWith('skilling', undefined);
    });

    test('a press reads the block’s skill from React and opens the Skilling tab on it', () => {
        const { container, slots } = makeBlock();
        const root = document.createElement('div');
        root.id = 'root';
        document.body.appendChild(root);
        const slotsFiber = {
            stateNode: slots,
            return: { memoizedProps: { actionTypeHrid: '/action_types/foraging' } },
        };
        root._reactRootContainer = { current: { stateNode: null, child: { stateNode: null, child: slotsFiber } } };
        handleClick(container);
        expect(game.openTab).toHaveBeenCalledWith('skilling', { skill: '/action_types/foraging' });
    });

    test('a press before the UI bundle has published the panel says it is still loading', () => {
        game.panel = null;
        expect(() => handleClick(null)).not.toThrow();
        expect(game.openTab).not.toHaveBeenCalled();
        expect(showToast).toHaveBeenCalledWith(expect.stringContaining('still loading'));
    });
});
