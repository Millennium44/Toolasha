import { beforeAll, describe, expect, test, vi } from 'vitest';
import * as mathJs from 'mathjs';

beforeAll(() => {
    globalThis.math = mathJs;
});

const itemDetailsMap = { '/items/widget': { enhancementCosts: [{ itemHrid: '/items/coin', count: 1000 }] } };
itemDetailsMap['/items/kraken_chaps_refined'] = {
    enhancementCosts: [
        { itemHrid: '/items/pirate_essence', count: 14 },
        { itemHrid: '/items/umbral_leather', count: 6 },
        { itemHrid: '/items/coin', count: 4815 },
    ],
    protectionItemHrids: ['/items/kraken_leather', '/items/kraken_chaps'],
};

vi.mock('../../core/data-manager.js', () => ({
    default: { getItemDetails: (itemHrid) => itemDetailsMap[itemHrid] },
}));

let protectionPrice = 5000;
let materialPricing = { cost: 1000, hasCost: true, costPartial: false };
vi.mock('../../features/enhancement/tooltip-enhancement.js', () => ({
    calculatePerAttemptMaterialCost: () => materialPricing,
    getCheapestProtectionPrice: () => ({ price: protectionPrice, itemHrid: '/items/mirror_of_protection' }),
}));

const { buildEnhancementModel } = await import('./enhancement-adapter.js');

// enhancingLevel === itemLevel with 0 toolBonus gives a successMultiplier of exactly 1, so
// actualRate == BASE_SUCCESS_RATES, making outcomes hand-verifiable without extra arithmetic.
const NEUTRAL_PARAMS = Object.freeze({
    enhancingLevel: 1,
    houseLevel: 0,
    toolBonus: 0,
    speedBonus: 0,
    itemLevel: 1,
    blessedTea: false,
    guzzlingBonus: 1,
});

