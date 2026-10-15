/**
 * Guild-wide skill levels, from the profiles already logged.
 *
 * The guild roster message carries no per-skill levels; they come only from each
 * member's profile, which `guild-member-skills.js` collects one click at a time.
 * This module only *reads* those captures and folds them into one row per skill,
 * so a guild can see where it is short. It never writes to the captures.
 *
 * Only members currently on the roster count (a capture of someone who left is
 * ignored), a stale capture still counts but is flagged, and the caller is told
 * how many members were counted so a half-logged roster is not read as the
 * whole guild.
 */

/**
 * A capture older than this is flagged as stale. Mirrors `STALE_AFTER_MS` in
 * `guild-member-skills.js`; kept local so this pure module imports nothing.
 */
export const SKILL_TOTALS_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/** Columns the table can be sorted by */
export const SKILL_TOTALS_SORT_KEYS = ['order', 'count', 'total', 'average', 'lowest', 'highest'];

/**
 * Fold the logged captures into one row per skill.
 *
 * @param {Object} input - Everything this needs, so it can be tested without the game
 * @param {Object<string, {name?: string, skills: Object<string, number>, at?: number}>} input.captures -
 *   lowercased member name to capture, as `guild-member-skills.js` stores them
 * @param {string[]} input.memberNames - The current roster's names
 * @param {Object<string, {name?: string, sortIndex?: number}>} [input.skillDetails] - The game's skillDetailMap
 * @param {number} [input.now] - Clock
 * @param {number} [input.staleAfterMs] - Age past which a capture is flagged
 * @returns {{rows: Array<Object>, counted: number, stale: number, rosterSize: number}}
 *   `rows` are in the game's skill order; each has `skillHrid`, `name`, `sortIndex`, `count`, `stale`, `total`,
 *   `average`, `lowest` and `highest` (`{level, name}` each)
 */
export function aggregateGuildSkills({
    captures,
    memberNames,
    skillDetails = {},
    now = Date.now(),
    staleAfterMs = SKILL_TOTALS_STALE_MS,
}) {
    const roster = [...new Set((memberNames || []).map((name) => String(name || '').toLowerCase()).filter(Boolean))];
    const bySkill = new Map();
    let counted = 0;
    let staleMembers = 0;

    for (const key of roster) {
        const capture = captures?.[key];
        if (!capture || typeof capture.skills !== 'object' || !capture.skills) continue;
        counted += 1;
        const isStale = now - (Number(capture.at) || 0) > staleAfterMs;
        if (isStale) staleMembers += 1;

        for (const [skillHrid, rawLevel] of Object.entries(capture.skills)) {
            const level = Number(rawLevel);
            if (!Number.isFinite(level)) continue;
            let entry = bySkill.get(skillHrid);
            if (!entry) {
                entry = { skillHrid, count: 0, stale: 0, total: 0, lowest: null, highest: null };
                bySkill.set(skillHrid, entry);
            }
            const who = capture.name || key;
            entry.count += 1;
            if (isStale) entry.stale += 1;
            entry.total += level;
            if (!entry.lowest || level < entry.lowest.level) entry.lowest = { level, name: who };
            if (!entry.highest || level > entry.highest.level) entry.highest = { level, name: who };
        }
    }

    const rows = [...bySkill.values()].map((entry) => {
        const details = skillDetails?.[entry.skillHrid];
        return {
            ...entry,
            name: details?.name || entry.skillHrid.split('/').pop().replace(/_/g, ' '),
            sortIndex: Number.isFinite(details?.sortIndex) ? details.sortIndex : 999,
            average: entry.total / entry.count,
        };
    });
    rows.sort((a, b) => a.sortIndex - b.sortIndex || a.name.localeCompare(b.name));

    return { rows, counted, stale: staleMembers, rosterSize: roster.length };
}

/**
 * Rows re-ordered by a column.
 *
 * @param {Array<Object>} rows - From {@link aggregateGuildSkills}, in game order
 * @param {string} sortKey - One of {@link SKILL_TOTALS_SORT_KEYS}; `order` keeps game order
 * @param {boolean} [descending] - Largest first
 * @returns {Array<Object>} A new array
 */
export function sortSkillRows(rows, sortKey, descending = false) {
    const value = (row) => (sortKey === 'lowest' || sortKey === 'highest' ? row[sortKey]?.level : row[sortKey]);
    const copy = [...(rows || [])];
    if (!SKILL_TOTALS_SORT_KEYS.includes(sortKey) || sortKey === 'order') return copy;
    const sign = descending ? -1 : 1;
    // Array.sort is stable, so ties keep game order
    return copy.sort((a, b) => sign * ((Number(value(a)) || 0) - (Number(value(b)) || 0)));
}
