/**
 * Tick periods — how often the game's periodic effects actually fire.
 *
 * The simulator advances four repeating effects on four constants: heal over
 * time every 5 s, damage over time every 3 s, hitpoint and mana regeneration
 * every 10 s, and the enrage ramp every 60 s. All four were inherited with the
 * engine, and no one here has ever checked one of them against the game. A
 * neighboring engine built from the same ancestor carries the same four and
 * says outright that they were not measured separately, so the agreement
 * between them is one unverified assumption seen twice rather than two
 * confirmations.
 *
 * This module is the arithmetic for checking them off the live battle stream;
 * {@link ./tick-period-observer.js} is the half that watches the wire.
 *
 * ## Telling a periodic tick from an ordinary combat event
 *
 * This is the whole difficulty. A regeneration tick and a heal landing both
 * raise `cHP`; a damage-over-time tick and a hit both lower it. The stream does
 * supply discriminators, and every one of them is used conservatively — an
 * event that could be two things is thrown away and counted as thrown away,
 * because a contaminated sample that looks tidy is the failure mode worth
 * fearing here.
 *
 * - **A unit entry is a delta.** A field that did not change is not sent, so a
 *   `cHP` that moved with no `dmgCounter` beside it is a health change the
 *   server did not resolve as an attack.
 * - **An attack moves counters.** The attacker's `atkCounter` and the
 *   defender's `dmgCounter` both rise on a swing, hit or miss. A unit whose own
 *   counters are still is not swinging and is not being swung at.
 * - **A cast names itself.** `abilityHrid` appears on the *caster's* entry, not
 *   the target's, so a heal cast on somebody else is invisible on the unit that
 *   gained the health. The only safe reading is therefore tick-wide: if
 *   anything at all named an ability on this tick, no recovery seen on this
 *   tick is counted.
 * - **Regeneration moves both resources.** The engine's regeneration tick adds
 *   hitpoints *and* mana at once, and the recorded stream agrees: the pattern is
 *   a simultaneous rise in `cHP` and `cMP` on a quiet unit. A recovery tick
 *   moves one of them. So a rise in one resource counts as recovery only when
 *   the other is known to be below its maximum — otherwise a regeneration tick
 *   with nowhere to put its mana looks exactly like food, and that ambiguity is
 *   a discard rather than a guess.
 *
 * ## What that leaves unanswerable, and why the panel says so
 *
 * Damage over time has no positive signature; it is a health fall that nothing
 * else explains. If the server counts a tick of it in `dmgCounter` the same way
 * it counts a swing, there is nothing here to separate the two and this tool
 * cannot measure it at all. So every health fall is classified and counted:
 * falls attributed to a swing, and falls with nothing behind them. A category
 * with no observations and a large attributed count is a stated result — "not
 * resolvable from what the server sends" — and not an empty row.
 *
 * ## What the intervals are measured with
 *
 * Both ends are client arrival times. That noise is measured rather than
 * assumed, by {@link ./wave-gap.js}'s calibration, which reads the server's own
 * stated delay to each player's next action and takes the residual. It comes
 * out near 20 ms of robust standard deviation. Against a 3–10 s period that is
 * about half a percent of one reading, so a handful of observations already
 * separates 3.0 s from 2.8 s — the panel prints the band rather than asserting
 * it. At 60 s the periods are rare instead of imprecise, and the honest report
 * there is the count.
 *
 * ## Missed ticks, and why the estimate is a mode and not a mean
 *
 * A tick with nowhere to land is not sent: a unit at full health gains nothing
 * and appears in no delta. The interval then measured is two periods, or three.
 * A mean of that sample is a number no period ever had. So the estimate is the
 * densest cluster of intervals — the window that holds the most of them, at a
 * tolerance fixed in advance and independent of the constant being tested — and
 * the multiples are reported beside it as corroboration: a clean 2× and 3×
 * echo is what a periodic process looks like when observations are dropped.
 */

import { percentile, robustScale } from './wave-gap.js';

/** The four effects, keyed as the tally stores them */
export const EFFECTS = {
    regen: 'regen',
    hot: 'hot',
    dot: 'dot',
    enrage: 'enrage',
};

/**
 * What each effect is, what the engine assumes, and how much of it is needed
 * before a number is worth printing. The enrage threshold is far lower than the
 * others because a 60 s period yields one observation a minute at best; the
 * panel labels anything under the threshold as provisional rather than hiding
 * it.
 */
