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

/**
 * A fight the recorder saw begin with the player at least this much of full is a
 * clean start. Below it the player carried a wound in — or the recorder joined
 * mid-fight — and the sim, which always fights from full, has no equivalent: its
 * short length skews the fight-length rate and its opening damage may never have
 * been seen. Retries in one room reset the player to full, so a low start now
 * reliably marks a partial fight rather than ordinary play.
 */
const CLEAN_START_HP_FRACTION = 0.9;

/**
 * Room levels a monster appears at are spread across a random labyrinth, so
 * grouping by exact level would never pool enough fights of one monster to judge.
 * Levels are bucketed to this width instead — a band narrow enough that the
 * monster scales by only about this percent across it — and the group is
 * re-simulated at the median level of the fights in it.
 */
const LEVEL_BUCKET = 10;

/** The median of a list of numbers, for the level a bucket is re-simulated at */
function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** The sim's own run-to-run wobble, folded into every margin so a within-noise call stays honest */
const SIM_NOISE_FLOOR_PCT = 2;

/**
 * How much the damage-taken figure is known to run low. Damage you take is the 3
 * Hz tick-summed drops (see `exchange`) — two hits inside one frame collapse to a
 * single drop, so the total undercounts by a few percent. Damage you deal takes
 * the exact endpoint floor instead and carries no such bias, so this is credited
 * back to the taken metric alone, before its verdict, so a session that lands a
 * couple of points low on top of the bias is not called "below" (which reads as
 * "the sim over-models the monster") on what is really a measurement artifact.
 */
const TAKEN_UNDERCOUNT_PCT = 3;

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
 * The 95% binomial margin on a pooled rate, as a percent of that rate, widened
 * by the sim's own run-to-run noise like every other band here.
 *
 * For the crit rate: per-fight crit ratios have tiny, unequal denominators —
 * a fight with three landed hits swings its ratio by a third per crit — so the
 * honest band comes from the pooled trial count, not the fight-to-fight
 * spread. Null when the rate is zero or there are no trials ("cannot say",
 * the same contract as relMarginPct — a 0% observed rate reads insufficient
 * rather than pretending a band around nothing).
 *
 * @param {number} rate - Pooled successes / trials, 0..1
 * @param {number} trials - Pooled trial count (landed hits, for crits)
 * @returns {number|null}
 */
