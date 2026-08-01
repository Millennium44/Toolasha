/**
 * Combat level
 *
 * What your combat level actually is, and what it would take to move it.
 *
 * The game shows a whole number and nothing else, which hides the two facts
 * worth knowing: how close the next one is, and which skill would get you there
 * soonest. Combat level is a weighted average, so those two questions have
 * different answers for every skill — a level of Melee is worth six times a
 * level of Defense, and no amount of Defense may be the fastest route anyway.
 *
 * ## The formula
 *
 * ```
 * 0.1 × (stamina + intelligence + attack + defense + MAX(melee, ranged, magic))
 *   + 0.5 × MAX(attack, defense, melee, ranged, magic)
 * ```
 *
 * The two maxima are over **different sets**, which is the detail worth getting
 * right: the first counts only the three offensive skills, and the second
 * includes Attack and Defense as well. They agree whenever an offensive skill
 * leads overall — which is most builds, and is exactly why taking them to be the
 * same set survives casual checking — and disagree the moment Attack or Defense
 * is your highest, where the doubled term is Attack's rather than Melee's.
 *
 * So a skill can count twice, once, or not at all, and which of those it is
 * depends on the rest of the build. Rather than encode that as a table of cases,
 * what a level is worth is measured by adding one and re-running the formula.
 *
 * The displayed level is the floor, and the fraction it discards is exactly the
 * progress bar the game does not draw.
 *
 * The model is GWhiz's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

/** Every skill that counts, and what one level of it is worth on its own */
export const COMBAT_SKILLS = ['stamina', 'intelligence', 'attack', 'defense', 'melee', 'ranged', 'magic'];

/** The three that compete for the slot inside the flat sum */
export const OFFENSE_SKILLS = ['melee', 'ranged', 'magic'];

/** The five that compete for the doubled term — Attack and Defense are in it too */
export const DOUBLED_SKILLS = ['attack', 'defense', 'melee', 'ranged', 'magic'];

/** Weight on the flat sum, and the extra weight the best offensive skill carries */
const FLAT_WEIGHT = 0.1;
const BEST_WEIGHT = 0.5;

/**
 * A skill's level, defaulting to zero rather than to NaN.
 * @param {Object} levels - Skill name → level
 * @param {string} skill - Which one
 * @returns {number}
 */
function levelOf(levels, skill) {
    const value = Number(levels?.[skill]);
    return Number.isFinite(value) ? value : 0;
}

/**
 * The highest of a set of skills.
 *
 * Ties resolve to the first in the given order, so the answer does not wander
 * between two equal skills as unrelated levels change — which would make the
 * combat level appear to flicker without anything having happened.
 *
 * @param {Object} levels - Skill name → level
 * @param {string[]} among - Which skills to consider
 * @returns {{skill: string, level: number}}
 */
export function highestOf(levels, among) {
    let skill = among[0];
    let level = levelOf(levels, skill);

    for (const candidate of among.slice(1)) {
        const value = levelOf(levels, candidate);
        if (value > level) {
            skill = candidate;
            level = value;
        }
    }
    return { skill, level };
}

/**
 * The offensive skill inside the flat sum.
 * @param {Object} levels - Skill name → level
 * @returns {{skill: string, level: number}}
 */
export function bestOffense(levels) {
    return highestOf(levels, OFFENSE_SKILLS);
}

/**
 * The skill carrying the doubled term, which may be Attack or Defense.
 * @param {Object} levels - Skill name → level
 * @returns {{skill: string, level: number}}
 */
export function bestDoubled(levels) {
    return highestOf(levels, DOUBLED_SKILLS);
}

/**
 * Your combat level, and the arithmetic behind it.
 *
 * @param {Object} levels - Skill name → level
 * @returns {{level: number, exact: number, best: string, progress: number, terms: number[]}}
 *   `level` is what the game shows, `exact` the unrounded figure, and `progress`
 *   the fraction of the way to the next whole level — the bar the game omits.
 */
