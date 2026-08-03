/**
 * Offering gear you are not wearing, per skill.
 *
 * The skilling advisor could only ever enhance what was already on, which meant
 * it was silent about the two things that actually move a labyrinth skilling
 * room — a celestial tool and the skill's own outfit. Both live in the item data
 * rather than on the character, so neither was ever a candidate.
 */

import { describe, test, expect } from 'vitest';
import { relevantStats, skillScore, canEquip, bestGearForSkill, NEW_GEAR_LEVEL } from './skilling-gear-candidates.js';

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

    test('gathering quantity only where there is gathering', () => {
        expect(relevantStats('milking').has('gatheringQuantity')).toBe(true);
        expect(relevantStats('crafting').has('gatheringQuantity')).toBe(false);
    });

    test('an item with no relevant stat scores nothing', () => {
        expect(skillScore(ITEMS['/items/sword'], relevantStats('milking'))).toBe(0);
        expect(skillScore(ITEMS['/items/crafting_top'], relevantStats('milking'))).toBe(0);
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
