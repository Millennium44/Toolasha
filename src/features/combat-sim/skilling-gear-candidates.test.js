/**
 * Offering gear you are not wearing, per skill.
 *
 * The skilling advisor could only ever enhance what was already on, which meant
 * it was silent about the two things that actually move a labyrinth skilling
 * room — a celestial tool and the skill's own outfit. Both live in the item data
 * rather than on the character, so neither was ever a candidate.
 */

import { describe, test, expect } from 'vitest';
import {
    relevantStats,
    skillScore,
    canEquip,
    affectsSkill,
    scopeEquipmentToSkill,
    bestGearForSkill,
    isCombatOnlyItem,
    NEW_GEAR_LEVEL,
} from './skilling-gear-candidates.js';

const gear = (type, stats, over = {}) => ({
    name: over.name,
    equipmentDetail: { type, noncombatStats: stats, levelRequirements: over.levelRequirements || [] },
});

const ITEMS = {
    '/items/celestial_brush': gear('/equipment_types/milking_tool', { milkingSpeed: 0.5 }, { name: 'Celestial Brush' }),
    '/items/basic_brush': gear('/equipment_types/milking_tool', { milkingSpeed: 0.1 }, { name: 'Basic Brush' }),
    '/items/milking_top': gear('/equipment_types/body', { milkingEfficiency: 0.2 }, { name: 'Milking Top' }),
    '/items/crafting_top': gear('/equipment_types/body', { craftingEfficiency: 0.2 }, { name: 'Crafting Top' }),
    '/items/celestial_chisel': gear(
        '/equipment_types/crafting_tool',
        { craftingSpeed: 0.5 },
        { name: 'Celestial Chisel' }
    ),
    '/items/generic_cape': gear('/equipment_types/back', { skillingSpeed: 0.05 }, { name: 'Generic Cape' }),
    '/items/sword': gear('/equipment_types/main_hand', {}, { name: 'Sword' }),
    // A charm whose only stat the room simulation never reads
    '/items/rare_find_charm': gear(
        '/equipment_types/charm',
        { skillingRareFind: 0.3, milkingRareFind: 0.2 },
        { name: 'Rare Find Charm' }
    ),
    '/items/collectors_boots': gear(
        '/equipment_types/feet',
        { gatheringQuantity: 0.15 },
        { name: "Collector's Boots" }
    ),
    '/items/locked_brush': gear(
        '/equipment_types/milking_tool',
        { milkingSpeed: 0.9 },
        {
            name: 'Locked Brush',
            levelRequirements: [{ levelTypeHrid: '/level_types/milking', level: 120 }],
        }
    ),
};

const LEVELS = new Map([
    ['/skills/milking', 100],
    ['/skills/crafting', 100],
]);

const forSkill = (skill, equipment = {}) =>
    bestGearForSkill({ skill, equipment, itemDetailMap: ITEMS, levels: LEVELS });
const named = (skill, equipment) => forSkill(skill, equipment).map((c) => c.upgradeHrid);

describe('what counts as being for a skill', () => {
    test('the skill’s own stats and the generic skilling ones', () => {
        const stats = relevantStats('milking');
        expect(stats.has('milkingSpeed')).toBe(true);
        expect(stats.has('skillingEfficiency')).toBe(true);
    });

    test('only the stats the room simulation actually reads off a kit', () => {
        // A kit reaches the labyrinth skilling model as exactly two numbers —
        // a speed and an efficiency. Rare find, essence find and gathering
        // quantity worn on gear are read by nobody, so counting them bought a
        // full room evaluation per piece to prove +0.00%
        const stats = relevantStats('milking');

        expect([...stats].sort()).toEqual(['milkingEfficiency', 'milkingSpeed', 'skillingEfficiency', 'skillingSpeed']);
    });

    test('enhancing has a speed stat and no efficiency one, which is the game’s own shape', () => {
        // `VALID_EFFICIENCY_FIELDS` in the equipment parser has no
        // `enhancingEfficiency`, and an enhancing room clears on success rate
        const stats = relevantStats('enhancing');

        expect(stats.has('enhancingSpeed')).toBe(true);
        expect(stats.has('enhancingEfficiency')).toBe(false);
    });

    test('an item with no relevant stat scores nothing', () => {
        expect(skillScore(ITEMS['/items/sword'], relevantStats('milking'))).toBe(0);
        expect(skillScore(ITEMS['/items/crafting_top'], relevantStats('milking'))).toBe(0);
        expect(skillScore(ITEMS['/items/rare_find_charm'], relevantStats('milking'))).toBe(0);
        expect(skillScore(ITEMS['/items/collectors_boots'], relevantStats('milking'))).toBe(0);
    });

    test('and is therefore never offered as a candidate for it', () => {
        expect(named('milking')).not.toContain('/items/rare_find_charm');
        expect(named('milking')).not.toContain('/items/collectors_boots');
    });
});

