import { describe, it, expect } from 'vitest';
import {
    MIN_CLAIMS,
    categoryLabel,
    median,
    claimValue,
    spendByQuest,
    goalBands,
    analyzeTaskPayouts,
} from './task-payout-analysis.js';

/** Tokens are worth 1000 each and every claim carries a 500-coin prorated gift. */
const valueRewards = ({ coins = 0, tokens = 0, taskCount = 0 }) => coins + tokens * 1000 + taskCount * 500;

/** Cheese is priced, mystery is not. */
const priceItem = (itemHrid) => (itemHrid === '/items/cheese' ? 200 : null);

/**
 * A completion entry with sane defaults.
 * @param {Object} overrides - Fields to override
 * @returns {Object} Completion entry
 */
function completion(overrides = {}) {
    return {
        questId: 1,
        name: 'Task',
        category: 'combat',
        taskHrid: '/monsters/rat',
        tokens: 1,
        coins: 1000,
        items: [],
        goalCount: 100,
        progressMet: true,
        completedAt: 1_700_000_000_000,
        ...overrides,
    };
}

/**
 * `n` claims in one category, each worth `coins` in coins.
 * @param {Object} params - Inputs
 * @param {string} params.category - Category slug
 * @param {number} params.n - How many
 * @param {number} params.coins - Coins per claim
 * @param {number} [params.startId] - First quest id
 * @param {number} [params.goalCount] - Goal count on each
 * @returns {Array<Object>} Completion entries
 */
function claims({ category, n, coins, startId = 1, goalCount = 100 }) {
    return Array.from({ length: n }, (_, index) =>
        completion({ questId: startId + index, category, coins, goalCount })
    );
}

describe('categoryLabel', () => {
    it('title-cases a bare slug', () => {
        expect(categoryLabel('combat')).toBe('Combat');
        expect(categoryLabel('cheesesmithing')).toBe('Cheesesmithing');
    });

    it('turns underscores into spaces', () => {
        expect(categoryLabel('deep_mining')).toBe('Deep mining');
    });

    it('labels a missing category rather than rendering blank', () => {
        expect(categoryLabel('')).toBe('Unknown');
        expect(categoryLabel(undefined)).toBe('Unknown');
    });
});

describe('median', () => {
    it('takes the middle of an odd list and averages an even one', () => {
        expect(median([3, 1, 2])).toBe(2);
        expect(median([1, 2, 3, 10])).toBe(2.5);
    });

    it('drops non-finite values rather than poisoning the answer', () => {
        expect(median([1, NaN, 3, undefined, 5])).toBe(3);
    });

    it('is null for nothing', () => {
        expect(median([])).toBeNull();
        expect(median(undefined)).toBeNull();
        expect(median([NaN])).toBeNull();
    });
});

describe('claimValue', () => {
    it('adds coins, tokens, the prorated gift and the priced items', () => {
        const entry = completion({ coins: 1000, tokens: 2, items: [{ itemHrid: '/items/cheese', count: 3 }] });
        // 1000 + 2*1000 + 500 gift + 3*200 items
        expect(claimValue(entry, { valueRewards, priceItem })).toEqual({ value: 4100, unpricedStacks: 0 });
    });

    it('prorates the gift once per claim, not once per token', () => {
        const one = claimValue(completion({ coins: 0, tokens: 1 }), { valueRewards, priceItem });
        const four = claimValue(completion({ coins: 0, tokens: 4 }), { valueRewards, priceItem });
        expect(one.value).toBe(1500);
        expect(four.value).toBe(4500);
    });

    it('excludes an unpriced item and counts it instead of valuing it at zero', () => {
        const entry = completion({
            coins: 0,
            tokens: 0,
            items: [
                { itemHrid: '/items/cheese', count: 2 },
                { itemHrid: '/items/mystery', count: 99 },
            ],
        });
        const result = claimValue(entry, { valueRewards, priceItem });
        expect(result.value).toBe(500 + 400);
        expect(result.unpricedStacks).toBe(1);
    });

    it('does not treat an unpriced-only claim as a zero payer, but flags it', () => {
        const entry = completion({ coins: 0, tokens: 0, items: [{ itemHrid: '/items/mystery', count: 1 }] });
        const result = claimValue(entry, { valueRewards, priceItem });
        expect(result.unpricedStacks).toBe(1);
        expect(result.value).toBe(500);
    });

    it('is null when the reward valuation itself cannot price the claim', () => {
        expect(claimValue(completion(), { valueRewards: () => null, priceItem })).toEqual({
            value: null,
            unpricedStacks: 0,
        });
    });

    it('handles an entry with no items array at all', () => {
        expect(claimValue(completion({ items: undefined }), { valueRewards, priceItem }).value).toBe(2500);
    });
});

