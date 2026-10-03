/** @vitest-environment happy-dom
 *
 * Whether the Consumables panel comes back.
 *
 * The target duration it measures against lives in `utils/consumable-target.js`
 * and is tested there, because the overlay tile reads the same setting.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

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
    characterData: null,
    currentActions: [],
    clientData: null,
    prices: {},
    equipment: new Map(),
    ownedEquipment: [],
}));

const settings = vi.hoisted(() => ({ values: {}, listeners: {} }));

/** Who is logged in, and the data manager's event bus */
const bus = vi.hoisted(() => ({ characterId: 'char1', handlers: {} }));

vi.mock('../../core/config.js', () => ({
    default: {
        Z_FLOATING_PANEL: 1100,
        getSetting: (key) => settings.values[key] ?? true,
        // Unknown keys keep answering 'compact' for the overlay's density
        getSettingValue: (key, fallback) =>
            settings.values[key] ?? (String(key).startsWith('market_') ? fallback : 'compact'),
        setSetting: (key, value) => {
            settings.values[key] = value;
            for (const callback of settings.listeners[key] || []) callback(value);
        },
        onSettingChange: (key, callback) => {
            (settings.listeners[key] ||= []).push(callback);
            return () => {
                settings.listeners[key] = (settings.listeners[key] || []).filter((cb) => cb !== callback);
            };
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
        getEquipment: () => game.equipment,
        getInitClientData: () => game.clientData,
        getCurrentActions: () => game.currentActions,
        get characterData() {
            return game.characterData;
        },
        getSkills: () => [],
        // Per-character keys and the listeners that reload them: the panel's
        // open state is this character's, not the account's
        getCurrentCharacterId: () => bus.characterId,
        getCurrentCharacterGameMode: () => 'standard',
        on: (event, handler) => {
            (bus.handlers[event] ||= []).push(handler);
        },
        off: (event, handler) => {
            bus.handlers[event] = (bus.handlers[event] || []).filter((h) => h !== handler);
        },
        emit: (event, payload) => {
            for (const handler of bus.handlers[event] || []) handler(payload);
        },
    },
}));
vi.mock('../../utils/market-data.js', () => ({ getItemPrices: (hrid) => game.prices[hrid] || {} }));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));
vi.mock('../../utils/marketplace-autofill.js', () => ({
    createAutofillManager: () => ({ initialize: () => {}, setQuantity: () => {} }),
}));
vi.mock('../../utils/order-book.js', () => ({ estimateFillSeconds: () => null }));
const shopping = vi.hoisted(() => ({ calls: [] }));
vi.mock('./consumables-shopping-list.js', () => ({
    openShoppingList: (items, options) => shopping.calls.push({ items, options }),
}));
vi.mock('../combat-stats/combat-stats-data-collector.js', () => ({
    default: { getLatestData: () => game.latest },
}));
vi.mock('../combat-stats/combat-stats-calculator.js', () => ({
    calculatePlayerStats: (player) => game.statsByName[player.name] || {},
}));

const { consumablesPanel } = await import('./consumables-panel.js');
const { wasOpen, _resetCaches } = await import('../../utils/panel-geometry.js');
const { default: dataManager } = await import('../../core/data-manager.js');
const { highestOwnedEnhancements, resolveEnhancementLevel } = await import('../../utils/loadout-equipment.js');

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
    store.data = {};
    settings.values = {};
    game.items = {};
    game.actionDetail = null;
    game.inventory = [];
    game.latest = null;
    game.statsByName = {};
    game.characterData = null;
    game.clientData = null;
    game.prices = {};
    game.equipment = new Map();
    game.ownedEquipment = [];
    shopping.calls.length = 0;
    game.currentActions = [];
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 768 });
    consumablesPanel._readinessMemo = null;
    consumablesPanel._profiles = [];
    consumablesPanel._dungeonHistory = [];
    consumablesPanel.hide({ remember: false });
    bus.characterId = 'char1';
    _resetCaches();
});

const resolvedSnapshotEquipment = (snapshot) => {
    const owned = highestOwnedEnhancements(game.ownedEquipment);
    return (snapshot.equipment || []).map((equip) => ({
        ...equip,
        enhancementLevel: resolveEnhancementLevel(snapshot, equip, owned),
    }));
};

// `vi.spyOn` on a method that is already spied hands back the *existing* spy
// rather than wrapping it again, so an unrestored spy is a call history that
// carries into the next test that asks for one — "not called at all" then reads
// the calls the previous test made. `document.hidden` is the other half: a
// getter left stubbed answers for every test after it.
afterEach(() => {
    vi.restoreAllMocks();
});

describe('whether the panel was open', () => {
    test('a fresh panel opens centered in the available viewport', async () => {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 600 });

        consumablesPanel.show({ remember: false });
        await settled();

        expect(consumablesPanel.panel.style.left).toBe('139px');
        expect(consumablesPanel.panel.style.top).toBe('89px');
    });

    test('a fresh panel stays centered and reachable on a narrow viewport', async () => {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 320 });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 240 });

        consumablesPanel.show({ remember: false });
        await settled();

        expect(parseFloat(consumablesPanel.panel.style.left)).toBeGreaterThanOrEqual(8);
        expect(parseFloat(consumablesPanel.panel.style.left)).toBeLessThan(20);
        expect(parseFloat(consumablesPanel.panel.style.top)).toBeGreaterThanOrEqual(8);
        expect(parseFloat(consumablesPanel.panel.style.top)).toBeLessThan(30);
    });

    test('saved geometry still determines where the panel opens', async () => {
        store.data.panelGeometry = {
            consumablesPanel: { left: 24, top: 36, width: 500, height: 400 },
        };

        consumablesPanel.show({ remember: false });
        await settled();

        expect(consumablesPanel.panel.style.left).toBe('24px');
        expect(consumablesPanel.panel.style.top).toBe('36px');
    });

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

    test('Escape closes it', async () => {
        consumablesPanel.show();
        await settled();
        expect(consumablesPanel.panel).not.toBeNull();

        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

        expect(consumablesPanel.panel).toBeNull();
    });

    test('Escape after it is already closed does nothing surprising', async () => {
        consumablesPanel.show();
        await settled();
        consumablesPanel.hide();

        // The listener is torn down with the panel; a stray Escape afterwards
        // must not throw for want of a panel to close
        expect(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))).not.toThrow();
    });

    test('going to the marketplace records the panel as closed', async () => {
        // It used to be filed as still open — "you went shopping, you did not
        // put the panel away" — but that memory never expired, so every later
        // page load reopened the panel, hours or days after the trip. Reported
        // from live use on 2026-09-18 as the panel opening itself at random.
        consumablesPanel.show();
        await settled();
        consumablesPanel._openShoppingList([]);
        await settled();

        await expect(wasOpen('consumablesPanel')).resolves.toBe(false);
    });

    test('buying a top-up records it as closed too', async () => {
        consumablesPanel.show();
        await settled();
        consumablesPanel._buy({ itemHrid: '/items/coffee' }, 10);
        await settled();

        await expect(wasOpen('consumablesPanel')).resolves.toBe(false);
    });
});

