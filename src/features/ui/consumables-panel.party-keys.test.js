/** @vitest-environment happy-dom
 *
 * Keys in the Consumables panel: every member's entry key, the chest key, the
 * craft route, and what other players' sections may and may not offer.
 *
 * The scenario is the one that was reported: you hold 62 Sinister Entry Keys at
 * 96 a day, a party member holds 77 and has food for longer, so it is their keys
 * that stop the run - which the panel used to hide because it only knew yours.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const store = vi.hoisted(() => ({ data: {} }));
const settings = vi.hoisted(() => ({ values: {} }));
const keys = vi.hoisted(() => ({ cost: null }));
const game = vi.hoisted(() => ({
    items: {},
    actionDetail: null,
    inventory: [],
    latest: null,
    statsByName: {},
    characterData: null,
    currentActions: [],
    prices: {},
}));
const shopping = vi.hoisted(() => ({ calls: [] }));

vi.mock('../../utils/background-work.js', () => ({ runInBackground: async (_name, work) => work() }));
vi.mock('../../core/config.js', () => ({
    default: {
        Z_FLOATING_PANEL: 1100,
        getSetting: (key) => settings.values[key] ?? true,
        getSettingValue: (key, fallback) =>
            settings.values[key] ?? (String(key).startsWith('market_') ? fallback : 'compact'),
        setSetting: (key, value) => {
            settings.values[key] = value;
        },
        onSettingChange: () => () => {},
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        ready: Promise.resolve(true),
        get: async (key, _name, fallback = null) => store.data[key] ?? fallback,
        set: async (key, value) => {
            store.data[key] = value;
            return true;
        },
        delete: async (key) => {
            delete store.data[key];
            return true;
        },
        getAllKeys: async () => Object.keys(store.data),
        getJSON: async (key, _name, fallback) => store.data[key] ?? fallback,
        setJSON: async (key, value) => {
            store.data[key] = value;
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: (hrid) => game.items[hrid] || null,
        getActionDetails: () => game.actionDetail,
        getInventory: () => game.inventory,
        getEquipment: () => new Map(),
        getInitClientData: () => ({ itemDetailMap: {}, abilityDetailMap: {} }),
        getCurrentActions: () => game.currentActions,
        get characterData() {
            return game.characterData;
        },
        getSkills: () => [],
        getEquippedAbilities: () => [],
        getCurrentCharacterId: () => 'char1',
        getCurrentCharacterGameMode: () => 'standard',
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../utils/market-data.js', () => ({ getItemPrices: (hrid) => game.prices[hrid] || {} }));
vi.mock('../../utils/key-cost.js', () => ({
    KEY_PRICING_MODES: ['ask', 'bid', 'synced', 'craft'],
    KEY_PRICING_SETTING: 'profitCalc_keyPricingMode',
    describeKeyCost: () => keys.cost,
    invalidateKeyCostCache: () => {},
    resolveKeyPricing: () => {
        const stored = settings.values.profitCalc_keyPricingMode;
        const setting = ['ask', 'bid', 'synced', 'craft'].includes(stored) ? stored : 'ask';
        return {
            setting,
            priceSide: setting === 'bid' ? 'bid' : 'ask',
            basis: setting === 'craft' ? 'craft' : 'market',
        };
    },
}));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));
vi.mock('../../utils/marketplace-autofill.js', () => ({
    createAutofillManager: () => ({ initialize: () => {}, setQuantity: () => {} }),
}));
vi.mock('../../utils/order-book.js', () => ({ estimateFillSeconds: () => null }));
vi.mock('./consumables-shopping-list.js', () => ({
    openShoppingList: (items) => shopping.calls.push(items),
}));
vi.mock('../combat-stats/combat-stats-data-collector.js', () => ({
    default: { getLatestData: () => game.latest },
}));
vi.mock('../combat-stats/combat-stats-calculator.js', () => ({
    valueOfLoot: () => ({ ask: 0, bid: 0, value: 0 }),
    calculatePlayerStats: (player) => game.statsByName[player.name] || {},
}));

const { consumablesPanel } = await import('./consumables-panel.js');
const { dropKeyCostCache } = await import('../../utils/dungeon-party-keys.js');
const { _resetCaches } = await import('../../utils/panel-geometry.js');

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

const DEN = '/actions/combat/sinister_circus';
const KEY = '/items/sinister_entry_key';
const CHEST_KEY = '/items/sinister_chest_key';
const CAKE = '/items/spaceberry_cake';
const bag = (hrid, count) => ({ itemHrid: hrid, count, itemLocationHrid: '/item_locations/inventory' });

const openBill = vi.fn(async () => true);

/** Foods are `{inventoryAmount, consumptionRate}`; keys come from the chests dropped */
const cake = (held, rate = 0.001) => ({
    itemHrid: CAKE,
    itemName: 'Spaceberry Cake',
    inventoryAmount: held,
    consumptionRate: rate,
    pricePerItem: 100,
});

