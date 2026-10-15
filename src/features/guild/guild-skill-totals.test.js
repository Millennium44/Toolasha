import { describe, test, expect } from 'vitest';
import { aggregateGuildSkills, sortSkillRows, SKILL_TOTALS_STALE_MS } from './guild-skill-totals.js';

const NOW = 1_800_000_000_000;

// The shape guild-member-skills.js stores: lowercased name -> {name, characterId, skills: {hrid: level}, at}
const capture = (name, skills, at = NOW - 1000) => ({ name, characterId: name.length, skills, at });

const details = {
    '/skills/milking': { name: 'Milking', sortIndex: 1 },
    '/skills/foraging': { name: 'Foraging', sortIndex: 2 },
    '/skills/attack': { name: 'Attack', sortIndex: 20 },
};

describe('aggregateGuildSkills', () => {
    test('totals, averages and extremes with names, in game order', () => {
        const captures = {
            ann: capture('Ann', { '/skills/foraging': 50, '/skills/milking': 90 }),
            bob: capture('Bob', { '/skills/foraging': 70, '/skills/milking': 40 }),
            cy: capture('Cy', { '/skills/foraging': 61, '/skills/attack': 10 }),
        };
        const result = aggregateGuildSkills({
            captures,
            memberNames: ['Ann', 'Bob', 'Cy'],
            skillDetails: details,
            now: NOW,
        });
        expect(result.rows.map((r) => r.skillHrid)).toEqual(['/skills/milking', '/skills/foraging', '/skills/attack']);
        const foraging = result.rows[1];
        expect(foraging).toMatchObject({ name: 'Foraging', count: 3, total: 181, stale: 0 });
        expect(foraging.average).toBeCloseTo(60.333, 2);
        expect(foraging.lowest).toEqual({ level: 50, name: 'Ann' });
        expect(foraging.highest).toEqual({ level: 70, name: 'Bob' });
        expect(result.rows[0].count).toBe(2);
        expect(result).toMatchObject({ counted: 3, rosterSize: 3, stale: 0 });
    });

    test('ignores captures of people no longer on the roster and members without a capture', () => {
        const captures = {
            ann: capture('Ann', { '/skills/milking': 10 }),
            gone: capture('Gone', { '/skills/milking': 99 }),
        };
        const result = aggregateGuildSkills({ captures, memberNames: ['Ann', 'Bob'], skillDetails: details, now: NOW });
        expect(result.counted).toBe(1);
        expect(result.rosterSize).toBe(2);
        expect(result.rows[0]).toMatchObject({ total: 10, highest: { level: 10, name: 'Ann' } });
    });

    test('stale captures are still counted but flagged', () => {
        const old = NOW - SKILL_TOTALS_STALE_MS - 1;
        const captures = {
            ann: capture('Ann', { '/skills/milking': 10 }, old),
            bob: capture('Bob', { '/skills/milking': 30 }),
        };
        const result = aggregateGuildSkills({ captures, memberNames: ['Ann', 'Bob'], skillDetails: details, now: NOW });
        expect(result.rows[0]).toMatchObject({ count: 2, stale: 1, total: 40, average: 20 });
        expect(result.stale).toBe(1);
    });

    test('empty when nothing is captured; unknown skills fall back to the hrid and sort last', () => {
        expect(aggregateGuildSkills({ captures: {}, memberNames: ['Ann'] })).toMatchObject({ rows: [], counted: 0 });
        const result = aggregateGuildSkills({
            captures: { ann: capture('Ann', { '/skills/total_level': 700, '/skills/milking': 5 }) },
            memberNames: ['Ann'],
            skillDetails: details,
            now: NOW,
        });
        expect(result.rows.map((r) => r.name)).toEqual(['Milking', 'total level']);
    });
});

describe('sortSkillRows', () => {
    const rows = [
        { name: 'A', average: 10, total: 5, lowest: { level: 3 }, highest: { level: 9 } },
        { name: 'B', average: 30, total: 1, lowest: { level: 1 }, highest: { level: 2 } },
    ];
    test('sorts by a column in either direction and keeps game order for "order"', () => {
        expect(sortSkillRows(rows, 'average', true).map((r) => r.name)).toEqual(['B', 'A']);
        expect(sortSkillRows(rows, 'lowest', false).map((r) => r.name)).toEqual(['B', 'A']);
        expect(sortSkillRows(rows, 'order').map((r) => r.name)).toEqual(['A', 'B']);
    });
});
