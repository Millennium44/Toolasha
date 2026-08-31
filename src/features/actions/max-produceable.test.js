/** @vitest-environment happy-dom */

/**
 * Tests for the Max Produceable calculation
 *
 * "Can produce: N" is the one number on the action panel that is pure
 * arithmetic: inventory divided by the per-action material cost, floored, and
 * taken across every input plus the upgrade slot. The character's bank and teas
 * are mocked; the division is not.
 *
 * Also covered: the injectMaxProduceable re-entry guard, because a missing
 * guard there is a page freeze rather than a wrong number.
 *
 * Not covered here (pure DOM/observer glue): updateCount, addBestActionIndicators,
 * the font-fitting and layout-sync helpers.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    actionDetails: {},
    actionDetailMap: {},
    inventory: [],
    itemDetailMap: {},
    drinkSlots: [],
}));

const settings = vi.hoisted(() => ({
    values: {},
}));

const sortCalls = vi.hoisted(() => ({
    triggerSort: 0,
    registerPanel: 0,
}));

const buffs = vi.hoisted(() => ({
    artisanBonus: 0,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getActionDetails: (hrid) => game.actionDetails[hrid] ?? null,
        getInventory: () => game.inventory,
        getInitClientData: () => ({ itemDetailMap: game.itemDetailMap, actionDetailMap: game.actionDetailMap }),
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => game.drinkSlots,
        on: () => {},
        off: () => {},
    },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {} },
}));

// Real subscribe/unsubscribe bookkeeping, unlike a no-op stub, so a test can
// prove a disable+initialize cycle does not accumulate listeners.
const settingListeners = vi.hoisted(() => ({}));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => settings.values[key] ?? true,
        getSettingValue: (_k, fallback) => fallback,
        onSettingChange: (key, callback) => {
            (settingListeners[key] ??= []).push(callback);
            return () => {
                settingListeners[key] = (settingListeners[key] || []).filter((cb) => cb !== callback);
            };
        },
        offSettingChange: (key, callback) => {
            settingListeners[key] = (settingListeners[key] || []).filter((cb) => cb !== callback);
        },
        COLOR_BORDER: '#333',
        COLOR_PROFIT: '#0f0',
        COLOR_LOSS: '#f00',
        COLOR_WARNING: '#ff0',
        SCRIPT_COLOR_ALERT: '#fa0',
    },
}));

vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, fetch: async () => {}, getPrice: () => null, on: () => () => {} },
}));

vi.mock('./action-panel-sort.js', () => ({
    default: {
        initialize: async () => {},
        updateProfit: () => {},
        updateExpPerHour: () => {},
        isPinned: () => false,
        triggerSort: () => {
            sortCalls.triggerSort += 1;
        },
        registerPanel: () => {
            sortCalls.registerPanel += 1;
        },
        unregisterPanel: () => {},
        clearAllPanels: () => {},
    },
}));

vi.mock('./action-filter.js', () => ({
    default: { isFilterHidden: () => false },
}));

vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: async () => null }));
vi.mock('./production-profit.js', () => ({ calculateProductionProfit: async () => null }));
vi.mock('../../utils/experience-calculator.js', () => ({ calculateExpPerHour: () => null }));

vi.mock('../../utils/tea-parser.js', () => ({
    parseArtisanBonus: () => buffs.artisanBonus,
    getDrinkConcentration: () => 0,
}));

const maxProduceable = (await import('./max-produceable.js')).default;

const SWORD = '/actions/cheesesmithing/cheesy_sword';
const CHEESE = '/items/cheese';
const IRON = '/items/iron_bar';
const STONE = '/items/enhancement_stone';

/** Inventory rows, defaulting to the inventory location the index filters on */
function stack(itemHrid, count, itemLocationHrid = '/item_locations/inventory') {
    return { itemHrid, count, itemLocationHrid };
}

beforeEach(() => {
    buffs.artisanBonus = 0;
    settings.values = {};
    sortCalls.triggerSort = 0;
    sortCalls.registerPanel = 0;
    game.drinkSlots = [];
    game.itemDetailMap = {};
    game.actionDetailMap = { [SWORD]: { name: 'Cheesy Sword' } };
    game.actionDetails = {
        [SWORD]: {
            type: '/action_types/cheesesmithing',
            inputItems: [
                { itemHrid: CHEESE, count: 10 },
                { itemHrid: IRON, count: 5 },
            ],
        },
    };
    game.inventory = [stack(CHEESE, 120), stack(IRON, 65)];
});