export function combatLevel(levels) {
    const offense = bestOffense(levels);
    const doubled = bestDoubled(levels);

    const terms = [
        levelOf(levels, 'stamina'),
        levelOf(levels, 'intelligence'),
        levelOf(levels, 'attack'),
        levelOf(levels, 'defense'),
        offense.level,
    ];

    const exact = FLAT_WEIGHT * terms.reduce((sum, value) => sum + value, 0) + BEST_WEIGHT * doubled.level;
    return {
        level: Math.floor(exact),
        exact,
        best: offense.skill,
        doubled: doubled.skill,
        doubledLevel: doubled.level,
        terms,
        progress: exact - Math.floor(exact),
    };
}

/**
 * What one more level of a skill is worth towards combat level.
 *
 * Measured rather than looked up: add one and re-run the formula. A skill can
 * count twice, once, or not at all depending on the rest of the build, and this
 * gets the awkward cases right for free — a skill one level below the leader is
 * worth 0.1 for that level and 0.6 for the next, which no fixed table says.
 *
 * @param {Object} levels - Skill name → level
 * @param {string} skill - Which skill
 * @returns {number} Combat levels gained by one level of it
 */
export function combatValueOf(levels, skill) {
    if (!COMBAT_SKILLS.includes(skill)) return 0;

    const before = combatLevel(levels).exact;
    const after = combatLevel({ ...levels, [skill]: levelOf(levels, skill) + 1 }).exact;
    return after - before;
}

/**
 * How many levels of one skill would raise your combat level.
 *
 * Counted by adding levels until the whole number moves, rather than by
 * dividing — because the value of each level is not constant. A skill below the
 * leader contributes little until it overtakes and then contributes a lot, and
 * dividing by today's rate would report a number that is wrong in both
 * directions at once.
 *
 * @param {Object} levels - Skill name → level
 * @param {string} skill - Which skill to raise
 * @param {number} [limit] - Give up past this many levels
 * @returns {number|null} Levels needed, or null when it would take more than the limit
 */
export function levelsToNextCombat(levels, skill, limit = 200) {
    if (!COMBAT_SKILLS.includes(skill)) return null;

    const target = Math.floor(combatLevel(levels).exact) + 1;
    const start = levelOf(levels, skill);

    for (let added = 1; added <= limit; added++) {
        if (combatLevel({ ...levels, [skill]: start + added }).exact >= target) return added;
    }
    return null;
}

/**
 * The skill that reaches the next combat level in the fewest levels.
 *
 * Fewest *levels*, not fastest — how long a level takes is a question about
 * experience rates, which this module deliberately knows nothing about.
 *
 * @param {Object} levels - Skill name → level
 * @returns {{skill: string, levels: number}|null}
 */
export function cheapestRouteToNextCombat(levels) {
    let best = null;
    for (const skill of COMBAT_SKILLS) {
        const needed = levelsToNextCombat(levels, skill);
        if (needed === null) continue;
        if (!best || needed < best.levels) best = { skill, levels: needed };
    }
    return best;
}

/**
 * Experience between two levels.
 *
 * @param {number} from - Starting level
 * @param {number} to - Target level
 * @param {number[]} table - The game's cumulative `levelExperienceTable`
 * @returns {number|null} Experience needed, or null when either level is off the table
 */
export function experienceBetween(from, to, table) {
    const start = table?.[from];
    const end = table?.[to];
    if (start === undefined || end === undefined) return null;

    return Math.max(0, end - start);
}

/**
 * How long a target level is away at a given rate.
 *
 * @param {Object} input - What it needs
 * @param {number} input.experience - Cumulative experience now
 * @param {number} input.target - Target level
 * @param {number[]} input.table - The game's cumulative experience table
 * @param {number} input.perHour - Experience per hour
 * @returns {number|null} Seconds, or null when unknowable
 */
export function timeToTargetLevel({ experience, target, table, perHour }) {
    const goal = table?.[target];
    if (goal === undefined || !(perHour > 0)) return null;

    const remaining = goal - (Number(experience) || 0);
    // Already there is zero, not a negative countdown
    if (remaining <= 0) return 0;

    return (remaining / perHour) * 3600;
}
