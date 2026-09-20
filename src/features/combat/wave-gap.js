/**
 * Wave gap — what actually happens between one wave dying and the next arriving.
 *
 * The simulator advances its clock by a single constant between waves. That
 * constant was most recently changed from a flat 3.000 s to 3.0369 s, and the
 * new number came from somebody else's published mean, applied to the open-zone
 * respawn as well as the dungeon wave transition on the argument that a server
 * clock runs wherever the fight is. Neither half of that has ever been checked
 * here. This module is the arithmetic for checking it;
 * {@link ./wave-gap-observer.js} is the half that watches the wire.
 *
 * ## Three categories, kept apart
 *
 * An open-zone respawn and a dungeon wave transition are different events in
 * the client even if they turn out to be the same number on the server, so they
 * are never pooled. The dungeon *boundary* — the last wave of a run to the
 * first wave of the next — is the third, because it is the one people assume is
 * special and our own earlier count of a completion-to-completion cycle says it
 * is not. Pooling them would hide exactly the disagreement worth finding.
 *
 * ## What the measurement is made of, and what that costs
 *
 * The interval measured is: the arrival of the first tick reporting every
 * monster in the wave at zero hitpoints, to the arrival of the `new_battle`
 * that opens the next wave. Both endpoints are client arrival timestamps, so
 * the figure carries two ticks' worth of network jitter.
 *
 * That matters more than usual here. The structure being looked for spans about
 * 67 ms end to end. If the jitter is wider than that, a tidy-looking table of
 * per-bin means would be a table of noise, and printing one would be worse than
 * printing nothing.
 *
 * So the jitter is measured rather than assumed, from a signal the server
 * supplies: each player delta carries `int`, the server's own nanosecond delay
 * from that action to that player's next one. Pair two consecutive actions by
 * the same player and the residual — arrival delta minus the server's stated
 * interval — is a direct sample of the same two-timestamp noise the gap
 * measurement carries. It does not measure the respawn (it describes action
 * scheduling, which is a different thing), but it calibrates the ruler, and the
 * panel reports the calibration next to the reading so a number can be read as
 * the evidence it is rather than the evidence it looks like.
 *
 * ## Why a wipe is not a wave gap
 *
 * When the party dies the wave does not clear; the fight restarts, which is a
 * different mechanism with its own timing. A restart counted as a respawn would
 * drag the mean toward whatever that other number is. So an episode qualifies
 * only if every monster was seen at zero hitpoints — a wipe never reaches that
 * state, and is counted as a discard rather than quietly dropped.
 */

/** The three things being told apart */
export const CATEGORIES = {
    openZone: 'openZone',
    dungeonWave: 'dungeonWave',
    dungeonBoundary: 'dungeonBoundary',
};

/** Human labels for the categories, in the order the panel shows them */
export const CATEGORY_LABELS = [
    [CATEGORIES.openZone, 'Open-zone respawn'],
    [CATEGORIES.dungeonWave, 'Dungeon wave to wave'],
    [CATEGORIES.dungeonBoundary, 'Dungeon run boundary'],
];

/** Why an observation was thrown away, with the label the panel prints */
export const DISCARDS = {
    wipe: 'Wave never cleared (wipe or walked away)',
    noRoster: 'Joined the wave already in progress',
    zoneChanged: 'Zone or mode changed across the transition',
    waveUnknown: 'Dungeon wave number missing',
    streamHole: 'Tick stream stalled somewhere in the wave',
    hidden: 'Tab was in the background',
    outOfRange: 'Interval implausible for a respawn',
};

/** Below this, something other than a respawn happened */
const MIN_GAP_MS = 500;

/** Above this, likewise */
const MAX_GAP_MS = 15_000;

/**
 * How far a tick may land from where the server said it would before this wave
 * is treated as having been timed by a stopped clock.
 *
 * A quiet stretch is not by itself a hole — ticks arrive only when something
 * changes, and a slow weapon is several seconds between them — so tick spacing
 * cannot tell a calm fight from a stalled client. The server's own stated
 * interval can: when a player's next action arrives far from when the server
 * said it would, the arrival timestamps in that wave are not measuring what
 * they claim to, and the gap taken from them is measured off the wrong instant.
 */
