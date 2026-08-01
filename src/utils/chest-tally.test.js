import { describe, test, expect } from 'vitest';
import {
    recordOpening,
    resetTally,
    expectedLootPerChest,
    chestPerformance,
    summariseTally,
    tallyTotals,
} from './chest-tally.js';

const CHEST = '/items/small_chest';
const dropTable = [
    { itemHrid: '/items/coin', dropRate: 1, minCount: 100, maxCount: 300 },
    { itemHrid: '/items/rare', dropRate: 0.01, minCount: 1, maxCount: 1 },
];
const priceOf = (hrid) => ({ '/items/coin': 1, '/items/rare': 100000, '/items/junk': 0 })[hrid] ?? null;

describe('recordOpening', () => {
    test('records the first opening', () => {
        const tally = recordOpening({}, CHEST, 1, [{ itemHrid: '/items/coin', count: 200 }]);
        expect(tally[CHEST]).toEqual({ opened: 1, loot: { '/items/coin': 200 } });
    });

    test('accumulates across openings', () => {
        let tally = recordOpening({}, CHEST, 5, [{ itemHrid: '/items/coin', count: 1000 }]);
        tally = recordOpening(tally, CHEST, 3, [
            { itemHrid: '/items/coin', count: 600 },
            { itemHrid: '/items/rare', count: 1 },
        ]);
        expect(tally[CHEST]).toEqual({ opened: 8, loot: { '/items/coin': 1600, '/items/rare': 1 } });
    });

    test('leaves the tally it was given alone', () => {
        // The caller persists the result; mutating in place makes it ambiguous
        // which copy is the saved one
        const before = { [CHEST]: { opened: 1, loot: { '/items/coin': 200 } } };
        recordOpening(before, CHEST, 1, [{ itemHrid: '/items/coin', count: 200 }]);
        expect(before[CHEST].opened).toBe(1);
    });

    test('keeps chests apart', () => {
        let tally = recordOpening({}, CHEST, 1, [{ itemHrid: '/items/coin', count: 100 }]);
        tally = recordOpening(tally, '/items/big_chest', 1, [{ itemHrid: '/items/coin', count: 900 }]);
        expect(Object.keys(tally)).toHaveLength(2);
    });

    test('ignores an opening with nothing to record', () => {
        expect(recordOpening({}, '', 1, [])).toEqual({});
        expect(recordOpening({}, CHEST, 0, [])).toEqual({});
    });

    test('an opening that gave nothing still counts as an opening', () => {
        // Otherwise a chest that can come up empty looks better than it is
        expect(recordOpening({}, CHEST, 2, [])[CHEST]).toEqual({ opened: 2, loot: {} });
    });
});

describe('resetTally', () => {
    test('forgets one chest and keeps the rest', () => {
        const tally = { a: { opened: 1, loot: {} }, b: { opened: 2, loot: {} } };
        expect(Object.keys(resetTally(tally, 'a'))).toEqual(['b']);
    });

    test('forgets everything when given no chest', () => {
        expect(resetTally({ a: { opened: 1, loot: {} } })).toEqual({});
    });
});

describe('expectedLootPerChest', () => {
    test('is the midpoint of the range times the rate', () => {
        expect(expectedLootPerChest(dropTable)).toEqual({ '/items/coin': 200, '/items/rare': 0.01 });
    });

    test('adds up an item that appears twice in one table', () => {
        expect(
            expectedLootPerChest([
                { itemHrid: '/items/coin', dropRate: 1, minCount: 10, maxCount: 10 },
                { itemHrid: '/items/coin', dropRate: 0.5, minCount: 4, maxCount: 4 },
            ])
        ).toEqual({ '/items/coin': 12 });
    });

    test('survives a missing table', () => {
        expect(expectedLootPerChest(null)).toEqual({});
    });
});

describe('chestPerformance', () => {
    test('an exactly average run comes out level', () => {
        // 100 chests owe 20000 coin and one rare
        const entry = { opened: 100, loot: { '/items/coin': 20000, '/items/rare': 1 } };
        const result = chestPerformance(entry, dropTable, priceOf);

        expect(result.expectedValue).toBeCloseTo(120000, 6);
        expect(result.actualValue).toBeCloseTo(120000, 6);
        expect(result.ratio).toBeCloseTo(1, 6);
    });

    test('a rare that never came up shows as a row, not an absence', () => {
        // The missing rare is the whole story on an unlucky chest; dropping it
        // from the list hides exactly the row worth reading
        const entry = { opened: 100, loot: { '/items/coin': 20000 } };
        const result = chestPerformance(entry, dropTable, priceOf);

        const rare = result.items.find((item) => item.itemHrid === '/items/rare');
        expect(rare).toMatchObject({ actualCount: 0 });
        expect(rare.expectedCount).toBeCloseTo(1, 6);
        expect(result.ratio).toBeCloseTo(20000 / 120000, 6);
    });

    test('rows are ordered by what they were supposed to be worth', () => {
        const entry = { opened: 100, loot: { '/items/coin': 20000, '/items/rare': 1 } };
        const [first] = chestPerformance(entry, dropTable, priceOf).items;
        expect(first.itemHrid).toBe('/items/rare');
    });

    test('an item with no price sits out of both sides', () => {
        const withJunk = [...dropTable, { itemHrid: '/items/junk', dropRate: 1, minCount: 5, maxCount: 5 }];
        const entry = { opened: 10, loot: { '/items/coin': 2000, '/items/junk': 50 } };
        const result = chestPerformance(entry, withJunk, priceOf);

        expect(result.items.some((item) => item.itemHrid === '/items/junk')).toBe(false);
        expect(result.actualValue).toBe(2000);
    });

    test('nothing opened yet is not a verdict', () => {
        // A ratio of zero would read as catastrophically unlucky
        expect(chestPerformance({ opened: 0, loot: {} }, dropTable, priceOf).ratio).toBeNull();
    });

    test('counts loot from a table that no longer lists it', () => {
        // Drop tables change between game updates; history should not vanish
        const entry = { opened: 1, loot: { '/items/rare': 2 } };
        const result = chestPerformance(entry, [], priceOf);
        expect(result.actualValue).toBe(200000);
        expect(result.expectedValue).toBe(0);
    });
});

describe('summariseTally', () => {
    const dropTables = { [CHEST]: dropTable, '/items/big_chest': dropTable };

    test('puts the worst chest first', () => {
        const tally = {
            [CHEST]: { opened: 100, loot: { '/items/coin': 20000, '/items/rare': 2 } },
            '/items/big_chest': { opened: 100, loot: { '/items/coin': 20000 } },
        };
        expect(summariseTally(tally, dropTables, priceOf)[0].chestHrid).toBe('/items/big_chest');
    });

    test('skips chests with no history', () => {
        const tally = { [CHEST]: { opened: 0, loot: {} } };
        expect(summariseTally(tally, dropTables, priceOf)).toEqual([]);
    });

    test('survives an empty tally', () => {
        expect(summariseTally(null, dropTables, priceOf)).toEqual([]);
    });
});

describe('tallyTotals', () => {
    test('one chest running hot does not hide another running cold', () => {
        const rows = [
            { opened: 10, actualValue: 5000, expectedValue: 10000 },
            { opened: 10, actualValue: 15000, expectedValue: 10000 },
        ];
        expect(tallyTotals(rows)).toMatchObject({ opened: 20, difference: 0, ratio: 1 });
    });

    test('no history is no verdict', () => {
        expect(tallyTotals([]).ratio).toBeNull();
    });
});
