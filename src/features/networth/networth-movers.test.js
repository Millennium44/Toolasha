import { describe, test, expect, beforeEach, vi } from 'vitest';

const disk = vi.hoisted(() => ({ map: new Map(), failSet: false, failGetMany: false, failDelete: false }));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: vi.fn(async (key, store, fallback) => (disk.map.has(key) ? disk.map.get(key) : fallback)),
        set: vi.fn(async (key, value) => {
            if (disk.failSet) throw new Error('quota');
            disk.map.set(key, structuredClone(value));
        }),
        delete: vi.fn(async (key) => {
            if (disk.failDelete) throw new Error('delete failed');
            disk.map.delete(key);
        }),
        getMany: vi.fn(async (keys) => {
            if (disk.failGetMany) throw new Error('read failed');
            return new Map(keys.map((key) => [key, disk.map.get(key)]));
        }),
        getAllKeys: vi.fn(async () => [...disk.map.keys()]),
    },
}));
vi.mock('../../core/config.js', () => ({
    default: { getSettingValue: (id) => ({ networth_pricingMode: 'ask', networth_valueSource: 'orderBook' })[id] },
}));
vi.mock('../../utils/ironcow-valuation.js', () => ({
    isIronCowCharacter: () => false,
    getIronCowValuationMode: () => 'market',
}));

const mod = await import('./networth-movers.js');
const { default: movers, isBigJump, selectKept, buildRows, buildRecord, diffRecords } = mod;
const { partitionOwnedKeys, ownsKey } = await import('../sync/sync-ownership.js');

const ctx = { pm: 'ask', vs: 'orderBook', ic: null };
const H = (n) => `/items/${n}`;

/** A calculator result in the shapes the calculator emits */
function data({ inventory = [], equipped = [], listings = [], books = [] } = {}) {
    return {
        currentAssets: {
            inventory: { breakdown: inventory },
            equipped: { breakdown: equipped },
            listings: { breakdown: listings },
        },
        fixedAssets: { abilityBooks: { breakdown: books } },
    };
}

function record(rows, extra = {}) {
    return {
        v: 1,
        cid: 'c1',
        t: 2,
        prevT: 1,
        jump: false,
        total: 0,
        nonExcluded: 0,
        house: 0,
        abilities: 0,
        shrines: null,
        ...ctx,
        cut: 0,
        rows,
        ...extra,
    };
}

describe('isBigJump', () => {
    test('100M or 1% either way, not less, and never from nothing', () => {
        expect(isBigJump(10e9, 10.1e9)).toBe(true);
        expect(isBigJump(10e9, 9.9e9)).toBe(true);
        expect(isBigJump(100e6, 101e6)).toBe(true); // 1%
        expect(isBigJump(10e9, 10.05e9)).toBe(false);
        expect(isBigJump(1e6, 1.0001e6)).toBe(false);
        expect(isBigJump(null, 5e9)).toBe(false);
        expect(isBigJump(0, 5e6)).toBe(false);
    });
});

