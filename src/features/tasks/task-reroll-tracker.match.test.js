/** @vitest-environment happy-dom */

/**
 * Matching a task card to the reroll record of its task.
 *
 * The card carries no id, so the match is by name and goal. The names overlap:
 * "Cow" is inside "Verdant Cow", "Tree" inside "Birch Tree". A substring test
 * handed the Verdant Cow card the plain Cow task's reroll spend whenever the
 * goals agreed and the Cow record came first.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../core/storage.js', () => ({
    default: { get: async () => null, set: async () => true, getJSON: async () => null, setJSON: async () => true },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'c1',
        getCurrentCharacterGameMode: () => 'standard',
        getInitClientData: () => ({}),
        characterData: null,
        characterQuests: [],
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true, COLOR_TEXT_SECONDARY: '#888' } }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../utils/dom.js', () => ({ addStyles: () => {} }));

const { default: tracker } = await import('./task-reroll-tracker.js');

/**
 * @param {string} name - The card's task name
 * @param {number} goal - Its goal
 * @returns {Element} A task card
 */
function card(name, goal) {
    const el = document.createElement('div');
    el.innerHTML = `<div class="RandomTask_name__x">${name}</div><div>Progress: 0 / ${goal}</div>`;
    return el;
}

beforeEach(() => {
    tracker.taskRerollData.clear();
});

describe('task card to reroll record', () => {
    test('a Verdant Cow card is not given the plain Cow task', () => {
        tracker.taskRerollData.set(1, { actionHrid: '/actions/milking/cow', goalCount: 100, coinRerollCount: 2 });
        tracker.taskRerollData.set(2, { actionHrid: '/actions/milking/verdant_cow', goalCount: 100 });

        const claimed = new Set();
        expect(tracker.getTaskIdFromElement(card('Milking - Verdant Cow', 100), claimed)).toBe(2);
        expect(tracker.getTaskIdFromElement(card('Milking - Cow', 100), claimed)).toBe(1);
    });

    test('the plain Cow card still matches when no longer name is present', () => {
        tracker.taskRerollData.set(1, { actionHrid: '/actions/milking/cow', goalCount: 100 });
        expect(tracker.getTaskIdFromElement(card('Milking - Cow', 100), new Set())).toBe(1);
    });

    test('a card whose longer-named task is already claimed does not fall back to the shorter one', () => {
        tracker.taskRerollData.set(1, { actionHrid: '/actions/milking/cow', goalCount: 100 });
        tracker.taskRerollData.set(2, { actionHrid: '/actions/milking/verdant_cow', goalCount: 100 });
        const claimed = new Set([2]);
        expect(tracker.getTaskIdFromElement(card('Milking - Verdant Cow', 100), claimed)).toBeNull();
    });
});
