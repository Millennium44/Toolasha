/**
 * Labyrinth rush-floor verdict
 *
 * "Could the rush floor come down?" is a question three shipped measurements
 * already answer between them, and none of them answers alone:
 *
 * - **How close the losses are.** `nearMissRemainder` in
 *   `labyrinth-replay-check.js` gives the median share of the monster still
 *   standing when a fight ended badly. Losing at 3% means one more cleared
 *   floor's worth of gear flips the room; losing at 60% means the room is not
 *   close and nothing about supplies will make it close.
 * - **Whether the supplies would stretch.** `burnSummary` in
 *   `labyrinth-run-ledger.js` gives what the trusted runs actually spent, and
 *   the torch capacity says what there was to spend. Rushing fewer floors means
 *   entering more rooms, which means burning more torches, so headroom is the
 *   budget the change has to fit inside.
 * - **Whether either figure is still about this character.** The gear
 *   fingerprint (`gearChangedSince` in `labyrinth-sim-cache.js`) decides that.
 *   A near-miss median measured in last month's gear describes last month's
 *   character.
 *
 * The Consumables panel already draws the first two as separate readings a few
 * lines apart, and leaves the reader to combine them. This is the combination,
 * as one sentence:
 *
 *     losses end at 8.0% median (n=14) and runs return 210 torches spare —
 *     lowering the rush floor is supported
 *
 *     losses aren't close — they end at 47% median (n=14), and supply headroom
 *     won't help
 *
 * ## Refusals, and why each one is a refusal rather than a hedge
 *
 * The house style is that a verdict below its minimum is not issued at all, and
 * all three inputs carry a minimum:
 *
 * - **Below the near-miss minimum.** A median of two remainders is a number,
 *   not a reading. `nearMissRemainder` already declines to produce text below
 *   `MIN_LAB_FIGHTS`, and this declines to produce a verdict.
 * - **Across a gear-fingerprint boundary.** This is the refusal that is easiest
 *   to talk yourself out of, because there is *more* data on the other side of
 *   the boundary and it looks like the same kind of data. It is not: fights
 *   fought in different gear were fought by different characters, and pooling
 *   them produces a median that describes nobody. The reason is named in the
 *   text rather than left as silence, because a reader who has just changed
 *   gear should understand that the line went quiet on purpose.
 * - **Under {@link MIN_TRUSTED_RUNS} trusted runs of supply data.** A run first
 *   seen mid-way reports a floor rather than a measurement — `observedUse` sets
 *   this out at length — so the runs that count are few, and three is the point
 *   below which an average is a single run with extra steps.
 *
 * Nothing here decides anything for the player: it says whether the two
 * readings point the same way, and the player moves the setting.
 */

import { nearMissRemainder, MIN_LAB_FIGHTS } from './labyrinth-replay-check.js';
import { burnSummary } from './labyrinth-run-ledger.js';
import { gearChangedSince } from './labyrinth-sim-cache.js';

/**
 * Trusted runs a supply reading needs before an average means anything.
 *
 * Three, not one, and not the ledger's thirty. `burnSummary` already excludes
 * untrusted runs, so this is a floor on genuine measurements — and two of them
 * is a range, not a distribution.
 */
export const MIN_TRUSTED_RUNS = 3;

/**
 * At or under this median remainder, the losses count as close.
 *
 * Fifteen percent of the monster left standing is roughly "one more tier and
 * this room flips". Above it the fights are being lost, not nearly won, and the
 * supply side of the question stops mattering — which is why the "not close"
 * branch does not quote the headroom at all.
 */
export const CLOSE_MEDIAN = 0.15;

/**
 * A remainder as the near-miss reading itself prints one: tenths near the
 * bottom, where 3% and 8% are different decisions, whole percents further out.
 * @param {number} fraction - 0..1
 * @returns {string} e.g. `8.0%`, `47%`
 */
function remainderPercent(fraction) {
    const pct = fraction * 100;
    return `${pct >= 9.95 ? String(Math.round(pct)) : pct.toFixed(1)}%`;
}

/**
 * The distinct gear fingerprints a set of attempts was fought under.
 *
 * Attempts recorded before fingerprinting existed carry none. Those are
 * *unknown*, not *different* — the same abstention `gearChangedSince` makes —
 * so they are not counted as a second cohort and cannot on their own trigger
 * the boundary refusal.
 *
 * @param {Array<Object>} attempts - From the fight recorder
 * @returns {string[]} Distinct fingerprints, unfingerprinted attempts ignored
 */
