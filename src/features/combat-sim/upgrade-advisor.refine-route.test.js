/**
 * Refined (star) targets in the upgrade advisor: a held base copy is refined, not re-enhanced from a fresh base.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

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
const SHARD = '/items/sinister_refinement_shard';
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
    enhancementSweepParams: () => state.sweepParams,
}));
vi.mock('../enhancement/enhancement-params-source.js', () => ({ describeEnhancementSource: () => null }));
vi.mock('../../utils/profit-helpers.js', () => ({
    // A cape base with no listing: the craft estimate the ordinary +0 path returns
    resolveItemPrice: vi.fn((hrid, opts) => ({
        price:
            hrid === CAPE
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

        test('spare +6 and +5 bases are the mirror inputs of a refined +7: shards plus the mirror', () => {
            state.items = [stack(BASE, 6), stack(BASE, 5)];
            const detail = explainUpgradeCost(tier(7), gameData);
            expect(detail.buys[0]).toMatchObject({ source: 'refine', price: SHARDS + 1_000_000 });
            expect(detail.ladder.refine.mirror.heldLevels).toEqual([6, 5]);
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

        test('refined gear one level short of the mirror input enhances up to it first', () => {
            state.items = [stack(CAPE, 4, '/item_locations/back')];
            const ordinaryBase = Array.from({ length: 6 }, (_, k) => 300_000 + (2 ** k - 1) * 1e6);
            const { best } = cheapestWithMirror(ordinaryBase, 1_000_000);
            // +4 to the +6 input costs 2^6 - 2^4 = 48M, then the base +5 and the mirror
            const detail = explainUpgradeCost(breakpoint(CAPE, 4, 7), gameData);
            expect(detail.source).toBe('mirror');
            expect(detail.net).toBeCloseTo(48_000_000 + best[5] + 1_000_000, 0);
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
