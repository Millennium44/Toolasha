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
 * The same hop answers the question the other way round: given a points
 * target and no clock, run until the target is crossed and report how long it
 * took and where the time went.
 *
 * Pure: everything is an argument and nothing is read from the game.
 */

import { pointsFromCount, nextPointCount } from './bestiary.js';

/** A guard against a pathological input looping forever */
const MAX_STEPS = 20_000;

/**
 * The hours a points-target plan is allowed to reach before it gives up.
 *
 * Points never stop being earnable — the next power of ten is always finite —
 * so "unreachable" is a statement about patience, not about mathematics. A
 * century of fighting is not an answer anybody wanted.
 */
const MAX_PLAN_HOURS = 1e6;

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
 * How long one zone, held alone, takes to earn `target` points.
 *
 * The same crossing-by-crossing walk the route does, with the zone choice
 * removed: advance to whichever of the zone's own monsters reaches its next
 * threshold soonest, bank what that crossing is worth, repeat.
 *
 * @param {Object} killsPerHour - monsterHrid → kills/hour
 * @param {Object} counts - monsterHrid → current count
 * @param {number} target - Points wanted
 * @returns {number|null} Hours, or null when the zone never gets there inside the safety cap
 */
function singleZoneHoursToTarget(killsPerHour, counts, target) {
    if (!(target > 0)) return 0;
    const state = [];
    for (const [hrid, rate] of Object.entries(killsPerHour || {})) {
        const perHour = Number(rate) || 0;
        if (!(perHour > 0)) continue;
        state.push({ perHour, count: Math.max(0, Math.floor(Number(counts[hrid]) || 0)) });
    }
    if (!state.length) return null;

    let elapsed = 0;
    let points = 0;
    for (let step = 0; step < MAX_STEPS; step += 1) {
        let soonest = Infinity;
        let winner = null;
        let winnerAt = 0;
        for (const monster of state) {
            const at = nextPointCount(monster.count);
            const hoursToIt = (at - monster.count) / monster.perHour;
            if (hoursToIt < soonest) {
                soonest = hoursToIt;
                winner = monster;
                winnerAt = at;
            }
        }
        if (!winner || !Number.isFinite(soonest)) return null;
        if (elapsed + soonest > MAX_PLAN_HOURS) return null;
        for (const monster of state) {
            const from = monster.count;
            monster.count = monster === winner ? winnerAt : from + monster.perHour * soonest;
            points += pointsFromCount(monster.count) - pointsFromCount(from);
        }
        elapsed += soonest;
        if (points >= target) return elapsed;
    }
    return null;
}

/**
 * A run's length in milliseconds, whichever field the recording route used.
 *
 * A local copy rather than an import: this module is a pure util and the
 * dungeon run history lives in a feature bundle, which a util may not reach
 * into. Two lines of field-picking is cheaper than that dependency.
 *
 * @param {Object} run - A stored dungeon run
 * @returns {number|null}
 */
