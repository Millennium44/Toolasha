/**
 * @vitest-environment happy-dom
 *
 * The picture on a task card follows the task.
 *
 * Rerolling used to leave it behind. The game keeps the reroll chooser open
 * after a reroll — the same card, now holding a different task, still showing
 * Back / Pay / MooPass Free Reroll — and Toolasha's rule for a card mid-flow is
 * to leave it exactly as the game drew it. That rule is right for everything
 * that sits in the card's own flow, because moving it shifts the button under
 * the player's pending click. It was wrong for the picture: one absolutely
 * positioned, pointer-events:none layer behind the card, which cannot move
 * anything and cannot take a click. So the name said the new task and the
 * picture said the old one, for as long as the player kept rerolling.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const settings = vi.hoisted(() => ({ values: {} }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => settings.values[key] ?? false,
        isFeatureEnabled: (key) => settings.values[key] ?? false,
    },
}));

const GAME_DATA = {
    itemDetailMap: {
        '/items/milk': { name: 'Milk' },
        '/items/cheese': { name: 'Cheese' },
    },
    actionDetailMap: {
        '/actions/milking/cow': { name: 'Cow', outputItems: [{ itemHrid: '/items/milk' }] },
        '/actions/cheesesmithing/cheese': { name: 'Cheese', outputItems: [{ itemHrid: '/items/cheese' }] },
    },
    combatMonsterDetailMap: {},
};

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => GAME_DATA,
        on: () => {},
        off: () => {},
    },
}));

vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../utils/asset-manifest.js', () => ({ default: { fetchManifest: async () => ({}) } }));
vi.mock('./task-icon-filters.js', () => ({ default: { shouldShowDungeonBadge: () => true } }));

// The name→hrid lookup lives in game data the real helper reads from a store
// this test has no business standing up
vi.mock('../../utils/game-lookups.js', () => ({
    getActionHridFromName: (name) =>
        ({ Cow: '/actions/milking/cow', Cheese: '/actions/cheesesmithing/cheese' })[name] || null,
}));

const { default: taskIcons } = await import('./task-icons.js');

const ITEMS_SPRITE = '/static/media/items_sprite.svg';

/**
 * A task card on the board, in whichever step its buttons describe.
 * @param {string} name - The card's task line, e.g. 'Milking - Cow'
 * @param {Array<string>} buttonLabels - Button text for the action row
 * @returns {HTMLElement} The card
 */
function cardOnBoard(name, buttonLabels) {
    const list = document.querySelector('[class*="TasksPanel_taskList"]');

    const card = document.createElement('div');
    card.className = 'RandomTask_randomTask__1abc';

    const content = document.createElement('div');
    content.className = 'RandomTask_content__2def';
    const nameEl = document.createElement('div');
    nameEl.className = 'RandomTask_name__3ghi';
    nameEl.textContent = name;
    content.appendChild(nameEl);
    card.appendChild(content);

    const action = document.createElement('div');
    action.className = 'RandomTask_action__4jkl';
    for (const label of buttonLabels) {
        const button = document.createElement('button');
        button.textContent = label;
        action.appendChild(button);
    }
    card.appendChild(action);

    list.appendChild(card);
    return card;
}

/** What the card's picture is pointing at */
const pictureOf = (card) => card.querySelector('.mwi-task-icon use')?.getAttribute('href') ?? null;

/** Reroll the card in place, the way the game does it: new task, chooser still open */
function rerollInto(card, name, buttonLabels) {
    card.querySelector('[class*="RandomTask_name"]').textContent = name;
    const action = card.querySelector('[class*="RandomTask_action"]');
    action.replaceChildren(
        ...buttonLabels.map((label) => {
            const button = document.createElement('button');
            button.textContent = label;
            return button;
        })
    );
}

beforeEach(() => {
    settings.values = {};
    document.body.replaceChildren();
    const list = document.createElement('div');
    list.className = 'TasksPanel_taskList__xyz';
    document.body.appendChild(list);

    taskIcons.loadGameData();
    taskIcons.manifestUrls = { items: ITEMS_SPRITE };
});

afterEach(() => {
    taskIcons.cleanup();
});

describe('the picture on a task card', () => {
    test('is drawn for the task the card is showing', () => {
        const card = cardOnBoard('Milking - Cow', ['Go', 'Reroll', '']);

        taskIcons.processAllTaskCards();

        expect(pictureOf(card)).toBe(`${ITEMS_SPRITE}#milk`);
    });

    test('follows a reroll made from the chooser, which the game leaves open', () => {
        // The reported bug, exactly: reroll, and the card keeps the picture of
        // the task that was rerolled away
        const card = cardOnBoard('Milking - Cow', ['Go', 'Reroll', '']);
        taskIcons.processAllTaskCards();

        rerollInto(card, 'Cheesesmithing - Cheese', ['Back', 'Pay 10K', 'MooPass Free Reroll (2)']);
        taskIcons.processAllTaskCards();

        expect(pictureOf(card)).toBe(`${ITEMS_SPRITE}#cheese`);
    });

    test('follows the free MooPass reroll too, chooser and all', () => {
        const card = cardOnBoard('Milking - Cow', ['Back', 'Pay 10K', 'MooPass Free Reroll (2)']);
        taskIcons.processAllTaskCards();
        expect(pictureOf(card)).toBe(`${ITEMS_SPRITE}#milk`);

        rerollInto(card, 'Cheesesmithing - Cheese', ['Back', 'Pay 10K', 'MooPass Free Reroll (1)']);
        taskIcons.processAllTaskCards();

        expect(pictureOf(card)).toBe(`${ITEMS_SPRITE}#cheese`);
    });

    test('is one layer, however many passes run over the card', () => {
        const card = cardOnBoard('Milking - Cow', ['Back', 'Pay 10K']);

        taskIcons.processAllTaskCards();
        taskIcons.processAllTaskCards();
        rerollInto(card, 'Cheesesmithing - Cheese', ['Back', 'Pay 10K']);
        taskIcons.processAllTaskCards();
        taskIcons.processAllTaskCards();

        expect(card.querySelectorAll('.mwi-task-icon')).toHaveLength(1);
    });

    test('never comes between the player and the button they are aiming at', () => {
        // Why the picture is allowed to be redrawn mid-flow at all: it is
        // behind everything, it takes no clicks, and it leaves the chooser's
        // own buttons exactly where and what they were
        const card = cardOnBoard('Milking - Cow', ['Back', 'Pay 10K', 'MooPass Free Reroll (2)']);
        taskIcons.processAllTaskCards();
        const buttonsBefore = [...card.querySelectorAll('button')];

        rerollInto(card, 'Cheesesmithing - Cheese', ['Back', 'Pay 10K', 'MooPass Free Reroll (1)']);
        const chooserButtons = [...card.querySelectorAll('button')];
        taskIcons.processAllTaskCards();

        expect([...card.querySelectorAll('button')]).toEqual(chooserButtons);
        expect(buttonsBefore.length).toBe(3);
        const layer = card.querySelector('.mwi-task-icon');
        expect(layer.style.pointerEvents).toBe('none');
        expect(layer.style.position).toBe('absolute');
    });

    test('a task rerolled into the same task redraws nothing', () => {
        const card = cardOnBoard('Milking - Cow', ['Back', 'Pay 10K']);
        taskIcons.processAllTaskCards();
        const layer = card.querySelector('.mwi-task-icon');

        taskIcons.processAllTaskCards();

        expect(card.querySelector('.mwi-task-icon')).toBe(layer);
    });
});
