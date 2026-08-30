/** @vitest-environment happy-dom */

/**
 * The task statistics panel's arithmetic.
 *
 * Two figures in here were wrong in ways that read as confident:
 *
 * - The seven-day reward value multiplied a per-TASK prorated Purple's Gift by
 *   a TOKEN count, so a week of multi-token tasks was credited a gift per token.
 * - A task whose action could not be priced arrived as `totalValue: null` (from
 *   gathering) or `totalProfit: null` (from production), and a `||` chain turned
 *   both into 0 — drawn green as a break-even and summed into the totals, while
 *   the N/A rendering that existed for exactly this case never fired.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    quests: [],
    valuation: { tokenValue: 2000, giftPerTask: 10000, error: null },
    /** Per action hrid: what calculateTaskProfit hands back as `action` */
    actionProfits: {},
    completions: null,
    rerollHistory: [],
    /** Every claim the completion tracker has, for the per-type payout card */
    claimLog: [],
    /** itemHrid → coins per unit after tax; anything absent is unpriced */
    itemPrices: {},
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        onSettingChange: () => {},
        COLOR_TEXT_PRIMARY: '#fff',
        COLOR_TEXT_SECONDARY: '#888',
        COLOR_ACCENT: '#0af',
        COLOR_PROFIT: '#0f0',
        COLOR_LOSS: '#f00',
        COLOR_ESSENCE: '#a0f',
        COLOR_GOLD: '#fa0',
    },
}));

vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../api/marketplace.js', () => ({ default: {} }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterQuests() {
            return game.quests;
        },
        characterData: {},
        on: () => {},
        off: () => {},
        getInitClientData: () => ({
            actionDetailMap: {
                '/actions/foraging/egg': { name: 'Egg', type: '/action_types/foraging' },
                '/actions/cooking/stew': { name: 'Stew', type: '/action_types/cooking' },
            },
            combatMonsterDetailMap: {},
        }),
    },
}));

// Mocked outright rather than through importOriginal: the real module pulls in
// the market and enhancement stack, which is not what this panel is being
// tested for. `valueTaskRewards` is the one piece kept real — it is the
// arithmetic under test.
vi.mock('./task-profit-calculator.js', () => ({
    formatTokenFigure: (value) => String(Math.round(value)),
    valueTaskRewards: (tokenData, { coins = 0, tokens = 0, taskCount = 0 } = {}) => {
        if (!tokenData || tokenData.error || !Number.isFinite(tokenData.tokenValue)) return null;
        const giftPerTask = Number.isFinite(tokenData.giftPerTask) ? tokenData.giftPerTask : 0;
        return coins + tokens * tokenData.tokenValue + taskCount * giftPerTask;
    },
    calculateTaskTokenValue: () => game.valuation,
    calculateTaskRewardValue: (coins, tokens, taskCount) => ({
        coins,
        taskTokens: tokens * game.valuation.tokenValue,
        purpleGift: taskCount * game.valuation.giftPerTask,
        total: coins + tokens * game.valuation.tokenValue + taskCount * game.valuation.giftPerTask,
        breakdown: {},
        error: null,
    }),
    calculateTaskProfit: async (taskData) => ({ action: game.actionProfits[taskData.description] ?? null }),
    getCowbellValue: () => 200000,
    // Null, not zero, for an item nothing can price — the payout card has to be
    // able to leave those out rather than average them in as worthless
    valueOfRewardItem: (itemHrid) => game.itemPrices[itemHrid] ?? null,
}));

vi.mock('./task-profit-display.js', () => ({
    calculateTaskCompletionSeconds: () => 3600,
}));

vi.mock('./task-completion-tracker.js', () => ({
    default: {
        summary: async () => game.completions,
        getCompletions: async () => game.claimLog,
        initialize: () => {},
    },
}));

vi.mock('./task-reroll-tracker.js', () => ({
    default: {
        taskRerollData: new Map(),
        loadHistory: async () => game.rerollHistory,
        calculateGoldSpent: () => 0,
        calculateCowbellSpent: () => 0,
    },
}));