describe('the dungeon entry-key row', () => {
    const DEN = '/actions/combat/chimerical_den';
    const KEY = '/items/chimerical_entry_key';

    /** A session in the Den: plenty of coffee, four clears in the hour */
    const denSession = () => {
        game.actionDetail = { combatZoneInfo: { isDungeon: true, dungeonInfo: { keyItemHrid: KEY } } };
        game.items[KEY] = { name: 'Chimerical Entry Key' };
        game.inventory = [
            { itemHrid: KEY, count: 4, itemLocationHrid: '/item_locations/inventory' },
            // The live inventory is what the panel now reads the coffee from
            { itemHrid: '/items/power_coffee', count: 1000, itemLocationHrid: '/item_locations/inventory' },
        ];
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
        // labels the unknown rate instead of claiming it lasts forever.
        expect(text()).not.toContain('96.0/day');
        expect(text()).toContain('rate unknown');
        expect(text()).not.toContain('Stocked ✓');
        const keyRow = [...consumablesPanel.bodyEl.querySelectorAll('div[style*="grid-template-columns"]')].find(
            (row) => row.textContent.includes('Chimerical Entry Key')
        );
        expect(keyRow?.textContent).toContain('?');
    });

    test('unpriced key rows still use regular chests from the raw loot map', async () => {
        denSession();
        game.statsByName.Me.keyBreakdown = [];
        game.statsByName.Me.consumableBreakdown = [];
        game.inventory = game.inventory.filter((entry) => entry.itemHrid === KEY);
        game.latest.players[0].loot = {
            regular: { itemHrid: '/items/chimerical_chest', count: 4 },
            refinement: { itemHrid: '/items/chimerical_refinement_chest', count: 9 },
        };
        consumablesPanel.show();
        await settled();
        consumablesPanel._render();

        expect(text()).toContain('96.0/day');
        expect(text()).not.toContain('rate unknown');
        expect(text()).toContain('unpriced');
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
        consumablesPanel._buySettingsOpen = false;
    });

    test('an offered walk stays inline while the panel is expanded', async () => {
        consumablesPanel.show();
        await settled();
        consumablesPanel._registerBuyQueue('Combat', shortfall);
        consumablesPanel.bodyEl.appendChild(consumablesPanel._renderInlineBuyWalk());
        consumablesPanel._syncBuyWidget();

        expect(widget()).toBe(null);
        expect(document.querySelectorAll('#toolasha-lab-buy-next')).toHaveLength(0);
        expect(document.querySelector('.toolasha-consumables-inline-next').textContent).toBe('▶ Walk buys');
    });

    test('long player labels wrap within a narrow panel without widening its controls', async () => {
        consumablesPanel.show();
        await settled();
        consumablesPanel.panel.style.width = '294px';
        const longPlayerName = 'A very long current character name that should stay inside the picker';
        consumablesPanel._buyQueues = [
            { label: longPlayerName, queue: shortfall },
            { label: 'Labyrinth', queue: shortfall },
        ];
        consumablesPanel.bodyEl.appendChild(consumablesPanel._renderInlineBuyWalk());

        const row = document.querySelector('.toolasha-consumables-inline-walk');
        const picker = row.querySelector('select');

        expect(row.style.flexWrap).toBe('wrap');
        expect(row.style.maxWidth).toBe('100%');
        expect(row.querySelector('span').style.minWidth).toBe('0');
        expect(picker.style.minWidth).toBe('0');
        expect(picker.style.maxWidth).toBe('100%');
        expect(picker.options[0].textContent).toContain(longPlayerName);
        expect(row.querySelector('.toolasha-consumables-inline-next').style.whiteSpace).toBe('nowrap');
    });

    test('one row short is left to its own Buy link', async () => {
        consumablesPanel.show();
        await settled();
        consumablesPanel._registerBuyQueue('Combat', [shortfall[0]]);
        consumablesPanel._syncBuyWidget();

        expect(widget()).toBe(null);
    });

    test('offered controls stay with the panel when minimized and return on restore', async () => {
        consumablesPanel.show();
        await settled();
        consumablesPanel._registerBuyQueue('Combat', shortfall);
        consumablesPanel.minimizeCtl.button.click();
        consumablesPanel._syncBuyWidget();

        expect(widget()).toBe(null);
        expect(consumablesPanel.minimizeCtl.collapsed).toBe(true);

        document.querySelector('.toolasha-consumables-buy-settings').click();
        expect(consumablesPanel.minimizeCtl.collapsed).toBe(false);
        expect(document.querySelector('.toolasha-consumables-buy-settings-drawer')).not.toBe(null);
        consumablesPanel._registerBuyQueue('Combat', shortfall);
        consumablesPanel.bodyEl.appendChild(consumablesPanel._renderInlineBuyWalk());
        expect(document.querySelector('.toolasha-consumables-inline-next').textContent).toBe('▶ Walk buys');
        expect(widget()).toBe(null);
    });

    test('starting an inline walk opens one item and keeps the next step floating while shopping', async () => {
        consumablesPanel.show();
        await settled();
        consumablesPanel._registerBuyQueue('Combat', shortfall);
        consumablesPanel.bodyEl.appendChild(consumablesPanel._renderInlineBuyWalk());

        document.querySelector('.toolasha-consumables-inline-next').click();

        expect(consumablesPanel.panel).toBe(null);
        expect(widget()).not.toBe(null);
        expect(document.querySelectorAll('#toolasha-lab-buy-next')).toHaveLength(1);
        expect(mainLabel()).toBe('▶ Next: Star Fruit Gummy (1 left)');

        document.querySelector('.toolasha-lab-buy-next-close').click();
        expect(widget()).toBe(null);
        expect(consumablesPanel._buyQueue).toEqual([]);
    });

    test('a walking panel shows the next step inline and can cancel it', async () => {
        consumablesPanel._buyQueue = shortfall.slice();
        consumablesPanel.show();
        await settled();

        expect(widget()).toBe(null);
        expect(document.querySelector('.toolasha-consumables-inline-walk').textContent).toContain(
            'Next: Peach Gummy (2 left)'
        );
        document.querySelector('.toolasha-consumables-inline-cancel').click();
        expect(consumablesPanel._buyQueue).toEqual([]);
        expect(widget()).toBe(null);
    });

    test('a walk and its saved floating position survive minimizing and reopening the panel', async () => {
        consumablesPanel._buyWidgetPosition = { left: 120, top: 60 };
        consumablesPanel._buyQueue = shortfall.slice();
        consumablesPanel.show();
        await settled();

        consumablesPanel.minimizeCtl.button.click();
        await settled();
        expect(mainLabel()).toBe('▶ Next: Peach Gummy (2 left)');
        expect(widget().style.left).toBe('120px');
        expect(widget().style.top).toBe('60px');

        consumablesPanel.minimizeCtl.button.click();
        expect(widget()).toBe(null);
        expect(consumablesPanel._buyQueue).toEqual(shortfall);
        expect(document.querySelector('.toolasha-consumables-inline-next').textContent).toBe('▶ Next');

        document.querySelector('.toolasha-consumables-inline-next').click();
        await settled();
        expect(widget()).not.toBe(null);
        expect(widget().style.left).toBe('120px');
        expect(widget().style.top).toBe('60px');
        expect(mainLabel()).toBe('▶ Next: Star Fruit Gummy (1 left)');
    });

    test('the inline settings control keeps all buy rules editable', async () => {
        consumablesPanel.show();
        await settled();

        document.querySelector('.toolasha-consumables-buy-settings').click();
        const drawer = document.querySelector('.toolasha-consumables-buy-settings-drawer');

        const spread = drawer.querySelector('.mwi-widget-setting-market_consumableBuyMaxSpreadPct');
        const saving = drawer.querySelector('.mwi-widget-setting-market_consumableBuyMinSaving');
        const orderValue = drawer.querySelector('.mwi-widget-setting-market_consumableBuyMinOrderValue');
        spread.value = '7';
        spread.dispatchEvent(new Event('change'));
        saving.value = '25';
        saving.dispatchEvent(new Event('change'));
        orderValue.value = '1000';
        orderValue.dispatchEvent(new Event('change'));
        expect(settings.values.market_consumableBuyMaxSpreadPct).toBe(7);
        expect(settings.values.market_consumableBuyMinSaving).toBe(25);
        expect(settings.values.market_consumableBuyMinOrderValue).toBe(1000);

        const opens = drawer.querySelector('.mwi-widget-setting-market_consumableBuyOpenRecommended');
        opens.checked = false;
        opens.dispatchEvent(new Event('change'));
        expect(settings.values.market_consumableBuyOpenRecommended).toBe(false);
    });
});

