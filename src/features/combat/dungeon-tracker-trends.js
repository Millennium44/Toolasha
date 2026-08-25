/**
 * Dungeon Tracker Trends
 *
 * "Am I getting faster?", answered from the run history the panel already has.
 *
 * Two figures, both per dungeon+tier, because a tier is a different fight and
 * averaging two of them together describes neither:
 *
 * - the last ten runs' average duration against the ten before it, as a
 *   direction and a percent, and
 * - the runs per hour that recent average implies.
 *
 * There is deliberately no token figure. A stored run records `duration`,
 * `timestamp`, `team`, `tier` and `keyCountsMap` — and `keyCountsMap` is the
 * *keys each party member spent*, not what the run paid out. Nothing in the
 * stored shape says how many tokens a run earned, so nothing here claims to.
 * (The ROI board's token figures come from the game's reward tables, not from
 * recorded runs, and are a different question: what a run is worth in theory,
 * not what these runs earned.)
 *
 * Everything is null-honest: too few runs answers "not enough runs yet" rather
 * than a rate built on one run's luck, and no rate is ever divided by a zero
 * or absent duration.
 */

import { runIdentity } from './dungeon-tracker-storage.js';

/** Below this many runs a figure is one run's luck, not a trend */
export const MIN_RUNS_FOR_TREND = 3;

/** How many runs each side of the run-over-run comparison holds */
export const TREND_WINDOW = 10;

/** How many previous runs a single run's delta is measured against */
export const DELTA_WINDOW = 5;

/** Within this much either way, two averages are the same average */
export const FLAT_TOLERANCE_PERCENT = 1;

const MS_PER_HOUR = 3600000;

/** What a group with too little history says instead of a number */
export const NOT_ENOUGH_RUNS = 'not enough runs yet';

/**
 * A run's duration in milliseconds, if it has a usable one.
 *
 * Both field names are stored: chat-recorded runs carry `duration`, the live
 * tracker's older records carry `totalTime`.
 *
 * @param {Object} run - A stored run
 * @returns {number|null} Milliseconds, or null when the run cannot say
 */
export function runDurationMs(run) {
    const duration = Number(run?.duration ?? run?.totalTime);
    return Number.isFinite(duration) && duration > 0 ? duration : null;
}

/**
 * The dungeon+tier a run belongs to.
 *
 * Runs recovered from chat carry no tier; they group under their own key
 * rather than being folded into a tier they were never known to be.
 *
 * @param {Object} run - A stored run
 * @returns {string} Group key
 */
export function trendKey(run) {
    const tier = Number.isInteger(run?.tier) ? `T${run.tier}` : 'T?';
    return `${run?.dungeonName || 'Unknown'}::${tier}`;
}

/**
 * A human label for a group key.
 * @param {Object} run - Any run in the group
 * @returns {string} e.g. "Chimerical Den T2", or the dungeon alone without a tier
 */
export function trendLabel(run) {
    const name = run?.dungeonName || 'Unknown';
    return Number.isInteger(run?.tier) ? `${name} T${run.tier}` : name;
}

/**
 * The mean of a list of durations.
 * @param {Array<number>} values - Milliseconds
 * @returns {number|null} Mean, or null for an empty list
 */
