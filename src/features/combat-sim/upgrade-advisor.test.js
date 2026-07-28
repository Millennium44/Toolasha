/**
 * Tests for Upgrade Advisor candidate generation
 */

import { describe, test, expect, vi } from 'vitest';

vi.mock('../../core/data-manager.js', () => ({ default: {} }));
vi.mock('./combat-sim-adapter.js', () => ({
    buildGameDataPayload: vi.fn(),
    calculateSimRevenue: vi.fn(),
}));
vi.mock('./combat-sim-runner.js', () => ({
    runSimulation: vi.fn(),
    runLabyrinthSimulation: vi.fn(),
}));
vi.mock('../combat/labyrinth-clear-rate.js', () => ({ default: {} }));
vi.mock('../../utils/profit-helpers.js', () => ({ resolveItemPrice: vi.fn() }));
vi.mock('../../utils/market-data.js', () => ({ getItemPrices: vi.fn() }));
vi.mock('../../utils/enhancement-calculator.js', () => ({ calculateEnhancement: vi.fn() }));
vi.mock('../../utils/enhancement-config.js', () => ({
    getEnhancingParams: vi.fn(),
    getAutoDetectedParams: vi.fn(),
}));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({
    getCheapestProtectionPrice: vi.fn(),
    getProductionCost: vi.fn(),
}));
vi.mock('../../utils/ability-cost-calculator.js', () => ({ calculateAbilityLevelUpCost: vi.fn() }));
vi.mock('./skilling-sim-helpers.js', () => ({ buildOverridesForSkill: vi.fn() }));

const { generateCandidates } = await import('./upgrade-advisor.js');

const MAIN_HAND = '/equipment_types/main_hand';

function buildGameData() {
    return {
        actionDetailMap: {},
        itemDetailMap: {
            '/items/fine_sword': {
                name: 'Fine Sword',
                itemLevel: 50,
                sortIndex: 1,
                equipmentDetail: {
                    type: MAIN_HAND,
                    combatStats: { slashDamage: 10 },
                },
            },
            '/items/regal_sword_refined': {
                name: 'Regal Sword (R)',
                itemLevel: 60,
                sortIndex: 2,
                equipmentDetail: {
                    type: MAIN_HAND,
                    combatStats: { slashDamage: 15 },
                },
            },
        },
    };
}

function buildPlayer(hrid, enhancementLevel) {
    return {
        equipment: {
            [MAIN_HAND]: { hrid, enhancementLevel },
        },
    };
}

describe('generateCandidates refined-equipment gating', () => {
    test('does not recommend refined gear below +10', () => {
        const candidates = generateCandidates(buildPlayer('/items/fine_sword', 4), buildGameData(), 'equipment');

        const refinedRecommendations = candidates.filter(
            (c) => c.upgradeHrid.endsWith('_refined') && c.upgradeHrid !== c.currentHrid
        );
        expect(refinedRecommendations).toEqual([]);

        // The regular enhancement candidate on the current item is still present
        expect(candidates.some((c) => c.type === 'enhancement' && c.upgradeHrid === '/items/fine_sword')).toBe(true);
    });

    test('recommends refined gear at +10 and above', () => {
        const candidates = generateCandidates(buildPlayer('/items/fine_sword', 10), buildGameData(), 'equipment');

        const refinedTier = candidates.find((c) => c.type === 'tier' && c.upgradeHrid === '/items/regal_sword_refined');
        expect(refinedTier).toBeDefined();
        expect(refinedTier.upgradeLevel).toBe(10);
    });

    test('still generates enhancement candidates for an already-equipped refined item', () => {
        const candidates = generateCandidates(
            buildPlayer('/items/regal_sword_refined', 10),
            buildGameData(),
            'equipment'
        );

        const enhancement = candidates.find(
            (c) => c.type === 'enhancement' && c.upgradeHrid === '/items/regal_sword_refined'
        );
        expect(enhancement).toBeDefined();
        expect(enhancement.upgradeLevel).toBeGreaterThanOrEqual(10);
    });
});