describe('a restock shows at once', () => {
    test("the character's own held count reads the live inventory, party members keep the battle snapshot", () => {
        game.items['/items/coffee'] = { name: 'Coffee', consumableDetail: {} };
        game.inventory = [{ itemHrid: '/items/coffee', count: 25 }];
        game.latest = {
            durationSeconds: 600,
            players: [
                { name: 'Me', isCurrentPlayer: true },
                { name: 'Pal', isCurrentPlayer: false },
            ],
        };
        const entry = {
            itemHrid: '/items/coffee',
            itemName: 'Coffee',
            currentCount: 5,
            inventoryAmount: 5,
            consumptionRate: 0.001,
        };
        game.statsByName = {
            Me: { consumableBreakdown: [{ ...entry }] },
            Pal: { consumableBreakdown: [{ ...entry, currentCount: 7, inventoryAmount: 7 }] },
        };

        const players = consumablesPanel._players();
        const me = players.find((p) => p.isCurrent);
        const pal = players.find((p) => !p.isCurrent);

        // The battle snapshot said 5; the purchase already landed in the inventory
        expect(me.forecasts[0].held).toBe(25);
        // A party member's inventory is not visible, so the snapshot stands
        expect(pal.forecasts[0].held).toBe(7);
    });

    test('an empty inventory read leaves the snapshot counts alone', () => {
        game.inventory = [];
        game.latest = { durationSeconds: 600, players: [{ name: 'Me', isCurrentPlayer: true }] };
        game.statsByName = {
            Me: {
                consumableBreakdown: [
                    {
                        itemHrid: '/items/coffee',
                        itemName: 'Coffee',
                        currentCount: 5,
                        inventoryAmount: 5,
                        consumptionRate: 0.001,
                    },
                ],
            },
        };

        expect(consumablesPanel._players()[0].forecasts[0].held).toBe(5);
    });

    test('the daily total marks missing prices beside the known partial total', async () => {
        game.latest = { durationSeconds: 3600, players: [{ name: 'Me', isCurrentPlayer: true }] };
        game.prices['/items/spaceberry_cake'] = { ask: 100, bid: 90 };
        game.statsByName = {
            Me: {
                consumableBreakdown: [
                    {
                        itemHrid: '/items/spaceberry_cake',
                        itemName: 'Spaceberry Cake',
                        inventoryAmount: 100,
                        consumptionRate: 24 / 86400,
                        pricePerItem: 100,
                    },
                    {
                        itemHrid: '/items/blackberry_cake',
                        itemName: 'Blackberry Cake',
                        inventoryAmount: 100,
                        consumptionRate: 240 / 86400,
                        pricePerItem: null,
                    },
                ],
            },
        };
        consumablesPanel.show();
        await settled();
        consumablesPanel._render();

        expect(consumablesPanel.bodyEl.textContent).toContain('Ask: 2K (1 unpriced) / Bid: 2K (1 unpriced)');

        delete game.prices['/items/spaceberry_cake'];
        game.statsByName.Me.consumableBreakdown = [game.statsByName.Me.consumableBreakdown[1]];
        consumablesPanel._render();

        expect(consumablesPanel.bodyEl.textContent).toContain('Ask: — (1 unpriced) / Bid: — (1 unpriced)');
    });

    test('known purchase totals identify slots whose consumption rates are unknown', async () => {
        game.items['/items/spaceberry_cake'] = { name: 'Spaceberry Cake', consumableDetail: {} };
        game.items['/items/blackberry_cake'] = { name: 'Blackberry Cake', consumableDetail: {} };
        game.prices['/items/spaceberry_cake'] = { ask: 100, bid: 90 };
        game.latest = { durationSeconds: 3600, players: [{ name: 'Me', isCurrentPlayer: true }] };
        game.statsByName = {
            Me: {
                consumableBreakdown: [
                    {
                        itemHrid: '/items/spaceberry_cake',
                        itemName: 'Spaceberry Cake',
                        inventoryAmount: 0,
                        consumptionRate: 24 / 86400,
                        pricePerItem: 100,
                    },
                    {
                        itemHrid: '/items/blackberry_cake',
                        itemName: 'Blackberry Cake',
                        inventoryAmount: 14,
                        consumptionRate: null,
                    },
                ],
            },
        };
        consumablesPanel.show();
        await settled();
        consumablesPanel._render();

        expect(consumablesPanel.bodyEl.textContent).toContain('Buy all 24 known · 1 rate unknown');
        expect(consumablesPanel.bodyEl.textContent).toContain('Ask: 2K (1 rate unknown)');
    });

    const POUCH = '/items/guzzling_pouch';
    const TEA = '/items/wisdom_coffee';

    const setConcentrationFixture = () => {
        game.clientData = {
            itemDetailMap: {
                [POUCH]: {
                    equipmentDetail: {
                        type: '/equipment_types/pouch',
                        noncombatStats: { drinkConcentration: 0.1 },
                        noncombatEnhancementBonuses: { drinkConcentration: 0.002 },
                    },
                },
                [TEA]: {
                    consumableDetail: {
                        usableInActionTypeMap: { '/action_types/combat': true },
                        buffs: [
                            {
                                uniqueHrid: '/buff_uniques/wisdom_coffee',
                                typeHrid: '/buff_types/wisdom',
                                ratioBoost: 0,
                                ratioBoostLevelBonus: 0,
                                flatBoost: 0.12,
                                flatBoostLevelBonus: 0,
                                duration: 300000000000,
                            },
                        ],
                    },
                },
            },
        };
        game.items[TEA] = { name: 'Wisdom Coffee', consumableDetail: { buffs: [{ duration: 300000000000 }] } };
    };

    const idleCombatSnapshot = (overrides = {}) => ({
        name: 'Combat ★',
        isDefault: true,
        actionTypeHrid: '/action_types/combat',
        equipment: [{ itemLocationHrid: '/item_locations/pouch', itemHrid: POUCH, enhancementLevel: 0 }],
        food: [],
        drinks: [{ itemHrid: TEA }],
        ...overrides,
    });

    const useIdleSnapshotBridge = (snapshot) => {
        const previous = globalThis.window.Toolasha;
        globalThis.window.Toolasha = {
            Combat: {
                loadoutSnapshot: {
                    getAllSnapshots: () => [snapshot],
                    resolveEquipment: resolvedSnapshotEquipment,
                },
            },
        };
        return () => {
            if (previous === undefined) delete globalThis.window.Toolasha;
            else globalThis.window.Toolasha = previous;
        };
    };

    test('idle drink rate uses the selected snapshot and its resolved owned enhancement', () => {
        setConcentrationFixture();
        game.equipment = new Map([['/item_locations/pouch', { itemHrid: POUCH, enhancementLevel: 0 }]]);
        game.ownedEquipment = [{ itemHrid: POUCH, enhancementLevel: 10 }];
        const restoreBridge = useIdleSnapshotBridge(idleCombatSnapshot());

        try {
            const section = consumablesPanel._idleSection();

            // Guzzling Pouch's captured 10% concentration at the owned +10 level is
            // 12.9% for its 1x pouch slot: 86,400 / (300 / 1.129).
            expect(section.textContent).toContain('325.2/day');
        } finally {
            restoreBridge();
        }
    });

    test('an exact snapshot enhancement level overrides the higher owned copy', () => {
        setConcentrationFixture();
        game.equipment = new Map([['/item_locations/pouch', { itemHrid: POUCH, enhancementLevel: 10 }]]);
        game.ownedEquipment = [{ itemHrid: POUCH, enhancementLevel: 10 }];
        const restoreBridge = useIdleSnapshotBridge(idleCombatSnapshot({ useExactEnhancement: true }));

        try {
            const section = consumablesPanel._idleSection();

            // Exact +0 remains 10% concentration even though a +10 is owned/worn.
            expect(section.textContent).toContain('316.8/day');
        } finally {
            restoreBridge();
        }
    });

    test('an explicitly empty snapshot equipment set does not borrow live gear', () => {
        setConcentrationFixture();
        game.equipment = new Map([['/item_locations/pouch', { itemHrid: POUCH, enhancementLevel: 10 }]]);
        game.ownedEquipment = [{ itemHrid: POUCH, enhancementLevel: 10 }];
        const restoreBridge = useIdleSnapshotBridge(idleCombatSnapshot({ equipment: [] }));

        try {
            const section = consumablesPanel._idleSection();

            expect(section.textContent).toContain('288.0/day');
            expect(section.textContent).not.toContain('325.2/day');
        } finally {
            restoreBridge();
        }
    });

    test('an empty All Skills loadout keeps its selector and can switch back to food', async () => {
        const previousBridge = globalThis.window.Toolasha;
        const previousLoadoutPin = consumablesPanel._idleLoadoutName;
        const previousZonePin = consumablesPanel._idleZoneKey;
        const combatLoadout = {
            name: 'Combat Donut',
            isDefault: false,
            actionTypeHrid: '/action_types/combat',
            equipment: [],
            food: [{ itemHrid: '/items/blueberry_donut' }],
            drinks: [],
        };
        const allSkillsLoadout = {
            name: 'All Skills',
            isDefault: true,
            actionTypeHrid: '',
            equipment: [],
            food: [],
            drinks: [],
        };
        globalThis.window.Toolasha = {
            Combat: {
                loadoutSnapshot: {
                    getAllSnapshots: () => [combatLoadout, allSkillsLoadout],
                    resolveEquipment: (snapshot) => snapshot.equipment || [],
                },
            },
        };
        game.clientData = {
            itemDetailMap: {
                '/items/blueberry_donut': {
                    categoryHrid: '/item_categories/food',
                    consumableDetail: {
                        cooldownDuration: 60000000000,
                        usableInActionTypeMap: { '/action_types/combat': true },
                        hitpointRestore: 80,
                        manapointRestore: 0,
                        recoveryDuration: 0,
                        buffs: null,
                    },
                },
            },
        };
        game.items['/items/blueberry_donut'] = {
            name: 'Blueberry Donut',
            consumableDetail: {
                cooldownDuration: 60000000000,
                usableInActionTypeMap: { '/action_types/combat': true },
                hitpointRestore: 80,
                manapointRestore: 0,
                recoveryDuration: 0,
                buffs: null,
            },
        };
        consumablesPanel._idleLoadoutName = null;
        consumablesPanel._idleZoneKey = 'last';

        try {
            consumablesPanel.show();
            await settled();

            expect(consumablesPanel.bodyEl.textContent).toContain('Blueberry Donut');
            expect(consumablesPanel.bodyEl.querySelector('select').value).toBe('Combat Donut');

            let loadoutSelect = consumablesPanel.bodyEl.querySelector('select');
            loadoutSelect.value = 'All Skills';
            loadoutSelect.dispatchEvent(new Event('change'));

            expect(consumablesPanel.bodyEl.textContent).toContain('No food or drinks in this loadout.');
            expect(consumablesPanel.bodyEl.textContent).not.toContain('Blueberry Donut');
            expect(consumablesPanel.bodyEl.textContent).not.toContain('HeldItemPer day');
            expect(consumablesPanel.bodyEl.querySelector('select')?.value).toBe('All Skills');
            expect(consumablesPanel._buyQueues.find((queue) => queue.label === 'Idle plan')).toBeUndefined();

            loadoutSelect = consumablesPanel.bodyEl.querySelector('select');
            loadoutSelect.value = 'Combat Donut';
            loadoutSelect.dispatchEvent(new Event('change'));

            expect(consumablesPanel.bodyEl.textContent).toContain('Blueberry Donut');
            expect(consumablesPanel.bodyEl.querySelector('select')?.value).toBe('Combat Donut');
        } finally {
            consumablesPanel.hide({ remember: false });
            consumablesPanel._idleLoadoutName = previousLoadoutPin;
            consumablesPanel._idleZoneKey = previousZonePin;
            if (previousBridge === undefined) delete globalThis.window.Toolasha;
            else globalThis.window.Toolasha = previousBridge;
        }
    });

    test('the idle plan stays absent when no eligible loadout exists', () => {
        const previousBridge = globalThis.window.Toolasha;
        globalThis.window.Toolasha = { Combat: { loadoutSnapshot: { getAllSnapshots: () => [] } } };
        try {
            expect(consumablesPanel._idleSection()).toBeNull();
        } finally {
            if (previousBridge === undefined) delete globalThis.window.Toolasha;
            else globalThis.window.Toolasha = previousBridge;
        }
    });

    test('the selected idle food absent from the sim is unknown, not unused', () => {
        const previous = globalThis.window.Toolasha;
        try {
            globalThis.window.Toolasha = {
                Combat: {
                    loadoutSnapshot: {
                        getAllSnapshots: () => [
                            {
                                name: 'Combat ★',
                                isDefault: true,
                                actionTypeHrid: '/action_types/combat',
                                food: [{ itemHrid: '/items/blackberry_cake' }],
                                drinks: [],
                            },
                        ],
                    },
                },
            };
            game.items['/items/blackberry_cake'] = { name: 'Blackberry Cake', consumableDetail: {} };
            game.inventory = [
                {
                    itemHrid: '/items/blackberry_cake',
                    count: 14,
                    itemLocationHrid: '/item_locations/inventory',
                },
            ];
            consumablesPanel._simRates = { perHour: { '/items/other_food': 5 } };
            consumablesPanel._simRatesByZone = {};

            const section = consumablesPanel._idleSection();
            expect(section.textContent).toContain('food rate unavailable for 1 item');
            expect(section.textContent).toContain('14');
            expect(section.textContent).toContain('?—??');
            expect(section.textContent).not.toContain('Stocked ✓');
        } finally {
            if (previous === undefined) delete globalThis.window.Toolasha;
            else globalThis.window.Toolasha = previous;
        }
    });

    test('idle food with no sim is not marked stocked', () => {
        const previous = globalThis.window.Toolasha;
        try {
            globalThis.window.Toolasha = {
                Combat: {
                    loadoutSnapshot: {
                        getAllSnapshots: () => [
                            {
                                name: 'Combat ★',
                                isDefault: true,
                                actionTypeHrid: '/action_types/combat',
                                food: [{ itemHrid: '/items/blackberry_cake' }],
                                drinks: [],
                            },
                        ],
                    },
                },
            };
            game.items['/items/blackberry_cake'] = { name: 'Blackberry Cake', consumableDetail: {} };
            game.inventory = [
                {
                    itemHrid: '/items/blackberry_cake',
                    count: 14,
                    itemLocationHrid: '/item_locations/inventory',
                },
            ];
            consumablesPanel._simRates = null;
            consumablesPanel._simRatesByZone = {};

            const section = consumablesPanel._idleSection();
            expect(section.textContent).toContain('food unrated — run a sim to rate it');
            expect(section.textContent).toContain('?');
            expect(section.textContent).not.toContain('Stocked ✓');
        } finally {
            if (previous === undefined) delete globalThis.window.Toolasha;
            else globalThis.window.Toolasha = previous;
        }
    });
});

