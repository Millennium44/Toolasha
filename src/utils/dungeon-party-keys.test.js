/**
 * The party's key rows: yours from the bag, a member's from the key-count message.
 *
 * Pure builder tested directly; the impure wrapper only gathers its arguments.
 */

import { describe, test, expect, vi } from 'vitest';

vi.mock('../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => 'char1', getItemDetails: () => null },
}));
vi.mock('./market-data.js', () => ({ getItemPrices: () => ({}) }));
vi.mock('./key-cost.js', () => ({
    describeKeyCost: () => null,
    resolveKeyPricing: () => ({ setting: 'ask', priceSide: 'ask', basis: 'market' }),
}));
vi.mock('./bundle-bridge.js', () => ({
    dungeonTracker: () => null,
    guildMemberSkills: () => null,
    marketUndercutAlerts: () => null,
}));

const { buildKeyRows, keyRoute, statedKeys, withLiveCounts, chestKeyForEntryKey } =
    await import('./dungeon-party-keys.js');
const { firstToRunOut, costPerDaySides, forecast } = await import('./consumable-forecast.js');

const DEN = '/actions/combat/sinister_circus';
const KEY = '/items/sinister_entry_key';
const CHEST_KEY = '/items/sinister_chest_key';
const inventory = (entry, chest = 0) => [
    { itemHrid: KEY, count: entry, itemLocationHrid: '/item_locations/inventory' },
    { itemHrid: CHEST_KEY, count: chest, itemLocationHrid: '/item_locations/inventory' },
];

/** An hour of dungeoning: 4 regular and 4 refinement chests, so 4 entry keys and 8 chest keys spent */
const session = (players) => ({
    actionHrid: DEN,
    durationSeconds: 3600,
    players: players ?? [
        {
            name: 'Me',
            isCurrentPlayer: true,
            loot: {
                a: { itemHrid: '/items/sinister_chest', count: 4 },
                b: { itemHrid: '/items/sinister_refinement_chest', count: 4 },
            },
        },
        { name: 'Ana' },
        { name: 'Zed' },
    ],
});
const stats = { keyBreakdown: [] };
const build = (extra = {}) =>
    buildKeyRows({
        data: session(extra.players),
        statsOf: () => stats,
        inventory: extra.inventory ?? inventory(62, 5),
        keyCounts: extra.keyCounts ?? { Me: 62, Ana: 77, Zed: 0 },
        keyHrid: KEY,
        chestKeyHrid: CHEST_KEY,
        itemName: (hrid) => hrid,
        pricesFor: () => ({ ask: 1000, bid: 900 }),
        ...extra.rest,
    });
const rowOf = (rows, name) => [...rows.entries()].find(([player]) => player.name === name)?.[1];

describe("a member's key row", () => {
    test('comes from the stated count, at your clear rate (96 a day)', () => {
        const rows = build();
        const ana = rowOf(rows, 'Ana').entry;

        expect(ana.held).toBe(77);
        expect(ana.statedCount).toBe(true);
        expect(ana.perDay).toBeCloseTo(96, 5);
        expect(ana.secondsLeft).toBeCloseTo((77 / 96) * 86400, 3);
    });

    test('a member the message did not name gets no row at all', () => {
        const rows = build({ keyCounts: { Me: 62, Ana: 77 } });

        expect(rowOf(rows, 'Zed')).toBeUndefined();
        expect(rowOf(rows, 'Ana')).toBeDefined();
    });

    test('a stated zero is a real row that stops them now', () => {
        const zed = rowOf(build(), 'Zed').entry;

        expect(zed.held).toBe(0);
        expect(zed.secondsLeft).toBe(0);
        expect(firstToRunOut([zed])).toBe(zed);
    });

    test('is the soonest when it runs out before their food', () => {
        const rows = build();
        const food = forecast({
            itemHrid: '/items/coffee',
            itemName: 'Coffee',
            inventoryAmount: 5000,
            consumptionRate: 0.001,
        });

        expect(firstToRunOut([food, rowOf(rows, 'Ana').entry]).isKey).toBe(true);
    });

    test('someone sharing your name is not counted as a second you, nor given your bag', () => {
        const players = session().players;
        players.push({ name: 'Me' });
        const rows = build({ players, keyCounts: { Me: 999 } });
        const mine = [...rows.keys()].filter((player) => player.name === 'Me');

        expect(mine).toHaveLength(1);
        expect(rows.get(mine[0]).entry.held).toBe(62);
        expect(rows.get(mine[0]).entry.statedCount).toBe(false);
    });

    test('invalid or blank stated counts are not zeros', () => {
        expect(statedKeys({ A: null }, 'A')).toBeNull();
        expect(statedKeys({ A: '' }, 'A')).toBeNull();
        expect(statedKeys({ A: -3 }, 'A')).toBeNull();
        expect(statedKeys({ A: '12' }, 'A')).toBe(12);
        expect(statedKeys({}, 'toString')).toBeNull();
    });
});