export function binomialMarginPct(rate, trials) {
    if (!(trials > 0) || !(rate > 0)) return null;
    const stdErr = Math.sqrt((rate * (1 - rate)) / trials);
    return Math.hypot(((Z95 * stdErr) / rate) * 100, SIM_NOISE_FLOOR_PCT);
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
 * The gross damage each side dealt over one attempt.
 *
 * Gross, not net: the comparison is against the sim's `totalDamageDealt`, which
 * counts every hit before any healing. Reading damage off the endpoints instead
 * — where a health bar ends versus where it began — quietly subtracts whatever
 * regenerated during the fight, and you regenerate through a labyrinth fight. A
 * recorder that summed the drops tick by tick reports the gross figure directly;
 * `monsterDamage`/`playerDamageTaken` carry it. Only an older recording that
 * lacks them falls back to the endpoints, which understate the monster by your
 * regen and read as the sim over-hitting.
 *
 * @param {Object} attempt
 * @returns {{monsterDamage: number, playerTaken: number}}
 */
function exchange(attempt) {
    if (Number.isFinite(attempt.monsterDamage) && Number.isFinite(attempt.playerDamageTaken)) {
        // Your damage output: the larger of the tick-summed drops and the
        // monster's endpoint HP loss. The summed feed is 3 Hz, so hits that
        // merged into one frame go uncounted — a few % low. An attempt with
        // the reconciliation fields carries the true start (`monsterHpStart`,
        // from the new_battle snapshot) and what the monster healed back, so
        // its endpoint figure IS the gross damage dealt; older recordings
        // approximate the start with the monster's maximum and carry no healed
        // figure. Damage you TOOK stays the summed figure either way: player
        // healing is not tracked, so no endpoint reconciliation is possible on
        // the taken side and its endpoints would understate by your regen.
        const healed = Number.isFinite(attempt.monsterHealed) ? Math.max(0, attempt.monsterHealed) : 0;
        const start = Number.isFinite(attempt.monsterHpStart)
            ? attempt.monsterHpStart
            : Number(attempt.monsterMaxHp) || 0;
        const endpointDealt = attempt.cleared
            ? start + healed
            : Math.max(0, start - (Number(attempt.monsterHpEnd) || 0) + healed);
        return {
            monsterDamage: Math.max(0, attempt.monsterDamage, endpointDealt),
            playerTaken: Math.max(0, attempt.playerDamageTaken),
        };
    }
    // Endpoint fallback for recordings made before gross damage was summed
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
 * @returns {Array<Object>} One entry per monster+level fought. The array also
 *   carries `droppedUnknownOutcome`, `droppedIncomplete` and
 *   `droppedNotCleanStart` — how many attempts each filter excluded — so an
 *   export can say what the pooled rates were derived from
 */
export function deriveObserved(attempts) {
    const groups = new Map();
    let droppedUnknownOutcome = 0;
    let droppedIncomplete = 0;
    let droppedNotCleanStart = 0;

    for (const attempt of attempts || []) {
        const seconds = Number(attempt?.seconds) || 0;
        if (!attempt?.monsterHrid || seconds <= 0) continue;
        if (attempt.outcome === 'unknown') {
            droppedUnknownOutcome += 1;
            continue;
        }

        // A new-format attempt says outright whether the whole fight was
        // measured; a partial one would understate the rates it pooled into.
        // Legacy attempts lack the flag and stay eligible under the old rules.
        if (attempt.complete === false) {
            droppedIncomplete += 1;
            continue;
        }

        // Drop a fight not seen from full — the player started it already hurt, so
        // it is not the fresh-start fight the sim models
        const maxHp = Number(attempt.playerMaxHp) || 0;
        if (maxHp > 0 && Number(attempt.playerHpStart) < maxHp * CLEAN_START_HP_FRACTION) {
            droppedNotCleanStart += 1;
            continue;
        }

        const level = Math.max(0, Math.floor(Number(attempt.roomLevel) || 0));
        const bucket = Math.round(level / LEVEL_BUCKET) * LEVEL_BUCKET;
        const key = `${attempt.monsterHrid}:${bucket}`;
        let group = groups.get(key);
        if (!group) {
            group = {
                monsterHrid: attempt.monsterHrid,
                monsterName: attempt.monsterName || null,
                bucket,
                levels: [],
                fights: 0,
                clears: 0,
                totalSeconds: 0,
                totalMonsterDamage: 0,
                totalPlayerTaken: 0,
                // Hit-rate/damage-per-hit accumulate only over fights that carry
                // swing counts, so an older recording without them does not drag
                // the rate toward zero — it just contributes no hit data
                totalPlayerHits: 0,
                totalPlayerMisses: 0,
                totalHitDataDealt: 0,
                hitDataFights: 0,
                // Damage-per-hit's like-for-like pool, kept apart from the
                // mixed one above. `totalHitDataDealt` is every point the
                // monster lost, damage-over-time included, over the swings
                // alone — the numerator counts a source the denominator does
                // not. These two accumulate only over fights that recorded
                // their DoT damage, so the subtraction is measured rather
                // than assumed, and a legacy fight never dilutes it.
                totalSwingDealt: 0,
                totalSwingHits: 0,
                swingDamageFights: 0,
                swingDmgPerHitSamples: [],
                // Crits accumulate over their own fights: an attempt can carry
                // hit counts without a crit count (recorded between the two
                // features landing), and folding it in would drag the rate down
                totalPlayerCrits: 0,
                totalCritDataHits: 0,
                critDataFights: 0,
                // The hit MIX, over its own fights for the same reason crits
                // have theirs: DoT ticks were counted later than swings, so a
                // fight recorded before that stores null and must not read as
                // a fight that ticked zero times
                totalPlayerDotTicks: 0,
                totalDotDataSwings: 0,
                dotDataFights: 0,
                dpsSamples: [],
                takenSamples: [],
                secondsSamples: [],
                clearSamples: [],
                hitRateSamples: [],
                dmgPerHitSamples: [],
                critRateSamples: [],
                dotPerSwingSamples: [],
            };
            groups.set(key, group);
        }

        const { monsterDamage, playerTaken } = exchange(attempt);
        group.levels.push(level);
        group.fights += 1;
        group.clears += attempt.cleared ? 1 : 0;
        group.totalSeconds += seconds;
        group.totalMonsterDamage += monsterDamage;
        group.totalPlayerTaken += playerTaken;
        group.dpsSamples.push(monsterDamage / seconds);
        group.takenSamples.push(playerTaken / seconds);
        group.secondsSamples.push(seconds);
        group.clearSamples.push(attempt.cleared ? 1 : 0);

        // Swings recorded this fight — hits + misses. Absent (null) on older
        // recordings; a swing of zero means the fight had none to attribute
        const hits = Number(attempt.playerHits);
        const misses = Number(attempt.playerMisses);
        if (Number.isFinite(hits) && Number.isFinite(misses) && hits + misses > 0) {
            group.totalPlayerHits += hits;
            group.totalPlayerMisses += misses;
            group.hitDataFights += 1;
            group.hitRateSamples.push(hits / (hits + misses));
            if (hits > 0) {
                group.totalHitDataDealt += monsterDamage;
                group.dmgPerHitSamples.push(monsterDamage / hits);
                // The like-for-like numerator: what the swings did, with the
                // uncounted health loss taken back out. Tested on the RAW
                // value — a fight recorded before the split stores null, and
                // Number(null) is 0, which would read as a fight that bled for
                // nothing and quietly leave the mixed figure in the pool under
                // a like-for-like label. `monsterDamage` can exceed the
                // tick-summed total when the endpoints reconcile higher, so
                // the residual the ticks missed stays in the numerator; it is
                // unattributed, not attributed to DoT.
                if (Number.isFinite(attempt.playerDotDamage)) {
                    const dotDamage = Math.max(0, Number(attempt.playerDotDamage));
                    const swingDealt = Math.max(0, monsterDamage - dotDamage);
                    group.totalSwingDealt += swingDealt;
                    group.totalSwingHits += hits;
                    group.swingDamageFights += 1;
                    group.swingDmgPerHitSamples.push(swingDealt / hits);
                }
            }
            // The crit share of landed hits — the tiebreaker on a soft-hit
            // gap: a low real crit rate says the sim over-credits crits, a
            // matching one points the gap at the monster's mitigation.
            // Tested on the RAW value: crits arrived later than hits, so a
            // legacy fight stores null — and Number(null) is 0, which would
            // read as a real zero-crit fight and poison the rate. A count
            // above the hits is a decoder glitch, dropped the same way.
            if (Number.isFinite(attempt.playerCrits) && hits > 0) {
                const crits = Number(attempt.playerCrits);
                if (crits >= 0 && crits <= hits) {
                    group.totalPlayerCrits += crits;
                    group.totalCritDataHits += hits;
                    group.critDataFights += 1;
                    group.critRateSamples.push(crits / hits);
                }
            }
            // Damage-over-time ticks per landed swing — the mix. Tested on the
            // RAW value for the same reason crits are: a legacy fight stores
            // null, and Number(null) is 0, which would read as a fight that
            // never ticked and drag the mix toward zero.
            if (Number.isFinite(attempt.playerDotTicks) && hits > 0) {
                const dotTicks = Number(attempt.playerDotTicks);
                if (dotTicks >= 0) {
                    group.totalPlayerDotTicks += dotTicks;
                    group.totalDotDataSwings += hits;
                    group.dotDataFights += 1;
                    group.dotPerSwingSamples.push(dotTicks / hits);
                }
            }
        }
    }

    const out = [...groups.values()].map((group) => ({
        ...group,
        // The level the group is re-simulated at, and the span it pools, so the
        // display can be honest about a bucket that mixes a few nearby levels
        roomLevel: median(group.levels),
        levelLow: Math.min(...group.levels),
        levelHigh: Math.max(...group.levels),
        dps: group.totalSeconds > 0 ? group.totalMonsterDamage / group.totalSeconds : 0,
        takenPerSecond: group.totalSeconds > 0 ? group.totalPlayerTaken / group.totalSeconds : 0,
        secondsPerFight: group.fights > 0 ? group.totalSeconds / group.fights : 0,
        clearRate: group.fights > 0 ? group.clears / group.fights : 0,
        // Null when no fight carried swing counts, so the replay skips these two
        // rows rather than showing a fabricated 0%
        hitRate:
            group.totalPlayerHits + group.totalPlayerMisses > 0
                ? group.totalPlayerHits / (group.totalPlayerHits + group.totalPlayerMisses)
                : null,
        // Damage-per-hit, on the best basis the pool supports. When any fight
        // recorded its DoT damage the whole row switches to the swing-only pool
        // — swing damage over swing hits, the same quantity the sim's
        // `dmgPerHit` now reports. When none did, the mixed figure survives with
        // its old meaning and `dmgPerHitIncludesDot` says so, so the comparison
        // can pick the prediction that matches rather than pretending the old
        // recording measured something it did not.
        ...(group.swingDamageFights > 0
            ? {
                  dmgPerHit: group.totalSwingHits > 0 ? group.totalSwingDealt / group.totalSwingHits : null,
                  dmgPerHitSamples: group.swingDmgPerHitSamples,
                  dmgPerHitFights: group.swingDamageFights,
                  dmgPerHitIncludesDot: false,
              }
            : {
                  dmgPerHit: group.totalPlayerHits > 0 ? group.totalHitDataDealt / group.totalPlayerHits : null,
                  dmgPerHitFights: group.hitDataFights,
                  dmgPerHitIncludesDot: true,
              }),
        hitDataFights: group.hitDataFights,
        critRate: group.totalCritDataHits > 0 ? group.totalPlayerCrits / group.totalCritDataHits : null,
        critDataFights: group.critDataFights,
        // Null when no fight carried a DoT-tick count: the mix is unknown, not
        // zero, and the row is skipped rather than compared against a fiction
        dotPerSwing: group.totalDotDataSwings > 0 ? group.totalPlayerDotTicks / group.totalDotDataSwings : null,
        dotDataFights: group.dotDataFights,
    }));

    out.sort((a, b) => b.fights - a.fights);
    // Carried on the array itself: consumers that iterate or filter the groups
    // are unaffected, and an export that wants the exclusion counts can read
    // them off the same return
    out.droppedUnknownOutcome = droppedUnknownOutcome;
    out.droppedIncomplete = droppedIncomplete;
    out.droppedNotCleanStart = droppedNotCleanStart;
    return out;
}

/**
 * The recorder's whole pool, summarised for browsing — no sims, no verdicts.
 *
 * Unlike {@link deriveObserved} this drops nothing but malformed rows:
 * incomplete fights, wounded starts and unknown-model attempts are part of
 * what the pool holds, and a browse view that quietly filtered them would
 * misstate what has accumulated. (The recorder never stores unknown
 * outcomes, so every attempt here cleared, died or timed out.)
 *
 * @param {Array<Object>} attempts - From the recorder
 * @returns {Array<Object>} One summary per monster+level bucket, most-fought first
 */
export function summarizePool(attempts) {
    const groups = new Map();

    for (const attempt of attempts || []) {
        const seconds = Number(attempt?.seconds) || 0;
        if (!attempt?.monsterHrid || seconds <= 0) continue;

        const level = Math.max(0, Math.floor(Number(attempt.roomLevel) || 0));
        const bucket = Math.round(level / LEVEL_BUCKET) * LEVEL_BUCKET;
        const key = `${attempt.monsterHrid}:${bucket}`;
        let group = groups.get(key);
        if (!group) {
            group = {
                monsterHrid: attempt.monsterHrid,
                monsterName: attempt.monsterName || null,
                bucket,
                levels: [],
                fights: 0,
                clears: 0,
                outcomes: {},
                totalSeconds: 0,
                totalDealt: 0,
                totalTaken: 0,
                totalCrits: 0,
                totalCritHits: 0,
                critDataFights: 0,
                completeFights: 0,
                residualTotal: 0,
                residualFights: 0,
                fingerprints: new Set(),
                attempts: [],
            };
            groups.set(key, group);
        }

        const { monsterDamage, playerTaken } = exchange(attempt);
        group.levels.push(level);
        group.fights += 1;
        group.clears += attempt.cleared ? 1 : 0;
        const outcome = String(attempt.outcome || 'unknown');
        group.outcomes[outcome] = (group.outcomes[outcome] || 0) + 1;
        group.totalSeconds += seconds;
        group.totalDealt += monsterDamage;
        group.totalTaken += playerTaken;
        if (attempt.complete === true) group.completeFights += 1;
        if (attempt.fingerprint) group.fingerprints.add(attempt.fingerprint);
        // Same accumulation rules as the comparison: raw finiteness (a stored
        // null is not a zero), and never more crits than hits
        const hits = Number(attempt.playerHits);
        if (Number.isFinite(attempt.playerCrits) && Number.isFinite(hits) && hits > 0) {
            const crits = Number(attempt.playerCrits);
            if (crits >= 0 && crits <= hits) {
                group.totalCrits += crits;
                group.totalCritHits += hits;
                group.critDataFights += 1;
            }
        }
        // The residual is signed and null when unmeasured
        if (Number.isFinite(attempt.unattributedDealt)) {
            group.residualTotal += attempt.unattributedDealt;
            group.residualFights += 1;
        }
        group.attempts.push(attempt);
    }

    const out = [...groups.values()].map((group) => ({
        monsterHrid: group.monsterHrid,
        monsterName: group.monsterName,
        bucket: group.bucket,
        roomLevel: median(group.levels),
        levelLow: Math.min(...group.levels),
        levelHigh: Math.max(...group.levels),
        fights: group.fights,
        clears: group.clears,
        winRate: group.fights > 0 ? group.clears / group.fights : 0,
        outcomes: group.outcomes,
        meanSeconds: group.fights > 0 ? group.totalSeconds / group.fights : 0,
        dps: group.totalSeconds > 0 ? group.totalDealt / group.totalSeconds : 0,
        takenPerSecond: group.totalSeconds > 0 ? group.totalTaken / group.totalSeconds : 0,
        critRate: group.totalCritHits > 0 ? group.totalCrits / group.totalCritHits : null,
        critDataFights: group.critDataFights,
        completeFights: group.completeFights,
        completeFraction: group.fights > 0 ? group.completeFights / group.fights : 0,
        residualMean: group.residualFights > 0 ? group.residualTotal / group.residualFights : null,
        residualFights: group.residualFights,
        gearCount: group.fingerprints.size,
        attempts: group.attempts,
    }));

    out.sort((a, b) => b.fights - a.fights);
    return out;
}

/**
 * How much of the pool was measured whole, and what ended the rest.
 *
 * Every recorded fight already carries `complete` — opened at its own
 * `new_battle` snapshot and resolved to a known outcome — and `resolveReason`,
 * the thing that closed it. Nothing outside the export has ever read either,
 * so the pool header quotes counts without saying how much of what it counts is
 * a whole fight. A pool that is one-fifth partials is a different pool from one
 * that is not, and the difference is invisible.
 *
 * Two separate unknowns, kept separate. A fight recorded before these fields
 * existed has no `complete` flag: it is not an incomplete fight, so it is
 * excluded from the fraction's denominator and counted aside. And a fight with
 * no `resolveReason` is filed under `unknown` in the histogram rather than
 * being attributed to whichever reason happens to be commonest.
 *
 * @param {Array<Object>} attempts - From the recorder
 * @returns {{total: number, complete: number, incomplete: number, unknownComplete: number,
 *   measured: number, completeFraction: number|null,
 *   reasons: Array<{reason: string, label: string, count: number}>, text: string}}
 */
export function poolHygiene(attempts) {
    const list = (attempts || []).filter((attempt) => attempt);
    const counts = new Map();
    let complete = 0;
    let incomplete = 0;
    let unknownComplete = 0;

    for (const attempt of list) {
        // Strictly true/false: an absent flag is a fight recorded before the
        // field existed, and reading it as "not complete" would invent partials
        if (attempt.complete === true) complete += 1;
        else if (attempt.complete === false) incomplete += 1;
        else unknownComplete += 1;

        const reason =
            typeof attempt.resolveReason === 'string' && attempt.resolveReason ? attempt.resolveReason : 'unknown';
        counts.set(reason, (counts.get(reason) || 0) + 1);
    }

    const reasons = [...counts.entries()]
        .map(([reason, count]) => ({ reason, count, label: reason.replace(/_/g, '-') }))
        .sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : 1));

    const measured = complete + incomplete;
    const parts = [];
    if (measured > 0) parts.push(`${complete} of ${measured} complete`);
    if (unknownComplete) parts.push(`${unknownComplete} before the field existed`);
    for (const entry of reasons) parts.push(`${entry.count} ${entry.label}`);

    return {
        total: list.length,
        complete,
        incomplete,
        unknownComplete,
        measured,
        completeFraction: measured > 0 ? complete / measured : null,
        reasons,
        text: list.length ? parts.join(' · ') : 'no fights recorded',
    };
}