const STALL_MS = 300;

/** Histogram resolution. Fine enough to show a 67 ms spread as several bars */
export const HISTOGRAM_BIN_MS = 10;

/** Raw observations kept per category, for percentiles and cycle binning */
const MAX_ROWS = 1500;

/** Jitter residuals kept, for a median and a MAD */
const MAX_JITTER_ROWS = 800;

/** A residual further out than this is a different fight event, not jitter */
const JITTER_CLAMP_MS = 2000;

/** Cycle lengths the phase analysis tries. 120 s is the claim, not the premise */
export const CYCLE_CANDIDATES = [30_000, 60_000, 120_000, 240_000];

/** Bins a cycle is cut into */
export const CYCLE_BINS = 12;

/** Below this an interval estimate is not worth printing */
export const MIN_OBSERVATIONS = 20;

/** Per bin, below this the cycle analysis cannot say anything at all */
export const MIN_PER_BIN = 5;

/** MAD to standard deviation, for a normal */
const MAD_TO_SD = 1.4826;

/** Two-sided 95% normal quantile */
const Z95 = 1.96;

/**
 * Roughly the multiplier on a standard error that a difference has to clear to
 * be detectable at 5% with 80% power. Used to state what this sample *cannot*
 * see, which is the more useful half of a measurement this marginal.
 */
const MDD_Z = 2.8;

/**
 * An empty tally, which is also the shape stored.
 * @returns {Object} Tally
 */
export function emptyTally() {
    const categories = {};
    for (const key of Object.values(CATEGORIES)) categories[key] = emptyCategory();
    const discards = {};
    for (const key of Object.keys(DISCARDS)) discards[key] = 0;
    return { version: 1, categories, discards, jitter: { rows: [], seen: 0 }, updatedAt: 0 };
}

/**
 * One category's accumulator.
 * @returns {Object} Category
 */
function emptyCategory() {
    return { n: 0, sum: 0, sumSq: 0, min: null, max: null, hist: {}, rows: [] };
}

/**
 * Fold one observation into the tally.
 * @param {Object} tally - Tally, mutated
 * @param {{category: string, gapMs: number, deathAt: number}} observation - What the watch emitted
 * @returns {void}
 */
export function foldObservation(tally, observation) {
    const bucket = tally.categories?.[observation.category];
    if (!bucket) return;
    const gap = observation.gapMs;
    bucket.n += 1;
    bucket.sum += gap;
    bucket.sumSq += gap * gap;
    bucket.min = bucket.min === null ? gap : Math.min(bucket.min, gap);
    bucket.max = bucket.max === null ? gap : Math.max(bucket.max, gap);
    const bin = Math.floor(gap / HISTOGRAM_BIN_MS);
    bucket.hist[bin] = (bucket.hist[bin] || 0) + 1;
    bucket.rows.push({ g: Math.round(gap), t: observation.deathAt });
    if (bucket.rows.length > MAX_ROWS) bucket.rows.splice(0, bucket.rows.length - MAX_ROWS);
    tally.updatedAt = observation.deathAt;
}

/**
 * Count a discard. Which ones were thrown away is part of the result.
 * @param {Object} tally - Tally, mutated
 * @param {string} reason - A key of {@link DISCARDS}
 * @returns {void}
 */
export function foldDiscard(tally, reason) {
    if (!(reason in (tally.discards || {}))) return;
    tally.discards[reason] += 1;
}

/**
 * Fold one server-interval residual — the calibration of the ruler.
 * @param {Object} tally - Tally, mutated
 * @param {number} residualMs - Arrival delta minus the server's stated interval
 * @returns {void}
 */
export function foldJitter(tally, residualMs) {
    if (!Number.isFinite(residualMs)) return;
    const jitter = tally.jitter;
    jitter.seen += 1;
    if (Math.abs(residualMs) > JITTER_CLAMP_MS) return;
    jitter.rows.push(Math.round(residualMs * 10) / 10);
    if (jitter.rows.length > MAX_JITTER_ROWS) jitter.rows.splice(0, jitter.rows.length - MAX_JITTER_ROWS);
}