const scene = ({ cakeMe = 100_000, cakeKas = 82, players } = {}) => {
    game.actionDetail = {
        name: 'Sinister Circus',
        outputItems: [{ itemHrid: KEY, count: 1 }],
        combatZoneInfo: { isDungeon: true, dungeonInfo: { keyItemHrid: KEY } },
    };
    game.items = {
        [KEY]: { name: 'Sinister Entry Key' },
        [CHEST_KEY]: { name: 'Sinister Chest Key' },
        [CAKE]: { name: 'Spaceberry Cake' },
    };
    game.prices = {
        [KEY]: { ask: 1000, bid: 900 },
        [CHEST_KEY]: { ask: 2000, bid: 1800 },
        [CAKE]: { ask: 100, bid: 90 },
    };
    game.inventory = [bag(KEY, 62), bag(CHEST_KEY, 5), bag(CAKE, cakeMe)];
    game.latest = {
        durationSeconds: 3600,
        actionHrid: DEN,
        players: players ?? [
            {
                name: 'Me',
                isCurrentPlayer: true,
                // 4 regular and 4 refinement chests in an hour: 96 entry keys and 192 chest keys a day
                loot: {
                    a: { itemHrid: '/items/sinister_chest', count: 4 },
                    b: { itemHrid: '/items/sinister_refinement_chest', count: 4 },
                },
            },
            { name: 'Kasvitatti' },
            { name: 'Zed' },
        ],
    };
    game.statsByName = {
        Me: { consumableBreakdown: [cake(cakeMe)], keyBreakdown: [] },
        Kasvitatti: { consumableBreakdown: [cake(cakeKas)], keyBreakdown: [] },
        Zed: { consumableBreakdown: [cake(100_000)], keyBreakdown: [] },
    };
    game.currentActions = [{ actionHrid: DEN, isDone: false, difficultyTier: 1 }];
    game.characterData = {
        character: { id: 'char1', name: 'Me' },
        partyInfo: { partySlotMap: {} },
    };
    window.Toolasha = {
        Combat: {
            dungeonTracker: {
                getCurrentRun: () => ({
                    dungeonHrid: DEN,
                    keyCountsMap: { Me: 62, Kasvitatti: 77, AFKANDY: 46 },
                }),
            },
        },
        Actions: { missingMaterialsButton: { openCraftBill: openBill } },
    };
};

const draw = async () => {
    consumablesPanel.show();
    await settled();
    consumablesPanel._render();
};
const body = () => consumablesPanel.bodyEl;
const sectionOf = (name) => [...body().children].find((node) => node.textContent.startsWith(name));
const click = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const buyAllLink = (section) =>
    [...section.querySelectorAll('span')].find((node) => /^(Buy all|Craft )/.test(node.textContent));

beforeEach(() => {
    store.data = {};
    settings.values = {};
    keys.cost = null;
    game.statsByName = {};
    shopping.calls.length = 0;
    openBill.mockClear();
    dropKeyCostCache();
    consumablesPanel._readinessMemo = null;
    consumablesPanel._profiles = [];
    consumablesPanel._dungeonHistory = [];
    consumablesPanel._craftChestKeys = false;
    consumablesPanel.hide({ remember: false });
    _resetCaches();
});

afterEach(() => {
    vi.restoreAllMocks();
    delete window.Toolasha;
});