vi.mock('./task-slot-forecast.js', () => ({ forecastTaskSlots: () => ({}) }));

const { default: taskStatistics } = await import('./task-statistics.js');

/**
 * A random task in progress.
 * @param {Object} fields - Overrides
 * @returns {Object} A quest
 */
function task({ coins = 0, tokens = 0, actionHrid = null, ...rest } = {}) {
    return {
        id: rest.id ?? Math.random(),
        category: '/quest_category/random_task',
        status: '/quest_status/in_progress',
        type: actionHrid ? '/quest_type/action' : '/quest_type/monster',
        actionHrid: actionHrid || '',
        goalCount: 100,
        currentCount: 0,
        itemRewardsJSON: JSON.stringify([
            { itemHrid: '/items/coin', count: coins },
            { itemHrid: '/items/task_token', count: tokens },
        ]),
        ...rest,
    };
}

beforeEach(() => {
    game.quests = [];
    game.valuation = { tokenValue: 2000, giftPerTask: 10000, error: null };
    game.actionProfits = {};
    game.completions = null;
    game.rerollHistory = [];
    game.claimLog = [];
    game.itemPrices = {};
});

describe("Purple's Gift across a week of claims", () => {
    test('the gift is prorated per claimed task, not per token claimed', async () => {
        // 10 tasks claimed, paying 40 tokens and 500,000 coins between them
        game.completions = {
            rates: {
                week: { completions: 10, tokens: 40, coins: 500000, spanMs: 3600000 },
                session: null,
            },
            recent: [],
        };

        const result = await taskStatistics.calculateCompletions(0);

        // 500,000 + 40 × 2,000 + 10 × 10,000 — not 40 × (2,000 + 10,000)
        expect(result.rewardValue).toBe(500000 + 40 * 2000 + 10 * 10000);
    });

    test('an unpriceable token leaves the reward value null rather than zero', async () => {
        game.valuation = { tokenValue: null, giftPerTask: null, error: 'Market data not loaded' };
        game.completions = {
            rates: { week: { completions: 3, tokens: 6, coins: 1000, spanMs: 1000 }, session: null },
            recent: [],
        };

        const result = await taskStatistics.calculateCompletions(0);

        expect(result.rewardValue).toBe(null);
        expect(result.netValue).toBe(null);
    });
});

