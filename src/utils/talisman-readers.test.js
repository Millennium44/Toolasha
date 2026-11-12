/**
 * Readers that rebuild skilling bonuses from equipment get the slotted talismans through the equipment Map.
 *
 * The bonus set is computed for the Map (live: dataManager.getEquipment(); a loadout: its own store), attached,
 * and read back by the shared parsers. Values are the measured ones: Large belt +10 -> power 0.258.
 */

import { describe, test, expect, vi } from 'vitest';
import {
    BELT_ITEMS,
    MODIFIER_DETAILS,
    TALISMAN_ENHANCEMENT_TABLE,
    talisman,
} from '../__fixtures__/talisman-bonuses.js';

vi.mock('../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({}),
        getHouseRooms: () => new Map(),
        getAchievementBuffFlatBoost: () => 0,
        getPersonalBuffFlatBoost: () => 0,
    },
}));
vi.mock('./action-context.js', () => ({ resolveActionContext: () => ({ equipment: new Map(), drinks: [] }) }));
vi.mock('./game-server.js', () => ({ isTestServer: () => true }));

const { computeTalismanBonuses, attachTalismanBonuses } = await import('./talisman-bonuses.js');
const {
    parseEquipmentSpeedBonuses,
    parseEquipmentEfficiencyBonuses,
    parseEquipmentEfficiencyBreakdown,
    parseGatheringQuantityBonus,
    parseEssenceFindBonus,
    parseRareFindBonus,
    parseEquipmentTalismanBuff,
    debugEquipmentSpeedBonuses,
} = await import('./equipment-parser.js');
const { parseEquipmentWisdom, parseCharmExperience } = await import('./experience-parser.js');
const { detectSkillGear } = await import('./enhancement-gear-detector.js');
const { compareGearStats } = await import('../core/gear-stats-check.js');

const POWER = 1.258;
const items = {
    ...BELT_ITEMS,
    '/items/philosophers_necklace': {
        name: "Philosopher's Necklace",
        equipmentDetail: {
            type: '/equipment_types/neck',
            noncombatStats: { skillingSpeed: 0.01 },
            noncombatEnhancementBonuses: {},
        },
    },
};

/** An equipment Map wearing the Large belt +10 (and a necklace), carrying the given slotted talismans */
function wearing(talismans, { belt = true } = {}) {
    const map = new Map([['/item_locations/neck', { itemHrid: '/items/philosophers_necklace', enhancementLevel: 0 }]]);
    const beltItem = belt ? { itemHrid: '/items/large_talisman_belt', enhancementLevel: 10 } : null;
    if (beltItem) map.set('/item_locations/belt', beltItem);
    return attachTalismanBonuses(
        map,
        computeTalismanBonuses({
            talismans,
            belt: beltItem,
            itemDetailMap: items,
            modifierDetailMap: MODIFIER_DETAILS,
            enhancementTable: TALISMAN_ENHANCEMENT_TABLE,
        })
    );
}

describe('speed and efficiency', () => {
    const milkingG2 = talisman(1, 1, [['milking_speed', 2]]);

    test('Milking Speed G2 adds 0.05661 to milking, on top of the necklace', () => {
        const equipment = wearing([milkingG2]);
        expect(parseEquipmentSpeedBonuses(equipment, '/action_types/milking', items)).toBeCloseTo(0.01 + 0.05661, 10);
    });

    test('and nothing to another skill (the line is Milking only)', () => {
        const equipment = wearing([milkingG2]);
        expect(parseEquipmentSpeedBonuses(equipment, '/action_types/cooking', items)).toBeCloseTo(0.01, 10);
    });

    test('a Skilling Speed line speeds every skill', () => {
        const equipment = wearing([talisman(1, 1, [['skilling_speed', 1]])]);
        for (const skill of ['milking', 'cooking', 'enhancing', 'alchemy']) {
            expect(parseEquipmentSpeedBonuses(equipment, `/action_types/${skill}`, items)).toBeCloseTo(
                0.01 + 0.01 * POWER,
                10
            );
        }
    });

    test('two talismans with the same modifier stack', () => {
        const equipment = wearing([milkingG2, talisman(2, 2, [['milking_speed', 2]])]);
        expect(parseEquipmentSpeedBonuses(equipment, '/action_types/milking', items)).toBeCloseTo(
            0.01 + 2 * 0.05661,
            10
        );
    });

    test('efficiency comes back as a percentage, and its breakdown lines still add up', () => {
        const equipment = wearing([
            talisman(1, 1, [
                ['milking_efficiency', 2],
                ['skilling_efficiency', 1],
            ]),
        ]);
        const total = parseEquipmentEfficiencyBonuses(equipment, '/action_types/milking', items);
        expect(total).toBeCloseTo((0.045 + 0.01) * POWER * 100, 8);
        const lines = parseEquipmentEfficiencyBreakdown(equipment, '/action_types/milking', items);
        expect(lines.reduce((sum, line) => sum + line.value, 0)).toBeCloseTo(total, 8);
        expect(lines.map((l) => l.name)).toEqual(['Talismans']);
    });

    test('the speed debug list carries the talisman line so it adds up to the parser total', () => {
        const equipment = wearing([milkingG2]);
        const listed = debugEquipmentSpeedBonuses(equipment, items)
            .filter((b) => b.speedType === 'milkingSpeed' || b.speedType === 'skillingSpeed')
            .reduce((sum, b) => sum + b.scaledBonus, 0);
        expect(listed).toBeCloseTo(parseEquipmentSpeedBonuses(equipment, '/action_types/milking', items), 10);
    });
});

