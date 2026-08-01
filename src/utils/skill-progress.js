/**
 * Skill Progress
 *
 * How long until the next level, from a rate you are actually achieving.
 *
 * The arithmetic is small but every part of it has a wrong answer that looks
 * right. Cumulative experience against per-level experience, a rate measured
 * over a window short enough to be noise, a skill at the cap that should say
 * nothing rather than "never" — each produces a plausible number. So it lives
 * here, apart from the DOM, with tests.
 */

/** Below this a rate is one action's worth of luck rather than a measurement */
const MIN_WINDOW_SECONDS = 20;

/**
 * Experience per hour, from two readings of the same skill.
 *
 * Returns null rather than zero when there is nothing to measure. Zero is a
 * claim — that you are gaining no experience — and a window of two seconds
 * cannot support it.
 *
 * @param {{t: number, xp: number}} first - Earlier reading, `t` in ms
 * @param {{t: number, xp: number}} last - Later reading
 * @returns {number|null} Experience per hour, or null when unmeasurable
 */
export function experiencePerHour(first, last) {
    if (!first || !last) return null;

    const seconds = (last.t - first.t) / 1000;
    if (!(seconds >= MIN_WINDOW_SECONDS)) return null;

    const gained = last.xp - first.xp;
    // Experience going backwards is not a rate; it is a reset, a character
    // switch, or a reading from before a wipe
    if (!(gained > 0)) return null;

    return (gained / seconds) * 3600;
}

/**
 * Experience still owed for the next level.
 *
 * @param {number} experience - Cumulative experience in the skill
 * @param {number} level - Current level
 * @param {number[]} levelExperienceTable - Cumulative experience per level, indexed by level
 * @returns {number|null} Experience remaining, or null at the cap or without a table
 */
export function experienceToNextLevel(experience, level, levelExperienceTable) {
    const next = levelExperienceTable?.[level + 1];
    // Undefined means the table has run out, which is the level cap — not zero
    // experience remaining, which would read as "about to level"
    if (next === undefined || !Number.isFinite(experience)) return null;

    return Math.max(0, next - experience);
}

/**
 * How long the next level will take at the rate being achieved.
 *
 * @param {Object} input - What it needs
 * @param {number} input.experience - Cumulative experience
 * @param {number} input.level - Current level
 * @param {number[]} input.levelExperienceTable - The game's table
 * @param {number|null} input.xpPerHour - Measured rate
 * @returns {number|null} Seconds, or null when unknowable
 */
export function timeToNextLevel({ experience, level, levelExperienceTable, xpPerHour }) {
    if (!(xpPerHour > 0)) return null;

    const remaining = experienceToNextLevel(experience, level, levelExperienceTable);
    if (remaining === null) return null;

    return (remaining / xpPerHour) * 3600;
}

/**
 * Entries in `characterSkills` that are not skills you train.
 *
 * The game keeps the total level in the same list, and it gains experience
 * faster than anything else by definition — it is the sum of them all. Left in,
 * it always wins the "which is being trained" question and always reports no
 * next level, since there is no row for it in the experience table.
 */
const NOT_A_SKILL = new Set(['/skills/total_level']);

/**
 * Which skill is being trained, judged by which is gaining fastest.
 *
 * By rate rather than by the current action, because an action trains several
 * skills at once and the one you care about is the one moving. Ties go to
 * whichever is found first, which is stable for a stable input order.
 *
 * @param {Object<string, number>} ratesByHrid - Skill hrid → experience per hour
 * @returns {string|null} The skill hrid, or null when nothing is moving
 */
export function fastestGaining(ratesByHrid) {
    let best = null;
    let bestRate = 0;

    for (const [hrid, rate] of Object.entries(ratesByHrid || {})) {
        if (NOT_A_SKILL.has(hrid)) continue;
        if (rate > bestRate) {
            best = hrid;
            bestRate = rate;
        }
    }
    return best;
}

/**
 * A skill hrid as its name.
 * @param {string} skillHrid - e.g. `/skills/melee`
 * @returns {string} e.g. `Melee`
 */
export function skillName(skillHrid) {
    const last =
        String(skillHrid || '')
            .split('/')
            .pop() || '';
    return last.replace(/_/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}
