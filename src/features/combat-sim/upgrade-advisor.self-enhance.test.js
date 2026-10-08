/**
 * Self-enhanced gear in the upgrade advisor: a cape or quiver is priced as an
 * enhance from the copy the ladder picks, never at a market ask.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
    /** `characterItems`, inventory and equipped together, as init_character_data sends them */
    items: [],
    /** Enhancement sweeps the advisor asked for */
    sweeps: [],
}));

const CAPE = '/items/sinister_cape';
const SWORD = '/items/cheese_sword';
const CHAR = 161296;

// Capes carry no `isTradable` at all; tradables carry `isTradable: true`
const ITEM_DETAIL_MAP = {
    [CAPE]: {
        hrid: CAPE,
        name: 'Sinister Cape',
        equipmentDetail: { type: '/equipment_types/back' },
        enhancementCosts: [{ itemHrid: '/items/coin', count: 1000 }],
    },
    [SWORD]: {
        hrid: SWORD,
        name: 'Cheese Sword',
        isTradable: true,
        equipmentDetail: { type: '/equipment_types/main_hand' },
        enhancementCosts: [{ itemHrid: '/items/coin', count: 10 }],
    },
};

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInventory: () => [...state.items],
        getInitClientData: () => ({ itemDetailMap: ITEM_DETAIL_MAP }),
        getCurrentCharacterId: () => CHAR,
        getGuildBuildingLevel: () => 0,
        characterData: { characterAbilities: [] },
    },
}));
vi.mock('./combat-sim-adapter.js', () => ({
    buildGameDataPayload: vi.fn(),
    calculateSimRevenue: vi.fn(),
    getGuildBuffDetailMap: () => ({}),
    guildBuffMaxLevel: () => 0,
    applyGuildBuffLevel: () => [],
}));
vi.mock('./combat-sim-runner.js', () => ({
    runSimulation: vi.fn(),
    runLabyrinthSimulation: vi.fn(),
    getMaxWorkers: () => 4,
    plannedWorkerCount: vi.fn(() => 1),
}));
vi.mock('../combat/labyrinth-clear-rate.js', () => ({ default: {} }));
vi.mock('./labyrinth-level-finder.js', () => ({ findMaxLabyrinthLevel: vi.fn(), defaultThreshold: () => 0.7 }));
vi.mock('../../utils/tester-shop.js', () => ({ testerShopEnabled: () => false, testerGearPrice: () => null }));
// The sweep's own arithmetic has its suite; here it is a price per level stepped
vi.mock('./direct-enhancement-cost.js', () => ({
    calculateDirectEnhancementCost: (itemHrid, from, to) => {
        state.sweeps.push({ itemHrid, from, to });
        return (to - from) * 1_000_000;
    },
    enhancementSweepParams: () => ({}),
}));
vi.mock('../enhancement/enhancement-params-source.js', () => ({ describeEnhancementSource: () => null }));
vi.mock('../../utils/profit-helpers.js', () => ({
    // A cape base with no listing: the craft estimate the ordinary +0 path returns
    resolveItemPrice: vi.fn((hrid) => ({ price: hrid === CAPE ? 5_000_000 : 2_000_000 })),
}));
vi.mock('../../utils/market-data.js', () => ({
    // Every level of everything has an ask; a cape must never use one
    getItemPrices: vi.fn(() => ({ ask: 999_000_000, bid: 1 })),
}));
vi.mock('./skilling-sim-helpers.js', () => ({ buildOverridesForSkill: vi.fn() }));

const { calculateUpgradeCost, explainUpgradeCost } = await import('./upgrade-advisor.js');

/** One stack of `characterItems`, in the game's shape */
function stack(itemHrid, level, location = '/item_locations/inventory', count = 1) {
    return {
        id: Math.floor(Math.random() * 1e9),
        characterID: CHAR,
        itemLocationHrid: location,
        itemHrid,
        enhancementLevel: level,
        count,
        hash: `${CHAR}::${location}::${itemHrid}::${level}`,
    };
}

