/**
 * Queued alchemy rows: what they are timed, priced and costed at.
 *
 * - Level efficiency is measured from the alchemized item's level, as the action bar and the
 *   alchemy calculator measure it, not from the alchemy action's own requirement of 1.
 * - The row is priced with the queued action's own catalyst, not whichever catalyst the open
 *   alchemy panel shows.
 * - A catalyst is spent on every success, at the rate the game quotes with that catalyst
 *   (Mooberry Donut coinify 74.2% with tea, 91.7% with Prime), not at the bare base rate.
 * - A transmute that hands its own input back runs on the returned copies, so its input stack
 *   buys more attempts than it holds.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    actionDetails: {},
    itemDetails: {},
    statsCalls: [],
    calcCalls: [],
}));

vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentActions: () => [],
        getActionDetails: (hrid) => game.actionDetails[hrid] ?? null,
        getItemDetails: (hrid) => game.itemDetails[hrid] ?? null,
        getInventory: () => [],
        getInitClientData: () => ({ itemDetailMap: game.itemDetails }),
        getActionDrinkSlots: () => [],
        getElapsedSecondsInCurrentUnit: () => 0,
        getSkills: () => [],
        getEquipment: () => [],
        on: () => () => {},
    },
}));

vi.mock('../../utils/action-calculator.js', () => ({
    calculateActionStats: (_details, options) => {
        game.statsCalls.push(options);
        return { actionTime: 10, totalEfficiency: 0 };
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => key === 'actionQueue',
        getSettingValue: (_key, fallback) => fallback,
        COLOR_TOOLTIP_INFO: '#abc',
    },
}));

vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, getPrice: () => null, on: () => () => {} },
}));

vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: async () => null }));
vi.mock('../market/profit-calculator.js', () => ({ default: { calculate: async () => null } }));
vi.mock('../enhancement/enhancement-xp.js', () => ({ calculateEnhancementPredictions: () => null }));

// The calculator's success-rate arithmetic, with a tea worth 6% — the figure behind the live
// panel's 74.2% / 91.7% (coinify) and 53% / 65.5% (Gatherer Cape ★ transmute)
const TEA_BONUS = 0.06;
vi.mock('../market/alchemy-profit-calculator.js', () => ({
    default: {
        baseSuccessRateFor: (type, itemDetails) =>
            type === 'coinify'
                ? 0.7
                : type === 'decompose'
                  ? 0.6
                  : type === 'transmute'
                    ? itemDetails?.alchemyDetail?.transmuteSuccessRate || 0
                    : 0,
        catalystSuccessBonus: (hrid) => (!hrid ? 0 : hrid === '/items/prime_catalyst' ? 0.25 : 0.15),
        getUnderLevelPenalty: () => 0,
        calculateSuccessRateBreakdown: (base, catalyst, tea, penalty) => ({
            total: Math.min(1, base * (1 + catalyst + penalty + (tea ?? TEA_BONUS))),
        }),
        calculateCoinifyProfit: (...args) => {
            game.calcCalls.push(['coinify', ...args]);
            return null;
        },
        calculateDecomposeProfit: (...args) => {
            game.calcCalls.push(['decompose', ...args]);
            return null;
        },
        calculateTransmuteProfit: (...args) => {
            game.calcCalls.push(['transmute', ...args]);
            return null;
        },
        calculateUnrefineProfit: (...args) => {
            game.calcCalls.push(['unrefine', ...args]);
            return { profitPerHour: 36_000, actionsPerHour: 360, revenuePerHour: 72_000, successRate: 1 };
        },
    },
}));

const { default: actionTimeDisplay } = await import('./action-time-display.js');

const DONUT = '/items/mooberry_donut';
const CAPE = '/items/gatherer_cape_refined';
const CHANCE_CAPE = '/items/chance_cape_refined';
const PRIME = '/items/prime_catalyst';
const COIN = '/items/coin';
/** Transmute bills a coin fee per attempt; enough coins that it never binds */
const PURSE = { itemHrid: COIN, count: 1e12, enhancementLevel: 0, itemLocationHrid: '/item_locations/inventory' };
const COINIFY = '/actions/alchemy/coinify';
const TRANSMUTE = '/actions/alchemy/transmute';
const UNREFINE = '/actions/alchemy/unrefine';