export const EFFECT_SPECS = [
    {
        key: EFFECTS.regen,
        label: 'Hitpoint and mana regeneration',
        assumedMs: 10_000,
        minObservations: 20,
        signature: 'Hitpoints and mana rising together on a unit that neither swung nor was swung at.',
    },
    {
        key: EFFECTS.hot,
        label: 'Food and drink recovery',
        assumedMs: 5_000,
        minObservations: 20,
        signature:
            'One resource rising on a quiet unit while the other is known to be below its maximum, on a tick ' +
            'where nothing named an ability.',
    },
    {
        key: EFFECTS.dot,
        label: 'Damage over time',
        assumedMs: 3_000,
        minObservations: 20,
        signature: 'Hitpoints falling on a unit whose damage counter did not move, so no swing resolved on it.',
    },
    {
        key: EFFECTS.enrage,
        label: 'Enrage ramp',
        assumedMs: 60_000,
        minObservations: 6,
        signature: "A monster's enrage buff restating a larger boost in its combat buff map.",
    },
];

/** Why a candidate was thrown away, with the label the panel prints */
export const REJECTIONS = {
    hpFallAttributed: 'Hitpoints fell, but that unit’s damage counter moved with them (a swing, not a tick)',
    abilityInTick: 'A recovery discarded because something named an ability on that tick',
    maxUnknown: 'A recovery discarded because the unit’s maximum for the other resource is not known yet',
    otherResourceFull: 'A recovery discarded because the other resource was full, so regen and food look alike',
    outOfRange: 'Interval implausible for a periodic tick',
    hidden: 'Tab was in the background',
};

/** Shorter than this, it is not one period of anything periodic */
const MIN_INTERVAL_MS = 300;

/** Longer than this, whatever linked the two events is not a tick schedule */
const MAX_INTERVAL_MS = 300_000;

/**
 * Half-width of the clustering window, as a fraction of the candidate period.
 *
 * Wide enough to hold the jitter and the odd late tick, narrow enough that 3.0 s
 * and 2.5 s cannot land in the same cluster. Fixed here rather than derived from
 * the constant under test, so the estimate cannot be pulled toward the answer
 * the engine already assumes.
 */
export const CLUSTER_TOLERANCE = 0.1;

/** Raw intervals kept per effect */
const MAX_ROWS = 1200;

/** Median of a normal, as a multiple of the mean's own standard error */
const MEDIAN_SEM_FACTOR = 1.2533;

/** Two-sided 95% normal quantile */
const Z95 = 1.96;

/** Below this many milliseconds a difference is not worth asserting either way */
const FLOOR_MS = 1;

/**
 * An empty tally, which is also the shape stored.
 * @returns {Object} Tally
 */
export function emptyTally() {
    const effects = {};
    const rejections = {};
    for (const spec of EFFECT_SPECS) {
        effects[spec.key] = { n: 0, rows: [], simultaneous: 0 };
        rejections[spec.key] = {};
        for (const reason of Object.keys(REJECTIONS)) rejections[spec.key][reason] = 0;
    }
    return {
        version: 1,
        effects,
        rejections,
        hpFalls: { attributed: 0, unattributed: 0 },
        jitter: { rows: [], seen: 0 },
        updatedAt: 0,
    };
}

/**
 * Fold one measured interval in.
 * @param {Object} tally - Tally, mutated
 * @param {{effect: string, intervalMs: number, at: number, simultaneous?: number}} observation - From the watch
 * @returns {void}
 */
export function foldObservation(tally, observation) {
    const bucket = tally.effects?.[observation.effect];
    if (!bucket) return;
    if (!Number.isFinite(observation.intervalMs)) return;
    bucket.n += 1;
    bucket.rows.push(Math.round(observation.intervalMs));
    if (bucket.rows.length > MAX_ROWS) bucket.rows.splice(0, bucket.rows.length - MAX_ROWS);
    if (observation.simultaneous > 1) bucket.simultaneous += 1;
    tally.updatedAt = observation.at || tally.updatedAt;
}

/**
 * Count a rejected candidate. Which ones were dropped is half the result.
 * @param {Object} tally - Tally, mutated
 * @param {string} effect - Which effect the candidate would have been
 * @param {string} reason - A key of {@link REJECTIONS}
 * @returns {void}
 */
export function foldRejection(tally, effect, reason) {
    const bucket = tally.rejections?.[effect];
    if (!bucket || !(reason in REJECTIONS)) return;
    bucket[reason] += 1;
}

/**
 * Count a health fall by whether a swing explained it.
 *
 * This is the evidence that separates "no damage over time happened here" from
 * "damage over time is indistinguishable from a hit on this wire", and without
 * it a damage-over-time row of zero would be unreadable.
 *
 * @param {Object} tally - Tally, mutated
 * @param {boolean} attributed - Whether the unit's damage counter moved with it
 * @returns {void}
 */
