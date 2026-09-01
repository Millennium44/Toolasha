/** @vitest-environment happy-dom
 *
 * The dungeon readiness card on the Consumables panel.
 *
 * The arithmetic lives in `utils/dungeon-readiness.js` and is tested there.
 * What these cover is the honesty of the card: that it says "unknown" with a
 * reason for everything the pre-run payload does not carry, that it never
 * renders an unreadable member as if they were stocked, and that the keys —
 * the one figure that is exact before the run — are exact.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const store = vi.hoisted(() => ({ data: {} }));
const settings = vi.hoisted(() => ({ values: {} }));
const game = vi.hoisted(() => ({
    items: {},
    actionDetail: null,
    inventory: [],
    latest: null,
    statsByName: {},
    characterData: null,
    actions: [],
    skills: [],
    clientData: { itemDetailMap: {}, abilityDetailMap: {} },
    equipment: new Map(),
    abilities: [],
}));

vi.mock('../../core/config.js', () => ({
    default: {
        Z_FLOATING_PANEL: 1100,
        getSetting: (key) => settings.values[key] ?? true,
        getSettingValue: (key, fallback) =>
            settings.values[key] ?? (String(key).startsWith('market_') ? fallback : 'compact'),
        setSetting: (key, value) => {
            settings.values[key] = value;
        },
        // The consumables panel, imported transitively, subscribes at module
        // scope so a setting flipped on the settings page repaints it
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
        get characterData() {
            return game.characterData;
        },
        getItemDetails: (hrid) => game.items[hrid] || null,
        getActionDetails: () => game.actionDetail,
        getInventory: () => game.inventory,
        getCurrentActions: () => game.actions,
        getSkills: () => game.skills,
        getInitClientData: () => game.clientData,
        getEquipment: () => game.equipment,
        getEquippedAbilities: () => game.abilities,
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

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));
const text = () => consumablesPanel.bodyEl.textContent;

const DEN = '/actions/combat/chimerical_den';
const KEY = '/items/chimerical_entry_key';

/** Skills that come to a round combat level */
const skillsAt = (level) => [
    { skillHrid: '/skills/stamina', level },
    { skillHrid: '/skills/intelligence', level },
    { skillHrid: '/skills/attack', level },
    { skillHrid: '/skills/defense', level },
    { skillHrid: '/skills/melee', level },
];

/** Sitting in a three-person party at the Den, four keys in the bag */
const inParty = () => {
    game.actionDetail = {
        name: 'Chimerical Den',
        combatZoneInfo: { isDungeon: true, dungeonInfo: { keyItemHrid: KEY } },
    };
    game.items[KEY] = { name: 'Chimerical Entry Key' };
    game.inventory = [{ itemHrid: KEY, count: 4, itemLocationHrid: '/item_locations/inventory' }];
    game.actions = [{ actionHrid: DEN, difficultyTier: 0, isDone: false }];
    game.skills = skillsAt(100);
    game.characterData = {
        character: { id: 'char1', name: 'Me' },
        partyInfo: {
            party: { actionHrid: DEN, difficultyTier: 0 },
            partySlotMap: {
                1: { characterID: 'char1', characterName: 'Me' },
                2: { characterID: 'char2', characterName: 'Ally' },
                3: { characterID: 'char3', characterName: 'Stranger' },
            },
        },
    };
    // Ten-minute runs on record, so hours of food convert to runs
    store.data.allRuns = Array.from({ length: 5 }, () => ({
        dungeonName: 'Chimerical Den',
        tier: 0,
        duration: 600_000,
    }));
};

/** What the last battle measured for the logged-in character only */
const measuredSelf = () => {
    game.latest = {
        durationSeconds: 3600,
        actionHrid: DEN,
        players: [{ name: 'Me', isCurrentPlayer: true }],
    };
    game.statsByName = {
        Me: {
            consumableBreakdown: [
                // 3600 held at one every two seconds is two hours: twelve runs
                {
                    itemHrid: '/items/power_coffee',
                    itemName: 'Power Coffee',
                    inventoryAmount: 3600,
                    consumptionRate: 0.5,
                },
            ],
            keyBreakdown: [],
        },
    };
    // The panel reads the character's own held counts from the live inventory
    game.inventory = [
        ...game.inventory,
        { itemHrid: '/items/power_coffee', count: 3600, itemLocationHrid: '/item_locations/inventory' },
    ];
};

const render = async () => {
    await consumablesPanel.loadSettings();
    consumablesPanel.show();
    await settled();
    consumablesPanel._render();
};

beforeEach(() => {
    store.data = {};
    settings.values = {};
    game.items = {};
    game.actionDetail = null;
    game.inventory = [];
    game.latest = null;
    game.statsByName = {};
    game.characterData = null;
    game.actions = [];
    game.skills = [];
    game.clientData = { itemDetailMap: {}, abilityDetailMap: {} };
    game.equipment = new Map();
    game.abilities = [];
    consumablesPanel.hide({ remember: false });
});

