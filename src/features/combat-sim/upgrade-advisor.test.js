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
    // Fights run several at a time; one at a time in tests keeps the order of
    // the mock's calls readable
    getMaxWorkers: () => 4,
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
vi.mock('../../utils/ability-cost-calculator.js', () => ({
    calculateAbilityLevelUpCost: vi.fn(),
    explainAbilityLevelUpCost: vi.fn(() => ({
        bookHrid: '/items/fireball',
        bookName: 'Fireball',
        books: 12.4,
        xpPerBook: 50,
        bookPrice: 1000,
        total: 12_400,
        learnBook: false,
    })),
}));
vi.mock('./skilling-sim-helpers.js', () => ({ buildOverridesForSkill: vi.fn() }));

const {
    generateCandidates,
    applyCandidateToDTO,
    calculateUpgradeCost,
    findMatchingCharmForSkill,
    getMainTrainingSkills,
    runLabyrinthAllFightsAnalysis,
    runLabyrinthCombinationCheck,
    generateSkillingEquipmentCandidates,
    generateHouseCandidates,
    houseRoomAffectsCombat,
    describeHouseScan,
    resolveCandidateModes,
    candidateAssignmentKey,
    candidateAppliesToDTO,
    applyToEquipment,
    attemptsNoise,
    conflictKey,
    planWithinBudget,
    explainUpgradeCost,
    computeEconomics,
    assignRankScores,
    RANK_PLACES,
    SCORE_METRICS,
    DEFAULT_SCORE_KEYS,
} = await import('./upgrade-advisor.js');
const { resolveItemPrice } = await import('../../utils/profit-helpers.js');
const { getItemPrices } = await import('../../utils/market-data.js');
const { calculateEnhancement } = await import('../../utils/enhancement-calculator.js');
const { getCheapestProtectionPrice } = await import('../enhancement/tooltip-enhancement.js');
const { getEnhancingParams } = await import('../../utils/enhancement-config.js');
const { explainAbilityLevelUpCost } = await import('../../utils/ability-cost-calculator.js');
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

    test('a weapon upgrade is only simmed against the loadouts carrying that weapon', async () => {
        // Installing a melee sword into a ranged loadout replaces the bow with a
        // sword: not an upgrade, a costume change, and it comes back as a large
        // negative for a room nobody would ever have applied it to
        const gameData = buildGameData();
        gameData.itemDetailMap['/items/fine_bow'] = {
            name: 'Fine Bow',
            itemLevel: 50,
            sortIndex: 5,
            equipmentDetail: { type: '/equipment_types/two_hand', combatStats: { rangedDamage: 12 } },
        };
        buildGameDataPayload.mockReturnValue(gameData);
        runLabyrinthSimulation.mockResolvedValue({ labyAttemptCount: 100, encounters: 50 });
        resolveItemPrice.mockImplementation(() => ({ price: 1_000_000 }));
        getItemPrices.mockReturnValue({ ask: 2_000_000, bid: 1_500_000 });

        const meleeDTO = {
            equipment: { [MAIN_HAND]: { hrid: '/items/fine_sword', enhancementLevel: 0 } },
            meleeLevel: 50,
        };
        const rangedDTO = {
            equipment: { '/equipment_types/two_hand': { hrid: '/items/fine_bow', enhancementLevel: 0 } },
            rangedLevel: 50,
        };

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
                modes: ['equipment'],
            },
            null,
            {}
        );

        const sword = result.results.find((r) => r.candidate.currentHrid === '/items/fine_sword');
        expect(sword.appliedFights).toBe(1);
        expect(sword.fights[0].applied).toBe(true);
        expect(sword.fights[1]).toMatchObject({ applied: false, winRateDelta: 0 });
    });

    test('and the room it does not reach keeps its baseline exactly', async () => {
        const gameData = buildGameData();
        gameData.itemDetailMap['/items/fine_bow'] = {
            name: 'Fine Bow',
            itemLevel: 50,
            sortIndex: 5,
            equipmentDetail: { type: '/equipment_types/two_hand', combatStats: { rangedDamage: 12 } },
        };
        buildGameDataPayload.mockReturnValue(gameData);
        // The ranged room would come back at a different rate if it were simmed
        // with a sword in hand; it must not be simmed at all
        // The wisp room reads completely differently with a sword in hand — so
        // if it were simmed with one, the baseline comparison would say so
        runLabyrinthSimulation.mockImplementation(async ({ monsterHrid, playerDTOs }) => {
            if (monsterHrid !== '/monsters/wisp') return { labyAttemptCount: 100, encounters: 50 };
            const armed = Boolean(playerDTOs[0].equipment?.[MAIN_HAND]);
            return { labyAttemptCount: 100, encounters: armed ? 90 : 20 };
        });
        resolveItemPrice.mockImplementation(() => ({ price: 1_000_000 }));
        getItemPrices.mockReturnValue({ ask: 2_000_000, bid: 1_500_000 });

        const result = await runLabyrinthAllFightsAnalysis(
            {
                fights: [
                    {
                        monsterHrid: '/monsters/goblin',
                        monsterName: 'Goblin',
                        roomLevel: 100,
                        dto: { equipment: { [MAIN_HAND]: { hrid: '/items/fine_sword', enhancementLevel: 0 } } },
                    },
                    {
                        monsterHrid: '/monsters/wisp',
                        monsterName: 'Wisp',
                        roomLevel: 110,
                        // A two-hander: a main-hand sword cannot go in beside it
                        dto: {
                            equipment: {
                                '/equipment_types/two_hand': { hrid: '/items/fine_bow', enhancementLevel: 0 },
                                [BACK]: { hrid: '/items/plain_cape', enhancementLevel: 0 },
                            },
                        },
                    },
                ],
                crates: [],
                hours: 1,
                communityBuffs: {},
                labyrinthCombatBuffs: [],
                modes: ['equipment'],
            },
            null,
            {}
        );

        const sword = result.results.find(
            (r) => r.candidate.slot === MAIN_HAND && r.candidate.currentHrid === '/items/fine_sword'
        );
        expect(sword.fights[1].winRate).toBe(result.baseline.fights[1].winRate);
    });

    test('each result carries the error behind its own number', async () => {
        // Without it a lucky run on one 30% room reads as an upgrade worth
        // billions, and nothing in the table says otherwise
        const gameData = buildGameData();
        buildGameDataPayload.mockReturnValue(gameData);
        runLabyrinthSimulation.mockResolvedValue({ labyAttemptCount: 200, encounters: 100 });

        const result = await runLabyrinthAllFightsAnalysis(
            {
                fights: [
                    {
                        monsterHrid: '/monsters/goblin',
                        monsterName: 'Goblin',
                        roomLevel: 100,
                        dto: { staminaLevel: 50, meleeLevel: 50 },
                    },
                ],
                crates: [],
                hours: 1,
                communityBuffs: {},
                labyrinthCombatBuffs: [],
                combatLevelTargets: { meleeLevel: 60 },
            },
            null,
            {}
        );

        const row = result.results[0];
        expect(row.attemptsDeltaNoise).toBeGreaterThan(0);
        // Identical sims mean a delta of exactly zero, which is the clearest
        // case of "not measured" there is
        expect(row.significant).toBe(false);
    });

    test('fights run several at a time rather than one after another', async () => {
        // Each fight is its own worker with its own seed, so running them in
        // series left the rest of the machine idle for the length of the run
        const gameData = buildGameData();
        buildGameDataPayload.mockReturnValue(gameData);
        let running = 0;
        let peak = 0;
        runLabyrinthSimulation.mockImplementation(async () => {
            running++;
            peak = Math.max(peak, running);
            await new Promise((resolve) => setTimeout(resolve, 0));
            running--;
            return { labyAttemptCount: 100, encounters: 50 };
        });

        const fights = [0, 1, 2, 3].map((i) => ({
            monsterHrid: `/monsters/m${i}`,
            monsterName: `M${i}`,
            roomLevel: 100,
            dto: { staminaLevel: 50, meleeLevel: 50 },
        }));

        await runLabyrinthAllFightsAnalysis(
            {
                fights,
                crates: [],
                hours: 1,
                communityBuffs: {},
                labyrinthCombatBuffs: [],
                combatLevelTargets: { meleeLevel: 60 },
            },
            null,
            {}
        );

        expect(peak).toBeGreaterThan(1);
    });

    test('the progress total counts the sims it will actually run', async () => {
        // A total that assumed every candidate against every fight would leave
        // the bar stuck short of the end, which reads as a run that hung
        const gameData = buildGameData();
        buildGameDataPayload.mockReturnValue(gameData);
        runLabyrinthSimulation.mockResolvedValue({ labyAttemptCount: 100, encounters: 50 });
        runLabyrinthSimulation.mockClear();
        resolveItemPrice.mockImplementation(() => ({ price: 1_000_000 }));
        getItemPrices.mockReturnValue({ ask: 2_000_000, bid: 1_500_000 });
        const seen = [];

        const result = await runLabyrinthAllFightsAnalysis(
            {
                fights: [
                    {
                        monsterHrid: '/monsters/goblin',
                        monsterName: 'Goblin',
                        roomLevel: 100,
                        dto: { equipment: { [MAIN_HAND]: { hrid: '/items/fine_sword', enhancementLevel: 0 } } },
                    },
                    {
                        monsterHrid: '/monsters/wisp',
                        monsterName: 'Wisp',
                        roomLevel: 110,
                        dto: { equipment: { [BACK]: { hrid: '/items/plain_cape', enhancementLevel: 0 } } },
                    },
                ],
                crates: [],
                hours: 1,
                communityBuffs: {},
                labyrinthCombatBuffs: [],
                modes: ['equipment'],
            },
            (progress) => seen.push(progress),
            {}
        );
        const candidateCount = result.results.length;

        const { total } = seen[seen.length - 1];
        const everyCandidateEverywhere = 2 * (candidateCount + 1);
        expect(runLabyrinthSimulation.mock.calls.length).toBe(total);
        expect(total).toBeLessThan(everyCandidateEverywhere);
    });
});

