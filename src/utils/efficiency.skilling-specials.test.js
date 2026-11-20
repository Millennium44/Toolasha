/**
 * The skilling Special lines the test patch of 2026-11-20 added, read from a worn talisman through the equipment Map:
 * Abundance and Invigoration in the efficiency context, Epiphany (and Invigoration's Wisdom) in the XP multiplier.
 * Large belt +10 is Talisman Power 0.258, so a line is its grade value x 1.258. Grade values are the game's.
 */

import { describe, test, expect, vi } from 'vitest';
import {
    BELT_ITEMS,
    MODIFIER_DETAILS,
    TALISMAN_ENHANCEMENT_TABLE,
    talisman,
} from '../__fixtures__/talisman-bonuses.js';

const ITEMS = {
    ...BELT_ITEMS,
    '/items/efficiency_tea': {
        name: 'Efficiency Tea',
        consumableDetail: { buffs: [{ typeHrid: '/buff_types/efficiency', flatBoost: 0.1 }] },
    },
    '/items/gourmet_tea': {
        name: 'Gourmet Tea',
        consumableDetail: { buffs: [{ typeHrid: '/buff_types/gourmet', flatBoost: 0.12 }] },
    },
    '/items/wisdom_tea': {
        name: 'Wisdom Tea',
        consumableDetail: { buffs: [{ typeHrid: '/buff_types/wisdom', flatBoost: 0.12 }] },
    },
};

vi.mock('../core/data-manager.js', () => ({
    default: {
        getSkills: () => [],
        getInitClientData: () => ({ itemDetailMap: ITEMS, houseRoomDetailMap: {} }),
        getPersonalBuffFlatBoost: () => 0,
        getAchievementBuffFlatBoost: () => 0,
        getHouseRooms: () => new Map(),
        getHouseRoomLevel: () => 0,
        getCommunityBuffLevel: () => 0,
        getMooPassBuffs: () => [],
        characterData: {},
    },
}));
vi.mock('./action-context.js', () => ({ resolveActionContext: () => ({ equipment: new Map(), drinks: [] }) }));
vi.mock('./game-server.js', () => ({ isTestServer: () => true }));

const { getActionEfficiencyContext } = await import('./efficiency.js');
const { calculateExperienceMultiplier } = await import('./experience-parser.js');
const { computeTalismanBonuses, attachTalismanBonuses } = await import('./talisman-bonuses.js');

const POWER = 1.258;
const belt = { itemHrid: '/items/large_talisman_belt', enhancementLevel: 10 };
const withTalismans = (talismans) =>
    attachTalismanBonuses(
        new Map([
            [
                '/item_locations/belt',
                { itemHrid: belt.itemHrid, itemLocationHrid: '/item_locations/belt', enhancementLevel: 10 },
            ],
        ]),
        computeTalismanBonuses({
            talismans,
            belt,
            itemDetailMap: ITEMS,
            modifierDetailMap: MODIFIER_DETAILS,
            enhancementTable: TALISMAN_ENHANCEMENT_TABLE,
        })
    );

const cooking = {
    type: '/action_types/cooking',
    baseTimeCost: 6e9,
    levelRequirement: { skillHrid: '/skills/cooking', level: 1 },
};
const woodcutting = {
    type: '/action_types/woodcutting',
    baseTimeCost: 6e9,
    levelRequirement: { skillHrid: '/skills/woodcutting', level: 1 },
};
const gameData = { itemDetailMap: ITEMS, houseRoomDetailMap: {} };
const drinks = (...hrids) => hrids.map((h) => ({ itemHrid: `/items/${h}` }));

describe('Abundance', () => {
    test('G2 (0.015) under a Large belt +10 is 0.015 x 1.258 on a gathering action', () => {
        const out = getActionEfficiencyContext(woodcutting, {
            gameData,
            actionContext: { equipment: withTalismans([talisman(1, 1, [['abundance', 2]])]), drinks: [] },
        });
        expect(out.abundance).toBeCloseTo(0.015 * POWER, 12);
    });

    test('a second copy on another talisman counts once, at the highest grade (a Special line)', () => {
        const out = getActionEfficiencyContext(woodcutting, {
            gameData,
            actionContext: {
                equipment: withTalismans([talisman(1, 1, [['abundance', 2]]), talisman(2, 2, [['abundance', 5]])]),
                drinks: [],
            },
        });
        expect(out.abundance).toBeCloseTo(0.03 * POWER, 12);
    });

    test('it is zero on a production action, and with no talisman', () => {
        const worn = withTalismans([talisman(1, 1, [['abundance', 6]])]);
        expect(
            getActionEfficiencyContext(cooking, { isProduction: true, actionContext: { equipment: worn, drinks: [] } })
                .abundance
        ).toBe(0);
        expect(
            getActionEfficiencyContext(woodcutting, { gameData, actionContext: { equipment: new Map(), drinks: [] } })
                .abundance
        ).toBe(0);
    });
});

