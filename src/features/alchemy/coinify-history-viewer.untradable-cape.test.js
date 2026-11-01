/**
 * The coinify history viewer values an untradable cape input through the shared untradable-cape
 * convention (features/enhancement/untradable-cape-value.js), the figure every other panel shows.
 * Before, a refined cape was costed at its refinement materials alone (the base cape left out) and an
 * unrefined one was unpriced, so the same cape read differently here than in the alchemy profit table.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const REFINED = '/items/gatherer_cape_refined';
const PLAIN = '/items/gatherer_cape';
const SHARD = '/items/labyrinth_refinement_shard';

const state = vi.hoisted(() => ({ calls: [], values: {} }));

vi.mock('./coinify-history-tracker.js', () => ({
    coinifyHistoryTracker: { on: () => {}, off: () => {}, loadSessions: async () => [] },
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
    const priceFor = (hrid) => (hrid === SHARD ? 1000 : null);
    return {
        getItemPrice: (hrid) => priceFor(hrid),
        getItemPriceInfo: (hrid) => {
            const price = priceFor(hrid);
            return { price, source: price === null ? null : 'book', estimated: false };
        },
        getPricingMode: () => 'ask',
    };
});
vi.mock('../../utils/untradable-cape.js', () => ({ isUntradableCape: (hrid) => hrid === REFINED || hrid === PLAIN }));
vi.mock('../enhancement/untradable-cape-value.js', () => ({
    getUntradableCapeValue: (hrid, level, options) => {
        state.calls.push([hrid, level, options]);
        return state.values[`${hrid}|${level}`] ?? { value: null, partial: true };
    },
}));

const { coinifyHistoryViewer } = await import('./coinify-history-viewer.js');

const session = (inputItemHrid, enhancementLevel = 0) => ({
    id: 's1',
    inputItemHrid,
    enhancementLevel,
    bulkMultiplier: 1,
    totalAttempts: 10,
    totalSuccesses: 8,
    results: {},
    totalCoinsEarned: 0,
    catalystOfCoinificationUsed: 0,
    primeCatalystUsed: 0,
});

beforeEach(() => {
    state.calls = [];
    state.values = {};
});

describe('coinify history: untradable cape inputs use the shared cape value', () => {
    test('a refined cape at a nonzero level is costed at the convention figure, not the shards alone', () => {
        state.values[`${REFINED}|3`] = { value: 9_000_000, partial: false };
        const detail = coinifyHistoryViewer.computeSessionProfit(session(REFINED, 3));
        expect(detail.inputCost).toBe(10 * 9_000_000);
        expect(detail.inputBasis).toBe('untradable-cape value');
        expect(detail.inputUnpriced).toBe(false);
        expect(state.calls[0].slice(0, 2)).toEqual([REFINED, 3]);
    });

    test('an unrefined cape is valued at the cape setting instead of left unpriced', () => {
        state.values[`${PLAIN}|3`] = { value: 4_000_000, partial: false };
        const detail = coinifyHistoryViewer.computeSessionProfit(session(PLAIN, 3));
        expect(detail.inputCost).toBe(10 * 4_000_000);
        expect(detail.inputUnpriced).toBe(false);
    });

    test('two capes of the same kind at different levels each get their own figure', () => {
        state.values[`${REFINED}|3`] = { value: 9_000_000, partial: false };
        state.values[`${REFINED}|0`] = { value: 5_000_000, partial: false };
        expect(coinifyHistoryViewer.computeSessionProfit(session(REFINED, 3)).inputCost).toBe(90_000_000);
        expect(coinifyHistoryViewer.computeSessionProfit(session(REFINED, 0)).inputCost).toBe(50_000_000);
    });

    test('a cape the setting leaves unpriced stays unpriced, never 0 and never the shards-only craft cost', () => {
        state.values[`${REFINED}|0`] = { value: 800, partial: true };
        const refined = coinifyHistoryViewer.computeSessionProfit(session(REFINED, 0));
        expect(refined.inputUnpriced).toBe(true);
        expect(refined.inputBasis).toBeNull();
        expect(refined.inputCost).toBe(0);
        const plain = coinifyHistoryViewer.computeSessionProfit(session(PLAIN, 0));
        expect(plain.inputUnpriced).toBe(true);
    });
});