describe('whether an upgrade is about this loadout at all', () => {
    const swordDTO = {
        equipment: { [MAIN_HAND]: { hrid: '/items/fine_sword', enhancementLevel: 3 } },
        abilities: [{ hrid: '/abilities/fierce_aura', level: 10 }, { hrid: '/abilities/smack', level: 20 }, null],
    };

    test('a combat level is every fight, because levels are not worn', () => {
        expect(candidateAppliesToDTO({ type: 'combat_level', skillKey: 'meleeLevel' }, swordDTO)).toBe(true);
    });

    test('a tier upgrade where the piece it replaces is worn', () => {
        const candidate = {
            type: 'tier',
            slot: MAIN_HAND,
            currentHrid: '/items/fine_sword',
            upgradeHrid: '/items/regal_sword_refined',
            upgradeLevel: 10,
        };

        expect(candidateAppliesToDTO(candidate, swordDTO)).toBe(true);
    });

    test('and anywhere else the same purchase would be an upgrade too', () => {
        // One purchase serves every loadout. Matching only the exact item it was
        // generated against credited it for one room and charged full price
        const candidate = {
            type: 'tier',
            slot: MAIN_HAND,
            currentHrid: '/items/fine_sword',
            upgradeHrid: '/items/regal_sword_refined',
            upgradeLevel: 10,
        };
        const otherSword = { equipment: { [MAIN_HAND]: { hrid: '/items/plain_sword', enhancementLevel: 0 } } };
        const gameData = {
            itemDetailMap: {
                '/items/regal_sword_refined': {
                    itemLevel: 60,
                    equipmentDetail: { combatStats: { slashDamage: 15 } },
                },
                '/items/plain_sword': { itemLevel: 40, equipmentDetail: { combatStats: { slashDamage: 5 } } },
                '/items/master_sword': { itemLevel: 80, equipmentDetail: { combatStats: { slashDamage: 25 } } },
                '/items/fine_staff': { itemLevel: 40, equipmentDetail: { combatStats: { magicDamage: 9 } } },
            },
        };

        expect(candidateAppliesToDTO(candidate, otherSword, gameData)).toBe(true);
    });

    test('but never a step down, nor into a loadout that fights another way', () => {
        const candidate = {
            type: 'tier',
            slot: MAIN_HAND,
            currentHrid: '/items/fine_sword',
            upgradeHrid: '/items/regal_sword_refined',
            upgradeLevel: 10,
        };
        const gameData = {
            itemDetailMap: {
                '/items/regal_sword_refined': {
                    itemLevel: 60,
                    equipmentDetail: { combatStats: { slashDamage: 15 } },
                },
                '/items/master_sword': { itemLevel: 80, equipmentDetail: { combatStats: { slashDamage: 25 } } },
                '/items/fine_staff': { itemLevel: 40, equipmentDetail: { combatStats: { magicDamage: 9 } } },
            },
        };
        const better = { equipment: { [MAIN_HAND]: { hrid: '/items/master_sword', enhancementLevel: 0 } } };
        const caster = { equipment: { [MAIN_HAND]: { hrid: '/items/fine_staff', enhancementLevel: 0 } } };

        expect(candidateAppliesToDTO(candidate, better, gameData)).toBe(false);
        expect(candidateAppliesToDTO(candidate, caster, gameData)).toBe(false);
    });

    test('and not into a hand that a two-hander is already using', () => {
        // A sword installed beside a bow is a kit the game would never wear;
        // trading between them is what the cross-slot candidates are for
        const candidate = {
            type: 'tier',
            slot: MAIN_HAND,
            currentHrid: '/items/fine_sword',
            upgradeHrid: '/items/regal_sword_refined',
            upgradeLevel: 10,
        };
        const archer = {
            equipment: { '/equipment_types/two_hand': { hrid: '/items/fine_bow', enhancementLevel: 0 } },
        };

        expect(candidateAppliesToDTO(candidate, archer, {})).toBe(false);
    });

    test('an enhancement not once the piece is already at that level', () => {
        const candidate = {
            type: 'enhancement',
            slot: MAIN_HAND,
            currentHrid: '/items/fine_sword',
            upgradeHrid: '/items/fine_sword',
            upgradeLevel: 3,
        };

        expect(candidateAppliesToDTO(candidate, swordDTO)).toBe(false);
        expect(candidateAppliesToDTO({ ...candidate, upgradeLevel: 7 }, swordDTO)).toBe(true);
    });

    test('filling a bare slot only where the slot is bare', () => {
        const candidate = { type: 'tier', slot: BACK, currentHrid: '', upgradeHrid: '/items/plain_cape' };

        expect(candidateAppliesToDTO(candidate, swordDTO)).toBe(true);
        expect(candidateAppliesToDTO(candidate, { equipment: { [BACK]: { hrid: '/items/plain_cape' } } })).toBe(false);
    });

    test('an ability level only where the loadout casts it', () => {
        const candidate = {
            type: 'ability_level',
            slot: 'ability_1',
            upgradeHrid: '/abilities/smack',
            upgradeLevel: 30,
        };

        expect(candidateAppliesToDTO(candidate, swordDTO)).toBe(true);
        expect(candidateAppliesToDTO({ ...candidate, upgradeHrid: '/abilities/fireball' }, swordDTO)).toBe(false);
    });

    test('but an ability swap brings its own, so it applies anywhere it is not already up', () => {
        const swap = {
            type: 'ability_swap',
            slot: 'ability_0',
            upgradeHrid: '/abilities/critical_aura',
            upgradeLevel: 20,
        };

        expect(candidateAppliesToDTO(swap, swordDTO)).toBe(true);
        expect(candidateAppliesToDTO(swap, { abilities: [{ hrid: '/abilities/critical_aura', level: 20 }] })).toBe(
            false
        );
    });

    test('a cross-slot swap needs every piece it would remove', () => {
        const candidate = {
            type: 'cross_slot',
            addedSlots: { '/equipment_types/two_hand': { hrid: '/items/fine_bow' } },
            clearedSlots: [MAIN_HAND],
            removedItems: [{ hrid: '/items/fine_sword' }],
        };

        expect(candidateAppliesToDTO(candidate, swordDTO)).toBe(true);
        expect(candidateAppliesToDTO(candidate, { equipment: {} })).toBe(false);
    });

    test('nothing to apply it to is not an application', () => {
        expect(candidateAppliesToDTO({ type: 'tier', slot: MAIN_HAND }, null)).toBe(false);
        expect(candidateAppliesToDTO(null, swordDTO)).toBe(false);
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
        const enhancements = all.filter((c) => c.type === 'enhancement');
        expect(enhancements.map((c) => c.currentHrid).sort()).toEqual(['/items/spatula', '/items/wisdom_necklace']);

        // The necklace is generic skilling gear, so every skill not already
        // wearing it is offered one — and each offer names the skill it is for
        const offers = all.filter((c) => c.type === 'skilling_gear');
        expect(offers.length).toBeGreaterThan(0);
        expect(offers.every((c) => c.skillKey)).toBe(true);
        expect(offers.some((c) => c.skillKey === '/skills/alchemy')).toBe(false);

        const alchemyOnly = generateSkillingEquipmentCandidates(editorDTO, skillingGameData(), map, '/skills/alchemy');
        expect(alchemyOnly.map((c) => c.currentHrid)).toEqual(['/items/wisdom_necklace']);
    });
});

