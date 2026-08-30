/**
 * Alchemy success-rate calibration
 *
 * The rankings quote an alchemy action's profit off a predicted success rate,
 * and that rate is the whole forecast: halve it and the profit halves with it.
 * The three trackers have counted every attempt and every success for as long as
 * the account has existed, so the observed rate has always been sitting there —
 * against nothing to compare it to. `alchemy-success-stamp.js` writes the
 * prediction onto the session as it starts; this reads the two back together.
 *
 * ## Why these do not go through `predictionCalibration.addRecord()`
 *
 * The shared ledger's contract is a pair of *rates* — `{predicted, actual}` in
 * coins per hour, reduced by `deviationPercent` to a signed percentage and
 * pooled into a median per skill. An alchemy session is not that. It is a
 * proportion estimated from n Bernoulli trials, and the honest question about it
 * is not "how far off was the number" but "is the observed rate further from the
 * prediction than n trials can explain" — which needs the trial count and an
 * interval, neither of which the record shape carries. Pushing a rate of 0.63
 * into `predicted` would put it through `deviationPercent`'s `< 1` guard (which
 * rejects it outright), and past that it would appear in the panel's overall
 * median, its daily trend and its recent-runs list as a skill quoting "1/h".
 *
 * The panel already has this exact precedent: enhancement runs are read from
 * their own recorder and drawn as percentiles, because a draw from a heavy-
 * tailed distribution has no honest "gap" either. Alchemy joins them, reading
 * the trackers' own sessions directly.
 *
 * ## Why the kinds are never pooled
 *
 * Transmute, decompose and coinify are three different models — a per-item drop
 * table rate, a flat 60% and a flat 70% — sharing only the tea and catalyst
 * terms. Pooling them would let a wrong transmute table hide inside two correct
 * flat rates, which is precisely the failure this is built to catch.
 */

import { wilsonInterval } from '../combat-sim/engine/wilson.js';

/**
 * Attempts a rate needs before the sample can contradict a prediction.
 *
 * Alchemy runs in the hundreds of attempts an hour, so this is a low bar in
 * practice and still high enough that a handful of unlucky failures cannot
 * indict the model.
 */
export const MIN_ATTEMPTS = 50;

/** The three trackers, each judged on its own */
export const ALCHEMY_KINDS = ['transmute', 'decompose', 'coinify'];

/**
 * Whether a session can be judged at all.
 *
 * A session recorded before stamping existed carries no prediction, and there is
 * no honest way to supply one now: the tea, catalyst and level penalty behind
 * the rate it was run at are all gone. It is excluded, and counted so the panel
 * can say how much history is sitting out.
 *
 * @param {Object} session - A tracker session
 * @returns {boolean}
 */
export function isStamped(session) {
    return Boolean(session) && Number.isFinite(session.predictedRate) && session.predictedRate > 0;
}

/**
 * What the sample says about the prediction.
 *
 * "Off" means the observation's own Wilson interval excludes the predicted rate
 * — the sample is saying something the model does not allow for. A small sample
 * says nothing, which is the point.
 *
 * @param {number} successes - Attempts that produced output
 * @param {number} attempts - Attempts made
 * @param {number} predicted - The stamped rate, 0..1
 * @param {Object} [options] - Rules
 * @param {number} [options.minAttempts] - Attempts needed before a verdict is issued
 * @param {Function} [options.interval] - `wilsonInterval`, injected to keep this pure
 * @returns {{observed: number|null, low: number|null, high: number|null, verdict: string}}
 */
export function compareSuccessRate(successes, attempts, predicted, options = {}) {
    const { minAttempts = MIN_ATTEMPTS, interval = wilsonInterval } = options;

    const n = Math.max(0, Math.floor(Number(attempts) || 0));
    const wins = Math.min(Math.max(0, Math.floor(Number(successes) || 0)), n);

    if (n < Math.max(1, minAttempts)) {
        return { observed: n > 0 ? wins / n : null, low: null, high: null, attempts: n, verdict: 'too few attempts' };
    }
    if (!Number.isFinite(predicted)) {
        return { observed: wins / n, low: null, high: null, attempts: n, verdict: 'unstamped' };
    }

    const { low, high } = interval(wins, n);
    const p = Math.min(1, Math.max(0, predicted));
    let verdict = 'consistent';
    if (p < low) verdict = 'sim too low';
    else if (p > high) verdict = 'sim too high';

    return { observed: wins / n, low, high, attempts: n, verdict };
}

/**
 * The verdict as a line to put on a panel.
 * @param {Object} check - From `compareSuccessRate`
 * @returns {string}
 */