/**
 * The p-th percentile of an already-sorted array, by nearest rank.
 * @param {Array<number>} sorted - Ascending values
 * @param {number} p - 0..1
 * @returns {number|null} The value, or null when there is nothing to take one of
 */
export function percentile(sorted, p) {
    if (!sorted.length) return null;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
    return sorted[index];
}

/**
 * Median absolute deviation, scaled to a standard deviation.
 *
 * Used for the jitter rather than a plain standard deviation because the
 * residual sample is contaminated by design: a player who is stunned, dead or
 * simply between waves has a next action the server rescheduled, and those pairs
 * sit in tails hundreds of milliseconds wide. A mean would follow them; a median
 * does not.
 *
 * @param {Array<number>} values - Samples
 * @returns {{median: number, mad: number, sd: number}|null} Robust center and scale
 */
export function robustScale(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const median = percentile(sorted, 0.5);
    const deviations = sorted.map((value) => Math.abs(value - median)).sort((a, b) => a - b);
    const mad = percentile(deviations, 0.5);
    return { median, mad, sd: mad * MAD_TO_SD };
}

/**
 * Bin observations by where they fall inside a repeating cycle and ask whether
 * the gap depends on that position.
 *
 * The phase is taken from the client's own clock, which is offset from the
 * server's by an unknown constant. A constant offset rotates every observation
 * by the same amount: it moves which bin a given phase lands in and cannot
 * create or destroy the pattern, so an unaligned phase is fine for detecting
 * structure and useless for naming where in the cycle it sits. The panel says
 * so rather than implying an alignment nobody has.
 *
 * The statistic is a one-way F: between-bin variance over within-bin variance,
 * which is 1-ish when the bins agree. It is reported beside the smallest
 * bin-to-bin difference this many observations could have detected, because
 * with a 67 ms range spread over twelve bins the interesting differences are a
 * few milliseconds and the honest finding is usually that they are invisible.
 *
 * @param {Array<{g: number, t: number}>} rows - Observations
 * @param {number} cycleMs - Cycle length to test
 * @returns {Object} Bins, F, and what the sample could and could not have seen
 */
export function cycleAnalysis(rows, cycleMs) {
    const width = cycleMs / CYCLE_BINS;
    const bins = [];
    for (let index = 0; index < CYCLE_BINS; index += 1) bins.push({ index, values: [] });

    for (const row of rows) {
        const phase = ((row.t % cycleMs) + cycleMs) % cycleMs;
        const index = Math.min(CYCLE_BINS - 1, Math.floor(phase / width));
        bins[index].values.push(row.g);
    }

    const used = bins.filter((bin) => bin.values.length >= 2);
    const summary = bins.map((bin) => ({
        index: bin.index,
        fromMs: Math.round(bin.index * width),
        toMs: Math.round((bin.index + 1) * width),
        n: bin.values.length,
        mean: bin.values.length ? bin.values.reduce((a, b) => a + b, 0) / bin.values.length : null,
    }));

    const total = used.reduce((sum, bin) => sum + bin.values.length, 0);
    if (used.length < 2 || total - used.length < 1) {
        return { cycleMs, bins: summary, f: null, withinSd: null, spread: null, detectableMs: null, resolved: false };
    }

    const grand = used.reduce((sum, bin) => sum + bin.values.reduce((a, b) => a + b, 0), 0) / total;
    let ssBetween = 0;
    let ssWithin = 0;
    for (const bin of used) {
        const mean = bin.values.reduce((a, b) => a + b, 0) / bin.values.length;
        ssBetween += bin.values.length * (mean - grand) ** 2;
        for (const value of bin.values) ssWithin += (value - mean) ** 2;
    }
    const dfBetween = used.length - 1;
    const dfWithin = total - used.length;
    const msWithin = ssWithin / dfWithin;
    const f = msWithin > 0 ? ssBetween / dfBetween / msWithin : null;

    const means = summary.filter((bin) => bin.n >= MIN_PER_BIN).map((bin) => bin.mean);
    const spread = means.length >= 2 ? Math.max(...means) - Math.min(...means) : null;

    // The difference between two bins this sample could have caught, at the
    // smallest bin count that still counts as populated
    const smallest = Math.min(...used.map((bin) => bin.values.length));
    const detectableMs = MDD_Z * Math.sqrt(msWithin) * Math.sqrt(2 / smallest);
    const resolved = summary.filter((bin) => bin.n >= MIN_PER_BIN).length >= CYCLE_BINS / 2;

    return { cycleMs, bins: summary, f, withinSd: Math.sqrt(msWithin), spread, detectableMs, resolved };
}