describe('calculateMaxProduceable', () => {
    test('is limited by the scarcest input', () => {
        // cheese 120 / 10 = 12, iron 65 / 5 = 13 → 12
        expect(maxProduceable.calculateMaxProduceable(SWORD)).toBe(12);
    });

    test('floors partial crafts', () => {
        game.inventory = [stack(CHEESE, 129), stack(IRON, 65)];

        // 129 / 10 = 12.9 → 12
        expect(maxProduceable.calculateMaxProduceable(SWORD)).toBe(12);
    });

    test('a missing material means zero crafts, not a skipped ingredient', () => {
        game.inventory = [stack(CHEESE, 120)];

        expect(maxProduceable.calculateMaxProduceable(SWORD)).toBe(0);
    });

    test('ignores stacks held outside the inventory', () => {
        game.inventory = [stack(CHEESE, 120), stack(IRON, 65, '/item_locations/bank')];

        expect(maxProduceable.calculateMaxProduceable(SWORD)).toBe(0);
    });

    test('returns null for an unknown action', () => {
        expect(maxProduceable.calculateMaxProduceable('/actions/nope')).toBeNull();
    });

    test('accepts a prebuilt inventory index instead of re-reading the bank', () => {
        const index = new Map([
            [CHEESE, { itemHrid: CHEESE, count: 500 }],
            [IRON, { itemHrid: IRON, count: 500 }],
        ]);

        // 500 / 10 = 50, 500 / 5 = 100 → 50
        expect(maxProduceable.calculateMaxProduceable(SWORD, index)).toBe(50);
    });
});

describe('calculateMaxProduceable — Artisan Tea', () => {
    test('stretches the materials by the artisan reduction', () => {
        buffs.artisanBonus = 0.1;

        // cheese: 10 × 0.9 = 9 per action → 120 / 9 = 13.33 → 13
        // iron:    5 × 0.9 = 4.5        →  65 / 4.5 = 14.44 → 14
        expect(maxProduceable.calculateMaxProduceable(SWORD)).toBe(13);
    });

    test('an exact multiple of a fractional per-action cost is not floored one short', () => {
        // 10 × (1 − 0.112) = 8.88 per action, and 8880 in the bag is exactly
        // 1000 actions' worth — but IEEE division says 8880 / 8.88 is
        // 999.9999999999999, which a plain floor read as 999.
        buffs.artisanBonus = 0.112;
        game.actionDetails[SWORD].inputItems = [{ itemHrid: CHEESE, count: 10 }];
        game.inventory = [stack(CHEESE, 8880)];

        expect(maxProduceable.calculateMaxProduceable(SWORD)).toBe(1000);
    });
});

describe('calculateMaxProduceable — upgrade items', () => {
    test('an upgrade item caps the count and is not discounted by artisan tea', () => {
        game.actionDetails[SWORD].upgradeItemHrid = STONE;
        game.inventory = [stack(CHEESE, 120), stack(IRON, 65), stack(STONE, 4)];
        buffs.artisanBonus = 0.5; // would otherwise allow 24 crafts on cheese

        // 1 stone per craft, un-discounted → 4
        expect(maxProduceable.calculateMaxProduceable(SWORD)).toBe(4);
    });

    test('no upgrade item in the bank means nothing can be made', () => {
        game.actionDetails[SWORD].upgradeItemHrid = STONE;

        expect(maxProduceable.calculateMaxProduceable(SWORD)).toBe(0);
    });

    test('when the upgrade item is also an input it costs one extra, undiscounted', () => {
        // Upgrading a sword: 3 cheese plus the sword being upgraded
        game.actionDetails['/actions/cheesesmithing/upgrade'] = {
            type: '/action_types/cheesesmithing',
            inputItems: [
                { itemHrid: CHEESE, count: 3 },
                { itemHrid: '/items/cheesy_sword', count: 2 },
            ],
            upgradeItemHrid: '/items/cheesy_sword',
        };
        game.inventory = [stack(CHEESE, 100), stack('/items/cheesy_sword', 9)];

        // swords per action = 2 + 1 upgrade = 3 → 9 / 3 = 3
        // cheese 100 / 3 = 33 → limited to 3, and the upgrade slot is not charged twice
        expect(maxProduceable.calculateMaxProduceable('/actions/cheesesmithing/upgrade')).toBe(3);
    });

    test('artisan tea discounts the input half of a shared upgrade item only', () => {
        game.actionDetails['/actions/cheesesmithing/upgrade'] = {
            type: '/action_types/cheesesmithing',
            inputItems: [{ itemHrid: '/items/cheesy_sword', count: 2 }],
            upgradeItemHrid: '/items/cheesy_sword',
        };
        game.inventory = [stack('/items/cheesy_sword', 20)];
        buffs.artisanBonus = 0.5;

        // swords per action = 2 × 0.5 + 1 = 2 → 20 / 2 = 10
        expect(maxProduceable.calculateMaxProduceable('/actions/cheesesmithing/upgrade')).toBe(10);
    });
});

