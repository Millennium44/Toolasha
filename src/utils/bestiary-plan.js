/**
 * The Bestiary route planner: given a time budget, which zones in which order
 * earn the most Bestiary points.
 *
 * Points land on powers of ten of each monster's kill count (see
 * `bestiary.js`), so a zone is worth the most while one of its monsters is
 * close to a threshold and worth very little the moment it crosses one — the
 * next threshold is ten times further away. A single zone held for a whole
 * day therefore wastes most of the day; a route that hops to whichever zone
 * has the nearest threshold does not.
 *
 * The planner is that hop, repeated: pick the zone whose next point arrives
 * soonest at its simulated kill rates from the current counts, fight there
 * until that point lands, advance every count the zone touches, and go again
 * until the budget is spent. Greedy, not optimal — a zone whose monsters
 * cross three thresholds within the hour loses to one that crosses a single
 * threshold a minute sooner — but it is deterministic, cheap, and far better
 * than any single zone, which it also reports for comparison.
 *
 * Pure: everything is an argument and nothing is read from the game.
 */

import { pointsFromCount, nextPointCount } from './bestiary.js';

/** A guard against a pathological input looping forever */
const MAX_STEPS = 20_000;

/**
 * The soonest point a zone reaches from the current counts.
 * @param {Object} killsPerHour - monsterHrid → kills/hour
 * @param {Object} counts - monsterHrid → current count (may be fractional mid-plan)
 * @returns {{hours: number, monsterHrid: string|null}} `hours` is Infinity when the zone earns nothing
 */
function soonestPoint(killsPerHour, counts) {
    let best = { hours: Infinity, monsterHrid: null };
    for (const [hrid, rate] of Object.entries(killsPerHour || {})) {
        const perHour = Number(rate) || 0;
        if (!(perHour > 0)) continue;
        const count = Math.max(0, Number(counts[hrid]) || 0);
        const hours = (nextPointCount(count) - count) / perHour;
        if (hours < best.hours) best = { hours, monsterHrid: hrid };
    }
    return best;
}

/**
 * Advance the counts a zone touches by `hours` of fighting there, and say
 * what that did for the Bestiary.
 *
 * `snap` is the monster whose threshold ends this step: its count is set to
 * the threshold exactly rather than computed from rate × time, so floating
 * point never leaves it at 9.999999 and charges the point twice.
 *
 * @returns {{points: number, monsters: Array}} monsters: {monsterHrid, from, count, to, reached}
 */
function advance(killsPerHour, counts, hours, snap) {
    let points = 0;
    const monsters = [];
    for (const [hrid, rate] of Object.entries(killsPerHour || {})) {
        const perHour = Number(rate) || 0;
        if (!(perHour > 0)) continue;
        const from = Math.max(0, Number(counts[hrid]) || 0);
        const nextAt = nextPointCount(from);
        let count = from + perHour * hours;
        if (hrid === snap) count = nextAt;
        counts[hrid] = count;
        const gained = pointsFromCount(count) - pointsFromCount(from);
        points += gained;
        const reached = gained > 0;
        monsters.push({
            monsterHrid: hrid,
            from: Math.floor(from),
            count,
            // The highest threshold crossed, or the one still ahead
            to: reached ? nextPointCount(count) / 10 : nextAt,
            reached,
            points: gained,
        });
    }
    // Crossings first, nearest-next-threshold after, so a cell that shows the
    // first few names shows the ones that mattered
    monsters.sort((a, b) => {
        if (a.reached !== b.reached) return a.reached ? -1 : 1;
        if (a.reached) return b.points - a.points;
        return a.to - a.count - (b.to - b.count);
    });
    return { points, monsters };
}

/**
 * The points one zone earns held for the whole budget.
 * @returns {number}
 */
function singleZonePoints(killsPerHour, counts, hours) {
    let points = 0;
    for (const [hrid, rate] of Object.entries(killsPerHour || {})) {
        const perHour = Number(rate) || 0;
        if (!(perHour > 0)) continue;
        const count = Math.max(0, Number(counts[hrid]) || 0);
        points += pointsFromCount(count + perHour * hours) - pointsFromCount(count);
    }
    return points;
}

/**
 * Plan a Bestiary route through `zones` for `hours`.
 *
 * @param {Object} input
 * @param {Array<{zoneHrid: string, name?: string, killsPerHour: Object, encountersPerHour?: number}>} input.zones -
 *   Candidate zones with their simulated kills per hour by monster (and, when known, fights per hour, so a
 *   stay can be quoted in fights as well as time); earlier zones win ties
 * @param {Object} input.counts - monsterHrid → kills so far (the Bestiary)
 * @param {number} input.hours - The time budget
 * @returns {{
 *   hours: number,
 *   hoursUsed: number,
 *   totalPoints: number,
 *   pointsByZone: Object,
 *   segments: Array<{zoneHrid: string, name: string, hours: number, encounters: number|null, points: number,
 *     partial: boolean,
 *     monsters: Array<{monsterHrid: string, from: number, count: number, to: number, reached: boolean, points: number}>}>,
 *   bestSingle: {zoneHrid: string, name: string, points: number, encounters: number|null}|null,
 *   counts: Object,
 * }}
 */