/**
 * One category read as an answer.
 * @param {Object} bucket - A category accumulator
 * @returns {Object} Summary
 */
function summarizeCategory(bucket) {
    const n = bucket.n;
    if (!n) {
        return { n: 0, mean: null, sd: null, sem: null, low: null, high: null, percentiles: {}, histogram: [] };
    }
    const mean = bucket.sum / n;
    const variance = n > 1 ? Math.max(0, (bucket.sumSq - (bucket.sum * bucket.sum) / n) / (n - 1)) : 0;
    const sd = Math.sqrt(variance);
    const sem = n > 1 ? sd / Math.sqrt(n) : null;

    const sorted = bucket.rows.map((row) => row.g).sort((a, b) => a - b);
    const percentiles = {
        p5: percentile(sorted, 0.05),
        p25: percentile(sorted, 0.25),
        p50: percentile(sorted, 0.5),
        p75: percentile(sorted, 0.75),
        p95: percentile(sorted, 0.95),
    };

    const keys = Object.keys(bucket.hist)
        .map(Number)
        .sort((a, b) => a - b);
    const histogram = keys.map((bin) => ({
        fromMs: bin * HISTOGRAM_BIN_MS,
        toMs: (bin + 1) * HISTOGRAM_BIN_MS,
        count: bucket.hist[bin],
    }));

    return {
        n,
        mean,
        sd,
        sem,
        low: sem === null ? null : mean - Z95 * sem,
        high: sem === null ? null : mean + Z95 * sem,
        min: bucket.min,
        max: bucket.max,
        percentiles,
        histogram,
        rows: bucket.rows,
    };
}

/**
 * Whether two category means can be told apart, which is the whole of the
 * "should the simulator share one constant between them" question.
 * @param {Object} a - A summary
 * @param {Object} b - Another
 * @returns {Object|null} The difference, its interval and a verdict
 */
export function compareCategories(a, b) {
    if (!a?.sem || !b?.sem) return null;
    const difference = a.mean - b.mean;
    const sem = Math.sqrt(a.sem * a.sem + b.sem * b.sem);
    const low = difference - Z95 * sem;
    const high = difference + Z95 * sem;
    const enough = a.n >= MIN_OBSERVATIONS && b.n >= MIN_OBSERVATIONS;
    let verdict;
    if (!enough) verdict = 'Not enough observations on both sides to compare yet.';
    else if (low > 0 || high < 0) verdict = 'They differ — one constant for both is wrong.';
    else verdict = `No difference detected; anything larger than ±${Math.round(Z95 * sem)} ms would have shown.`;
    return { difference, low, high, sem, verdict, enough };
}

/**
 * The tally read as an answer.
 * @param {Object} tally - The stored tally
 * @param {Object} [options] - Overrides
 * @param {Array<number>} [options.cycleCandidates] - Cycle lengths to test
 * @returns {Object} Everything the panel prints
 */
