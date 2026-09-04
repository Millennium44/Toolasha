/** @vitest-environment happy-dom
 *
 * The dungeon readiness card on the Consumables panel.
 *
 * The arithmetic lives in `utils/dungeon-readiness.js` and is tested there.
 * What these cover is the honesty of the card: that it says "unknown" with a
 * reason for everything the pre-run payload does not carry, that it never
 * renders an unreadable member as if they were stocked, and that the keys —
 * the one figure that is exact before the run — are exact, for the party as
 * well as for you, without a counted key pile ever passing for a read member.
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

/**
 * What the dungeon tracker's current run holds, reached the way the panel
 * reaches it: `window.Toolasha.Combat`, because the tracker is a
 * websocket-fed singleton in another bundle.
 */
const tracking = (run) => {
    window.Toolasha = { Combat: { dungeonTracker: { getCurrentRun: () => run } } };
};

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

/** Put a different number of entry keys in the bag than `inParty`'s four */
const keysInBag = (count) => {
    game.inventory = game.inventory.map((entry) => (entry.itemHrid === KEY ? { ...entry, count } : entry));
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
    delete window.Toolasha;
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
    test('counts the inventory and names what is missing for the plan', async () => {
        inParty();
        store.data.consumablesDungeonRuns = 10;
        await render();

        expect(text()).toContain('Chimerical Entry Key');
        // The count to go and buy, not the count to end up holding
        expect(text()).toContain('4 held · covers 4 · 6 to buy');
    });

    test('enough keys say so, and nothing is offered to buy', async () => {
        inParty();
        store.data.consumablesDungeonRuns = 3;
        await render();

        expect(text()).toContain('4 held · covers 3');
        expect(text()).not.toContain('to buy');
    });

    test('a large pile keeps its exact figure rather than being rounded to K', async () => {
        inParty();
        keysInBag(9053);
        store.data.consumablesDungeonRuns = 50;
        await render();

        expect(text()).toContain('9,053 held · covers 50');
    });

    test("another member's shortfall is shown as coverage, never as a shopping list", async () => {
        inParty();
        tracking({ dungeonHrid: DEN, keyCountsMap: { Me: 4, Ally: 3 } });
        store.data.consumablesDungeonRuns = 10;
        await render();

        const body = text();
        expect(body).toContain('3 keys · food unknown');
        // One "to buy" on the card, and it is yours
        expect(body.match(/to buy/g)).toHaveLength(1);
    });
});