export function planBestiaryRoute({ zones = [], counts = {}, hours = 24 } = {}) {
    const budget = Number(hours) > 0 ? Number(hours) : 0;
    const usable = (zones || []).filter(
        (zone) =>
            zone &&
            zone.zoneHrid &&
            zone.killsPerHour &&
            Object.values(zone.killsPerHour).some((rate) => Number(rate) > 0)
    );
    const state = {};
    for (const [hrid, count] of Object.entries(counts || {})) {
        state[hrid] = Math.max(0, Math.floor(Number(count) || 0));
    }

    const segments = [];
    const pointsByZone = {};
    let remaining = budget;
    let totalPoints = 0;

    // Fights for a stay, when the zone's fight rate is known — null otherwise,
    // so a table can say "—" rather than 0
    const fightsFor = (zone, hoursSpent) =>
        Number(zone.encountersPerHour) > 0 ? Number(zone.encountersPerHour) * hoursSpent : null;

    const record = (zone, hoursSpent, result, partial) => {
        const last = segments[segments.length - 1];
        if (last && last.zoneHrid === zone.zoneHrid && !last.partial) {
            last.hours += hoursSpent;
            const more = fightsFor(zone, hoursSpent);
            last.encounters = more === null ? last.encounters : (last.encounters || 0) + more;
            last.points += result.points;
            last.partial = partial;
            // A monster already listed keeps its original starting count
            const seen = new Map(last.monsters.map((m) => [m.monsterHrid, m]));
            for (const m of result.monsters) {
                const prev = seen.get(m.monsterHrid);
                if (prev) {
                    prev.count = m.count;
                    prev.to = m.reached || !prev.reached ? m.to : prev.to;
                    prev.reached = prev.reached || m.reached;
                    prev.points += m.points;
                } else {
                    last.monsters.push({ ...m });
                }
            }
            last.monsters.sort((a, b) => {
                if (a.reached !== b.reached) return a.reached ? -1 : 1;
                if (a.reached) return b.points - a.points;
                return a.to - a.count - (b.to - b.count);
            });
        } else {
            segments.push({
                zoneHrid: zone.zoneHrid,
                name: zone.name || zone.zoneHrid,
                hours: hoursSpent,
                encounters: fightsFor(zone, hoursSpent),
                points: result.points,
                partial,
                monsters: result.monsters.map((m) => ({ ...m })),
            });
        }
        pointsByZone[zone.zoneHrid] = (pointsByZone[zone.zoneHrid] || 0) + result.points;
        totalPoints += result.points;
    };

    for (let step = 0; step < MAX_STEPS && remaining > 1e-9 && usable.length; step += 1) {
        let pick = null;
        let pickNext = { hours: Infinity, monsterHrid: null };
        for (const zone of usable) {
            const next = soonestPoint(zone.killsPerHour, state);
            if (next.hours < pickNext.hours) {
                pick = zone;
                pickNext = next;
            }
        }
        if (!pick || !Number.isFinite(pickNext.hours)) break;

        if (pickNext.hours <= remaining) {
            const result = advance(pick.killsPerHour, state, pickNext.hours, pickNext.monsterHrid);
            record(pick, pickNext.hours, result, false);
            remaining -= pickNext.hours;
        } else {
            // The budget runs out before the next point: fight here for what
            // is left and show how far each monster got
            const result = advance(pick.killsPerHour, state, remaining, null);
            record(pick, remaining, result, true);
            remaining = 0;
        }
    }

    let bestSingle = null;
    for (const zone of usable) {
        const points = singleZonePoints(zone.killsPerHour, counts, budget);
        if (!bestSingle || points > bestSingle.points) {
            bestSingle = {
                zoneHrid: zone.zoneHrid,
                name: zone.name || zone.zoneHrid,
                points,
                encounters: fightsFor(zone, budget),
            };
        }
    }

    return {
        hours: budget,
        hoursUsed: budget - remaining,
        totalPoints,
        pointsByZone,
        segments,
        bestSingle,
        counts: state,
    };
}

/**
 * Hours as `h:mm`, for a plan row.
 * @param {number} hours
 * @returns {string}
 */
export function formatPlanHours(hours) {
    const totalMinutes = Math.max(0, Math.round((Number(hours) || 0) * 60));
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${h}:${String(m).padStart(2, '0')}`;
}

/**
 * A plan as plain text, for the clipboard.
 * @param {ReturnType<typeof planBestiaryRoute>} plan
 * @param {Object} [options]
 * @param {Function} [options.monsterName] - monsterHrid → display name
 * @returns {string}
 */
export function formatPlanText(plan, { monsterName = (hrid) => hrid } = {}) {
    if (!plan) return '';
    const lines = [`Bestiary plan — ${formatPlanHours(plan.hours)} h, ${plan.totalPoints} points`];
    plan.segments.forEach((segment, index) => {
        const crossings = segment.monsters
            .filter((m) => m.reached)
            .map((m) => `${monsterName(m.monsterHrid)} ${m.from}→${m.to}`)
            .join(', ');
        const partial = segment.partial
            ? segment.monsters
                  .filter((m) => !m.reached)
                  .slice(0, 3)
                  .map((m) => `${monsterName(m.monsterHrid)} ${Math.floor(m.count)}/${m.to}`)
                  .join(', ')
            : '';
        const detail = [crossings, partial ? `(partial: ${partial})` : ''].filter(Boolean).join(' ');
        const fights =
            segment.encounters === null || segment.encounters === undefined
                ? ''
                : ` (≈${Math.round(segment.encounters)} fights)`;
        lines.push(
            `${index + 1}. ${segment.name} — ${formatPlanHours(segment.hours)}${fights} — +${segment.points}` +
                (detail ? ` — ${detail}` : '')
        );
    });
    if (plan.bestSingle) {
        lines.push(`Best single zone: ${plan.bestSingle.name} — ${plan.bestSingle.points} points`);
    }
    return lines.join('\n');
}