describe('Invigoration', () => {
    const G3 = 0.06 * POWER; // 0.07548

    test('G3 doubles the drinks with that chance: tea efficiency and Gourmet are (1 + chance) times stronger', () => {
        const out = getActionEfficiencyContext(cooking, {
            isProduction: true,
            actionContext: {
                equipment: withTalismans([talisman(1, 1, [['invigoration', 3]])]),
                drinks: drinks('efficiency_tea', 'gourmet_tea'),
            },
        });
        expect(out.invigoration).toBeCloseTo(G3, 12);
        expect(out.teaEfficiency).toBeCloseTo(10 * (1 + G3), 10);
        expect(out.gourmetBonus).toBeCloseTo(0.12 * (1 + G3), 12);
        // What a drink costs is not doubled: the concentration the cost reads is untouched
        expect(out.drinkConcentration).toBe(0);
    });

    test('with no drinks worn, Invigoration has nothing to double', () => {
        const out = getActionEfficiencyContext(cooking, {
            isProduction: true,
            actionContext: { equipment: withTalismans([talisman(1, 1, [['invigoration', 6]])]), drinks: [] },
        });
        expect(out.teaEfficiency).toBe(0);
        expect(out.gourmetBonus).toBe(0);
    });

    test('it does nothing outside cooking and brewing', () => {
        const out = getActionEfficiencyContext(woodcutting, {
            gameData,
            actionContext: {
                equipment: withTalismans([talisman(1, 1, [['invigoration', 6]])]),
                drinks: drinks('efficiency_tea'),
            },
        });
        expect(out.invigoration).toBe(0);
        expect(out.teaEfficiency).toBeCloseTo(10, 10);
    });
});

describe('Epiphany and the XP multiplier', () => {
    test('G4 (0.025) is 0.025 x 1.258 more XP in expectation, applied to the final XP', () => {
        const worn = withTalismans([talisman(1, 1, [['epiphany', 4]])]);
        const out = calculateExperienceMultiplier('/skills/cooking', '/action_types/cooking', {
            equipment: worn,
            drinks: [],
        });
        expect(out.epiphany).toBeCloseTo(0.025 * POWER, 12);
        expect(out.totalMultiplier).toBeCloseTo(1 + 0.025 * POWER, 12);
    });

    test('it multiplies the Wisdom pool instead of adding to it: 12% Wisdom x (1 + 0.03145)', () => {
        const out = calculateExperienceMultiplier('/skills/cooking', '/action_types/cooking', {
            equipment: withTalismans([talisman(1, 1, [['epiphany', 4]])]),
            drinks: drinks('wisdom_tea'),
        });
        expect(out.totalMultiplier).toBeCloseTo(1.12 * (1 + 0.025 * POWER), 12);
    });

    test('Invigoration strengthens a Wisdom drink on cooking: 12% x (1 + 0.07548) = 12.90576%', () => {
        const out = calculateExperienceMultiplier('/skills/cooking', '/action_types/cooking', {
            equipment: withTalismans([talisman(1, 1, [['invigoration', 3]])]),
            drinks: drinks('wisdom_tea'),
        });
        expect(out.breakdown.consumableWisdom).toBeCloseTo(12 * (1 + 0.06 * POWER), 10);
        // and not on woodcutting, which has no Invigoration
        const wood = calculateExperienceMultiplier('/skills/woodcutting', '/action_types/woodcutting', {
            equipment: withTalismans([talisman(1, 1, [['invigoration', 3]])]),
            drinks: drinks('wisdom_tea'),
        });
        expect(wood.breakdown.consumableWisdom).toBeCloseTo(12, 10);
    });

    test('combat XP is not skilling XP: Epiphany adds nothing there', () => {
        const out = calculateExperienceMultiplier('/skills/attack', '/action_types/combat', {
            equipment: withTalismans([talisman(1, 1, [['epiphany', 6]])]),
            drinks: [],
        });
        expect(out.epiphany).toBe(0);
        expect(out.totalMultiplier).toBe(1);
    });

    test('a talisman that no longer carries a removed line (Gourmet) reads as nothing, without throwing', () => {
        // A client on the new game data has no detail for the removed lines: the record still names them
        const worn = attachTalismanBonuses(
            new Map([['/item_locations/belt', { itemHrid: belt.itemHrid, enhancementLevel: 10 }]]),
            computeTalismanBonuses({
                talismans: [
                    talisman(1, 1, [
                        ['gourmet', 3],
                        ['processing', 2],
                        ['gathering_quantity', 1],
                        ['epiphany', 1],
                    ]),
                ],
                belt,
                itemDetailMap: ITEMS,
                modifierDetailMap: Object.fromEntries(
                    Object.entries(MODIFIER_DETAILS).filter(
                        ([hrid]) => !/gourmet|processing|gathering_quantity/.test(hrid)
                    )
                ),
                enhancementTable: TALISMAN_ENHANCEMENT_TABLE,
            })
        );
        const ctx = getActionEfficiencyContext(cooking, {
            isProduction: true,
            actionContext: { equipment: worn, drinks: [] },
        });
        expect(ctx.gourmetBonus).toBe(0);
        expect(
            calculateExperienceMultiplier('/skills/cooking', '/action_types/cooking', { equipment: worn, drinks: [] })
                .epiphany
        ).toBeCloseTo(0.01 * POWER, 12);
    });
});