describe('the readiness card is not stale', () => {
    const DEN = '/actions/combat/chimerical_den';
    const KEY = '/items/chimerical_entry_key';

    /** A party standing outside the Den, with keys in the bag */
    const partyAtTheDoor = (held = 4) => {
        game.actionDetail = {
            name: 'Chimerical Den',
            combatZoneInfo: { isDungeon: true, dungeonInfo: { keyItemHrid: KEY } },
        };
        game.items[KEY] = { name: 'Chimerical Entry Key' };
        game.inventory = [{ itemHrid: KEY, count: held, itemLocationHrid: '/item_locations/inventory' }];
        game.currentActions = [{ actionHrid: DEN, isDone: false, difficultyTier: 0 }];
        game.characterData = {
            character: { id: 'char1', name: 'Me' },
            partyInfo: {
                partySlotMap: {
                    1: { characterID: 'char1', characterName: 'Me' },
                    2: { characterID: 'ally-a', characterName: 'Ally A' },
                },
            },
        };
    };

    const players = (secondsLeft, includeUnknownRate = false) => [
        {
            name: 'Me',
            isCurrent: true,
            forecasts: [
                { itemHrid: '/items/power_coffee', name: 'Power Coffee', rateKnown: true, secondsLeft },
                ...(includeUnknownRate
                    ? [
                          {
                              itemHrid: '/items/blackberry_cake',
                              name: 'Blackberry Cake',
                              rateKnown: false,
                              secondsLeft: null,
                          },
                      ]
                    : []),
            ],
        },
    ];

    test('buying keys invalidates the memo', () => {
        partyAtTheDoor(2);
        const before = consumablesPanel._readinessModel(players(9000));
        expect(before.keys.held).toBe(2);

        // Same party, same dungeon, same run target — only the bag changed
        game.inventory = [{ itemHrid: KEY, count: 20, itemLocationHrid: '/item_locations/inventory' }];
        const after = consumablesPanel._readinessModel(players(9000));

        expect(after).not.toBe(before);
        expect(after.keys.held).toBe(20);
    });

    test('a same-size member swap invalidates the memo', () => {
        partyAtTheDoor();
        const before = consumablesPanel._readinessModel(players(9000));
        expect(before.members.map((row) => row.name)).toContain('Ally A');

        game.characterData.partyInfo.partySlotMap[2] = { characterID: 'ally-b', characterName: 'Ally B' };
        const after = consumablesPanel._readinessModel(players(9000));

        expect(after.members.map((row) => row.name)).toContain('Ally B');
        expect(after.members.map((row) => row.name)).not.toContain('Ally A');
    });

    test('a fresh burn forecast invalidates the memo', () => {
        partyAtTheDoor();
        const before = consumablesPanel._readinessModel(players(9000));
        expect(before.members.find((row) => row.isSelf).secondsLeft).toBe(9000);

        // The collector rebuilds forecasts every refresh; drinking coffee moves
        // this one without changing any count in the old signature
        const after = consumablesPanel._readinessModel(players(600));

        expect(after.members.find((row) => row.isSelf).secondsLeft).toBe(600);
    });

    test('an unknown slot invalidates the memo and removes a complete-readiness claim', () => {
        partyAtTheDoor();
        const before = consumablesPanel._readinessModel(players(9000));
        expect(before.members.find((row) => row.isSelf).unknown).toBeNull();

        const after = consumablesPanel._readinessModel(players(9000, true));
        const me = after.members.find((row) => row.isSelf);
        expect(after).not.toBe(before);
        expect(me.unknown).toContain('rates are unknown');
        expect(after.stopsFirst).toMatchObject({ source: 'keys', known: 0, partial: 1 });
    });

    test('nothing moving still reuses the model', () => {
        partyAtTheDoor();
        const first = consumablesPanel._readinessModel(players(9000));
        const second = consumablesPanel._readinessModel(players(9000));

        expect(second).toBe(first);
    });
});

