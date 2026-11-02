/**
 * The transmute history viewer values an untradable cape input through the shared untradable-cape
 * convention (features/enhancement/untradable-cape-value.js), the figure every other panel shows.
 * Before, a refined cape was costed at its refinement materials alone (the base cape left out) and an
 * unrefined one was unpriced, so the same cape read differently here than in the alchemy profit table.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const REFINED = '/items/gatherer_cape_refined';
const PLAIN = '/items/gatherer_cape';
const SHARD = '/items/labyrinth_refinement_shard';

const state = vi.hoisted(() => ({ calls: [], values: {}, mode: 'mirror', shardPrice: 1000 }));

vi.mock('./transmute-history-tracker.js', () => ({
    transmuteHistoryTracker: { on: () => {}, off: () => {}, loadSessions: async () => [] },
}));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, getSettingValue: (key, fallback) => fallback },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'char1',
        getItemDetails: () => ({ name: 'Cape', itemLevel: 1, alchemyDetail: { bulkMultiplier: 1 } }),
        getInitClientData: () => ({
            itemDetailMap: { [PLAIN]: { name: 'Cape', isTradable: false } },
            // The old craft path: refinement shards only, base cape left out
            actionDetailMap: {
                '/actions/refine': {
                    type: '/action_types/enhancing',
                    upgradeItemHrid: PLAIN,
                    outputItems: [{ itemHrid: REFINED }],
                    inputItems: [{ itemHrid: SHARD, count: 10 }],
                },
            },
        }),
        getInventory: () => [],
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => [],
    },
}));
vi.mock('../../utils/market-data.js', () => {
    const priceFor = (hrid) => (hrid === SHARD ? state.shardPrice : null);
    return {
        getItemPrice: (hrid) => priceFor(hrid),
        getItemPriceInfo: (hrid) => {
            const price = priceFor(hrid);
            return { price, source: price === null ? null : 'book', estimated: false };
        },
        getPricingMode: () => 'ask',
    };
});
vi.mock('../../utils/untradable-cape.js', () => ({
    isUntradableCape: (hrid) => hrid === REFINED || hrid === PLAIN,
    getCapeBaseValueMode: () => state.mode,
    CAPE_BASE_VALUE_ZERO: 'zero',
}));
vi.mock('../enhancement/untradable-cape-value.js', () => ({
    getUntradableCapeValue: (hrid, level, options) => {
        state.calls.push([hrid, level, options]);
        return state.values[`${hrid}|${level}`] ?? { value: null, partial: true };
    },
}));

const { transmuteHistoryViewer } = await import('./transmute-history-viewer.js');

const session = (inputItemHrid, enhancementLevel = 0) => ({
    id: 's1',
    inputItemHrid,
    enhancementLevel,
    bulkMultiplier: 1,
    totalAttempts: 10,
    totalSuccesses: 8,
    results: {},
    totalCoinsEarned: 0,

    primeCatalystUsed: 0,
});

beforeEach(() => {
    state.calls = [];
    state.values = {};
    state.mode = 'mirror';
    state.shardPrice = 1000;
});

describe('transmute history: base cape set to nothing (the default cape setting)', () => {
    // The cape value is always a floor on this setting (the base counts as 0), whatever the shards cost
    beforeEach(() => {
        state.mode = 'zero';
        state.values[`${REFINED}|0`] = { value: 10_000, partial: true };
    });

    test('a refined cape is costed at its refinement materials, never 0 and not flagged unpriced', () => {
        const detail = transmuteHistoryViewer.computeSessionProfit(session(REFINED, 0));
        expect(detail.inputCost).toBe(10 * 10 * 1000);
        expect(detail.inputUnpriced).toBe(false);
        expect(detail.inputBasis).toContain('base cape counted as nothing');
        expect(transmuteHistoryViewer.buildDataNote(session(REFINED), detail)).not.toContain('unpriced');
    });

    test('an unpriced refinement material still leaves it unpriced, not costed at 0', () => {
        state.shardPrice = null;
        const detail = transmuteHistoryViewer.computeSessionProfit(session(REFINED, 0));
        expect(detail.inputUnpriced).toBe(true);
        expect(detail.inputBasis).toBeNull();
    });

    test('an unrefined cape costs a plain 0 by the setting, not an unpriced 0*', () => {
        const detail = transmuteHistoryViewer.computeSessionProfit(session(PLAIN, 0));
        expect(detail.inputCost).toBe(0);
        expect(detail.inputUnpriced).toBe(false);
        expect(detail.inputBasis).toContain('cape setting');
    });

    test('mirror setting with a partial value is unaffected and stays unpriced', () => {
        state.mode = 'mirror';
        expect(transmuteHistoryViewer.computeSessionProfit(session(REFINED, 0)).inputUnpriced).toBe(true);
    });
});

describe('transmute history: untradable cape inputs use the shared cape value', () => {
    test('a refined cape at a nonzero level is costed at the convention figure, not the shards alone', () => {
        state.values[`${REFINED}|0`] = { value: 9_000_000, partial: false };
        const detail = transmuteHistoryViewer.computeSessionProfit(session(REFINED, 0));
        expect(detail.inputCost).toBe(10 * 9_000_000);
        expect(detail.inputBasis).toBe('untradable-cape value');
        expect(detail.inputUnpriced).toBe(false);
        expect(state.calls[0].slice(0, 2)).toEqual([REFINED, 0]);
    });

    test('an unrefined cape is valued at the cape setting instead of left unpriced', () => {
        state.values[`${PLAIN}|0`] = { value: 4_000_000, partial: false };
        const detail = transmuteHistoryViewer.computeSessionProfit(session(PLAIN, 0));
        expect(detail.inputCost).toBe(10 * 4_000_000);
        expect(detail.inputUnpriced).toBe(false);
    });

    test('two capes (refined and unrefined) of the same kind each get their own figure', () => {
        state.values[`${REFINED}|0`] = { value: 9_000_000, partial: false };
        state.values[`${PLAIN}|0`] = { value: 4_000_000, partial: false };
        expect(transmuteHistoryViewer.computeSessionProfit(session(REFINED)).inputCost).toBe(90_000_000);
        expect(transmuteHistoryViewer.computeSessionProfit(session(PLAIN)).inputCost).toBe(40_000_000);
    });

    test('a cape the setting leaves unpriced stays unpriced, never 0 and never the shards-only craft cost', () => {
        state.values[`${REFINED}|0`] = { value: 800, partial: true };
        const refined = transmuteHistoryViewer.computeSessionProfit(session(REFINED, 0));
        expect(refined.inputUnpriced).toBe(true);
        expect(refined.inputBasis).toBeNull();
        expect(refined.inputCost).toBe(0);
        const plain = transmuteHistoryViewer.computeSessionProfit(session(PLAIN, 0));
        expect(plain.inputUnpriced).toBe(true);
    });
});
