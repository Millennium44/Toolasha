/**
 * Refined (star) targets in the upgrade advisor: a held base copy is refined, not re-enhanced from a fresh base.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
    /** `characterItems`, inventory and equipped together, as init_character_data sends them */
    items: [],
    /** Enhancement sweeps the advisor asked for */
    sweeps: [],
    /** Extra init_client_data maps (shops) */
    shops: {},
}));

const CAPE = '/items/sinister_cape_refined';
const BASE = '/items/sinister_cape';
const SHARD = '/items/sinister_refinement_shard';
const SWORD = '/items/cheese_sword';
const CHAR = 161296;

// Capes carry no `isTradable` at all; tradables carry `isTradable: true`
const ITEM_DETAIL_MAP = {
    [CAPE]: {
        hrid: CAPE,
        name: 'Sinister Cape ★',
        equipmentDetail: { type: '/equipment_types/back' },
        enhancementCosts: [{ itemHrid: '/items/coin', count: 1000 }],
    },
    [BASE]: { hrid: BASE, name: 'Sinister Cape', equipmentDetail: { type: '/equipment_types/back' } },
    [SWORD]: {
        hrid: SWORD,
        name: 'Cheese Sword',
        isTradable: true,
        equipmentDetail: { type: '/equipment_types/main_hand' },
        enhancementCosts: [{ itemHrid: '/items/coin', count: 10 }],
    },
};

// The real recipe shape: the base is `upgradeItemHrid`, the shards are an input, all levels transfer
const ACTIONS = {
    '/actions/tailoring/sinister_cape_refined': {
        hrid: '/actions/tailoring/sinister_cape_refined',
        upgradeItemHrid: BASE,
        retainAllEnhancement: true,
        inputItems: [{ itemHrid: SHARD, count: 100 }],
        outputItems: [{ itemHrid: CAPE, count: 1 }],
    },
};

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInventory: () => [...state.items],
        getInitClientData: () => ({ itemDetailMap: ITEM_DETAIL_MAP, actionDetailMap: ACTIONS, ...state.shops }),
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
    resolveItemPrice: vi.fn((hrid) => ({
        price: hrid === CAPE ? 500_000_000 : hrid === SHARD ? 2_000_000 : hrid === BASE ? 300_000 : 1,
    })),
}));
vi.mock('../../utils/market-data.js', () => ({
    // Every level of everything has an ask; a cape must never use one
    getItemPrices: vi.fn(() => ({ ask: 999_000_000, bid: 1 })),
}));
vi.mock('./skilling-sim-helpers.js', () => ({ buildOverridesForSkill: vi.fn() }));

const { calculateUpgradeCost, explainUpgradeCost } = await import('./upgrade-advisor.js');

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
const SHARDS = 100 * 2_000_000;
const tier = (level, extra = {}) => ({
    type: 'equipment',
    upgradeHrid: CAPE,
    upgradeLevel: level,
    removedItems: [],
    ...extra,
});

describe('refined target priced from a held base', () => {
    beforeEach(() => {
        state.items = [];
        state.sweeps = [];
        state.shops = {};
    });

    test('a spare +5 base is refined, then enhanced +5 to +7 on the star item', () => {
        state.items = [stack(BASE, 5)];
        const detail = explainUpgradeCost(tier(7), gameData);
        expect(calculateUpgradeCost(tier(7), gameData)).toBe(SHARDS + 2_000_000);
        expect(detail.buys[0]).toMatchObject({ price: SHARDS + 2_000_000, source: 'refine' });
        expect(detail.ladder).toMatchObject({ fresh: false, fromLevel: 5, toLevel: 7 });
        expect(state.sweeps).toContainEqual({ itemHrid: CAPE, from: 5, to: 7 });
    });

    test('no base held: the old fresh-base route is unchanged', () => {
        const detail = explainUpgradeCost(tier(7), gameData);
        expect(detail.ladder).toMatchObject({ fresh: true });
        expect(detail.buys[0].source).toBe('enhance');
    });

    test('a spare base below the refinement minimum is not refined', () => {
        state.items = [stack(BASE, 4)];
        expect(explainUpgradeCost(tier(7), gameData).buys[0].source).toBe('enhance');
    });

    test('a spare base above the target costs the shards alone', () => {
        state.items = [stack(BASE, 9)];
        expect(calculateUpgradeCost(tier(7), gameData)).toBe(SHARDS);
    });

    test('the worn base the row replaces is refined as it stands: shards only, no resale credit', () => {
        state.items = [stack(BASE, 7, '/item_locations/back')];
        const candidate = tier(7, { currentHrid: BASE, currentLevel: 7, removedItems: undefined });
        const detail = explainUpgradeCost(candidate, gameData);
        expect(calculateUpgradeCost(candidate, gameData)).toBe(SHARDS);
        expect(detail.net).toBe(SHARDS);
        expect(detail.credit).toBe(0);
        expect(detail.ladder).toMatchObject({ fromLevel: 7, toLevel: 7, fromEquipped: true });
        expect(detail.source).toBe('refine');
    });

    test('a worn base the row does not replace is not consumed', () => {
        state.items = [stack(BASE, 7, '/item_locations/back')];
        expect(explainUpgradeCost(tier(7), gameData).buys[0].source).toBe('enhance');
    });

    test('worn +7 and spare +5: the worn one is the cheaper base', () => {
        state.items = [stack(BASE, 7, '/item_locations/back'), stack(BASE, 5)];
        const candidate = tier(7, { currentHrid: BASE, currentLevel: 7, removedItems: undefined });
        expect(calculateUpgradeCost(candidate, gameData)).toBe(SHARDS);
    });
});