describe('the five-second redraw', () => {
    const REFRESH_MS = 5000;

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        consumablesPanel.hide({ remember: false });
        vi.useRealTimers();
    });

    test('a folded panel is not rebuilt', () => {
        consumablesPanel.show({ remember: false });
        const render = vi.spyOn(consumablesPanel, '_render');

        consumablesPanel.minimizeCtl = { collapsed: true, destroy: () => {} };
        vi.advanceTimersByTime(REFRESH_MS * 3);

        expect(render).not.toHaveBeenCalled();
    });

    test('an open dropdown is not pulled out from under the pointer', async () => {
        consumablesPanel.show({ remember: false });
        const render = vi.spyOn(consumablesPanel, '_render');
        // The stored-readings re-read draws once on its own; let it
        await vi.advanceTimersByTimeAsync(0);
        render.mockClear();

        // A `<select>` inside the panel with the keyboard in it: the section
        // source pickers are exactly this, and rebuilding one shuts its list
        const picker = document.createElement('select');
        consumablesPanel.bodyEl.appendChild(picker);
        picker.focus();

        vi.advanceTimersByTime(REFRESH_MS * 2);
        expect(render).not.toHaveBeenCalled();

        picker.blur();
        vi.advanceTimersByTime(REFRESH_MS);
        expect(render).toHaveBeenCalled();
    });

    test('a hidden tab is not rebuilt', async () => {
        consumablesPanel.show({ remember: false });
        const render = vi.spyOn(consumablesPanel, '_render');
        await vi.advanceTimersByTimeAsync(0);
        render.mockClear();

        const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
        vi.advanceTimersByTime(REFRESH_MS * 3);
        expect(render).not.toHaveBeenCalled();

        hidden.mockReturnValue(false);
        vi.advanceTimersByTime(REFRESH_MS);
        expect(render).toHaveBeenCalled();
    });

    test('a setting flipped elsewhere repaints the panel now, not at the next tick', async () => {
        const { default: mockedConfig } = await import('../../core/config.js');
        consumablesPanel.show({ remember: false });
        const render = vi.spyOn(consumablesPanel, '_render');
        await vi.advanceTimersByTimeAsync(0);
        render.mockClear();

        // The body reads this while it draws, and the redraw used to be the
        // five-second tick and nothing else — so the settings page and the open
        // panel disagreed until it came round
        mockedConfig.setSetting('consumables_idleLoadoutPlan', false);

        expect(render).toHaveBeenCalled();
    });

    test('unchanged inputs leave the DOM nodes alone', async () => {
        consumablesPanel.show({ remember: false });
        await vi.advanceTimersByTimeAsync(0);

        consumablesPanel._render();
        const before = consumablesPanel.bodyEl.firstElementChild;
        expect(before).not.toBeNull();

        // Same game state, so the scratch build serialises identically and the
        // live body is kept rather than swapped — node identity is the proof
        consumablesPanel._render();
        expect(consumablesPanel.bodyEl.firstElementChild).toBe(before);
    });
});

