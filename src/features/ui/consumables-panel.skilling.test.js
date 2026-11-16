/** @vitest-environment happy-dom
 *
 * The Consumables panel following a skill's teas.
 *
 * Combat stays exactly as it was; what is new is the picker and the skill section, and every way
 * that section can end: running, frozen, nothing slotted, held at zero, unpriced, rate unknown,
 * concentration zero, a tea slotted twice, empty slots and no character yet.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const FORAGING = '/action_types/foraging';
const COMBAT = '/action_types/combat';
const MINUTE_NS = 60_000_000_000;
const INV = '/item_locations/inventory';

const store = vi.hoisted(() => ({ data: {} }));
const settings = vi.hoisted(() => ({ values: {} }));
const bus = vi.hoisted(() => ({ handlers: {} }));
const game = vi.hoisted(() => ({
    items: {},
    inventory: [],
    clientData: null,
    characterData: null,
    currentActions: [],
    actionDetails: {},
    slots: {},
    map: new Map(),
    prices: {},
    latest: null,
    listings: [],
}));

vi.mock('../../core/config.js', () => ({
    default: {
        Z_FLOATING_PANEL: 1100,
        getSetting: (key) => settings.values[key] ?? true,
        getSettingValue: (key, fallback) =>
            settings.values[key] ?? (String(key).startsWith('market_') ? fallback : 'compact'),
        setSetting: () => {},
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
        delete: async () => true,
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
        getActionDetails: (hrid) => game.actionDetails[hrid] || null,
        getActionDrinkSlots: (type) => game.slots[type] || [],
        getInventory: () => game.inventory,
        getMarketListings: () => game.listings,
        getEquipment: () => new Map(),
        getInitClientData: () => game.clientData,
        getCurrentActions: () => game.currentActions,
        get characterData() {
            return game.characterData;
        },
        get actionTypeDrinkSlotsMap() {
            return game.map;
        },
        getSkills: () => [],
        getCurrentCharacterId: () => 'char1',
        getCurrentCharacterGameMode: () => 'standard',
        on: (event, handler) => {
            (bus.handlers[event] ||= []).push(handler);
        },
        off: () => {},
        emit: (event, payload) => {
            for (const handler of bus.handlers[event] || []) handler(payload);
        },
    },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrices: (hrid) => game.prices[hrid] ?? null,
    getItemPrice: (hrid) => game.prices[hrid]?.ask ?? null,
    getItemPriceInfo: (hrid) => ({ price: game.prices[hrid]?.ask ?? null, estimated: false }),
}));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));
vi.mock('../../utils/marketplace-autofill.js', () => ({
    createAutofillManager: () => ({ initialize: () => {}, setQuantity: () => {} }),
}));
vi.mock('../../utils/order-book.js', () => ({ estimateFillSeconds: () => null }));
vi.mock('../../utils/action-context.js', () => ({
    resolveActionContext: () => ({ equipment: new Map(), drinks: [] }),
}));
vi.mock('../../utils/tea-parser.js', () => ({ getDrinkConcentration: () => 0.1 }));
vi.mock('./consumables-shopping-list.js', () => ({ openShoppingList: () => {} }));
vi.mock('../combat-stats/combat-stats-data-collector.js', () => ({
    default: { getLatestData: () => game.latest },
}));
vi.mock('../combat-stats/combat-stats-calculator.js', () => ({
    valueOfLoot: () => ({ ask: 0, bid: 0, value: 0 }),
    calculatePlayerStats: (player) => ({ consumableBreakdown: player.breakdown || [] }),
}));

const { consumablesPanel } = await import('./consumables-panel.js');
const { _resetCaches } = await import('../../utils/panel-geometry.js');
const { default: dataManager } = await import('../../core/data-manager.js');

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const tea = (name, minutes) => ({ name, consumableDetail: { buffs: [{ duration: minutes * MINUTE_NS }] } });
const slot = (itemHrid, extra = {}) => ({
    actionTypeHrid: FORAGING,
    characterID: 1,
    consumableSlotTypeHrid: '/consumable_slot_types/drink',
    duration: 0,
    isActive: false,
    itemHrid,
    slotIndex: 0,
    ...extra,
});
const stack = (itemHrid, count) => ({ itemHrid, count, itemLocationHrid: INV, enhancementLevel: 0 });
const run = (actionHrid, type) => {
    game.currentActions = [{ actionHrid, isDone: false, ordinal: 1 }];
    game.actionDetails[actionHrid] = { type };
};
const runForaging = () => run('/actions/foraging/farmland', FORAGING);
const runCombat = () => run('/actions/combat/fly', COMBAT);

/** A combat player the way the collector hands one over */
const combatLatest = () => ({
    durationSeconds: 600,
    players: [
        {
            name: 'Fighter',
            isCurrentPlayer: true,
            breakdown: [
                {
                    itemHrid: '/items/super_coffee',
                    itemName: 'Super Coffee',
                    inventoryAmount: 5,
                    consumptionRate: 0.01,
                },
            ],
        },
    ],
});

