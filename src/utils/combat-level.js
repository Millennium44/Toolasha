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
 * `0.1 × (stamina + intelligence + attack + defense + best) + 0.5 × best`
 *
 * where `best` is the highest of Melee, Ranged and Magic. So the offensive skill
 * you are actually using counts **twice** — once in the sum and once on its own —
 * which is why it is worth 0.6 a level against everything else's 0.1.
 *
 * The displayed level is the floor of that, and the fraction it discards is
 * exactly the progress bar the game does not draw.
 *
 * The model is GWhiz's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

/** Every skill that counts, and what one level of it is worth on its own */
export const COMBAT_SKILLS = ['stamina', 'intelligence', 'attack', 'defense', 'melee', 'ranged', 'magic'];

/** The three that compete for the doubled slot */
export const OFFENSE_SKILLS = ['melee', 'ranged', 'magic'];

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
 * Which offensive skill carries the doubled weight.
 *
 * The highest, and on a tie the first in a fixed order so the answer does not
 * wander between two equal skills as unrelated levels change.
 *
 * @param {Object} levels - Skill name → level
 * @returns {{skill: string, level: number}}
 */
export function bestOffense(levels) {
    let skill = OFFENSE_SKILLS[0];
    let level = levelOf(levels, skill);

    for (const candidate of OFFENSE_SKILLS.slice(1)) {
        const value = levelOf(levels, candidate);
        if (value > level) {
            skill = candidate;
            level = value;
        }
    }
    return { skill, level };
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
    const best = bestOffense(levels);
    const terms = [
        levelOf(levels, 'stamina'),
        levelOf(levels, 'intelligence'),
        levelOf(levels, 'attack'),
        levelOf(levels, 'defense'),
        best.level,
    ];

    const exact = FLAT_WEIGHT * terms.reduce((sum, value) => sum + value, 0) + BEST_WEIGHT * best.level;
    return {
        level: Math.floor(exact),
        exact,
        best: best.skill,
        terms,
        progress: exact - Math.floor(exact),
    };
}

/**
 * What one level of a skill is worth towards combat level.
 *
 * The doubled skill is worth six times any other, which is the whole reason this
 * question has a different answer per skill rather than one answer.
 *
 * @param {Object} levels - Skill name → level
 * @param {string} skill - Which skill
 * @returns {number} Combat levels gained per level of it
 */
export function combatValueOf(levels, skill) {
    if (!COMBAT_SKILLS.includes(skill)) return 0;

    const best = bestOffense(levels);
    if (skill === best.skill) return FLAT_WEIGHT + BEST_WEIGHT;

    // An offensive skill below the best contributes nothing at all until it
    // overtakes it — levelling Magic behind a higher Melee moves nothing
    if (OFFENSE_SKILLS.includes(skill)) return 0;

    return FLAT_WEIGHT;
}

/**
 * How many levels of one skill would raise your combat level.
 *
 * Rounded up, because the question is "how many do I need" and two-thirds of a
 * level is not a level. Returns null for a skill that cannot move it — an
 * offensive skill sitting behind a higher one moves nothing until it passes it,
 * and saying "0" there would read as "already done".
 *
 * @param {Object} levels - Skill name → level
 * @param {string} skill - Which skill to raise
 * @returns {number|null} Levels needed, or null when this skill cannot do it
 */
export function levelsToNextCombat(levels, skill) {
    const value = combatValueOf(levels, skill);
    if (!(value > 0)) return null;

    const { exact } = combatLevel(levels);
    const needed = Math.floor(exact) + 1 - exact;
    return Math.ceil(needed / value);
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
