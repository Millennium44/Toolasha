/**
 * Labyrinth replay check
 *
 * The accuracy record already asks whether the sim's clear chance matches how
 * often a room is actually cleared. That is one bit per attempt and it takes
 * hundreds of them to say anything — and when it finally does, it says the rate
 * is wrong without saying why. A room that times out and a room that kills you
 * are both "lost", and the fix for each is the opposite: more damage, or more
 * defence.
 *
 * This decomposes the gap. From a handful of recorded attempts it measures two
 * rates the clear chance hides — how fast you destroyed the monster, and how
 * fast it destroyed you — and compares each against the same rate the sim
 * produces for that monster at that room level. A sim that over-credits your
 * damage shows up as your rate falling short; one that under-models the monster's
 * shows up as its rate running over. Either one, or both, is what pushes the
 * predicted clear chance above what the room delivers.
 *
 * Pure: recorded attempts and a sim result in, a comparison out. The sim itself
 * is run by the clear-rate feature, which owns the simulator and the loadout.
 */

/** Below this many fights a rate is noise, and the verdict says so rather than guessing */
export const MIN_LAB_FIGHTS = 5;

/** The sim's own run-to-run wobble, folded into every margin so a within-noise call stays honest */
const SIM_NOISE_FLOOR_PCT = 2;

/** 95% of a normal sits inside this many standard errors of the mean */
const Z95 = 1.96;

/**
 * The mean of a list of numbers.
 * @param {number[]} values
 * @returns {number}
 */