const open = async () => {
    consumablesPanel.show({ remember: false });
    await settled();
    return consumablesPanel.bodyEl;
};
const text = () => consumablesPanel.bodyEl.textContent;
const skillingSection = () => consumablesPanel.bodyEl.querySelector('[data-skilling-section]');
const picker = () => consumablesPanel.bodyEl.querySelector('select[data-skill-action-type]');
const tab = (id) => {
    consumablesPanel.bodyEl.querySelector(`[data-tab="${id}"]`).click();
};
const pick = (value) => {
    const select = picker();
    select.value = value;
    select.dispatchEvent(new Event('change'));
};

beforeEach(() => {
    store.data = {};
    settings.values = {};
    game.items = {
        '/items/gathering_tea': tea('Gathering Tea', 5),
        '/items/efficiency_tea': tea('Efficiency Tea', 5),
        '/items/mystery_tea': { name: 'Mystery Tea' },
    };
    game.inventory = [];
    game.listings = [];
    game.clientData = { itemDetailMap: game.items };
    game.characterData = { noncombatStats: { drinkConcentration: 0.129 } };
    game.currentActions = [];
    game.actionDetails = {};
    game.slots = {};
    game.map = new Map([
        [FORAGING, []],
        ['/action_types/woodcutting', []],
        [COMBAT, []],
        ['/action_types/labyrinth', []],
        ['/action_types/special', []],
    ]);
    game.prices = {};
    game.latest = null;
    consumablesPanel._skillPin = null;
    consumablesPanel._tab = null;
    consumablesPanel._readinessMemo = null;
    consumablesPanel._profiles = [];
    consumablesPanel._dungeonHistory = [];
    consumablesPanel.hide({ remember: false });
    _resetCaches();
});

afterEach(() => {
    consumablesPanel.hide({ remember: false });
    vi.restoreAllMocks();
});

describe('the picker', () => {
    test('offers whatever I am doing and every skill, and not combat, labyrinth or special', async () => {
        runForaging();
        await open();

        const options = [...picker().options].map((option) => [option.value, option.textContent]);
        expect(options).toEqual([
            ['', 'Whatever I am doing'],
            [FORAGING, 'Foraging (running)'],
            ['/action_types/woodcutting', 'Woodcutting'],
        ]);
        expect(text()).toContain('Running: Foraging');
        expect(text()).not.toContain('could not be drawn');
    });

    test('the caption names what is shown when it differs from what is running', async () => {
        runForaging();
        await open();
        pick('/action_types/woodcutting');
        expect(text()).toContain('Running: Foraging — showing Woodcutting');
    });

    test('the pin is dropped on a character switch', async () => {
        runForaging();
        await open();
        pick('/action_types/woodcutting');
        expect(consumablesPanel._skillPin).toBe('/action_types/woodcutting');

        dataManager.emit('character_switched', {});
        expect(consumablesPanel._skillPin).toBeNull();
    });

    test('a pin for a type that is no longer offered is ignored, not drawn', async () => {
        consumablesPanel._skillPin = '/action_types/brewing';
        consumablesPanel._tab = 'skilling';
        await open();
        expect(skillingSection()?.dataset.skillingSection).not.toBe('/action_types/brewing');
        expect(picker().value).toBe('');
    });

    test('with nothing running, Whatever I am doing shows the first skill on offer', async () => {
        consumablesPanel._tab = 'skilling';
        await open();
        expect(skillingSection()?.dataset.skillingSection).toBe(FORAGING);
        expect(text()).toContain('Nothing running — showing Foraging');
    });

    test('a skill with no drink slots anywhere and nothing running says so', async () => {
        game.map = new Map([[COMBAT, []]]);
        consumablesPanel._tab = 'skilling';
        await open();
        expect(skillingSection()).toBeNull();
        expect(text()).toContain('No skills with drink slots yet');
        expect(text()).not.toContain('could not be drawn');
    });

    test('the pin is not stored anywhere', async () => {
        runForaging();
        await open();
        pick(FORAGING);
        await settled();
        expect(Object.keys(store.data).filter((key) => /skill|pin/i.test(key))).toEqual([]);
    });
});

