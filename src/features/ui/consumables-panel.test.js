/** @vitest-environment happy-dom
 *
 * Whether the Consumables panel comes back.
 *
 * The target duration it measures against lives in `utils/consumable-target.js`
 * and is tested there, because the overlay tile reads the same setting.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const store = vi.hoisted(() => ({ data: {} }));

/**
 * The game the panel is looking at, swapped between tests.
 *
 * Hoisted because `vi.mock` factories run before the module body — a plain
 * `let` would still be in its temporal dead zone when the mock is built.
 */
const game = vi.hoisted(() => ({
    items: {},
    actionDetail: null,
    inventory: [],
    latest: null,
    statsByName: {},
}));

const settings = vi.hoisted(() => ({ values: {} }));

vi.mock('../../core/config.js', () => ({
    default: {
        Z_FLOATING_PANEL: 1100,
        getSetting: (key) => settings.values[key] ?? true,
        // Unknown keys keep answering 'compact' for the overlay's density
        getSettingValue: (key, fallback) =>
            settings.values[key] ?? (String(key).startsWith('market_') ? fallback : 'compact'),
        setSetting: (key, value) => {
            settings.values[key] = value;
        },
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
        // Per-character keys and the listeners that reload them: the panel's
        // open state is this character's, not the account's
        getCurrentCharacterId: () => 'char1',
        getCurrentCharacterGameMode: () => 'standard',
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../utils/market-data.js', () => ({ getItemPrices: () => ({}) }));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));
vi.mock('../../utils/marketplace-autofill.js', () => ({
    createAutofillManager: () => ({ initialize: () => {}, setQuantity: () => {} }),
}));
vi.mock('../../utils/order-book.js', () => ({ estimateFillSeconds: () => null }));
vi.mock('./consumables-shopping-list.js', () => ({ openShoppingList: () => {} }));
vi.mock('../combat-stats/combat-stats-data-collector.js', () => ({
    default: { getLatestData: () => game.latest },
}));
vi.mock('../combat-stats/combat-stats-calculator.js', () => ({
    calculatePlayerStats: (player) => game.statsByName[player.name] || {},
}));

const { consumablesPanel } = await import('./consumables-panel.js');
const { wasOpen } = await import('../../utils/panel-geometry.js');

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
    store.data = {};
    settings.values = {};
    game.items = {};
    game.actionDetail = null;
    game.inventory = [];
    game.latest = null;
    game.statsByName = {};
    consumablesPanel.hide({ remember: false });
});

describe('whether the panel was open', () => {
    test('opening it is remembered', async () => {
        consumablesPanel.show();
        await settled();

        await expect(wasOpen('consumablesPanel')).resolves.toBe(true);
    });

    test('and closing it is', async () => {
        consumablesPanel.show();
        await settled();
        consumablesPanel.hide();
        await settled();

        await expect(wasOpen('consumablesPanel')).resolves.toBe(false);
    });

    test('going to the marketplace is not closing it', async () => {
        // The panel gets out of the way so the marketplace is not underneath it.
        // You went shopping; you did not put the panel away.
        consumablesPanel.show();
        await settled();
        consumablesPanel._openShoppingList([]);
        await settled();

        await expect(wasOpen('consumablesPanel')).resolves.toBe(true);
    });
});

describe('the dungeon entry-key row', () => {
    const DEN = '/actions/combat/chimerical_den';
    const KEY = '/items/chimerical_entry_key';

    /** A session in the Den: plenty of coffee, four clears in the hour */
    const denSession = () => {
        game.actionDetail = { combatZoneInfo: { isDungeon: true, dungeonInfo: { keyItemHrid: KEY } } };
        game.items[KEY] = { name: 'Chimerical Entry Key' };
        game.inventory = [{ itemHrid: KEY, count: 4, itemLocationHrid: '/item_locations/inventory' }];
        game.latest = {
            durationSeconds: 3600,
            actionHrid: DEN,
            players: [{ name: 'Me', isCurrentPlayer: true }],
        };
        game.statsByName = {
            Me: {
                consumableBreakdown: [
                    // Lasts eleven and a half days, so the keys run out first
                    {
                        itemHrid: '/items/power_coffee',
                        itemName: 'Power Coffee',
                        inventoryAmount: 1000,
                        consumptionRate: 0.001,
                    },
                ],
                keyBreakdown: [{ itemHrid: KEY, itemName: 'Chimerical Entry Key', count: 4, pricePerItem: 90000 }],
            },
        };
    };

    const text = () => consumablesPanel.bodyEl.textContent;

    test('a dungeon run gets a key row at the measured clear rate', async () => {
        denSession();
        consumablesPanel.show();
        await settled();
        consumablesPanel._render();

        expect(text()).toContain('Chimerical Entry Key');
        // Four clears an hour is 96 keys a day
        expect(text()).toContain('96.0/day');
    });

    test('the key wins the limiting highlight when it runs out first', async () => {
        denSession();
        consumablesPanel.show();
        await settled();
        consumablesPanel._render();

        // Four keys at four an hour is one hour, against days of coffee
        expect(text()).toContain('stops in 1h · Chimerical Entry Key');
    });

    test('a zone renders exactly as before: no key row', async () => {
        denSession();
        game.actionDetail = { combatZoneInfo: { isDungeon: false } };
        consumablesPanel.show();
        await settled();
        consumablesPanel._render();

        expect(text()).toContain('Power Coffee');
        expect(text()).not.toContain('Entry Key');
    });

    test('no chests yet: the held count shows, the rates say so', async () => {
        denSession();
        game.statsByName.Me.keyBreakdown = [];
        consumablesPanel.show();
        await settled();
        consumablesPanel._render();

        expect(text()).toContain('Chimerical Entry Key');
        // No measured rate is not a zero rate — the row keeps the count and
        // declines to invent a countdown
        expect(text()).not.toContain('96.0/day');
        expect(text()).toContain('∞');
    });
});

describe('the Buy-all widget', () => {
    /** A shortfall the walk can be pointed at */
    const shortfall = [
        { itemHrid: '/items/peach_gummy', count: 5 },
        { itemHrid: '/items/star_fruit_gummy', count: 3 },
    ];

    const widget = () => document.getElementById('toolasha-lab-buy-next');
    const mainLabel = () => document.querySelector('.toolasha-lab-buy-next-main')?.textContent || '';

    beforeEach(() => {
        game.items = {
            '/items/peach_gummy': { name: 'Peach Gummy' },
            '/items/star_fruit_gummy': { name: 'Star Fruit Gummy' },
        };
        consumablesPanel._buyQueue = [];
        consumablesPanel._buyWidgetHidden = false;
    });

    test('a section short of two or more items offers the walk', async () => {
        consumablesPanel.show();
        await settled();
        consumablesPanel._registerBuyQueue('Combat', shortfall);
        consumablesPanel._syncBuyWidget();

        expect(widget()).not.toBe(null);
        expect(mainLabel()).toBe('▶ Buy all');
    });

    test('one row short is left to its own Buy link', async () => {
        consumablesPanel.show();
        await settled();
        consumablesPanel._registerBuyQueue('Combat', [shortfall[0]]);
        consumablesPanel._syncBuyWidget();

        expect(widget()).toBe(null);
    });

    test('the label becomes the next item once the walk is running', async () => {
        consumablesPanel.show();
        await settled();
        consumablesPanel._registerBuyQueue('Combat', shortfall);
        consumablesPanel._syncBuyWidget();

        document.querySelector('.toolasha-lab-buy-next-main').click();

        // The first item's form is already open, so the button offers the second
        expect(mainLabel()).toBe('▶ Next: Star Fruit Gummy (1 left)');
        // The panel got out of the way; the control did not
        expect(widget()).not.toBe(null);
    });

    test('the ✕ ends the walk and puts the widget away', async () => {
        consumablesPanel.show();
        await settled();
        consumablesPanel._registerBuyQueue('Combat', shortfall);
        consumablesPanel._syncBuyWidget();
        document.querySelector('.toolasha-lab-buy-next-main').click();

        document.querySelector('.toolasha-lab-buy-next-close').click();

        expect(widget()).toBe(null);
        expect(consumablesPanel._buyQueue).toEqual([]);
    });

    test('the gear edits the buy rules the walk decides by', async () => {
        consumablesPanel.show();
        await settled();
        consumablesPanel._registerBuyQueue('Combat', shortfall);
        consumablesPanel._syncBuyWidget();

        document.querySelector('.toolasha-lab-buy-next-gear').click();
        const drawer = document.querySelector('.toolasha-lab-buy-next-settings');

        const spread = drawer.querySelector('.mwi-widget-setting-market_consumableBuyMaxSpreadPct');
        spread.value = '7';
        spread.dispatchEvent(new Event('change'));
        expect(settings.values.market_consumableBuyMaxSpreadPct).toBe(7);

        const opens = drawer.querySelector('.mwi-widget-setting-market_consumableBuyOpenRecommended');
        opens.checked = false;
        opens.dispatchEvent(new Event('change'));
        expect(settings.values.market_consumableBuyOpenRecommended).toBe(false);
    });
});