describe('selectKept', () => {
    const run = (n, jumps = {}) =>
        Array.from({ length: n }, (_, i) => ({ t: i + 1, prevT: i === 0 ? null : i, jump: jumps[i + 1] === true }));

    test('keeps the 24 newest readings and nothing older without a jump', () => {
        const kept = selectKept(run(30));
        expect([...kept].sort((a, b) => a - b)).toEqual(Array.from({ length: 24 }, (_, i) => i + 7));
    });

    test('an older jump is kept with the reading before it', () => {
        const kept = selectKept(run(40, { 5: true }));
        expect(kept.has(5)).toBe(true);
        expect(kept.has(4)).toBe(true);
        expect(kept.has(3)).toBe(false);
        expect(kept.size).toBe(26);
    });

    test('only the newest 10 jumps are held, 12 old jumps keep the 10 newest pairs', () => {
        const jumps = {};
        for (let t = 2; t <= 24; t += 2) jumps[t] = true; // 12 jumps at 2..24
        const kept = selectKept(run(60, jumps));
        const heldJumps = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24].filter((t) => kept.has(t));
        expect(heldJumps).toEqual([6, 8, 10, 12, 14, 16, 18, 20, 22, 24]);
        // 24 recent + 10 jumps + their 10 predecessors (t-1 are 5..23 odd; 5 .. 23)
        expect(kept.size).toBe(24 + 10 + 10);
    });

    test('a pair whose first half is already gone keeps only the jump', () => {
        const index = [
            { t: 10, prevT: 5, jump: true },
            ...Array.from({ length: 30 }, (_, i) => ({ t: 100 + i, prevT: 99 + i, jump: false })),
        ];
        const kept = selectKept(index);
        expect(kept.has(10)).toBe(true);
        expect(kept.has(5)).toBe(false);
    });
});

describe('buildRows', () => {
    test('merges duplicates and stacks, keeps levels apart, merges worn with held', () => {
        const rows = buildRows(
            data({
                inventory: [
                    { itemHrid: H('sword'), enhancementLevel: 0, count: 3, value: 300 },
                    { itemHrid: H('sword'), enhancementLevel: 0, count: 4, value: 400 },
                    { itemHrid: H('sword'), enhancementLevel: 10, count: 1, value: 9000 },
                    { itemHrid: H('coin'), enhancementLevel: 0, count: 5000, value: 5000 },
                ],
                equipped: [
                    { itemHrid: H('sword'), enhancementLevel: 10, value: 9100 },
                    { itemHrid: H('cape'), enhancementLevel: 14, value: 70000, partial: true },
                ],
            })
        ).rows;
        const byKey = Object.fromEntries(rows.map((r) => [`${r[1]}:${r[2]}`, r]));
        expect(byKey['/items/sword:0'].slice(0, 5)).toEqual(['h', H('sword'), 0, 7, 700]);
        expect(byKey['/items/sword:10'].slice(0, 5)).toEqual(['h', H('sword'), 10, 2, 18100]);
        expect(byKey['/items/cape:14'][5]).toBe(2);
        expect(byKey['/items/coin:0'][3]).toBe(5000);
    });

    test('a held stack nothing priced is flagged, not valued as a quiet 0', () => {
        const { rows } = buildRows(
            data({ inventory: [{ itemHrid: H('odd'), enhancementLevel: 0, count: 5, value: 0 }] })
        );
        expect(rows).toEqual([['h', H('odd'), 0, 5, 0, 1]]);
    });

    test('empty inventory gives no rows; listings, books keep their own kinds', () => {
        expect(buildRows(data()).rows).toEqual([]);
        const { rows } = buildRows(
            data({
                listings: [
                    { itemHrid: H('log'), enhancementLevel: 0, isSell: true, count: 10, value: 960 },
                    { itemHrid: H('log'), enhancementLevel: 0, isSell: false, count: 10, value: 800 },
                ],
                books: [{ itemHrid: H('book'), count: 2, value: 50 }],
            })
        );
        expect(rows.map((r) => r[0]).sort()).toEqual(['b', 'k', 's']);
    });

    test('a record over the cap keeps the largest and says how many it cut', () => {
        const inventory = Array.from({ length: mod.MAX_ROWS + 5 }, (_, i) => ({
            itemHrid: H(`item_${i}`),
            enhancementLevel: 0,
            count: 1,
            value: i + 1,
        }));
        const { rows, cut } = buildRows(data({ inventory }));
        expect(rows.length).toBe(mod.MAX_ROWS);
        expect(cut).toBe(5);
        expect(rows[0][4]).toBe(mod.MAX_ROWS + 5);
    });
});