const hashFor = (itemHrid, level = 0) => `char1::/item_locations/inventory::${itemHrid}::${level}`;

/** An inventory row in the one location the lookup counts */
function stack(itemHrid, count) {
    return { itemHrid, count, enhancementLevel: 0, itemLocationHrid: '/item_locations/inventory' };
}

/** A queued alchemy action, the shape `characterActions` carries */
function queued(id, actionHrid, itemHrid, { maxCount, catalyst } = {}) {
    return {
        id,
        ordinal: id,
        actionHrid,
        primaryItemHash: hashFor(itemHrid),
        secondaryItemHash: catalyst ? hashFor(catalyst) : '',
        hasMaxCount: maxCount !== undefined,
        maxCount: maxCount ?? 0,
        currentCount: 0,
    };
}

beforeEach(() => {
    game.statsCalls = [];
    game.calcCalls = [];
    game.itemDetails = {
        [DONUT]: {
            hrid: DONUT,
            name: 'Mooberry Donut',
            itemLevel: 45,
            sellPrice: 150,
            alchemyDetail: { bulkMultiplier: 1, isCoinifiable: true },
        },
        [CAPE]: {
            hrid: CAPE,
            name: 'Gatherer Cape ★',
            itemLevel: 90,
            alchemyDetail: {
                bulkMultiplier: 1,
                transmuteSuccessRate: 0.5,
                transmuteDropTable: [
                    { itemHrid: CAPE, dropRate: 0.25, minCount: 1, maxCount: 1 },
                    { itemHrid: CHANCE_CAPE, dropRate: 0.75, minCount: 1, maxCount: 1 },
                ],
            },
        },
        [PRIME]: { hrid: PRIME, name: 'Prime Catalyst', itemLevel: 1 },
    };
    game.actionDetails = {
        [COINIFY]: {
            hrid: COINIFY,
            name: 'Coinify',
            type: '/action_types/alchemy',
            coinCost: 0,
            levelRequirement: { skillHrid: '/skills/alchemy', level: 1 },
        },
        [TRANSMUTE]: {
            hrid: TRANSMUTE,
            name: 'Transmute',
            type: '/action_types/alchemy',
            coinCost: 0,
            levelRequirement: { skillHrid: '/skills/alchemy', level: 1 },
        },
        [UNREFINE]: {
            hrid: UNREFINE,
            name: 'Unrefine',
            type: '/action_types/alchemy',
            coinCost: 0,
            levelRequirement: { skillHrid: '/skills/alchemy', level: 1 },
        },
    };
});

describe('a queued alchemy row is timed from the item it alchemizes', () => {
    test('level efficiency is measured from the item level, not the action requirement of 1', () => {
        const lookup = actionTimeDisplay.buildInventoryLookup([stack(DONUT, 100)]);
        const action = queued(1, COINIFY, DONUT);

        actionTimeDisplay.calculateSingleQueueActionTime(action, game.actionDetails[COINIFY], lookup);

        expect(game.statsCalls.at(-1).levelRequirementOverride).toBe(45);
    });

    test('a non-alchemy action keeps its own requirement', () => {
        expect(actionTimeDisplay.alchemyLevelRequirement({ type: '/action_types/cooking' }, null)).toBeUndefined();
    });
});

describe('a queued alchemy row is priced with its own catalyst', () => {
    test('transmute passes the queued Prime Catalyst rather than reading the open panel', () => {
        actionTimeDisplay.calculateAlchemyProfitForAction(queued(1, TRANSMUTE, CAPE, { catalyst: PRIME }));
        expect(game.calcCalls).toEqual([['transmute', CAPE, true, null, 'prime']]);
    });

    test('a row with no catalyst says none, so an open panel’s catalyst is not borrowed', () => {
        actionTimeDisplay.calculateAlchemyProfitForAction(queued(1, TRANSMUTE, CAPE));
        expect(game.calcCalls[0][4]).toBe('none');
    });

    test('coinify hands the calculator the queued catalyst as its sixth argument', () => {
        actionTimeDisplay.calculateAlchemyProfitForAction(queued(1, COINIFY, DONUT, { catalyst: PRIME }));
        expect(game.calcCalls).toEqual([['coinify', DONUT, 0, true, null, null, 'prime']]);
    });

    test('an Unrefine row is priced instead of left blank', () => {
        const profit = actionTimeDisplay.calculateAlchemyProfitForAction(queued(1, UNREFINE, CAPE));
        expect(profit.profitPerHour).toBe(36_000);
    });

    test('an Unrefine row says why it has no experience figure', () => {
        const xp = actionTimeDisplay.alchemyRowXp(queued(1, UNREFINE, CAPE), 10);
        expect(xp.perHour).toBeNull();
        expect(xp.reason).toContain('Unrefine');
    });
});

