/**
 * calculateSimRevenue nets the marketplace sale tax off drop value.
 *
 * The sim values a drop at what it sells for, and selling on the market is
 * taxed — so a drop is worth its price *after* tax, not gross. This was missed
 * (the sim valued drops gross), so the 8/13 tax rise never moved sim profit.
 * Coin is not sold and stays whole; cowbell bags carry their own higher rate.
 *
 * The suite's global setup mocks the marketplace-patch gate on, so MARKET_TAX
 * reads 5% here.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

import { MARKET_TAX, COWBELL_BAG_TAX } from '../../utils/profit-constants.js';

const mocks = vi.hoisted(() => ({ prices: {}, pricingMode: 'hybrid', patientTick: false }));

vi.mock('../../core/data-manager.js', () => ({
    default: { getItemDetails: (hrid) => ({ name: hrid.split('/').pop() }) },
}));
vi.mock('../../core/storage.js', () => ({ default: {} }));
vi.mock('../../core/config.js', () => ({
    // Default pricing mode → getSellPrice reads the ask
    default: { getSetting: () => null, getSettingValue: (_key, fallback) => fallback },
}));
vi.mock('../combat/loadout-snapshot.js', () => ({ default: {} }));
vi.mock('../../utils/bundle-bridge.js', () => ({
    loadoutSnapshot: () => ({}),
    expectedValueCalculator: () => null,
}));
vi.mock('../../api/marketplace.js', () => ({
    default: { getPrice: (hrid) => mocks.prices[hrid] || null },
}));
vi.mock('../market/expected-value-calculator.js', () => ({
    default: { getCachedValue: () => null, calculateSingleContainer: () => null },
}));
vi.mock('../../utils/dungeon-level-gap.js', () => ({ partyLevelGaps: () => ({}) }));
// profit-helpers pulls these in at load; stub the ones that touch the live
// market on import. calculatePriceAfterTax itself lives in profit-helpers and
// stays real, so the tax math under test is the real thing.
//
// `getItemPrice` is a small stand-in for the real pricing-mode/patient-tick
// resolution: it reads off `mocks.prices` (the same book `marketAPI.getPrice`
// answers with) rather than always answering 0, since `getSellPrice`/
// `getBuyPrice` now route through it instead of mapping ask/bid themselves.
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid, options = {}) => {
        const price = mocks.prices[hrid];
        if (!price) return null;
        const side = options.side === 'buy' ? 'buy' : 'sell';
        let book;
        switch (mocks.pricingMode) {
            case 'conservative':
                book = side === 'buy' ? 'ask' : 'bid';
                break;
            case 'optimistic':
                book = side === 'buy' ? 'bid' : 'ask';
                break;
            case 'patientBuy':
                book = 'bid';
                break;
            default:
                book = 'ask';
        }
        const raw = price[book];
        if (!(raw > 0)) return null;
        // A buy priced at the bid moves up a tick, a sell priced at the ask
        // moves down one — the same patient leg `patientTickPrice` improves.
        const patientLeg = (side === 'buy' && book === 'bid') || (side === 'sell' && book === 'ask');
        if (mocks.patientTick && patientLeg) {
            return side === 'buy' ? raw + 1 : raw - 1;
        }
        return raw;
    },
    getItemPrices: () => ({}),
}));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({ getProductionCost: () => 0 }));

const { calculateSimRevenue } = await import('./combat-sim-adapter.js');

/**
 * A dungeon run whose completion always drops one chimerical chest, which costs
 * one entry key and one chest key.
 */
function simClearingDungeon(completions, chestPrice, keyPrice) {
    mocks.prices['/items/chimerical_chest'] = { ask: chestPrice, bid: chestPrice };
    mocks.prices['/items/chimerical_entry_key'] = { ask: keyPrice, bid: keyPrice };
    mocks.prices['/items/chimerical_chest_key'] = { ask: keyPrice, bid: keyPrice };
    const simResult = {
        deaths: {},
        dropRateMultiplier: { player1: 1 },
        rareFindMultiplier: { player1: 1 },
        combatDropQuantity: { player1: 0 },
        debuffOnLevelGap: { player1: 0 },
        numberOfPlayers: 1,
        difficultyTier: 0,
        isDungeon: true,
        dungeonsCompleted: completions,
        zoneName: '/actions/combat/chimerical_den',
        consumablesUsed: { player1: {} },
    };
    const gameData = {
        combatMonsterDetailMap: {},
        actionDetailMap: {
            '/actions/combat/chimerical_den': {
                combatZoneInfo: {
                    dungeonInfo: {
                        rewardDropTable: [
                            { itemHrid: '/items/chimerical_chest', dropRate: 0.2, minCount: 1, maxCount: 1 },
                        ],
                    },
                },
            },
        },
    };
    return { simResult, gameData };
}