export function summarize(tally, options = {}) {
    const candidates = options.cycleCandidates || CYCLE_CANDIDATES;
    const categories = {};
    for (const key of Object.values(CATEGORIES)) {
        categories[key] = summarizeCategory(tally.categories?.[key] || emptyCategory());
    }

    const jitterRows = tally.jitter?.rows || [];
    const scale = robustScale(jitterRows);
    const jitter = {
        n: jitterRows.length,
        seen: tally.jitter?.seen || 0,
        median: scale?.median ?? null,
        sd: scale?.sd ?? null,
    };

    // Cycle structure is asked of whichever category has the most to say; the
    // others do not have the counts and pooling them would mix two processes
    const richest = Object.entries(categories).reduce(
        (best, entry) => (entry[1].n > (best?.[1]?.n || 0) ? entry : best),
        null
    );
    const cycles = richest && richest[1].rows?.length ? candidates.map((ms) => cycleAnalysis(richest[1].rows, ms)) : [];

    const discards = Object.entries(DISCARDS).map(([key, label]) => ({
        key,
        label,
        count: tally.discards?.[key] || 0,
    }));

    return {
        categories,
        jitter,
        cycleSubject: richest && richest[1].n ? richest[0] : null,
        cycles,
        discards,
        discarded: discards.reduce((sum, row) => sum + row.count, 0),
        openVsDungeon: compareCategories(categories[CATEGORIES.openZone], categories[CATEGORIES.dungeonWave]),
        boundaryVsWave: compareCategories(categories[CATEGORIES.dungeonBoundary], categories[CATEGORIES.dungeonWave]),
        updatedAt: tally.updatedAt || 0,
        verdict: verdictFor(categories, jitter),
    };
}

/**
 * The headline, phrased so it cannot be read as more than it is.
 * @param {Object} categories - Summaries by category
 * @param {Object} jitter - The calibration
 * @returns {{text: string}} Verdict
 */
function verdictFor(categories, jitter) {
    const counted = Object.values(categories).reduce((sum, category) => sum + category.n, 0);
    if (!counted) return { text: 'Nothing measured yet — fight a zone or a dungeon with this switched on.' };

    const ruler = jitter.sd === null ? 'unmeasured' : `${jitter.sd.toFixed(0)} ms`;
    const best = Object.values(categories).reduce((a, b) => (b.n > a.n ? b : a));
    if (best.n < MIN_OBSERVATIONS) {
        return {
            text:
                `${counted} observation${counted === 1 ? '' : 's'} so far; ${MIN_OBSERVATIONS} in a category ` +
                `before a mean is worth quoting. Tick-arrival noise measured at ${ruler}.`,
        };
    }
    const band = best.sem === null ? '—' : `±${(Z95 * best.sem).toFixed(0)} ms`;
    return {
        text:
            `Measured against a ruler whose own noise is about ${ruler} per reading, so the mean is good to ` +
            `${band} and a single observation is not evidence of anything. The distribution below is the finding, ` +
            'not the mean.',
    };
}

/**
 * The ruler, on its own so more than one measurement can be read against it.
 *
 * Every player delta carries `int`, the server's own nanosecond delay from that
 * action to that player's next one. Pair two consecutive actions by the same
 * player and the residual — arrival delta minus the stated interval — is a
 * direct sample of the two-timestamp noise any arrival-timed measurement here
 * carries. It says nothing about respawns or tick periods; it calibrates the
 * ruler they are all measured with, which is why it lives apart from the wave
 * gap's own state machine rather than inside it.
 *
 * @returns {{residualsFor: Function, reset: Function}} A calibration
 */
export function createArrivalCalibration() {
    /** Last recorded action per player slot */
    const actions = new Map();

    return {
        /**
         * Residuals this tick supplies, if any.
         * @param {Object} pMap - A tick's `pMap`
         * @param {number} at - Arrival time
         * @returns {Array<number>} Residuals in milliseconds
         */
        residualsFor(pMap, at) {
            const out = [];
            for (const [slot, unit] of Object.entries(pMap || {})) {
                const interval = Number(unit?.int);
                const counter = Number(unit?.atkCounter);
                if (!Number.isFinite(interval) || !Number.isFinite(counter)) continue;
                const last = actions.get(slot);
                if (last && counter <= last.counter) continue;
                // Only a pair of the same player's own consecutive actions says
                // anything: the server's stated delay runs from one to the next,
                // and a delta sent for some other reason is not the next one
                if (last) out.push(at - last.at - last.interval / 1e6);
                actions.set(slot, { at, counter, interval });
            }
            return out;
        },

        /** Forget the pairing state — a new fight is a new set of schedules. @returns {void} */
        reset() {
            actions.clear();
        },
    };
}

