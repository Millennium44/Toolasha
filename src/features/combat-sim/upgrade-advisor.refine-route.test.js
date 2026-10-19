/**
 * Refined (star) targets in the upgrade advisor: a held base copy is refined, not re-enhanced from a fresh base.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

// The advisor's mirror and base prices go through the shared enhancement input rule; here they read the
// same mocked resolver every other price in this file does, so each test keeps saying what they cost
vi.mock('../../utils/enhancement-input-pricing.js', async () => {
    const { resolveItemPrice } = await import('../../utils/profit-helpers.js');
    const { getItemPrices } = await import('../../utils/market-data.js');
    const via = (hrid) => {
        const price = resolveItemPrice(hrid, { side: 'buy', enhancementLevel: 0 })?.price;
        return price > 0
            ? { price, unpriced: false, estimated: false }
            : { price: null, unpriced: true, estimated: false };
    };
    return {
        priceMirror: () => via('/items/philosophers_mirror'),
        priceBase: (hrid) => via(hrid),
        priceAtLevel: (hrid, level) => {
            if (!(level > 0)) return via(hrid);
            const ask = getItemPrices(hrid, level)?.ask;
            return ask > 0
                ? { price: ask, unpriced: false, estimated: false }
                : { price: null, unpriced: true, estimated: false };
        },
        getCheapestProtectionPrice: () => ({ price: null, itemHrid: null }),
        perAttemptMaterialCost: () => ({ cost: 0, hasCost: false, hasMissingPrices: true }),
    };
});

const state = vi.hoisted(() => ({
    /** `characterItems`, inventory and equipped together, as init_character_data sends them */
    items: [],
    /** The enhancing parameters the advisor's bench has (Blessed Tea on or off) */
    sweepParams: {},
    /** Enhancement sweeps the advisor asked for */
    sweeps: [],
    /** Extra init_client_data maps (shops) */
    shops: {},
    /** Philosopher's Mirror buy price: dear by default, so a mirror route only shows when a test wants it */
    mirrorPrice: 1_000_000_000,
    /** No market listing at any level */
    noAsk: false,
    /** Ask by item and level when a test wants listings at some levels only; null for the flat default */
    askFor: null,
    /** What the sword sells for */
    swordSell: 1,
    /** What the star item is worth as a craft estimate, and what the base sells for */
    starPrice: 500_000_000,
    baseSell: 300_000,
    /** Enhance cost of one climb, in gold; linear by default */
    climb: (from, to) => (to - from) * 1_000_000,
}));

const CAPE = '/items/sinister_cape_refined';
const BASE = '/items/sinister_cape';
const RING = '/items/sinister_ring_refined';
const RING_BASE = '/items/sinister_ring';
const SHARD = '/items/sinister_refinement_shard';
const RING_ORE = '/items/sinister_ore';
const MIRROR = '/items/philosophers_mirror';
const SWORD = '/items/cheese_sword';
const CHAR = 161296;

// Capes carry no `isTradable` at all; tradables carry `isTradable: true`
const ITEM_DETAIL_MAP = {
    [CAPE]: {
        hrid: CAPE,
        name: 'Sinister Cape ★',
        baseItemHrids: [BASE],
        equipmentDetail: { type: '/equipment_types/back' },
        enhancementCosts: [{ itemHrid: '/items/coin', count: 1000 }],
    },
    [BASE]: { hrid: BASE, name: 'Sinister Cape', equipmentDetail: { type: '/equipment_types/back' } },
    // A refined piece whose base is on the market, unlike the cape
    [RING]: {
        hrid: RING,
        name: 'Sinister Ring ★',
        baseItemHrids: [RING_BASE],
        equipmentDetail: { type: '/equipment_types/ring' },
        enhancementCosts: [{ itemHrid: '/items/coin', count: 1000 }],
    },
    [RING_BASE]: {
        hrid: RING_BASE,
        name: 'Sinister Ring',
        isTradable: true,
        equipmentDetail: { type: '/equipment_types/ring' },
        enhancementCosts: [{ itemHrid: '/items/coin', count: 10 }],
    },
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
    // The unrefined ring is crafted too, two to a batch: what a base with no +0 listing is priced from
    '/actions/crafting/sinister_ring': {
        hrid: '/actions/crafting/sinister_ring',
        inputItems: [
            { itemHrid: RING_ORE, count: 3 },
            { itemHrid: '/items/coin', count: 500 },
        ],
        outputItems: [{ itemHrid: RING_BASE, count: 2 }],
    },
    '/actions/crafting/sinister_ring_refined': {
        hrid: '/actions/crafting/sinister_ring_refined',
        upgradeItemHrid: RING_BASE,
        retainAllEnhancement: true,
        inputItems: [{ itemHrid: SHARD, count: 100 }],
        outputItems: [{ itemHrid: RING, count: 1 }],
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
    enhancementSweepParams: () => state.sweepParams,
}));
vi.mock('../enhancement/enhancement-params-source.js', () => ({ describeEnhancementSource: () => null }));
vi.mock('../../utils/profit-helpers.js', () => ({
    // Untaxed, as for an Iron Cow character: this suite is about which route a row is priced by, and its
    // figures are gross. The market sell tax on a resale is tested in upgrade-advisor.test.js
    calculatePriceAfterTax: (price) => price,
    outputTaxRate: () => 0,

    // A cape base with no listing: the craft estimate the ordinary +0 path returns
    resolveItemPrice: vi.fn((hrid, opts) => ({
        price:
            hrid === CAPE || hrid === RING
                ? state.starPrice
                : hrid === SHARD
                  ? 2_000_000
                  : hrid === BASE
                    ? opts?.side === 'sell'
                        ? state.baseSell
                        : 300_000
                    : hrid === MIRROR
                      ? state.mirrorPrice
                      : hrid === SWORD && opts?.side === 'sell'
                        ? state.swordSell
                        : 1,
    })),
}));
vi.mock('../../utils/market-data.js', () => ({
    // Every level of everything has an ask; a cape must never use one
    getItemPrices: vi.fn((hrid, level) => {
        if (state.noAsk) return null;
        return { ask: state.askFor ? state.askFor(hrid, level) : 999_000_000, bid: 1 };
    }),
}));
vi.mock('./skilling-sim-helpers.js', () => ({ buildOverridesForSkill: vi.fn() }));

