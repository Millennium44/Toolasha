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
    /** Philosopher's Mirror buy price: dear by default, so a mirror route only shows when a test wants it */
    mirrorPrice: 1_000_000_000,
    /** What the star item is worth as a craft estimate, and what the base sells for */
    starPrice: 500_000_000,
    baseSell: 300_000,
    /** Enhance cost of one climb, in gold; linear by default */
    climb: (from, to) => (to - from) * 1_000_000,
}));

const CAPE = '/items/sinister_cape_refined';
const BASE = '/items/sinister_cape';
const SHARD = '/items/sinister_refinement_shard';
const MIRROR = '/items/philosophers_mirror';
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
        return state.climb(from, to);
    },
    enhancementSweepParams: () => ({}),
}));
vi.mock('../enhancement/enhancement-params-source.js', () => ({ describeEnhancementSource: () => null }));
vi.mock('../../utils/profit-helpers.js', () => ({
    // A cape base with no listing: the craft estimate the ordinary +0 path returns
    resolveItemPrice: vi.fn((hrid) => ({
        price:
            hrid === CAPE
                ? state.starPrice
                : hrid === SHARD
                  ? 2_000_000
                  : hrid === BASE
                    ? state.baseSell
                    : hrid === MIRROR
                      ? state.mirrorPrice
                      : 1,
    })),
}));
vi.mock('../../utils/market-data.js', () => ({
    // Every level of everything has an ask; a cape must never use one
    getItemPrices: vi.fn(() => ({ ask: 999_000_000, bid: 1 })),
}));
vi.mock('./skilling-sim-helpers.js', () => ({ buildOverridesForSkill: vi.fn() }));

const { calculateUpgradeCost, explainUpgradeCost } = await import('./upgrade-advisor.js');
const { cheapestWithMirror } = await import('../../utils/mirror-route.js');

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
        state.mirrorPrice = 1_000_000_000;
        state.starPrice = 500_000_000;
        state.baseSell = 300_000;
        state.climb = (from, to) => (to - from) * 1_000_000;
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

    test('a base listed on the marketplace is not a held copy', () => {
        state.items = [stack(BASE, 7, '/item_locations/back'), stack(BASE, 10, '/item_locations/marketplace')];
        const candidate = tier(7, { currentHrid: BASE, currentLevel: 7, removedItems: undefined });
        const detail = explainUpgradeCost(candidate, gameData);
        expect(detail.ladder).toMatchObject({ fromLevel: 7, fromEquipped: true });
        expect(calculateUpgradeCost(candidate, gameData)).toBe(SHARDS);
    });

    test('a base listed on the marketplace alone does not make a refine route', () => {
        state.items = [stack(BASE, 10, '/item_locations/marketplace')];
        expect(explainUpgradeCost(tier(7), gameData).buys[0].source).toBe('enhance');
    });

    test('a cross-slot swap (lab armor) refines the worn base it takes off', () => {
        state.items = [stack(BASE, 7, '/item_locations/back')];
        const candidate = {
            type: 'cross_slot',
            addedSlots: { '/equipment_types/back': { hrid: CAPE, enhancementLevel: 7 } },
            removedItems: [{ hrid: BASE, enhancementLevel: 7 }],
        };
        const detail = explainUpgradeCost(candidate, gameData);
        expect(calculateUpgradeCost(candidate, gameData)).toBe(SHARDS);
        expect(detail.net).toBe(SHARDS);
        expect(detail.buys[0].source).toBe('refine');
        expect(detail.credit).toBe(0);
    });

    test('a cross-slot swap that does not take the base off leaves it worn', () => {
        state.items = [stack(BASE, 7, '/item_locations/back')];
        const candidate = {
            type: 'cross_slot',
            addedSlots: { '/equipment_types/back': { hrid: CAPE, enhancementLevel: 7 } },
            removedItems: [],
        };
        expect(explainUpgradeCost(candidate, gameData).buys[0].source).toBe('enhance');
    });

    test('routes are compared after resale: buying and selling the worn base beats refining it', () => {
        // Buying directly: 203M star craft + 7M enhance = 210M. Refining: 200M shards, but the worn
        // base would have sold for 100M, so refining is really 300M against 210M - 100M = 110M.
        state.starPrice = 203_000_000;
        state.baseSell = 100_000_000;
        state.items = [stack(BASE, 7, '/item_locations/back')];
        const candidate = tier(7, { currentHrid: BASE, currentLevel: 7, removedItems: undefined });
        expect(calculateUpgradeCost(candidate, gameData)).toBe(110_000_000);
        expect(explainUpgradeCost(candidate, gameData).buys[0].source).toBe('enhance');
    });

    describe('Philosophers Mirror', () => {
        // Each climb doubles, so mirroring two cheaper copies beats climbing, as at +14/+15 in game
        beforeEach(() => {
            state.climb = (from, to) => (2 ** to - 2 ** from) * 1_000_000;
            state.mirrorPrice = 1_000_000;
        });

        test('a star target is built from a mirrored base, then refined', () => {
            const detail = explainUpgradeCost(tier(7), gameData);
            // Base copies: +0 is 0.3M; a climb to +k adds (2^k - 1)M. The mirror ladder, in millions.
            const ordinary = Array.from({ length: 8 }, (_, k) => 0.3 + (2 ** k - 1)).map((m) => m * 1e6);
            const { best } = cheapestWithMirror(ordinary, 1_000_000);
            expect(best[7]).toBeLessThan(ordinary[7]);
            expect(detail.buys[0]).toMatchObject({ source: 'refine' });
            expect(detail.buys[0].price).toBeCloseTo(SHARDS + best[7], 0);
            expect(detail.ladder.refine.mirror).toBeTruthy();
        });

        test('a dear mirror leaves the ordinary route alone', () => {
            state.mirrorPrice = 1_000_000_000;
            expect(explainUpgradeCost(tier(7), gameData).buys[0].source).toBe('enhance');
        });
    });
});