describe('combat is as it was', () => {
    test('nothing running and no pin: the combat empty message, with no skilling section', async () => {
        await open();
        expect(skillingSection()).toBeNull();
        expect(picker()).toBeNull();
        expect(text()).toContain('No consumable data yet. Fight something with food or drinks equipped.');
    });

    test('a fight running: the combat player section, no skilling section', async () => {
        runCombat();
        game.latest = combatLatest();
        await open();
        expect(skillingSection()).toBeNull();
        expect(text()).toContain('Fighter (you)');
    });

    test('combat pinned while a skill runs shows the fight', async () => {
        runForaging();
        game.latest = combatLatest();
        game.slots[FORAGING] = [slot('/items/gathering_tea')];
        await open();
        expect(skillingSection()).not.toBeNull();
        tab('combat');
        expect(skillingSection()).toBeNull();
        expect(text()).toContain('Fighter (you)');
    });

    test('the combat button opens the Combat tab despite a running skill, and the choice is kept', async () => {
        runForaging();
        game.latest = combatLatest();
        game.slots[FORAGING] = [slot('/items/gathering_tea')];
        consumablesPanel.openTab('combat');
        await settled();
        expect(skillingSection()).toBeNull();
        expect(text()).toContain('Fighter (you)');
        consumablesPanel._render();
        expect(skillingSection()).toBeNull();
    });
});