/**
 * The attack-tally key the engine files damage-over-time ticks under. Every
 * other key is a swing of some kind — `autoAttack`, an ability hrid, or one of
 * the reactive sources (`parry`, `retaliation`, a thorn type).
 */
export const DOT_SOURCE = 'damageOverTime';

/**
 * The reflect sources the engine files, from `CombatUtilities`' `thornType`.
 *
 * Grouped with damage-over-time rather than with swings because the observed
 * side groups them there: `attributeTick` calls a health loss with no
 * `dmgCounter` movement behind it a tick, and the module's own field note says
 * a thorns reflect is exactly that — health lost without the monster's hit
 * counter rising. Whatever the recorder cannot see as a counted hit, the sim
 * must not offer as one.
 */
const THORN_SOURCES = new Set(['physicalThorns', 'elementalThorns']);

/**
 * Whether a tally source is one the monster's damage counter counted.
 *
 * This is the whole of the like-for-like question. The observed hit and miss
 * counts are not health diffs — `attributeTick` calls a hit `dmgCounter`
 * **rising**, a miss the same counter rising with the health unchanged, and
 * everything else (a bleed ticking, a reflect firing) an uncounted tick that
 * `foldEvents` banks under `dotTicks`, never under `hits`. So the sim's side
 * has to be read the same way: `autoAttack`, an ability, `parry` and
 * `retaliation` are attacks the game counts — and they are the only sources
 * the engine ever files a `'miss'` under, which is the tell, since a miss can
 * only exist as a counted attempt that dealt nothing. `damageOverTime` and the
 * thorn types are real damage with no counted attempt behind them.
 *
 * @param {string} source - A key of `attacks[player][monster]`
 * @returns {boolean}
 */
