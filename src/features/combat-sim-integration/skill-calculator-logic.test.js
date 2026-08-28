import { describe, test, expect } from 'vitest';
import {
    calculateLevelsAfterDays,
    calculateTimeToLevel,
    calculateCombatLevel,
    getLevelFromExp,
} from './skill-calculator-logic.js';

/** A simple level->exp table: level N needs 1000 * (N - 1) exp, up to 200 */
function buildLevelExpTable() {
    const table = {};
    for (let level = 1; level <= 201; level++) {
        table[level] = (level - 1) * 1000;
    }
    return table;
}

describe('calculateLevelsAfterDays', () => {
    const levelExpTable = buildLevelExpTable();

    test('projects from real dataManager experience as before', () => {
        const skills = [{ skillHrid: '/skills/attack', experience: 5000, level: 6 }];
        const result = calculateLevelsAfterDays(skills, { attack: 1000 }, 1, levelExpTable);
        // 5000 + 1000*24 = 29000 exp -> level 30
        expect(result.attack.level).toBe(30);
    });

    test('a level-only skill imported from the combat sim (experience stamped 0) still projects from its level, not from scratch', () => {
        // extractSimulatorSkillLevels() in combat-sim-integration.js builds
        // exactly this shape: a real level pulled from the sim's input field,
        // but `experience: 0` because the sim never tracks experience.
        const skills = [{ skillHrid: '/skills/attack', experience: 0, level: 90 }];
        const result = calculateLevelsAfterDays(skills, { attack: 0 }, 1, levelExpTable);
        // With no exp gain, a level-90 loadout must still project as level 90 —
        // not fall back to level 1 because currentExp was read as 0.
        expect(result.attack.level).toBe(90);
    });

    test('a level-only skill still gains further levels from its starting point', () => {
        const skills = [{ skillHrid: '/skills/attack', experience: 0, level: 90 }];
        // Level 90 = 89000 exp. +1000/hr * 24h = 24000 exp -> 113000 -> level 114
        const result = calculateLevelsAfterDays(skills, { attack: 1000 }, 1, levelExpTable);
        expect(result.attack.level).toBe(114);
    });

    test('a genuinely fresh level-1 skill with no experience field still starts at level 1', () => {
        const skills = [{ skillHrid: '/skills/attack', level: 1 }];
        const result = calculateLevelsAfterDays(skills, { attack: 0 }, 1, levelExpTable);
        expect(result.attack.level).toBe(1);
    });
});

describe('calculateTimeToLevel', () => {
    const levelExpTable = buildLevelExpTable();

    test('returns null for an unreachable target level', () => {
        expect(calculateTimeToLevel(0, 500, 100, levelExpTable)).toBeNull();
    });

    test('reports already achieved when current exp already meets the target', () => {
        const result = calculateTimeToLevel(5000, 3, 100, levelExpTable);
        expect(result.readable).toBe('Already achieved');
    });
});

describe('calculateCombatLevel', () => {
    test('untrained skills default to level 1', () => {
        expect(calculateCombatLevel({})).toBeCloseTo(0.1 * 5 + 0.5 * 1, 5);
    });
});

describe('getLevelFromExp', () => {
    const levelExpTable = buildLevelExpTable();

    test('reads the level a given experience total falls in', () => {
        expect(getLevelFromExp(29000, levelExpTable)).toBe(30);
    });
});
