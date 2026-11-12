/** @vitest-environment happy-dom
 *
 * The Consumables tile with dungeon keys, and with a purchase.
 *
 * Built from the real forecast and key-row modules, so what is asserted is what
 * the tile draws: your key and each member's stated keys in the You/Party
 * countdowns, your keys (and chest keys) in the Ask/day, and a bought stack
 * showing without waiting for the next battle.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    items: {},
    actionDetail: null,
    inventory: [],
    latest: null,
    stats: {},
    prices: {},
    handlers: {},
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: (hrid) => game.items[hrid],
        getActionDetails: () => game.actionDetail,
        getInventory: () => game.inventory,
        getCurrentActions: () => [],
        getInitClientData: () => ({}),
        getCurrentCharacterId: () => 'char1',
        getCurrentCharacterGameMode: () => 'standard',
        on: (event, handler) => {
            (game.handlers[event] ||= []).push(handler);
        },
        off: () => {},
        emit: (event, payload) => {
            for (const handler of game.handlers[event] || []) handler(payload);
        },
    },
}));
vi.mock('../../utils/market-data.js', () => ({ getItemPrices: (hrid) => game.prices[hrid] || {} }));
vi.mock('../../utils/key-cost.js', () => ({
    describeKeyCost: () => null,
    resolveKeyPricing: () => ({ setting: 'ask', priceSide: 'ask', basis: 'market' }),
}));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));
vi.mock('./combat-stats-data-collector.js', () => ({ default: { getLatestData: () => game.latest } }));
vi.mock('./combat-stats-calculator.js', () => ({
    valueOfLoot: () => ({ ask: 0, bid: 0, value: 0 }),
    calculatePlayerStats: (player) => game.stats[player.name] || {},
    describeLuckAdjustment: () => '',
}));

const { registeredRows } = await import('../../utils/overlay-rows.js');
const { default: dataManager } = await import('../../core/data-manager.js');
await import('./combat-stats-rows.js');

const DEN = '/actions/combat/sinister_circus';
const KEY = '/items/sinister_entry_key';
const CHEST_KEY = '/items/sinister_chest_key';
const CAKE = '/items/spaceberry_cake';
const bag = (hrid, count) => ({ itemHrid: hrid, count, itemLocationHrid: '/item_locations/inventory' });
const cake = (held) => ({
    itemHrid: CAKE,
    itemName: 'Spaceberry Cake',
    inventoryAmount: held,
    consumptionRate: 0.001,
    pricePerItem: 100,
});

const tile = () => registeredRows().find((row) => row.key === 'consumables');
const draw = () => {
    const container = document.createElement('div');
    tile().render(container);
    return container.textContent;
};

beforeEach(() => {
    game.items = {
        [KEY]: { name: 'Sinister Entry Key' },
        [CHEST_KEY]: { name: 'Sinister Chest Key' },
        [CAKE]: { name: 'Spaceberry Cake' },
    };
    game.actionDetail = { combatZoneInfo: { isDungeon: true, dungeonInfo: { keyItemHrid: KEY } } };
    game.prices = {
        [KEY]: { ask: 1000, bid: 900 },
        [CHEST_KEY]: { ask: 2000, bid: 1800 },
        [CAKE]: { ask: 100, bid: 90 },
    };
    game.inventory = [bag(KEY, 62), bag(CHEST_KEY, 5), bag(CAKE, 100_000)];
    game.latest = {
        durationSeconds: 3600,
        actionHrid: DEN,
        players: [
            {
                name: 'Me',
                isCurrentPlayer: true,
                loot: {
                    a: { itemHrid: '/items/sinister_chest', count: 4 },
                    b: { itemHrid: '/items/sinister_refinement_chest', count: 4 },
                },
            },
            { name: 'Kasvitatti' },
        ],
    };
    game.stats = {
        Me: { consumableBreakdown: [cake(100_000)], keyBreakdown: [] },
        Kasvitatti: { consumableBreakdown: [cake(82)], keyBreakdown: [] },
    };
    window.Toolasha = {
        Combat: {
            dungeonTracker: {
                getCurrentRun: () => ({ dungeonHrid: DEN, keyCountsMap: { Me: 62, Kasvitatti: 77 } }),
            },
        },
    };
    // The tile's forecast is cached; a character switch is the way to start clean
    dataManager.emit('character_switching');
});

describe('keys in the tile', () => {
    test("the You and Party countdowns include the key, yours and a member's stated count", () => {
        const text = draw();

        // 62 keys at 96 a day against days of cake; 77 keys against 22h 46m of cake
        expect(text).toContain('You:15h 30m');
        expect(text).toContain('Party:19h 15m');
        expect(text).toContain('Sinister Entry Key');
    });

    test('a member with no stated count adds no countdown', () => {
        window.Toolasha.Combat.dungeonTracker.getCurrentRun = () => ({ dungeonHrid: DEN, keyCountsMap: { Me: 62 } });
        dataManager.emit('character_switching');

        // Kasvitatti's cake alone: 22h 46m
        expect(draw()).toContain('Party:22h 46m');
    });

    test('the Ask per day counts your entry key and your chest key, and the chest key never counts down', () => {
        const container = document.createElement('div');
        tile().render(container);

        // Entry 96 x 1000 + chest 192 x 2000 + cake 86.4 x 100
        expect(container.title).toContain('Ask: 488.64K');
        // 5 chest keys at 192 a day would be 37 minutes: not the You countdown
        expect(container.textContent).toContain('You:15h 30m');
    });

    test("a different dungeon's key counts are ignored", () => {
        window.Toolasha.Combat.dungeonTracker.getCurrentRun = () => ({
            dungeonHrid: '/actions/combat/other',
            keyCountsMap: { Kasvitatti: 1 },
        });
        dataManager.emit('character_switching');

        expect(draw()).toContain('Party:22h 46m');
    });
});

describe('a purchase shows without a new battle', () => {
    test('items_updated drops the cache and the live inventory sets the held counts', () => {
        const before = draw();
        const versionBefore = tile().version();
        expect(before).toContain('You:15h 30m');

        // Bought 100 keys; the collector's snapshot still says what it said at the last battle
        game.inventory = [bag(KEY, 162), bag(CHEST_KEY, 5), bag(CAKE, 100_000)];
        dataManager.emit('items_updated', {});

        const after = draw();
        // 162 keys at 96 a day is 1d 16h 52m... and the limiting held count is the new one
        expect(after).not.toContain('You:15h 30m');
        expect(after).toContain('162');
        expect(tile().version()).not.toBe(versionBefore);
    });

    test('a purchase of a non-limiting item still redraws the tile', () => {
        const versionBefore = tile().version();

        game.inventory = [bag(KEY, 62), bag(CHEST_KEY, 5), bag(CAKE, 150_000)];
        dataManager.emit('items_updated', {});

        expect(tile().version()).not.toBe(versionBefore);
    });

    test('without the event the cached forecast is still served', () => {
        draw();
        game.inventory = [bag(KEY, 162), bag(CHEST_KEY, 5), bag(CAKE, 100_000)];

        expect(draw()).toContain('You:15h 30m');
    });

    test('party members keep the snapshot count: the live bag is only yours', () => {
        game.inventory = [bag(KEY, 62), bag(CAKE, 5)];
        dataManager.emit('items_updated', {});

        // Kasvitatti's cake is theirs, not read from your bag
        expect(draw()).toContain('Party:19h 15m');
    });
});