/**
 * A sim where killing one monster always drops exactly one of `itemHrid`, so the
 * expected drop count is the kill count and the revenue math is easy to pin.
 */
function simDropping(itemHrid, kills, price) {
    mocks.prices[itemHrid] = { ask: price, bid: price };
    const simResult = {
        deaths: { '/monsters/rat': kills, player1: 0 },
        dropRateMultiplier: { player1: 1 },
        rareFindMultiplier: { player1: 1 },
        combatDropQuantity: { player1: 0 },
        debuffOnLevelGap: { player1: 0 },
        numberOfPlayers: 1,
        difficultyTier: 0,
        isDungeon: false,
        consumablesUsed: { player1: {} },
    };
    const gameData = {
        combatMonsterDetailMap: {
            '/monsters/rat': {
                dropTable: [{ itemHrid, dropRate: 1, minCount: 1, maxCount: 1, minDifficultyTier: 0 }],
            },
        },
    };
    return { simResult, gameData };
}

// kills === hours, so (total / hours) is 1 and revenuePerHour is the unit value
const KILLS = 10;
const HOURS = 10;

beforeEach(() => {
    mocks.prices = {};
    mocks.pricingMode = 'hybrid';
    mocks.patientTick = false;
});

describe('calculateSimRevenue drop tax', () => {
    test('an ordinary drop is worth its price net of the market tax', () => {
        const { simResult, gameData } = simDropping('/items/cheese', KILLS, 1000);
        const { revenuePerHour } = calculateSimRevenue(simResult, gameData, 'player1', HOURS);

        expect(revenuePerHour).toBeCloseTo(1000 * (1 - MARKET_TAX), 9);
        // And it is genuinely lower than the gross the sim used to report
        expect(revenuePerHour).toBeLessThan(1000);
    });

    test('a cowbell bag is taxed at its own higher rate, not the flat market rate', () => {
        const { simResult, gameData } = simDropping('/items/bag_of_10_cowbells', KILLS, 1000);
        const { revenuePerHour } = calculateSimRevenue(simResult, gameData, 'player1', HOURS);

        expect(revenuePerHour).toBeCloseTo(1000 * (1 - COWBELL_BAG_TAX), 9);
        expect(COWBELL_BAG_TAX).toBeGreaterThan(MARKET_TAX);
    });

    test('coin is not sold, so it is not taxed', () => {
        const { simResult, gameData } = simDropping('/items/coin', KILLS, 1);
        const { revenuePerHour } = calculateSimRevenue(simResult, gameData, 'player1', HOURS);

        // One coin per kill, valued at 1 apiece, untouched by tax
        expect(revenuePerHour).toBeCloseTo(1, 9);
    });
});

/**
 * A dungeon's keys are a cost of running it.
 *
 * Only the Results detail view ever priced them, and it computes its own figure.
 * Every reader of `netPerHour` — the all-zones table that ranks dungeons against
 * zones, the upgrade advisor, the task profit display — was handed a dungeon's
 * revenue with entry and chest keys unpaid.
 */
/**
 * `getSellPrice`/`getBuyPrice` used to map `profitCalc_pricingMode` onto
 * ask/bid themselves, so the patient ticks (`profitCalc_patientTickBuy`/`Sell`) —
 * which only the central `getItemPrice` applied — never reached the sim's
 * drop revenue, consumable cost or dungeon key cost. They now route through
 * `getItemPrice`, so these prove the tick actually moves the numbers, and
 * that it leaves them alone when off.
 */