describe('the off-hand a two-hander is traded for', () => {
    const TWO_HAND = '/equipment_types/two_hand';
    const MAIN = '/equipment_types/main_hand';
    const OFF = '/equipment_types/off_hand';

    function weaponGameData() {
        return {
            actionDetailMap: {},
            itemDetailMap: {
                '/items/cursed_bow': {
                    name: 'Cursed Bow',
                    itemLevel: 80,
                    equipmentDetail: { type: TWO_HAND, combatStats: { rangedDamage: 30, rangedAccuracy: 10 } },
                },
                '/items/sundering_crossbow': {
                    name: 'Sundering Crossbow',
                    itemLevel: 90,
                    equipmentDetail: { type: MAIN, combatStats: { rangedDamage: 25, rangedAccuracy: 8 } },
                },
                '/items/manticore_shield': {
                    name: 'Manticore Shield',
                    itemLevel: 70,
                    equipmentDetail: { type: OFF, combatStats: { rangedAccuracy: 5, armor: 2 } },
                },
                '/items/knights_aegis': {
                    name: "Knight's Aegis",
                    itemLevel: 85,
                    equipmentDetail: { type: OFF, combatStats: { slashAccuracy: 9, armor: 12 } },
                },
                '/items/plain_buckler': {
                    name: 'Plain Buckler',
                    itemLevel: 75,
                    equipmentDetail: { type: OFF, combatStats: { armor: 8 } },
                },
            },
        };
    }

    const offHandsOffered = (gameData) => {
        const player = { equipment: { [TWO_HAND]: { hrid: '/items/cursed_bow', enhancementLevel: 10 } } };
        return generateCandidates(player, gameData, 'equipment')
            .filter((c) => c.type === 'cross_slot' && c.addedSlots?.[OFF])
            .map((c) => c.addedSlots[OFF].hrid);
    };

    test('never one built for another style, however high its item level', () => {
        // A shield with melee accuracy paired with a crossbow offers a ranged
        // build a piece whose whole offensive contribution is dead weight
        expect(offHandsOffered(weaponGameData())).not.toContain('/items/knights_aegis');
    });

    test('the one that matches the weapon is offered', () => {
        expect(offHandsOffered(weaponGameData())).toContain('/items/manticore_shield');
    });

    test('and a purely defensive one, which suits anybody', () => {
        expect(offHandsOffered(weaponGameData())).toContain('/items/plain_buckler');
    });

    test('a melee weapon is offered the melee shield, which is what it is for', () => {
        const gameData = weaponGameData();
        gameData.itemDetailMap['/items/cursed_bow'].equipmentDetail.combatStats = {
            slashDamage: 30,
            slashAccuracy: 10,
        };
        gameData.itemDetailMap['/items/sundering_crossbow'].equipmentDetail.combatStats = {
            slashDamage: 25,
            slashAccuracy: 8,
        };

        expect(offHandsOffered(gameData)).toContain('/items/knights_aegis');
    });
});