function runDurationMs(run) {
    const ms = Number(run?.duration ?? run?.totalTime);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * The median of a list of numbers, ignoring anything that is not one.
 * @param {Array<number>} values - Samples
 * @returns {number|null}
 */
function middle(values) {
    const sorted = (values || []).filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Restate a dungeon's simulated kill rates at the clear time you actually get.
 *
 * The simulator clears a dungeon at the pace of a party that never hesitates,
 * never re-stocks and never wipes on a wave it should not have; the run history
 * knows what the door really costs. Both agree about what one clear *contains*
 * — the sim's kills per simulated hour divided by its completions per simulated
 * hour is a wave-for-wave inventory of a single clear — so the honest rate is
 * that inventory times the clears per hour your own runs manage.
 *
 * With no runs for the tier, the dungeon's other tiers stand in (a slower tier
 * is a better guide to your party than a simulation of it); with no runs at all,
 * the sim's own clear time, said so in `source`.
 *
 * @param {Object} input
 * @param {Object} input.killsPerHour - The sim's kills per hour by monster
 * @param {number} input.simClearsPerHour - The sim's completions per simulated hour
 * @param {Array<Object>} [input.runs] - Recorded runs for this dungeon, any tier (`{tier, duration|totalTime}`)
 * @param {number|null} [input.tier] - The tier being rescaled
 * @returns {{killsPerHour: Object, clearsPerHour: number, clearSeconds: number,
 *   source: 'measured'|'measured-all-tiers'|'sim', runs: number}|null} Null when the sim never cleared it
 */
export function rescaleDungeonRates({ killsPerHour = {}, simClearsPerHour = 0, runs = [], tier = null } = {}) {
    const simClears = Number(simClearsPerHour) || 0;
    if (!(simClears > 0)) return null;

    const perClear = {};
    for (const [hrid, rate] of Object.entries(killsPerHour || {})) {
        const perHour = Number(rate) || 0;
        if (!(perHour > 0)) continue;
        perClear[hrid] = perHour / simClears;
    }
    if (!Object.keys(perClear).length) return null;

    const all = (Array.isArray(runs) ? runs : []).filter(Boolean);
    const sameTier = Number.isInteger(tier) ? all.filter((run) => Number(run.tier) === tier) : [];
    const tierDurations = sameTier.map(runDurationMs).filter((ms) => ms !== null);
    const allDurations = all.map(runDurationMs).filter((ms) => ms !== null);

    let source = 'sim';
    let sampled = 0;
    let clearSeconds = 3600 / simClears;
    if (tierDurations.length) {
        source = 'measured';
        sampled = tierDurations.length;
        clearSeconds = middle(tierDurations) / 1000;
    } else if (allDurations.length) {
        source = 'measured-all-tiers';
        sampled = allDurations.length;
        clearSeconds = middle(allDurations) / 1000;
    }
    if (!(clearSeconds > 0)) return null;

    const clearsPerHour = 3600 / clearSeconds;
    const scaled = {};
    for (const [hrid, perOne] of Object.entries(perClear)) scaled[hrid] = perOne * clearsPerHour;
    return { killsPerHour: scaled, clearsPerHour, clearSeconds, source, runs: sampled };
}

/**
 * Plan a Bestiary route through `zones`, either for a time budget or to a
 * points target.
 *
 * With `targetPoints` the question turns around: the same greedy hop runs with
 * no clock on it and stops the moment the target is crossed, so the answer is
 * "how long, and where" rather than "how much". A safety cap on steps and hours
 * keeps a pathological input from looping; what it reached is still reported,
 * with `unreachable: true`.
 *
 * @param {Object} input
 * @param {Array<{zoneHrid: string, name?: string, killsPerHour: Object, encountersPerHour?: number,
 *   isDungeon?: boolean, note?: string}>} input.zones -
 *   Candidate zones with their simulated kills per hour by monster (and, when known, fights per hour, so a
 *   stay can be quoted in fights as well as time); earlier zones win ties
 * @param {Object} input.counts - monsterHrid → kills so far (the Bestiary)
 * @param {number} input.hours - The time budget, in hours mode
 * @param {number} [input.targetPoints] - Points wanted; when set, the plan runs to it instead of to a clock
 * @returns {{
 *   mode: 'hours'|'points',
 *   hours: number,
 *   hoursUsed: number,
 *   targetPoints: number|null,
 *   unreachable: boolean,
 *   totalPoints: number,
 *   pointsByZone: Object,
 *   segments: Array<{zoneHrid: string, name: string, hours: number, encounters: number|null, points: number,
 *     partial: boolean, isDungeon: boolean, note: string|null,
 *     monsters: Array<{monsterHrid: string, from: number, count: number, to: number, reached: boolean, points: number}>}>,
 *   bestSingle: {zoneHrid: string, name: string, points: number, encounters: number|null, hours?: number|null}|null,
 *   counts: Object,
 * }}
 */
export function planBestiaryRoute({ zones = [], counts = {}, hours = 24, targetPoints = null } = {}) {
    const targeting = Number(targetPoints) > 0;
    const target = targeting ? Number(targetPoints) : 0;
    const budget = targeting ? Infinity : Number(hours) > 0 ? Number(hours) : 0;
    const usable = (zones || []).filter(
        (zone) =>
            zone &&
            zone.zoneHrid &&
            zone.killsPerHour &&
            Object.values(zone.killsPerHour).some((rate) => Number(rate) > 0)
    );
    // The route walks on whole kills, so the starting counts are floored once
    // here. `state` is the walk's own mutable copy; `start` is the untouched
    // snapshot the single-zone comparison is measured from — it has to see the
    // same starting point the route did, not the raw counts (a fractional count
    // would credit the zone with progress the route never had) and not the
    // state the route has since advanced.
    const start = {};
    for (const [hrid, count] of Object.entries(counts || {})) {
        start[hrid] = Math.max(0, Math.floor(Number(count) || 0));
    }
    const state = { ...start };

    const segments = [];
    const pointsByZone = {};
    let remaining = budget;
    let used = 0;
    let totalPoints = 0;
    let cappedOut = false;

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
                isDungeon: Boolean(zone.isDungeon),
                note: zone.note || null,
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
        // No clock in points mode, so patience is the only stopping rule left
        if (used + pickNext.hours > MAX_PLAN_HOURS) {
            cappedOut = true;
            break;
        }

        if (pickNext.hours <= remaining) {
            const result = advance(pick.killsPerHour, state, pickNext.hours, pickNext.monsterHrid);
            record(pick, pickNext.hours, result, false);
            remaining -= pickNext.hours;
            used += pickNext.hours;
        } else {
            // The budget runs out before the next point: fight here for what
            // is left and show how far each monster got
            const result = advance(pick.killsPerHour, state, remaining, null);
            record(pick, remaining, result, true);
            used += remaining;
            remaining = 0;
        }
        if (targeting && totalPoints >= target) break;
    }

    let bestSingle = null;
    if (targeting) {
        // The comparison a points target wants is time, not points: which one
        // zone, held the whole way, gets there soonest
        for (const zone of usable) {
            const toTarget = singleZoneHoursToTarget(zone.killsPerHour, start, target);
            // A zone that never gets there only stands in until one that does
            const better =
                !bestSingle || (toTarget !== null && (bestSingle.hours === null || toTarget < bestSingle.hours));
            if (!better) continue;
            bestSingle = {
                zoneHrid: zone.zoneHrid,
                name: zone.name || zone.zoneHrid,
                points: toTarget === null ? 0 : target,
                encounters: toTarget === null ? null : fightsFor(zone, toTarget),
                hours: toTarget,
            };
        }
    } else {
        for (const zone of usable) {
            const points = singleZonePoints(zone.killsPerHour, start, budget);
            if (!bestSingle || points > bestSingle.points) {
                bestSingle = {
                    zoneHrid: zone.zoneHrid,
                    name: zone.name || zone.zoneHrid,
                    points,
                    encounters: fightsFor(zone, budget),
                };
            }
        }
    }

    return {
        mode: targeting ? 'points' : 'hours',
        hours: targeting ? used : budget,
        hoursUsed: used,
        targetPoints: targeting ? target : null,
        unreachable: targeting && totalPoints < target,
        cappedOut,
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
    const points = plan.mode === 'points';
    const lines = [
        points
            ? `Bestiary plan — ${plan.totalPoints} points in ${formatPlanHours(plan.hoursUsed)} h` +
              (plan.unreachable ? ` (${plan.targetPoints} not reachable)` : '')
            : `Bestiary plan — ${formatPlanHours(plan.hours)} h, ${plan.totalPoints} points`,
    ];
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
                : ` (≈${Math.round(segment.encounters)} ${segment.isDungeon ? 'clears' : 'fights'})`;
        lines.push(
            `${index + 1}. ${segment.name} — ${formatPlanHours(segment.hours)}${fights} — +${segment.points}` +
                (detail ? ` — ${detail}` : '')
        );
    });
    if (plan.bestSingle && points) {
        lines.push(
            plan.bestSingle.hours === null || plan.bestSingle.hours === undefined
                ? `Best single zone: none reaches ${plan.targetPoints} points`
                : `Best single zone: ${plan.bestSingle.name} — reaches ${plan.targetPoints} in ` +
                      `${formatPlanHours(plan.bestSingle.hours)} h`
        );
    } else if (plan.bestSingle) {
        lines.push(`Best single zone: ${plan.bestSingle.name} — ${plan.bestSingle.points} points`);
    }
    return lines.join('\n');
}