describe('when the card appears at all', () => {
    test('a dungeon in the action queue draws it', async () => {
        inParty();
        await render();
        expect(text()).toContain('Chimerical Den readiness');
    });

    test('a plain combat zone draws nothing', async () => {
        inParty();
        game.actionDetail = { name: 'Fly', combatZoneInfo: { isDungeon: false } };
        await render();
        expect(text()).not.toContain('readiness');
    });

    test('no character at all draws nothing, rather than failing', async () => {
        await render();
        expect(text()).not.toContain('readiness');
        expect(text()).not.toContain('could not');
    });
});

describe('the key line, which is the one exact figure', () => {
    test('counts the inventory and names the shortfall for the plan', async () => {
        inParty();
        store.data.consumablesDungeonRuns = 10;
        await render();

        expect(text()).toContain('Chimerical Entry Key');
        expect(text()).toContain('4 held · 6 short of 10');
    });

    test('enough keys say so instead', async () => {
        inParty();
        store.data.consumablesDungeonRuns = 3;
        await render();

        expect(text()).toContain('4 held · covers 3');
    });
});

describe('what the lobby cannot see', () => {
    test('every member is unknown before anything has been measured', async () => {
        inParty();
        await render();

        const body = text();
        expect(body).toContain('Me (you)');
        expect(body).toContain('Ally');
        expect(body).toContain('Stranger');
        expect(body.match(/unknown — not in party data/g)).toHaveLength(3);
    });

    test('the reason is footnoted, not left to be inferred', async () => {
        inParty();
        await render();
        expect(text()).toContain('only in the battle payload');
    });

    test('a member the last battle measured is shown in runs; the rest stay unknown', async () => {
        inParty();
        measuredSelf();
        await render();

        const body = text();
        expect(body).toContain('12 runs · Power Coffee');
        expect(body).toContain('Stops first');
        // And it says how thin the sample for that verdict is
        expect(body).toContain('1 of 3 read');
        expect(body.match(/unknown — not in party data/g)).toHaveLength(2);
    });

    test('with no recorded run length the coverage stays in time and says why', async () => {
        inParty();
        measuredSelf();
        store.data.allRuns = [];
        await render();

        const body = text();
        expect(body).not.toContain('12 runs');
        expect(body).toContain('how long one takes');
    });
});

describe('the checks that a captured profile does make possible', () => {
    test('a level-gapped member is flagged, and the uncheckable ones are named', async () => {
        inParty();
        store.data.profile_list = [
            {
                characterID: 'char2',
                characterName: 'Ally',
                profile: { characterSkills: skillsAt(50), wearableItemMap: {}, equippedAbilities: [] },
            },
        ];
        await render();

        const body = text();
        expect(body).toContain('Ally is level-gapped');
        expect(body).toContain('% off their monster drops');
        // Stranger has no profile, so the lint says it could not look
        expect(body).toContain('not for Stranger');
    });

    test('skilling gear on a member with a profile is flagged', async () => {
        inParty();
        game.clientData = {
            itemDetailMap: {
                '/items/cheese_hatchet': {
                    name: 'Cheese Hatchet',
                    equipmentDetail: { type: '/equipment_types/main_hand', noncombatStats: { woodcuttingSpeed: 1 } },
                },
            },
            abilityDetailMap: {},
        };
        store.data.profile_list = [
            {
                characterID: 'char2',
                characterName: 'Ally',
                profile: {
                    characterSkills: skillsAt(100),
                    wearableItemMap: { 1: { itemHrid: '/items/cheese_hatchet', enhancementLevel: 0 } },
                    equippedAbilities: [],
                },
            },
        ];
        await render();

        expect(text()).toContain('Ally has skilling gear equipped: Cheese Hatchet');
    });
});

describe('the card is not rebuilt on the refresh clock', () => {
    test('a redraw with nothing changed reuses the model it already built', async () => {
        inParty();
        await render();

        const first = consumablesPanel._readinessModel([]);
        const second = consumablesPanel._readinessModel([]);
        // The same object, not merely an equal one: the lint walks every
        // member's equipment through the item map, and doing it again five
        // seconds later produces the same card at the same cost
        expect(second).toBe(first);
    });

    test('changing the run target rebuilds it', async () => {
        inParty();
        await render();

        const first = consumablesPanel._readinessModel([]);
        consumablesPanel._cycleDungeonRuns();
        const second = consumablesPanel._readinessModel([]);

        expect(second).not.toBe(first);
        expect(second.runsPlanned).not.toBe(first.runsPlanned);
    });

    test('leaving the party drops the memo rather than keeping a stale card', async () => {
        inParty();
        await render();
        expect(consumablesPanel._readinessModel([])).not.toBeNull();

        game.characterData = { character: { id: 'char1', name: 'Me' } };
        game.actions = [];
        expect(consumablesPanel._readinessModel([])).toBeNull();
    });
});