describe('what a run of one skill is allowed to weigh', () => {
    const ITEM_MAP = ITEMS;

    test('another skill’s tool cannot move this skill’s room, so it is not weighed', () => {
        // The complaint this is about: a Cooking run spending simulations on
        // "Holy Chisel +5 → +7", which is a crafting tool
        expect(affectsSkill(ITEMS['/items/celestial_chisel'], 'crafting')).toBe(true);
        expect(affectsSkill(ITEMS['/items/celestial_chisel'], 'cooking')).toBe(false);
    });

    test('gear with a generic skilling stat is for everybody, which is what generic means', () => {
        expect(affectsSkill(ITEMS['/items/generic_cape'], 'cooking')).toBe(true);
        expect(affectsSkill(ITEMS['/items/generic_cape'], 'enhancing')).toBe(true);
    });

    test('a scoped kit drops the pieces this skill cannot feel', () => {
        const worn = {
            '/equipment_types/crafting_tool': { hrid: '/items/celestial_chisel', enhancementLevel: 5 },
            '/equipment_types/body': { hrid: '/items/crafting_top', enhancementLevel: 3 },
            '/equipment_types/back': { hrid: '/items/generic_cape', enhancementLevel: 0 },
        };

        const scoped = scopeEquipmentToSkill(worn, '/skills/milking', ITEM_MAP);

        expect(Object.keys(scoped)).toEqual(['/equipment_types/back']);
    });

    test('and keeps them for the skill they belong to', () => {
        const worn = { '/equipment_types/crafting_tool': { hrid: '/items/celestial_chisel', enhancementLevel: 5 } };

        expect(scopeEquipmentToSkill(worn, '/skills/crafting', ITEM_MAP)).toEqual(worn);
    });

    test('a piece with no noncombat stats at all stays put', () => {
        // It generates no enhancement candidate anyway, and it is what a
        // philosopher's-accessory swap is measured against — dropping it would
        // turn "trade this for the philosopher's one" into "fill an empty slot"
        // and price the trade without its sale
        const worn = { '/equipment_types/main_hand': { hrid: '/items/sword', enhancementLevel: 0 } };

        expect(scopeEquipmentToSkill(worn, '/skills/milking', ITEM_MAP)).toEqual(worn);
    });

    test('and so does an item the game data has never heard of', () => {
        const worn = { '/equipment_types/body': { hrid: '/items/mystery', enhancementLevel: 0 } };

        expect(scopeEquipmentToSkill(worn, '/skills/milking', ITEM_MAP)).toEqual(worn);
    });

    test('nothing worn is nothing scoped, rather than a throw', () => {
        expect(scopeEquipmentToSkill(undefined, '/skills/milking', ITEM_MAP)).toEqual({});
        expect(scopeEquipmentToSkill({ '/equipment_types/body': null }, '/skills/milking', ITEM_MAP)).toEqual({});
    });
});

describe('what you can actually wear', () => {
    test('a requirement you meet is no obstacle', () => {
        expect(canEquip(ITEMS['/items/celestial_brush'], LEVELS)).toBe(true);
    });

    test('one you do not is', () => {
        // A tool twenty levels out of reach is a shopping list, not an upgrade,
        // and would sit at the top of a ranked list pushing down what you could
        // buy today
        expect(canEquip(ITEMS['/items/locked_brush'], LEVELS)).toBe(false);
    });

    test('and levels can arrive as a plain object as well as a map', () => {
        expect(canEquip(ITEMS['/items/locked_brush'], { '/skills/milking': 130 })).toBe(true);
    });
});