describe('what a set of upgrades is worth together', () => {
    const MAIN = '/equipment_types/main_hand';

    function comboSetup() {
        const gameData = buildGameData();
        buildGameDataPayload.mockReturnValue(gameData);
        const fights = [
            {
                monsterHrid: '/monsters/goblin',
                monsterName: 'Goblin',
                roomLevel: 100,
                dto: { equipment: { [MAIN]: { hrid: '/items/fine_sword', enhancementLevel: 0 } }, meleeLevel: 50 },
            },
        ];
        return {
            picks: [
                {
                    candidate: {
                        type: 'combat_level',
                        skillKey: 'meleeLevel',
                        slot: 'combat_level|meleeLevel',
                        upgradeLevel: 55,
                        description: 'Melee 50 → 55',
                    },
                    attemptsDelta: -1,
                },
                {
                    candidate: {
                        type: 'tier',
                        slot: MAIN,
                        currentHrid: '/items/fine_sword',
                        upgradeHrid: '/items/regal_sword_refined',
                        upgradeLevel: 10,
                        description: 'Fine Sword → Regal Sword',
                    },
                    attemptsDelta: -1,
                },
            ],
            baseline: {
                fights: [{ monsterHrid: '/monsters/goblin', roomLevel: 100, winRate: 0.5, trials: 100 }],
                expectedAttempts: 2,
            },
            context: { fights, crates: [], hours: 1, communityBuffs: {}, labyrinthCombatBuffs: [] },
            pairing: { seed: 7, rules: [] },
        };
    }

    test('the pair is simulated wearing both at once', async () => {
        const setup = comboSetup();
        runLabyrinthSimulation.mockImplementation(async ({ playerDTOs }) => {
            const dto = playerDTOs[0];
            const both = dto.meleeLevel === 55 && dto.equipment[MAIN].hrid === '/items/regal_sword_refined';
            return { labyAttemptCount: 100, encounters: both ? 80 : 50 };
        });

        const check = await runLabyrinthCombinationCheck(setup, null, {});

        expect(check.fights[0].winRate).toBeCloseTo(0.8, 5);
        expect(check.fights[0].installed).toHaveLength(2);
    });

    test('and the overlap is what the parts promised but the set did not deliver', async () => {
        // Two upgrades that both rescue the same room each got credited with
        // rescuing it; only one of them can be the reason it is now won
        const setup = comboSetup();
        runLabyrinthSimulation.mockResolvedValue({ labyAttemptCount: 100, encounters: 66.7 });

        const check = await runLabyrinthCombinationCheck(setup, null, {});

        expect(check.summedDelta).toBe(-2);
        expect(check.attemptsDelta).toBeCloseTo(1.5 - 2, 1);
        expect(check.overlap).toBeGreaterThan(0);
    });

    test('an upgrade that does not belong in a loadout is not installed there', async () => {
        const setup = comboSetup();
        setup.context.fights[0].dto.equipment = {
            '/equipment_types/two_hand': { hrid: '/items/grand_cape_refined', enhancementLevel: 0 },
        };
        runLabyrinthSimulation.mockResolvedValue({ labyAttemptCount: 100, encounters: 50 });

        const check = await runLabyrinthCombinationCheck(setup, null, {});

        expect(check.fights[0].installed).toEqual(['Melee 50 → 55']);
    });

    test('two picks for one slot are not both worn — the room gets the better one', async () => {
        // The plan buys a second chestpiece for the rooms the first cannot
        // reach; a room that both fit wears whichever is better *there*, which
        // is exactly what the second one was valued at
        const setup = comboSetup();
        setup.picks = [
            {
                candidate: {
                    type: 'tier',
                    slot: MAIN,
                    currentHrid: '/items/fine_sword',
                    upgradeHrid: '/items/regal_sword_refined',
                    upgradeLevel: 10,
                    description: 'Regal Sword',
                },
                attemptsDelta: -1,
                fights: [{ winRateDelta: 0.02 }],
            },
            {
                candidate: {
                    type: 'tier',
                    slot: MAIN,
                    currentHrid: '/items/fine_sword',
                    upgradeHrid: '/items/grand_cape_refined',
                    upgradeLevel: 10,
                    description: 'Other Sword',
                },
                attemptsDelta: -1,
                fights: [{ winRateDelta: 0.11 }],
            },
        ];
        runLabyrinthSimulation.mockResolvedValue({ labyAttemptCount: 100, encounters: 60 });

        const check = await runLabyrinthCombinationCheck(setup, null, {});

        expect(check.fights[0].installed).toEqual(['Other Sword']);
    });

    test('nothing to check is an error rather than a confident zero', async () => {
        const setup = comboSetup();

        await expect(runLabyrinthCombinationCheck({ ...setup, picks: [] }, null, {})).rejects.toThrow();
    });
});

describe('how much of a gain is measurement', () => {
    const fight = (winRate, trials, monsterHrid = '/monsters/goblin', roomLevel = 100) => ({
        monsterHrid,
        roomLevel,
        winRate,
        trials,
    });

    test('a bigger sample is a smaller error', () => {
        const few = attemptsNoise([fight(0.5, 100)], [fight(0.5, 100)]);
        const many = attemptsNoise([fight(0.5, 10_000)], [fight(0.5, 10_000)]);

        expect(many).toBeLessThan(few / 5);
    });

    test('a low win rate is far noisier, because 1/p magnifies it', () => {
        // The tries figure at 5% moves twenty times as far per point of win
        // rate as it does at 50% — which is exactly where a lucky run reads as
        // an upgrade worth billions
        const middling = attemptsNoise([fight(0.5, 1000)], [fight(0.5, 1000)]);
        const desperate = attemptsNoise([fight(0.05, 1000)], [fight(0.05, 1000)]);

        expect(desperate).toBeGreaterThan(middling * 10);
    });

    test('every room the upgrade touches adds its own', () => {
        const one = attemptsNoise([fight(0.5, 1000)], [fight(0.5, 1000)]);
        const four = attemptsNoise(
            [fight(0.5, 1000, '/monsters/a'), fight(0.5, 1000, '/monsters/b')],
            [fight(0.5, 1000, '/monsters/a'), fight(0.5, 1000, '/monsters/b')]
        );

        expect(four).toBeCloseTo(one * Math.SQRT2, 5);
    });

    test('rooms it does not touch add none', () => {
        // They are not simulated — the number is copied from the baseline, so
        // it carries no error of its own into the comparison
        expect(attemptsNoise([], [fight(0.5, 1000)])).toBe(0);
    });

    test('a certain win is not an infinite error', () => {
        expect(Number.isFinite(attemptsNoise([fight(1, 1000)], [fight(1, 1000)]))).toBe(true);
        expect(Number.isFinite(attemptsNoise([fight(0, 1000)], [fight(0, 1000)]))).toBe(true);
    });
});

describe('what cannot be bought together', () => {
    test('two upgrades to one slot are alternatives', () => {
        const boots = (hrid) => ({ type: 'tier', slot: '/equipment_types/feet', upgradeHrid: hrid });

        expect(conflictKey(boots('/items/a'))).toBe(conflictKey(boots('/items/b')));
    });

    test('different slots are not', () => {
        expect(conflictKey({ type: 'tier', slot: '/equipment_types/feet' })).not.toBe(
            conflictKey({ type: 'tier', slot: '/equipment_types/head' })
        );
    });

    test('a two-hander competes with a main hand, whatever the slot names say', () => {
        const twoHand = { type: 'tier', slot: '/equipment_types/two_hand' };
        const mainHand = { type: 'tier', slot: '/equipment_types/main_hand' };
        const swap = {
            type: 'cross_slot',
            addedSlots: { '/equipment_types/main_hand': {} },
            clearedSlots: ['/equipment_types/two_hand'],
        };

        expect(conflictKey(twoHand)).toBe(conflictKey(mainHand));
        expect(conflictKey(swap)).toBe(conflictKey(twoHand));
    });

    test('two targets for one ability are one purchase, not two', () => {
        const level = (upgradeLevel) => ({
            type: 'ability_level',
            slot: 'ability_1',
            upgradeHrid: '/abilities/fireball',
            upgradeLevel,
        });

        expect(conflictKey(level(50))).toBe(conflictKey(level(60)));
    });

    test('nor are two levels of one combat skill', () => {
        expect(conflictKey({ type: 'combat_level', skillKey: 'meleeLevel', upgradeLevel: 105 })).toBe(
            conflictKey({ type: 'combat_level', skillKey: 'meleeLevel', upgradeLevel: 110 })
        );
    });
});

