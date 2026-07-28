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

const { generateCandidates, calculateUpgradeCost } = await import('./upgrade-advisor.js');
const { resolveItemPrice } = await import('../../utils/profit-helpers.js');
const { getItemPrices } = await import('../../utils/market-data.js');

const MAIN_HAND = '/equipment_types/main_hand';
const BACK = '/equipment_types/back';

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
            '/items/plain_cape': {
                name: 'Plain Cape',
                itemLevel: 50,
                sortIndex: 3,
                equipmentDetail: {
                    type: BACK,
                    combatStats: { slashDamage: 3 },
                },
            },
            '/items/grand_cape_refined': {
                name: 'Grand Cape (R)',
                itemLevel: 60,
                sortIndex: 4,
                equipmentDetail: {
                    type: BACK,
                    combatStats: { slashDamage: 5 },
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
    test('clamps refined recommendations below +10 up to +10', () => {
        const candidates = generateCandidates(buildPlayer('/items/fine_sword', 4), buildGameData(), 'equipment');

        // The refined tier upgrade is still suggested, but at +10 (refined items
        // cannot exist below +10), and its description reflects the clamped level
        const refinedTier = candidates.find((c) => c.type === 'tier' && c.upgradeHrid === '/items/regal_sword_refined');
        expect(refinedTier).toBeDefined();
        expect(refinedTier.upgradeLevel).toBe(10);
        expect(refinedTier.description).toContain('(+10)');

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

    test('does not clamp refined capes — the back slot is exempt', () => {
        const player = {
            equipment: {
                [BACK]: { hrid: '/items/plain_cape', enhancementLevel: 4 },
            },
        };
        const candidates = generateCandidates(player, buildGameData(), 'equipment');

        const refinedCape = candidates.find((c) => c.type === 'tier' && c.upgradeHrid === '/items/grand_cape_refined');
        expect(refinedCape).toBeDefined();
        expect(refinedCape.upgradeLevel).toBe(4);
        expect(refinedCape.description).toContain('(+4)');
    });

    test('equipped refined capes below +10 use the back breakpoints', () => {
        const player = {
            equipment: {
                [BACK]: { hrid: '/items/grand_cape_refined', enhancementLevel: 3 },
            },
        };
        const candidates = generateCandidates(player, buildGameData(), 'equipment');

        const enhancement = candidates.find(
            (c) => c.type === 'enhancement' && c.upgradeHrid === '/items/grand_cape_refined'
        );
        expect(enhancement).toBeDefined();
        // Next back-slot breakpoint after +3 is +5, not the refined table's +10
        expect(enhancement.upgradeLevel).toBe(5);
    });
});

describe('generateCandidates combat_level mode', () => {
    test('generates one +N candidate per combat skill', () => {
        const player = {
            equipment: {},
            staminaLevel: 90,
            intelligenceLevel: 95,
            attackLevel: 100,
            meleeLevel: 100,
            defenseLevel: 88,
            rangedLevel: 110,
            magicLevel: 70,
        };
        const candidates = generateCandidates(player, buildGameData(), 'combat_level', 5);

        expect(candidates).toHaveLength(7);
        const ranged = candidates.find((c) => c.skillKey === 'rangedLevel');
        expect(ranged.currentLevel).toBe(110);
        expect(ranged.upgradeLevel).toBe(115);
        expect(ranged.description).toBe('Ranged 110 → 115');
        expect(candidates.every((c) => c.type === 'combat_level')).toBe(true);
    });

    test('defaults the boost to 5 and combat level costs are null', () => {
        const player = { equipment: {}, staminaLevel: 50 };
        const candidates = generateCandidates(player, buildGameData(), 'combat_level', 0);

        const stamina = candidates.find((c) => c.skillKey === 'staminaLevel');
        expect(stamina.upgradeLevel).toBe(55);
        expect(calculateUpgradeCost(stamina, buildGameData())).toBeNull();
    });

    test('per-skill target levels override the uniform boost', () => {
        const player = { equipment: {}, staminaLevel: 50, attackLevel: 100, defenseLevel: 80 };
        const targets = { staminaLevel: 60, attackLevel: 90, defenseLevel: 85 };
        const candidates = generateCandidates(player, buildGameData(), 'combat_level', 5, 'increment', false, targets);

        // attack target (90) is below current (100) → skipped; others use targets
        expect(candidates.find((c) => c.skillKey === 'attackLevel')).toBeUndefined();
        expect(candidates.find((c) => c.skillKey === 'staminaLevel').upgradeLevel).toBe(60);
        expect(candidates.find((c) => c.skillKey === 'defenseLevel').upgradeLevel).toBe(85);
        // skills without a target entry are skipped too
        expect(candidates.find((c) => c.skillKey === 'magicLevel')).toBeUndefined();
    });
});

describe('calculateUpgradeCost for items without high-level listings', () => {
    test('uses the market ask when the target enhancement level has a listing', () => {
        getItemPrices.mockReturnValue({ ask: 200_000_000, bid: 150_000_000 });
        resolveItemPrice.mockImplementation((hrid, { side }) => {
            if (side === 'sell') return { price: 1_000_000 };
            return { price: 5_000_000 };
        });

        const cost = calculateUpgradeCost(
            {
                type: 'tier',
                slot: MAIN_HAND,
                currentHrid: '/items/fine_sword',
                currentLevel: 10,
                upgradeHrid: '/items/regal_sword_refined',
                upgradeLevel: 10,
            },
            buildGameData()
        );

        expect(cost).toBe(199_000_000);
    });

    test('falls back to base price when the target enhancement level has no listing', () => {
        getItemPrices.mockReturnValue(null);
        resolveItemPrice.mockImplementation((hrid, { enhancementLevel, side }) => {
            if (side === 'sell') return { price: 1_000_000 };
            if (enhancementLevel === 10) return { price: 0 };
            return { price: 5_000_000 };
        });

        const cost = calculateUpgradeCost(
            {
                type: 'tier',
                slot: MAIN_HAND,
                currentHrid: '/items/fine_sword',
                currentLevel: 10,
                upgradeHrid: '/items/regal_sword_refined',
                upgradeLevel: 10,
            },
            buildGameData()
        );

        // Base price (5M) + enhancement cost (0, no enhancementCosts data) - sell current (1M)
        expect(cost).toBe(4_000_000);
    });

    test('returns null instead of 0 when no price is known at all', () => {
        getItemPrices.mockReturnValue(null);
        resolveItemPrice.mockImplementation(() => ({ price: 0 }));

        const cost = calculateUpgradeCost(
            {
                type: 'tier',
                slot: MAIN_HAND,
                currentHrid: '/items/fine_sword',
                currentLevel: 5,
                upgradeHrid: '/items/regal_sword_refined',
                upgradeLevel: 10,
            },
            buildGameData()
        );

        expect(cost).toBeNull();
    });
});