export function foldHpFall(tally, attributed) {
    if (!tally.hpFalls) return;
    if (attributed) tally.hpFalls.attributed += 1;
    else tally.hpFalls.unattributed += 1;
}

/**
 * The densest cluster of intervals, and how tight it is.
 *
 * Every observed value is tried as a center and the one holding the most
 * neighbors wins; the window is then re-centered once on that cluster's median
 * so the estimate does not depend on an edge member having been the seed.
 *
 * @param {Array<number>} values - Intervals in milliseconds
 * @param {number} [tolerance] - Half-width as a fraction of the center
 * @returns {{median: number, n: number, sd: number, sem: number, share: number}|null} The cluster
 */
export function modeCluster(values, tolerance = CLUSTER_TOLERANCE) {
    if (!values?.length) return null;

    let bestCenter = null;
    let bestCount = 0;
    for (const center of values) {
        if (!(center > 0)) continue;
        const inside = values.filter((value) => Math.abs(value - center) <= center * tolerance).length;
        if (inside > bestCount || (inside === bestCount && bestCenter !== null && center < bestCenter)) {
            bestCount = inside;
            bestCenter = center;
        }
    }
    if (bestCenter === null) return null;

    const seeded = values.filter((value) => Math.abs(value - bestCenter) <= bestCenter * tolerance);
    const seedMedian = percentile(
        [...seeded].sort((a, b) => a - b),
        0.5
    );
    const members = values.filter((value) => Math.abs(value - seedMedian) <= seedMedian * tolerance);
    const scale = robustScale(members);
    const median = percentile(
        [...members].sort((a, b) => a - b),
        0.5
    );
    const sem = members.length > 1 ? (MEDIAN_SEM_FACTOR * scale.sd) / Math.sqrt(members.length) : null;

    return { median, n: members.length, sd: scale.sd, sem, share: members.length / values.length };
}

/**
 * How many intervals are a whole multiple of the cluster's period.
 * @param {Array<number>} values - Intervals
 * @param {number} period - The cluster median
 * @param {number} [tolerance] - Half-width as a fraction
 * @returns {{x2: number, x3: number, other: number}} Counts
 */
export function multiples(values, period, tolerance = CLUSTER_TOLERANCE) {
    const near = (value, target) => Math.abs(value - target) <= target * tolerance;
    let x2 = 0;
    let x3 = 0;
    let other = 0;
    for (const value of values) {
        if (near(value, period)) continue;
        if (near(value, period * 2)) x2 += 1;
        else if (near(value, period * 3)) x3 += 1;
        else other += 1;
    }
    return { x2, x3, other };
}

/**
 * One effect read as an answer, including the several ways it can fail to be one.
 * @param {Object} spec - An entry of {@link EFFECT_SPECS}
 * @param {Object} tally - The stored tally
 * @returns {Object} Summary
 */
function summarizeEffect(spec, tally) {
    const bucket = tally.effects?.[spec.key] || { n: 0, rows: [], simultaneous: 0 };
    const rows = bucket.rows || [];
    const rejections = Object.entries(REJECTIONS)
        .map(([key, label]) => ({ key, label, count: tally.rejections?.[spec.key]?.[key] || 0 }))
        .filter((row) => row.count > 0);
    const rejected = rejections.reduce((sum, row) => sum + row.count, 0);

    const cluster = modeCluster(rows);
    const echo = cluster ? multiples(rows, cluster.median) : { x2: 0, x3: 0, other: 0 };
    const band = cluster?.sem === null || cluster === null ? null : Math.max(Z95 * cluster.sem, FLOOR_MS);
    const difference = cluster ? cluster.median - spec.assumedMs : null;

    let state;
    let text;
    if (!rows.length && !rejected) {
        state = 'empty';
        text = 'Nothing seen yet.';
    } else if (!rows.length) {
        state = 'unresolved';
        text =
            `No interval could be isolated: ${rejected} candidate${rejected === 1 ? '' : 's'} were seen and ` +
            'every one of them could have been something else. This effect is not resolvable from what the ' +
            'stream has carried so far.';
    } else if (cluster.n < spec.minObservations) {
        state = 'provisional';
        text =
            `Provisional — ${cluster.n} interval${cluster.n === 1 ? '' : 's'} in the cluster, ` +
            `${spec.minObservations} before this is worth quoting.`;
    } else if (Math.abs(difference) <= band) {
        state = 'consistent';
        text =
            `Consistent with the assumed ${(spec.assumedMs / 1000).toFixed(3)} s: measured ` +
            `${(cluster.median / 1000).toFixed(3)} s, and a difference larger than ±${band.toFixed(0)} ms ` +
            'would have shown.';
    } else {
        state = 'differs';
        text =
            `Differs from the assumed ${(spec.assumedMs / 1000).toFixed(3)} s: measured ` +
            `${(cluster.median / 1000).toFixed(3)} s, ${difference > 0 ? '+' : ''}${difference.toFixed(0)} ms, ` +
            `against a ±${band.toFixed(0)} ms band.`;
    }

    return {
        key: spec.key,
        label: spec.label,
        signature: spec.signature,
        assumedMs: spec.assumedMs,
        minObservations: spec.minObservations,
        n: bucket.n,
        kept: rows.length,
        simultaneous: bucket.simultaneous || 0,
        cluster,
        band,
        difference,
        echo,
        rejections,
        rejected,
        state,
        text,
    };
}