describe('switching character', () => {
    test('the departing character’s panel is torn down without recording a close', async () => {
        consumablesPanel.show();
        await settled();
        const departing = consumablesPanel.panel;
        expect(departing).not.toBe(null);

        // char2 has nothing flagged open, so the pass finds nothing to reopen
        bus.characterId = 'char2';
        _resetCaches();
        dataManager.emit('character_switched', {});
        await settled();

        expect(consumablesPanel.panel).toBe(null);
        expect(departing.isConnected).toBe(false);

        // char1's flag is untouched: a switch is not the user putting the panel
        // away, and recording it as one would write into char2's flags instead
        bus.characterId = 'char1';
        _resetCaches();
        await expect(wasOpen('consumablesPanel')).resolves.toBe(true);
    });

    test('the arriving character’s panel reopens', async () => {
        // char2 left it open last time
        bus.characterId = 'char2';
        consumablesPanel.show();
        await settled();
        consumablesPanel.hide({ remember: false });

        // char1 is the one logged in, and did not leave it open
        bus.characterId = 'char1';
        _resetCaches();
        dataManager.emit('character_switched', {});
        await settled();
        expect(consumablesPanel.panel).toBe(null);

        // now back to char2
        bus.characterId = 'char2';
        _resetCaches();
        dataManager.emit('character_switched', {});
        await settled();

        expect(consumablesPanel.panel).not.toBe(null);
    });
});

