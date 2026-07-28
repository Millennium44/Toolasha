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

const {
    generateCandidates,
    calculateUpgradeCost,
    findMatchingCharmForSkill,
    getMainTrainingSkills,
    runLabyrinthAllFightsAnalysis,
} = await import('./upgrade-advisor.js');
const { resolveItemPrice } = await import('../../utils/profit-helpers.js');
const { getItemPrices } = await import('../../utils/market-data.js');
const { buildGameDataPayload } = await import('./combat-sim-adapter.js');
const { runLabyrinthSimulation } = await import('./combat-sim-runner.js');

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
    test('generates one +N candidate per style-relevant combat skill', () => {
        const player = {
            equipment: { [MAIN_HAND]: { hrid: '/items/fine_sword', enhancementLevel: 0 } },
            staminaLevel: 90,
            intelligenceLevel: 95,
            attackLevel: 100,
            meleeLevel: 100,
            defenseLevel: 88,
            rangedLevel: 110,
            magicLevel: 70,
        };
        const candidates = generateCandidates(player, buildGameData(), 'combat_level', 5);

        // Melee weapon → Ranged and Magic are irrelevant and excluded
        expect(candidates.map((c) => c.skillKey)).toEqual([
            'staminaLevel',
            'intelligenceLevel',
            'attackLevel',
            'meleeLevel',
            'defenseLevel',
        ]);
        const melee = candidates.find((c) => c.skillKey === 'meleeLevel');
        expect(melee.currentLevel).toBe(100);
        expect(melee.upgradeLevel).toBe(105);
        expect(melee.description).toBe('Melee 100 → 105');
        expect(candidates.every((c) => c.type === 'combat_level')).toBe(true);
    });

    test('ranged weapons exclude the melee and magic skills', () => {
        const gameData = buildGameData();
        gameData.itemDetailMap['/items/fine_bow'] = {
            name: 'Fine Bow',
            itemLevel: 50,
            equipmentDetail: { type: '/equipment_types/two_hand', combatStats: { rangedDamage: 12 } },
        };
        const player = {
            equipment: { '/equipment_types/two_hand': { hrid: '/items/fine_bow', enhancementLevel: 0 } },
            staminaLevel: 90,
            intelligenceLevel: 90,
            attackLevel: 90,
            meleeLevel: 90,
            defenseLevel: 90,
            rangedLevel: 90,
            magicLevel: 90,
        };
        const candidates = generateCandidates(player, gameData, 'combat_level', 5);

        // Attack stays — it trains under every style via the XP split
        expect(candidates.map((c) => c.skillKey)).toEqual([
            'staminaLevel',
            'intelligenceLevel',
            'attackLevel',
            'defenseLevel',
            'rangedLevel',
        ]);
    });

    test('magic weapons exclude the melee and ranged skills', () => {
        const gameData = buildGameData();
        gameData.itemDetailMap['/items/fine_staff'] = {
            name: 'Fine Staff',
            itemLevel: 50,
            equipmentDetail: { type: '/equipment_types/two_hand', combatStats: { magicDamage: 12 } },
        };
        const player = {
            equipment: { '/equipment_types/two_hand': { hrid: '/items/fine_staff', enhancementLevel: 0 } },
            staminaLevel: 90,
            intelligenceLevel: 90,
            attackLevel: 90,
            meleeLevel: 90,
            defenseLevel: 90,
            rangedLevel: 90,
            magicLevel: 90,
        };
        const candidates = generateCandidates(player, gameData, 'combat_level', 5);

        // Melee and Ranged are excluded for magic weapons; Attack stays
        expect(candidates.map((c) => c.skillKey)).toEqual([
            'staminaLevel',
            'intelligenceLevel',
            'attackLevel',
            'defenseLevel',
            'magicLevel',
        ]);
    });

    test('defaults the boost to 5 and combat level costs are null', () => {
        const player = { equipment: {}, staminaLevel: 50 };
        const candidates = generateCandidates(player, buildGameData(), 'combat_level', 0);

        const stamina = candidates.find((c) => c.skillKey === 'staminaLevel');
        expect(stamina.upgradeLevel).toBe(55);
        expect(calculateUpgradeCost(stamina, buildGameData())).toBeNull();
        // Unarmed counts as melee — Ranged and Magic are excluded here too
        expect(candidates.some((c) => c.skillKey === 'rangedLevel' || c.skillKey === 'magicLevel')).toBe(false);
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

describe('findMatchingCharmForSkill', () => {
    const CHARM = '/equipment_types/charm';
    function charmGameData() {
        const charm = (name, itemLevel, skill) => ({
            name,
            itemLevel,
            equipmentDetail: { type: CHARM, combatStats: { focusTraining: `/skills/${skill}` } },
        });
        return {
            itemDetailMap: {
                '/items/basic_melee_charm': charm('Basic Melee Charm', 10, 'melee'),
                '/items/expert_melee_charm': charm('Expert Melee Charm', 60, 'melee'),
                '/items/basic_defense_charm': charm('Basic Defense Charm', 10, 'defense'),
                '/items/expert_defense_charm': charm('Expert Defense Charm', 60, 'defense'),
            },
        };
    }
    const equipped = { hrid: '/items/expert_melee_charm', enhancementLevel: 5 };

    test('matches the equipped charm tier for another skill, keeping enhancement', () => {
        const result = findMatchingCharmForSkill(equipped, 'defenseLevel', charmGameData());
        expect(result).toEqual({ hrid: '/items/expert_defense_charm', enhancementLevel: 5 });
    });

    test('keeps the equipped charm when it already focuses the skill', () => {
        const result = findMatchingCharmForSkill(equipped, 'meleeLevel', charmGameData());
        expect(result).toEqual({ hrid: '/items/expert_melee_charm', enhancementLevel: 5 });
    });

    test('an explicit tier overrides the equipped charm tier', () => {
        const result = findMatchingCharmForSkill(equipped, 'defenseLevel', charmGameData(), 'Basic');
        expect(result).toEqual({ hrid: '/items/basic_defense_charm', enhancementLevel: 5 });
    });

    test('tier "none" simulates without a charm', () => {
        expect(findMatchingCharmForSkill(equipped, 'defenseLevel', charmGameData(), 'none')).toBeNull();
    });

    test('falls back to the highest-level charm when nothing is equipped', () => {
        const result = findMatchingCharmForSkill(null, 'defenseLevel', charmGameData());
        expect(result).toEqual({ hrid: '/items/expert_defense_charm', enhancementLevel: 0 });
    });
});

describe('getMainTrainingSkills', () => {
    test('unions the weapon primary training skill with its style offense skills', () => {
        const gameData = {
            itemDetailMap: {
                '/items/spear': {
                    equipmentDetail: {
                        type: MAIN_HAND,
                        combatStats: { primaryTraining: '/skills/attack', combatStyleHrids: ['/combat_styles/stab'] },
                    },
                },
            },
            combatStyleDetailMap: {
                '/combat_styles/stab': {
                    // Real skillExpMaps include stamina/intelligence/defense too —
                    // only the offensive skills count as "main"
                    skillExpMap: {
                        '/skills/attack': 0.2,
                        '/skills/melee': 0.2,
                        '/skills/stamina': 0.2,
                        '/skills/intelligence': 0.2,
                        '/skills/defense': 0.2,
                    },
                },
            },
        };
        const player = { equipment: { [MAIN_HAND]: { hrid: '/items/spear', enhancementLevel: 0 } } };
        expect(getMainTrainingSkills(player, gameData).sort()).toEqual(['attack', 'melee']);
    });

    test('defaults to melee with no weapon equipped', () => {
        expect(getMainTrainingSkills({ equipment: {} }, { itemDetailMap: {}, combatStyleDetailMap: {} })).toEqual([
            'melee',
        ]);
    });
});

describe('runLabyrinthAllFightsAnalysis', () => {
    test('unions candidates across loadout styles and ranks by run-clear delta', async () => {
        const gameData = buildGameData();
        gameData.itemDetailMap['/items/fine_bow'] = {
            name: 'Fine Bow',
            itemLevel: 50,
            equipmentDetail: { type: '/equipment_types/two_hand', combatStats: { rangedDamage: 12 } },
        };
        buildGameDataPayload.mockReturnValue(gameData);

        const levels = {
            staminaLevel: 50,
            intelligenceLevel: 50,
            attackLevel: 50,
            meleeLevel: 50,
            defenseLevel: 50,
            rangedLevel: 50,
            magicLevel: 50,
        };
        const meleeDTO = {
            equipment: { [MAIN_HAND]: { hrid: '/items/fine_sword', enhancementLevel: 0 } },
            ...levels,
        };
        const rangedDTO = {
            equipment: { '/equipment_types/two_hand': { hrid: '/items/fine_bow', enhancementLevel: 0 } },
            ...levels,
        };

        // Boosting melee improves the goblin fight only; nothing else moves
        runLabyrinthSimulation.mockImplementation(async ({ playerDTOs, monsterHrid }) => {
            let winRate = monsterHrid === '/monsters/goblin' ? 0.8 : 0.5;
            if (monsterHrid === '/monsters/goblin' && playerDTOs[0].meleeLevel === 55) winRate = 0.9;
            return { labyAttemptCount: 100, encounters: winRate * 100 };
        });

        const result = await runLabyrinthAllFightsAnalysis(
            {
                fights: [
                    { monsterHrid: '/monsters/goblin', monsterName: 'Goblin', roomLevel: 100, dto: meleeDTO },
                    { monsterHrid: '/monsters/wisp', monsterName: 'Wisp', roomLevel: 110, dto: rangedDTO },
                ],
                crates: [],
                hours: 1,
                communityBuffs: {},
                labyrinthCombatBuffs: [],
                abilityTargetLevel: 5,
            },
            null,
            {}
        );

        // Candidate union: melee loadout contributes Melee, ranged loadout
        // contributes Ranged; Magic stays excluded (no loadout trains it)
        expect(result.results.map((r) => r.candidate.skillKey).sort()).toEqual([
            'attackLevel',
            'defenseLevel',
            'intelligenceLevel',
            'meleeLevel',
            'rangedLevel',
            'staminaLevel',
        ]);

        expect(result.baseline.runClearChance).toBeCloseTo(0.8 * 0.5, 5);
        expect(result.baseline.expectedAttempts).toBeCloseTo(1 / 0.8 + 1 / 0.5, 5);

        // Melee gives the only improvement (fewest expected attempts) and ranks first
        expect(result.results[0].candidate.skillKey).toBe('meleeLevel');
        const meleeRow = result.results[0];
        expect(meleeRow.fights[0].winRate).toBeCloseTo(0.9, 5);
        expect(meleeRow.fights[0].winRateDelta).toBeCloseTo(0.1, 5);
        expect(meleeRow.runClearChance).toBeCloseTo(0.9 * 0.5, 5);
        expect(meleeRow.expectedAttempts).toBeCloseTo(1 / 0.9 + 1 / 0.5, 5);
        expect(meleeRow.attemptsDelta).toBeCloseTo(1 / 0.9 - 1 / 0.8, 5);
    });

    test('per-skill target levels flow through to the candidate union', async () => {
        const gameData = buildGameData();
        buildGameDataPayload.mockReturnValue(gameData);
        runLabyrinthSimulation.mockResolvedValue({ labyAttemptCount: 100, encounters: 50 });

        const dto = {
            equipment: { [MAIN_HAND]: { hrid: '/items/fine_sword', enhancementLevel: 0 } },
            staminaLevel: 50,
            meleeLevel: 50,
        };
        const result = await runLabyrinthAllFightsAnalysis(
            {
                fights: [{ monsterHrid: '/monsters/goblin', monsterName: 'Goblin', roomLevel: 100, dto }],
                crates: [],
                hours: 1,
                communityBuffs: {},
                labyrinthCombatBuffs: [],
                abilityTargetLevel: 5,
                combatLevelTargets: { meleeLevel: 60 },
            },
            null,
            {}
        );

        // Only the targeted skill produces a candidate, at its target level
        expect(result.results).toHaveLength(1);
        expect(result.results[0].candidate.skillKey).toBe('meleeLevel');
        expect(result.results[0].candidate.upgradeLevel).toBe(60);
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