describe('calculateSimRevenue pricing mode and the patient tick', () => {
    test('an optimistic drop sells one tick below the ask, when the tick is on', () => {
        const { simResult, gameData } = simDropping('/items/cheese', KILLS, 0);
        mocks.prices['/items/cheese'] = { ask: 100, bid: 90 };
        mocks.pricingMode = 'optimistic';

        mocks.patientTick = false;
        const { revenuePerHour: off } = calculateSimRevenue(simResult, gameData, 'player1', HOURS);
        expect(off).toBeCloseTo(100 * (1 - MARKET_TAX), 9);

        mocks.patientTick = true;
        const { revenuePerHour: on } = calculateSimRevenue(simResult, gameData, 'player1', HOURS);
        expect(on).toBeCloseTo(99 * (1 - MARKET_TAX), 9);
        expect(on).toBeLessThan(off);
    });

    test('a patientBuy consumable buys one tick above the bid, when the tick is on', () => {
        const simResult = {
            deaths: {},
            dropRateMultiplier: { player1: 1 },
            rareFindMultiplier: { player1: 1 },
            combatDropQuantity: { player1: 0 },
            debuffOnLevelGap: { player1: 0 },
            numberOfPlayers: 1,
            difficultyTier: 0,
            isDungeon: false,
            consumablesUsed: { player1: { '/items/wisdom_tea': 5 } },
        };
        const gameData = { combatMonsterDetailMap: {} };
        mocks.prices['/items/wisdom_tea'] = { ask: 220, bid: 200 };
        mocks.pricingMode = 'patientBuy';

        mocks.patientTick = false;
        const { costPerHour: off } = calculateSimRevenue(simResult, gameData, 'player1', HOURS);
        expect(off).toBeCloseTo((5 / HOURS) * 200, 9);

        mocks.patientTick = true;
        const { costPerHour: on } = calculateSimRevenue(simResult, gameData, 'player1', HOURS);
        expect(on).toBeCloseTo((5 / HOURS) * 201, 9);
        expect(on).toBeGreaterThan(off);
    });

    test('dungeon key costs follow the key pricing setting, not the general buy side or its patient tick', () => {
        // Keys used to be priced off the same general-buy helper as
        // consumables, so a Patient/bid general setting silently moved the key
        // cost too. `profitCalc_keyPricingMode` defaults to 'ask' and is a
        // side of its own — see `resolveKeyPricing` in key-cost.js — so it
        // must answer the same ask price regardless of the general setting or
        // its patient tick.
        const { simResult, gameData } = simClearingDungeon(10, 5000, 1000);
        mocks.prices['/items/chimerical_entry_key'] = { ask: 1100, bid: 1000 };
        mocks.prices['/items/chimerical_chest_key'] = { ask: 1100, bid: 1000 };
        mocks.pricingMode = 'patientBuy';

        mocks.patientTick = false;
        const { keyCostPerHour: off } = calculateSimRevenue(simResult, gameData, 'player1', HOURS);
        expect(off).toBeCloseTo(0.2 * 2200, 6);

        mocks.patientTick = true;
        const { keyCostPerHour: on } = calculateSimRevenue(simResult, gameData, 'player1', HOURS);
        expect(on).toBeCloseTo(0.2 * 2200, 6);
        expect(on).toBe(off);
    });
});

describe('calculateSimRevenue dungeon key cost', () => {
    test('entry and chest keys are charged against the run', () => {
        // 10 completions × 0.2 = 2 chests, over 10 hours = 0.2 chests/hr, each
        // owing one entry key and one chest key at 1000 apiece
        const { simResult, gameData } = simClearingDungeon(10, 5000, 1000);
        const { keyCostPerHour, costPerHour, revenuePerHour, netPerHour } = calculateSimRevenue(
            simResult,
            gameData,
            'player1',
            HOURS
        );

        expect(keyCostPerHour).toBeCloseTo(0.2 * 2000, 6);
        expect(costPerHour).toBeCloseTo(keyCostPerHour, 6);
        expect(netPerHour).toBeCloseTo(revenuePerHour - keyCostPerHour, 6);
    });

    test('a non-dungeon run is charged nothing', () => {
        const { simResult, gameData } = simDropping('/items/cheese', KILLS, 1000);
        const { keyCostPerHour, costPerHour } = calculateSimRevenue(simResult, gameData, 'player1', HOURS);

        expect(keyCostPerHour).toBe(0);
        expect(costPerHour).toBe(0);
    });
});