describe("a member's keys in their own section", () => {
    test('their stated count is a row, and it is what stops them when it runs out before their food', async () => {
        scene();
        await draw();

        const section = sectionOf('Kasvitatti');
        // 77 keys at 96 a day is 19h 15m; their cake lasts 22h 46m
        expect(section.textContent).toContain('stops in 19h 15m · Sinister Entry Key');
        expect(section.textContent).toContain('Sinister Entry Key');
        expect(section.textContent).toContain('96.0/day');
        const row = [...section.querySelectorAll('div[style*="grid-template-columns"]')].find((node) =>
            node.textContent.includes('Sinister Entry Key')
        );
        expect(row.textContent).toContain('77');
        expect([...row.querySelectorAll('span')].some((node) => node.title.includes('key-count message'))).toBe(true);
    });

    test('a member the key-count message did not name has no key row and no invented countdown', async () => {
        scene();
        await draw();

        const section = sectionOf('Zed');
        expect(section.textContent).not.toContain('Sinister Entry Key');
        expect(section.textContent).toContain('Spaceberry Cake');
    });

    test('a member stated at zero keys stops now', async () => {
        scene();
        window.Toolasha.Combat.dungeonTracker.getCurrentRun = () => ({
            dungeonHrid: DEN,
            keyCountsMap: { Me: 62, Zed: 0 },
        });
        await draw();

        expect(sectionOf('Zed').textContent).toContain('stops in 0s · Sinister Entry Key');
    });

    test('your own countdown includes your key too', async () => {
        scene();
        await draw();

        // 62 keys at 96 a day: 15h 30m, against a cake pile that lasts days
        expect(sectionOf('Me (you)').textContent).toContain('stops in 15h 30m · Sinister Entry Key');
    });

    test("a member's key count of another dungeon's run is not used", async () => {
        scene();
        window.Toolasha.Combat.dungeonTracker.getCurrentRun = () => ({
            dungeonHrid: '/actions/combat/other',
            keyCountsMap: { Kasvitatti: 77 },
        });
        await draw();

        expect(sectionOf('Kasvitatti').textContent).not.toContain('Sinister Entry Key');
    });
});

describe("other players' sections offer nothing to buy", () => {
    test('no clickable buy cell, no Buy all, but the shortfall and its cost stay as plain text', async () => {
        scene();
        await draw();

        const section = sectionOf('Kasvitatti');
        expect(section.textContent).not.toContain('⚡');
        expect(section.textContent).not.toContain('Buy all');
        expect(section.querySelector('[style*="underline"][style*="pointer"]')).toBeNull();
        // 19 keys at 1000 and 5 cakes at 100 for a day
        expect(section.textContent).toContain('Short 24 · 20K');

        // The shortfall is not in anything the Buy all walk reads
        expect(consumablesPanel._buyQueues.map((queue) => queue.label)).not.toContain('Kasvitatti');
    });

    test('your own section still has its buy controls', async () => {
        scene({ cakeMe: 10 });
        await draw();

        const mine = sectionOf('Me (you)');
        expect(buyAllLink(mine).textContent).toContain('Buy all');
        click(buyAllLink(mine));
        expect(shopping.calls).toHaveLength(1);
        expect(shopping.calls[0].map((item) => item.itemHrid)).toContain(KEY);
    });
});

describe('the chest key', () => {
    test('is drawn in your section, costed, and never what stops you', async () => {
        scene();
        await draw();

        const mine = sectionOf('Me (you)');
        const row = [...mine.querySelectorAll('div[style*="grid-template-columns"]')].find((node) =>
            node.textContent.includes('Sinister Chest Key')
        );
        expect(row).toBeDefined();
        expect(row.textContent).toContain('192.0/day');
        // 5 chest keys at 192 a day would be 40 minutes: it must not be the stop
        expect(mine.textContent).toContain('stops in 15h 30m · Sinister Entry Key');
        expect(mine.textContent).not.toContain('stops in 40m');
        // Costed: entry 96 x 1000 + chest 192 x 2000 + cake 86.4 x 100 (Ask), not just the entry key and cake
        expect(mine.textContent).toContain('Ask: 489K');
    });

    test('nobody else gets a chest key row', async () => {
        scene();
        await draw();

        expect(sectionOf('Kasvitatti').textContent).not.toContain('Chest Key');
    });

    test('the readiness card says what the plan earns, what is held and what is short', async () => {
        scene();
        await draw();

        // 100 runs at 2 chests a run (regular + refinement), 5 held
        expect(body().textContent).toContain('100 runs earn ~200 chests · you hold 5 chest keys · 195 short');
    });

    test('with no chest dropped yet the card assumes one chest per run and says so', async () => {
        scene({
            players: [{ name: 'Me', isCurrentPlayer: true, loot: {} }, { name: 'Kasvitatti' }],
        });
        await draw();

        expect(body().textContent).toContain('100 runs earn ~100 chests · you hold 5 chest keys · 95 short');
    });
});