describe('a skill', () => {
    test('running with teas: rows, headline, per-day and the continuous-running note', async () => {
        runForaging();
        game.latest = combatLatest();
        game.slots[FORAGING] = [slot('/items/gathering_tea', { isActive: true, duration: 100 * 1e9 }), null, null];
        game.inventory = [stack('/items/gathering_tea', 100)];
        game.prices['/items/gathering_tea'] = { ask: 1000, bid: 900 };
        await open();

        const section = skillingSection();
        expect(section).not.toBeNull();
        expect(section.textContent).toContain('Foraging teas');
        expect(section.textContent).toContain('Gathering Tea');
        expect(section.textContent).toContain('stops in');
        expect(section.textContent).toContain('Drink concentration 12.9%');
        expect(section.textContent).toContain('assume Foraging runs continuously');
        // 86400 / (300 / 1.129) a day
        expect(section.textContent).toContain('325.2/day');
        expect(text()).not.toContain('could not be drawn');
        // The fight's rows do not sit under a skill's heading
        expect(text()).not.toContain('Fighter (you)');
        expect(text()).not.toContain('No consumable data yet');
    });

    test('registers a walkable shortfall named for the skill', async () => {
        runForaging();
        game.slots[FORAGING] = [slot('/items/gathering_tea'), slot('/items/efficiency_tea', { slotIndex: 1 })];
        game.inventory = [stack('/items/gathering_tea', 10)];
        game.prices['/items/gathering_tea'] = { ask: 1000, bid: 900 };
        game.prices['/items/efficiency_tea'] = { ask: 2000, bid: 1800 };
        await open();

        const queue = consumablesPanel._buyQueues.find((entry) => entry.label === 'Foraging teas');
        expect(queue).toBeDefined();
        expect(queue.queue.map((item) => item.itemHrid)).toEqual(['/items/gathering_tea', '/items/efficiency_tea']);
        expect(queue.queue.every((item) => item.count > 0 && item.name)).toBe(true);
    });

    test('pinned but not running: frozen, with the stack held', async () => {
        runCombat();
        game.slots[FORAGING] = [slot('/items/gathering_tea', { duration: 90 * 1e9 })];
        game.inventory = [stack('/items/gathering_tea', 7)];
        await open();
        tab('skilling');
        pick(FORAGING);

        const section = skillingSection();
        expect(section.textContent).toContain('not running — frozen, 7 held');
        expect(section.textContent).not.toContain('stops in');
        expect(section.textContent).toContain('Foraging time, not clock time');
        expect(text()).toContain('Running: Combat — showing Foraging');
    });

    test('nothing slotted for the skill: an invitation naming it, with no empty table', async () => {
        runForaging();
        game.slots[FORAGING] = [null, null, null];
        await open();

        const section = skillingSection();
        expect(section.textContent).toContain('No teas are slotted for Foraging');
        expect(section.querySelector('[style*="grid"]')).toBeNull();
        expect(consumablesPanel._buyQueues.find((entry) => entry.label === 'Foraging teas')).toBeUndefined();
    });

    test('a tea held at zero keeps its row and its full shortfall', async () => {
        runForaging();
        game.slots[FORAGING] = [slot('/items/gathering_tea'), slot('/items/efficiency_tea', { slotIndex: 1 })];
        game.prices['/items/gathering_tea'] = { ask: 1000, bid: 900 };
        game.prices['/items/efficiency_tea'] = { ask: 2000, bid: 1800 };
        await open();

        expect(skillingSection().textContent).toContain('Gathering Tea');
        const queue = consumablesPanel._buyQueues.find((entry) => entry.label === 'Foraging teas');
        // The panel's own target, rounded up, with none held to subtract
        const perDay = 86400 / (300 / 1.129);
        const wanted = Math.ceil((perDay * consumablesPanel.target.seconds) / 86400);
        expect(queue.queue.map((item) => item.count)).toEqual([wanted, wanted]);
    });

    test('an open buy order is netted off the shortfall and carried to the list as its credit', async () => {
        runForaging();
        game.slots[FORAGING] = [slot('/items/gathering_tea'), slot('/items/efficiency_tea', { slotIndex: 1 })];
        game.prices['/items/gathering_tea'] = { ask: 1000, bid: 900 };
        game.prices['/items/efficiency_tea'] = { ask: 2000, bid: 1800 };
        const perDay = 86400 / (300 / 1.129);
        const wanted = Math.ceil((perDay * consumablesPanel.target.seconds) / 86400);
        const onOrder = Math.floor(wanted / 2);
        game.listings = [
            {
                id: 1,
                isSell: false,
                itemHrid: '/items/gathering_tea',
                enhancementLevel: 0,
                status: '/market_listing_status/active',
                orderQuantity: onOrder,
                filledQuantity: 0,
                unclaimedItemCount: 0,
            },
        ];
        await open();

        const queue = consumablesPanel._buyQueues.find((entry) => entry.label === 'Foraging teas');
        expect(queue.queue.map((item) => [item.count, item.onOrder])).toEqual([
            [wanted - onOrder, onOrder],
            [wanted, 0],
        ]);
    });

    test('an unpriced tea is flagged in the total, never drawn as free', async () => {
        runForaging();
        game.slots[FORAGING] = [slot('/items/gathering_tea'), slot('/items/efficiency_tea', { slotIndex: 1 })];
        game.inventory = [stack('/items/gathering_tea', 5), stack('/items/efficiency_tea', 5)];
        game.prices['/items/gathering_tea'] = { ask: 1000, bid: 900 };
        await open();

        expect(skillingSection().textContent).toContain('1 unpriced');
    });

    test('a rate-unknown tea says so rather than showing a figure', async () => {
        runForaging();
        game.slots[FORAGING] = [slot('/items/mystery_tea')];
        game.inventory = [stack('/items/mystery_tea', 5)];
        game.prices['/items/mystery_tea'] = { ask: 1000, bid: 900 };
        await open();

        const section = skillingSection();
        expect(section.textContent).toContain('rate unknown for 1 item');
        expect(section.textContent).toContain('?');
        expect(section.textContent).toContain('rate unknown');
        expect(text()).not.toContain('could not be drawn');
    });

    test('concentration zero is stated as 0%', async () => {
        runForaging();
        game.characterData = { noncombatStats: { drinkConcentration: 0 } };
        game.slots[FORAGING] = [slot('/items/gathering_tea')];
        game.inventory = [stack('/items/gathering_tea', 5)];
        await open();

        expect(skillingSection().textContent).toContain('Drink concentration 0%');
        expect(skillingSection().textContent).toContain('288.0/day');
    });

    test('a tea slotted twice is one row', async () => {
        runForaging();
        game.slots[FORAGING] = [slot('/items/gathering_tea'), slot('/items/gathering_tea', { slotIndex: 1 })];
        game.inventory = [stack('/items/gathering_tea', 5)];
        await open();

        // Once in the headline (the tea that stops you) and once in its row; a second row would make three
        expect(skillingSection().textContent.match(/Gathering Tea/g)).toHaveLength(2);
    });

    test('no character data yet: waiting, not an empty or zeroed table', async () => {
        runForaging();
        game.characterData = null;
        game.slots[FORAGING] = [slot('/items/gathering_tea')];
        await open();

        expect(skillingSection().textContent).toContain('Waiting for your character data');
        expect(text()).not.toContain('could not be drawn');
    });
});

