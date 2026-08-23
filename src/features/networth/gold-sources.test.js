import { describe, test, expect } from 'vitest';
import {
    attributeGoldSources,
    alchemySessionNet,
    enhancementSessionNet,
    marketplaceByDay,
    dailyCloses,
    daysBetween,
    lootEntryValue,
    splitDropKey,
    utcDayId,
} from './gold-sources.js';

const DAY = 24 * 60 * 60 * 1000;

/** 2026-08-20T12:00:00Z and the two days around it */
const D18 = Date.parse('2026-08-18T12:00:00Z');
const D19 = Date.parse('2026-08-19T12:00:00Z');
const D20 = Date.parse('2026-08-20T12:00:00Z');

/** A pricer over a small item table */
const priceTable = {
    '/items/cheese:0': 100,
    '/items/milk:0': 40,
    '/items/log:0': 10,
    '/items/sword:0': 1000,
    '/items/sword:5': 9000,
    '/items/apple:0': 7,
    '/items/coffee:0': 25,
    '/items/prime_catalyst:0': 500,
};
const price = (itemHrid, enhancementLevel = 0) => priceTable[`${itemHrid}:${enhancementLevel || 0}`] ?? null;

describe('day helpers', () => {
    test('utcDayId and daysBetween walk whole UTC days', () => {
        expect(utcDayId(D20)).toBe('2026-08-20');
        expect(daysBetween(D18, D20)).toEqual(['2026-08-18', '2026-08-19', '2026-08-20']);
    });

    test('splitDropKey separates an enhancement level from the hrid', () => {
        expect(splitDropKey('/items/sword::5')).toEqual({ itemHrid: '/items/sword', enhancementLevel: 5 });
        expect(splitDropKey('/items/milk')).toEqual({ itemHrid: '/items/milk', enhancementLevel: 0 });
    });

    test('lootEntryValue prices every drop in an entry', () => {
        const entry = { drops: { '/items/milk': 3, '/items/sword::5': 1 } };
        expect(lootEntryValue(entry, price)).toBe(3 * 40 + 9000);
    });

    test('dailyCloses keeps the last snapshot of each day', () => {
        const closes = dailyCloses([
            { t: D20 - 3600_000, total: 100 },
            { t: D20, total: 250 },
            { t: D19, total: 50 },
        ]);
        expect(closes).toEqual({ '2026-08-19': 50, '2026-08-20': 250 });
    });
});

describe('alchemySessionNet', () => {
    test('outputs less the inputs every attempt consumed', () => {
        const session = {
            startTime: D20,
            inputItemHrid: '/items/milk',
            totalAttempts: 10,
            results: { '/items/cheese': { count: 4 } },
        };
        // 4 cheese at 100 minus 10 milk at 40
        expect(alchemySessionNet(session, price)).toBe(400 - 400);
    });

    test('a run that produced less than it ate is negative, not zero', () => {
        const session = {
            startTime: D20,
            inputItemHrid: '/items/milk',
            totalAttempts: 10,
            results: { '/items/cheese': { count: 1 } },
        };
        expect(alchemySessionNet(session, price)).toBe(100 - 400);
    });

    test('coinify coins and catalysts both count', () => {
        const session = {
            startTime: D20,
            inputItemHrid: '/items/log',
            totalAttempts: 5,
            totalCoinsEarned: 900,
            primeCatalystUsed: 1,
        };
        expect(alchemySessionNet(session, price)).toBe(900 - 5 * 10 - 500);
    });

    test('an unpriceable output falls back to the value recorded at the time', () => {
        const session = {
            startTime: D20,
            inputItemHrid: '/items/log',
            totalAttempts: 1,
            results: { '/items/unknown_thing': { count: 2, totalValue: 777 } },
        };
        expect(alchemySessionNet(session, price)).toBe(777 - 10);
    });
});

describe('enhancementSessionNet', () => {
    test('value gained less what the run cost', () => {
        const session = { itemHrid: '/items/sword', startLevel: 0, currentLevel: 5, totalCost: 3000 };
        expect(enhancementSessionNet(session, price)).toBe(9000 - 1000 - 3000);
    });

    test('a run that cost more than it added is a loss', () => {
        const session = { itemHrid: '/items/sword', startLevel: 0, currentLevel: 5, totalCost: 50000 };
        expect(enhancementSessionNet(session, price)).toBe(9000 - 1000 - 50000);
    });

    test('an item with no price at one of its levels is not valued at all', () => {
        const session = { itemHrid: '/items/sword', startLevel: 0, currentLevel: 20, totalCost: 10 };
        expect(enhancementSessionNet(session, price)).toBeNull();
    });
});