describe('diffRecords', () => {
    const base = (rows, total) => record(rows, { total, nonExcluded: total });

    test('quantity only, price only, both: the parts sum to the change', () => {
        const prev = base(
            [
                ['h', H('a'), 0, 3, 300],
                ['h', H('b'), 0, 4, 400],
                ['h', H('c'), 0, 2, 200],
            ],
            900
        );
        const cur = base(
            [
                ['h', H('a'), 0, 5, 500], // quantity
                ['h', H('b'), 0, 4, 480], // price
                ['h', H('c'), 0, 4, 600], // both: unit 100 -> 150
            ],
            1580
        );
        const diff = diffRecords(prev, cur);
        const by = Object.fromEntries(diff.top.map((c) => [c.hrid, c]));
        expect(by[H('a')].cause).toBe('quantity');
        expect(by[H('b')].cause).toBe('price');
        expect(by[H('c')].cause).toBe('both');
        expect(by[H('c')].quantityPart + by[H('c')].pricePart).toBeCloseTo(400);
        expect(by[H('c')].quantityPart).toBeCloseTo(200);
        expect(diff.top.reduce((s, c) => s + c.delta, 0) + diff.rest.delta).toBe(diff.totalDelta);
    });

    test('an item gained or lost entirely, and one level apart from its twin', () => {
        const prev = base(
            [
                ['h', H('x'), 10, 1, 9000],
                ['h', H('x'), 0, 1, 10],
            ],
            9010
        );
        const cur = base(
            [
                ['h', H('x'), 0, 1, 10],
                ['h', H('y'), 0, 2, 40],
            ],
            50
        );
        const diff = diffRecords(prev, cur);
        const causes = Object.fromEntries(diff.top.map((c) => [`${c.hrid}:${c.level}`, c.cause]));
        expect(causes).toEqual({ '/items/x:10': 'lost', '/items/y:0': 'gained' });
    });

    test('a missing price is never read as a real 0: the row says so', () => {
        const prev = base([['h', H('odd'), 0, 5, 0, 1]], 100);
        const cur = base([['h', H('odd'), 0, 5, 5000]], 5100);
        const [row] = diffRecords(prev, cur).top;
        expect(row.cause).toBe('unpriced');
        expect(row.unpricedBefore).toBe(true);
        expect(row.quantityPart).toBe(0);
        expect(row.pricePart).toBe(0);
    });

    test('top 10 by absolute change, the rest in one row, and the list adds up with houses and exclusions', () => {
        const prevRows = [];
        const curRows = [];
        for (let i = 1; i <= 14; i++) {
            prevRows.push(['h', H(`i${i}`), 0, 1, 1000]);
            curRows.push(['h', H(`i${i}`), 0, 1, 1000 + (i % 2 === 0 ? i * 10 : -i * 10)]);
        }
        const prev = record(prevRows, { total: 20000, nonExcluded: 19000, house: 100, abilities: 50, shrines: 10 });
        const cur = record(curRows, { total: 20300, nonExcluded: 19200, house: 160, abilities: 50, shrines: 30 });
        const diff = diffRecords(prev, cur);
        expect(diff.top).toHaveLength(10);
        expect(Math.abs(diff.top[0].delta)).toBeGreaterThanOrEqual(Math.abs(diff.top[9].delta));
        expect(diff.rest.otherItems).toBe(4);
        expect(diff.top.reduce((s, c) => s + c.delta, 0) + diff.rest.delta).toBe(300);
        expect(diff.rest.house).toBe(60);
        expect(diff.rest.shrines).toBe(20);
        expect(diff.rest.excluded).toBe(100);
    });

    test('nothing moved', () => {
        const rows = [['h', H('a'), 0, 3, 300]];
        expect(diffRecords(base(rows, 300), base(rows, 300)).state).toBe('unchanged');
    });

    test('a pricing change between readings is reported', () => {
        const prev = base([['h', H('a'), 0, 1, 100]], 100);
        const cur = { ...base([['h', H('a'), 0, 1, 90]], 90), pm: 'bid' };
        const diff = diffRecords(prev, cur);
        expect(diff.pricing.changed).toBe(true);
        expect(diff.pricing.before.pm).toBe('ask');
        expect(diff.pricing.after.pm).toBe('bid');
        expect(diff.top[0].cause).toBe('price');
        expect(diffRecords(prev, base([['h', H('a'), 0, 1, 90]], 90)).pricing.changed).toBe(false);
    });

    test('a partial bill is carried, and a truncated record is flagged', () => {
        const prev = base([['h', H('cape'), 14, 1, 0, 1]], 0);
        const cur = { ...base([['h', H('cape'), 14, 1, 50000, 2]], 50000), cut: 3 };
        const diff = diffRecords(prev, cur);
        expect(diff.top[0].partialAfter).toBe(true);
        expect(diff.truncated).toBe(true);
    });
});

