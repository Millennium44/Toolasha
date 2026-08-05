import { describe, test, expect } from 'vitest';
import {
    bestOffense,
    bestDoubled,
    combatLevel,
    combatValueOf,
    levelsToNextCombat,
    cheapestRouteToNextCombat,
    levelFraction,
    fractionalLevels,
    fractionalLevelOf,
    timeToCombatLevel,
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

describe('the two maxima are over different sets', () => {
    // The detail the formula turns on: the flat sum takes the best of the three
    // offensive skills, and the doubled term takes the best of five. They agree
    // on most builds — which is why reading them as one set survives a casual
    // check — and part company the moment Attack or Defense leads.
    const attackLed = { stamina: 100, intelligence: 100, attack: 150, defense: 100, melee: 120, ranged: 0, magic: 0 };

    test('the doubled term can be Attack, which is not an offensive skill', () => {
        expect(bestOffense(attackLed).skill).toBe('melee');
        expect(bestDoubled(attackLed).skill).toBe('attack');
    });

    test('and the level follows the doubled skill, not the offensive one', () => {
        // 0.1 x (100 + 100 + 150 + 100 + 120) + 0.5 x 150 = 57 + 75 = 132
        expect(combatLevel(attackLed).exact).toBeCloseTo(132, 6);
    });

    test('reading both maxima as the offensive set would understate it', () => {
        // That reading gives 0.5 x 120 = 60, so 117 — fifteen levels adrift
        expect(combatLevel(attackLed).exact).not.toBeCloseTo(117, 6);
    });
});

describe('combatValueOf', () => {
    test('the doubled skill is worth six of anything else', () => {
        expect(combatValueOf(build, 'melee')).toBeCloseTo(0.6, 6);
        expect(combatValueOf(build, 'defense')).toBeCloseTo(0.1, 6);
    });

    test('an offensive skill behind the leader is worth nothing yet', () => {
        // Levelling Magic under a higher Melee moves nothing until it overtakes
        expect(combatValueOf(build, 'magic')).toBeCloseTo(0, 6);
        expect(combatValueOf(build, 'ranged')).toBeCloseTo(0, 6);
    });

    test('Attack still counts in the flat sum even when it is not the leader', () => {
        // It is a named term, unlike the offensive skills which only appear
        // through their maximum
        expect(combatValueOf(build, 'attack')).toBeCloseTo(0.1, 6);
    });

    test('the level that overtakes is worth more than the ones before it', () => {
        // A fixed table of per-skill weights cannot say this, which is why the
        // value is measured by adding one and re-running the formula
        const behind = { stamina: 0, intelligence: 0, attack: 0, defense: 0, melee: 100, ranged: 99, magic: 0 };
        expect(combatValueOf(behind, 'ranged')).toBeCloseTo(0, 6);

        const level = { ...behind, ranged: 100 };
        expect(combatValueOf(level, 'ranged')).toBeCloseTo(0.6, 6);
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

    test('a skill far behind reports the real number, not nothing', () => {
        // Magic at 106 has to reach 136 before the whole number moves — 135
        // leaves it at 126.9, still short — which is a true and useful answer
        // where null was merely an absence
        expect(levelsToNextCombat(build, 'magic')).toBe(30);
    });

    test('past the search limit it declines rather than guessing', () => {
        expect(levelsToNextCombat(build, 'magic', 5)).toBeNull();
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

    test('does not pick a skill that has to overtake first', () => {
        expect(['magic', 'ranged']).not.toContain(cheapestRouteToNextCombat(build).skill);
    });
});

describe('levelFraction', () => {
    const table = [0, 0, 100, 300, 700];

    test('is how far between the two thresholds the experience sits', () => {
        expect(levelFraction(200, 2, table)).toBeCloseTo(0.5, 6);
        expect(levelFraction(100, 2, table)).toBeCloseTo(0, 6);
    });

    test('at the cap there is nothing to be part of', () => {
        expect(levelFraction(700, 4, table)).toBe(0);
    });
});

describe('fractional levels change what the progress bar should say', () => {
    // The build from the panel, with Melee 81.7% of the way to 135
    const table = [];
    for (let level = 0; level <= 140; level++) table[level] = level * 1000;

    test('the whole-number formula and the fractional one disagree, and the second is right', () => {
        const whole = combatLevel(build);
        expect(whole.exact).toBeCloseTo(126.3, 6);

        // Melee's part-finished level carries the doubled term, so 0.817 of a
        // level is worth 0.817 x 0.6 = 0.49 combat levels already earned
        const partial = combatLevel({ ...build, melee: 134.817 });
        expect(partial.exact).toBeCloseTo(126.79, 2);
        expect(partial.level).toBe(126);
        expect(partial.progress).toBeCloseTo(0.79, 2);
    });

    test('fractionalLevels puts the game’s experience into those levels', () => {
        // Level 3 spans 3000 to 4000, so 3500 is halfway
        const skills = [{ name: 'melee', level: 3, experience: 3500 }];
        expect(fractionalLevels(skills, table)).toEqual({ melee: 3.5 });
    });
});

describe('fractionalLevelOf', () => {
    const table = [0, 0, 100, 300, 700];

    test('is the level plus how far into it the experience sits', () => {
        expect(fractionalLevelOf(200, table)).toBeCloseTo(2.5, 6);
        expect(fractionalLevelOf(100, table)).toBeCloseTo(2, 6);
    });

    test('a new character is level 1, not level 0', () => {
        expect(fractionalLevelOf(0, table)).toBe(1);
    });

    test('at or past the cap it is the cap, since there is no next threshold', () => {
        expect(fractionalLevelOf(700, table)).toBe(4);
        expect(fractionalLevelOf(99999, table)).toBe(4);
    });

    test('without a table there is no answer to give', () => {
        expect(fractionalLevelOf(100, null)).toBeNull();
    });

    test('it inverts the table it was built from, at every level', () => {
        // The binary search is the part that can be subtly wrong, and wrong in
        // a way that looks right for the levels anybody checks by hand
        const big = [0, 0];
        for (let level = 2; level <= 150; level++) big[level] = big[level - 1] + level * 1000;

        for (let level = 1; level < 150; level++) {
            expect(fractionalLevelOf(big[level], big)).toBeCloseTo(level, 6);
            const half = (big[level] + big[level + 1]) / 2;
            expect(fractionalLevelOf(half, big)).toBeCloseTo(level + 0.5, 6);
        }
    });
});

describe('timeToCombatLevel', () => {
    const table = [0, 0];
    for (let level = 2; level <= 200; level++) table[level] = table[level - 1] + level * 1000;

    const skills = (levels) => Object.entries(levels).map(([name, level]) => ({ name, experience: table[level] }));

    test('already there is no time at all', () => {
        expect(timeToCombatLevel({ skills: skills(build), table, rates: { melee: 100 }, target: 100 })).toBe(0);
    });

    test('nothing moving has no answer rather than infinity', () => {
        expect(timeToCombatLevel({ skills: skills(build), table, rates: {}, target: 127 })).toBeNull();
    });

    test('the time it lands is the time the formula crosses the target', () => {
        const rates = { melee: 1000000, attack: 400000 };
        const seconds = timeToCombatLevel({ skills: skills(build), table, rates, target: 127 });

        // Checked by replaying it: a moment before, still short; at it, there
        const at = (elapsed) => {
            const levels = {};
            for (const skill of skills(build)) {
                levels[skill.name] = fractionalLevelOf(
                    skill.experience + (rates[skill.name] || 0) * (elapsed / 3600),
                    table
                );
            }
            return combatLevel(levels).exact;
        };
        expect(at(seconds)).toBeCloseTo(127, 3);
        expect(at(seconds - 60)).toBeLessThan(127);
    });

    test('two skills moving get there sooner than one of them alone', () => {
        const both = timeToCombatLevel({
            skills: skills(build),
            table,
            rates: { melee: 1000000, attack: 400000 },
            target: 127,
        });
        const one = timeToCombatLevel({ skills: skills(build), table, rates: { melee: 1000000 }, target: 127 });

        // Attack is worth 0.1 a level against Melee's 0.6, so it helps a little
        expect(both).toBeLessThan(one);
    });

    test('a target nothing can reach declines rather than guessing', () => {
        // Everything caps out at 200, so combat cannot pass 0.1 x 1000 + 0.5 x 200
        expect(timeToCombatLevel({ skills: skills(build), table, rates: { melee: 1e9 }, target: 250 })).toBeNull();
    });

    test('a skill that overtakes another is priced correctly through the crossover', () => {
        // Magic starts behind Melee and passes it, so what a level of it is
        // worth changes partway through — the reason this is searched rather
        // than divided
        const behind = {
            stamina: 100,
            intelligence: 100,
            attack: 100,
            defense: 100,
            melee: 120,
            ranged: 1,
            magic: 110,
        };
        const seconds = timeToCombatLevel({
            skills: skills(behind),
            table,
            rates: { magic: 5000000 },
            target: 121,
        });
        expect(seconds).toBeGreaterThan(0);
        expect(Number.isFinite(seconds)).toBe(true);
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