describe('marketplaceByDay', () => {
    test('profit is matched against recorded buys, and tax is reported apart', () => {
        const fills = [
            { t: D18, itemHrid: '/items/cheese', side: 'buy', quantity: 10, price: 100, coins: 1000 },
            { t: D20, itemHrid: '/items/cheese', side: 'sell', quantity: 10, price: 200, coins: 1900 },
        ];
        const byDay = marketplaceByDay(fills, 0.05);
        // Gross 2000, cost 1000, tax 100
        expect(byDay['2026-08-20'].realisedGross).toBe(1000);
        expect(byDay['2026-08-20'].tax).toBe(100);
    });

    test('a sell with no recorded buy realises nothing but still pays tax', () => {
        const fills = [{ t: D20, itemHrid: '/items/cheese', side: 'sell', quantity: 5, price: 100, coins: 475 }];
        const byDay = marketplaceByDay(fills, 0.05);
        expect(byDay['2026-08-20'].realisedGross).toBe(0);
        expect(byDay['2026-08-20'].tax).toBe(25);
    });

    test('buys before the window still fill the cost pool', () => {
        const fills = [
            { t: D18 - 30 * DAY, itemHrid: '/items/cheese', side: 'buy', quantity: 4, price: 50, coins: 200 },
            { t: D20, itemHrid: '/items/cheese', side: 'sell', quantity: 4, price: 100, coins: 380 },
        ];
        expect(marketplaceByDay(fills, 0.05)['2026-08-20'].realisedGross).toBe(200);
    });
});

