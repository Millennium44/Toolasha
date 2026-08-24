/** @vitest-environment happy-dom */

/**
 * The Task Tokens tile.
 *
 * The board is read straight off `characterQuests` rather than through the
 * statistics feature, so the two filters that decide what counts as a task in
 * progress are this tile's own and are worth holding down: a claimed task and a
 * quest that is not a random task both look like tasks from a distance.
 *
 * The second half is what happens when a figure is missing. A token with no
 * price is not a token worth nothing, and a tile that drew a zero there would be
 * saying the board is worthless; a rate measured from one claim is not a rate at
 * all, and the tile has to leave the line out rather than divide by the time
 * since a single timestamp.
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
    rates: null,
    ratesThrows: false,
    started: 0,
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

// The wording helper is the real one — how a partial valuation reads is part of
// what this tile is being tested for
vi.mock('./task-profit-calculator.js', async (importOriginal) => ({
    ...(await importOriginal()),
    calculateTaskTokenValue: () => game.valuation,
}));

vi.mock('./task-completion-tracker.js', () => ({
    default: {
        initialize: () => {
            game.started += 1;
        },
        rates: () => {
            if (game.ratesThrows) throw new Error('storage is asleep');
            return game.rates;
        },
    },
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

const { boardTokens, formatRate } = await import('./task-tokens-row.js');

/**
 * A measured week.
 * @param {Object} [overrides] - Fields to change
 * @returns {Object} What the tracker's `rates()` returns
 */
function measured(overrides = {}) {
    const week = {
        completions: 6,
        tokens: 24,
        coins: 22000,
        spanMs: 5 * 60 * 60 * 1000,
        tokensPerHour: 4.2,
        coinsPerHour: 3800,
        basis: 'wall-clock',
        ...overrides,
    };
    return { session: week, week, total: week };
}

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
        game.rates = null;
        game.ratesThrows = false;
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

    test('the board figure still says outright that it is not a rate', () => {
        game.quests = [task(3)];

        expect(draw().title).toContain('not a rate');
    });

    test('the measured rate joins the tile once two tasks have been claimed', () => {
        game.quests = [task(3)];
        game.rates = measured();

        const container = draw();
        expect(container.textContent).toContain('4.2 tokens/hr');
        expect(container.textContent).toContain('this week');
        expect(container.title).toContain('6 tasks claimed over 5.0h');
        expect(container.title).toContain('Wall-clock rate');
    });

    test('one claim draws no rate line, and says why', () => {
        game.quests = [task(3)];
        game.rates = measured({ completions: 1, tokensPerHour: null, coinsPerHour: null, spanMs: 0 });

        const container = draw();
        expect(container.textContent).not.toContain('tokens/hr');
        expect(container.title).toContain('One task claimed in the last 7 days');
        expect(container.title).toContain('a rate needs two');
    });

    test('no claims at all is a tile that still draws the board', () => {
        game.quests = [task(3)];
        game.rates = measured({ completions: 0, tokens: 0, coins: 0, tokensPerHour: null, coinsPerHour: null });

        const container = draw();
        expect(container.textContent).toContain('3');
        expect(container.textContent).not.toContain('tokens/hr');
        expect(container.title).toContain('No tasks claimed in the last 7 days');
    });

    test('a tracker that cannot answer costs the rate line, not the tile', () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
        game.quests = [task(3)];
        game.ratesThrows = true;

        const container = draw();
        expect(container.textContent).toContain('3');
        expect(container.textContent).not.toContain('tokens/hr');
        expect(logged).toHaveBeenCalled();

        logged.mockRestore();
    });

    test('recording starts with the module, not with the tile being switched on', () => {
        expect(game.started).toBe(1);
    });

    test('a rate keeps a decimal while it is small and loses it when it is not', () => {
        expect(formatRate(4.23)).toBe('4.2');
        expect(formatRate(0)).toBe('0.0');
        expect(formatRate(3800)).toBe('3.80K');
        expect(formatRate(null)).toBe('—');
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

describe('a token valuation that is only a floor', () => {
    beforeEach(() => {
        game.quests = [task(3)];
        game.popupOpen = false;
        game.rates = null;
    });

    test('the tile marks the figure rather than presenting it as firm', () => {
        game.valuation = {
            tokenValue: 4000,
            giftPerTask: 1000,
            totalPerToken: 5000,
            partialDrops: 2,
            isPartial: true,
            error: null,
        };

        expect(draw().textContent).toContain('≥');
    });

    test('a fully priced valuation carries no marker', () => {
        game.valuation = {
            tokenValue: 4000,
            giftPerTask: 1000,
            totalPerToken: 5000,
            partialDrops: 0,
            isPartial: false,
            error: null,
        };

        expect(draw().textContent).not.toContain('≥');
    });
});