describe('the dungeon readiness card', () => {
    const readinessStub = () =>
        vi.spyOn(consumablesPanel, '_readinessSection').mockImplementation(() => {
            const card = document.createElement('div');
            card.textContent = 'Dungeon readiness card';
            return card;
        });

    test('is not drawn under a skill heading, even with a dungeon queued', async () => {
        runForaging();
        game.slots[FORAGING] = [slot('/items/gathering_tea')];
        const card = readinessStub();
        await open();
        expect(skillingSection()).not.toBeNull();
        expect(text()).not.toContain('Dungeon readiness card');
        expect(card).not.toHaveBeenCalled();
    });

    test('is still drawn in the combat view, pinned or running, and with nothing running', async () => {
        readinessStub();
        runCombat();
        game.latest = combatLatest();
        await open();
        expect(text()).toContain('Dungeon readiness card');

        // Combat tab chosen while a skill runs
        consumablesPanel.hide({ remember: false });
        runForaging();
        game.slots[FORAGING] = [slot('/items/gathering_tea')];
        consumablesPanel._tab = 'combat';
        await open();
        expect(text()).toContain('Dungeon readiness card');

        consumablesPanel.hide({ remember: false });
        consumablesPanel._tab = null;
        game.currentActions = [];
        game.latest = null;
        await open();
        expect(text()).toContain('Dungeon readiness card');
    });
});

describe('the picker dropdown while it is open', () => {
    test('a redraw while the picker has focus leaves the select in place, and choosing still redraws', async () => {
        runForaging();
        game.slots[FORAGING] = [slot('/items/gathering_tea')];
        game.inventory = [stack('/items/gathering_tea', 7)];
        await open();

        const select = picker();
        select.focus();
        expect(document.activeElement).toBe(select);

        // Stock changes: the body would be rebuilt, which closes an open dropdown
        game.inventory = [stack('/items/gathering_tea', 900)];
        consumablesPanel._render();
        expect(picker()).toBe(select);

        // Choosing from it is the one redraw that must go through
        pick('/action_types/woodcutting');
        expect(picker()).not.toBe(select);
        expect(consumablesPanel._skillPin).toBe('/action_types/woodcutting');
    });

    test('once the picker loses focus the next redraw catches up', async () => {
        runForaging();
        game.slots[FORAGING] = [slot('/items/gathering_tea')];
        game.inventory = [stack('/items/gathering_tea', 7)];
        await open();

        const select = picker();
        select.focus();
        game.inventory = [stack('/items/gathering_tea', 900)];
        consumablesPanel._render();
        select.blur();
        consumablesPanel._render();
        expect(picker()).not.toBe(select);
        expect(text()).toContain('900');
    });
});

describe('the Labyrinth tab', () => {
    const labStub = () =>
        vi.spyOn(consumablesPanel, '_labSection').mockImplementation(() => {
            const section = document.createElement('div');
            section.textContent = 'Labyrinth shopping list';
            return section;
        });

    test('is not drawn under a skill or in the combat view, and its section is not even built', async () => {
        runForaging();
        game.slots[FORAGING] = [slot('/items/gathering_tea')];
        const lab = labStub();
        await open();
        expect(skillingSection()).not.toBeNull();
        expect(text()).not.toContain('Labyrinth shopping list');
        tab('combat');
        expect(text()).not.toContain('Labyrinth shopping list');
        expect(lab).not.toHaveBeenCalled();
    });

    test('is drawn on its own tab, with a skill running or nothing running', async () => {
        runForaging();
        labStub();
        await open();
        tab('labyrinth');
        expect(text()).toContain('Labyrinth shopping list');

        consumablesPanel.hide({ remember: false });
        game.currentActions = [];
        consumablesPanel._tab = null;
        await open();
        tab('labyrinth');
        expect(text()).toContain('Labyrinth shopping list');
    });

    test('with no supply data the tab says so instead of staying blank', async () => {
        vi.spyOn(consumablesPanel, '_labSection').mockImplementation(() => null);
        consumablesPanel._tab = 'labyrinth';
        await open();
        expect(text()).toContain('No labyrinth supply data yet.');
        expect(text()).not.toContain('could not be drawn');
    });
});