/**
 * The tally read as an answer.
 * @param {Object} tally - The stored tally
 * @returns {Object} Everything the panel prints
 */
export function summarize(tally) {
    const effects = EFFECT_SPECS.map((spec) => summarizeEffect(spec, tally));
    const jitterRows = tally.jitter?.rows || [];
    const scale = robustScale(jitterRows);
    const jitter = {
        n: jitterRows.length,
        seen: tally.jitter?.seen || 0,
        median: scale?.median ?? null,
        sd: scale?.sd ?? null,
    };

    const resolved = effects.filter((effect) => effect.state === 'consistent' || effect.state === 'differs');
    const disagreeing = resolved.filter((effect) => effect.state === 'differs');
    let verdict;
    if (!resolved.length) {
        const seen = effects.reduce((sum, effect) => sum + effect.kept + effect.rejected, 0);
        verdict = seen
            ? 'Nothing resolved yet — the counts and the discards below are the whole of what is known.'
            : 'Nothing measured yet — fight with this switched on.';
    } else if (disagreeing.length) {
        verdict =
            `${disagreeing.length} of ${resolved.length} resolved effect` +
            `${resolved.length === 1 ? '' : 's'} disagrees with the constant the engine assumes.`;
    } else {
        verdict =
            `${resolved.length} of ${effects.length} effects resolved, and consistent with the constant the ` +
            'engine assumes. The rest are unresolved, which is not the same as confirmed.';
    }

    return {
        effects,
        jitter,
        hpFalls: tally.hpFalls || { attributed: 0, unattributed: 0 },
        updatedAt: tally.updatedAt || 0,
        verdict,
    };
}

/**
 * Whether a unit entry says the unit swung or was swung at on this tick.
 * @param {Object} entry - The delta as it arrived
 * @param {Object} last - What was known of the unit before it
 * @returns {boolean} True when a counter moved
 */
function countersMoved(entry, last) {
    for (const field of ['dmgCounter', 'atkCounter']) {
        if (field in entry && Number(entry[field]) !== Number(last?.[field])) return true;
    }
    return false;
}

/**
 * The boost an enrage entry in a combat buff map currently states.
 * @param {Object} buffMap - A unit's `combatBuffMap`
 * @returns {number|null} The summed enrage boost, or null when there is none
 */
export function enrageBoost(buffMap) {
    let total = null;
    for (const [uniqueHrid, buff] of Object.entries(buffMap || {})) {
        if (!String(uniqueHrid).includes('enrage')) continue;
        const boost = Number(buff?.ratioBoost);
        if (!Number.isFinite(boost)) continue;
        total = (total ?? 0) + boost;
    }
    return total;
}

/**
 * The live half's state machine, kept here so a test can drive it with a tick
 * sequence rather than by playing the game.
 *
 * @returns {Object} A watch
 */