describe('the labyrinth buy all', () => {
    const SUPPLIES = ['/items/basic_torch', '/items/basic_shroud', '/items/basic_beacon'];

    beforeEach(() => {
        game.clientData = { itemDetailMap: Object.fromEntries(SUPPLIES.map((h) => [h, {}])) };
        for (const hrid of SUPPLIES) game.items[hrid] = { name: hrid.split('/').pop() };
        game.characterData = {
            characterInfo: { labyrinthTorchCap: 100, labyrinthShroudCap: 4, labyrinthBeaconCap: 5 },
        };
        game.inventory = [];
    });

    test('the whole lab shortfall goes to the marketplace in one gesture', async () => {
        consumablesPanel.show();
        await settled();
        consumablesPanel._render();

        // Five runs is the default target: 5x(100 torches + 4 shrouds + 5 beacons)
        const buyAll = [...consumablesPanel.bodyEl.querySelectorAll('span')].find((el) =>
            el.textContent.startsWith('Buy all 545')
        );
        expect(buyAll).toBeTruthy();

        buyAll.click();
        expect(shopping.calls).toHaveLength(1);
        expect(shopping.calls[0].items.map((i) => [i.itemHrid, i.count])).toEqual([
            ['/items/basic_torch', 500],
            ['/items/basic_shroud', 20],
            ['/items/basic_beacon', 25],
        ]);
        // Names ride along so the marketplace tabs can label themselves
        expect(shopping.calls[0].items.every((i) => typeof i.name === 'string' && i.name)).toBe(true);
    });

    test('a fully stocked lab shows no buy-all line', async () => {
        game.inventory = [
            { itemHrid: '/items/basic_torch', count: 500, itemLocationHrid: '/item_locations/inventory' },
            { itemHrid: '/items/basic_shroud', count: 50, itemLocationHrid: '/item_locations/inventory' },
            { itemHrid: '/items/basic_beacon', count: 50, itemLocationHrid: '/item_locations/inventory' },
        ];
        consumablesPanel.show();
        await settled();
        consumablesPanel._render();

        const buyAll = [...consumablesPanel.bodyEl.querySelectorAll('span')].find((el) =>
            el.textContent.startsWith('Buy all')
        );
        expect(buyAll).toBeUndefined();
    });
});

describe('the idle plan pins across a character switch', () => {
    test('each character keeps its own loadout and zone pin', async () => {
        // char1 pins a loadout it has and a zone it simmed
        bus.characterId = 'char1';
        await consumablesPanel.reloadIdlePins();
        consumablesPanel.pinIdleLoadout('Bruiser');
        consumablesPanel.pinIdleZone('/actions/combat/jungle|3');
        await settled();
        expect(consumablesPanel._idleLoadoutName).toBe('Bruiser');
        expect(consumablesPanel._idleZoneKey).toBe('/actions/combat/jungle|3');

        // The alt arrives: it must start clean rather than plan against a
        // loadout it does not own and a zone it has never simmed
        bus.characterId = 'char2';
        dataManager.emit('character_switched', {});
        await settled();
        expect(consumablesPanel._idleLoadoutName).toBeNull();
        expect(consumablesPanel._idleZoneKey).toBe('last');

        // and its own choice does not reach back to char1
        consumablesPanel.pinIdleLoadout('Tank');
        consumablesPanel.pinIdleZone('/actions/combat/swamp|0');
        await settled();
        bus.characterId = 'char1';
        dataManager.emit('character_switched', {});
        await settled();
        expect(consumablesPanel._idleLoadoutName).toBe('Bruiser');
        expect(consumablesPanel._idleZoneKey).toBe('/actions/combat/jungle|3');
    });

    test('a legacy bare pin is discarded rather than inherited', async () => {
        store.data.consumablesIdleLoadout = 'MainsLoadout';
        store.data.consumablesIdleZone = '/actions/combat/jungle|5';

        bus.characterId = 'char2';
        dataManager.emit('character_initialized', {});
        await settled();

        expect(consumablesPanel._idleLoadoutName).toBeNull();
        expect(consumablesPanel._idleZoneKey).toBe('last');
        // and the bare key is gone, so it cannot leak onto the next character either
        expect(store.data.consumablesIdleLoadout).toBeUndefined();
        expect(store.data.consumablesIdleZone).toBeUndefined();
    });

    test('a departing character’s slow read does not land on top of a fast switch', async () => {
        // Mirrors consumable-target.test.js's "a read started before a switch
        // does not land on top of the switch": reloadIdlePins() has the same
        // character-scoped-read-across-a-switch shape as loadTarget(), but no
        // generation guard. Two switches close enough together let the older
        // read's storage.get resolve after the newer character's own read has
        // already landed, and — without the guard — silently overwrite the
        // pins with the departed character's values.
        store.data.consumablesIdleLoadout_char1 = 'Bruiser';
        store.data.consumablesIdleLoadout_char2 = 'Tank';

        const { default: mockedStorage } = await import('../../core/storage.js');
        const realGet = mockedStorage.get;
        let releaseDeparting;
        const gate = new Promise((resolve) => {
            releaseDeparting = resolve;
        });
        mockedStorage.get = async (key, name, fallback) => {
            if (key === 'consumablesIdleLoadout_char1') await gate;
            return realGet(key, name, fallback);
        };

        bus.characterId = 'char1';
        const departingLoad = consumablesPanel.reloadIdlePins();

        // Let char1's read reach (and block on) its own storage.get before
        // switching characters out from under it — same technique as the
        // consumable-target.js race test.
        await settled();

        bus.characterId = 'char2';
        await consumablesPanel.reloadIdlePins();
        expect(consumablesPanel._idleLoadoutName).toBe('Tank');

        // Now let char1's stale read land. It must not stomp char2's pin.
        releaseDeparting();
        await departingLoad;
        mockedStorage.get = realGet;

        expect(consumablesPanel._idleLoadoutName).toBe('Tank');
    });

    test('a departing character’s slow sim-rate read does not land on top of a fast switch', async () => {
        // _refreshStoredReadings has the identical shape and hazard as
        // reloadIdlePins above: it re-reads character-scoped state (this time
        // via a single Promise.all) every time the panel is shown, and
        // character_switched's hide()+restore() calls show() again on every
        // switch with no way to cancel a read already in flight.
        store.data.simConsumableRates_char1 = { rate: 'char1-rate' };
        store.data.simConsumableRates_char2 = { rate: 'char2-rate' };

        const { default: mockedStorage } = await import('../../core/storage.js');
        const realGet = mockedStorage.get;
        let releaseDeparting;
        const gate = new Promise((resolve) => {
            releaseDeparting = resolve;
        });
        mockedStorage.get = async (key, name, fallback) => {
            if (key === 'simConsumableRates_char1') await gate;
            return realGet(key, name, fallback);
        };

        bus.characterId = 'char1';
        const departingLoad = consumablesPanel._refreshStoredReadings();
        await settled();

        bus.characterId = 'char2';
        await consumablesPanel._refreshStoredReadings();
        expect(consumablesPanel._simRates).toEqual({ rate: 'char2-rate' });

        releaseDeparting();
        await departingLoad;
        mockedStorage.get = realGet;

        expect(consumablesPanel._simRates).toEqual({ rate: 'char2-rate' });
    });

    test('a rate simulated by an older build is dropped rather than rated against today’s plan', async () => {
        // The engine that produced a rate decides how fast the fight ends, and
        // therefore how fast it eats food. A build that changes the engine must
        // not keep serving its predecessor's appetite as its own
        globalThis.GM_info = { script: { version: '9.9.9' } };
        try {
            store.data.simConsumableRates_char1 = { scriptVersion: '9.9.8', perHour: { '/items/cheese': 5 } };
            store.data.simConsumableRatesByZone_char1 = {
                'old|0': { scriptVersion: '9.9.8', perHour: { '/items/cheese': 5 } },
                'now|0': { scriptVersion: '9.9.9', perHour: { '/items/cheese': 7 } },
            };

            bus.characterId = 'char1';
            await consumablesPanel._refreshStoredReadings();

            expect(consumablesPanel._simRates).toBe(null);
            expect(Object.keys(consumablesPanel._simRatesByZone)).toEqual(['now|0']);
        } finally {
            delete globalThis.GM_info;
        }
    });
});