function isCountedSource(source) {
    return source !== DOT_SOURCE && !THORN_SOURCES.has(source);
}

/**
 * The sim's damage against one monster, split by what dealt it.
 *
 * `attacks[you][monster]` is keyed by source, and each source holds a histogram
 * of `{miss: n, <damageValue>: n, …}` — so the miss key counts misses and every
 * other key is a landed hit whose key IS the damage it did. That makes counts,
 * totals and means per source recoverable without the engine keeping any of
 * them, which is why this lives here rather than in the engine.
 *
 * The split does two jobs. It supplies the swing-only figures the hit rate and
 * damage-per-hit are compared on — the sim files every DoT tick and thorns
 * reflect as an entry here, and pooling those with the swings put a denominator
 * against the recorder's that never counted them. And it supplies `dotPerSwing`:
 * a tick lands for a fraction of the blow that applied it, so a sim that ticks
 * more or less often than you moves damage-per-hit by several percent with the
 * monster's mitigation untouched, which is the ambiguity the soft-hit diagnosis
 * could not otherwise resolve.
 *
 * @param {Object} simResult - From runLabyrinthSimulation
 * @param {Object} keys
 * @param {string} keys.playerHrid - The player DTO's hrid
 * @param {string} keys.monsterHrid - The monster fought
 * @returns {Object|null} `{sources, landedHits, misses, totalDamage, meanDamage,
 *   swings, swingMisses, swingDamage, dotTicks, dotDamage, dotPerSwing}`, or null
 *   when the result carries no tally at all — which must not read as a run that
 *   dealt nothing. The first four are every entry the engine filed, kept for the
 *   export and for a recorded pool that can only be read mixed; the `swing*`
 *   figures are the subset the monster's damage counter would have counted, which
 *   is what the observed side measures
 */
