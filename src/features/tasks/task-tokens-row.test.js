/** @vitest-environment happy-dom */

/**
 * The Task Tokens tile.
 *
 * The board is read straight off `characterQuests` rather than through the
 * statistics feature, so the two filters that decide what counts as a task in
 * progress are this tile's own and are worth holding down: a claimed task and a
 * quest that is not a random task both look like tasks from a distance.
 *
 * The other half is what happens when the Task Shop has not loaded. A token with
 * no price is not a token worth nothing, and a tile that drew a zero there would
 * be saying the board is worthless.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    rows: {},
    quests: [],
    valuation: { tokenValue: 4000, giftPerTask: 1000, totalPerToken: 5000, error: null },
    popupOpen: false,
    shown: 0,
    closed: 0,
    showThrows: false,
}));

vi.mock('../../utils/overlay-rows.js', () => ({
    registerRow: (definition) => {
        game.rows[definition.key] = definition;
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterQuests() {
            return game.quests;
        },
    },
}));

vi.mock('./task-profit-calculator.js', () => ({
    calculateTaskTokenValue: () => game.valuation,
}));

vi.mock('./task-statistics.js', () => ({
    default: {
        get overlay() {
            return game.popupOpen ? {} : null;
        },
        showPopup: async () => {
            game.shown += 1;
            if (game.showThrows) throw new Error('market is asleep');
        },
        closePopup: () => {
            game.closed += 1;
        },
    },
}));

const { boardTokens } = await import('./task-tokens-row.js');

/**
 * A task on the board.
 * @param {number} tokens - Its token reward
 * @param {Object} [overrides] - Fields to change
 * @returns {Object} A quest
 */
function task(tokens, overrides = {}) {
    return {
        category: '/quest_category/random_task',
        status: '/quest_status/in_progress',
        itemRewardsJSON: JSON.stringify([
            { itemHrid: '/items/coin', count: 1000 },
            { itemHrid: '/items/task_token', count: tokens },
        ]),
        ...overrides,
    };
}

/**
 * Draw the tile into a fresh container.
 * @returns {HTMLElement} The container
 */
function draw() {
    const container = document.createElement('div');
    game.rows.taskTokens.render(container);
    return container;
}

describe('the task tokens tile', () => {
    beforeEach(() => {
        game.quests = [];
        game.valuation = { tokenValue: 4000, giftPerTask: 1000, totalPerToken: 5000, error: null };
        game.popupOpen = false;
        game.shown = 0;
        game.closed = 0;
        game.showThrows = false;
    });

    test('registers, off by default', () => {
        expect(game.rows.taskTokens).toBeDefined();
        expect(game.rows.taskTokens.defaultVisible).toBe(false);
    });

    test('an empty board draws nothing at all', () => {
        expect(draw().textContent).toBe('');
    });

    test('the tokens on the board add up, with what they are worth beside them', () => {
        game.quests = [task(1), task(2), task(3)];

        expect(boardTokens()).toEqual({ tasks: 3, tokens: 6 });

        const container = draw();
        expect(container.textContent).toContain('6');
        expect(container.textContent).toContain('30.00K');
    });

    test('only random tasks in progress are on the board', () => {
        game.quests = [
            task(5),
            task(9, { status: '/quest_status/claimed' }),
            task(9, { category: '/quest_category/community' }),
        ];

        expect(boardTokens()).toEqual({ tasks: 1, tokens: 5 });
    });

    test('a task whose rewards will not parse is still a task', () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
        game.quests = [task(4), task(0, { itemRewardsJSON: 'not json' })];

        expect(boardTokens()).toEqual({ tasks: 2, tokens: 4 });
        expect(logged).toHaveBeenCalled();

        logged.mockRestore();
    });

    test('without a token price the tile draws a dash, never a zero', () => {
        game.quests = [task(3)];
        game.valuation = { tokenValue: null, totalPerToken: null, error: 'Market data not loaded' };

        const container = draw();
        expect(container.textContent).toContain('3');
        expect(container.textContent).toContain('—');
        expect(container.title).toContain('Market data not loaded');
    });

    test('it says outright that it is not a rate', () => {
        game.quests = [task(3)];

        expect(draw().title).toContain('not a rate');
    });

    test('opening the tile shows the statistics popup', async () => {
        await game.rows.taskTokens.onOpen();

        expect(game.shown).toBe(1);
        expect(game.closed).toBe(0);
    });

    test('opening it again puts the popup away', async () => {
        game.popupOpen = true;
        await game.rows.taskTokens.onOpen();

        expect(game.closed).toBe(1);
        expect(game.shown).toBe(0);
    });

    test('a popup that fails to open is logged rather than thrown', async () => {
        game.showThrows = true;
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

        await expect(game.rows.taskTokens.onOpen()).resolves.toBeUndefined();
        expect(logged).toHaveBeenCalled();

        logged.mockRestore();
    });

    test('drawing the tile never opens anything', () => {
        game.quests = [task(3)];
        draw();

        expect(game.shown).toBe(0);
    });
});