function mean(values) {
    if (!values.length) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * One dungeon+tier's trend.
 *
 * The recent window is the newest ten runs and the prior window the ten before
 * them. Either side needs {@link MIN_RUNS_FOR_TREND} runs to speak: with fewer
 * recent runs there is no rate at all, and with fewer prior ones there is a
 * rate but nothing to compare it against.
 *
 * @param {Array<Object>} runs - The group's runs, newest first
 * @returns {{runCount: number, enough: boolean, recentAvgMs: number|null, priorAvgMs: number|null,
 *   changePercent: number|null, direction: 'faster'|'slower'|'flat'|null, runsPerHour: number|null}}
 */
export function computeTrend(runs) {
    const durations = (runs || []).map(runDurationMs).filter((ms) => ms !== null);

    const recent = durations.slice(0, TREND_WINDOW);
    const prior = durations.slice(TREND_WINDOW, TREND_WINDOW * 2);

    const enough = recent.length >= MIN_RUNS_FOR_TREND;
    const recentAvgMs = enough ? mean(recent) : null;
    const priorAvgMs = prior.length >= MIN_RUNS_FOR_TREND ? mean(prior) : null;

    let changePercent = null;
    let direction = null;
    if (recentAvgMs !== null && priorAvgMs !== null && priorAvgMs > 0) {
        // Positive is faster: a *shorter* run is the good direction, so the
        // sign answers "am I improving", not "is the number bigger"
        changePercent = ((priorAvgMs - recentAvgMs) / priorAvgMs) * 100;
        if (Math.abs(changePercent) < FLAT_TOLERANCE_PERCENT) direction = 'flat';
        else direction = changePercent > 0 ? 'faster' : 'slower';
    }

    return {
        runCount: durations.length,
        enough,
        recentAvgMs,
        priorAvgMs,
        changePercent,
        direction,
        // Never a rate over a zero or missing average
        runsPerHour: recentAvgMs !== null && recentAvgMs > 0 ? MS_PER_HOUR / recentAvgMs : null,
    };
}

/**
 * The marker for a direction.
 * @param {'faster'|'slower'|'flat'|null} direction - From `computeTrend`
 * @returns {string} An arrow, or an em dash when there is nothing to compare
 */
export function directionMarker(direction) {
    if (direction === 'faster') return '▼';
    if (direction === 'slower') return '▲';
    if (direction === 'flat') return '→';
    return '—';
}

/**
 * Group runs by dungeon+tier and trend each group.
 *
 * @param {Array<Object>} runs - Runs, newest first, as the panel holds them
 * @returns {Array<{key: string, label: string, trend: Object}>} Groups, most-run first
 */
export function buildTrends(runs) {
    const groups = new Map();
    for (const run of runs || []) {
        if (!run) continue;
        const key = trendKey(run);
        const group = groups.get(key);
        if (group) group.runs.push(run);
        else groups.set(key, { key, label: trendLabel(run), runs: [run] });
    }

    return [...groups.values()]
        .map((group) => ({ key: group.key, label: group.label, trend: computeTrend(group.runs) }))
        .sort((a, b) => b.trend.runCount - a.trend.runCount || a.label.localeCompare(b.label));
}

/**
 * Each run against the rolling average of the five runs before it.
 *
 * "Before" is chronological, so with the list newest first a run's previous
 * runs are the ones after it. A run without {@link MIN_RUNS_FOR_TREND} runs
 * behind it in its own dungeon+tier gets no delta rather than a comparison
 * against one or two runs.
 *
 * @param {Array<Object>} runs - Runs, newest first
 * @returns {Map<string, {deltaMs: number, percent: number, direction: 'faster'|'slower'|'flat'}>}
 *   Keyed by `runIdentity`
 */
export function buildRunDeltas(runs) {
    const byGroup = new Map();
    for (const run of runs || []) {
        if (!run) continue;
        const key = trendKey(run);
        const list = byGroup.get(key);
        if (list) list.push(run);
        else byGroup.set(key, [run]);
    }

    const deltas = new Map();
    for (const list of byGroup.values()) {
        for (let i = 0; i < list.length; i++) {
            const duration = runDurationMs(list[i]);
            if (duration === null) continue;

            const previous = list
                .slice(i + 1, i + 1 + DELTA_WINDOW)
                .map(runDurationMs)
                .filter((ms) => ms !== null);
            if (previous.length < MIN_RUNS_FOR_TREND) continue;

            const baseline = mean(previous);
            if (!baseline) continue;

            const percent = ((baseline - duration) / baseline) * 100;
            deltas.set(runIdentity(list[i]), {
                deltaMs: duration - baseline,
                percent,
                direction: Math.abs(percent) < FLAT_TOLERANCE_PERCENT ? 'flat' : percent > 0 ? 'faster' : 'slower',
            });
        }
    }
    return deltas;
}

/**
 * What the run list looks like, cheaply.
 *
 * The panel is handed a fresh copy of the history on every redraw, so the array
 * itself is never the same object twice and identity is no use as a cache key.
 * The runs that make up a signature are the ones the figures are computed from:
 * a run added, removed, amended or re-filtered changes the length, the ends or
 * the total, and any of those misses the cache.
 *
 * @param {Array<Object>} runs - Runs, newest first
 * @returns {string} Signature
 * @private
 */
function signature(runs) {
    const list = runs || [];
    if (!list.length) return '0';
    let total = 0;
    for (const run of list) total += runDurationMs(run) ?? 0;
    return `${list.length}|${runIdentity(list[0])}|${runIdentity(list[list.length - 1])}|${total}`;
}

/** The last computation, kept so a redraw that changed nothing costs nothing */
let memo = null;

/**
 * Trends and per-run deltas for a run list, computed on demand and remembered.
 *
 * Called from the render path, so nothing here is on a timer: the figures are
 * recomputed exactly when the data behind them changed and the view asked.
 *
 * @param {Array<Object>} runs - Runs, newest first
 * @returns {{groups: Array<Object>, deltas: Map<string, Object>}}
 */
export function trendsFor(runs) {
    const key = signature(runs);
    if (memo && memo.key === key) return memo.value;

    const value = { groups: buildTrends(runs), deltas: buildRunDeltas(runs) };
    memo = { key, value };
    return value;
}

/**
 * Test-only: forget the memoised computation.
 * @returns {void}
 */
export function _resetTrendMemo() {
    memo = null;
}