describe('what a budget buys', () => {
    const pick = (over = {}) => ({
        candidate: { type: 'tier', slot: over.slot || '/equipment_types/feet', upgradeHrid: over.hrid || '/items/x' },
        cost: over.cost ?? 100,
        attemptsDelta: over.attemptsDelta ?? -1,
        attemptsSavedPerMillion: over.per ?? 10,
        significant: over.significant ?? true,
    });

    // Three rooms, all at a 50% win rate, so each is two expected attempts
    const BASELINE = [0, 1, 2].map((i) => ({ monsterHrid: `/monsters/m${i}`, roomLevel: 100, winRate: 0.5 }));
    /** A candidate that lifts the named rooms to `winRate` and misses the rest */
    const covering = (rooms, over = {}) => ({
        ...pick(over),
        fights: BASELINE.map((fight, i) =>
            rooms.includes(i) ? { ...fight, winRate: over.winRate ?? 1, applied: true } : { ...fight, applied: false }
        ),
        attemptsDelta: -1,
    });
    const planFor = (results, budget) => planWithinBudget(results, budget, { baselineFights: BASELINE });

    test('best value first, until the money runs out', () => {
        const plan = planWithinBudget(
            [
                pick({ cost: 100, attemptsDelta: -0.5, slot: '/equipment_types/head' }),
                pick({ cost: 100, attemptsDelta: -2, slot: '/equipment_types/feet' }),
            ],
            100
        );

        expect(plan.picks).toHaveLength(1);
        expect(plan.picks[0].candidate.slot).toBe('/equipment_types/feet');
        expect(plan.skipped.some((s) => s.reason === 'over budget')).toBe(true);
    });

    test('two pieces for one slot, when they serve different rooms', () => {
        // One chestpiece for the melee loadouts and one for the casters is two
        // purchases doing two jobs, not a mistake
        const plan = planFor([covering([0], { hrid: '/items/a' }), covering([1, 2], { hrid: '/items/b' })], 1000);

        expect(plan.picks).toHaveLength(2);
        expect(plan.picks.map((p) => p.rooms).sort()).toEqual([1, 2]);
    });

    test('but not a second piece for the rooms the first already covers', () => {
        const plan = planFor(
            [covering([0, 1, 2], { hrid: '/items/a', cost: 10 }), covering([0, 1], { hrid: '/items/b', cost: 10 })],
            1000
        );

        expect(plan.picks).toHaveLength(1);
        expect(plan.skipped.some((s) => s.reason.includes('already cover'))).toBe(true);
    });

    test('a second piece is valued only at what it adds', () => {
        // The cheap piece is the best thing room 0 can wear; the broad one is
        // better than nothing in room 1 and worse than the first in room 0, so
        // only room 1 is its to claim
        const plan = planFor(
            [
                covering([0], { hrid: '/items/sharp', cost: 5, winRate: 1 }),
                covering([0, 1], { hrid: '/items/broad', cost: 20, winRate: 0.75 }),
            ],
            1000
        );

        expect(plan.picks.map((p) => p.candidate.upgradeHrid)).toEqual(['/items/sharp', '/items/broad']);
        // 2 tries at 50% down to 1.333 at 75% — and only in room 1
        expect(plan.picks[1].marginalAttemptsSaved).toBeCloseTo(2 - 1 / 0.75, 3);
    });

    test('and a piece nobody would wear any more is taken back out', () => {
        // Bought early because it was cheap, then beaten everywhere it applied:
        // leaving it in the plan spends gold on a piece that never gets worn
        const plan = planFor(
            [
                covering([0], { hrid: '/items/cheap', cost: 1, winRate: 0.6 }),
                covering([0, 1, 2], { hrid: '/items/better', cost: 20, winRate: 1 }),
            ],
            1000
        );

        expect(plan.picks.map((p) => p.candidate.upgradeHrid)).toEqual(['/items/better']);
        expect(plan.totalCost).toBe(20);
        expect(plan.skipped.some((s) => s.reason.includes('covers every room'))).toBe(true);
    });

    test('a skill level is still one purchase, however many rooms it touches', () => {
        const level = (upgradeLevel, cost) => ({
            ...covering([0, 1, 2], { cost }),
            candidate: { type: 'combat_level', skillKey: 'meleeLevel', upgradeLevel },
        });

        const plan = planFor([level(55, 10), level(60, 10)], 1000);

        expect(plan.picks).toHaveLength(1);
    });

    test('nothing whose gain is inside the noise', () => {
        const plan = planWithinBudget([pick({ per: 99, significant: false })], 1000);

        expect(plan.picks).toHaveLength(0);
        expect(plan.skipped[0].reason).toContain('noise');
    });

    test('unless you ask for it anyway', () => {
        const plan = planWithinBudget([pick({ per: 99, significant: false })], 1000, { includeUnmeasured: true });

        expect(plan.picks).toHaveLength(1);
    });

    test('and nothing priceless, since a budget is in coins', () => {
        const plan = planWithinBudget([{ ...pick(), cost: null }], 1000);

        expect(plan.picks).toHaveLength(0);
    });

    test('nor anything that made the run worse', () => {
        const plan = planWithinBudget([pick({ attemptsDelta: 0.4 }), pick({ attemptsDelta: 0 })], 1000);

        expect(plan.picks).toHaveLength(0);
    });

    test('the totals are what was actually picked', () => {
        const plan = planWithinBudget(
            [
                pick({ per: 20, cost: 100, attemptsDelta: -2, slot: '/equipment_types/feet' }),
                pick({ per: 10, cost: 250, attemptsDelta: -1, slot: '/equipment_types/head' }),
            ],
            1000
        );

        expect(plan.totalCost).toBe(350);
        expect(plan.attemptsSaved).toBe(3);
    });

    test('and the saving counts each room once, not once per piece', () => {
        // Two pieces both lifting room 0 from two attempts to one is still one
        // attempt saved there, whichever of them the room wears
        const plan = planFor(
            [covering([0], { hrid: '/items/a', cost: 10 }), covering([0, 1], { hrid: '/items/b', cost: 10 })],
            1000
        );

        expect(plan.attemptsSaved).toBeCloseTo(2, 5);
    });
});