describe('spendByQuest', () => {
    it('keys spend by the quest id the completion also carries', () => {
        const map = spendByQuest([{ taskId: 7, goldSpent: 10000, cowbellsSpent: 0 }], 20000);
        expect(map.get(7)).toBe(10000);
    });

    it('converts cowbells into coins at the given rate', () => {
        const map = spendByQuest([{ taskId: 7, goldSpent: 10000, cowbellsSpent: 3 }], 20000);
        expect(map.get(7)).toBe(10000 + 60000);
    });

    it('drops the cowbell half when cowbells cannot be priced', () => {
        const map = spendByQuest([{ taskId: 7, goldSpent: 10000, cowbellsSpent: 3 }], 0);
        expect(map.get(7)).toBe(10000);
    });

    it('sums two records for the same quest rather than letting one win', () => {
        const map = spendByQuest(
            [
                { taskId: 7, goldSpent: 10000 },
                { taskId: 7, goldSpent: 20000 },
            ],
            0
        );
        expect(map.get(7)).toBe(30000);
    });

    it('skips records with no task id and survives a missing history', () => {
        expect(spendByQuest([{ goldSpent: 500 }, null], 0).size).toBe(0);
        expect(spendByQuest(undefined, 0).size).toBe(0);
    });
});

describe('goalBands', () => {
    /**
     * Claims with a goal count and a value.
     * @param {Array<Array<number>>} pairs - `[goalCount, value]` pairs
     * @returns {Array<Object>} Claims
     */
    const band = (pairs) => pairs.map(([goalCount, value]) => ({ goalCount, value, net: null }));

    it('splits at the category’s own median goal when both halves clear the gate', () => {
        const claimList = band([
            [10, 100],
            [10, 100],
            [10, 100],
            [10, 100],
            [10, 100],
            [200, 900],
            [200, 900],
            [200, 900],
            [200, 900],
            [200, 900],
        ]);
        const bands = goalBands(claimList, 5);
        expect(bands).toHaveLength(2);
        expect(bands[0]).toEqual({ label: 'goal ≤ 105', claims: 5, medianPayout: 100 });
        expect(bands[1]).toEqual({ label: 'goal > 105', claims: 5, medianPayout: 900 });
    });

    it('returns no bands when one half is too thin to stand on its own', () => {
        const claimList = band([
            [10, 100],
            [10, 100],
            [10, 100],
            [10, 100],
            [10, 100],
            [10, 100],
            [10, 100],
            [10, 100],
            [10, 100],
            [200, 900],
        ]);
        expect(goalBands(claimList, 5)).toEqual([]);
    });

    it('returns no bands when every goal is the same number', () => {
        const claimList = band(Array.from({ length: 12 }, () => [100, 500]));
        expect(goalBands(claimList, 5)).toEqual([]);
    });

    it('refuses to band when any claim is missing its goal count', () => {
        const claimList = band(Array.from({ length: 12 }, (_, i) => [i < 6 ? 10 : 200, 100]));
        claimList[0].goalCount = undefined;
        expect(goalBands(claimList, 5)).toEqual([]);
    });

    it('returns no bands for an empty category', () => {
        expect(goalBands([], 5)).toEqual([]);
    });
});