describe('the store', () => {
    const snap = (t, total) => ({ t, total, nonExcluded: total, gold: 0, house: 5, abilities: 5 });
    const d = (value) => data({ inventory: [{ itemHrid: H('a'), enhancementLevel: 0, count: 2, value }] });

    beforeEach(async () => {
        disk.map.clear();
        disk.failSet = false;
        disk.failGetMany = false;
        disk.failDelete = false;
        movers.reset();
        await movers.load('c1');
    });

    test('keeps 24 recent maps and deletes the rest from disk', () => {
        for (let i = 1; i <= 30; i++)
            movers.record({ characterId: 'c1', snapshot: snap(i * 1000, 1e9 + i), data: d(100) });
        const keys = [...disk.map.keys()].filter((k) => k.startsWith('networthMovers_c1_'));
        expect(keys).toHaveLength(24);
        expect(movers.index).toHaveLength(24);
        expect(disk.map.has('networthMoversIndex_c1')).toBe(true);
    });

    test('a big jump keeps both readings of its pair past the recent window', () => {
        movers.record({ characterId: 'c1', snapshot: snap(1000, 10e9), data: d(100) });
        movers.record({ characterId: 'c1', snapshot: snap(2000, 10.5e9), data: d(500) }); // +500M
        for (let i = 3; i <= 40; i++)
            movers.record({ characterId: 'c1', snapshot: snap(i * 1000, 10.5e9 + i), data: d(500) });
        expect(movers.hasMap(1000)).toBe(true);
        expect(movers.hasMap(2000)).toBe(true);
        expect(movers.hasMap(3000)).toBe(false);
        expect(disk.map.has('networthMovers_c1_1000')).toBe(true);
        expect(disk.map.has('networthMovers_c1_3000')).toBe(false);
    });

    test('a record for another character, or before load, is ignored', () => {
        movers.record({ characterId: 'c2', snapshot: snap(1000, 1), data: d(1) });
        expect(movers.index).toHaveLength(0);
        movers.reset();
        movers.record({ characterId: 'c1', snapshot: snap(1000, 1), data: d(1) });
        expect(disk.map.size).toBe(0);
    });

    test('a failing write costs the detail and throws nothing', async () => {
        disk.failSet = true;
        expect(() => movers.record({ characterId: 'c1', snapshot: snap(1000, 1e9), data: d(1) })).not.toThrow();
        await Promise.resolve();
        expect(disk.map.size).toBe(0);
        // The reading is in the index but has no record: shown as having no detail
        expect((await movers.detailFor(1000)).state).toBe('no-map');
    });

    test('detailFor: no map, first reading, then a diff against the nearest earlier map', async () => {
        expect((await movers.detailFor(1000)).state).toBe('no-map');
        movers.record({ characterId: 'c1', snapshot: snap(1000, 1000), data: d(1000) });
        expect((await movers.detailFor(1000)).state).toBe('no-previous');
        movers.record({ characterId: 'c1', snapshot: snap(2000, 1500), data: d(1500) });
        const result = await movers.detailFor(2000);
        expect(result.since).toBe(1000);
        expect(result.totalDelta).toBe(500);
        expect(result.top[0]).toMatchObject({ hrid: H('a'), cause: 'price', delta: 500 });
    });

    test('a read failure is reported, not thrown', async () => {
        movers.record({ characterId: 'c1', snapshot: snap(1000, 1000), data: d(1000) });
        movers.record({ characterId: 'c1', snapshot: snap(2000, 1500), data: d(1500) });
        disk.failGetMany = true;
        expect((await movers.detailFor(2000)).state).toBe('unreadable');
    });

    test('a character switch while reading returns stale', async () => {
        movers.record({ characterId: 'c1', snapshot: snap(1000, 1000), data: d(1000) });
        movers.record({ characterId: 'c1', snapshot: snap(2000, 1500), data: d(1500) });
        const pending = movers.detailFor(2000);
        movers.reset();
        await movers.load('c2');
        expect((await pending).state).toBe('stale');
    });

    test('load drops index entries without a record and rebuilds a lost index', async () => {
        movers.record({ characterId: 'c1', snapshot: snap(1000, 1000), data: d(1000) });
        movers.record({ characterId: 'c1', snapshot: snap(2000, 1500), data: d(1500) });
        await Promise.resolve();
        disk.map.delete('networthMovers_c1_2000');
        await movers.load('c1');
        expect(movers.index.map((e) => e.t)).toEqual([1000]);

        disk.map.delete('networthMoversIndex_c1');
        await movers.load('c1');
        expect(movers.index.map((e) => e.t)).toEqual([1000]);
    });

    test('the first reading after a character switch has no previous', async () => {
        movers.record({ characterId: 'c1', snapshot: snap(1000, 1000), data: d(1000) });
        movers.reset();
        await movers.load('c2');
        movers.record({ characterId: 'c2', snapshot: snap(5000, 7e9), data: d(1000) });
        expect(movers.index[0].prevT).toBe(null);
        expect(movers.index[0].jump).toBe(false);
        expect((await movers.detailFor(5000)).state).toBe('no-previous');
    });

    test('buildRecord stamps the pricing context and the jump flag', () => {
        const rec = buildRecord({
            characterId: 'c1',
            snapshot: snap(2000, 11e9),
            data: d(1),
            prev: { t: 1000, total: 10e9 },
            context: { pm: 'bid', vs: 'orderBook', ic: null },
        });
        expect(rec).toMatchObject({ jump: true, prevT: 1000, pm: 'bid', cid: 'c1' });
    });
});