describe('an action nobody can price', () => {
    test('gathering’s null total stays null instead of becoming a break-even zero', async () => {
        game.quests = [task({ id: 1, actionHrid: '/actions/foraging/egg' })];
        game.actionProfits['Foraging - Egg'] = { totalValue: null, hasMissingPrices: true };

        const rewards = await taskStatistics.calculateRewardsSummary();

        expect(rewards.taskDetails[0].actionProfit).toBe(null);
        expect(rewards.totalActionProfit).toBe(null);
        expect(rewards.unpricedActionTasks).toBe(1);
    });

    test('production’s null total, on its own key, does the same', async () => {
        game.quests = [task({ id: 1, actionHrid: '/actions/cooking/stew' })];
        game.actionProfits['Cooking - Stew'] = { totalProfit: null, hasMissingPrices: true };

        const rewards = await taskStatistics.calculateRewardsSummary();

        expect(rewards.taskDetails[0].actionProfit).toBe(null);
        expect(rewards.unpricedActionTasks).toBe(1);
    });

    test('a real zero is still a zero', async () => {
        game.quests = [task({ id: 1, actionHrid: '/actions/foraging/egg' })];
        game.actionProfits['Foraging - Egg'] = { totalValue: 0, hasMissingPrices: false };

        const rewards = await taskStatistics.calculateRewardsSummary();

        expect(rewards.taskDetails[0].actionProfit).toBe(0);
        expect(rewards.unpricedActionTasks).toBe(0);
    });

    test('an unpriced task is left out of the total rather than counted as nothing', async () => {
        game.quests = [
            task({ id: 1, actionHrid: '/actions/foraging/egg' }),
            task({ id: 2, actionHrid: '/actions/cooking/stew' }),
        ];
        game.actionProfits['Foraging - Egg'] = { totalValue: 30000, hasMissingPrices: false };
        game.actionProfits['Cooking - Stew'] = { totalProfit: null, hasMissingPrices: true };

        const rewards = await taskStatistics.calculateRewardsSummary();

        expect(rewards.totalActionProfit).toBe(30000);
        expect(rewards.unpricedActionTasks).toBe(1);
    });

    test('a combat task is not an unpriced one — it has no action to price', async () => {
        game.quests = [task({ id: 1, monsterHrid: '/monsters/cow' })];

        const rewards = await taskStatistics.calculateRewardsSummary();

        expect(rewards.unpricedActionTasks).toBe(0);
    });

    test('the totals are drawn as the floor they are, and the per-task row as N/A', async () => {
        game.quests = [
            task({ id: 1, coins: 1000, tokens: 1, actionHrid: '/actions/foraging/egg' }),
            task({ id: 2, coins: 1000, tokens: 1, actionHrid: '/actions/cooking/stew' }),
        ];
        game.actionProfits['Foraging - Egg'] = { totalValue: 30000, hasMissingPrices: false };
        game.actionProfits['Cooking - Stew'] = { totalProfit: null, hasMissingPrices: true };

        const rewards = await taskStatistics.calculateRewardsSummary();
        const section = taskStatistics.createActionProfitSection(rewards);

        expect(section.textContent).toContain('N/A');
        expect(section.textContent).toContain('≥');
        expect(section.textContent).toContain('1 unpriced');
    });

    test('a fully priced board carries no floor marker', async () => {
        game.quests = [task({ id: 1, coins: 1000, tokens: 1, actionHrid: '/actions/foraging/egg' })];
        game.actionProfits['Foraging - Egg'] = { totalValue: 30000, hasMissingPrices: false };

        const rewards = await taskStatistics.calculateRewardsSummary();
        const section = taskStatistics.createActionProfitSection(rewards);

        expect(section.textContent).not.toContain('≥');
        expect(section.textContent).not.toContain('unpriced');
    });
});