export function attemptFingerprints(attempts) {
    const seen = new Set();
    for (const attempt of attempts || []) {
        const fingerprint = attempt?.fingerprint;
        if (fingerprint) seen.add(String(fingerprint));
    }
    return [...seen];
}

/**
 * The one line the rush-floor decision gets.
 *
 * @param {Object} input - Everything the verdict reads
 * @param {Array<Object>} input.attempts - Recorded fights, for the near-miss median
 * @param {Array<Object>} input.runs - Ledger runs, for the supply burn
 * @param {number} input.torchCap - The character's torch capacity
 * @param {string|null} [input.currentFingerprint] - The gear worn now, when known
 * @param {boolean} [input.snapshotsReady] - Whether loadout snapshots have landed;
 *   false means there is no current fingerprint worth comparing against
 * @param {Object} [options] - Rules, all injectable for tests
 * @param {number} [options.minLosses] - Usable losses a median needs
 * @param {number} [options.minRuns] - Trusted runs a supply average needs
 * @param {number} [options.closeMedian] - At or under this, the losses are close
 * @returns {{verdict: 'supported'|'not-close'|'no-headroom'|'refused',
 *   reason: string|null, text: string, nearMiss: Object, burn: Object|null,
 *   headroom: number|null}}
 */
export function rushFloorVerdict(
    { attempts, runs, torchCap, currentFingerprint = null, snapshotsReady = true } = {},
    { minLosses = MIN_LAB_FIGHTS, minRuns = MIN_TRUSTED_RUNS, closeMedian = CLOSE_MEDIAN } = {}
) {
    const nearMiss = nearMissRemainder(attempts, minLosses);
    const burn = burnSummary(runs, 'torch');
    const cap = Number(torchCap) || 0;
    const headroom = burn && cap > 0 ? cap - burn.average : null;

    const refuse = (reason, text) => ({ verdict: 'refused', reason, text, nearMiss, burn, headroom });

    // Gear first. It is the only refusal that says the *other* readings are
    // untrue rather than merely thin, so reporting a sample size beside it
    // would be quoting a number this line has just said not to trust.
    const fingerprints = attemptFingerprints(attempts);
    if (fingerprints.length > 1) {
        return refuse(
            'gear-changed',
            `these fights span ${fingerprints.length} different sets of gear — the losses from the old gear say ` +
                'nothing about the new gear, so there is no rush-floor verdict to give until the pool is one build again'
        );
    }
    if (fingerprints.length === 1 && snapshotsReady && gearChangedSince(fingerprints[0], currentFingerprint, true)) {
        return refuse(
            'gear-changed',
            'every recorded fight was fought in gear you are no longer wearing — data from the old gear says ' +
                'nothing about the new gear, so the rush floor cannot be judged from it'
        );
    }

    if (nearMiss.median === null) {
        return refuse(
            'too-few-losses',
            `only ${nearMiss.n} measured loss${nearMiss.n === 1 ? '' : 'es'} of the ${minLosses} a median needs — ` +
                'how close the losses are is not yet a reading'
        );
    }

    if (!burn || burn.runs < minRuns) {
        const have = burn?.runs || 0;
        return refuse(
            'too-few-runs',
            `only ${have} trusted run${have === 1 ? '' : 's'} of torch spend, of the ${minRuns} an average needs — ` +
                'a run joined mid-way reports a floor rather than a measurement, so it does not count'
        );
    }

    const median = remainderPercent(nearMiss.median);

    if (nearMiss.median > closeMedian) {
        return {
            verdict: 'not-close',
            reason: null,
            text: `losses aren't close — they end at ${median} median (n=${nearMiss.n}), and supply headroom won't help`,
            nearMiss,
            burn,
            headroom,
        };
    }

    if (headroom === null || headroom <= 0) {
        return {
            verdict: 'no-headroom',
            reason: null,
            text:
                `losses end at ${median} median (n=${nearMiss.n}), but runs return no torches spare ` +
                `(${Math.round(burn.average)} spent of ${cap || '—'} over ${burn.runs} runs) — lowering the rush ` +
                'floor would need supplies it does not have',
            nearMiss,
            burn,
            headroom,
        };
    }

    return {
        verdict: 'supported',
        reason: null,
        text:
            `losses end at ${median} median (n=${nearMiss.n}) and runs return ${Math.round(headroom)} torches ` +
            'spare — lowering the rush floor is supported',
        nearMiss,
        burn,
        headroom,
    };
}

export default { MIN_TRUSTED_RUNS, CLOSE_MEDIAN, attemptFingerprints, rushFloorVerdict };
