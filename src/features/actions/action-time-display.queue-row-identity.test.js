/**
 * A queue menu row is identified by its "#N" label, not by its text.
 *
 * Each row starts with its 1-based position in `characterActions` sorted by ordinal (#1 is the
 * running action, so the menu's first row is "#2"). That label reads the same in every game
 * language; the row's text does not. The text is kept only as a cross-check.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, vi } from 'vitest';

const game = vi.hoisted(() => ({ details: {} }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getActionDetails: (hrid) => game.details[hrid] ?? null,
        getItemDetails: () => null,
        getInitClientData: () => ({ itemDetailMap: {} }),
        on: () => () => {},
    },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/tooltip-observer.js', () => ({
    default: { register: () => () => {}, onTooltip: () => () => {} },
}));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => false, getSettingValue: (_k, f) => f, COLOR_TOOLTIP_INFO: '#abc' },
}));
vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, getPrice: () => null, on: () => () => {} },
}));
vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: async () => null }));
vi.mock('../market/profit-calculator.js', () => ({ default: { calculate: async () => null } }));
vi.mock('../market/alchemy-profit-calculator.js', () => ({ default: { calculate: async () => null } }));

const actionTimeDisplay = (await import('./action-time-display.js')).default;

game.details = {
    '/actions/crafting/plank': { name: 'Plank', type: '/action_types/crafting', outputItems: [] },
    '/actions/crafting/bow': { name: 'Bow', type: '/action_types/crafting', outputItems: [] },
};

/** characterActions entries as the game sends them; the array order is NOT the queue order. */
const queue = [
    { id: 30, ordinal: 3, actionHrid: '/actions/crafting/bow', characterLoadoutID: 0 },
    { id: 10, ordinal: 1, actionHrid: '/actions/crafting/plank', characterLoadoutID: 0 },
    { id: 20, ordinal: 2, actionHrid: '/actions/crafting/plank', characterLoadoutID: 30284 },
];

function rowFor(text) {
    const el = document.createElement('div');
    el.innerHTML = `
        <div class="QueuedActions_action__item">
            <div class="QueuedActions_actionText__y"><div class="QueuedActions_text__z">${text}</div></div>
        </div>`;
    return el.firstElementChild;
}

describe('queue rows map to actions by their #N label', () => {
    test('the label picks the action in a language the text cannot be read in', () => {
        // #1 (id 10) is running; the menu's rows are #2 and #3
        expect(actionTimeDisplay.matchActionFromDiv(rowFor('#2木板'), queue)?.id).toBe(20);
        expect(actionTimeDisplay.matchActionFromDiv(rowFor('#3弓'), queue)?.id).toBe(30);
    });

    test('identical rows keep their own actions (own loadout) whatever has been used', () => {
        // The second Plank row is #2 and must be id 20 (loadout 30284) even when row #3 is read first
        expect(actionTimeDisplay.matchActionFromDiv(rowFor('#2Plank'), queue, new Set())?.characterLoadoutID).toBe(
            30284
        );
    });

    test('a label whose action the text positively contradicts is left unmapped, not guessed', () => {
        // The queue moved under the open menu: #2 is now a Plank, but the row still says Bow
        expect(actionTimeDisplay.matchActionFromDiv(rowFor('#2Bow'), queue)).toBeNull();
    });

    test('a label past the end of the queue falls back to the text, and an unreadable one stays unmapped', () => {
        expect(actionTimeDisplay.matchActionFromDiv(rowFor('#9Bow'), queue)?.id).toBe(30);
        expect(actionTimeDisplay.matchActionFromDiv(rowFor('#9弓'), queue)).toBeNull();
    });

    test('a row already given to the running action does not take it twice', () => {
        const used = new Set([10]);
        expect(actionTimeDisplay.matchActionFromDiv(rowFor('#1木板'), queue, used)).toBeNull();
    });
});