describe('what the lobby cannot see', () => {
    test('every member with no key count is unknown before anything has been measured', async () => {
        inParty();
        await render();

        const body = text();
        expect(body).toContain('Me (you)');
        expect(body).toContain('Ally');
        expect(body).toContain('Stranger');
        // Your own keys are in your inventory, so your line is never blank —
        // but your food is still unmeasured and the line says so
        expect(body).toContain('4 keys · food unknown');
        expect(body.match(/unknown — not in party data/g)).toHaveLength(2);
    });

    test('the reason is footnoted, not left to be inferred', async () => {
        inParty();
        await render();
        expect(text()).toContain('only in the battle payload');
    });

    test('a member the last battle measured is shown in runs; the rest stay unknown', async () => {
        inParty();
        keysInBag(500);
        measuredSelf();
        await render();

        const body = text();
        expect(body).toContain('12 runs · Power Coffee');
        expect(body).toContain('Stops first');
        // And it says how thin the sample for that verdict is
        expect(body).toContain('1 of 3 read');
        expect(body.match(/unknown — not in party data/g)).toHaveLength(2);
    });

    test('a key pile shorter than the food is what stops you, and says so', async () => {
        inParty();
        measuredSelf();
        store.data.consumablesDungeonRuns = 10;
        await render();

        const body = text();
        // Four keys against twelve runs of coffee: the keys bind
        expect(body).toContain('4 runs · Chimerical Entry Key');
        expect(body).toContain('Stops first');
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

describe('the party key counts the game itself broadcasts', () => {
    test("a member's stated keys are shown, and their food is still unknown", async () => {
        inParty();
        tracking({ dungeonHrid: DEN, keyCountsMap: { Me: 4, Ally: 3 } });
        store.data.consumablesDungeonRuns = 10;
        await render();

        const body = text();
        expect(body).toContain('3 keys · food unknown');
        // Counting a member's keys does not count them as read
        expect(body).toContain('keys only for');
        expect(body).toContain('key-count message in party chat');
        // The member chat said nothing about is still plainly unknown
        expect(body).toContain('unknown — not in party data');
    });

    test('an emptied slot map mid-battle still names the party', async () => {
        inParty();
        game.characterData.partyInfo.partySlotMap = {};
        tracking({ dungeonHrid: DEN, keyCountsMap: { Me: 4, Ally: 3 } });
        await render();

        const body = text();
        expect(body).toContain('Ally');
        expect(body).not.toContain('Unknown player');
    });

    test('the battle payload names a party no key count has arrived for yet', async () => {
        inParty();
        game.characterData.partyInfo.partySlotMap = {};
        game.latest = { durationSeconds: 60, actionHrid: DEN, players: [{ name: 'Me' }, { name: 'Ally' }] };
        await render();

        const body = text();
        expect(body).toContain('Ally');
        expect(body).toContain('unknown — not in party data');
    });

    test('a battle payload from another dungeon does not lend this card its names', async () => {
        inParty();
        game.characterData.partyInfo.partySlotMap = {};
        game.latest = {
            durationSeconds: 60,
            actionHrid: '/actions/combat/pirate_cove',
            players: [{ name: 'Me' }, { name: 'Ally' }],
        };
        await render();

        expect(text()).not.toContain('Ally');
    });

    test('a tracked run of another dungeon does not lend this card its counts', async () => {
        inParty();
        tracking({ dungeonHrid: '/actions/combat/pirate_cove', keyCountsMap: { Ally: 3 } });
        await render();

        expect(text()).not.toContain('3 keys');
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

describe('how many runs the card is sized for', () => {
    test('a day of dungeoning is the default, not five runs', async () => {
        inParty();
        await render();

        expect(text()).toContain('100 runs');
        expect(consumablesPanel.dungeonRuns).toBe(100);
    });

    test('a target already chosen survives the new default', async () => {
        inParty();
        store.data.consumablesDungeonRuns = 3;
        await render();

        expect(consumablesPanel.dungeonRuns).toBe(3);
        expect(text()).toContain('3 runs');
    });

    test('the old steps still cycle, and the list now reaches past them', async () => {
        inParty();
        store.data.consumablesDungeonRuns = 25;
        await render();

        const seen = [];
        for (let i = 0; i < 4; i += 1) {
            consumablesPanel._cycleDungeonRuns();
            seen.push(consumablesPanel.dungeonRuns);
        }
        expect(seen).toEqual([50, 100, 250, 500]);
        expect(store.data.consumablesDungeonRuns).toBe(500);
    });

    test('the cycle wraps rather than running off the end', async () => {
        inParty();
        store.data.consumablesDungeonRuns = 1000;
        await render();

        consumablesPanel._cycleDungeonRuns();
        expect(consumablesPanel.dungeonRuns).toBe(1);
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

describe('typing an exact run count', () => {
    /** The ✎ beside the cycling chip, and the box it opens */
    const editButton = () => [...consumablesPanel.bodyEl.querySelectorAll('span')].find((el) => el.textContent === '✎');
    const box = () => consumablesPanel.bodyEl.querySelector('input[inputmode="numeric"]');

    const type = async (value) => {
        editButton().dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        const input = box();
        input.value = value;
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await settled();
        return input;
    };

    test('a count no preset offers is taken and remembered', async () => {
        inParty();
        await render();

        await type('2753');

        expect(consumablesPanel.dungeonRuns).toBe(2753);
        expect(store.data.consumablesDungeonRuns).toBe(2753);
        expect(text()).toContain('2,753 runs');
    });

    test('it survives a reload', async () => {
        inParty();
        await render();
        await type('2753');

        // The same stored settings read back the way a fresh page load reads them
        await consumablesPanel.loadSettings();
        consumablesPanel._render();

        expect(consumablesPanel.dungeonRuns).toBe(2753);
        expect(text()).toContain('2,753 runs');
    });

    test('a stored count that was never valid falls back rather than being trusted', async () => {
        inParty();
        store.data.consumablesDungeonRuns = -12;
        await render();

        expect(consumablesPanel.dungeonRuns).toBe(100);
    });

    test('an entry that is not a run count leaves the stored plan alone', async () => {
        inParty();
        store.data.consumablesDungeonRuns = 25;
        await render();

        for (const bad of ['0', '-3', 'lots', '1000000']) {
            await type(bad);
            expect(consumablesPanel.dungeonRuns).toBe(25);
            expect(store.data.consumablesDungeonRuns).toBe(25);
        }
        expect(text()).toContain('25 runs');
    });

    test('Escape leaves the plan exactly as it was', async () => {
        inParty();
        store.data.consumablesDungeonRuns = 50;
        await render();

        editButton().dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
        const input = box();
        input.value = '7';
        input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await settled();

        expect(consumablesPanel.dungeonRuns).toBe(50);
        expect(store.data.consumablesDungeonRuns).toBe(50);
    });

    test('cycling from a typed count steps up rather than forgetting it', async () => {
        inParty();
        await render();
        await type('60');

        consumablesPanel._cycleDungeonRuns();
        expect(consumablesPanel.dungeonRuns).toBe(100);
    });

    test('cycling past the top of the ladder wraps, from a typed count too', async () => {
        inParty();
        await render();
        await type('2753');

        consumablesPanel._cycleDungeonRuns();
        expect(consumablesPanel.dungeonRuns).toBe(1);
    });
});