/**
 * The live half's state machine, kept here so it can be driven by a synthetic
 * tick sequence in a test rather than by playing the game.
 *
 * @returns {Object} A watch
 */
export function createWaveGapWatch() {
    let current = null;
    let previous = null;
    const out = [];
    const discards = [];
    const calibration = createArrivalCalibration();

    /**
     * Close the wave that just ended against the wave that just started.
     * @param {number} at - Arrival of the `new_battle`
     * @param {Object} context - The new wave's zone context
     * @returns {void}
     */
    function close(at, context) {
        if (!previous) return;
        const prev = previous;
        previous = null;

        if (!prev.sawRoster) return discards.push('noRoster');
        if (prev.hidden || context.hidden) return discards.push('hidden');
        if (prev.deadAt === null) return discards.push('wipe');
        if (prev.zoneKey !== context.zoneKey || prev.isDungeon !== context.isDungeon) {
            return discards.push('zoneChanged');
        }
        if (prev.maxResidual > STALL_MS) return discards.push('streamHole');

        const gapMs = at - prev.deadAt;
        if (!(gapMs >= MIN_GAP_MS && gapMs <= MAX_GAP_MS)) return discards.push('outOfRange');

        let category;
        if (!context.isDungeon) {
            category = CATEGORIES.openZone;
        } else if (!prev.wave || !context.wave) {
            return discards.push('waveUnknown');
        } else if (context.wave > prev.wave) {
            category = CATEGORIES.dungeonWave;
        } else {
            category = CATEGORIES.dungeonBoundary;
        }

        return out.push({ category, gapMs, deathAt: prev.deadAt, waveFrom: prev.wave, waveTo: context.wave });
    }

    return {
        /**
         * A wave started.
         * @param {Object} data - `new_battle` payload
         * @param {number} at - Arrival time
         * @param {Object} context - `{zoneKey, isDungeon, wave, hidden}` from the observer
         * @returns {void}
         */
        newBattle(data, at, context = {}) {
            close(at, context);
            calibration.reset();

            const monsters = data?.monsters;
            const slots = Array.isArray(monsters)
                ? monsters.map((_, index) => String(index))
                : Object.keys(monsters || {});

            current = {
                zoneKey: context.zoneKey ?? null,
                isDungeon: context.isDungeon === true,
                wave: Number(context.wave) || 0,
                alive: new Set(slots),
                sawRoster: slots.length > 0,
                deadAt: null,
                maxResidual: 0,
                hidden: context.hidden === true,
            };
            previous = current;
        },

        /**
         * A tick landed.
         * @param {Object} data - `battle_updated` payload
         * @param {number} at - Arrival time
         * @param {Object} [context] - `{hidden}`
         * @returns {void}
         */
        battleUpdated(data, at, context = {}) {
            if (!current) return;
            if (context.hidden === true) current.hidden = true;

            for (const residual of calibration.residualsFor(data?.pMap, at)) {
                foldPair(out, residual);
                current.maxResidual = Math.max(current.maxResidual, Math.abs(residual));
            }

            for (const [slot, unit] of Object.entries(data?.mMap || {})) {
                if (Number(unit?.cHP) === 0) current.alive.delete(slot);
            }

            if (current.deadAt === null && current.sawRoster && current.alive.size === 0) current.deadAt = at;
        },

        /**
         * Everything finished since the last call.
         * @returns {{observations: Array<Object>, discards: Array<string>, jitter: Array<number>}} Results
         */
        drain() {
            const observations = out.filter((entry) => !entry.jitter);
            const jitter = out.filter((entry) => entry.jitter).map((entry) => entry.residual);
            const reasons = discards.slice();
            out.length = 0;
            discards.length = 0;
            return { observations, discards: reasons, jitter };
        },

        /** @returns {boolean} Whether a wave is being watched right now */
        watching() {
            return current !== null;
        },
    };
}

/**
 * Park a jitter residual on the same out-queue the observations use, so the
 * observer drains one thing.
 * @param {Array<Object>} out - Queue
 * @param {number} residual - Milliseconds
 * @returns {void}
 */
function foldPair(out, residual) {
    if (Number.isFinite(residual)) out.push({ jitter: true, residual });
}