describe('the realized-payout-by-type card', () => {
    beforeEach(() => {
        // The card is reached through calculateAllStatistics, which also builds
        // the seven-day section; give that one something valid so its own
        // failure path is not what these tests are watching
        game.completions = {
            rates: { week: { completions: 0, tokens: 0, coins: 0, spanMs: 0 }, session: null },
            recent: [],
        };
    });

    /**
     * `n` claims in one category.
     * @param {Object} params - Inputs
     * @param {string} params.category - Category slug
     * @param {number} params.n - How many
     * @param {number} params.coins - Coins per claim
     * @param {number} [params.startId] - First quest id
     * @param {Array<Object>} [params.items] - Item rewards on each claim
     * @returns {Array<Object>} Completion entries
     */
    function claims({ category, n, coins, startId = 1, items = [] }) {
        return Array.from({ length: n }, (_, index) => ({
            questId: startId + index,
            name: 'Task',
            category,
            taskHrid: '/actions/foraging/egg',
            tokens: 1,
            coins,
            items,
            goalCount: 100,
            progressMet: true,
            completedAt: 1_700_000_000_000,
        }));
    }

    /** The rendered text of the payout card, or '' when it was not drawn. */
    function cardText(stats) {
        const section = taskStatistics.createTypePayoutSection(stats.payouts, '#fff');
        return section.textContent;
    }

    test('the card is built rather than silently dropped when there are claims', async () => {
        game.claimLog = claims({ category: 'combat', n: 6, coins: 1000 });
        const stats = await taskStatistics.calculateAllStatistics();

        expect(stats.payouts).not.toBeNull();
        expect(stats.payouts.rows).toHaveLength(1);
        const text = cardText(stats);
        expect(text).toContain('Combat');
        expect(text).not.toContain('undefined');
        expect(text).not.toContain('NaN');
    });

    test('no claims at all leaves the card off entirely rather than drawing an empty one', async () => {
        game.claimLog = [];
        const stats = await taskStatistics.calculateAllStatistics();
        expect(stats.payouts).toBeNull();
    });

    test('prices item rewards at today’s post-tax price and says so on the card', async () => {
        game.itemPrices = { '/items/cheese': 300 };
        game.claimLog = claims({
            category: 'combat',
            n: 6,
            coins: 0,
            items: [{ itemHrid: '/items/cheese', count: 2 }],
        });

        const stats = await taskStatistics.calculateAllStatistics();
        // 0 coins + 1 token x 2000 + 1 gift x 10000 + 2 x 300 items
        expect(stats.payouts.rows[0].medianPayout).toBe(12600);
        expect(cardText(stats)).toContain('today');
    });

    test('excludes an unpriced reward and reports the count instead of valuing it at zero', async () => {
        game.itemPrices = {};
        game.claimLog = claims({
            category: 'combat',
            n: 6,
            coins: 0,
            items: [{ itemHrid: '/items/mystery', count: 5 }],
        });

        const stats = await taskStatistics.calculateAllStatistics();
        expect(stats.payouts.rows[0].medianPayout).toBe(12000);
        expect(stats.payouts.unpricedStacks).toBe(6);
        expect(cardText(stats)).toContain('excluded');
    });

    test('gates a thin category out of the ranking but still names its claim count', async () => {
        game.claimLog = [
            ...claims({ category: 'combat', n: 6, coins: 1000, startId: 1 }),
            ...claims({ category: 'brewing', n: 2, coins: 90000, startId: 100 }),
        ];

        const stats = await taskStatistics.calculateAllStatistics();
        expect(stats.payouts.rows.map((row) => row.category)).toEqual(['combat']);
        const text = cardText(stats);
        expect(text).toContain('Brewing (2)');
        expect(text).toContain('too few to rank');
    });

    test('nets attributable reroll spend, valuing cowbells through the panel’s own rate', async () => {
        game.claimLog = claims({ category: 'combat', n: 6, coins: 1000, startId: 1 });
        game.rerollHistory = [1, 2, 3, 4, 5, 6].map((taskId) => ({
            taskId,
            goldSpent: 10000,
            cowbellsSpent: 1,
        }));

        const stats = await taskStatistics.calculateAllStatistics();
        const row = stats.payouts.rows[0];
        // 1000 + 2000 token + 10000 gift = 13000 gross; 10000 gold + 1 cowbell at 200000
        expect(row.medianPayout).toBe(13000);
        expect(row.netMedian).toBe(13000 - 210000);
        expect(row.attributed).toBe(6);
        expect(cardText(stats)).toContain('net of rerolls');
    });

    test('says outright that there is no per-hour figure', async () => {
        game.claimLog = claims({ category: 'combat', n: 6, coins: 1000 });
        const stats = await taskStatistics.calculateAllStatistics();
        const text = cardText(stats);
        expect(text).toContain('No per-hour figure');
        expect(text).toContain('no duration');
        expect(text).not.toContain('/ hr');
    });

    test('names a best and worst payer once two categories qualify', async () => {
        game.claimLog = [
            ...claims({ category: 'combat', n: 6, coins: 1000, startId: 1 }),
            ...claims({ category: 'cooking', n: 6, coins: 90000, startId: 100 }),
        ];

        const stats = await taskStatistics.calculateAllStatistics();
        expect(cardText(stats)).toContain('Cooking / Combat');
    });

    test('an unpriceable token drops the whole card rather than reporting zeroes', async () => {
        game.valuation = { tokenValue: null, giftPerTask: null, error: 'Market data not loaded' };
        game.claimLog = claims({ category: 'combat', n: 6, coins: 1000 });

        const stats = await taskStatistics.calculateAllStatistics();
        expect(stats.payouts.rows).toHaveLength(0);
        expect(stats.payouts.valuedClaims).toBe(0);
        expect(cardText(stats)).toContain('Not enough claims yet');
    });
});