export function simDamageTally(simResult, { playerHrid, monsterHrid } = {}) {
    const abilityTally = simResult?.attacks?.[playerHrid]?.[monsterHrid];
    if (!abilityTally || !Object.keys(abilityTally).length) return null;

    const sources = [];
    let landedHits = 0;
    let misses = 0;
    let totalDamage = 0;
    let swings = 0;
    let swingMisses = 0;
    let swingDamage = 0;
    let dotTicks = 0;
    let dotDamage = 0;

    for (const [source, stats] of Object.entries(abilityTally)) {
        let sourceLanded = 0;
        let sourceMisses = 0;
        let sourceDamage = 0;
        for (const [outcome, count] of Object.entries(stats || {})) {
            const n = Number(count) || 0;
            if (outcome === 'miss') {
                sourceMisses += n;
                continue;
            }
            sourceLanded += n;
            sourceDamage += (Number(outcome) || 0) * n;
        }

        landedHits += sourceLanded;
        misses += sourceMisses;
        totalDamage += sourceDamage;
        if (isCountedSource(source)) {
            swings += sourceLanded;
            swingMisses += sourceMisses;
            swingDamage += sourceDamage;
        } else {
            dotTicks += sourceLanded;
            dotDamage += sourceDamage;
        }

        sources.push({
            source,
            landedHits: sourceLanded,
            misses: sourceMisses,
            totalDamage: sourceDamage,
            // Null rather than zero when nothing landed: a source that only ever
            // missed has no mean, and printing 0 would read as free hits
            meanDamage: sourceLanded > 0 ? sourceDamage / sourceLanded : null,
            shareOfLandedHits: 0,
        });
    }

    for (const row of sources) {
        row.shareOfLandedHits = landedHits > 0 ? row.landedHits / landedHits : 0;
    }
    // Biggest contributor first — the order the panel reads top-down
    sources.sort((a, b) => b.totalDamage - a.totalDamage);

    return {
        sources,
        landedHits,
        misses,
        totalDamage,
        meanDamage: landedHits > 0 ? totalDamage / landedHits : null,
        swings,
        swingMisses,
        swingDamage,
        // Null rather than zero when nothing landed, the same contract the
        // per-source means keep
        meanSwingDamage: swings > 0 ? swingDamage / swings : null,
        dotTicks,
        dotDamage,
        // Null only when the run threw no swings at all; a run that swung and
        // never ticked is a real zero and a finding when you tick
        dotPerSwing: swings > 0 ? dotTicks / swings : null,
    };
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

    // Labyrinth restarts are instant: every resolution (win, death, timeout)
    // queues the next CombatStartEvent at the same simulationTime, so the sim's
    // wall-clock IS in-fight time. An earlier version subtracted 3 s per attempt
    // here for "the engine's RESTART_INTERVAL" — but that interval only applies
    // to the dungeon-wipe path, so the subtraction shrank the divisor and read
    // the sim's dps and damage-taken a few percent higher than it fights.
    const rateSeconds = simSeconds;

    // Your swings on the monster, from the sim's per-source attack tally. The
    // split by source is computed once and carried through, so the export and
    // the panel read the same numbers the rates were derived from.
    const tally = simDamageTally(simResult, { playerHrid, monsterHrid });
    // Every entry the engine filed. Only the mixed damage-per-hit still divides
    // by this, and only for a recorded pool that cannot be read any other way.
    const simHits = tally?.landedHits ?? 0;
    // The counted subset — what the observed hit and miss counts are. A
    // damage-over-time tick and a thorns reflect are damage with no counted
    // attempt behind them, so they are neither a hit nor an attempt here.
    const simSwings = tally?.swings ?? 0;
    const simSwingMisses = tally?.swingMisses ?? 0;
    const simSwingAttempts = simSwings + simSwingMisses;

    // The sim's landed crits. The property's PRESENCE is the discriminator —
    // an engine that counts crits always creates the map, so a run that never
    // critted reads as a real 0% (a finding, if you crit), while a cached
    // result from an engine without the counter reads as "no data" and the
    // row is skipped rather than compared against a fabricated zero.
    const hasCritData = simResult.crits !== undefined;
    const simCrits = hasCritData ? Number(simResult.crits?.[playerHrid]) || 0 : null;

    return {
        dps: dealt / rateSeconds,
        takenPerSecond: taken / rateSeconds,
        secondsPerFight: attempts > 0 ? simSeconds / attempts : 0,
        clearRate: attempts > 0 ? wins / attempts : 0,
        hitRate: simSwingAttempts > 0 ? simSwings / simSwingAttempts : null,
        // Swing damage over swing hits. `tally.swingDamage` rather than
        // `dealt`: the latter is `totalDamageDealt`, which is every point the
        // player dealt from every source, so dividing it by swings would leave
        // the DoT damage in the numerator and take it out of the denominator —
        // wrong in the opposite direction to the bug this replaces.
        dmgPerHit: simSwings > 0 ? tally.swingDamage / simSwings : null,
        // The old mixed figure, kept for a recorded pool that predates the
        // observed DoT-damage split and can therefore only be compared mixed.
        // Both sides of THAT comparison count every source, so it is still
        // like-for-like — just against a coarser quantity.
        dmgPerHitAllSources: simHits > 0 ? dealt / simHits : null,
        // Crits divide by swings for the same reason: the engine passes
        // `isCrit` only from the counted attack paths, and the recorder counts a
        // crit only when the monster's crit counter moved on a counted hit
        critRate: hasCritData && simSwings > 0 ? simCrits / simSwings : null,
        // The per-source split, and the one ratio that decides a soft-hit gap
        tally,
        dotPerSwing: tally?.dotPerSwing ?? null,
        attempts,
        wins,
        simSeconds,
        // How the sim run itself went, for the exported comparison: attempts it
        // left unresolved at the cutoff, and whether it stopped because the rate
        // hit its precision target rather than the clock
        unfinishedAttempts: Math.max(0, Number(simResult.labyUnfinishedAttempts) || 0),
        stoppedOnPrecision: !!simResult.labyStoppedOnPrecision,
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
 * @param {number} [downwardBiasPct=0] - Percent the observed side is known to run
 *   low (a measurement bias); credited back before the verdict, not to the shown
 *   deviation, so a rate short only by the bias is not called "below".
 * @returns {Object}
 */
function compareMetric(
    key,
    label,
    observed,
    predicted,
    samples,
    fights,
    downwardBiasPct = 0,
    marginPctOverride = null
) {
    const marginPct = marginPctOverride ?? widenedMarginPct(samples);
    const dev = deviationPct(observed, predicted);
    // The verdict judges the bias-corrected deviation; the row still shows the
    // raw one, since the observed figure it displays is the real measured rate.
    const judgedDev = dev === null ? null : dev + downwardBiasPct;

    let verdict;
    if (fights < MIN_LAB_FIGHTS || marginPct === null || judgedDev === null) {
        verdict = 'insufficient';
    } else if (Math.abs(judgedDev) <= marginPct) {
        verdict = 'consistent';
    } else {
        verdict = judgedDev > 0 ? 'above' : 'below';
    }

    return { key, label, observed, predicted, deviationPct: dev, marginPct, verdict };
}

/**
 * Read the four verdicts into one sentence about what the sim is getting wrong.
 *
 * @param {Object} dps - Your-damage metric
 * @param {Object} taken - Monster-damage metric
 * @param {Object} clear - Clear-rate metric
 * @param {Object} [split] - `{hitRate, dmgPerHit, critRate, mix}` metrics, when the
 *   data behind each exists
 * @returns {string}
 */
function diagnose(dps, taken, clear, { hitRate = null, dmgPerHit = null, critRate = null, mix = null } = {}) {
    // Both damage metrics err in either direction, and each direction is a
    // different finding. `below` on your damage means the sim credited you more
    // than you delivered; `below` on the monster's means it credited the monster
    // more than it dealt — the sim over-modelled the monster, which is why the
    // observed rate came in under.
    const yourDamage = dps.verdict === 'below' ? 'over' : dps.verdict === 'above' ? 'under' : null;
    const monsterDamage = taken.verdict === 'above' ? 'under' : taken.verdict === 'below' ? 'over' : null;

    // When the damage gap decomposes, name the half that is off: fewer hits than
    // predicted is an accuracy gap (the monster's evasion is under-modelled — a
    // buff like Guardian Aura); softer hits are a mitigation gap (its resistance
    // or armour is under-modelled — a buff like Toughness) OR a difference in
    // what counted as a hit, which is not the same finding and is spelled out
    // where the sentence is built below.
    const missingHits = hitRate?.verdict === 'below';
    const softHits = dmgPerHit?.verdict === 'below';
    // The crit tiebreaker on a soft-hit gap: crits are the player's own roll,
    // so a real crit rate under the sim's means the damage roll itself is
    // over-credited — the gap is not the monster's mitigation at all
    const fewCrits = critRate?.verdict === 'below';
    // "Consistent" is not "matches". A crit rate is measured over landed hits,
    // so its band is the widest of the four — 15% is normal at a few hundred
    // hits — and a real 12% shortfall sits inside it. Reading that as a
    // positive result and printing "your crit rate matches" turns "the sample
    // cannot tell" into evidence, and it pointed the Pyre Hunter diagnosis at
    // the monster's mitigation (observed dmg/hit −6.26%, crit rate −11.97%
    // against a 15.2% band) when the monster stat check had already shown its
    // armour and all three resistances matching the game exactly. Only a
    // deviation well inside its own band rules anything out.
    const critsMatch =
        critRate?.verdict === 'consistent' &&
        Number.isFinite(critRate.deviationPct) &&
        Number.isFinite(critRate.marginPct) &&
        Math.abs(critRate.deviationPct) <= critRate.marginPct / 2;
    const critsUndecided = critRate?.verdict === 'consistent' && !critsMatch;

    // The mix ratio. It used to be one of the two explanations for a soft-hit
    // gap, because both sides counted a damage-over-time tick as a landed hit
    // and a tick is a fraction of the blow that applied it. Both sides now
    // divide swing damage by swings, so a tick is in neither half of that row
    // and the mix cannot move it — which makes a mix that is off its own
    // finding about the rotation rather than an alternative to mitigation.
    const mixIsOff = mix?.verdict === 'above' || mix?.verdict === 'below';
    // Both ratios, quoted, because the ratio IS the finding — a reader who
    // disagrees with the verdict can redo the division from the sentence
    const mixNumbers =
        mix && Number.isFinite(mix.observed) && Number.isFinite(mix.predicted)
            ? `${mix.observed.toFixed(2)} DoT ticks per swing against the sim’s ${mix.predicted.toFixed(2)}`
            : null;

    let because = '';
    if (missingHits && softHits) {
        because =
            ' — you land fewer hits and each lands softer than it predicts, so its evasion and mitigation both run light';
    } else if (missingHits) {
        because =
            ' — you land fewer hits than it predicts, so its evasion runs light (an unmodelled evasion buff like Guardian Aura)';
    } else if (softHits && fewCrits) {
        because =
            ' — each hit lands softer than it predicts and you crit less than it predicts, so the sim over-credits ' +
            'your crits rather than under-modelling the monster';
    } else if (softHits) {
        // A soft-hit gap used to have two candidate mechanisms, mitigation and
        // the hit MIX, because a damage-over-time tick counted as a landed hit
        // on both sides and lands for a fraction of the blow that applied it.
        // Against a Pyre Hunter at room 239 that was 26 ticks per 100 swings at
        // a mean of 81 against 219 for a swing — enough to move the row by
        // several percent on its own, which is why the ambiguity was real.
        //
        // It is not any more. Both sides divide swing damage by swing hits, so
        // a tick is in neither half of this row and the mix cannot move it. The
        // mechanisms left are the monster's mitigation, which the stat check
        // reads straight off the game, and the damage roll itself. A mix that
        // is off is still worth saying — it moves your damage per second — but
        // it is a separate finding, and offering it as an explanation for THIS
        // row would send the reader after the wrong thing.
        because =
            ' — each hit lands softer than it predicts. Both sides count swings only, so the hit mix is out ' +
            'of this row: what is left is the monster’s mitigation (an unmodelled resistance/armour buff ' +
            'like Toughness) or the damage roll itself. Run the monster stat check on this room to settle ' +
            'the mitigation half' +
            (critsMatch
                ? '; your crit rate matches, which rules the crit roll out'
                : critsUndecided
                  ? '; your crit rate reads low too but stays inside its band, so the crit roll is not ruled out'
                  : '') +
            (mixIsOff && mixNumbers
                ? `. Your hit mix is off as well — ${mixNumbers} — which is its own finding: a tick is ` +
                  'damage with no swing behind it, so it moves your damage per second rather than this row'
                : '');
    }

    if (yourDamage === 'over' && monsterDamage === 'under') {
        return `Sim over-credits your damage and under-models the monster’s — both push the clear chance too high${because}.`;
    }
    if (yourDamage === 'over') {
        return `Sim over-credits your damage: real fights kill the monster slower, so more of them time out${because}.`;
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
        observed.fights,
        TAKEN_UNDERCOUNT_PCT
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

    // The decomposition of the damage gap — only when both sides carry swing
    // counts. Hit-rate is accuracy against the monster's evasion; damage-per-hit
    // is what each landed hit does after its mitigation. Which one is off names
    // whether the sim under-models the monster's evasion or its resistance.
    const hasHitData = observed.hitDataFights > 0 && observed.hitRate !== null && Number.isFinite(predicted?.hitRate);
    const hitRate = hasHitData
        ? compareMetric(
              'hitRate',
              'Your hit rate',
              observed.hitRate,
              predicted.hitRate,
              observed.hitRateSamples,
              observed.hitDataFights
          )
        : null;
    // Damage-per-hit, compared on whichever basis BOTH sides can state. A pool
    // whose fights recorded their DoT damage divides swing damage by swing hits
    // and meets the sim's swing-only figure; a pool recorded before that split
    // can only offer the mixed number, so it is put against the sim's mixed one
    // and the label says which it is. What must never happen is the two crossed:
    // the observed side counting DoT damage into a numerator whose denominator
    // is swings, against a prediction that counted it into neither.
    const mixedBasis = observed.dmgPerHitIncludesDot === true;
    // A prediction from before the split carries only the one figure; falling
    // back to it keeps the old row rather than dropping it, and it IS the mixed
    // figure on such a prediction
    const predictedDmgPerHit = mixedBasis
        ? (predicted?.dmgPerHitAllSources ?? predicted?.dmgPerHit)
        : predicted?.dmgPerHit;
    const dmgPerHit =
        hasHitData && observed.dmgPerHit !== null && Number.isFinite(predictedDmgPerHit)
            ? compareMetric(
                  'dmgPerHit',
                  mixedBasis ? 'Damage / hit (incl. DoT)' : 'Damage / hit',
                  observed.dmgPerHit,
                  predictedDmgPerHit,
                  observed.dmgPerHitSamples,
                  observed.dmgPerHitFights ?? observed.hitDataFights
              )
            : null;
    // The crit share of landed hits, the soft-hit tiebreaker: a real crit rate
    // below the sim's says the damage roll is over-credited by crits (not the
    // monster's mitigation); a matching one points a soft-hit gap at the monster
    const critRate =
        observed.critDataFights > 0 && observed.critRate !== null && Number.isFinite(predicted?.critRate)
            ? compareMetric(
                  'critRate',
                  'Your crit rate',
                  observed.critRate,
                  predicted.critRate,
                  observed.critRateSamples,
                  observed.critDataFights,
                  0,
                  // Binomial over the pooled hits — per-fight ratios have
                  // denominators too small to band honestly
                  binomialMarginPct(observed.critRate, observed.totalCritDataHits)
              )
            : null;

    // The hit mix: damage-over-time ticks per landed swing, on both sides. This
    // is the measurement that decides a soft-hit gap — a tick lands for a
    // fraction of the blow that applied it, so a mix the sim gets wrong moves
    // damage-per-hit on its own, with the monster's mitigation untouched.
    const mix =
        observed.dotDataFights > 0 && observed.dotPerSwing !== null && Number.isFinite(predicted?.dotPerSwing)
            ? compareMetric(
                  'dotPerSwing',
                  'DoT ticks / swing',
                  observed.dotPerSwing,
                  predicted.dotPerSwing,
                  observed.dotPerSwingSamples,
                  observed.dotDataFights
              )
            : null;

    const metrics = [dps, taken, clear, seconds];
    if (hitRate) metrics.push(hitRate);
    if (dmgPerHit) metrics.push(dmgPerHit);
    if (critRate) metrics.push(critRate);
    if (mix) metrics.push(mix);

    return {
        monsterHrid: observed.monsterHrid,
        monsterName: observed.monsterName || null,
        roomLevel: observed.roomLevel,
        levelLow: observed.levelLow ?? observed.roomLevel,
        levelHigh: observed.levelHigh ?? observed.roomLevel,
        fights: observed.fights,
        clears: observed.clears,
        metrics,
        // The sim run behind the prediction, kept so an exported comparison
        // says how the figures were produced — a run that stopped wide of its
        // precision target is a weaker witness than one that converged
        sim: {
            attempts: predicted.attempts ?? null,
            wins: predicted.wins ?? null,
            simSeconds: predicted.simSeconds ?? null,
            unfinishedAttempts: predicted.unfinishedAttempts ?? null,
            stoppedOnPrecision: predicted.stoppedOnPrecision ?? null,
        },
        // The sim's damage split by what dealt it — auto attack, each ability,
        // damage-over-time — so the export carries the predicted hit mix beside
        // the rates it produced. Null when the sim result held no attack tally.
        simTally: predicted.tally ?? null,
        diagnosis: diagnose(dps, taken, clear, { hitRate, dmgPerHit, critRate, mix }),
    };
}

export default {
    deriveObserved,
    predictedFromSim,
    simDamageTally,
    compareLab,
    deviationPct,
    relMarginPct,
    MIN_LAB_FIGHTS,
};