export function createTickPeriodWatch() {
    /** Last known whole state per unit key, rebuilt from the deltas */
    const units = new Map();
    /** When each unit was last seen ticking each effect */
    const seen = new Map();
    const out = [];
    const rejections = [];
    const falls = [];

    /**
     * Emit the interval since this unit last ticked this effect.
     * @param {string} key - Unit key
     * @param {string} effect - Which effect
     * @param {number} at - Arrival time
     * @param {number} simultaneous - How many units ticked it on this same tick
     * @returns {void}
     */
    function note(key, effect, at, simultaneous) {
        const id = `${key}:${effect}`;
        const last = seen.get(id);
        seen.set(id, at);
        if (last === undefined) return;
        const intervalMs = at - last;
        if (intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
            rejections.push({ effect, reason: 'outOfRange' });
            return;
        }
        out.push({ effect, intervalMs, at, simultaneous });
    }

    return {
        /**
         * A wave started. Monster slots are reused by different monsters, so
         * everything on that side is forgotten; the players are the same people
         * and their schedules visibly run straight through a respawn.
         * @returns {void}
         */
        newBattle() {
            for (const key of [...units.keys()]) if (key.startsWith('m')) units.delete(key);
            for (const id of [...seen.keys()]) if (id.startsWith('m')) seen.delete(id);
        },

        /**
         * A tick landed.
         * @param {Object} data - `battle_updated` payload
         * @param {number} at - Arrival time
         * @param {Object} [context] - `{hidden}`
         * @returns {void}
         */
        battleUpdated(data, at, context = {}) {
            if (context.hidden === true) {
                // A backgrounded tab is not a stopped stream, but it is not a
                // clock worth timing against either, and an interval that spans
                // the gap would be a period this machine invented
                if (seen.size) {
                    for (const spec of EFFECT_SPECS) rejections.push({ effect: spec.key, reason: 'hidden' });
                }
                seen.clear();
                return;
            }

            const sides = [
                ['p', data?.pMap],
                ['m', data?.mMap],
            ];

            let abilityInTick = false;
            for (const [, map] of sides) {
                for (const entry of Object.values(map || {})) if (entry?.abilityHrid) abilityInTick = true;
            }

            const candidates = [];
            for (const [prefix, map] of sides) {
                for (const [slot, entry] of Object.entries(map || {})) {
                    const key = `${prefix}${slot}`;
                    const last = units.get(key);
                    const now = { ...(last || {}), ...entry };
                    units.set(key, now);
                    if (!last) continue;

                    const enraged = enrageBoost(entry?.combatBuffMap);
                    if (enraged !== null && enraged > (Number(last.enrageBoost) || 0)) {
                        candidates.push({ key, effect: EFFECTS.enrage });
                    }
                    if (enraged !== null) now.enrageBoost = enraged;

                    const deltaHp = 'cHP' in entry && 'cHP' in last ? Number(entry.cHP) - Number(last.cHP) : 0;
                    const deltaMp = 'cMP' in entry && 'cMP' in last ? Number(entry.cMP) - Number(last.cMP) : 0;
                    const quiet = !countersMoved(entry, last);

                    if (deltaHp < 0) {
                        falls.push('dmgCounter' in entry && Number(entry.dmgCounter) !== Number(last.dmgCounter));
                        if (quiet) candidates.push({ key, effect: EFFECTS.dot });
                        else rejections.push({ effect: EFFECTS.dot, reason: 'hpFallAttributed' });
                        continue;
                    }
                    if (deltaHp <= 0 && deltaMp <= 0) continue;
                    if (!quiet) continue;

                    if (deltaHp > 0 && deltaMp > 0) {
                        candidates.push({ key, effect: EFFECTS.regen });
                        continue;
                    }
                    if (abilityInTick) {
                        rejections.push({ effect: EFFECTS.hot, reason: 'abilityInTick' });
                        continue;
                    }
                    // One resource rose; the claim that this is recovery rather
                    // than regeneration rests entirely on the other resource
                    // having had somewhere to go and not gone there
                    const otherMax = deltaHp > 0 ? Number(now.mMP) : Number(now.mHP);
                    const otherNow = deltaHp > 0 ? Number(now.cMP) : Number(now.cHP);
                    if (!Number.isFinite(otherMax) || !Number.isFinite(otherNow)) {
                        rejections.push({ effect: EFFECTS.hot, reason: 'maxUnknown' });
                        continue;
                    }
                    if (otherNow >= otherMax) {
                        rejections.push({ effect: EFFECTS.hot, reason: 'otherResourceFull' });
                        continue;
                    }
                    candidates.push({ key, effect: EFFECTS.hot });
                }
            }

            const counts = {};
            for (const candidate of candidates) counts[candidate.effect] = (counts[candidate.effect] || 0) + 1;
            for (const candidate of candidates) note(candidate.key, candidate.effect, at, counts[candidate.effect]);
        },

        /**
         * Everything finished since the last call.
         * @returns {{observations: Array<Object>, rejections: Array<Object>, hpFalls: Array<boolean>}} Results
         */
        drain() {
            const observations = out.slice();
            const reasons = rejections.slice();
            const hpFalls = falls.slice();
            out.length = 0;
            rejections.length = 0;
            falls.length = 0;
            return { observations, rejections: reasons, hpFalls };
        },
    };
}
