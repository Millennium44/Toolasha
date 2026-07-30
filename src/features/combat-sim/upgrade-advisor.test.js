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
    generateSkillingEquipmentCandidates,
    generateHouseCandidates,
    houseRoomAffectsCombat,
    describeHouseScan,
    resolveCandidateModes,
} = await import('./upgrade-advisor.js');
const { resolveItemPrice } = await import('../../utils/profit-helpers.js');
const { getItemPrices } = await import('../../utils/market-data.js');
const { calculateEnhancement } = await import('../../utils/enhancement-calculator.js');
const { getCheapestProtectionPrice } = await import('../enhancement/tooltip-enhancement.js');
const { getEnhancingParams } = await import('../../utils/enhancement-config.js');
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

describe('generateCandidates ability_level targets', () => {
    test('per-ability target levels override the uniform increment', () => {
        const gameData = buildGameData();
        gameData.abilityDetailMap = {
            '/abilities/cleave': { name: 'Cleave' },
            '/abilities/insanity': { name: 'Insanity' },
        };
        const player = {
            equipment: {},
            abilities: [
                { hrid: '/abilities/cleave', level: 60 },
                { hrid: '/abilities/insanity', level: 20 },
            ],
        };
        const targets = { '/abilities/insanity': 25 };
        const candidates = generateCandidates(player, gameData, 'ability_level', 5, 'increment', false, null, targets);

        // Only the targeted ability produces a candidate, at its target level;
        // Cleave has no entry and is skipped
        expect(candidates).toHaveLength(1);
        expect(candidates[0].upgradeHrid).toBe('/abilities/insanity');
        expect(candidates[0].upgradeLevel).toBe(25);
        expect(candidates[0].description).toBe('Insanity Lv20 → Lv25');
    });

    test('a target at or below the current level skips the ability', () => {
        const gameData = buildGameData();
        gameData.abilityDetailMap = { '/abilities/cleave': { name: 'Cleave' } };
        const player = { equipment: {}, abilities: [{ hrid: '/abilities/cleave', level: 60 }] };
        const candidates = generateCandidates(player, gameData, 'ability_level', 5, 'increment', false, null, {
            '/abilities/cleave': 55,
        });
        expect(candidates).toHaveLength(0);
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

describe('generateSkillingEquipmentCandidates targetSkill filtering', () => {
    function skillingGameData() {
        return {
            itemDetailMap: {
                '/items/spatula': {
                    name: 'Spatula',
                    itemLevel: 50,
                    equipmentDetail: { type: '/equipment_types/tool', noncombatStats: { cookingSpeed: 0.1 } },
                },
                '/items/wisdom_necklace': {
                    name: 'Wisdom Necklace',
                    itemLevel: 50,
                    equipmentDetail: { type: '/equipment_types/neck', noncombatStats: { skillingSpeed: 0.05 } },
                },
            },
        };
    }

    test('restricts candidates to the target skill loadout when set', () => {
        const editorDTO = {
            equipment: { '/equipment_types/tool': { hrid: '/items/spatula', enhancementLevel: 0 } },
        };
        const map = {
            '/skills/alchemy': {
                '/equipment_types/neck': { hrid: '/items/wisdom_necklace', enhancementLevel: 0 },
            },
        };

        const all = generateSkillingEquipmentCandidates(editorDTO, skillingGameData(), map);
        expect(all.map((c) => c.currentHrid).sort()).toEqual(['/items/spatula', '/items/wisdom_necklace']);

        const alchemyOnly = generateSkillingEquipmentCandidates(editorDTO, skillingGameData(), map, '/skills/alchemy');
        expect(alchemyOnly.map((c) => c.currentHrid)).toEqual(['/items/wisdom_necklace']);
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

    test('falls back to base price plus enhancement cost when the level has no listing', () => {
        getItemPrices.mockImplementation((hrid) =>
            hrid === '/items/enhance_mat' ? { ask: 100_000, bid: 90_000 } : null
        );
        resolveItemPrice.mockImplementation((hrid, { enhancementLevel, side }) => {
            if (side === 'sell') return { price: 1_000_000 };
            if (enhancementLevel === 10) return { price: 0 };
            return { price: 5_000_000 };
        });
        calculateEnhancement.mockReturnValue({ attempts: 3, protectionCount: 0 });
        getCheapestProtectionPrice.mockReturnValue({ price: 0 });
        getEnhancingParams.mockReturnValue({
            enhancingLevel: 100,
            toolBonus: 0,
            speedBonus: 0,
            teas: {},
            guzzlingBonus: 1,
        });

        const gameData = buildGameData();
        gameData.itemDetailMap['/items/regal_sword_refined'].enhancementCosts = [
            { itemHrid: '/items/enhance_mat', count: 1 },
        ];

        const cost = calculateUpgradeCost(
            {
                type: 'tier',
                slot: MAIN_HAND,
                currentHrid: '/items/fine_sword',
                currentLevel: 10,
                upgradeHrid: '/items/regal_sword_refined',
                upgradeLevel: 10,
            },
            gameData
        );

        // Base price (5M) + enhancement path cost - sell current (1M); the exact
        // enhance cost depends on the mocked attempt count, so just assert the shape
        expect(cost).toBeGreaterThan(4_000_000);
    });

    test('reports unknown (null) instead of free when the item has no enhancement recipe', () => {
        getItemPrices.mockReturnValue(null);
        resolveItemPrice.mockImplementation((hrid, { enhancementLevel, side }) => {
            if (side === 'sell') return { price: 1_000_000 };
            if (enhancementLevel === 10) return { price: 0 };
            return { price: 5_000_000 };
        });

        // buildGameData()'s items carry no enhancementCosts — pricing a +10 buy
        // is impossible, and reporting 0 would rank this as the best-value upgrade
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

        expect(cost).toBeNull();
    });

    test('enhancement candidates report unknown when the enhance path cannot be priced', () => {
        getItemPrices.mockReturnValue(null);
        resolveItemPrice.mockImplementation(() => ({ price: 0 }));

        const cost = calculateUpgradeCost(
            {
                type: 'enhancement',
                slot: MAIN_HAND,
                currentHrid: '/items/fine_sword',
                currentLevel: 5,
                upgradeHrid: '/items/fine_sword',
                upgradeLevel: 10,
            },
            buildGameData()
        );

        expect(cost).toBeNull();
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

describe('Philosopher accessory candidates', () => {
    const NECK = '/equipment_types/neck';
    const RING = '/equipment_types/ring';

    function buildJewelryGameData() {
        return {
            actionDetailMap: {},
            itemDetailMap: {
                '/items/necklace_of_speed': {
                    name: 'Necklace Of Speed',
                    itemLevel: 60,
                    equipmentDetail: { type: NECK, combatStats: { slashDamage: 2 } },
                },
                '/items/philosophers_necklace': {
                    name: "Philosopher's Necklace",
                    itemLevel: 60,
                    equipmentDetail: { type: NECK, combatStats: { slashDamage: 1 } },
                },
                '/items/philosophers_ring': {
                    name: "Philosopher's Ring",
                    itemLevel: 60,
                    equipmentDetail: { type: RING, combatStats: { slashDamage: 1 } },
                },
            },
        };
    }

    test('offers the philo accessory at +5 even when current jewelry is enhanced higher', () => {
        const player = { equipment: { [NECK]: { hrid: '/items/necklace_of_speed', enhancementLevel: 12 } } };

        const candidates = generateCandidates(player, buildJewelryGameData(), 'equipment');
        const philo = candidates.find((c) => c.upgradeHrid === '/items/philosophers_necklace');

        expect(philo).toBeDefined();
        expect(philo.upgradeLevel).toBe(5);
        expect(philo.currentLevel).toBe(12);
    });

    test('does not offer a philo swap when the philo accessory is already worn', () => {
        const player = { equipment: { [NECK]: { hrid: '/items/philosophers_necklace', enhancementLevel: 3 } } };

        const candidates = generateCandidates(player, buildJewelryGameData(), 'equipment');
        const philoSwaps = candidates.filter(
            (c) => c.type === 'tier' && c.upgradeHrid === '/items/philosophers_necklace'
        );

        expect(philoSwaps).toHaveLength(0);
    });

    test('skips jewelry slots with nothing equipped', () => {
        const player = { equipment: { [NECK]: null } };

        const candidates = generateCandidates(player, buildJewelryGameData(), 'equipment');

        expect(candidates.filter((c) => c.upgradeHrid?.startsWith('/items/philosophers_'))).toHaveLength(0);
    });

    test('skilling candidates also include the philo accessory at +5', () => {
        resolveItemPrice.mockImplementation(() => ({ price: 0 }));
        getItemPrices.mockReturnValue(null);
        const gameData = buildJewelryGameData();
        gameData.itemDetailMap['/items/necklace_of_speed'].equipmentDetail.noncombatStats = { skillingSpeed: 1 };

        const editorDTO = { equipment: { [NECK]: { hrid: '/items/necklace_of_speed', enhancementLevel: 12 } } };
        const candidates = generateSkillingEquipmentCandidates(editorDTO, gameData);
        const philo = candidates.find((c) => c.upgradeHrid === '/items/philosophers_necklace');

        expect(philo).toBeDefined();
        expect(philo.upgradeLevel).toBe(5);
    });
});

describe('tier progression sidegrade guard', () => {
    function buildSiblingGameData() {
        return {
            actionDetailMap: {},
            itemDetailMap: {
                // Two T50 melee swords: same slot, same role, same item level
                '/items/sword_a': {
                    name: 'Sword A',
                    itemLevel: 50,
                    sortIndex: 1,
                    equipmentDetail: { type: MAIN_HAND, combatStats: { slashDamage: 10 } },
                },
                '/items/sword_b': {
                    name: 'Sword B',
                    itemLevel: 50,
                    sortIndex: 2,
                    equipmentDetail: { type: MAIN_HAND, combatStats: { slashDamage: 10 } },
                },
                '/items/sword_c': {
                    name: 'Sword C',
                    itemLevel: 70,
                    sortIndex: 3,
                    equipmentDetail: { type: MAIN_HAND, combatStats: { slashDamage: 20 } },
                },
            },
        };
    }

    test('skips a same-item-level sibling and suggests the next real tier instead', () => {
        const candidates = generateCandidates(buildPlayer('/items/sword_a', 5), buildSiblingGameData(), 'equipment');
        const tiers = candidates.filter((c) => c.type === 'tier');

        // Sword B is the immediate neighbour but the same tier — a paid sidegrade
        expect(tiers.some((c) => c.upgradeHrid === '/items/sword_b')).toBe(false);
        expect(tiers.some((c) => c.upgradeHrid === '/items/sword_c')).toBe(true);
    });

    test('still suggests a refined variant sharing the base item level', () => {
        const gameData = buildSiblingGameData();
        gameData.itemDetailMap['/items/sword_a_refined'] = {
            name: 'Sword A (R)',
            itemLevel: 50,
            sortIndex: 4,
            equipmentDetail: { type: MAIN_HAND, combatStats: { slashDamage: 14 } },
        };

        const candidates = generateCandidates(buildPlayer('/items/sword_a', 10), gameData, 'equipment');
        const tiers = candidates.filter((c) => c.type === 'tier');

        expect(tiers.some((c) => c.upgradeHrid === '/items/sword_a_refined')).toBe(true);
    });
});

describe('resolveCandidateModes', () => {
    test('uses the checked sets and drops the food pseudo-mode', () => {
        expect(resolveCandidateModes(['equipment', 'house', 'food'])).toEqual(['equipment', 'house']);
    });

    test('deduplicates repeated sets', () => {
        expect(resolveCandidateModes(['equipment', 'equipment'])).toEqual(['equipment']);
    });

    test('expands the legacy combined mode', () => {
        expect(resolveCandidateModes(undefined, 'combined')).toEqual(['equipment', 'ability_level']);
    });

    test('passes a legacy single mode through', () => {
        expect(resolveCandidateModes(undefined, 'ability_swap')).toEqual(['ability_swap']);
    });

    test('falls back to equipment with nothing specified', () => {
        expect(resolveCandidateModes(undefined, undefined)).toEqual(['equipment']);
        expect(resolveCandidateModes([], undefined)).toEqual(['equipment']);
    });
});

describe('house upgrade candidates', () => {
    const ROOM_TAGGED = { usableInActionTypeMap: { '/action_types/combat': true } };
    const BUFF_TAGGED = { typeHrid: '/buff_types/mystery', usableInActionTypeMap: { '/action_types/combat': true } };
    const COMBAT_TYPE_BUFF = { typeHrid: '/buff_types/armor' };
    const SKILL_BUFF = {
        typeHrid: '/buff_types/action_speed',
        usableInActionTypeMap: { '/action_types/brewing': true },
    };

    function houseGameData() {
        return {
            houseRoomDetailMap: {
                '/house_rooms/dojo': {
                    name: 'Dojo',
                    actionBuffs: [COMBAT_TYPE_BUFF],
                    upgradeCostsMap: {
                        4: [
                            { itemHrid: '/items/coin', count: 1_000_000 },
                            { itemHrid: '/items/lumber', count: 10 },
                        ],
                        5: [{ itemHrid: '/items/coin', count: 2_000_000 }],
                    },
                },
                '/house_rooms/brewery': {
                    name: 'Brewery',
                    actionBuffs: [SKILL_BUFF],
                    upgradeCostsMap: { 1: [{ itemHrid: '/items/coin', count: 100 }] },
                },
                '/house_rooms/gym': {
                    name: 'Gym',
                    globalBuffs: [COMBAT_TYPE_BUFF],
                    upgradeCostsMap: {},
                },
            },
        };
    }

    describe('combat relevance', () => {
        test('accepts a room tagged for combat on the room itself', () => {
            expect(houseRoomAffectsCombat({ ...ROOM_TAGGED, actionBuffs: [SKILL_BUFF] })).toBe(true);
        });

        test('accepts a room whose buff is tagged for combat', () => {
            expect(houseRoomAffectsCombat({ actionBuffs: [BUFF_TAGGED] })).toBe(true);
        });

        test('accepts a room whose buff type the combat engine reads', () => {
            expect(houseRoomAffectsCombat({ globalBuffs: [COMBAT_TYPE_BUFF] })).toBe(true);
        });

        test('rejects a skilling-only room', () => {
            expect(houseRoomAffectsCombat({ actionBuffs: [SKILL_BUFF] })).toBe(false);
        });

        test('rejects a room with no buffs at all', () => {
            expect(houseRoomAffectsCombat({ name: 'Empty' })).toBe(false);
            expect(houseRoomAffectsCombat(null)).toBe(false);
        });
    });

    test('offers one level per combat-relevant room and skips skilling rooms', () => {
        const candidates = generateHouseCandidates(
            { houseRooms: { '/house_rooms/dojo': 3, '/house_rooms/brewery': 0, '/house_rooms/gym': 0 } },
            houseGameData()
        );

        expect(candidates.map((c) => c.roomHrid).sort()).toEqual(['/house_rooms/dojo', '/house_rooms/gym']);
        const dojo = candidates.find((c) => c.roomHrid === '/house_rooms/dojo');
        expect(dojo.currentLevel).toBe(3);
        expect(dojo.upgradeLevel).toBe(4);
        expect(dojo.description).toBe('Dojo Lv3 → Lv4');
    });

    test('skips rooms already at the level cap', () => {
        const candidates = generateHouseCandidates({ houseRooms: { '/house_rooms/dojo': 8 } }, houseGameData());
        expect(candidates.some((c) => c.roomHrid === '/house_rooms/dojo')).toBe(false);
    });

    test('jumps straight to a target level when one is given', () => {
        const candidates = generateHouseCandidates({ houseRooms: { '/house_rooms/dojo': 3 } }, houseGameData(), 6);
        const dojo = candidates.find((c) => c.roomHrid === '/house_rooms/dojo');

        expect(dojo.upgradeLevel).toBe(6);
        expect(dojo.description).toBe('Dojo Lv3 → Lv6');
    });

    test('skips rooms already at or above the target level', () => {
        const candidates = generateHouseCandidates({ houseRooms: { '/house_rooms/dojo': 6 } }, houseGameData(), 6);
        expect(candidates.some((c) => c.roomHrid === '/house_rooms/dojo')).toBe(false);
    });

    test('clamps a target level above the cap', () => {
        const candidates = generateHouseCandidates({ houseRooms: { '/house_rooms/dojo': 3 } }, houseGameData(), 99);
        expect(candidates.find((c) => c.roomHrid === '/house_rooms/dojo').upgradeLevel).toBe(8);
    });

    test('costs coins at face value plus the market price of each material', () => {
        resolveItemPrice.mockImplementation((hrid) => ({ price: hrid === '/items/lumber' ? 2_000 : 0 }));

        const cost = calculateUpgradeCost(
            { type: 'house', roomHrid: '/house_rooms/dojo', currentLevel: 3, upgradeLevel: 4 },
            houseGameData()
        );

        expect(cost).toBe(1_000_000 + 10 * 2_000);
    });

    test('sums every level when jumping more than one', () => {
        resolveItemPrice.mockImplementation((hrid) => ({ price: hrid === '/items/lumber' ? 2_000 : 0 }));

        const cost = calculateUpgradeCost(
            { type: 'house', roomHrid: '/house_rooms/dojo', currentLevel: 3, upgradeLevel: 5 },
            houseGameData()
        );

        expect(cost).toBe(1_000_000 + 10 * 2_000 + 2_000_000);
    });

    test('reports unknown when a material has no price', () => {
        resolveItemPrice.mockImplementation(() => ({ price: 0 }));

        const cost = calculateUpgradeCost(
            { type: 'house', roomHrid: '/house_rooms/dojo', currentLevel: 3, upgradeLevel: 4 },
            houseGameData()
        );

        expect(cost).toBe(null);
    });

    test('reports unknown when any level in the span has no cost recipe', () => {
        resolveItemPrice.mockImplementation(() => ({ price: 2_000 }));

        const cost = calculateUpgradeCost(
            // Level 6 has no recipe in the fixture
            { type: 'house', roomHrid: '/house_rooms/dojo', currentLevel: 3, upgradeLevel: 6 },
            houseGameData()
        );

        expect(cost).toBe(null);
    });

    test('reports unknown when the level has no cost recipe', () => {
        const cost = calculateUpgradeCost(
            { type: 'house', roomHrid: '/house_rooms/gym', currentLevel: 0, upgradeLevel: 1 },
            houseGameData()
        );

        expect(cost).toBe(null);
    });

    describe('describeHouseScan', () => {
        test('counts rooms, buffed rooms, combat rooms and upgradable rooms', () => {
            const scan = describeHouseScan({ houseRooms: { '/house_rooms/dojo': 8 } }, houseGameData());

            expect(scan).toEqual({ rooms: 3, withBuffs: 3, combatRelevant: 2, belowCap: 1 });
        });

        test('reports zeroes with no house data', () => {
            expect(describeHouseScan({}, {})).toEqual({ rooms: 0, withBuffs: 0, combatRelevant: 0, belowCap: 0 });
        });
    });
});