describe('analyzeTaskPayouts', () => {
    it('reports a median payout per category, richest first', () => {
        const completions = [
            ...claims({ category: 'combat', n: 5, coins: 1000, startId: 1 }),
            ...claims({ category: 'cooking', n: 5, coins: 5000, startId: 100 }),
        ];

        const result = analyzeTaskPayouts({ completions, valueRewards, priceItem });
        expect(result.rows.map((row) => [row.category, row.claims, row.medianPayout])).toEqual([
            ['cooking', 5, 6500],
            ['combat', 5, 2500],
        ]);
    });

    it('gates a thin category out of the rows but keeps its claim count', () => {
        const completions = [
            ...claims({ category: 'combat', n: 5, coins: 1000, startId: 1 }),
            ...claims({ category: 'brewing', n: 2, coins: 9000, startId: 100 }),
        ];

        const result = analyzeTaskPayouts({ completions, valueRewards, priceItem });
        expect(result.rows.map((row) => row.category)).toEqual(['combat']);
        expect(result.thin).toEqual([{ category: 'brewing', label: 'Brewing', claims: 2 }]);
        expect(result.totalClaims).toBe(7);
    });

    it('uses the configured gate rather than a hard-coded one', () => {
        const completions = claims({ category: 'combat', n: 3, coins: 1000 });
        expect(analyzeTaskPayouts({ completions, valueRewards, priceItem, minClaims: 3 }).rows).toHaveLength(1);
        expect(analyzeTaskPayouts({ completions, valueRewards, priceItem, minClaims: 4 }).rows).toHaveLength(0);
        expect(MIN_CLAIMS).toBe(5);
    });

    it('counts unpriced item stacks and the claims they came from without zeroing those claims', () => {
        const completions = claims({ category: 'combat', n: 5, coins: 1000 });
        completions[0].items = [
            { itemHrid: '/items/mystery', count: 1 },
            { itemHrid: '/items/other_mystery', count: 1 },
        ];
        completions[1].items = [{ itemHrid: '/items/cheese', count: 1 }];

        const result = analyzeTaskPayouts({ completions, valueRewards, priceItem });
        expect(result.unpricedStacks).toBe(2);
        expect(result.unpricedClaims).toBe(1);
        // The claim with two unpriced stacks still contributes its coins/tokens
        expect(result.rows[0].claims).toBe(5);
        expect(result.rows[0].medianPayout).toBe(2500);
    });

    it('drops a claim the reward valuation could not price at all', () => {
        const completions = claims({ category: 'combat', n: 5, coins: 1000 });
        const result = analyzeTaskPayouts({
            completions,
            valueRewards: ({ coins }) => (coins === 1000 ? null : 0),
            priceItem,
        });
        expect(result.totalClaims).toBe(5);
        expect(result.valuedClaims).toBe(0);
        expect(result.rows).toHaveLength(0);
    });

    it('nets reroll spend off the claims the join reached, and says how many those were', () => {
        const completions = claims({ category: 'combat', n: 5, coins: 1000, startId: 1 });
        const rerollHistory = [1, 2, 3, 4, 5].map((taskId) => ({ taskId, goldSpent: 500, cowbellsSpent: 0 }));

        const result = analyzeTaskPayouts({ completions, rerollHistory, valueRewards, priceItem });
        expect(result.rows[0].medianPayout).toBe(2500);
        expect(result.rows[0].netMedian).toBe(2000);
        expect(result.rows[0].attributed).toBe(5);
    });

    it('withholds the net when too few claims have an attributable spend record', () => {
        const completions = claims({ category: 'combat', n: 5, coins: 1000, startId: 1 });
        const rerollHistory = [
            { taskId: 1, goldSpent: 500 },
            { taskId: 2, goldSpent: 500 },
        ];

        const result = analyzeTaskPayouts({ completions, rerollHistory, valueRewards, priceItem });
        expect(result.rows[0].attributed).toBe(2);
        expect(result.rows[0].netMedian).toBeNull();
    });

    it('does not treat an absent spend record as a zero-spend claim', () => {
        const completions = claims({ category: 'combat', n: 6, coins: 1000, startId: 1 });
        // Five expensive rerolls recorded, one claim with no record at all
        const rerollHistory = [1, 2, 3, 4, 5].map((taskId) => ({ taskId, goldSpent: 1000 }));

        const result = analyzeTaskPayouts({ completions, rerollHistory, valueRewards, priceItem });
        expect(result.rows[0].attributed).toBe(5);
        // 1500 across all five attributed claims — the unrecorded sixth would
        // have pulled the median up to 2500 had it been counted as free
        expect(result.rows[0].netMedian).toBe(1500);
    });

    it('values cowbell spend through the given cowbell price', () => {
        const completions = claims({ category: 'combat', n: 5, coins: 1000, startId: 1 });
        const rerollHistory = [1, 2, 3, 4, 5].map((taskId) => ({ taskId, goldSpent: 0, cowbellsSpent: 1 }));

        const result = analyzeTaskPayouts({
            completions,
            rerollHistory,
            cowbellValue: 300,
            valueRewards,
            priceItem,
        });
        expect(result.rows[0].netMedian).toBe(2200);
    });

    it('attaches goal-count bands to a category whose goals actually split', () => {
        const low = claims({ category: 'combat', n: 5, coins: 1000, startId: 1, goalCount: 10 });
        const high = claims({ category: 'combat', n: 5, coins: 9000, startId: 100, goalCount: 500 });

        const result = analyzeTaskPayouts({ completions: [...low, ...high], valueRewards, priceItem });
        expect(result.rows[0].bands.map((band) => [band.claims, band.medianPayout])).toEqual([
            [5, 2500],
            [5, 10500],
        ]);
    });

    it('leaves bands empty when the goals do not split into two usable halves', () => {
        const completions = claims({ category: 'combat', n: 10, coins: 1000, goalCount: 100 });
        expect(analyzeTaskPayouts({ completions, valueRewards, priceItem }).rows[0].bands).toEqual([]);
    });

    it('names a best and a worst payer only when there are two rows to compare', () => {
        const one = claims({ category: 'combat', n: 5, coins: 1000, startId: 1 });
        const single = analyzeTaskPayouts({ completions: one, valueRewards, priceItem });
        expect(single.best).toBeNull();
        expect(single.worst).toBeNull();

        const two = [...one, ...claims({ category: 'cooking', n: 5, coins: 9000, startId: 100 })];
        const pair = analyzeTaskPayouts({ completions: two, valueRewards, priceItem });
        expect(pair.best.category).toBe('cooking');
        expect(pair.worst.category).toBe('combat');
    });

    it('buckets claims with no category under unknown rather than dropping them', () => {
        const completions = claims({ category: undefined, n: 5, coins: 1000 });
        const result = analyzeTaskPayouts({ completions, valueRewards, priceItem });
        expect(result.rows[0].category).toBe('unknown');
        expect(result.rows[0].label).toBe('Unknown');
    });

    it('survives an empty history and being called with nothing at all', () => {
        expect(analyzeTaskPayouts({ completions: [], valueRewards, priceItem }).rows).toEqual([]);
        const nothing = analyzeTaskPayouts();
        expect(nothing.rows).toEqual([]);
        expect(nothing.totalClaims).toBe(0);
        expect(nothing.best).toBeNull();
    });
});