const gameData = { itemDetailMap: ITEM_DETAIL_MAP };
const tier = (itemHrid, level) => ({
    type: 'equipment',
    upgradeHrid: itemHrid,
    upgradeLevel: level,
    // An empty slot: nothing is sold, so the net is the purchase alone
    removedItems: [],
});

describe('self-enhanced upgrade pricing', () => {
    beforeEach(() => {
        state.items = [];
        state.sweeps = [];
    });

    test('best copy at +6 and second at +3: a +5 row ladders the +3 up, never the ask', () => {
        state.items = [stack(CAPE, 6, '/item_locations/back'), stack(CAPE, 3)];

        const candidate = tier(CAPE, 5);
        expect(calculateUpgradeCost(candidate, gameData)).toBe(2_000_000);
        const detail = explainUpgradeCost(candidate, gameData);
        expect(detail.buys[0]).toMatchObject({ price: 2_000_000, source: 'enhance' });
        expect(detail.ladder).toMatchObject({ fromLevel: 3, toLevel: 5, fresh: false, alreadyHeld: false });
        expect(state.sweeps).toContainEqual({ itemHrid: CAPE, from: 3, to: 5 });
    });

    test('best copy at +4: the ladder runs from the +4 itself', () => {
        state.items = [stack(CAPE, 4), stack(CAPE, 1)];
        const detail = explainUpgradeCost(tier(CAPE, 7), gameData);
        expect(detail.ladder).toMatchObject({ fromLevel: 4, toLevel: 7 });
        expect(detail.net).toBe(3_000_000);
    });

    test('no copy held: a fresh +0 base from the ordinary base path, plus the whole enhance', () => {
        const detail = explainUpgradeCost(tier(CAPE, 5), gameData);
        expect(detail.ladder).toMatchObject({ fromLevel: 0, fresh: true, baseCost: 5_000_000 });
        expect(detail.net).toBe(5_000_000 + 5_000_000);
    });

    test('a stack of two +6 copies ladders the second +6, which already meets +5', () => {
        state.items = [stack(CAPE, 6, '/item_locations/inventory', 2)];
        const detail = explainUpgradeCost(tier(CAPE, 5), gameData);
        expect(detail.ladder).toMatchObject({ fromLevel: 6, alreadyHeld: true });
        expect(detail.net).toBe(0);
    });

    test('an enhancement row on a worn +6 cape ladders the spare +3, not the worn one', () => {
        state.items = [stack(CAPE, 6, '/item_locations/back'), stack(CAPE, 3)];
        const candidate = {
            type: 'enhancement',
            currentHrid: CAPE,
            currentLevel: 6,
            upgradeHrid: CAPE,
            upgradeLevel: 7,
        };
        expect(calculateUpgradeCost(candidate, gameData)).toBe(4_000_000);
        const detail = explainUpgradeCost(candidate, gameData);
        expect(detail).toMatchObject({ net: 4_000_000, source: 'enhance', targetAsk: null, enhancementPath: true });
        expect(detail.ladder).toMatchObject({ fromLevel: 3, toLevel: 7 });
    });

    test('another player’s row never reads the live inventory', () => {
        state.items = [stack(CAPE, 4)];
        const candidate = {
            type: 'enhancement',
            currentHrid: CAPE,
            currentLevel: 2,
            upgradeHrid: CAPE,
            upgradeLevel: 4,
        };
        expect(calculateUpgradeCost(candidate, gameData, false)).toBe(2_000_000);
        expect(explainUpgradeCost(candidate, gameData, false).ladder).toMatchObject({ fromLevel: 2 });
    });

    test('a tradable item still prices at its target-level ask', () => {
        state.items = [stack(SWORD, 3)];
        const detail = explainUpgradeCost(tier(SWORD, 5), gameData);
        expect(detail.buys[0]).toMatchObject({ price: 999_000_000, source: 'market' });
        expect(detail.ladder).toBeNull();
        expect(state.sweeps).toEqual([]);
    });
});