function mean(values) {
    if (!values.length) return 0;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * The 95% margin on a sample's mean, as a percent of that mean.
 *
 * Null when there are too few points to measure a spread or the mean is zero —
 * both are "cannot say", which the caller must not read as "zero spread".
 *
 * @param {number[]} values
 * @returns {number|null}
 */
export function relMarginPct(values) {
    if (!Array.isArray(values) || values.length < 2) return null;
    const m = mean(values);
    if (!(m > 0)) return null;
    const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
    const stdErr = Math.sqrt(variance) / Math.sqrt(values.length);
    return ((Z95 * stdErr) / m) * 100;
}

/**
 * A sample's margin, widened by the sim's own noise so a comparison against a
 * simulated figure is not called a finding on a difference the sim itself would
 * produce between two runs.
 *
 * @param {number[]} values
 * @returns {number|null}
 */
function widenedMarginPct(values) {
    const base = relMarginPct(values);
    if (base === null) return null;
    return Math.hypot(base, SIM_NOISE_FLOOR_PCT);
}

/**
 * Signed deviation of an observed value from a predicted one, as a percent of
 * the prediction. Positive means observed ran higher than the sim expected.
 *
 * @param {number} observed
 * @param {number} predicted
 * @returns {number|null} Null when the prediction is zero and a ratio is undefined
 */
export function deviationPct(observed, predicted) {
    if (!(predicted > 0)) return null;
    return ((observed - predicted) / predicted) * 100;
}

/**
 * The damage each side dealt over one attempt.
 *
 * A fresh monster always starts at full, so what you dealt is how far its health
 * fell; a cleared room's monster fell all the way whether or not the killing tick
 * was seen. You have no food or drink in the labyrinth, so your health only
 * falls, and what you took is how far yours fell from where the fight began.
 *
 * @param {Object} attempt
 * @returns {{monsterDamage: number, playerTaken: number}}
 */
function exchange(attempt) {
    const monsterDamage = attempt.cleared
        ? attempt.monsterMaxHp
        : Math.max(0, attempt.monsterMaxHp - attempt.monsterHpEnd);
    const playerTaken = Math.max(0, attempt.playerHpStart - attempt.playerHpEnd);
    return { monsterDamage, playerTaken };
}

/**
 * Group recorded attempts by monster and room level, into the rates the replay
 * compares. Groups are returned most-fought first, since that is the one worth
 * spending a sim on.
 *
 * @param {Array<Object>} attempts - From the recorder
 * @returns {Array<Object>} One entry per monster+level fought
 */
export function deriveObserved(attempts) {
    const groups = new Map();

    for (const attempt of attempts || []) {
        const seconds = Number(attempt?.seconds) || 0;
        if (!attempt?.monsterHrid || seconds <= 0 || attempt.outcome === 'unknown') continue;

        const key = `${attempt.monsterHrid}:${attempt.roomLevel}`;
        let group = groups.get(key);
        if (!group) {
            group = {
                monsterHrid: attempt.monsterHrid,
                monsterName: attempt.monsterName || null,
                roomLevel: Math.max(0, Math.floor(Number(attempt.roomLevel) || 0)),
                fights: 0,
                clears: 0,
                totalSeconds: 0,
                totalMonsterDamage: 0,
                totalPlayerTaken: 0,
                dpsSamples: [],
                takenSamples: [],
                secondsSamples: [],
                clearSamples: [],
            };
            groups.set(key, group);
        }

        const { monsterDamage, playerTaken } = exchange(attempt);
        group.fights += 1;
        group.clears += attempt.cleared ? 1 : 0;
        group.totalSeconds += seconds;
        group.totalMonsterDamage += monsterDamage;
        group.totalPlayerTaken += playerTaken;
        group.dpsSamples.push(monsterDamage / seconds);
        group.takenSamples.push(playerTaken / seconds);
        group.secondsSamples.push(seconds);
        group.clearSamples.push(attempt.cleared ? 1 : 0);
    }

    const out = [...groups.values()].map((group) => ({
        ...group,
        dps: group.totalSeconds > 0 ? group.totalMonsterDamage / group.totalSeconds : 0,
        takenPerSecond: group.totalSeconds > 0 ? group.totalPlayerTaken / group.totalSeconds : 0,
        secondsPerFight: group.fights > 0 ? group.totalSeconds / group.fights : 0,
        clearRate: group.fights > 0 ? group.clears / group.fights : 0,
    }));

    out.sort((a, b) => b.fights - a.fights);
    return out;
}

/**
 * The same four rates, read off a labyrinth sim result.
 *
 * `totalDamageDealt` is keyed by the unit that dealt it, so your DTO's hrid is
 * the damage you dealt and the monster's hrid is the damage you took.
 *
 * @param {Object} simResult - From runLabyrinthSimulation
 * @param {Object} keys
 * @param {string} keys.playerHrid - The player DTO's hrid
 * @param {string} keys.monsterHrid - The monster fought
 * @returns {Object|null} Null when the sim produced no time to divide by
 */
export function predictedFromSim(simResult, { playerHrid, monsterHrid } = {}) {
    if (!simResult) return null;
    const simSeconds = (Number(simResult.simulatedTime) || 0) / 1e9;
    if (!(simSeconds > 0)) return null;

    const attempts = Math.max(0, Number(simResult.labyAttemptCount) || 0);
    const wins = Math.max(0, Number(simResult.encounters) || 0);
    const dealt = Number(simResult.totalDamageDealt?.[playerHrid]) || 0;
    const taken = Number(simResult.totalDamageDealt?.[monsterHrid]) || 0;

    return {
        dps: dealt / simSeconds,
        takenPerSecond: taken / simSeconds,
        secondsPerFight: attempts > 0 ? simSeconds / attempts : 0,
        clearRate: attempts > 0 ? wins / attempts : 0,
        attempts,
        wins,
        simSeconds,
    };
}

/**
 * Compare one observed rate against its prediction.
 *
 * @param {string} key - Metric id
 * @param {string} label - How it reads
 * @param {number} observed
 * @param {number} predicted
 * @param {number[]} samples - The per-fight values the observed rate came from
 * @param {number} fights - How many fights back the observed rate
 * @returns {Object}
 */
function compareMetric(key, label, observed, predicted, samples, fights) {
    const marginPct = widenedMarginPct(samples);
    const dev = deviationPct(observed, predicted);

    let verdict;
    if (fights < MIN_LAB_FIGHTS || marginPct === null || dev === null) {
        verdict = 'insufficient';
    } else if (Math.abs(dev) <= marginPct) {
        verdict = 'consistent';
    } else {
        verdict = dev > 0 ? 'above' : 'below';
    }

    return { key, label, observed, predicted, deviationPct: dev, marginPct, verdict };
}

/**
 * Read the four verdicts into one sentence about what the sim is getting wrong.
 *
 * @param {Object} dps - Your-damage metric
 * @param {Object} taken - Monster-damage metric
 * @param {Object} clear - Clear-rate metric
 * @returns {string}
 */
function diagnose(dps, taken, clear) {
    // Both damage metrics err in either direction, and each direction is a
    // different finding. `below` on your damage means the sim credited you more
    // than you delivered; `below` on the monster's means it credited the monster
    // more than it dealt — the sim over-modelled the monster, which is why the
    // observed rate came in under.
    const yourDamage = dps.verdict === 'below' ? 'over' : dps.verdict === 'above' ? 'under' : null;
    const monsterDamage = taken.verdict === 'above' ? 'under' : taken.verdict === 'below' ? 'over' : null;

    if (yourDamage === 'over' && monsterDamage === 'under') {
        return 'Sim over-credits your damage and under-models the monster’s — both push the clear chance too high.';
    }
    if (yourDamage === 'over') {
        return 'Sim over-credits your damage: real fights kill the monster slower, so more of them time out.';
    }
    if (monsterDamage === 'under') {
        return 'Sim under-models the monster’s damage: you take more than predicted, so more attempts end in death.';
    }
    if (monsterDamage === 'over') {
        return (
            'Sim over-models the monster’s damage: it hits softer than predicted, so you survive longer than it ' +
            'expects — the clear rate can still match if you are outmatched either way.'
        );
    }
    if (yourDamage === 'under') {
        return 'Sim under-credits your damage: you kill the monster faster than predicted.';
    }
    if (clear.verdict === 'below') {
        return 'Clear rate runs below prediction but the damage rates line up — the gap is likely CC uptime or variance, not raw damage.';
    }
    if (clear.verdict === 'above') {
        return 'Clear rate runs above prediction but the damage rates line up — likely CC uptime or variance, not raw damage.';
    }
    if (dps.verdict === 'insufficient' || taken.verdict === 'insufficient') {
        return `Not enough fights yet — record at least ${MIN_LAB_FIGHTS} clean attempts for a rate worth reading.`;
    }
    return 'Observed and predicted line up within noise.';
}

/**
 * Compare an observed group against a sim's prediction for the same room.
 *
 * @param {Object} observed - One entry from {@link deriveObserved}
 * @param {Object} predicted - From {@link predictedFromSim}
 * @returns {Object}
 */
export function compareLab(observed, predicted) {
    const dps = compareMetric(
        'dps',
        'Your damage / s',
        observed.dps,
        predicted.dps,
        observed.dpsSamples,
        observed.fights
    );
    const taken = compareMetric(
        'taken',
        'Monster damage / s',
        observed.takenPerSecond,
        predicted.takenPerSecond,
        observed.takenSamples,
        observed.fights
    );
    const clear = compareMetric(
        'clearRate',
        'Clear rate',
        observed.clearRate,
        predicted.clearRate,
        observed.clearSamples,
        observed.fights
    );
    const seconds = compareMetric(
        'secondsPerFight',
        'Fight length',
        observed.secondsPerFight,
        predicted.secondsPerFight,
        observed.secondsSamples,
        observed.fights
    );

    return {
        monsterHrid: observed.monsterHrid,
        monsterName: observed.monsterName || null,
        roomLevel: observed.roomLevel,
        fights: observed.fights,
        clears: observed.clears,
        metrics: [dps, taken, clear, seconds],
        diagnosis: diagnose(dps, taken, clear),
    };
}

export default { deriveObserved, predictedFromSim, compareLab, deviationPct, relMarginPct, MIN_LAB_FIGHTS };