const {
    calculateUpgradeCost,
    explainUpgradeCost,
    buildOtherLoadoutClaims,
    withLoadoutClaims,
    runLabyrinthAllFightsAnalysis,
} = await import('./upgrade-advisor.js');
const { buildGameDataPayload } = await import('./combat-sim-adapter.js');
const { runLabyrinthSimulation } = await import('./combat-sim-runner.js');

/** A row as the Lab's all-fights analysis prices it: carrying what its fights' loadouts wear */
const claimedBy = (row, fights) => withLoadoutClaims(row, buildOtherLoadoutClaims(fights));
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
    type: 'tier',
    upgradeHrid: CAPE,
    upgradeLevel: level,
    removedItems: [],
    ...extra,
});

describe('refined target priced from a held base', () => {
    beforeEach(() => {
        state.items = [];
        state.sweepParams = {};
        state.sweeps = [];
        state.shops = {};
        state.mirrorPrice = 1_000_000_000;
        state.noAsk = false;
        state.askFor = null;
        state.swordSell = 1;
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

    test('a base another loadout wears is refined at its resale, not free', () => {
        state.items = [stack(BASE, 5)];
        const row = claimedBy(tier(7), [
            { loadoutName: 'A', dto: { equipment: {} } },
            {
                loadoutName: 'B',
                dto: { equipment: { '/equipment_types/back': { hrid: BASE, enhancementLevel: 5 } } },
            },
        ]);
        expect(calculateUpgradeCost(row, gameData)).toBe(SHARDS + 2_000_000 + state.baseSell);
        // The same row without the claims is the old free refine
        expect(calculateUpgradeCost(tier(7), gameData)).toBe(SHARDS + 2_000_000);
    });

    test('two saved loadouts that share a name are told apart by id', () => {
        const wears = (level) => ({ equipment: { '/equipment_types/back': { hrid: BASE, enhancementLevel: level } } });
        const claims = buildOtherLoadoutClaims([
            { loadoutName: 'Lab', loadoutId: 1, dto: wears(5) },
            { loadoutName: 'Lab', loadoutId: 2, dto: wears(6) },
            { loadoutName: 'Lab', loadoutId: 2, dto: wears(6) },
        ]);
        expect(claims.get(`${BASE}@5`)).toBe(1);
        expect(claims.get(`${BASE}@6`)).toBe(1);
    });

    test('loadouts are alternatives: one copy serves every loadout wearing it, two slots in one need two', () => {
        const ring = '/items/test_ring';
        const claims = buildOtherLoadoutClaims([
            { loadoutId: 1, dto: { equipment: { '/equipment_types/back': { hrid: BASE, enhancementLevel: 5 } } } },
            { loadoutId: 2, dto: { equipment: { '/equipment_types/back': { hrid: BASE, enhancementLevel: 5 } } } },
            {
                loadoutId: 3,
                dto: {
                    equipment: {
                        '/equipment_types/ring': { hrid: ring, enhancementLevel: 3 },
                        '/equipment_types/earrings': { hrid: ring, enhancementLevel: 3 },
                    },
                },
            },
        ]);
        expect(claims.get(`${BASE}@5`)).toBe(1);
        expect(claims.get(`${ring}@3`)).toBe(2);
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
            // The shard stack to buy rides the ladder as structured data, for the row's Market button
            expect(detail.ladder.refine.materials).toEqual([{ itemHrid: SHARD, count: 100 }]);
        });

        test('a mirrored base with no held copies counts every mirror its built copies spend', () => {
            // Every level from +3 up is mirrored here, so the +7 is built from a built +6 and a built +5:
            // +3 spends 1, +4 2, +5 4, +6 7, and the +7 7 + 4 + its own 1 = 12
            const detail = explainUpgradeCost(tier(7), gameData);
            expect(detail.ladder.refine.mirror.mirrorCount).toBe(12);
            const ordinary = Array.from({ length: 8 }, (_, k) => 0.3 + (2 ** k - 1)).map((m) => m * 1e6);
            expect(cheapestWithMirror(ordinary, 1_000_000).mirrorTotalCounts[7]).toBe(12);
        });

        test('held inputs spend no mirrors of their own: spare +6 and +5 leave one', () => {
            state.items = [stack(BASE, 6), stack(BASE, 5)];
            expect(explainUpgradeCost(tier(7), gameData).ladder.refine.mirror.mirrorCount).toBe(1);
        });

        test('spare +6 and +5 bases are the mirror inputs of a refined +7: shards plus the mirror', () => {
            state.items = [stack(BASE, 6), stack(BASE, 5)];
            const detail = explainUpgradeCost(tier(7), gameData);
            expect(detail.buys[0]).toMatchObject({ source: 'refine', price: SHARDS + 1_000_000 });
            expect(detail.ladder.refine.mirror.heldLevels).toEqual([6, 5]);
        });

        describe('the base copies the route buys', () => {
            const ring = (level) => tier(level, { upgradeHrid: RING });
            // +6 is listed at 5M; every other level is the base plus a climb of (2^k - 1)M
            const listedSix = () => {
                state.askFor = (hrid, level) => (hrid === RING_BASE && level === 6 ? 5_000_000 : 0);
            };
            const boughtOf = (level) => explainUpgradeCost(ring(level), gameData).ladder.refine.mirror.boughtCopies;

            test('a listed +6 is bought at its level, the built +5 down to its base copies', () => {
                // +0 is listed as well as +6, so the +0 bases are bought off the market
                state.askFor = (hrid, level) => (hrid === RING_BASE && (level === 6 || level === 0) ? 5_000_000 : 0);
                const bought = boughtOf(7);
                // +5 is built from a +4 and a +3, each built in turn: five +0 bases stand under it
                expect(bought).toContainEqual({ itemHrid: RING_BASE, enhancementLevel: 0, count: 5 });
                expect(bought).toContainEqual({ itemHrid: RING_BASE, enhancementLevel: 6, count: 1 });
                // The +5 is built from cheaper copies, so no +5 is bought, only the +0 bases it stands on
                expect(bought.some((line) => line.enhancementLevel === 5)).toBe(false);
                expect(bought.find((line) => line.enhancementLevel === 0).count).toBeGreaterThan(0);
            });

            test('a +0 base with no listing is crafted: the bill is the recipe inputs, not a +0 base to buy', () => {
                listedSix();
                const bought = boughtOf(7);
                // Five bases stand under the built +5, two to a batch, three ore a batch: 3 whole batches use 9
                expect(bought).toContainEqual({ itemHrid: RING_ORE, enhancementLevel: 0, count: 9 });
                expect(bought).toContainEqual({ itemHrid: RING_BASE, enhancementLevel: 6, count: 1 });
                expect(bought.some((line) => line.itemHrid === RING_BASE && line.enhancementLevel === 0)).toBe(false);
                // Coins are not an item to buy
                expect(bought.some((line) => line.itemHrid === '/items/coin')).toBe(false);
            });

            test('a +0 base with no listing and no recipe leaves nothing to buy for it', () => {
                listedSix();
                const noRecipes = { itemDetailMap: ITEM_DETAIL_MAP, actionDetailMap: {} };
                const bought = explainUpgradeCost(ring(7), noRecipes).ladder.refine.mirror.boughtCopies;
                expect(bought).toEqual([{ itemHrid: RING_BASE, enhancementLevel: 6, count: 1 }]);
            });

            test('a held +6 is used, not bought', () => {
                listedSix();
                state.items = [stack(RING_BASE, 6)];
                expect(boughtOf(7).some((line) => line.enhancementLevel === 6)).toBe(false);
            });

            test('a cape base nobody lists has nothing to buy', () => {
                const detail = explainUpgradeCost(tier(7), gameData);
                expect(detail.ladder.refine.mirror.boughtCopies).toEqual([]);
            });
        });

        test('a dear mirror leaves the ordinary route alone', () => {
            state.mirrorPrice = 1_000_000_000;
            expect(explainUpgradeCost(tier(7), gameData).buys[0].source).toBe('enhance');
        });
    });

    describe('Philosophers Mirror for an ordinary (unrefined) target', () => {
        beforeEach(() => {
            state.climb = (from, to) => (2 ** to - 2 ** from) * 1_000_000;
            state.mirrorPrice = 1_000_000;
            state.noAsk = true;
        });
        const sword = (level) => ({ type: 'tier', upgradeHrid: SWORD, upgradeLevel: level, removedItems: [] });

        test('a tradable +7 with no listing is built from a +6 and a +5 copy', () => {
            const detail = explainUpgradeCost(sword(7), gameData);
            // The base is a bare 1 gold here; a climb to +k adds (2^k - 1)M
            const ordinary = Array.from({ length: 8 }, (_, k) => 1 + (2 ** k - 1) * 1e6);
            const { best } = cheapestWithMirror(ordinary, 1_000_000);
            expect(best[7]).toBeLessThan(ordinary[7]);
            expect(detail.buys[0]).toMatchObject({ source: 'mirror' });
            expect(detail.buys[0].price).toBeCloseTo(best[7], 0);
            expect(detail.ladder.mirror).toBeTruthy();
        });

        test('Blessed Tea shortens the mirror chain: a +2 success skips the next step', () => {
            const ordinary = Array.from({ length: 8 }, (_, k) => 1 + (2 ** k - 1) * 1e6);
            const plain = explainUpgradeCost(sword(7), gameData).buys[0].price;
            expect(plain).toBeCloseTo(cheapestWithMirror(ordinary, 1_000_000).best[7], 0);

            state.sweepParams = { teas: { blessed: true }, blessedTeaBonus: 0.3, guzzlingBonus: 1 };
            const blessed = explainUpgradeCost(sword(7), gameData).buys[0].price;
            expect(blessed).toBeCloseTo(cheapestWithMirror(ordinary, 1_000_000, 0.3).best[7], 0);
            expect(blessed).toBeLessThan(plain);
        });

        describe('held copies supply mirror inputs', () => {
            const ordinary = Array.from({ length: 9 }, (_, k) => 1 + (2 ** k - 1) * 1e6);
            const { best } = cheapestWithMirror(ordinary, 1_000_000);
            const wornSword = (level) => stack(SWORD, level, '/item_locations/main_hand');

            test('a worn +6 is the +6 input of its own +7 row: mirror plus a fresh +5, no resale', () => {
                state.swordSell = 5_000_000;
                state.items = [wornSword(6)];
                const detail = explainUpgradeCost(breakpoint(SWORD, 6, 7), gameData);
                expect(detail.source).toBe('mirror');
                expect(detail.buys[0].price).toBeCloseTo(best[5] + 1_000_000, 0);
                expect(detail.credit).toBe(0);
                expect(detail.net).toBeCloseTo(best[5] + 1_000_000, 0);
                expect(calculateUpgradeCost(breakpoint(SWORD, 6, 7), gameData)).toBeCloseTo(detail.net, 0);
                expect(detail.ladder.mirror.heldLevels).toEqual([6]);
                // Before: a fresh +6 and a fresh +5, less the 5M the worn +6 sells for
                expect(best[6] + best[5] + 1_000_000 - 5_000_000).toBeGreaterThan(detail.net);
            });

            test('a worn copy the row does not take off is not an input', () => {
                state.items = [wornSword(6)];
                const detail = explainUpgradeCost(sword(7), gameData);
                expect(detail.buys[0].price).toBeCloseTo(best[7], 0);
                expect(detail.ladder.mirror.heldLevels).toEqual([]);
            });

            test('a worn copy a swap replaces is an input and is not also sold', () => {
                state.swordSell = 5_000_000;
                state.items = [wornSword(6)];
                const swap = { ...sword(7), removedItems: [{ hrid: SWORD, enhancementLevel: 6 }] };
                const detail = explainUpgradeCost(swap, gameData);
                expect(detail.buys[0].price).toBeCloseTo(best[5] + 1_000_000, 0);
                expect(detail.credit).toBe(0);
                expect(calculateUpgradeCost(swap, gameData)).toBeCloseTo(best[5] + 1_000_000, 0);
            });

            test('a replaced piece in the bag (another loadout) is an input and is not also sold', () => {
                // The swap takes a +6 off a loadout that is not the one equipped, so the copy is in the bag
                state.swordSell = 5_000_000;
                state.items = [stack(SWORD, 6)];
                const swap = { ...sword(7), removedItems: [{ hrid: SWORD, enhancementLevel: 6 }] };
                const detail = explainUpgradeCost(swap, gameData);
                expect(detail.buys[0].price).toBeCloseTo(best[5] + 1_000_000, 0);
                expect(detail.credit).toBe(0);
                expect(calculateUpgradeCost(swap, gameData)).toBeCloseTo(best[5] + 1_000_000, 0);

                // A second copy at that level is a real spare: one is spent, the other is sold
                state.items = [stack(SWORD, 6, '/item_locations/inventory', 2)];
                const two = explainUpgradeCost(swap, gameData);
                expect(two.buys[0].price).toBeCloseTo(best[5] + 1_000_000, 0);
                expect(two.credit).toBe(5_000_000);
            });

            describe('a copy another loadout wears', () => {
                // Loadout B is not equipped, so its +6 sword sits in the bag; the Lab knows B from the fights
                const fightsWhereBWears = (level) => [
                    { loadoutName: 'A', dto: { equipment: {} } },
                    {
                        loadoutName: 'B',
                        dto: { equipment: { '/equipment_types/main_hand': { hrid: SWORD, enhancementLevel: level } } },
                    },
                ];

                test('is an input at its resale, not free', () => {
                    state.swordSell = 5_000_000;
                    state.items = [stack(SWORD, 6)];
                    const row = claimedBy(sword(7), fightsWhereBWears(6));
                    const detail = explainUpgradeCost(row, gameData);
                    expect(detail.source).toBe('mirror');
                    expect(detail.buys[0].price).toBeCloseTo(best[5] + 1_000_000 + 5_000_000, 0);
                    expect(calculateUpgradeCost(row, gameData)).toBeCloseTo(detail.net, 0);
                });

                test('a spare beyond the claimed copies stays free', () => {
                    state.swordSell = 5_000_000;
                    state.items = [stack(SWORD, 6, '/item_locations/inventory', 2)];
                    const detail = explainUpgradeCost(claimedBy(sword(7), fightsWhereBWears(6)), gameData);
                    expect(detail.buys[0].price).toBeCloseTo(best[5] + 1_000_000, 0);
                });

                test('a stack larger than the ladder sees keeps its surplus free', () => {
                    // Three +6 swords in one stack, two loadouts wearing a +6: the third copy is a real spare
                    state.swordSell = 5_000_000;
                    state.items = [stack(SWORD, 6, '/item_locations/inventory', 3)];
                    const wears = (name) => ({
                        loadoutName: name,
                        dto: { equipment: { '/equipment_types/main_hand': { hrid: SWORD, enhancementLevel: 6 } } },
                    });
                    const row = claimedBy(sword(7), [wears('B'), wears('C')]);
                    const detail = explainUpgradeCost(row, gameData);
                    expect(detail.buys[0].price).toBeCloseTo(best[5] + 1_000_000, 0);
                    // Loadouts are alternatives: three wearing a +6 still need just one copy between them
                    const all = claimedBy(sword(7), [wears('B'), wears('C'), wears('D')]);
                    expect(explainUpgradeCost(all, gameData).buys[0].price).toBeCloseTo(best[5] + 1_000_000, 0);
                });

                test('a checked swap priced before the claims existed is priced again with them', async () => {
                    state.swordSell = 5_000_000;
                    state.items = [stack(SWORD, 6)];
                    // A sword a loadout can feel: it needs combat stats to be a candidate at all
                    const armed = {
                        ...ITEM_DETAIL_MAP,
                        [SWORD]: {
                            ...ITEM_DETAIL_MAP[SWORD],
                            equipmentDetail: {
                                type: '/equipment_types/main_hand',
                                combatStats: { slashDamage: 10 },
                            },
                        },
                    };
                    buildGameDataPayload.mockReturnValue({ actionDetailMap: {}, itemDetailMap: armed });
                    runLabyrinthSimulation.mockResolvedValue({ labyAttemptCount: 100, encounters: 50 });
                    const dto = (level) => ({
                        equipment: { '/equipment_types/main_hand': { hrid: SWORD, enhancementLevel: level } },
                        staminaLevel: 50,
                        meleeLevel: 50,
                    });
                    // As buildCombatSwapCandidate hands it over: costed once, with no claims in sight
                    const swap = {
                        ...sword(7),
                        slot: '/equipment_types/main_hand',
                        currentHrid: SWORD,
                        currentLevel: 3,
                        removedItems: [],
                        checkedSwap: true,
                        allLoadouts: true,
                        isSelf: true,
                    };
                    swap.cost = calculateUpgradeCost(swap, gameData);
                    expect(swap.cost).toBeCloseTo(best[5] + 1_000_000, 0);
                    const { results } = await runLabyrinthAllFightsAnalysis(
                        {
                            fights: [
                                { monsterHrid: '/monsters/goblin', monsterName: 'Goblin', roomLevel: 100, dto: dto(3) },
                                { monsterHrid: '/monsters/wisp', monsterName: 'Wisp', roomLevel: 110, dto: dto(6) },
                            ],
                            crates: [],
                            hours: 1,
                            communityBuffs: {},
                            labyrinthCombatBuffs: [],
                            modes: [],
                            extraCandidates: [swap],
                        },
                        null,
                        {}
                    );
                    const row = results.find((r) => r.candidate.checkedSwap);
                    // The bag +6 is the wisp loadout's: using it forfeits its resale
                    expect(row.costDetail.buys[0].price).toBeCloseTo(best[5] + 1_000_000 + 5_000_000, 0);
                    expect(row.cost).toBeCloseTo(row.costDetail.net, 0);
                });

                test('the copy one loadout wears while equipped also serves another loadout', () => {
                    // A wears the +6 right now (equipped); B wears one too, but loadouts are alternatives, so the
                    // equipped copy serves both and the bag copy is a free spare
                    state.swordSell = 5_000_000;
                    state.items = [wornSword(6), stack(SWORD, 6)];
                    const row = claimedBy(sword(7), [
                        {
                            loadoutName: 'A',
                            dto: { equipment: { '/equipment_types/main_hand': { hrid: SWORD, enhancementLevel: 6 } } },
                        },
                        fightsWhereBWears(6)[1],
                    ]);
                    const detail = explainUpgradeCost(row, gameData);
                    expect(detail.buys[0].price).toBeCloseTo(best[5] + 1_000_000, 0);
                });

                test('nothing is claimed outside an analysis, even while one is in flight', async () => {
                    state.swordSell = 5_000_000;
                    state.items = [stack(SWORD, 6)];
                    const inFlight = claimedBy(sword(7), fightsWhereBWears(6));
                    const price = (row) => explainUpgradeCost(row, gameData).buys[0].price;
                    expect(price(inFlight)).toBeCloseTo(best[5] + 1_000_000 + 5_000_000, 0);
                    await Promise.resolve();
                    // A plain row priced between the analysis's awaits carries no claims
                    expect(price(sword(7))).toBeCloseTo(best[5] + 1_000_000, 0);
                    expect(price(inFlight)).toBeCloseTo(best[5] + 1_000_000 + 5_000_000, 0);
                });

                test('two analyses with different loadouts, interleaved, price only their own claims', async () => {
                    state.swordSell = 5_000_000;
                    state.items = [stack(SWORD, 6), stack(SWORD, 5)];
                    const a = claimedBy(sword(7), fightsWhereBWears(6));
                    const b = claimedBy(sword(7), fightsWhereBWears(4));
                    const price = (row) => explainUpgradeCost(row, gameData).buys[0].price;
                    // Start A, start B, let A finish, then B: neither run's claims reach the other's rows
                    const aFirst = price(a);
                    await Promise.resolve();
                    const bFirst = price(b);
                    await Promise.resolve();
                    const aLast = price(a);
                    const bLast = price(b);
                    expect(aFirst).toBeCloseTo(aLast, 0);
                    expect(bFirst).toBeCloseTo(bLast, 0);
                    // A claims the bag +6, B wears something else: only A pays its resale
                    expect(aFirst).not.toBeCloseTo(bFirst, 0);
                    expect(price(sword(7))).toBe(1_000_000);
                });
            });

            test('a spare +6 and a spare +5 together leave only the mirror to buy', () => {
                state.items = [stack(SWORD, 6), stack(SWORD, 5)];
                const detail = explainUpgradeCost(sword(7), gameData);
                expect(detail.buys[0].price).toBe(1_000_000);
            });

            test('Blessed Tea: a worn lower input is spent only when the step runs, the rest is still sold', () => {
                state.sweepParams = { teas: { blessed: true }, blessedTeaBonus: 0.5, guzzlingBonus: 1 };
                state.swordSell = 2_000_000;
                state.items = [wornSword(5)];
                const swap = { ...sword(7), removedItems: [{ hrid: SWORD, enhancementLevel: 5 }] };
                const { best, landing } = cheapestWithMirror(ordinary, 1_000_000, 0.5);
                const share = landing[6];
                expect(share).toBeLessThan(1);
                const detail = explainUpgradeCost(swap, gameData);
                expect(detail.buys[0].price).toBeCloseTo(best[6] + share * 1_000_000, 0);
                // Only the share the step spends is forfeited; the remainder is credited
                expect(detail.credit).toBeCloseTo((1 - share) * 2_000_000, 0);
                expect(detail.credit).toBeGreaterThan(0);
                expect(calculateUpgradeCost(swap, gameData)).toBeCloseTo(detail.net, 0);
            });

            test('one spare serves one input: a lone +5 for a +7 still buys the +6', () => {
                state.items = [stack(SWORD, 5)];
                const detail = explainUpgradeCost(sword(7), gameData);
                expect(detail.buys[0].price).toBeCloseTo(best[6] + 1_000_000, 0);
            });
        });

        test('a self-enhanced cape +7 is mirrored too', () => {
            const detail = explainUpgradeCost(tier(7, { upgradeHrid: BASE }), gameData);
            expect(detail.buys[0].source).toBe('mirror');
        });

        // The generator's "next breakpoint" row: the worn piece, enhanced in place
        const breakpoint = (hrid, from, to) => ({
            type: 'enhancement',
            currentHrid: hrid,
            currentLevel: from,
            upgradeHrid: hrid,
            upgradeLevel: to,
        });

        test('an enhancement row on a tradable piece weighs a mirror build against the enhance', () => {
            const candidate = breakpoint(SWORD, 6, 7);
            const detail = explainUpgradeCost(candidate, gameData);
            expect(detail.source).toBe('mirror');
            expect(detail.net).toBeLessThan(64_000_000);
            expect(calculateUpgradeCost(candidate, gameData)).toBe(detail.net);
            expect(detail.ladder.mirror).toBeTruthy();
        });

        test('an enhancement row on worn refined gear mirrors the refined +(L-1) with a base +(L-2)', () => {
            // The worn star cape is the +6 the mirror runs on; the other input is an unrefined base +5
            state.items = [stack(CAPE, 6, '/item_locations/back')];
            const candidate = breakpoint(CAPE, 6, 7);
            const ordinaryBase = Array.from({ length: 6 }, (_, k) => 300_000 + (2 ** k - 1) * 1e6);
            const { best } = cheapestWithMirror(ordinaryBase, 1_000_000);
            const detail = explainUpgradeCost(candidate, gameData);
            expect(detail.source).toBe('mirror');
            expect(detail.net).toBeCloseTo(best[5] + 1_000_000, 0);
            expect(detail.credit).toBe(0);
            expect(calculateUpgradeCost(candidate, gameData)).toBeCloseTo(detail.net, 0);
        });

        test('a claimed base copy is not picked over a free duplicate for the mirror input', () => {
            // Two bare +5 bases in the bag; a loadout that is not equipped wears one of them
            state.items = [stack(CAPE, 6, '/item_locations/back'), stack(BASE, 5, '/item_locations/inventory', 2)];
            const row = claimedBy(breakpoint(CAPE, 6, 7), [
                { loadoutName: 'A', loadoutId: 1, dto: { equipment: {} } },
                {
                    loadoutName: 'B',
                    loadoutId: 2,
                    dto: { equipment: { '/equipment_types/back': { hrid: BASE, enhancementLevel: 5 } } },
                },
            ]);
            const detail = explainUpgradeCost(row, gameData);
            expect(detail.source).toBe('mirror');
            // The free duplicate is the input: the mirror alone, no resale of the claimed copy
            expect(detail.net).toBeCloseTo(1_000_000, 0);
        });

        test('refined gear one level short of the mirror input enhances up to it first', () => {
            state.items = [stack(CAPE, 4, '/item_locations/back')];
            const ordinaryBase = Array.from({ length: 6 }, (_, k) => 300_000 + (2 ** k - 1) * 1e6);
            const { best } = cheapestWithMirror(ordinaryBase, 1_000_000);
            // +4 to the +6 input costs 2^6 - 2^4 = 48M, then the base +5 and the mirror
            const detail = explainUpgradeCost(breakpoint(CAPE, 4, 7), gameData);
            expect(detail.source).toBe('mirror');
            expect(detail.net).toBeCloseTo(48_000_000 + best[5] + 1_000_000, 0);
        });

        test('Blessed Tea: an enhance that overshoots onto +L never needs the base copy or the mirror', () => {
            state.sweepParams = { teas: { blessed: true }, blessedTeaBonus: 0.5, guzzlingBonus: 1 };
            state.items = [stack(CAPE, 4, '/item_locations/back')];
            const ordinaryBase = Array.from({ length: 6 }, (_, k) => 300_000 + (2 ** k - 1) * 1e6);
            const { best } = cheapestWithMirror(ordinaryBase, 1_000_000, 0.5);
            // +4 to the +6 input is 48M; its last step is a +2 half the time (given the chain stood on +5,
            // also half the time), leaving the other 75% to run the base copy and the mirror
            const detail = explainUpgradeCost(breakpoint(CAPE, 4, 7), gameData);
            expect(detail.source).toBe('mirror');
            expect(detail.net).toBeCloseTo(48_000_000 + 0.75 * (best[5] + 1_000_000), 0);
        });

        test('refined gear gets no mirror route when the mirror is dear', () => {
            state.mirrorPrice = 1_000_000_000;
            state.items = [stack(CAPE, 6, '/item_locations/back')];
            expect(explainUpgradeCost(breakpoint(CAPE, 6, 7), gameData).source).not.toBe('mirror');
        });

        test('an enhancement row on a worn cape weighs a mirror build too', () => {
            state.items = [stack(BASE, 6, '/item_locations/back')];
            expect(explainUpgradeCost(breakpoint(BASE, 6, 7), gameData).source).toBe('mirror');
        });

        test('an enhancement row keeps the enhance when the mirror is dear or the step is small', () => {
            expect(explainUpgradeCost(breakpoint(SWORD, 1, 2), gameData).source).toBe('sim');
            state.mirrorPrice = 1_000_000_000;
            expect(explainUpgradeCost(breakpoint(SWORD, 6, 7), gameData).source).toBe('sim');
            expect(calculateUpgradeCost(breakpoint(SWORD, 6, 7), gameData)).toBe(64_000_000);
        });

        test('a 312B bid on the replaced piece cannot take a mirror-built row below free', () => {
            state.swordSell = 312_000_000_000;
            const enhancement = breakpoint(SWORD, 6, 7);
            expect(explainUpgradeCost(enhancement, gameData).source).toBe('mirror');
            // The cap is named, so the cell reads capped and not genuinely free
            const capped = explainUpgradeCost(enhancement, gameData);
            expect(capped).toMatchObject({ creditCapped: true, rawCredit: 312_000_000_000 });
            expect(capped.credits[0]).toMatchObject({ price: capped.credit, rawPrice: 312_000_000_000 });
            expect(explainUpgradeCost(enhancement, gameData).net).toBeGreaterThanOrEqual(0);
            expect(calculateUpgradeCost(enhancement, gameData)).toBeGreaterThanOrEqual(0);

            const swap = {
                type: 'tier',
                upgradeHrid: SWORD,
                upgradeLevel: 7,
                removedItems: [{ hrid: SWORD, enhancementLevel: 6 }],
            };
            const detail = explainUpgradeCost(swap, gameData);
            expect(detail.buys[0].source).toBe('mirror');
            expect(detail.net).toBeGreaterThanOrEqual(0);
            expect(calculateUpgradeCost(swap, gameData)).toBeGreaterThanOrEqual(0);
            expect(detail).toMatchObject({ creditCapped: true, rawCredit: 312_000_000_000 });
            expect(detail.credits[0]).toMatchObject({ price: detail.credit, rawPrice: 312_000_000_000 });
        });

        test('a tier swap keeps a quoted buy when its resale makes the quote the cheaper net', () => {
            // Only the +7 is listed, at 210M; the lower levels are climbed. A mirror build is about 41M
            // gross, but the +6 being replaced sells for 300M: a quote keeps that whole credit (net
            // -90M) while a build's credit is capped at its spend (net 0).
            state.noAsk = false;
            state.askFor = (hrid, level) => (hrid === SWORD && level === 7 ? 210_000_000 : 0);
            state.swordSell = 300_000_000;
            const swap = {
                type: 'tier',
                upgradeHrid: SWORD,
                upgradeLevel: 7,
                removedItems: [{ hrid: SWORD, enhancementLevel: 6 }],
            };
            const detail = explainUpgradeCost(swap, gameData);
            expect(detail.buys[0]).toMatchObject({ source: 'market', price: 210_000_000 });
            expect(detail.net).toBe(-90_000_000);
            expect(calculateUpgradeCost(swap, gameData)).toBe(-90_000_000);

            // Sold for little, the same build is the cheaper net
            state.swordSell = 1_000_000;
            expect(explainUpgradeCost(swap, gameData).buys[0].source).toBe('mirror');
        });

        test('a tier swap keeps a sweep-priced buy when its resale makes it the cheaper net, short of an outlier bid', () => {
            // No listing: the +7 is a 127M climb. A mirror build is about 41M gross and nets 0 (credit
            // capped at its spend); the climb nets 127M - 150M = -23M with the 150M bid kept whole.
            state.noAsk = true;
            state.swordSell = 150_000_000;
            const swap = {
                type: 'tier',
                upgradeHrid: SWORD,
                upgradeLevel: 7,
                removedItems: [{ hrid: SWORD, enhancementLevel: 6 }],
            };
            const detail = explainUpgradeCost(swap, gameData);
            expect(detail.buys[0].source).toBe('sim');
            expect(detail.net).toBeCloseTo(-23_000_000 + 1, 0);
            expect(calculateUpgradeCost(swap, gameData)).toBeCloseTo(detail.net, 0);

            // Past twice the spend the bid is an outlier: the build wins and the row cannot go negative
            state.swordSell = 312_000_000_000;
            const outlier = explainUpgradeCost(swap, gameData);
            expect(outlier.buys[0].source).toBe('mirror');
            expect(outlier.net).toBeGreaterThanOrEqual(0);
        });

        test('below +3 a mirror cannot run, and a dear mirror changes nothing', () => {
            expect(explainUpgradeCost(sword(2), gameData).buys[0].source).toBe('sim');
            state.mirrorPrice = 1_000_000_000;
            expect(explainUpgradeCost(sword(7), gameData).buys[0].source).toBe('sim');
        });
    });

    describe('review follow-ups', () => {
        beforeEach(() => {
            state.climb = (from, to) => (2 ** to - 2 ** from) * 1_000_000;
            state.mirrorPrice = 1_000_000;
        });

        test('one held copy is not both inputs of a mirror: a lone +4 cape to +5 supplies one input only', () => {
            state.items = [stack(BASE, 4)];
            const detail = explainUpgradeCost(tier(5, { upgradeHrid: BASE }), gameData);
            // The +4 is the +(L-1) input; the +3 is bought fresh (5.6M, itself mirrored from a +2 and a
            // +1) with a 1M mirror. Counting the +4 for both inputs would have made this the mirror alone.
            expect(detail.buys[0]).toMatchObject({ source: 'mirror', price: 6_600_000 });
            expect(detail.buys[0].price).toBeGreaterThan(state.mirrorPrice);
        });

        test('a worn and a spare base of the same level: the spare is the one refined', () => {
            state.mirrorPrice = 1_000_000_000;
            state.items = [stack(BASE, 7, '/item_locations/back'), stack(BASE, 7)];
            const candidate = tier(7, { currentHrid: BASE, currentLevel: 7, removedItems: undefined });
            const detail = explainUpgradeCost(candidate, gameData);
            expect(detail.ladder).toMatchObject({ fromLevel: 7, fromEquipped: false });
            expect(detail.credit).toBe(state.baseSell);
        });

        test('a replaced base in the bag (another loadout) is refined as it stands, not also sold', () => {
            state.mirrorPrice = 1_000_000_000;
            state.items = [stack(BASE, 7)];
            const candidate = tier(7, { currentHrid: BASE, currentLevel: 7, removedItems: undefined });
            const detail = explainUpgradeCost(candidate, gameData);
            expect(detail.buys[0].source).toBe('refine');
            expect(detail.credit).toBe(0);
            expect(detail.net).toBe(SHARDS);
            expect(calculateUpgradeCost(candidate, gameData)).toBe(SHARDS);
        });

        test('a mirrored base beats refining the worn one when the worn base sells for enough', () => {
            // Worn refine: 200M shards, 300M with the 100M the base would sell for. A mirrored base:
            // 200M shards + about 45M of copies.
            state.baseSell = 100_000_000;
            state.items = [stack(BASE, 7, '/item_locations/back')];
            const candidate = tier(7, { currentHrid: BASE, currentLevel: 7, removedItems: undefined });
            const detail = explainUpgradeCost(candidate, gameData);
            expect(detail.ladder.refine.mirror).toBeTruthy();
            expect(detail.credit).toBe(100_000_000);
        });

        test('a refined route whose credit is capped says so, not that it is free', () => {
            state.swordSell = 312_000_000_000;
            const swap = tier(7, { removedItems: [{ hrid: SWORD, enhancementLevel: 6 }] });
            const detail = explainUpgradeCost(swap, gameData);
            expect(detail.buys[0].source).toBe('refine');
            expect(detail.net).toBe(0);
            expect(detail).toMatchObject({ creditCapped: true, rawCredit: 312_000_000_000 });
            expect(detail.credit).toBe(detail.gross);
            expect(detail.credits[0]).toMatchObject({ price: detail.gross, rawPrice: 312_000_000_000 });
        });

        test('a quoted buy keeps its uncapped credit and sets no cap flag', () => {
            state.swordSell = 5_000_000;
            state.askFor = () => 1_000_000;
            const swap = { type: 'tier', upgradeHrid: SWORD, upgradeLevel: 7, removedItems: [] };
            expect(explainUpgradeCost(swap, gameData).creditCapped).toBeUndefined();
        });

        test('a cheap worn base is still refined as it stands', () => {
            state.items = [stack(BASE, 7, '/item_locations/back')];
            const candidate = tier(7, { currentHrid: BASE, currentLevel: 7, removedItems: undefined });
            expect(explainUpgradeCost(candidate, gameData).ladder.refine.mirror).toBeUndefined();
        });
    });
});