describe('the craft route', () => {
    const craftCost = (overrides = {}) => ({
        unitCost: 40_000,
        buyPrice: 60_000,
        craftCost: 40_000,
        cheaper: 'craft',
        craftActionHrid: '/actions/crafting/sinister_key',
        ...overrides,
    });

    test('the key is priced at the craft cost and its buy cell opens the materials, not the key market', async () => {
        settings.values.profitCalc_keyPricingMode = 'craft';
        keys.cost = craftCost();
        scene();
        await draw();

        const row = [...sectionOf('Me (you)').querySelectorAll('div[style*="grid-template-columns"]')].find((node) =>
            node.textContent.includes('Sinister Entry Key')
        );
        // 96 a day at 40,000 each, both sides
        expect(row.textContent).toContain('Ask: 4M');
        expect(row.textContent).toContain('Bid: 4M');
        const craftCell = [...row.querySelectorAll('span')].find((node) => node.textContent.includes('⚒'));
        expect(craftCell.textContent).toBe('34 ⚒');

        click(craftCell);
        await settled();
        expect(openBill).toHaveBeenCalledWith([{ actionHrid: '/actions/crafting/sinister_key', numActions: 34 }], []);
        expect(shopping.calls).toHaveLength(0);
    });

    test('the chest keys join the list only when asked', async () => {
        settings.values.profitCalc_keyPricingMode = 'craft';
        keys.cost = craftCost();
        scene({ cakeMe: 10 });
        consumablesPanel._craftChestKeys = true;
        await draw();

        // Buy all is ONE trip: the cake rides in the same bill as the key materials (a second bill would
        // replace the first), as held + short so the bill nets the stock once - and neither key is bought
        click(buyAllLink(sectionOf('Me (you)')));
        await settled();
        expect(shopping.calls).toHaveLength(0);
        expect(openBill).toHaveBeenCalledTimes(1);
        expect(openBill).toHaveBeenCalledWith(
            [
                { actionHrid: '/actions/crafting/sinister_key', numActions: 34 },
                { actionHrid: '/actions/crafting/sinister_key', numActions: 187 },
            ],
            [{ itemHrid: CAKE, count: 10 + 77 }]
        );
    });

    test('without the chest option the chest key is not in the list and its cell is plain', async () => {
        settings.values.profitCalc_keyPricingMode = 'craft';
        keys.cost = craftCost();
        scene();
        await draw();

        const row = [...sectionOf('Me (you)').querySelectorAll('div[style*="grid-template-columns"]')].find((node) =>
            node.textContent.includes('Sinister Chest Key')
        );
        expect(row.textContent).not.toContain('⚒');
        click(buyAllLink(sectionOf('Me (you)')));
        await settled();
        expect(openBill.mock.calls[0][0]).toHaveLength(1);
    });

    test('an unpriceable recipe falls back to buying the keys and says why', async () => {
        settings.values.profitCalc_keyPricingMode = 'craft';
        keys.cost = craftCost({ unitCost: 60_000, craftCost: null, cheaper: 'buy' });
        scene();
        await draw();

        const row = [...sectionOf('Me (you)').querySelectorAll('div[style*="grid-template-columns"]')].find((node) =>
            node.textContent.includes('Sinister Entry Key')
        );
        expect(row.textContent).toMatch(/34 [⚡⏳]/);
        expect(row.textContent).not.toContain('⚒');
        expect(
            [...row.querySelectorAll('span')].some((node) => node.title.includes('priced and bought at the market'))
        ).toBe(true);
    });

    test('the buy setting keeps buying the keys at the market book', async () => {
        keys.cost = craftCost();
        scene();
        await draw();

        const row = [...sectionOf('Me (you)').querySelectorAll('div[style*="grid-template-columns"]')].find((node) =>
            node.textContent.includes('Sinister Entry Key')
        );
        expect(row.textContent).toContain('Ask: 96K');
        expect(row.textContent).toContain('Bid: 86K');
        expect(row.textContent).toMatch(/34 [⚡⏳]/);
    });

    test('a member on the craft route still has nothing clickable', async () => {
        settings.values.profitCalc_keyPricingMode = 'craft';
        keys.cost = craftCost();
        scene();
        await draw();

        const section = sectionOf('Kasvitatti');
        expect(section.textContent).not.toContain('⚒');
        // Their key is priced at the market (96 x 1000), not at your craft cost (96 x 40,000)
        expect(section.textContent).toContain('Ask: 96K');
        expect(section.textContent).not.toContain('Ask: 4M');
        expect(section.textContent).toContain('Short 24 · 20K');
    });
});
