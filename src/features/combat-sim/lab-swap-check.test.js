/**
 * Check a swap: the candidates a hand-picked swap becomes, who they reach, and
 * what they cost.
 *
 * The point of the feature is that a checked swap behaves exactly like a
 * generated row for the same target, so these tests run the real advisor
 * (`generateCandidates`, `calculateUpgradeCost`, `candidateAppliesToDTO`,
 * `applyCandidateToDTO`) and compare against it, with only the market and the
 * enhancing sweep stood in for.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ items: [] }));

const CAPE = '/items/sinister_cape';
const QUIVER = '/items/chimerical_quiver';
const SWORD = '/items/cheese_sword';
const MACE = '/items/cheese_mace';
const STAFF = '/items/holy_staff';
const BOW = '/items/cheese_bow';
const MILKING_TOOL = '/items/celestial_milking_tool';
const CHISEL = '/items/celestial_crafting_tool';
const CHAR = 161296;

// Real equipment types: a cape is `/equipment_types/back`, never `back`
const BACK = '/equipment_types/back';
const MAIN = '/equipment_types/main_hand';
const TWO = '/equipment_types/two_hand';

const ITEM_DETAIL_MAP = {
    [CAPE]: {
        hrid: CAPE,
        name: 'Sinister Cape',
        itemLevel: 80,
        equipmentDetail: { type: BACK, combatStats: { slashDamage: 0.1, stabDamage: 0.1, smashDamage: 0.1 } },
        enhancementCosts: [{ itemHrid: '/items/coin', count: 1000 }],
    },
    [QUIVER]: {
        hrid: QUIVER,
        name: 'Chimerical Quiver',
        itemLevel: 80,
        equipmentDetail: { type: BACK, combatStats: { rangedDamage: 0.1, rangedAccuracy: 0.1 } },
        enhancementCosts: [{ itemHrid: '/items/coin', count: 1000 }],
    },
    [SWORD]: {
        hrid: SWORD,
        name: 'Cheese Sword',
        isTradable: true,
        itemLevel: 10,
        equipmentDetail: { type: MAIN, combatStats: { slashDamage: 20 } },
        enhancementCosts: [{ itemHrid: '/items/coin', count: 10 }],
    },
    [MACE]: {
        hrid: MACE,
        name: 'Cheese Mace',
        isTradable: true,
        itemLevel: 10,
        equipmentDetail: { type: MAIN, combatStats: { smashDamage: 20 } },
        enhancementCosts: [{ itemHrid: '/items/coin', count: 10 }],
    },
    [STAFF]: {
        hrid: STAFF,
        name: 'Holy Staff',
        isTradable: true,
        itemLevel: 10,
        equipmentDetail: { type: TWO, combatStats: { magicDamage: 30 } },
        enhancementCosts: [{ itemHrid: '/items/coin', count: 10 }],
    },
    [BOW]: {
        hrid: BOW,
        name: 'Cheese Bow',
        isTradable: true,
        itemLevel: 10,
        equipmentDetail: { type: TWO, combatStats: { rangedDamage: 30 } },
        enhancementCosts: [{ itemHrid: '/items/coin', count: 10 }],
    },
    [MILKING_TOOL]: {
        hrid: MILKING_TOOL,
        name: 'Celestial Milking Tool',
        isTradable: true,
        itemLevel: 90,
        equipmentDetail: { type: '/equipment_types/milking_tool', noncombatStats: { milkingSpeed: 0.5 } },
        enhancementCosts: [{ itemHrid: '/items/coin', count: 100 }],
    },
    [CHISEL]: {
        hrid: CHISEL,
        name: 'Celestial Crafting Tool',
        isTradable: true,
        itemLevel: 90,
        equipmentDetail: { type: '/equipment_types/crafting_tool', noncombatStats: { craftingSpeed: 0.5 } },
        enhancementCosts: [{ itemHrid: '/items/coin', count: 100 }],
    },
};

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInventory: () => [...state.items],
        getInitClientData: () => ({ itemDetailMap: ITEM_DETAIL_MAP }),
        getCurrentCharacterId: () => CHAR,
        getGuildBuildingLevel: () => 0,
        getSkills: () => [],
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
vi.mock('./direct-enhancement-cost.js', () => ({
    calculateDirectEnhancementCost: (_itemHrid, from, to) => (to - from) * 1_000_000,
    enhancementSweepParams: () => ({}),
}));
vi.mock('../enhancement/enhancement-params-source.js', () => ({ describeEnhancementSource: () => null }));
vi.mock('../../utils/profit-helpers.js', () => ({
    resolveItemPrice: vi.fn(() => ({ price: 2_000_000 })),
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrices: vi.fn(() => ({ ask: 50_000_000, bid: 10_000_000 })),
}));
vi.mock('./skilling-sim-helpers.js', () => ({ buildOverridesForSkill: vi.fn() }));

const advisor = await import('./upgrade-advisor.js');
const {
    MAX_QUEUED_SWAPS,
    buildCombatSwapCandidate,
    buildSkillingSwapCandidate,
    checkedSwapKey,
    clampSwapLevel,
    describeCheckedSwap,
    evaluateSkillingSwaps,
    resolveEquipmentHrid,
    sanitizeSwapQueues,
    searchEquipmentItems,
} = await import('./lab-swap-check.js');
const { applySkillingCandidate } = await import('./lab-skilling-goals.js');

const gameData = { itemDetailMap: ITEM_DETAIL_MAP, actionDetailMap: {} };
const wearing = (equipment) => ({ equipment, abilities: [] });
const piece = (hrid, enhancementLevel = 0) => ({ hrid, enhancementLevel });

beforeEach(() => {
    state.items = [];
});

describe('picking an item', () => {
    test('a name resolves to its item, exactly or when it is the only match', () => {
        expect(resolveEquipmentHrid(gameData, 'Sinister Cape')).toBe(CAPE);
        expect(resolveEquipmentHrid(gameData, 'sinister')).toBe(CAPE);
        expect(resolveEquipmentHrid(gameData, CAPE)).toBe(CAPE);
    });

    test('text matching several items, or none, resolves to nothing', () => {
        expect(resolveEquipmentHrid(gameData, 'cheese')).toBeNull();
        expect(resolveEquipmentHrid(gameData, 'nonsense')).toBeNull();
        expect(resolveEquipmentHrid(gameData, '')).toBeNull();
    });

    test('the search lists names that start with the text before ones that only contain it', () => {
        const names = searchEquipmentItems(gameData, 'ce').map((item) => item.name);
        expect(names.slice(0, 2)).toEqual(['Celestial Crafting Tool', 'Celestial Milking Tool']);
        expect(searchEquipmentItems(gameData, 'cape').map((item) => item.name)).toEqual(['Sinister Cape']);
    });
});

describe('the remembered queue', () => {
    test('survives a round trip and is brought back into shape', () => {
        const queues = sanitizeSwapQueues({
            combat: [
                { hrid: CAPE, level: 7 },
                { hrid: CAPE, level: 7 },
                { hrid: QUIVER, level: 99 },
                { hrid: 'cape', level: 3 },
                null,
            ],
            skilling: 'garbage',
        });
        expect(queues.combat).toEqual([
            { hrid: CAPE, level: 7 },
            { hrid: QUIVER, level: 20 },
        ]);
        expect(queues.skilling).toEqual([]);
        expect(sanitizeSwapQueues(JSON.parse(JSON.stringify(queues)))).toEqual(queues);
    });

    test('is capped, and levels are whole numbers in range', () => {
        const many = Array.from({ length: MAX_QUEUED_SWAPS + 5 }, (_, i) => ({ hrid: `/items/item_${i}`, level: 1 }));
        expect(sanitizeSwapQueues({ combat: many }).combat).toHaveLength(MAX_QUEUED_SWAPS);
        expect(clampSwapLevel('7.9')).toBe(7);
        expect(clampSwapLevel(-3)).toBe(0);
        expect(clampSwapLevel('')).toBe(0);
        expect(clampSwapLevel(40)).toBe(20);
    });

    test('a chip reads as the item and its level', () => {
        expect(describeCheckedSwap({ hrid: CAPE, level: 7 }, gameData)).toBe('Sinister Cape +7');
        expect(checkedSwapKey({ hrid: CAPE, level: 7 })).toBe(`${CAPE}@7`);
    });
});

describe('combat: who a checked swap reaches', () => {
    test('a cape goes in every loadout that has the slot to use, and not where it is already that high', () => {
        const wornLow = wearing({ [BACK]: piece(CAPE, 5) });
        const bare = wearing({ [MAIN]: piece(SWORD) });
        const wornHigh = wearing({ [BACK]: piece(CAPE, 7) });
        const otherCape = wearing({ [BACK]: piece('/items/other_cape', 3) });
        ITEM_DETAIL_MAP['/items/other_cape'] = {
            hrid: '/items/other_cape',
            name: 'Other Cape',
            equipmentDetail: { type: BACK, combatStats: { slashDamage: 0.05 } },
        };

        const candidate = buildCombatSwapCandidate(
            { hrid: CAPE, level: 7 },
            [wornLow, bare, wornHigh, otherCape],
            gameData
        );
        const reached = [wornLow, bare, wornHigh, otherCape].map((dto) =>
            advisor.candidateAppliesToDTO(candidate, dto, gameData)
        );

        expect(reached).toEqual([true, true, false, true]);
        expect(candidate.reach).toBe(3);
        expect(candidate.slot).toBe(BACK);

        // Applied, it lands in the slot of the loadouts it reaches and nowhere else
        const after = advisor.applyCandidateToDTO(wornLow, candidate);
        expect(after.equipment[BACK]).toEqual({ hrid: CAPE, enhancementLevel: 7 });
        expect(after.equipment[MAIN]).toBeUndefined();
        expect(wornLow.equipment[BACK].enhancementLevel).toBe(5);
        delete ITEM_DETAIL_MAP['/items/other_cape'];
    });

    test('hand slots keep their rules: a two-hander does not go beside a main hand, nor a sword in a staff loadout', () => {
        const swordLoadout = wearing({ [MAIN]: piece(MACE, 3) });
        const staffLoadout = wearing({ [TWO]: piece(STAFF, 3) });
        const bowLoadout = wearing({ [TWO]: piece(BOW, 3) });
        const loadouts = [swordLoadout, staffLoadout, bowLoadout];

        const sword = buildCombatSwapCandidate({ hrid: SWORD, level: 5 }, loadouts, gameData);
        // Mace to sword is a melee-for-melee swap; a two-hander loadout has no main hand to put it in
        expect(loadouts.map((dto) => advisor.candidateAppliesToDTO(sword, dto, gameData))).toEqual([
            true,
            false,
            false,
        ]);

        const bow = buildCombatSwapCandidate({ hrid: BOW, level: 5 }, loadouts, gameData);
        // A bow replaces a bow; it is not a staff and it cannot sit beside a main hand
        expect(loadouts.map((dto) => advisor.candidateAppliesToDTO(bow, dto, gameData))).toEqual([false, false, true]);
    });

    test('a quiver is for the loadouts that fight with ranged, not the melee ones', () => {
        const ranged = wearing({ [TWO]: piece(BOW, 3), [BACK]: piece(CAPE, 5) });
        const melee = wearing({ [MAIN]: piece(SWORD, 3), [BACK]: piece(CAPE, 5) });
        // Both wear a melee cape today; it is the weapon that decides
        const quiver = buildCombatSwapCandidate({ hrid: QUIVER, level: 5 }, [ranged, melee], gameData);
        expect([ranged, melee].map((dto) => advisor.candidateAppliesToDTO(quiver, dto, gameData))).toEqual([
            true,
            false,
        ]);
        expect(quiver.reach).toBe(1);
    });

    test('a piece with no combat stats is in no loadout', () => {
        const candidate = buildCombatSwapCandidate(
            { hrid: MILKING_TOOL, level: 5 },
            [wearing({ [MAIN]: piece(SWORD) })],
            gameData
        );
        expect(candidate.reach).toBe(0);
    });

    test('an item with no equipment slot builds nothing', () => {
        expect(buildCombatSwapCandidate({ hrid: '/items/coin', level: 0 }, [], gameData)).toBeNull();
    });
});

describe('combat: what a checked swap costs', () => {
    test('matches the generated row for the same target', () => {
        state.items = [
            {
                id: 1,
                characterID: CHAR,
                itemLocationHrid: '/item_locations/back',
                itemHrid: CAPE,
                enhancementLevel: 5,
                count: 1,
            },
        ];
        const dto = wearing({ [BACK]: piece(CAPE, 5) });
        const generated = advisor
            .generateCandidates(dto, gameData, 'equipment')
            .find((candidate) => candidate.type === 'enhancement' && candidate.upgradeHrid === CAPE);
        expect(generated).toBeTruthy();

        const checked = buildCombatSwapCandidate({ hrid: CAPE, level: generated.upgradeLevel }, [dto], gameData);

        expect(checked.type).toBe('enhancement');
        expect(checked.currentLevel).toBe(5);
        expect(checked.description).toBe(generated.description);
        expect(checked.cost).toBe(advisor.calculateUpgradeCost(generated, gameData));
        // Through the self-enhance ladder, not at a market ask: the 50M ask never shows
        expect(checked.cost).toBeLessThan(50_000_000);
    });

    test('a swap into a different piece is priced as the purchase less the resale of what it replaces', () => {
        const dto = wearing({ [MAIN]: piece(MACE, 3) });
        const checked = buildCombatSwapCandidate({ hrid: SWORD, level: 3 }, [dto], gameData);
        const same = {
            type: 'tier',
            slot: MAIN,
            currentHrid: MACE,
            currentLevel: 3,
            upgradeHrid: SWORD,
            upgradeLevel: 3,
        };

        expect(checked.type).toBe('tier');
        expect(checked.description).toBe('Cheese Mace +3 → Cheese Sword +3');
        expect(checked.cost).toBe(advisor.calculateUpgradeCost(same, gameData));
    });

    test('a fill of a bare slot sells nothing', () => {
        const dto = wearing({ [MAIN]: piece(SWORD) });
        const checked = buildCombatSwapCandidate({ hrid: CAPE, level: 3 }, [dto], gameData);
        expect(checked.description).toBe('Sinister Cape +3');
        expect(checked.cost).toBe(advisor.calculateUpgradeCost({ ...checked }, gameData));
    });
});

describe('skilling: which kits a checked swap reaches', () => {
    const MILKING = '/skills/milking';
    const FORAGING = '/skills/foraging';
    const CRAFTING = '/skills/crafting';
    const TOOL = '/equipment_types/milking_tool';

    const kits = () => ({
        dto: { equipment: { [BACK]: piece(CAPE, 5) } },
        skillEquipmentMap: {
            [MILKING]: { [TOOL]: piece(MILKING_TOOL, 2), [BACK]: piece(CAPE, 5) },
            [FORAGING]: { [BACK]: piece(CAPE, 5) },
        },
        skills: [MILKING, FORAGING, CRAFTING],
    });

    test('a milking tool is written into the milking kit and no other', () => {
        const context = kits();
        const candidate = buildSkillingSwapCandidate({ hrid: MILKING_TOOL, level: 7 }, context, gameData);

        expect(candidate.skillKeys).toEqual([MILKING]);
        expect(candidate.members).toHaveLength(1);
        expect(candidate.type).toBe('enhancement');
        expect(candidate.description).toBe('Celestial Milking Tool +2 → +7 (milking)');

        const after = applySkillingCandidate(
            { dto: context.dto, skillEquipmentMap: context.skillEquipmentMap },
            candidate
        );
        expect(after.skillEquipmentMap[MILKING][TOOL]).toEqual({ hrid: MILKING_TOOL, enhancementLevel: 7 });
        expect(after.skillEquipmentMap[FORAGING][TOOL]).toBeUndefined();
        expect(after.dto.equipment[TOOL]).toBeUndefined();
        // The setup it was applied to is untouched
        expect(context.skillEquipmentMap[MILKING][TOOL].enhancementLevel).toBe(2);
    });

    test('a kit already wearing it that high is left out, and a swap nobody can feel is reported', () => {
        const context = kits();
        context.skillEquipmentMap[MILKING][TOOL] = piece(MILKING_TOOL, 9);
        expect(buildSkillingSwapCandidate({ hrid: MILKING_TOOL, level: 7 }, context, gameData)).toBeNull();
        // A combat cape moves no skilling room
        expect(buildSkillingSwapCandidate({ hrid: CAPE, level: 9 }, kits(), gameData)).toBeNull();
        // Nor does a tool for a skill that is not in the run
        const narrowed = { ...kits(), skills: [FORAGING] };
        expect(buildSkillingSwapCandidate({ hrid: MILKING_TOOL, level: 7 }, narrowed, gameData)).toBeNull();
    });

    test('a skill running in the base kit gets a kit of its own rather than changing everyone', () => {
        const context = {
            dto: { equipment: { [BACK]: piece(CAPE, 5) } },
            skillEquipmentMap: {},
            skills: [MILKING, CRAFTING],
        };
        const candidate = buildSkillingSwapCandidate({ hrid: MILKING_TOOL, level: 5 }, context, gameData);
        const after = applySkillingCandidate({ dto: context.dto, skillEquipmentMap: {} }, candidate);

        expect(after.skillEquipmentMap[MILKING][TOOL]).toEqual({ hrid: MILKING_TOOL, enhancementLevel: 5 });
        expect(after.skillEquipmentMap[CRAFTING]).toBeUndefined();
        expect(after.dto.equipment[TOOL]).toBeUndefined();
    });

    test('rows are measured against the baseline in the shape the Skilling table draws', async () => {
        const context = kits();
        // A stand-in evaluator: clearing is likelier the higher the milking tool
        const evaluate = (setup) => {
            const level = setup.skillEquipmentMap[MILKING]?.[TOOL]?.enhancementLevel ?? 0;
            return { clearRate: 0.5 + level * 0.01, xpPerRoom: 100 };
        };
        const progress = [];

        const out = await evaluateSkillingSwaps({
            swaps: [
                { hrid: MILKING_TOOL, level: 7 },
                { hrid: CAPE, level: 9 },
            ],
            baseSetup: { dto: context.dto, skillEquipmentMap: context.skillEquipmentMap },
            evaluate,
            applySetup: (setup, candidate) => applySkillingCandidate(setup, candidate),
            roomLevel: 100,
            skills: context.skills,
            gameData,
            yieldFn: async () => {},
            onProgress: (p) => progress.push(p.description),
        });

        expect(out.baseline.clearRate).toBeCloseTo(0.52);
        expect(out.rows).toHaveLength(1);
        expect(out.rows[0]).toMatchObject({ costType: 'gold', metricType: 'clearRate' });
        expect(out.rows[0].clearRateDelta).toBeCloseTo(0.05);
        expect(out.rows[0].cost).toBe(advisor.calculateUpgradeCost(out.rows[0].candidate, gameData));
        expect(out.rows[0].goldPerClearRate).toBeCloseTo(out.rows[0].cost / 5);
        expect(out.unreached).toEqual([{ hrid: CAPE, level: 9 }]);
        expect(progress).toEqual(['Celestial Milking Tool +7', 'Sinister Cape +9']);
    });

    test('Stop ends it between swaps', async () => {
        const context = kits();
        let calls = 0;
        const out = await evaluateSkillingSwaps({
            swaps: [
                { hrid: MILKING_TOOL, level: 7 },
                { hrid: MILKING_TOOL, level: 8 },
            ],
            baseSetup: { dto: context.dto, skillEquipmentMap: context.skillEquipmentMap },
            evaluate: () => ({ clearRate: 0.5 }),
            applySetup: (setup) => setup,
            roomLevel: 100,
            skills: context.skills,
            gameData,
            abortSignal: () => ++calls > 1,
            yieldFn: async () => {},
        });
        expect(out.rows).toHaveLength(1);
    });
});