describe('attributeGoldSources', () => {
    const actionType = (hrid) =>
        ({
            '/actions/combat/cow': '/action_types/combat',
            '/actions/milking/cow': '/action_types/milking',
            '/actions/cooking/pie': '/action_types/cooking',
        })[hrid] || null;

    const base = {
        from: D19,
        to: D20 + 3600_000,
        price,
        marketTax: 0.05,
        actionType,
        series: [
            { t: D18, total: 0 },
            { t: D19, total: 5000 },
            { t: D20, total: 25000 },
        ],
    };

    test('combat and gathering are read from the loot log and kept apart', () => {
        const result = attributeGoldSources({
            ...base,
            lootEntries: [
                {
                    startTime: new Date(D20).toISOString(),
                    actionHrid: '/actions/combat/cow',
                    drops: { '/items/log': 10 },
                },
                {
                    startTime: new Date(D20).toISOString(),
                    actionHrid: '/actions/milking/cow',
                    drops: { '/items/milk': 5 },
                },
            ],
        });

        expect(result.totals.sources.combat).toBe(100);
        expect(result.totals.sources.gathering).toBe(200);
    });

    test('production loot entries are ignored, so the recorder is not double counted', () => {
        const result = attributeGoldSources({
            ...base,
            lootEntries: [
                {
                    startTime: new Date(D20).toISOString(),
                    actionHrid: '/actions/cooking/pie',
                    drops: { '/items/cheese': 100 },
                },
            ],
            productionDays: [{ d: '2026-08-20', outputValue: 10000, inputValue: 4000 }],
        });

        expect(result.totals.sources.combat).toBe(0);
        expect(result.totals.sources.gathering).toBe(0);
        expect(result.totals.sources.production).toBe(6000);
    });

    test('the residual is the measured change minus what was explained, and is never spread', () => {
        const result = attributeGoldSources({
            ...base,
            lootEntries: [
                {
                    startTime: new Date(D20).toISOString(),
                    actionHrid: '/actions/combat/cow',
                    drops: { '/items/cheese': 50 },
                },
            ],
        });

        // The window covers the 19th and the 20th, so the change is measured
        // from the 18th's close: 0 -> 25000, of which 5000 is explained
        expect(result.totals.delta).toBe(25000);
        expect(result.totals.explained).toBe(5000);
        expect(result.totals.residual).toBe(20000);
        // Nothing was moved into the source rows to close the gap
        expect(result.totals.sources.combat).toBe(5000);
    });

    test('a day with no snapshot has no delta and no residual rather than an invented one', () => {
        const result = attributeGoldSources({
            ...base,
            from: D18,
            series: [
                { t: D18, total: 1000 },
                { t: D20, total: 4000 },
            ],
            productionDays: [{ d: '2026-08-19', outputValue: 500, inputValue: 0 }],
        });

        const quiet = result.days.find((row) => row.day === '2026-08-19');
        expect(quiet.delta).toBeNull();
        expect(quiet.residual).toBeNull();
        expect(quiet.sources.production).toBe(500);
        // The window's own delta is still measured end to end
        expect(result.totals.delta).toBe(3000);
    });

    test('costs come through negative', () => {
        const result = attributeGoldSources({
            ...base,
            combatSessions: [
                {
                    combatStartTime: new Date(D20).toISOString(),
                    players: [{ isCurrentPlayer: true, consumables: [{ itemHrid: '/items/coffee', consumed: 8 }] }],
                },
            ],
            tradeFills: [{ t: D20, itemHrid: '/items/cheese', side: 'sell', quantity: 5, price: 100, coins: 475 }],
        });

        expect(result.totals.sources.consumables).toBe(-200);
        expect(result.totals.sources.marketTax).toBe(-25);
    });

    test('offline income is its own row', () => {
        const result = attributeGoldSources({
            ...base,
            productionDays: [{ d: '2026-08-20', outputValue: 0, inputValue: 0, offlineProfit: 1234 }],
        });
        expect(result.totals.sources.offline).toBe(1234);
        expect(result.totals.sources.production).toBe(0);
    });

    test('unpriceable enhancement runs are counted, not silently valued at zero', () => {
        const result = attributeGoldSources({
            ...base,
            enhancementSessions: [
                { startTime: D20, itemHrid: '/items/sword', startLevel: 0, currentLevel: 20, totalCost: 10 },
                { startTime: D20, itemHrid: '/items/sword', startLevel: 0, currentLevel: 5, totalCost: 1000 },
            ],
        });

        expect(result.unpricedEnhancementSessions).toBe(1);
        expect(result.totals.sources.enhancement).toBe(9000 - 1000 - 1000);
    });

    test('coverage reports when each recording starts', () => {
        const result = attributeGoldSources({
            ...base,
            lootEntries: [
                { startTime: new Date(D18).toISOString(), actionHrid: '/actions/combat/cow', drops: {} },
                { startTime: new Date(D20).toISOString(), actionHrid: '/actions/combat/cow', drops: {} },
            ],
            productionDays: [{ d: '2026-08-19', outputValue: 1, inputValue: 0 }],
        });

        expect(result.coverage.combat).toBe(D18);
        expect(result.coverage.production).toBe(Date.parse('2026-08-19T00:00:00.000Z'));
        expect(result.coverage.alchemy).toBeNull();
    });

    test('combat and gathering coverage are split the way the attribution splits them', () => {
        // Both live in the loot log, so answering both with the log's earliest
        // entry claimed combat had been recorded since a date on which only
        // foraging had — coverage for a source that had never been seen
        const result = attributeGoldSources({
            ...base,
            lootEntries: [
                { startTime: new Date(D18).toISOString(), actionHrid: '/actions/milking/cow', drops: {} },
                { startTime: new Date(D20).toISOString(), actionHrid: '/actions/combat/cow', drops: {} },
            ],
        });

        expect(result.coverage.gathering).toBe(D18);
        expect(result.coverage.combat).toBe(D20);
    });

    test('gathering coverage is null when only combat has ever been logged', () => {
        const result = attributeGoldSources({
            ...base,
            lootEntries: [{ startTime: new Date(D20).toISOString(), actionHrid: '/actions/combat/cow', drops: {} }],
        });

        expect(result.coverage.gathering).toBeNull();
    });

    test('production actions nothing could be priced for are counted and reported', () => {
        const result = attributeGoldSources({
            ...base,
            productionDays: [
                { d: '2026-08-19', outputValue: 100, inputValue: 40, actions: 2, unpricedActions: 7 },
                // Outside the window, so its uncounted actions are not this window's
                { d: '2026-08-01', outputValue: 0, inputValue: 0, unpricedActions: 3 },
            ],
        });

        expect(result.unpricedProductionActions).toBe(7);
    });

    test('activity outside the window is left out entirely', () => {
        const result = attributeGoldSources({
            ...base,
            lootEntries: [
                {
                    startTime: new Date(D18 - 5 * DAY).toISOString(),
                    actionHrid: '/actions/combat/cow',
                    drops: { '/items/cheese': 1000 },
                },
            ],
        });
        expect(result.totals.sources.combat).toBe(0);
    });
});