export function verdictText(check) {
    if (check.verdict === 'too few attempts') return 'Too few attempts to call';
    if (check.verdict === 'unstamped') return 'No prediction stamped';
    return check.verdict === 'consistent'
        ? 'Consistent'
        : check.verdict === 'sim too high'
          ? 'Sim too high'
          : 'Sim too low';
}

/**
 * What distinguishes one predicted rate from another within a kind.
 *
 * Item and catalyst both move the rate — the catalyst by 15 or 25 percent of it
 * — so two sessions on the same item with different catalysts were predicted
 * different things and cannot share a bucket. Enhancement level rides along
 * because decompose and coinify record it and it changes what the item is.
 *
 * @param {Object} session - A tracker session
 * @returns {string}
 */
export function comboKey(session) {
    const item = session?.inputItemHrid || 'unknown';
    const catalyst = session?.predictedCatalystHrid || 'none';
    const level = session?.enhancementLevel || 0;
    return `${item}|${catalyst}|+${level}`;
}

/**
 * Attempts, successes and the attempt-weighted prediction over a set of sessions.
 *
 * Weighted by attempts because that is what the pooled observation is: a session
 * of a thousand attempts and one of ten do not get an equal say in what was
 * predicted, any more than they do in what happened.
 *
 * @param {Array<Object>} sessions - Stamped sessions
 * @returns {{attempts: number, successes: number, predicted: number|null}}
 */
function pool(sessions) {
    let attempts = 0;
    let successes = 0;
    let weighted = 0;
    for (const session of sessions) {
        const n = Math.max(0, Math.floor(Number(session.totalAttempts) || 0));
        if (n <= 0) continue;
        attempts += n;
        successes += Math.min(Math.max(0, Math.floor(Number(session.totalSuccesses) || 0)), n);
        weighted += session.predictedRate * n;
    }
    return { attempts, successes, predicted: attempts > 0 ? weighted / attempts : null };
}

/**
 * One tracker's sessions, judged whole and then per item/catalyst combo.
 *
 * @param {string} kind - `transmute` | `decompose` | `coinify`
 * @param {Array<Object>} sessions - That tracker's sessions, stamped or not
 * @param {Object} [options] - Rules, passed through to `compareSuccessRate`
 * @returns {Object} A group summary
 */
export function summarizeKind(kind, sessions, options = {}) {
    const all = (sessions || []).filter(Boolean);
    const stamped = all.filter(isStamped);
    const unstamped = all.length - stamped.length;

    const totals = pool(stamped);
    const check = compareSuccessRate(totals.successes, totals.attempts, totals.predicted, options);

    const byCombo = new Map();
    for (const session of stamped) {
        const key = comboKey(session);
        if (!byCombo.has(key)) byCombo.set(key, []);
        byCombo.get(key).push(session);
    }

    const combos = [...byCombo.entries()]
        .map(([key, group]) => {
            const comboTotals = pool(group);
            return {
                key,
                inputItemHrid: group[0].inputItemHrid || null,
                catalystHrid: group[0].predictedCatalystHrid || null,
                enhancementLevel: group[0].enhancementLevel || 0,
                sessions: group.length,
                ...comboTotals,
                ...compareSuccessRate(comboTotals.successes, comboTotals.attempts, comboTotals.predicted, options),
            };
        })
        // Decided combos first, most attempts at the top; a combo that cannot be
        // called yet is listed under them with its count rather than a figure
        .sort((a, b) => {
            const decidedA = a.verdict !== 'too few attempts';
            const decidedB = b.verdict !== 'too few attempts';
            if (decidedA !== decidedB) return decidedA ? -1 : 1;
            return b.attempts - a.attempts;
        });

    return {
        kind,
        sessions: all.length,
        stampedSessions: stamped.length,
        unstamped,
        ...totals,
        ...check,
        text: verdictText(check),
        combos,
    };
}

/**
 * Every kind, each on its own terms and never pooled together.
 *
 * @param {{transmute: Array<Object>, decompose: Array<Object>, coinify: Array<Object>}} sessionsByKind - Sessions
 * @param {Object} [options] - Rules
 * @returns {{kinds: Array<Object>, unstamped: number, attempts: number}}
 */
export function summarizeAlchemyCalibration(sessionsByKind, options = {}) {
    const kinds = ALCHEMY_KINDS.map((kind) => summarizeKind(kind, sessionsByKind?.[kind] || [], options)).filter(
        (group) => group.sessions > 0
    );

    return {
        kinds,
        unstamped: kinds.reduce((sum, group) => sum + group.unstamped, 0),
        attempts: kinds.reduce((sum, group) => sum + group.attempts, 0),
    };
}
