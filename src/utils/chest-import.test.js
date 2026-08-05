import { describe, test, expect } from 'vitest';
import {
    toExport,
    fromToolashaExport,
    fromTreasureExport,
    fromEdibleTools,
    findEdibleToolsData,
    mergeTally,
} from './chest-import.js';

const tally = {
    '/items/small_chest': { opened: 10, loot: { '/items/coin': 2000 }, last: { opened: 1, loot: {} } },
};

describe('toExport', () => {
    test('carries counts, and deliberately not prices', () => {
        // A price is a fact about the market on export day; baking it in makes an
        // old file re-import as a ledger priced in last month's money
        const file = toExport(tally, { capeValue: 'zero' }, 'Someone');
        expect(file.chests['/items/small_chest'].loot).toEqual({ '/items/coin': 2000 });
        expect(JSON.stringify(file)).not.toContain('unitPrice');
    });

    test('names its own format so a reader can tell', () => {
        expect(toExport(tally, {}).format).toBe('toolasha-treasure');
    });
});

describe('fromToolashaExport', () => {
    test('reads back what it wrote', () => {
        const round = fromToolashaExport(toExport(tally, { capeValue: 'mirror' }));
        expect(round.tally).toEqual(tally);
        expect(round.settings.capeValue).toBe('mirror');
    });

    test('declines a file that is not ours', () => {
        expect(fromToolashaExport({ chests: {} })).toBeNull();
        expect(fromToolashaExport(null)).toBeNull();
    });
});

describe('fromTreasureExport', () => {
    // The shape MWI Combat Suite writes: every entry an object with the price
    // and value as they stood at export
    const treasureFile = {
        player: 'Someone',
        settings: { useMirrorValue: 'zero', useCowbell0: true },
        chests: {
            '/items/large_treasure_chest': {
                name: 'Large Treasure Chest',
                total: {
                    opened: 562,
                    loot: {
                        '/items/coin': { name: 'Coin', count: 42524446, unitPrice: 1, totalValue: 42524446 },
                        '/items/pearl': { name: 'Pearl', count: 694, unitPrice: 12250, totalValue: 8501500 },
                    },
                },
                last: { opened: 1, loot: { '/items/coin': { name: 'Coin', count: 222753, unitPrice: 1 } } },
            },
        },
    };

    test('keeps the counts and drops the stale prices', () => {
        const { tally: read } = fromTreasureExport(treasureFile);
        expect(read['/items/large_treasure_chest']).toEqual({
            opened: 562,
            loot: { '/items/coin': 42524446, '/items/pearl': 694 },
            last: { opened: 1, loot: { '/items/coin': 222753 } },
        });
    });

    test('translates its two settings into ours', () => {
        const { settings } = fromTreasureExport(treasureFile);
        expect(settings).toEqual({ capeValue: 'zero', valueCowbells: false });
    });

    test('reads a file that already stores bare counts', () => {
        const bare = { chests: { '/items/c': { total: { opened: 2, loot: { '/items/coin': 5 } } } } };
        expect(fromTreasureExport(bare).tally['/items/c'].loot).toEqual({ '/items/coin': 5 });
    });

    test('declines our own file, so the right reader handles it', () => {
        expect(fromTreasureExport(toExport(tally, {}))).toBeNull();
    });

    test('declines something that is not a chest ledger at all', () => {
        expect(fromTreasureExport({ chests: { a: { nope: true } } })).toBeNull();
        expect(fromTreasureExport({})).toBeNull();
    });
});

describe('fromEdibleTools', () => {
    const names = { Chest: '/items/chest', Coin: '/items/coin', Pearl: '/items/pearl' };
    const data = {
        Chest: { 总计开箱数量: 40, 获得物品: { Coin: { 数量: 900 }, Pearl: { 数量: 3 } } },
    };

    test('translates display names into hrids', () => {
        const { tally: read } = fromEdibleTools(data, names);
        expect(read['/items/chest']).toMatchObject({
            opened: 40,
            loot: { '/items/coin': 900, '/items/pearl': 3 },
        });
    });

    test('reports names it could not translate rather than dropping them', () => {
        // A chest renamed since the data was written would otherwise vanish with
        // no sign anything was lost
        const { unmatched } = fromEdibleTools({ Mystery: { 总计开箱数量: 5, 获得物品: {} } }, names);
        expect(unmatched).toEqual(['Mystery']);
    });

    test('claims no last opening, because it records none', () => {
        // Reusing the total would report one opening of forty chests
        expect(fromEdibleTools(data, names).tally['/items/chest'].last).toEqual({ opened: 0, loot: {} });
    });

    test('survives no data', () => {
        expect(fromEdibleTools(null, names).tally).toEqual({});
    });
});

describe('findEdibleToolsData', () => {
    const stored = {
        Chest_Open_Data: {
            42: { 玩家昵称: 'Someone', 开箱数据: { Chest: { 总计开箱数量: 1 } } },
            99: { 玩家昵称: 'Other', 开箱数据: {} },
        },
    };

    test('finds the current character by id', () => {
        expect(findEdibleToolsData(stored, 42, 'Someone')).toEqual({ Chest: { 总计开箱数量: 1 } });
        expect(findEdibleToolsData(stored, '42', 'Someone')).toBeTruthy();
    });

    test('falls back to the name when the id has moved on', () => {
        expect(findEdibleToolsData(stored, 1234, 'Someone')).toBeTruthy();
    });

    test('returns nothing rather than another player’s ledger', () => {
        expect(findEdibleToolsData(stored, 1234, 'Nobody')).toBeNull();
        expect(findEdibleToolsData(null, 1, 'x')).toBeNull();
    });
});

describe('mergeTally', () => {
    const incoming = {
        '/items/small_chest': { opened: 5, loot: { '/items/coin': 500 }, last: { opened: 5, loot: {} } },
    };

    test('replaces by default, because the same ledger twice is not twice the ledger', () => {
        expect(mergeTally(tally, incoming)).toEqual(incoming);
    });

    test('appending adds the counts', () => {
        const merged = mergeTally(tally, incoming, 'append');
        expect(merged['/items/small_chest'].opened).toBe(15);
        expect(merged['/items/small_chest'].loot['/items/coin']).toBe(2500);
    });

    test('appending keeps the last opening already held', () => {
        // The imported file's "most recent" belongs to another timeline
        const merged = mergeTally(tally, incoming, 'append');
        expect(merged['/items/small_chest'].last).toEqual({ opened: 1, loot: {} });
    });

    test('appending brings in chests not held before', () => {
        const merged = mergeTally(tally, { '/items/new': { opened: 2, loot: {} } }, 'append');
        expect(Object.keys(merged)).toHaveLength(2);
    });
});
