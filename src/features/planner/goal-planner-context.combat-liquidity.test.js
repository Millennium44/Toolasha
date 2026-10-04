/**
 * Combat drops must reach the planner's real market-volume limiter.
 *
 * The saved rows below use the shape written by buildAllZonesSnapshot():
 * net profit, gross revenue, and the per-item drop composition. Keeping the
 * adapter and limiter real catches a missing field at their join.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const sim = vi.hoisted(() => ({ snapshot: null }));
const history = vi.hoisted(() => ({ hasVolume: true, rows: [], calls: [] }));
const game = vi.hoisted(() => ({ inventory: [] }));

vi.mock('../combat-sim/combat-sim-ui.js', () => ({
    default: { loadAllZonesSnapshot: async () => sim.snapshot },
}));
vi.mock('../combat/loadout-snapshot.js', () => ({
    default: { getAllSnapshots: () => [], resolveEquipment: () => [] },
}));
vi.mock('./goal-planner-store.js', () => ({
    loadCombatGear: async () => ({ preferred: null, baseline: null }),
    saveCombatGear: async () => ({}),
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ actionDetailMap: {}, itemDetailMap: {}, levelExperienceTable: [0, 1] }),
        getItemDetails: () => null,
        getActionDetails: () => null,
        getSkills: () => [],
        getEquipment: () => new Map(),
        getInventory: () => game.inventory,
        getHouseRoomLevel: () => 0,
        getActionDrinkSlots: () => [],
    },
}));
vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, fetch: async () => {}, lastFetchTimestamp: 12345 },
}));
vi.mock('../actions/gathering-profit.js', () => ({ calculateGatheringProfit: async () => null }));
vi.mock('../actions/production-profit.js', () => ({ calculateProductionProfit: async () => null }));
vi.mock('../alchemy/alchemy-rankings.js', () => ({ alchemyGoldRates: () => [] }));
vi.mock('../market/mooket/market-history-api.js', () => ({
    default: {
        fetchHistory: async (...args) => {
            history.calls.push(args);
            return history.rows;
        },
        currentSource: () => ({ key: 'mooket2', hasVolume: history.hasVolume }),
        get enabled() {
            return true;
        },
    },
}));
vi.mock('../crafting-plan/crafting-plan-calculator.js', () => ({ computeBestCraftingPlan: () => null }));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({
    calculateEnhancementPath: () => null,
    getProductionChainTime: () => 0,
    getCheapestProtectionPrice: () => null,
    getEnhancementMaterialPrice: () => 0,
}));
vi.mock('../enhancement/enhancement-xp.js', () => ({ calculateSuccessXP: () => 0, calculateFailureXP: () => 0 }));
vi.mock('../enhancement/enhancement-params-source.js', () => ({
    getTooltipEnhancementParams: () => ({ enhancingLevel: 1, houseLevel: 0 }),
    describeEnhancementSource: () => ({ kind: 'own', detail: '' }),
}));
vi.mock('../../utils/house-cost-calculator.js', () => ({
    initialize: async () => {},
    calculateCumulativeCost: async () => null,
    getItemName: () => '',
}));
vi.mock('../../utils/enhancement-calculator.js', () => ({ calculateEnhancement: () => null }));
vi.mock('../../utils/experience-calculator.js', () => ({
    calculateExpPerHour: () => ({ expPerHour: 0, modifiedXP: 0, actionTime: 1, totalEfficiency: 0 }),
}));
vi.mock('../../utils/market-data.js', () => ({ getPriceAgeString: () => 'a moment ago' }));
vi.mock('../../utils/inventory-reservations.js', () => ({
    effectiveInventory: (_itemHrid, _level, { held } = {}) => held || 0,
    shortfallNote: () => '',
}));

const { buildPlannerContext } = await import('./goal-planner-context.js');
const { resetLiquidityCache } = await import('./market-liquidity.js');
const { planGoal } = await import('./goal-planner.js');

const CHARM = '/items/rare_charm';
const NET_PER_HOUR = 10_000;

/** One day of the real history API row shape, over a complete 30-day window. */
function tradedRows(perDay) {
    const now = Math.floor(Date.now() / 1000);
    return Array.from({ length: 30 }, (_, day) => ({
        time: now - (29 - day) * 86_400,
        a: 1100,
        b: 900,
        p: 1000,
        v: perDay,
    }));
}

/** The stored output of buildAllZonesSnapshot for an actual dungeon zone. */
function producerSnapshot() {
    return {
        savedAt: Date.now(),
        zones: [
            {
                zoneHrid: '/actions/combat/fantasy',
                zoneName: 'Fantasy',
                difficultyTier: 0,
                // The simulator has already included its 2,000/hr expenses.
                profitPerHour: NET_PER_HOUR,
                revenuePerHour: 12_000,
                xpPerHour: 0,
                encountersPerHour: 100,
                dungeon: {
                    completions: 100,
                    failed: 0,
                    simHours: 1,
                    partySize: 1,
                    consumableCostPerHour: 2_000,
                    deathsPerHour: 0,
                },
                sells: [{ itemHrid: CHARM, name: 'Rare Charm', unitsPerHour: 20 }],
            },
        ],
    };
}

beforeEach(() => {
    sim.snapshot = producerSnapshot();
    history.hasVolume = true;
    history.rows = tradedRows(19.2); // 19.2/day => 0.2/hr absorbable => 0.01 throttle
    history.calls = [];
    game.inventory = [];
    resetLiquidityCache();
});

describe('planner combat snapshot liquidity', () => {
    test('bounds net combat income and the resulting gold-goal ETA by measured drop volume', async () => {
        const context = await buildPlannerContext();
        const [rate] = context.goldRates();

        expect(history.calls).toHaveLength(1);
        expect(history.calls[0]).toEqual([CHARM, 0, 30]);
        expect(rate).toMatchObject({
            kind: 'combat',
            sells: [{ itemHrid: CHARM, name: 'Rare Charm', unitsPerHour: 20 }],
        });
        expect(rate.goldPerHour).toBeCloseTo(NET_PER_HOUR * 0.01, 10);
        // The simulator's net value already includes the 2,000/hr consumables;
        // the planner uses that net field, never the separate gross figure.
        expect(rate.goldPerHour).not.toBe(12_000 * 0.01);

        const plan = planGoal({ type: 'gold', amount: 10_000_000 }, context);
        expect(plan.steps[0].timeHours).toBeCloseTo(10_000_000 / 100, 5);
        expect(plan.steps[0].details.rate).toBe(rate);
    });

    test('leaves the net rate usable and reports unchecked volume when sales history is unavailable', async () => {
        history.hasVolume = false;

        const context = await buildPlannerContext();
        const [rate] = context.goldRates();

        expect(history.calls).toHaveLength(0);
        expect(rate).toMatchObject({
            kind: 'combat',
            goldPerHour: NET_PER_HOUR,
            sells: [{ itemHrid: CHARM, name: 'Rare Charm', unitsPerHour: 20 }],
        });
        expect(context.rateNotes).toContain(
            'Market volume is not being checked, so a rate here is what its output is *worth*, not what you could sell. Turn on pooled market history to bound methods by how fast they actually trade.'
        );
        expect(planGoal({ type: 'gold', amount: 10_000_000 }, context).steps[0].timeHours).toBe(1000);
    });
});