describe('where a skilling upgrade lands', () => {
    const TOOL = '/equipment_types/milking_tool';
    const BODY = '/equipment_types/body';
    const payload = { hrid: '/items/celestial_brush', enhancementLevel: 5 };

    test('a piece bought for one skill goes into that skill alone', () => {
        const map = {
            '/skills/milking': { [TOOL]: { hrid: '/items/basic_brush', enhancementLevel: 0 } },
            '/skills/crafting': {},
        };
        applyToEquipment({ skillKey: '/skills/milking', slot: TOOL }, payload, { equipment: {} }, map, null);

        expect(map['/skills/milking'][TOOL]).toBe(payload);
        expect(map['/skills/crafting'][TOOL]).toBeUndefined();
    });

    test('a skill with no loadout gets a kit of its own rather than the shared one', () => {
        // Its room runs in the base kit, so writing the piece there would put a
        // Milking outfit into every other skill that also has no loadout
        const dto = { equipment: { [BODY]: { hrid: '/items/plain_shirt', enhancementLevel: 0 } } };
        const map = {};

        applyToEquipment({ skillKey: '/skills/milking', slot: TOOL }, payload, dto, map, null);

        expect(map['/skills/milking'][TOOL]).toBe(payload);
        expect(map['/skills/milking'][BODY]).toEqual(dto.equipment[BODY]);
        expect(dto.equipment[TOOL]).toBeUndefined();
    });

    test('enhancing an item you own upgrades it in every kit wearing it', () => {
        const candidate = { slot: TOOL, currentHrid: '/items/basic_brush', currentLevel: 3 };
        const dto = { equipment: { [TOOL]: { hrid: '/items/basic_brush', enhancementLevel: 3 } } };
        const map = {
            '/skills/milking': { [TOOL]: { hrid: '/items/basic_brush', enhancementLevel: 3 } },
        };

        applyToEquipment(candidate, payload, dto, map, null);

        expect(dto.equipment[TOOL]).toBe(payload);
        expect(map['/skills/milking'][TOOL]).toBe(payload);
    });

    test('but not a second copy of it worn at a different level', () => {
        // Matching on hrid alone dragged the +7 copy down to the +5 this
        // candidate was about, which reads as an upgrade making things worse
        const candidate = { slot: TOOL, currentHrid: '/items/basic_brush', currentLevel: 3 };
        const map = {
            '/skills/milking': { [TOOL]: { hrid: '/items/basic_brush', enhancementLevel: 3 } },
            '/skills/foraging': { [TOOL]: { hrid: '/items/basic_brush', enhancementLevel: 7 } },
        };

        applyToEquipment(candidate, payload, { equipment: {} }, map, null);

        expect(map['/skills/milking'][TOOL]).toBe(payload);
        expect(map['/skills/foraging'][TOOL].enhancementLevel).toBe(7);
    });

    test('and only the skill under analysis when one skill is being analysed', () => {
        const candidate = { slot: TOOL, currentHrid: '/items/basic_brush', currentLevel: 3 };
        const map = {
            '/skills/milking': { [TOOL]: { hrid: '/items/basic_brush', enhancementLevel: 3 } },
            '/skills/foraging': { [TOOL]: { hrid: '/items/basic_brush', enhancementLevel: 3 } },
        };

        applyToEquipment(candidate, payload, { equipment: {} }, map, '/skills/milking');

        expect(map['/skills/milking'][TOOL]).toBe(payload);
        expect(map['/skills/foraging'][TOOL]).not.toBe(payload);
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

    test('per-room targets take precedence over the uniform target', () => {
        const candidates = generateHouseCandidates(
            { houseRooms: { '/house_rooms/dojo': 3, '/house_rooms/gym': 0 } },
            houseGameData(),
            5,
            { '/house_rooms/dojo': 7 }
        );

        // Dojo follows its own target; Gym was left blank in the grid, so it's skipped
        expect(candidates).toHaveLength(1);
        expect(candidates[0].roomHrid).toBe('/house_rooms/dojo');
        expect(candidates[0].upgradeLevel).toBe(7);
    });

    test('per-room target at or below the current level skips the room', () => {
        const candidates = generateHouseCandidates({ houseRooms: { '/house_rooms/dojo': 5 } }, houseGameData(), 0, {
            '/house_rooms/dojo': 5,
        });
        expect(candidates).toHaveLength(0);
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

describe('candidateAssignmentKey', () => {
    const BODY = '/equipment_types/body';
    const LEGS = '/equipment_types/legs';

    test('a pair is distinct from either piece alone', () => {
        const bodyOnly = { type: 'cross_slot', addedSlots: { [BODY]: { hrid: '/items/a', enhancementLevel: 7 } } };
        const legsOnly = { type: 'cross_slot', addedSlots: { [LEGS]: { hrid: '/items/b', enhancementLevel: 7 } } };
        const pair = {
            type: 'cross_slot',
            addedSlots: {
                [BODY]: { hrid: '/items/a', enhancementLevel: 7 },
                [LEGS]: { hrid: '/items/b', enhancementLevel: 7 },
            },
        };

        const keys = [bodyOnly, legsOnly, pair].map(candidateAssignmentKey);
        expect(new Set(keys).size).toBe(3);
    });

    test('two pairs sharing a body piece stay distinct', () => {
        const withB = {
            type: 'cross_slot',
            addedSlots: {
                [BODY]: { hrid: '/items/a', enhancementLevel: 7 },
                [LEGS]: { hrid: '/items/b', enhancementLevel: 7 },
            },
        };
        const withC = {
            type: 'cross_slot',
            addedSlots: {
                [BODY]: { hrid: '/items/a', enhancementLevel: 7 },
                [LEGS]: { hrid: '/items/c', enhancementLevel: 7 },
            },
        };

        expect(candidateAssignmentKey(withB)).not.toBe(candidateAssignmentKey(withC));
    });

    test('a single-slot cross_slot matches the equivalent tier candidate', () => {
        const tier = { type: 'tier', slot: BODY, upgradeHrid: '/items/a', upgradeLevel: 7 };
        const crossSlot = {
            type: 'cross_slot',
            slot: BODY,
            addedSlots: { [BODY]: { hrid: '/items/a', enhancementLevel: 7 } },
            clearedSlots: [],
        };

        expect(candidateAssignmentKey(crossSlot)).toBe(candidateAssignmentKey(tier));
    });

    test('slot order does not change the key', () => {
        const a = {
            type: 'cross_slot',
            addedSlots: {
                [BODY]: { hrid: '/items/a', enhancementLevel: 7 },
                [LEGS]: { hrid: '/items/b', enhancementLevel: 7 },
            },
        };
        const b = {
            type: 'cross_slot',
            addedSlots: {
                [LEGS]: { hrid: '/items/b', enhancementLevel: 7 },
                [BODY]: { hrid: '/items/a', enhancementLevel: 7 },
            },
        };

        expect(candidateAssignmentKey(a)).toBe(candidateAssignmentKey(b));
    });

    test('a weapon swap that clears slots differs from one that does not', () => {
        const twoHand = {
            type: 'cross_slot',
            addedSlots: { '/equipment_types/two_hand': { hrid: '/items/w', enhancementLevel: 7 } },
            clearedSlots: ['/equipment_types/main_hand', '/equipment_types/off_hand'],
        };
        const bare = {
            type: 'cross_slot',
            addedSlots: { '/equipment_types/two_hand': { hrid: '/items/w', enhancementLevel: 7 } },
            clearedSlots: [],
        };

        expect(candidateAssignmentKey(twoHand)).not.toBe(candidateAssignmentKey(bare));
    });

    test('enhancement levels separate the same item at different levels', () => {
        const plus7 = { type: 'tier', slot: BODY, upgradeHrid: '/items/a', upgradeLevel: 7 };
        const plus10 = { type: 'tier', slot: BODY, upgradeHrid: '/items/a', upgradeLevel: 10 };
        expect(candidateAssignmentKey(plus7)).not.toBe(candidateAssignmentKey(plus10));
    });

    test('non-equipment candidates key off their own type', () => {
        const house = { type: 'house', slot: 'house|/house_rooms/dojo', upgradeLevel: 4 };
        const level = { type: 'combat_level', slot: 'combat_level|meleeLevel', upgradeLevel: 105 };
        const ability = { type: 'ability_level', slot: 'ability_1', upgradeHrid: '/abilities/x', upgradeLevel: 75 };

        const keys = [house, level, ability].map(candidateAssignmentKey);
        expect(new Set(keys).size).toBe(3);
        expect(keys[0]).toContain('house');
        expect(keys[1]).toContain('combat_level');
    });
});

describe('explainUpgradeCost', () => {
    const BODY = '/equipment_types/body';
    const LEGS = '/equipment_types/legs';

    function costGameData() {
        return {
            itemDetailMap: {
                '/items/fire_top': { name: 'Fire Top', equipmentDetail: { type: BODY } },
                '/items/fire_bottoms': { name: 'Fire Bottoms', equipmentDetail: { type: LEGS } },
                '/items/nature_top': { name: 'Nature Top', equipmentDetail: { type: BODY } },
            },
        };
    }

    test('itemises every purchase in a multi-slot swap', () => {
        resolveItemPrice.mockImplementation(() => ({ price: 1_000_000 }));
        getItemPrices.mockReturnValue({ ask: 5_000_000, bid: 4_000_000 });

        const detail = explainUpgradeCost(
            {
                type: 'cross_slot',
                addedSlots: {
                    [BODY]: { hrid: '/items/fire_top', enhancementLevel: 7 },
                    [LEGS]: { hrid: '/items/fire_bottoms', enhancementLevel: 7 },
                },
                removedItems: [{ hrid: '/items/nature_top', enhancementLevel: 7 }],
            },
            costGameData()
        );

        expect(detail.buys.map((b) => b.name)).toEqual(['Fire Top', 'Fire Bottoms']);
        expect(detail.credits.map((c) => c.name)).toEqual(['Nature Top']);
        expect(detail.credit).toBe(1_000_000);
    });

    test('names the unpriced item that makes a cost unknown', () => {
        // No listing at +7 and no enhancement recipe leaves the buy price unknown
        getItemPrices.mockReturnValue({ ask: 0, bid: 0 });
        resolveItemPrice.mockImplementation(() => ({ price: 0 }));

        const detail = explainUpgradeCost(
            {
                type: 'cross_slot',
                addedSlots: { [BODY]: { hrid: '/items/fire_top', enhancementLevel: 7 } },
                removedItems: [],
            },
            costGameData()
        );

        expect(detail.unpriced).toEqual(['Fire Top']);
        expect(detail.gross).toBe(null);
        expect(detail.net).toBe(null);
    });

    test('reports no credit when nothing is replaced', () => {
        resolveItemPrice.mockImplementation(() => ({ price: 0 }));
        getItemPrices.mockReturnValue({ ask: 3_000_000, bid: 2_000_000 });

        const detail = explainUpgradeCost(
            {
                type: 'cross_slot',
                addedSlots: { [BODY]: { hrid: '/items/fire_top', enhancementLevel: 7 } },
                removedItems: [],
            },
            costGameData()
        );

        expect(detail.credits).toEqual([]);
        expect(detail.credit).toBe(0);
        expect(detail.net).toBe(detail.gross);
    });
});

describe('what an ability upgrade costs', () => {
    const levelUp = {
        type: 'ability_level',
        slot: 'ability_1',
        currentHrid: '/abilities/fireball',
        currentLevel: 48,
        upgradeHrid: '/abilities/fireball',
        upgradeLevel: 53,
    };
    const gameData = { levelExperienceTable: [0, 100, 200], itemDetailMap: {} };

    test('it is books, not a listing for the ability at that level', () => {
        // An ability is not an item: asking the market for "fireball +53" finds
        // nothing, and the row reads "no price found" for something anyone can
        // buy books for today
        const detail = explainUpgradeCost(levelUp, gameData);

        expect(detail.books).toMatchObject({ bookName: 'Fireball', bookPrice: 1000 });
        expect(detail.buys).toEqual([]);
        expect(detail.gross).toBe(12_400);
    });

    test('nothing is credited back, because levels cannot be sold', () => {
        const detail = explainUpgradeCost(levelUp, gameData);

        expect(detail.credits).toEqual([]);
        expect(detail.credit).toBe(0);
        expect(detail.net).toBe(detail.gross);
    });

    test('it is priced from where the ability is now', () => {
        explainUpgradeCost(levelUp, gameData);

        // XP at the current level, not from zero — the books already read count
        expect(explainAbilityLevelUpCost).toHaveBeenLastCalledWith('/abilities/fireball', 48, 0, 53);
    });

    test('but a swap is learned from scratch', () => {
        explainUpgradeCost(
            { type: 'ability_swap', upgradeHrid: '/abilities/critical_aura', upgradeLevel: 20 },
            gameData
        );

        expect(explainAbilityLevelUpCost).toHaveBeenLastCalledWith('/abilities/critical_aura', 0, 0, 20);
    });

    test('an ability nobody is selling costs unknown rather than nothing', () => {
        explainAbilityLevelUpCost.mockReturnValueOnce({
            bookName: 'Fireball',
            books: 12,
            bookPrice: null,
            total: null,
        });

        expect(calculateUpgradeCost(levelUp, gameData)).toBe(null);
    });

    test('and the cost is the books, when there is a price', () => {
        expect(calculateUpgradeCost(levelUp, gameData)).toBe(12_400);
    });
});

describe('computeEconomics', () => {
    const base = { profitPerHour: 1000 };

    test('payback is cost over current profit, repay is cost over the gain', () => {
        const e = computeEconomics(10_000, base, { profitPerHour: 1500 });
        expect(e.profitGainPerHour).toBe(500);
        expect(e.paybackHours).toBe(10); // 10,000 / 1,000
        expect(e.repayHours).toBe(20); // 10,000 / 500
    });

    test('an upgrade that does not raise profit never repays', () => {
        const e = computeEconomics(10_000, base, { profitPerHour: 1000 });
        expect(e.repayHours).toBe(Infinity);
        // Still affordable, though — payback is about the wallet, not the upgrade
        expect(e.paybackHours).toBe(10);
    });

    test('a profit loss never repays rather than reporting a negative period', () => {
        const e = computeEconomics(10_000, base, { profitPerHour: 400 });
        expect(e.profitGainPerHour).toBe(-600);
        expect(e.repayHours).toBe(Infinity);
    });

    test('unknown cost is unknown, never free', () => {
        const e = computeEconomics(null, base, { profitPerHour: 1500 });
        expect(e.paybackHours).toBe(Infinity);
        expect(e.repayHours).toBe(Infinity);
    });

    test('a free upgrade costs no time on either measure', () => {
        const e = computeEconomics(0, base, { profitPerHour: 1500 });
        expect(e.paybackHours).toBe(0);
        expect(e.repayHours).toBe(0);
    });

    test('payback preserves the cost ordering, which is why it is not scored', () => {
        // Every row divides by the same baseline rate, so payback cannot reorder
        // candidates relative to Cost — the claim the column tooltip makes
        const costs = [500, 10_000, 2_500, 40_000];
        const paybacks = costs.map((c) => computeEconomics(c, base, { profitPerHour: 1500 }).paybackHours);

        const byCost = [...costs].sort((a, b) => a - b);
        const byPayback = costs
            .map((c, i) => [c, paybacks[i]])
            .sort((a, b) => a[1] - b[1])
            .map(([c]) => c);
        expect(byPayback).toEqual(byCost);
    });

    test('nothing is affordable on zero profit', () => {
        const e = computeEconomics(10_000, { profitPerHour: 0 }, { profitPerHour: 500 });
        expect(e.paybackHours).toBe(Infinity);
        expect(e.repayHours).toBe(20); // the gain still repays it
    });
});

describe('assignRankScores', () => {
    const row = (name, dps, xp, profit, repayHours) => ({
        candidate: { description: name },
        goldPer: { dps, xp, profit },
        economics: { repayHours },
    });

    test('awards descending points and sums them into a score', () => {
        const rows = [row('best', 1, 1, 1, 1), row('second', 2, 2, 2, 2)];
        assignRankScores(rows);

        // Four metrics, first place in each
        expect(rows[0].score).toBe(RANK_PLACES * 4);
        expect(rows[1].score).toBe((RANK_PLACES - 1) * 4);
        expect(rows[0].rankPoints.dps).toMatchObject({ place: 1, points: RANK_PLACES });
    });

    test('an all-rounder can outscore a single-column winner', () => {
        const rows = [
            row('spiky', 1, 900, 900, 900), // wins DPS outright, last everywhere else
            row('rounded', 2, 2, 2, 2), // second in all four
        ];
        assignRankScores(rows);

        expect(rows[1].score).toBeGreaterThan(rows[0].score);
    });

    test('ties share a placing rather than being split by list order', () => {
        const rows = [row('a', 5, 5, 5, 5), row('b', 5, 5, 5, 5)];
        assignRankScores(rows);

        expect(rows[0].score).toBe(rows[1].score);
        expect(rows[0].rankPoints.dps.place).toBe(1);
        expect(rows[1].rankPoints.dps.place).toBe(1);
    });

    test('unmeasurable metrics score nothing instead of ranking last', () => {
        const rows = [row('known', 1, 1, 1, 1), row('unknown', Infinity, Infinity, Infinity, Infinity)];
        assignRankScores(rows);

        expect(rows[1].score).toBe(0);
        expect(rows[1].rankPoints).toEqual({});
    });

    test('only the top placings earn points', () => {
        const rows = Array.from({ length: RANK_PLACES + 3 }, (_, i) => row(`r${i}`, i + 1, i + 1, i + 1, i + 1));
        assignRankScores(rows);

        expect(rows[RANK_PLACES - 1].score).toBe(4); // last scoring place, 1 point per metric
        expect(rows[RANK_PLACES].score).toBe(0);
    });
});

describe('ROI and configurable scoring', () => {
    const base = { profitPerHour: 1000 };

    test('ROI annualises the profit gain against the outlay', () => {
        // 500/hr extra on a 10,000 outlay = 4,380,000 a year = 43,800%
        const e = computeEconomics(10_000, base, { profitPerHour: 1500 });
        expect(e.roiAnnualPct).toBeCloseTo(43_800, 5);
    });

    test('ROI is unknown rather than zero when the cost is unknown', () => {
        expect(computeEconomics(null, base, { profitPerHour: 1500 }).roiAnnualPct).toBeNull();
    });

    test('ROI ranks identically to repay time, which is why scoring both double-counts', () => {
        const rows = [10_000, 50_000, 25_000].map((cost) => computeEconomics(cost, base, { profitPerHour: 1500 }));

        const byRepay = [...rows].sort((a, b) => a.repayHours - b.repayHours);
        const byRoi = [...rows].sort((a, b) => b.roiAnnualPct - a.roiAnnualPct);
        expect(byRoi).toEqual(byRepay);
    });

    test('only the selected metrics contribute to the score', () => {
        const row = (dps, xp) => ({
            candidate: {},
            goldPer: { dps, xp, profit: Infinity, encounters: Infinity, deaths: Infinity },
            economics: { repayHours: Infinity, roiAnnualPct: null },
        });
        const rows = [row(1, 900), row(900, 1)];

        assignRankScores(rows, { keys: ['dps'] });
        expect(rows[0].score).toBe(RANK_PLACES);
        expect(rows[1].score).toBe(RANK_PLACES - 1);
        expect(rows[0].rankPoints.xp).toBeUndefined();

        // Scoring the other metric alone flips the order
        assignRankScores(rows, { keys: ['xp'] });
        expect(rows[1].score).toBe(RANK_PLACES);
    });

    test('higher-is-better metrics rank downward', () => {
        const row = (roi) => ({ candidate: {}, goldPer: {}, economics: { roiAnnualPct: roi } });
        const rows = [row(100), row(900)];

        assignRankScores(rows, { keys: ['roi'] });
        expect(rows[1].score).toBe(RANK_PLACES); // the bigger return places first
        expect(rows[0].score).toBe(RANK_PLACES - 1);
    });

    test('an empty selection scores nothing rather than throwing', () => {
        const rows = [{ candidate: {}, goldPer: { dps: 1 }, economics: { repayHours: 1 } }];
        assignRankScores(rows, { keys: [] });
        expect(rows[0].score).toBe(0);
    });

    test('every default score key is a real metric, and ROI is not among them', () => {
        const known = SCORE_METRICS.map((m) => m.key);
        for (const key of DEFAULT_SCORE_KEYS) expect(known).toContain(key);
        expect(DEFAULT_SCORE_KEYS).not.toContain('roi');
    });
});

describe('default score selection', () => {
    test('counts every gold-per metric plus repay, and not ROI', () => {
        expect([...DEFAULT_SCORE_KEYS].sort()).toEqual(['deaths', 'dps', 'encounters', 'profit', 'repay', 'xp'].sort());
    });

    test('the Time column is not among the scored metrics', () => {
        // It is cost divided by a constant, so it duplicates Cost exactly
        expect(SCORE_METRICS.map((m) => m.key)).not.toContain('payback');
    });
});

describe('applying one candidate to a player', () => {
    const player = () => ({
        hrid: '/players/me',
        magicLevel: 100,
        abilities: [{ hrid: '/abilities/fierce_aura', level: 10, triggers: ['keep me'] }, null, null, null, null],
        equipment: { '/equipment_types/head': { hrid: '/items/hat', enhancementLevel: 2 } },
    });

    test('a piece of equipment lands in its slot', () => {
        const dto = applyCandidateToDTO(player(), {
            slot: '/equipment_types/head',
            upgradeHrid: '/items/better_hat',
            upgradeLevel: 5,
            type: 'enhancement',
        });

        expect(dto.equipment['/equipment_types/head']).toEqual({ hrid: '/items/better_hat', enhancementLevel: 5 });
    });

    test('levelling the ability already slotted keeps its triggers', () => {
        // They were configured on purpose; a level-up is not a reason to lose them
        const dto = applyCandidateToDTO(player(), {
            slot: 'ability_0',
            upgradeHrid: '/abilities/fierce_aura',
            upgradeLevel: 25,
        });

        expect(dto.abilities[0]).toMatchObject({ level: 25, triggers: ['keep me'] });
    });

    test('swapping in a different one does not inherit them', () => {
        const dto = applyCandidateToDTO(player(), {
            slot: 'ability_0',
            upgradeHrid: '/abilities/critical_aura',
            upgradeLevel: 20,
        });

        expect(dto.abilities[0]).toEqual({ hrid: '/abilities/critical_aura', level: 20, triggers: null });
    });

    test('a combat level sets the skill', () => {
        const dto = applyCandidateToDTO(player(), {
            type: 'combat_level',
            skillKey: 'magicLevel',
            upgradeLevel: 110,
        });

        expect(dto.magicLevel).toBe(110);
    });

    test('and the player it was given is never touched', () => {
        // A dozen candidates measured against a DTO carrying the last one's
        // change would each be measuring the pile rather than the piece
        const original = player();
        applyCandidateToDTO(original, {
            slot: '/equipment_types/head',
            upgradeHrid: '/items/better_hat',
            upgradeLevel: 5,
        });

        expect(original.equipment['/equipment_types/head'].hrid).toBe('/items/hat');
    });
});