describe('injectMaxProduceable — re-insertion guard', () => {
    /** A skilling panel as the game renders it: a name div the hrid lookup reads */
    function panel(name = 'Cheesy Sword') {
        const el = document.createElement('div');
        el.className = 'SkillAction_skillAction__2j3sd';
        const nameEl = document.createElement('div');
        nameEl.className = 'SkillAction_name__3fgh';
        nameEl.textContent = name;
        el.appendChild(nameEl);
        document.body.appendChild(el);
        return el;
    }

    const displays = (el) => el.querySelectorAll('.mwi-max-produceable');

    afterEach(() => {
        maxProduceable.actionElements.clear();
        maxProduceable.resizeObserver = null;
        document.body.innerHTML = '';
    });

    test('a fresh panel gets one display and one sort trigger', () => {
        settings.values.actions_pinnedPage = false;
        const el = panel();

        maxProduceable.injectMaxProduceable(el);

        expect(displays(el)).toHaveLength(1);
        expect(sortCalls.triggerSort).toBe(1);
    });

    test('re-insertion with Pinned Actions off neither duplicates the display nor re-triggers the sort', () => {
        // The freeze: sort re-inserts the panel, injection appends a second display and
        // calls triggerSort() again, which re-inserts the panel, forever.
        settings.values.actions_pinnedPage = false;
        const el = panel();

        maxProduceable.injectMaxProduceable(el);
        const first = el.querySelector('.mwi-max-produceable');
        const triggersAfterFirst = sortCalls.triggerSort;

        for (let i = 0; i < 5; i++) {
            maxProduceable.injectMaxProduceable(el);
        }

        expect(displays(el)).toHaveLength(1);
        expect(sortCalls.triggerSort).toBe(triggersAfterFirst);
        expect(maxProduceable.actionElements.get(el)).toMatchObject({
            actionHrid: SWORD,
            displayElement: first,
            pinElement: null,
        });
    });

    test('with Pinned Actions on the existing-pin branch still handles re-insertion', () => {
        settings.values.actions_pinnedPage = true;
        const el = panel();

        maxProduceable.injectMaxProduceable(el);
        maxProduceable.injectMaxProduceable(el);

        expect(displays(el)).toHaveLength(1);
        expect(el.querySelectorAll('.mwi-action-pin')).toHaveLength(1);
    });
});

describe('disable unregisters the setting-change listeners it registered', () => {
    afterEach(() => {
        maxProduceable.disable();
        for (const key of Object.keys(settingListeners)) delete settingListeners[key];
    });

    test('a character-switch cycle does not accumulate listeners', async () => {
        // Every character switch runs disable() then initialize() again
        // (feature-registry.js). If the unregister function onSettingChange
        // hands back is discarded, each cycle leaves one more copy of the
        // same callback on config's per-key list.
        await maxProduceable.initialize();
        for (let i = 0; i < 3; i++) {
            maxProduceable.disable();
            await maxProduceable.initialize();
        }

        expect(settingListeners.profitCalc_pricingMode).toHaveLength(1);
        expect(settingListeners.actionPanel_maxProduceable).toHaveLength(1);
        expect(settingListeners.actionPanel_showProfitPerHour_production).toHaveLength(1);
        expect(settingListeners.actionPanel_showExpPerHour_production).toHaveLength(1);
    });
});