describe('sync ownership', () => {
    test('the maps and their index never travel; the synced detail snapshots still do', () => {
        const entries = {
            networthMovers_c1_1000: {},
            networthMoversIndex_c1: [],
            networthMarkerState_c1: {},
            networthDetail_c1_1000: {},
            networthSeries_c1_2026_11: {},
        };
        const { owned } = partitionOwnedKeys('networthHistory', entries);
        expect(Object.keys(owned).sort()).toEqual(['networthDetail_c1_1000', 'networthSeries_c1_2026_11']);
        expect(ownsKey('networthHistory', 'networthMovers_c1_1000')).toBe(false);
        expect(ownsKey('networthHistory', 'networthDetail_c1_1000')).toBe(true);
    });
});

describe('a listing that partly filled', () => {
    test('is a value change with no made-up unit price', () => {
        const row = (count, value) => ['b', H('a'), 0, count, value];
        const prev = record([row(10, 1000)], { total: 1000, nonExcluded: 1000 });
        const cur = record([row(5, 1100)], { total: 1100, nonExcluded: 1100 });
        const change = diffRecords(prev, cur).top[0];
        expect(change.unitBefore).toBeNull();
        expect(change.unitAfter).toBeNull();
        expect(change.cause).toBe('price');
        expect(change.pricePart).toBe(100);
    });
});
