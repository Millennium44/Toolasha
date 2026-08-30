/**
 * Prediction calibration arithmetic
 *
 * The profit calculators say what an action is worth per hour. The loot log says
 * what it actually paid. Nobody compares the two, so a calculator that has been
 * quietly wrong about an action for a week reads exactly like one that is right
 * — the number is confident either way.
 *
 * This module is the comparison, and only the comparison: it takes recorded
 * prediction/actual pairs and reduces them to a deviation per action type, plus
 * a flag when the gap is not noise. Nothing here reads storage, prices, or the
 * page, so every rule below is testable on plain numbers.
 *
 * ## Why the median, not the mean
 *
 * A single unlucky rare drop moves a run's actual profit by more than the
 * calculator is ever wrong by. Averaging deviations lets one such run declare a
 * whole skill miscalibrated; the median of the per-run deviations asks instead
 * whether the *typical* run missed, which is the question worth answering.
 * The means are still reported, because they are what a player recognises.
 */

/** A gap this large, held across enough runs, is worth pointing at */
export const DEFAULT_GAP_PERCENT = 15;

/** Below this many runs a "persistent" gap is just a run of bad luck */
export const DEFAULT_MIN_SAMPLES = 5;

/**
 * How far the actual came out from the prediction, as a percentage.
 *
 * Signed the way a player reads it: negative means the action paid less than
 * the calculator promised.
 *
 * @param {number} predicted - Predicted profit per hour
 * @param {number} actual - Observed profit per hour
 * @returns {number|null} Percentage, or null when there is nothing to divide by
 */
export function deviationPercent(predicted, actual) {
    if (!Number.isFinite(predicted) || !Number.isFinite(actual)) return null;
    // A prediction of zero has no scale to be wrong against
    if (Math.abs(predicted) < 1) return null;
    return ((actual - predicted) / Math.abs(predicted)) * 100;
}

/**
 * The middle value, which is what a typical run did.
 * @param {number[]} values - Numbers, in any order
 * @returns {number|null} The median, or null when there is nothing
 */