describe('other stats', () => {
    test('rare find, gathering quantity, and a skill-specific essence find', () => {
        const equipment = wearing([
            talisman(1, 1, [
                ['milking_rare_find', 1],
                ['gathering_quantity', 2],
                ['alchemy_essence_find', 1],
            ]),
        ]);
        expect(parseRareFindBonus(equipment, '/action_types/milking', items)).toBeCloseTo(0.09 * POWER * 100, 8);
        expect(parseGatheringQuantityBonus(equipment, items)).toBeCloseTo(0.03 * POWER, 10);
        expect(parseEssenceFindBonus(equipment, items, '/action_types/alchemy')).toBeCloseTo(0.15 * POWER * 100, 8);
        // The skill-specific line does not reach another skill, or a caller that names none
        expect(parseEssenceFindBonus(equipment, items, '/action_types/milking')).toBe(0);
        expect(parseEssenceFindBonus(equipment, items)).toBe(0);
    });

    test('experience: Skilling Experience is wisdom, a skill experience line is that skill charm experience', () => {
        const equipment = wearing([
            talisman(1, 1, [
                ['skilling_experience', 3],
                ['milking_experience', 1],
            ]),
        ]);
        const wisdom = parseEquipmentWisdom(equipment, items);
        expect(wisdom.total).toBeCloseTo(0.02 * POWER * 100, 8);
        expect(wisdom.breakdown.map((b) => b.name)).toEqual(['Talismans']);
        expect(parseCharmExperience(equipment, '/skills/milking', items).total).toBeCloseTo(0.03 * POWER * 100, 8);
        expect(parseCharmExperience(equipment, '/skills/cooking', items).total).toBe(0);
    });

    test('the skill gear detector (enhancing and every other skill) counts speed, rare find and experience', () => {
        const equipment = wearing([
            talisman(1, 1, [
                ['milking_speed', 1],
                ['milking_rare_find', 1],
                ['skilling_experience', 1],
            ]),
        ]);
        const gear = detectSkillGear('milking', equipment, items);
        expect(gear.speedBonus).toBeCloseTo(1 + 0.03 * POWER * 100, 8); // necklace 1% + talisman
        expect(gear.rareFindBonus).toBeCloseTo(0.09 * POWER * 100, 8);
        expect(gear.experienceBonus).toBeCloseTo(0.01 * POWER * 100, 8);
    });
});

describe('buffs', () => {
    test('Gourmet and Processing reach the buff readers', () => {
        const equipment = wearing([
            talisman(1, 1, [
                ['gourmet', 3],
                ['processing', 2],
            ]),
        ]);
        expect(parseEquipmentTalismanBuff(equipment, '/buff_types/gourmet')).toBeCloseTo(0.02 * POWER, 10);
        expect(parseEquipmentTalismanBuff(equipment, '/buff_types/processing')).toBeCloseTo(0.03 * POWER, 10);
        expect(parseEquipmentTalismanBuff(equipment, '/buff_types/artisan')).toBe(0);
    });
});

describe('without a belt, or in a Map nobody attached to', () => {
    const talismans = [
        talisman(1, 1, [
            ['milking_speed', 6],
            ['gourmet', 6],
            ['skilling_experience', 6],
        ]),
    ];

    test('no belt: every reader returns what gear alone gives', () => {
        const equipment = wearing(talismans, { belt: false });
        expect(parseEquipmentSpeedBonuses(equipment, '/action_types/milking', items)).toBeCloseTo(0.01, 10);
        expect(parseEquipmentTalismanBuff(equipment, '/buff_types/gourmet')).toBe(0);
        expect(parseEquipmentWisdom(equipment, items).total).toBe(0);
    });

    test('a hypothetical Map a reader built itself (or a copy) reads gear alone', () => {
        const equipment = wearing(talismans);
        const copy = new Map(equipment);
        expect(parseEquipmentSpeedBonuses(copy, '/action_types/milking', items)).toBeCloseTo(0.01, 10);
        expect(parseEquipmentTalismanBuff(copy, '/buff_types/gourmet')).toBe(0);
    });
});

describe('a reader of the server totals is not double counted', () => {
    test('the gear check compares gear plus talismans with a server total that already has them: no mismatch', () => {
        const equipment = wearing([
            talisman(1, 1, [
                ['milking_speed', 2],
                ['milking_efficiency', 2],
            ]),
        ]);
        const clientData = { itemDetailMap: items };
        const serverTotals = {
            milkingSpeed: 0.05661,
            skillingSpeed: 0.01,
            milkingEfficiency: 0.05661,
        };
        const { compared, mismatches } = compareGearStats(equipment, clientData.itemDetailMap, serverTotals);
        expect(compared).toBeGreaterThan(0);
        expect(mismatches).toEqual([]);
    });
});
