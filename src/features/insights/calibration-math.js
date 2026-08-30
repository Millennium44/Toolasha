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
 * The median split by whether the pair's gear matched the forecast's.
 *
 * The combat card already counts how many pairs were played in gear the sim
 * never saw — and then pools them into one median anyway, which is the whole
 * problem. A sim that is right about the loadout it simulated and measured
 * against a different one reads exactly like a sim that is wrong. Splitting the
 * median by that flag is what tells those apart, and the split only speaks when
 * both cohorts are large enough to.
 *
 * `null` gear-match is its own bucket rather than being folded into either.
 * "We could not tell whether the gear matched" is not "the gear differed", and
 * a pair recorded before the flag existed must not be made to testify.
 *
 * @param {Array<Object>} records - Combat pairs carrying `fingerprintMatch`
 * @param {Object} [options] - Rules
 * @param {number} [options.minSamples] - Pairs needed *per cohort* before the split is called
 * @param {number} [options.gapPercent] - How large a median gap has to be to count as off
 * @returns {{matched: Object, mismatched: Object, unsigned: Object, verdict: string,
 *   figures: string, text: string, detail: string}}
 */
export function cohortSplit(records, options = {}) {
    const { minSamples = DEFAULT_MIN_SAMPLES, gapPercent = DEFAULT_GAP_PERCENT } = options;

    /**
     * One cohort's median, over the pairs that have a deviation at all.
     * @param {Array<Object>} group - Records in the cohort
     * @returns {{rated: number, medianDeviation: number|null}}
     */
    const cohort = (group) => {
        const deviations = group.map((r) => deviationPercent(r.predicted, r.actual)).filter((d) => d !== null);
        return { rated: deviations.length, medianDeviation: median(deviations) };
    };

    const usable = (records || []).filter((r) => r);
    const matched = cohort(usable.filter((r) => r.fingerprintMatch === true));
    const mismatched = cohort(usable.filter((r) => r.fingerprintMatch === false));
    const unsigned = cohort(usable.filter((r) => r.fingerprintMatch !== true && r.fingerprintMatch !== false));

    const figures = `matched ${pct(matched.medianDeviation)} (${matched.rated}) · mismatched ${pct(mismatched.medianDeviation)} (${mismatched.rated})`;
    const result = { matched, mismatched, unsigned, figures };

    if (matched.rated < minSamples || mismatched.rated < minSamples) {
        const thin =
            matched.rated < minSamples && mismatched.rated < minSamples
                ? 'neither cohort'
                : matched.rated < minSamples
                  ? 'the matched-gear cohort'
                  : 'the different-gear cohort';
        return {
            ...result,
            verdict: 'insufficient',
            text: 'Too few per cohort to call',
            detail: `${figures}. ${minSamples} pairs are needed on each side and ${thin} has that many, so the pooled median stands unexplained rather than being split on a handful of runs.`,
        };
    }

    const matchedOff = Math.abs(matched.medianDeviation) >= gapPercent;
    const mismatchedOff = Math.abs(mismatched.medianDeviation) >= gapPercent;
    const separation = Math.abs(matched.medianDeviation - mismatched.medianDeviation);

    if (!matchedOff && mismatchedOff) {
        return {
            ...result,
            verdict: 'mismatch_explains',
            text: 'the sim is right — the gap is the gear it never saw',
            detail: 'Pairs played in the loadout the sim simulated land inside the band; the ones played in different gear are what drag the pooled median. Re-run the sim on your current gear before reading anything into the pooled figure.',
        };
    }

    if (matchedOff && !mismatchedOff) {
        return {
            ...result,
            verdict: 'matched_off',
            text: 'the sim misses on the gear it simulated',
            detail: 'The cohort the sim actually simulated is the one that misses, while the different-gear pairs land inside the band. The gear mismatch is not the explanation — the forecast is.',
        };
    }

    if (matchedOff && mismatchedOff && separation < gapPercent) {
        return {
            ...result,
            verdict: 'sim_off',
            text: 'both cohorts miss alike — not the gear',
            detail: `Matched and mismatched pairs are off by within ${gapPercent}% of each other, so the gear the pairs were played in does not sort them. Whatever is wrong is wrong for both.`,
        };
    }

    if (!matchedOff && !mismatchedOff) {
        return {
            ...result,
            verdict: 'both_clean',
            text: 'neither cohort is off',
            detail: 'Both sides land inside the band, so there is no pooled gap for the gear flag to explain.',
        };
    }

    return {
        ...result,
        verdict: 'split',
        text: 'the cohorts disagree, and not about the gear',
        detail: `Both cohorts are off by ${gapPercent}% or more but ${separation.toFixed(1)} points apart, and not in a way that names one cause. Two findings, not one.`,
    };
}

/**
 * One skill's median, broken out by the action that earned it.
 *
 * A skill group pools every action under it, and a skill is not a thing the
 * calculator has an opinion about — actions are. Milking is six animals with six
 * drop tables and six prices, so a group median of -20% can mean "every cow is
 * off by a fifth" or "five are exact and one is catastrophic", and those are
 * different bugs with different fixes. The records have carried `actionHrid`
 * since the first pair was written; only `actionType` was ever read.
 *
 * Each action is gated on its own count, not the group's. An action with three
 * runs inside a group of forty is still three runs, and the whole reason the
 * group median is trustworthy — enough runs agreeing — is exactly what that
 * action does not have.
 *
 * @param {Array<Object>} records - Records for ONE group, carrying `actionHrid`
 * @param {Object} [options] - Rules
 * @param {number} [options.minSamples] - Runs needed *per action* before its figure is shown
 * @param {number} [options.gapPercent] - How large a median gap has to be to count as off
 * @returns {{actions: Array<Object>, decided: number, thin: number, unattributed: number}}
 *   Actions worst first, the refused ones after them
 */