describe('the tabs', () => {
    test('with no choice, a running skill opens Skilling and anything else opens Combat', async () => {
        runForaging();
        await open();
        expect(skillingSection() || picker()).not.toBeNull();
        consumablesPanel.hide({ remember: false });
        game.currentActions = [];
        await open();
        expect(picker()).toBeNull();
        expect(consumablesPanel.bodyEl.querySelector('[data-tab="combat"]').getAttribute('aria-pressed')).toBe('true');
    });

    test('with no choice, a running labyrinth opens the Labyrinth tab', async () => {
        run('/actions/labyrinth/labyrinth', '/action_types/labyrinth');
        await open();
        expect(consumablesPanel.bodyEl.querySelector('[data-tab="labyrinth"]').getAttribute('aria-pressed')).toBe(
            'true'
        );
    });

    test('a chosen tab lasts until the panel closes; the next open follows what is running', async () => {
        runForaging();
        consumablesPanel.openTab('labyrinth');
        await settled();
        expect(consumablesPanel.bodyEl.querySelector('[data-tab="labyrinth"]').getAttribute('aria-pressed')).toBe(
            'true'
        );
        consumablesPanel.hide({ remember: false });
        expect(consumablesPanel._tab).toBeNull();
        await open();
        expect(consumablesPanel.bodyEl.querySelector('[data-tab="skilling"]').getAttribute('aria-pressed')).toBe(
            'true'
        );
    });

    test('the choice is dropped on a character switch', async () => {
        await open();
        tab('labyrinth');
        expect(consumablesPanel._tab).toBe('labyrinth');
        dataManager.emit('character_switched', {});
        expect(consumablesPanel._tab).toBeNull();
    });

    test('openTab opens a closed panel, switches an open one, keeps one already on the tab, never closes', async () => {
        consumablesPanel.openTab('labyrinth');
        await settled();
        expect(consumablesPanel.panel).not.toBeNull();
        expect(consumablesPanel.bodyEl.querySelector('[data-tab="labyrinth"]').getAttribute('aria-pressed')).toBe(
            'true'
        );

        consumablesPanel.openTab('combat');
        expect(consumablesPanel.panel).not.toBeNull();
        expect(consumablesPanel.bodyEl.querySelector('[data-tab="combat"]').getAttribute('aria-pressed')).toBe('true');

        consumablesPanel.openTab('combat');
        expect(consumablesPanel.panel).not.toBeNull();
        expect(consumablesPanel.bodyEl.querySelector('[data-tab="combat"]').getAttribute('aria-pressed')).toBe('true');

        consumablesPanel.openTab('nonsense');
        expect(consumablesPanel._tab).toBe('combat');
    });

    test('openTab on Skilling with a skill shows that skill, not the running one', async () => {
        runForaging();
        consumablesPanel.openTab('skilling', { skill: '/action_types/combat' });
        await settled();
        expect(consumablesPanel._skillPin).toBeNull();
        consumablesPanel.openTab('skilling', { skill: FORAGING });
        expect(consumablesPanel._skillPin).toBe(FORAGING);
    });

    test('a folded panel is unfolded by openTab', async () => {
        await open();
        consumablesPanel.minimizeCtl.setCollapsed(true);
        consumablesPanel.openTab('labyrinth');
        expect(consumablesPanel.minimizeCtl.collapsed).toBe(false);
    });
});

