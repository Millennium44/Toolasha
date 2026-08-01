import { describe, test, expect } from 'vitest';
import {
    bestOffense,
    combatLevel,
    combatValueOf,
    levelsToNextCombat,
    cheapestRouteToNextCombat,
    experienceBetween,
    timeToTargetLevel,
} from './combat-level.js';

/** The build from GWhiz's own panel, whose figures this is checked against */
const build = { stamina: 110, intelligence: 100, attack: 129, defense: 120, melee: 134, ranged: 107, magic: 106 };

describe('bestOffense', () => {
    test('is the highest of the three', () => {
        expect(bestOffense(build)).toEqual({ skill: 'melee', level: 134 });
    });

    test('a tie resolves the same way every time', () => {
        // Otherwise the doubled skill wanders between two equal ones as
        // unrelated levels change, and the combat level appears to flicker
        const tied = { melee: 100, ranged: 100, magic: 100 };
        expect(bestOffense(tied).skill).toBe(bestOffense(tied).skill);
        expect(bestOffense(tied).skill).toBe('melee');
    });

    test('survives a character with nothing set', () => {
        expect(bestOffense({}).level).toBe(0);
    });
});

describe('combatLevel', () => {
    test('matches the figure GWhiz shows for the same build', () => {
        // 0.1 x (110 + 100 + 129 + 120 + 134) + 0.5 x 134 = 126.300
        const result = combatLevel(build);
        expect(result.exact).toBeCloseTo(126.3, 6);
        expect(result.level).toBe(126);
    });

    test('the fraction is the progress bar the game does not draw', () => {
        expect(combatLevel(build).progress).toBeCloseTo(0.3, 6);
    });

    test('counts the best offensive skill twice and the others once', () => {
        expect(combatLevel(build).terms).toEqual([110, 100, 129, 120, 134]);
        expect(combatLevel(build).best).toBe('melee');
    });

    test('a lower offensive skill does not displace the best', () => {
        const magicHeavy = { ...build, magic: 200 };
        expect(combatLevel(magicHeavy).best).toBe('magic');
    });
});

describe('combatValueOf', () => {
    test('the doubled skill is worth six of anything else', () => {
        expect(combatValueOf(build, 'melee')).toBeCloseTo(0.6, 6);
        expect(combatValueOf(build, 'defense')).toBeCloseTo(0.1, 6);
    });

    test('an offensive skill behind the best is worth nothing yet', () => {
        // Levelling Magic under a higher Melee moves the combat level not at all
        // until it overtakes, and calling that 0.1 would be a lie
        expect(combatValueOf(build, 'magic')).toBe(0);
        expect(combatValueOf(build, 'ranged')).toBe(0);
    });

    test('something that is not a combat skill is worth nothing', () => {
        expect(combatValueOf(build, 'cheesesmithing')).toBe(0);
    });
});

describe('levelsToNextCombat', () => {
    test('matches the panel: two levels of Melee', () => {
        // 0.7 of a combat level to go, at 0.6 each
        expect(levelsToNextCombat(build, 'melee')).toBe(2);
    });

    test('the same gap costs seven levels of a single-weighted skill', () => {
        expect(levelsToNextCombat(build, 'defense')).toBe(7);
        expect(levelsToNextCombat(build, 'stamina')).toBe(7);
    });

    test('a skill that cannot move it says so rather than saying zero', () => {
        // "0" would read as "already done" for a skill that will never do it
        expect(levelsToNextCombat(build, 'magic')).toBeNull();
    });

    test('rounds up, since two thirds of a level is not a level', () => {
        const exact = { stamina: 0, intelligence: 0, attack: 0, defense: 0, melee: 10 };
        // 0.1 x 10 + 0.5 x 10 = 6.0 exactly, so a whole level is needed
        expect(levelsToNextCombat(exact, 'melee')).toBe(2);
    });
});

describe('cheapestRouteToNextCombat', () => {
    test('picks the fewest levels, which is the doubled skill', () => {
        expect(cheapestRouteToNextCombat(build)).toEqual({ skill: 'melee', levels: 2 });
    });

    test('skips the skills that cannot move it at all', () => {
        expect(['magic', 'ranged']).not.toContain(cheapestRouteToNextCombat(build).skill);
    });
});

describe('experienceBetween', () => {
    const table = [0, 0, 100, 300, 700];

    test('is the difference between two thresholds', () => {
        expect(experienceBetween(2, 4, table)).toBe(600);
    });

    test('backwards is nothing owed, not a negative debt', () => {
        expect(experienceBetween(4, 2, table)).toBe(0);
    });

    test('off the table has no answer rather than a wrong one', () => {
        expect(experienceBetween(2, 99, table)).toBeNull();
    });
});

describe('timeToTargetLevel', () => {
    const table = [0, 0, 100, 300, 700];

    test('divides what is owed by the rate', () => {
        expect(timeToTargetLevel({ experience: 100, target: 3, table, perHour: 100 })).toBe(7200);
    });

    test('already past the target is no time at all, not a negative one', () => {
        expect(timeToTargetLevel({ experience: 900, target: 4, table, perHour: 100 })).toBe(0);
    });

    test('no rate and no such level both have no answer', () => {
        expect(timeToTargetLevel({ experience: 0, target: 3, table, perHour: 0 })).toBeNull();
        expect(timeToTargetLevel({ experience: 0, target: 99, table, perHour: 100 })).toBeNull();
    });
});