describe('buildEnhancementModel', () => {
    test('returns null for an unknown item', () => {
        expect(buildEnhancementModel('/items/unknown', { ...NEUTRAL_PARAMS, targetLevel: 2 })).toBeNull();
    });

    test('returns null when calculateEnhancement rejects the params', () => {
        // targetLevel 0 is invalid per calculateEnhancement's own validation
        expect(buildEnhancementModel('/items/widget', { ...NEUTRAL_PARAMS, targetLevel: 0 })).toBeNull();
    });

    test('builds unprotected two-outcome level distributions matching BASE_SUCCESS_RATES', () => {
        const model = buildEnhancementModel('/items/widget', { ...NEUTRAL_PARAMS, targetLevel: 2, protectFrom: 0 });

        expect(model.costPerAttempt).toBe(1000);
        expect(model.protectionCostOnFailure).toBe(0);
        expect(model.maxSinglePossibleLoss).toBe(1000);

        // Level 0: BASE_SUCCESS_RATES[0] = 50%
        const [failure0, success0] = model.perLevelOutcomeDistributions[0];
        expect(failure0).toEqual({ prob: 0.5, nextLevel: 0, net: -1000 });
        expect(success0).toEqual({ prob: 0.5, nextLevel: 1, net: -1000 });

        // Level 1: BASE_SUCCESS_RATES[1] = 45%
        const [failure1, success1] = model.perLevelOutcomeDistributions[1];
        expect(failure1).toEqual({ prob: 0.55, nextLevel: 0, net: -1000 });
        expect(success1).toEqual({ prob: 0.45, nextLevel: 2, net: -1000 });
    });

    test('charges protection cost on failure only once the game-allowed +2 threshold is reached', () => {
        protectionPrice = 5000;
        const model = buildEnhancementModel('/items/widget', { ...NEUTRAL_PARAMS, targetLevel: 3, protectFrom: 2 });

        // Level 0 (below protectFrom): unprotected failure, back to 0
        const [failure0] = model.perLevelOutcomeDistributions[0];
        expect(failure0).toEqual({ prob: 0.5, nextLevel: 0, net: -1000 });

        // Level 1 (below protectFrom): failure resets to 0 without protection
        const [failure1] = model.perLevelOutcomeDistributions[1];
        expect(failure1).toEqual({ prob: 0.55, nextLevel: 0, net: -1000 });

        // Level 2: protected failure drops to +1 and spends one protection
        const [failure2] = model.perLevelOutcomeDistributions[2];
        expect(failure2.nextLevel).toBe(1);
        expect(failure2.net).toBe(-6000);

        expect(model.protectionCostOnFailure).toBe(5000);
        expect(model.maxSinglePossibleLoss).toBe(6000);
    });

    test('refuses a partial material price for a real refined item instead of treating missing inputs as free', () => {
        materialPricing = { cost: 4815, hasCost: true, costPartial: true };
        try {
            expect(
                buildEnhancementModel('/items/kraken_chaps_refined', {
                    ...NEUTRAL_PARAMS,
                    targetLevel: 3,
                    protectFrom: 0,
                })
            ).toEqual({ error: 'incomplete-prices' });
        } finally {
            materialPricing = { cost: 1000, hasCost: true, costPartial: false };
        }
    });

    test('refuses unknown protection price only when the protected level can be attempted', () => {
        protectionPrice = null;
        try {
            expect(
                buildEnhancementModel('/items/kraken_chaps_refined', {
                    ...NEUTRAL_PARAMS,
                    targetLevel: 3,
                    protectFrom: 2,
                })
            ).toEqual({ error: 'incomplete-prices' });
            const unused = buildEnhancementModel('/items/kraken_chaps_refined', {
                ...NEUTRAL_PARAMS,
                targetLevel: 3,
                protectFrom: 3,
            });
            expect(unused.protectionCostOnFailure).toBe(0);
        } finally {
            protectionPrice = 5000;
        }
    });

    test('treats an explicitly known zero protection price as free', () => {
        protectionPrice = 0;
        try {
            const model = buildEnhancementModel('/items/kraken_chaps_refined', {
                ...NEUTRAL_PARAMS,
                targetLevel: 3,
                protectFrom: 2,
            });
            expect(model.protectionCostOnFailure).toBe(0);
            expect(model.error).toBeUndefined();
        } finally {
            protectionPrice = 5000;
        }
    });

    test('splits blessed tea success into a normal +1 and a skip +2 branch', () => {
        const model = buildEnhancementModel('/items/widget', {
            ...NEUTRAL_PARAMS,
            targetLevel: 5,
            protectFrom: 0,
            blessedTea: true,
            guzzlingBonus: 1,
        });

        const [failure0, normal0, skip0] = model.perLevelOutcomeDistributions[0];
        const successChance = 0.5;
        const skipChance = successChance * 0.01;
        const remaining = successChance - skipChance;

        expect(failure0.prob).toBeCloseTo(0.5, 10);
        expect(normal0).toMatchObject({ nextLevel: 1, net: -1000 });
        expect(normal0.prob).toBeCloseTo(remaining, 10);
        expect(skip0).toMatchObject({ nextLevel: 2, net: -1000 });
        expect(skip0.prob).toBeCloseTo(skipChance, 10);
    });

    test('collapses the blessed tea skip branch when +1 and +2 both land on the target', () => {
        // targetLevel 2, at level 1: normalDestination = min(2, 2) = 2, skipDestination = min(2, 3) = 2 -> same
        const model = buildEnhancementModel('/items/widget', {
            ...NEUTRAL_PARAMS,
            targetLevel: 2,
            protectFrom: 0,
            blessedTea: true,
            guzzlingBonus: 1,
        });

        expect(model.perLevelOutcomeDistributions[1]).toHaveLength(2);
        const [, success1] = model.perLevelOutcomeDistributions[1];
        expect(success1).toEqual({ prob: 0.45, nextLevel: 2, net: -1000 });
    });

    test('stepFn resolves the chosen branch and isTargetReached/initialState match startLevel/targetLevel', () => {
        const model = buildEnhancementModel('/items/widget', { ...NEUTRAL_PARAMS, targetLevel: 2, startLevel: 0 });

        expect(model.initialState).toEqual({ level: 0 });
        expect(model.isTargetReached({ level: 2 })).toBe(true);
        expect(model.isTargetReached({ level: 1 })).toBe(false);

        // rng() = 0.9 misses the 0.5 failure-branch cumulative, landing on the success branch
        const nextState = model.stepFn({ balance: 10000, level: 0 }, () => 0.9);
        expect(nextState).toEqual({ balance: 9000, level: 1 });
    });
});