export function actionSplit(records, options = {}) {
    const { minSamples = DEFAULT_MIN_SAMPLES, gapPercent = DEFAULT_GAP_PERCENT } = options;

    const byAction = new Map();
    let unattributed = 0;
    for (const record of records || []) {
        if (!record) continue;
        // A pair with no action recorded cannot be attributed to one. Counted
        // rather than swept into an "unknown" row that would then be read as a
        // real action with a real verdict.
        if (!record.actionHrid) {
            unattributed += 1;
            continue;
        }
        if (!byAction.has(record.actionHrid)) byAction.set(record.actionHrid, []);
        byAction.get(record.actionHrid).push(record);
    }

    const actions = [...byAction.entries()].map(([actionHrid, group]) => {
        const deviations = group.map((r) => deviationPercent(r.predicted, r.actual)).filter((d) => d !== null);
        const rated = deviations.length;
        const decided = rated >= minSamples;
        // Below the bar the figure is withheld rather than shown greyed out: a
        // number on screen is read as a finding whatever colour it is drawn in
        const medianDeviation = decided ? median(deviations) : null;
        return {
            actionHrid,
            samples: group.length,
            rated,
            decided,
            medianDeviation,
            flagged: decided && medianDeviation !== null && Math.abs(medianDeviation) >= gapPercent,
            text: decided ? pct(medianDeviation) : 'too few to call',
            lastAt: group.reduce((latest, r) => (r.t > latest ? r.t : latest), 0),
        };
    });

    // Decided actions first, worst gap at the top; the refused ones keep their
    // place below in run order so a thin action that is filling up is visible
    actions.sort((a, b) => {
        if (a.decided !== b.decided) return a.decided ? -1 : 1;
        if (a.decided) return Math.abs(b.medianDeviation ?? 0) - Math.abs(a.medianDeviation ?? 0);
        return b.rated - a.rated;
    });

    return {
        actions,
        decided: actions.filter((action) => action.decided).length,
        thin: actions.filter((action) => !action.decided).length,
        unattributed,
    };
}

/**
 * How much of a group's measured profit was only ever available at the ask.
 *
 * Every pair records the same run priced twice: `actual` values the loot at the
 * ask, which is what it fetches if somebody eventually buys your listing, and
 * `actualBid` at the bid, which is what it fetches right now. The forecasts, and
 * therefore every deviation in this panel, are the ask figure. That is a
 * defensible default and an invisible assumption: a skill whose output is thinly
 * traded can be quoted at a rate that is real only for a player willing to sit
 * in the order book for a week, and nothing on the panel says so.
 *
 * The gap is expressed as a share of the ask-priced figure, because that is the
 * number the reader is being shown everywhere else — "a fifth of this is
 * spread" is actionable in a way that "1.2M/h of spread" is not.
 *
 * Pairs recorded before `actualBid` existed carry none, and are counted rather
 * than read as a zero spread — no gap and no measurement are not the same claim.
 *
 * @param {Array<Object>} records - Pairs carrying `actual` and `actualBid`
 * @param {Object} [options] - Rules
 * @param {number} [options.minSamples] - Pairs needed before the share is called
 * @returns {{rated: number, withoutBid: number, askShare: number|null, verdict: string,
 *   text: string, detail: string}}
 */
export function bidSpread(records, options = {}) {
    const { minSamples = DEFAULT_MIN_SAMPLES } = options;

    const shares = [];
    let withoutBid = 0;
    for (const record of records || []) {
        if (!record || !Number.isFinite(record.actual)) continue;
        if (!Number.isFinite(record.actualBid)) {
            withoutBid += 1;
            continue;
        }
        // Same guard as `deviationPercent`: a run that netted nothing has no
        // scale for a share to be a share of
        if (Math.abs(record.actual) < 1) continue;
        shares.push(((record.actual - record.actualBid) / Math.abs(record.actual)) * 100);
    }

    const askShare = median(shares);
    const rated = shares.length;

    if (rated < minSamples || askShare === null) {
        return {
            rated,
            withoutBid,
            askShare,
            verdict: 'insufficient',
            text: 'Too few bid-priced runs to call',
            detail:
                `${rated} of the ${minSamples} runs this needs carry a bid-priced figure` +
                (withoutBid ? ` (${withoutBid} recorded without one)` : '') +
                '. Below that the spread is one run’s order book, not this skill’s.',
        };
    }

    const rounded = Math.round(Math.abs(askShare));
    const sentence =
        askShare >= 0
            ? `${rounded}% of this forecast depends on selling into the ask`
            : `${rounded}% more than the forecast if sold at the bid`;

    return {
        rated,
        withoutBid,
        askShare,
        verdict: askShare >= 0 ? 'ask_dependent' : 'bid_favoured',
        text: sentence,
        detail:
            `Median over ${rated} run${rated === 1 ? '' : 's'}${withoutBid ? ` (${withoutBid} without a bid figure)` : ''}. ` +
            'The same loot valued twice: at the ask, which is what a listing eventually fetches, ' +
            'and at the bid, which is what it fetches this second. Everything else on this panel is ' +
            'the ask figure, so this share is the part of it you only collect by waiting for a buyer.',
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