describe('the Buy-all walk row', () => {
    const shortfall = [
        { itemHrid: '/items/gathering_tea', count: 5 },
        { itemHrid: '/items/efficiency_tea', count: 5 },
    ];

    test('sits above the sections, under the tab row and picker', async () => {
        runForaging();
        game.slots[FORAGING] = [slot('/items/gathering_tea'), slot('/items/efficiency_tea', { slotIndex: 1 })];
        game.prices['/items/gathering_tea'] = { ask: 1000, bid: 900 };
        game.prices['/items/efficiency_tea'] = { ask: 2000, bid: 1800 };
        await open();

        const walk = consumablesPanel.bodyEl.querySelector('.toolasha-consumables-inline-walk');
        expect(walk).not.toBeNull();
        const kids = [...consumablesPanel.bodyEl.children];
        expect(kids[0].dataset.tabRow).toBe('true');
        expect(kids.indexOf(walk)).toBeGreaterThan(kids.indexOf(picker().parentElement));
        expect(kids.indexOf(walk)).toBeLessThan(kids.indexOf(skillingSection()));
    });

    test('is absent when nothing is short, with no crash', async () => {
        await open();
        expect(consumablesPanel.bodyEl.querySelector('.toolasha-consumables-inline-walk')).toBeNull();
        expect(text()).not.toContain('could not be drawn');
    });

    test('a walk already running survives a tab switch, and the other tab shows no stale sources', async () => {
        await open();
        consumablesPanel._buyQueue = shortfall.slice();
        consumablesPanel._render({ force: true });
        expect(consumablesPanel.bodyEl.querySelector('.toolasha-consumables-inline-walk').textContent).toContain(
            'Next: '
        );
        tab('labyrinth');
        expect(consumablesPanel.bodyEl.querySelector('.toolasha-consumables-inline-walk').textContent).toContain(
            'Next: '
        );
        expect(consumablesPanel._buyQueue).toHaveLength(2);
        consumablesPanel._buyQueue = [];
    });
});

describe('on a narrow panel', () => {
    const setWidth = (width) => {
        Object.defineProperty(consumablesPanel.bodyEl, 'clientWidth', { configurable: true, get: () => width });
        consumablesPanel._render();
    };
    const divs = () => [...skillingSection().querySelectorAll('div')];

    beforeEach(() => {
        runForaging();
        game.slots[FORAGING] = [slot('/items/gathering_tea', { isActive: true, duration: 100 * 1e9 })];
        game.inventory = [stack('/items/gathering_tea', 7)];
        game.prices['/items/gathering_tea'] = { ask: 1000, bid: 900 };
        consumablesPanel._narrow = false;
    });

    test('wide: one grid row and the column headings, as before', async () => {
        await open();
        setWidth(600);
        expect(text()).toContain('Cost/day');
        expect(text()).not.toContain(' held');
        const grid = divs().find((el) => el.style.gridTemplateColumns && el.textContent.includes('Gathering Tea'));
        expect(grid).toBeTruthy();
        expect(grid.style.gridTemplateColumns).toBe('64px 20px minmax(0, 1fr) 76px 84px 74px 64px');
    });

    test('narrow: two lines, no headings, name and Lasts first, held and buy second', async () => {
        await open();
        setWidth(358);
        expect(text()).not.toContain('Cost/day');
        const row = divs().find(
            (el) =>
                el.children.length === 2 && el.textContent.includes('Gathering Tea') && el.textContent.includes('held')
        );
        expect(row).toBeTruthy();
        const [top, bottom] = row.children;
        expect(top.textContent).toContain('Gathering Tea');
        expect(top.textContent).toMatch(/\d+[smhd]|∞/);
        expect(bottom.textContent).toContain('7 held');
        expect(bottom.textContent).toContain('/day');
        // No row is a seven-column grid, so none can overflow sideways
        expect(divs().some((el) => el.style.gridTemplateColumns.includes('76px'))).toBe(false);
        expect(text()).not.toContain('could not be drawn');
    });

    test('between the two widths the layout stays as it was, so a scrollbar cannot flip it', async () => {
        await open();
        setWidth(358);
        setWidth(455);
        expect(consumablesPanel._narrow).toBe(true);
        setWidth(480);
        expect(consumablesPanel._narrow).toBe(false);
        setWidth(455);
        expect(consumablesPanel._narrow).toBe(false);
    });

    test('an unmeasured body (width 0) keeps the last layout', async () => {
        await open();
        setWidth(358);
        setWidth(0);
        expect(consumablesPanel._narrow).toBe(true);
    });

    test('a short item keeps its Buy control, finger-sized, on the narrow row', async () => {
        game.inventory = [stack('/items/gathering_tea', 1)];
        await open();
        setWidth(358);
        const buy = [...skillingSection().querySelectorAll('span')].find((el) => /[⚡⏳]/.test(el.textContent));
        expect(buy).toBeTruthy();
        expect(buy.style.minHeight).toBe('20px');
    });
});
