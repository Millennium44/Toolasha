/**
 * Dungeon pace
 *
 * This run's average wave time against the stored average for the same
 * dungeon, as one signed figure — "am I ahead of myself or behind".
 *
 * The comparison is per wave rather than per run because a run in progress has
 * no duration yet, and projecting one would be a guess stacked on a guess. The
 * wave average is a thing both sides genuinely have: the live run measures its
 * waves directly, and a stored run's duration divided by the dungeon's wave
 * count is its wave average — every saved run finished, or it would not have
 * been saved.
 *
 * Stored runs recorded from chat carry no tier, so the history is matched on
 * dungeon name, and a run whose tier *is* stated only counts when it matches.
 * No history means no chip — a pace against nothing is not a pace.
 */

/** Below this many completed waves the live average is one wave's luck */
export const MIN_WAVES_FOR_PACE = 3;

/**
 * How far a stored run's own avgWaveTime may exceed its duration-derived wave
 * time before it is treated as corrupt and the duration is trusted instead. A
 * real avgWaveTime sits just under duration/maxWaves (the run total also
 * carries inter-wave gaps), never multiples above it — a run recorded while
 * per-wave timing was anchored to the constant run-start clocked every wave as
 * the cumulative elapsed since the run began, leaving avgWaveTime tens of times
 * too large. The run total was always right, so its per-wave figure heals those.
 */
export const STATED_AVG_SANITY_RATIO = 3;

/**
 * A stored run's average wave time.
 *
 * @param {Object} run - A stored run
 * @param {number} maxWaves - The dungeon's wave count, from the live run
 * @returns {number|null} Milliseconds per wave, or null when the run cannot say
 */
export function runAvgWaveMs(run, maxWaves) {
    if (!run) return null;

    const duration = Number(run.duration ?? run.totalTime);
    const fromDuration =
        Number.isFinite(duration) && duration > 0 && Number.isFinite(maxWaves) && maxWaves > 0
            ? duration / maxWaves
            : null;

    const stated = Number(run.avgWaveTime);
    if (Number.isFinite(stated) && stated > 0) {
        // Trust the run total over a stated average that dwarfs it — that
        // average is the corrupt cumulative-timing artefact, not this run.
        if (fromDuration !== null && stated > fromDuration * STATED_AVG_SANITY_RATIO) {
            return fromDuration;
        }
        return stated;
    }

    return fromDuration;
}

/**
 * The stored average wave time for a dungeon.
 *
 * @param {Array<Object>} runs - Stored runs, already narrowed to the character
 * @param {Object} current - The live run's identity
 * @param {string|null} current.dungeonName - Which dungeon
 * @param {number|null} current.tier - Its tier, where known
 * @param {number|null} current.maxWaves - Its wave count
 * @returns {number|null} Milliseconds per wave, or null without usable history
 */
export function historyAvgWaveMs(runs, { dungeonName, tier, maxWaves } = {}) {
    // 'Unknown' is what a run gets when nothing named it, and matching on it
    // would average unrelated dungeons together
    if (!dungeonName || dungeonName === 'Unknown') return null;

    const perWave = [];
    for (const run of runs || []) {
        if (!run || run.dungeonName !== dungeonName) continue;
        if (tier !== null && tier !== undefined && run.tier !== null && run.tier !== undefined && run.tier !== tier) {
            continue;
        }

        const avg = runAvgWaveMs(run, maxWaves);
        if (avg !== null) perWave.push(avg);
    }

    if (!perWave.length) return null;
    return perWave.reduce((sum, value) => sum + value, 0) / perWave.length;
}

/**
 * How far ahead of the stored average this run is.
 *
 * Positive is faster: the sign answers "am I winning", not "is the number
 * bigger", because a *shorter* wave time is the good direction.
 *
 * @param {number|null} currentAvgWaveMs - The live run's wave average
 * @param {number|null} historyMs - From `historyAvgWaveMs`
 * @param {number} wavesCompleted - How many waves back the live average
 * @returns {number|null} Whole percent, or null when either side is missing or
 *   the run is too young to have a pace
 */
export function pacePercent(currentAvgWaveMs, historyMs, wavesCompleted) {
    if (!Number.isFinite(currentAvgWaveMs) || currentAvgWaveMs <= 0) return null;
    if (!Number.isFinite(historyMs) || historyMs <= 0) return null;
    if (!Number.isFinite(wavesCompleted) || wavesCompleted < MIN_WAVES_FOR_PACE) return null;

    return Math.round(((historyMs - currentAvgWaveMs) / historyMs) * 100);
}

/**
 * The chip itself.
 *
 * @param {number|null} percent - From `pacePercent`
 * @returns {{text: string, tone: 'good'|'bad'|'dim'}|null} Null renders nothing
 */
export function paceChip(percent) {
    if (percent === null || percent === undefined) return null;

    if (percent > 0) return { text: `pace +${percent}% vs your avg`, tone: 'good' };
    if (percent < 0) return { text: `pace −${Math.abs(percent)}% vs your avg`, tone: 'bad' };
    return { text: 'pace even with your avg', tone: 'dim' };
}