describe('the best piece per slot', () => {
    test('a celestial tool is offered where none is worn', () => {
        expect(named('milking')).toContain('/items/celestial_brush');
    });

    test('and over a worse one that is', () => {
        const candidates = forSkill('milking', {
            '/equipment_types/milking_tool': { hrid: '/items/basic_brush', enhancementLevel: 3 },
        });
        const brush = candidates.find((c) => c.slot === '/equipment_types/milking_tool');

        expect(brush.upgradeHrid).toBe('/items/celestial_brush');
        expect(brush.description).toContain('Basic Brush');
    });

    test('but not when the better one is already on', () => {
        const worn = { '/equipment_types/milking_tool': { hrid: '/items/celestial_brush', enhancementLevel: 0 } };

        expect(named('milking', worn)).not.toContain('/items/celestial_brush');
    });

    test('one candidate per slot, not every tier of the same tool', () => {
        // The analysis simulates each candidate; six tiers of one tool would
        // spend the run proving the best one is the best one
        const tools = forSkill('milking').filter((c) => c.slot === '/equipment_types/milking_tool');

        expect(tools).toHaveLength(1);
    });

    test('a locked tool is never the winner, even when it is the best', () => {
        expect(named('milking')).not.toContain('/items/locked_brush');
    });
});

describe('a skill only gets its own gear', () => {
    test('a milking outfit is offered for milking', () => {
        expect(named('milking')).toContain('/items/milking_top');
    });

    test('and never for crafting', () => {
        // The analysis runs over every skill at once, and a candidate with no
        // skill on it is applied to all of them — an outfit would appear to help
        // rooms it cannot affect, which is the kind of wrong that reads as right
        expect(named('crafting')).not.toContain('/items/milking_top');
        expect(named('crafting')).toContain('/items/crafting_top');
    });

    test('another skill’s tool is not offered for a slot it cannot go in', () => {
        expect(named('milking')).not.toContain('/items/celestial_chisel');
    });

    test('generic skilling gear is offered to everybody, which is what generic means', () => {
        expect(named('milking')).toContain('/items/generic_cape');
        expect(named('crafting')).toContain('/items/generic_cape');
    });

    test('every candidate says which skill it belongs to', () => {
        expect(forSkill('milking').every((c) => c.skillKey === 'milking')).toBe(true);
    });
});

describe('a skill named either way', () => {
    // The panel and the equipment map hold skills as hrids; the stat names are
    // bare. Taking only the bare form meant an hrid looked for
    // `/skills/milkingSpeed`, matched nothing, missed the tool slot entirely,
    // and returned an empty list without ever erroring — the feature was inert
    // in the one place it is actually called from
    test('an hrid finds the same stats as a bare name', () => {
        expect(relevantStats('/skills/milking').has('milkingSpeed')).toBe(true);
    });

    test('and the same tool, which a missed slot lookup filters out entirely', () => {
        const byHrid = bestGearForSkill({ skill: '/skills/milking', itemDetailMap: ITEMS, levels: LEVELS });

        expect(byHrid.map((c) => c.upgradeHrid)).toContain('/items/celestial_brush');
        expect(byHrid.map((c) => c.upgradeHrid)).toEqual(named('milking'));
    });

    test('the description reads as a skill, not as a path', () => {
        const [candidate] = bestGearForSkill({ skill: '/skills/milking', itemDetailMap: ITEMS, levels: LEVELS });

        expect(candidate.description).toContain('(milking)');
    });

    test('but the key stays as it was given, since that is what the equipment map is keyed by', () => {
        const [candidate] = bestGearForSkill({ skill: '/skills/milking', itemDetailMap: ITEMS, levels: LEVELS });

        expect(candidate.skillKey).toBe('/skills/milking');
    });
});