describe('your own rows', () => {
    test('the entry key reads the bag, not the message', () => {
        const mine = rowOf(build(), 'Me').entry;

        expect(mine.held).toBe(62);
        expect(mine.statedCount).toBe(false);
    });

    test('the chest key is separate, costed, and only yours', () => {
        const rows = build();
        const mine = rowOf(rows, 'Me');

        // 8 chests in an hour, 5 held
        expect(mine.chest.held).toBe(5);
        expect(mine.chest.perDay).toBeCloseTo(192, 5);
        expect(mine.chest.isChestKey).toBe(true);
        expect(rowOf(rows, 'Ana').chest).toBeNull();
        // It is a cost: with the entry key it is 96 + 192 keys a day at 1000
        expect(costPerDaySides([mine.entry, mine.chest]).ask).toBeCloseTo(288_000, 3);
        // And because it is not in the list the stop-calculation reads, it can never be what stops you
        expect(firstToRunOut([mine.entry])).toBe(mine.entry);
    });

    test('no chest has dropped: the rate is unknown, not zero', () => {
        const players = [{ name: 'Me', isCurrentPlayer: true, loot: {} }];
        const mine = rowOf(build({ players }), 'Me');

        expect(mine.entry.rateKnown).toBe(false);
        expect(mine.chest.rateKnown).toBe(false);
    });

    test('outside a dungeon there is nothing to build', () => {
        expect(build({ rest: { keyHrid: null } }).size).toBe(0);
    });
});

describe('key pricing', () => {
    const craftCost = {
        unitCost: 40_000,
        cheaper: 'craft',
        craftActionHrid: '/actions/crafting/key',
        craftCost: 40_000,
    };

    test('craft cost prices the row at the recipe and routes the buy to the materials', () => {
        const mine = rowOf(build({ rest: { craftBasis: true, keyCost: craftCost } }), 'Me').entry;

        expect(mine.route).toBe('craft');
        expect(mine.craftActionHrid).toBe('/actions/crafting/key');
        expect(mine.costPerDaySides.ask).toBeCloseTo(96 * 40_000, 3);
        expect(mine.costPerDaySides.bid).toBeCloseTo(96 * 40_000, 3);
        expect(mine.price).toBe(40_000);
    });

    test('the market basis keeps the market book and the buy route', () => {
        const mine = rowOf(build({ rest: { craftBasis: false, keyCost: craftCost } }), 'Me').entry;

        expect(mine.route).toBe('buy');
        expect(mine.costPerDaySides.ask).toBeCloseTo(96 * 1000, 3);
        expect(mine.costPerDaySides.bid).toBeCloseTo(96 * 900, 3);
    });

    test('a craft setting with no priceable recipe falls back to buying and says why', () => {
        for (const cost of [null, { unitCost: 1000, cheaper: 'buy', craftActionHrid: null, craftCost: null }]) {
            const route = keyRoute(cost, true, { ask: 1000, bid: 900 });
            expect(route.route).toBe('buy');
            expect(route.craftActionHrid).toBeNull();
            expect(route.note).toContain('priced and bought at the market');
        }
        const unpriced = keyRoute({ cheaper: 'buy', craftActionHrid: '/actions/x', craftCost: null }, true, {});
        expect(unpriced.note).toContain('has no price');
    });

    test("a member's key is never priced at your craft cost: market for them, craft for you", () => {
        const rows = build({ rest: { craftBasis: true, keyCost: craftCost } });
        const ana = rowOf(rows, 'Ana').entry;
        const me = rowOf(rows, 'Me').entry;

        expect(ana.route).toBe('buy');
        expect(ana.price).toBe(1000);
        expect(ana.costPerDaySides.ask).toBeCloseTo(96 * 1000, 3);
        expect(ana.costPerDaySides.bid).toBeCloseTo(96 * 900, 3);
        expect(me.route).toBe('craft');
        expect(me.costPerDaySides.ask).toBeCloseTo(96 * 40_000, 3);
        expect(me.price).toBe(40_000);
    });

    test("even when the keys' row price was measured at your craft cost, the member refill uses the market", () => {
        const priced = { keyBreakdown: [{ itemHrid: KEY, count: 4, pricePerItem: 40_000 }] };
        const rows = buildKeyRows({
            data: session(),
            statsOf: () => priced,
            inventory: inventory(62),
            keyCounts: { Ana: 77 },
            keyHrid: KEY,
            pricesFor: () => ({ ask: 1000, bid: 900 }),
            keyCost: craftCost,
            craftBasis: true,
        });

        expect(rowOf(rows, 'Ana').entry.price).toBe(1000);
        expect(rowOf(rows, 'Me').entry.price).toBe(40_000);
    });
});

describe('helpers', () => {
    test('the chest key follows the entry key', () => {
        expect(chestKeyForEntryKey(KEY)).toBe(CHEST_KEY);
        expect(chestKeyForEntryKey('/items/coin')).toBeNull();
    });

    test('live counts overlay only the current player', () => {
        const breakdown = [{ itemHrid: '/items/coffee', inventoryAmount: 3 }];
        const bag = [{ itemHrid: '/items/coffee', count: 90 }];

        expect(withLiveCounts(breakdown, { isCurrentPlayer: true }, bag)[0].inventoryAmount).toBe(90);
        expect(withLiveCounts(breakdown, { isCurrentPlayer: false }, bag)).toBe(breakdown);
        expect(withLiveCounts(breakdown, { isCurrentPlayer: true }, [])).toBe(breakdown);
    });
});