export function median(values) {
    const sorted = (values || []).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * The arithmetic mean.
 * @param {number[]} values - Numbers
 * @returns {number|null} The mean, or null when there is nothing
 */
export function mean(values) {
    const usable = (values || []).filter((v) => Number.isFinite(v));
    if (!usable.length) return null;
    return usable.reduce((sum, v) => sum + v, 0) / usable.length;
}

/**
 * Reduce one action type's records to a single verdict.
 * @param {string} actionType - What the records are about
 * @param {Array<Object>} records - Records for that type
 * @param {{minSamples: number, gapPercent: number}} rules - When a gap counts
 * @returns {Object} A group summary
 */
function summarizeGroup(actionType, records, { minSamples, gapPercent }) {
    const deviations = records.map((r) => deviationPercent(r.predicted, r.actual)).filter((d) => d !== null);
    const medianDeviation = median(deviations);
    const samples = records.length;
    // A gap only counts once enough runs agree on it, and the median is what
    // keeps one spectacular drop from speaking for the whole skill
    const flagged =
        deviations.length >= minSamples && medianDeviation !== null && Math.abs(medianDeviation) >= gapPercent;

    return {
        actionType,
        samples,
        rated: deviations.length,
        predictedMean: mean(records.map((r) => r.predicted)),
        actualMean: mean(records.map((r) => r.actual)),
        medianDeviation,
        flagged,
        // Which way the calculator is wrong, in the words a player would use
        direction: medianDeviation === null ? null : medianDeviation < 0 ? 'optimistic' : 'pessimistic',
        lastAt: records.reduce((latest, r) => (r.t > latest ? r.t : latest), 0),
    };
}

/**
 * Predicted against actual, per action type and overall.
 *
 * @param {Array<Object>} records - `{actionType, predicted, actual, t}` pairs
 * @param {Object} [options] - Rules
 * @param {number} [options.minSamples] - Runs needed before a gap is called persistent
 * @param {number} [options.gapPercent] - How large a median gap has to be
 * @param {number} [options.now] - Clock, for windowing
 * @param {number} [options.windowMs] - Only consider records this recent
 * @returns {{overall: Object, groups: Array<Object>, flagged: Array<Object>}}
 */
export function summarizeCalibration(records, options = {}) {
    const {
        minSamples = DEFAULT_MIN_SAMPLES,
        gapPercent = DEFAULT_GAP_PERCENT,
        now = Date.now(),
        windowMs = null,
    } = options;

    const usable = (records || []).filter(
        (r) =>
            r &&
            Number.isFinite(r.predicted) &&
            Number.isFinite(r.actual) &&
            (windowMs === null || now - (r.t || 0) <= windowMs)
    );

    const byType = new Map();
    for (const record of usable) {
        const type = record.actionType || 'unknown';
        if (!byType.has(type)) byType.set(type, []);
        byType.get(type).push(record);
    }

    const groups = [...byType.entries()]
        .map(([type, group]) => summarizeGroup(type, group, { minSamples, gapPercent }))
        .sort((a, b) => Math.abs(b.medianDeviation ?? 0) - Math.abs(a.medianDeviation ?? 0));

    return {
        overall: summarizeGroup('all', usable, { minSamples, gapPercent }),
        groups,
        flagged: groups.filter((group) => group.flagged),
    };
}

/**
 * A deviation as a reader sees it, for the sentences built below.
 * @param {number|null} percent - A deviation
 * @returns {string} e.g. `-31%`
 */
function pct(percent) {
    return percent === null ? '—' : `${percent >= 0 ? '+' : ''}${percent.toFixed(1)}%`;
}

/**
 * XP against gold, on the pairs that carry both.
 *
 * A combat pair records two rates, not one: the coins the fight paid and the
 * experience it gave. Only the coins were ever read, and that pooling loses the
 * one distinction worth having. Experience per hour is very nearly the kill
 * rate — the game pays it per kill, not per drop — so an XP rate that lands
 * where the sim said while the gold rate does not means the sim is killing
 * things at the right speed and the gap lives entirely in what those kills are
 * worth: drop tables, or the prices the drops are valued at. Both rates off the
 * same way is the other finding: the sim is wrong about the fight.
 *
 * Both medians are taken over the SAME pairs. A gold median pooled over every
 * record and an XP median over the subset that carries XP are two different
 * samples, and comparing them would let a difference in which runs were
 * measured masquerade as a difference between XP and gold.
 *
 * @param {Array<Object>} records - `{predicted, actual, predictedXpPerHour, actualXpPerHour}` pairs
 * @param {Object} [options] - Rules
 * @param {number} [options.minSamples] - Pairs needed before the split is called
 * @param {number} [options.gapPercent] - How large a median gap has to be to count as off
 * @returns {{rated: number, withoutXp: number, xpDeviation: number|null, goldDeviation: number|null,
 *   verdict: string, text: string, detail: string}}
 */
export function xpGoldSplit(records, options = {}) {
    const { minSamples = DEFAULT_MIN_SAMPLES, gapPercent = DEFAULT_GAP_PERCENT } = options;

    const usable = (records || []).filter((r) => r && Number.isFinite(r.predicted) && Number.isFinite(r.actual));
    const paired = [];
    let withoutXp = 0;
    for (const record of usable) {
        const xp = deviationPercent(record.predictedXpPerHour, record.actualXpPerHour);
        // A record written before the XP fields existed, or one whose session
        // reported no experience, is not a zero-XP run — it is a run that
        // cannot answer this question, and it is counted rather than folded in
        if (xp === null) {
            withoutXp += 1;
            continue;
        }
        const gold = deviationPercent(record.predicted, record.actual);
        if (gold === null) continue;
        paired.push({ xp, gold });
    }

    const xpDeviation = median(paired.map((p) => p.xp));
    const goldDeviation = median(paired.map((p) => p.gold));
    const rated = paired.length;
    const numbers = `XP ${pct(xpDeviation)} against gold ${pct(goldDeviation)} over ${rated} paired run${rated === 1 ? '' : 's'}`;

    if (rated < minSamples || xpDeviation === null || goldDeviation === null) {
        return {
            rated,
            withoutXp,
            xpDeviation,
            goldDeviation,
            verdict: 'insufficient',
            text: 'Too few XP pairs to call',
            detail:
                `${rated} of the ${minSamples} paired runs this needs carry an XP rate` +
                (withoutXp ? ` (${withoutXp} recorded without one)` : '') +
                '. Below that a split is one run’s luck wearing a verdict’s clothes.',
        };
    }

    const xpOff = Math.abs(xpDeviation) >= gapPercent;
    const goldOff = Math.abs(goldDeviation) >= gapPercent;
    const sameWay = Math.sign(xpDeviation) === Math.sign(goldDeviation);

    if (!xpOff && goldOff) {
        return {
            rated,
            withoutXp,
            xpDeviation,
            goldDeviation,
            verdict: 'drops_or_prices',
            text: 'Kill rate is right — the gap is drops or prices',
            detail: `${numbers}. Experience is paid per kill, so an XP rate inside ${gapPercent}% says the sim kills at the speed it promised. What those kills are worth is where the coins went missing: the drop table, or the prices the drops are valued at.`,
        };
    }

    if (xpOff && goldOff && sameWay) {
        return {
            rated,
            withoutXp,
            xpDeviation,
            goldDeviation,
            verdict: 'fight_model',
            text: 'The sim mis-models the fight itself',
            detail: `${numbers}. Both rates miss the same way, and XP does not depend on drops or prices — what is left is the fight: kill speed, and therefore the sim’s model of it.`,
        };
    }

    if (xpOff && goldOff) {
        return {
            rated,
            withoutXp,
            xpDeviation,
            goldDeviation,
            verdict: 'opposed',
            text: 'XP and gold miss opposite ways',
            detail: `${numbers}. The kill rate is off in one direction and the coins in the other, so neither explains the other: two errors, not one.`,
        };
    }

    if (xpOff) {
        return {
            rated,
            withoutXp,
            xpDeviation,
            goldDeviation,
            verdict: 'xp_only',
            text: 'XP off, gold on target',
            detail: `${numbers}. The kill rate misses while the coins land, which means the drop value is absorbing a fight the sim gets wrong rather than the fight being right.`,
        };
    }

    return {
        rated,
        withoutXp,
        xpDeviation,
        goldDeviation,
        verdict: 'aligned',
        text: 'Both within noise',
        detail: `${numbers}. Neither rate is off by ${gapPercent}% or more; there is nothing here to explain.`,
    };
}

/**
 * The same comparison a day at a time, so a gap that opened recently can be told
 * from one that has always been there.
 *
 * @param {Array<Object>} records - `{predicted, actual, t}` pairs
 * @param {Object} [options] - Window
 * @param {number} [options.now] - Clock
 * @param {number} [options.days] - How many days back to cover
 * @returns {Array<{day: string, samples: number, predictedMean: number, actualMean: number, deviation: number|null}>}
 *   Oldest first, bucketed by the reader's own calendar day
 */
/**
 * The calendar day a timestamp falls on, in the reader's own timezone.
 *
 * `toISOString().slice(0, 10)` buckets by UTC day, which for anyone west of
 * Greenwich splits an evening's actions across two rows and mislabels both.
 * A day here means the day the user experienced.
 * @param {number} timestamp - Epoch ms
 * @returns {string} `YYYY-MM-DD`
 */
function localDayKey(timestamp) {
    const d = new Date(timestamp);
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${month}-${day}`;
}

export function dailySeries(records, { now = Date.now(), days = 7 } = {}) {
    const cutoff = now - days * 24 * 60 * 60 * 1000;
    const buckets = new Map();

    for (const record of records || []) {
        if (!record || !Number.isFinite(record.predicted) || !Number.isFinite(record.actual)) continue;
        if (!record.t || record.t < cutoff) continue;
        const day = localDayKey(record.t);
        if (!buckets.has(day)) buckets.set(day, []);
        buckets.get(day).push(record);
    }

    return [...buckets.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([day, group]) => {
            const predictedMean = mean(group.map((r) => r.predicted));
            const actualMean = mean(group.map((r) => r.actual));
            return {
                day,
                samples: group.length,
                predictedMean,
                actualMean,
                deviation: median(group.map((r) => deviationPercent(r.predicted, r.actual))),
            };
        });
}