describe('the catalyst is costed at the rate the catalyst itself gives', () => {
    test('Prime Catalyst coinify: 917 catalysts pay for 1,000 attempts at 91.7%, not 1,310 at 70%', () => {
        const lookup = actionTimeDisplay.buildInventoryLookup([stack(DONUT, 100_000), stack(PRIME, 917)]);
        const action = queued(1, COINIFY, DONUT, { catalyst: PRIME });

        const row = actionTimeDisplay.calculateSingleQueueActionTime(action, game.actionDetails[COINIFY], lookup);

        expect(row.materialLimit).toBe(1000);
        expect(row.limitType).toBe(`material:${PRIME}`);
    });

    test('the ledger spends the same draw the limit charged', () => {
        const lookup = actionTimeDisplay.buildInventoryLookup([stack(DONUT, 100_000), stack(PRIME, 2000)]);
        const action = queued(1, COINIFY, DONUT, { maxCount: 1000, catalyst: PRIME });

        actionTimeDisplay.deductQueueActionMaterials(lookup, game.actionDetails[COINIFY], action, {
            count: 1000,
            isTrulyInfinite: false,
        });

        expect(lookup.byHrid[PRIME]).toBeCloseTo(2000 - 917, 6);
    });
});

describe('a transmute’s input lasts through its own self-returns', () => {
    // 53% success × 25% self-return: each attempt uses 1 − 0.1325 = 0.8675 capes on average
    const NET_PER_ATTEMPT = 1 - 0.53 * 0.25;

    test('an endless row on 100 capes runs 115 expected attempts, marked as an estimate', () => {
        const lookup = actionTimeDisplay.buildInventoryLookup([stack(CAPE, 100), PURSE]);
        const row = actionTimeDisplay.calculateSingleQueueActionTime(
            queued(1, TRANSMUTE, CAPE),
            game.actionDetails[TRANSMUTE],
            lookup
        );

        expect(row.materialLimit).toBe(Math.floor(100 / NET_PER_ATTEMPT));
        expect(row.materialLimit).toBe(115);
        expect(row.materialLimitIsEstimated).toBe(true);
    });

    test('the action bar keeps the input-count floor', () => {
        const lookup = actionTimeDisplay.buildInventoryLookup([stack(CAPE, 100), PURSE]);
        const limit = actionTimeDisplay.calculateMaterialLimit(
            game.actionDetails[TRANSMUTE],
            lookup,
            0,
            queued(1, TRANSMUTE, CAPE),
            { countSelfReturns: false }
        );
        expect(limit.maxActions).toBe(100);
    });

    test('a later row gets what the first left, with the self-return counted once', () => {
        const lookup = actionTimeDisplay.buildInventoryLookup([stack(CAPE, 100), PURSE]);
        const first = queued(1, TRANSMUTE, CAPE, { maxCount: 50 });

        actionTimeDisplay.deductQueueActionMaterials(lookup, game.actionDetails[TRANSMUTE], first, {
            count: 50,
            isTrulyInfinite: false,
        });

        expect(lookup.byHrid[CAPE]).toBeCloseTo(100 - 50 * NET_PER_ATTEMPT, 6);
        // The other outputs are still credited
        expect(lookup.byHrid[CHANCE_CAPE]).toBeCloseTo(50 * 0.53 * 0.75, 6);
    });

    test('a coinify has no self-return to count', () => {
        const net = actionTimeDisplay.getAlchemyNetInputPerAction(
            game.actionDetails[COINIFY],
            game.itemDetails[DONUT],
            queued(1, COINIFY, DONUT)
        );
        expect(net).toEqual({ perAction: 1, isEstimated: false });
    });
});