describe('the shape the analysis expects', () => {
    test('an empty slot names nothing it would replace, so it is not priced as free', () => {
        const candidate = forSkill('milking').find((c) => c.slot === '/equipment_types/milking_tool');

        expect(candidate.currentHrid).toBe('');
        expect(candidate.type).toBe('skilling_gear');
    });

    test('a piece you do not own is offered at +5, not +0', () => {
        // Nobody buys a celestial tool and leaves it there, so +0 answers a
        // question nobody asked — and understates both its cost and its gain
        // against candidates judged at the level they would actually be run
        const candidate = forSkill('milking').find((c) => c.slot === '/equipment_types/milking_tool');

        expect(NEW_GEAR_LEVEL).toBe(5);
        expect(candidate.upgradeLevel).toBe(5);
        expect(candidate.description).toContain('+5');
    });

    test('nothing in the game data is nothing offered, rather than a throw', () => {
        expect(bestGearForSkill({ skill: 'milking', itemDetailMap: {} })).toEqual([]);
        expect(bestGearForSkill({ skill: 'milking' })).toEqual([]);
    });
});

/**
 * Combat gear is not sold to buy skilling gear.
 *
 * The Skilling tab offered "Maelstrom Plate Body ★ → Lumberjack's Top +5" at a
 * cost of −410,000,000, because the swap credited the resale of the plate. The
 * plate is not for sale: it goes back on the moment the woodcutting stops, and
 * a loadout holds both. The negative cost then divided into a Gold/1% that
 * ranked a woodcutting shirt above every real upgrade in the table.
 */
describe('what a skilling swap is allowed to sell', () => {
    const COMBAT_PLATE = {
        name: 'Maelstrom Plate Body',
        equipmentDetail: { type: '/equipment_types/body', combatStats: { armor: 40 }, noncombatStats: {} },
    };
    const HYBRID_NECKLACE = {
        name: "Philosopher's Necklace",
        equipmentDetail: {
            type: '/equipment_types/neck',
            combatStats: { armor: 2 },
            noncombatStats: { skillingEfficiency: 0.05 },
        },
    };

    test('a piece with combat stats and no noncombat ones is combat gear', () => {
        expect(isCombatOnlyItem(COMBAT_PLATE)).toBe(true);
    });

    test('a piece carrying both is not — it is worn for the skilling half too', () => {
        expect(isCombatOnlyItem(HYBRID_NECKLACE)).toBe(false);
    });

    test('and a piece with neither is not combat gear, which is a different claim', () => {
        expect(isCombatOnlyItem({ equipmentDetail: { type: '/equipment_types/body' } })).toBe(false);
        expect(isCombatOnlyItem(null)).toBe(false);
    });

    test('swapping combat armour out records it as kept, so nothing credits its resale', () => {
        const [candidate] = bestGearForSkill({
            skill: '/skills/milking',
            equipment: { '/equipment_types/body': { hrid: '/items/maelstrom_plate_body', enhancementLevel: 8 } },
            itemDetailMap: { ...ITEMS, '/items/maelstrom_plate_body': COMBAT_PLATE },
            levels: LEVELS,
        }).filter((c) => c.slot === '/equipment_types/body');

        expect(candidate.keptItems).toEqual([{ hrid: '/items/maelstrom_plate_body', enhancementLevel: 8 }]);
        // The empty list is the claim: "this swap removes nothing that is sold"
        expect(candidate.removedItems).toEqual([]);
    });

    test('a skilling piece replacing another skilling piece is still a straight trade', () => {
        const [candidate] = bestGearForSkill({
            skill: '/skills/milking',
            equipment: { '/equipment_types/milking_tool': { hrid: '/items/basic_brush', enhancementLevel: 3 } },
            itemDetailMap: ITEMS,
            levels: LEVELS,
        }).filter((c) => c.slot === '/equipment_types/milking_tool');

        expect(candidate.keptItems).toBeUndefined();
        expect(candidate.removedItems).toBeUndefined();
        expect(candidate.currentHrid).toBe('/items/basic_brush');
    });
});