describe('the labyrinth burn trend', () => {
    const SUPPLIES = ['/items/basic_torch', '/items/basic_shroud', '/items/basic_beacon'];

    /**
     * @param {Object} fields - Overrides
     * @returns {Object} A ledger record shaped as the run ledger stores them
     */
    const ledgerRun = ({ key, floor = 5, torch = 100, shroud = 2, beacon = 3, trusted = true }) => ({
        key,
        startTrusted: trusted,
        floor,
        left: { torch: 0, shroud: 0, beacon: 0 },
        start: { torch, shroud, beacon },
        spent: { torch, shroud, beacon },
        itemHrids: { torch: '/items/basic_torch', shroud: '/items/basic_shroud', beacon: '/items/basic_beacon' },
        endedAt: 1000,
    });

    /**
     * The lab section's text, with the panel drawn over the given ledger.
     *
     * The runs go in *after* the panel has settled: `restore()` reads the
     * ledger from storage as part of coming up, so anything set before that
     * would be replaced by the empty stored one.
     * @param {Array<Object>} runs - Ledger records, newest first
     * @returns {Promise<string>}
     */
    const draw = async (runs) => {
        consumablesPanel.show();
        await settled();
        consumablesPanel._ledgerRuns = runs;
        consumablesPanel._render();
        return consumablesPanel.bodyEl.textContent;
    };

    /** Every tooltip in the drawn panel, joined — the per-run detail lives there */
    const titles = () =>
        [...consumablesPanel.bodyEl.querySelectorAll('[title]')].map((el) => el.getAttribute('title')).join(' | ');

    beforeEach(() => {
        game.clientData = { itemDetailMap: Object.fromEntries(SUPPLIES.map((h) => [h, {}])) };
        for (const hrid of SUPPLIES) game.items[hrid] = { name: hrid.split('/').pop() };
        game.characterData = {
            characterInfo: { labyrinthTorchCap: 100, labyrinthShroudCap: 4, labyrinthBeaconCap: 5 },
        };
        game.inventory = [];
        consumablesPanel._ledgerRuns = [];
    });

    test('the burn line reads every trusted run, not just the five the plan uses', async () => {
        // Six runs: the plan slices five, the trend must not
        const text = await draw(Array.from({ length: 6 }, (_, i) => ledgerRun({ key: `r${i}`, torch: 60 })));
        expect(text).toContain('Burn per run:');
        expect(titles()).toContain('6 runs watched from the door');
    });

    test('the torch trend is per floor, so a short run and a deep one compare', async () => {
        const text = await draw([
            ledgerRun({ key: 'a', torch: 120, floor: 6 }),
            ledgerRun({ key: 'b', torch: 40, floor: 2 }),
            ledgerRun({ key: 'c', torch: 80, floor: 4 }),
        ]);
        expect(text).toContain('Torches per floor:');
        // All three are 20 per floor despite spending 120, 40 and 80
        expect(text).toContain('20.0');
    });

    test('untrusted runs are left out of both lines', async () => {
        const text = await draw([
            ledgerRun({ key: 'a', torch: 300, floor: 6 }),
            ledgerRun({ key: 'b', torch: 12, floor: 6, trusted: false }),
        ]);
        // One run, at 50 per floor — the untrusted 2/floor run would have
        // halved it, which is the 350-reads-as-106 mistake in miniature
        expect(titles()).toContain('1 run watched from the door');
        expect(text).toContain('50.0');
    });

    test('too few runs for a shape says so instead of drawing one', async () => {
        const text = await draw([ledgerRun({ key: 'a', torch: 100, floor: 5 })]);
        expect(text).toContain('Torches per floor:');
        expect(text).toContain('1 run so far');
        expect(text).not.toContain('▄');
    });

    test('a sparkline appears once there are three readings', async () => {
        const text = await draw([
            ledgerRun({ key: 'a', torch: 100, floor: 5 }),
            ledgerRun({ key: 'b', torch: 50, floor: 5 }),
            ledgerRun({ key: 'c', torch: 75, floor: 5 }),
        ]);
        expect(text).not.toContain('runs so far');
        expect(text).toMatch(/[▁▂▃▄▅▆▇█]{3}/);
    });

    test('an empty ledger draws neither line', async () => {
        const text = await draw([]);
        expect(text).not.toContain('Burn per run:');
        expect(text).not.toContain('Torches per floor:');
    });

    test('a ledger of nothing but untrusted runs draws neither line', async () => {
        const text = await draw([ledgerRun({ key: 'a', trusted: false })]);
        expect(text).not.toContain('Burn per run:');
        expect(text).not.toContain('Torches per floor:');
    });

    test('the rush-floor verdict is dropped on a switch rather than judging the new character', async () => {
        // char1 has a pool of recorded fights; char2 has never recorded one, so
        // the verdict has nothing to speak from and must say nothing
        store.data.labyrinthFightRecorder_char1 = [
            { outcome: 'loss', remainderFraction: 0.08, fingerprint: 'g1' },
            { outcome: 'loss', remainderFraction: 0.1, fingerprint: 'g1' },
        ];
        consumablesPanel._labFightAttempts = null;
        consumablesPanel._labFightAttemptsOwner = null;

        await draw([ledgerRun({ key: 'a' })]);
        // The pool is read lazily on the first draw; the line lands on the next
        await settled();
        consumablesPanel._render();
        expect(consumablesPanel.bodyEl.textContent).toContain('Rush floor:');

        bus.characterId = 'char2';
        consumablesPanel._ledgerRuns = [];
        consumablesPanel._render();
        await settled();
        consumablesPanel._render();

        expect(consumablesPanel.bodyEl.textContent).not.toContain('Rush floor:');
    });
});
