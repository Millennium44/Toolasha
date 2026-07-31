/**
 * Live clear chance for labyrinth combat rooms.
 *
 * The tile badge's number comes from simulating thousands of fights before you
 * walk in. This answers a different question — you are 40 seconds into *this*
 * fight, on this much health, against a monster on that much: do you clear?
 *
 * The method is deliberately crude. Two rates are measured from the fight in
 * progress — how fast the monster's health is falling, and how fast yours is —
 * and extrapolated to three finish lines: the monster dies, you die, the 120s
 * timer expires. No abilities, no procs, no healing model, no monster
 * mechanics. What it captures is the part that dominates: whether the trade is
 * going your way fast enough.
 *
 * The uncertainty is the interesting part. Damage arrives in lumps, so rates
 * measured over a few seconds are noisy and rates measured over a minute are
 * not. Both times-to-die are therefore treated as distributions whose spread
 * narrows as evidence accumulates, and the clear chance is the probability the
 * monster's runs out first — and inside the timer.
 *
 * Pure module: no DOM, no sockets, no game data. Whatever ends up feeding it
 * (socket fields or scraped bars) is somebody else's problem.
 */

/** Labyrinth combat rooms end in a loss at 120 seconds */
export const FIGHT_TIMEOUT_SECONDS = 120;

/**
 * Below this much elapsed time the rates are too noisy to publish. One lucky
 * crit in the first three seconds implies a monster dying in twelve.
 */
export const MIN_ELAPSED_SECONDS = 6;

/**
 * Coefficient of variation on a time-to-die estimated from a full fight's
 * worth of evidence. Damage is lumpy — crits, misses, ability cycles — so even
 * a well-measured rate does not pin the finish to the second.
 */
const BASE_SPREAD = 0.18;

/**
 * Standard normal CDF, Abramowitz & Stegun 26.2.17. Accurate to ~7.5e-8, which
 * is far past what a rate measured off two health bars deserves.
 * @param {number} z - Standard score
 * @returns {number} P(Z <= z)
 */
export function normalCdf(z) {
    const sign = z < 0 ? -1 : 1;
    const x = Math.abs(z) / Math.SQRT2;
    const t = 1 / (1 + 0.3275911 * x);
    const y =
        1 -
        ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
            t *
            Math.exp(-x * x);
    return 0.5 * (1 + sign * y);
}

/**
 * Spread on a time-to-die, as a fraction of the estimate. Falls as the fight
 * supplies evidence: a rate read off six seconds is a guess, one read off a
 * minute is a measurement.
 * @param {number} elapsed - Seconds of fight observed
 * @returns {number} Coefficient of variation
 */
function spreadFor(elapsed) {
    const evidence = Math.max(1, elapsed / FIGHT_TIMEOUT_SECONDS);
    return BASE_SPREAD / Math.sqrt(evidence) + 0.35 / Math.sqrt(Math.max(1, elapsed));
}

/**
 * Estimate the chance of clearing the room from the state of the fight so far.
 *
 * Fractions are of maximum, so 1 is untouched and 0 is dead. They are all this
 * needs: absolute hitpoints would not change any of the arithmetic.
 *
 * Rates are measured over the window you have actually watched, not assumed to
 * run back to a full health bar. Watching a fight from its start is the normal
 * case but not a requirement — the first update can arrive with damage already
 * done, and an estimator that insisted on full health would simply never
 * appear. What being late costs you is the clock: the time already spent is
 * invisible, so pass `remainingSeconds: null` and the timeout drops out of the
 * estimate rather than being guessed at.
 *
 * @param {Object} state - Fight in progress
 * @param {number} state.monsterHpFraction - Monster health remaining now, 0..1
 * @param {number} state.playerHpFraction - Your health remaining now, 0..1
 * @param {number} [state.observedSeconds] - Length of the watched window;
 *   defaults to elapsedSeconds
 * @param {number} [state.elapsedSeconds] - Seconds since the fight started, for
 *   the common case where those are the same thing
 * @param {number} [state.monsterLostFraction] - Monster health lost over the
 *   window; defaults to everything below full
 * @param {number} [state.playerLostFraction] - Yours over the window
 * @param {number|null} [state.remainingSeconds] - Time left on the room timer;
 *   null when unknown, omitted to derive it from elapsedSeconds
 * @param {number} [state.timeoutSeconds] - Room timer, for the rare non-120s case
 * @returns {Object|null} { clearChance, reason, killSeconds, deathSeconds,
 *   remainingSeconds, timerKnown, confident } — null when the state is unusable
 */
export function estimateLiveClearChance(state) {
    const monsterHp = Number(state?.monsterHpFraction);
    const playerHp = Number(state?.playerHpFraction);
    const timeout = Number(state?.timeoutSeconds) || FIGHT_TIMEOUT_SECONDS;
    const elapsed = Number(state?.elapsedSeconds);
    const observed = Number.isFinite(Number(state?.observedSeconds)) ? Number(state.observedSeconds) : elapsed;

    if (![monsterHp, playerHp, observed].every(Number.isFinite)) return null;
    if (monsterHp < 0 || monsterHp > 1 || playerHp < 0 || playerHp > 1 || observed < 0) return null;

    // Health lost over the window. Absent an explicit figure the fight was
    // watched from full, so everything missing was lost while watching.
    const monsterLost = Math.max(
        0,
        Number.isFinite(Number(state?.monsterLostFraction)) ? Number(state.monsterLostFraction) : 1 - monsterHp
    );
    const playerLost = Math.max(
        0,
        Number.isFinite(Number(state?.playerLostFraction)) ? Number(state.playerLostFraction) : 1 - playerHp
    );

    let remaining;
    if (state?.remainingSeconds === null) {
        remaining = null;
    } else if (Number.isFinite(Number(state?.remainingSeconds))) {
        remaining = Math.max(0, Number(state.remainingSeconds));
    } else {
        remaining = Number.isFinite(elapsed) ? Math.max(0, timeout - elapsed) : null;
    }

    // Settled fights need no estimate, and must not be run through the rate
    // math — a dead monster has an undefined time-to-die
    const settled = { remainingSeconds: remaining, timerKnown: remaining !== null, confident: true };
    if (monsterHp <= 0) return { clearChance: 1, reason: 'monster is down', ...settled };
    if (playerHp <= 0) return { clearChance: 0, reason: 'you are down', ...settled };
    if (remaining !== null && remaining <= 0) return { clearChance: 0, reason: 'out of time', ...settled };

    if (observed < MIN_ELAPSED_SECONDS) {
        return {
            clearChance: null,
            reason: 'too early to tell',
            remainingSeconds: remaining,
            timerKnown: remaining !== null,
            confident: false,
        };
    }

    // Time each side has left at the rate measured over the window
    const killSeconds = monsterLost > 0 ? (monsterHp * observed) / monsterLost : Infinity;
    const deathSeconds = playerLost > 0 ? (playerHp * observed) / playerLost : Infinity;
    const confident = observed >= FIGHT_TIMEOUT_SECONDS / 4;

    // Taking no damage at all is not evidence of invulnerability, but it is
    // evidence that death is not what ends this fight — the timer is
    if (killSeconds === Infinity) {
        return {
            clearChance: 0,
            reason: 'not damaging it',
            killSeconds,
            deathSeconds,
            remainingSeconds: remaining,
            timerKnown: remaining !== null,
            confident,
        };
    }

    const spread = spreadFor(observed);
    const killSigma = killSeconds * spread;

    // P(kill lands inside the time left). Both finish lines are uncertain, so
    // the race against death compares two spread-out times rather than two
    // numbers.
    const beatsTimer = remaining === null ? 1 : normalCdf((remaining - killSeconds) / Math.max(1e-6, killSigma));
    let beatsDeath = 1;
    if (deathSeconds !== Infinity) {
        const deathSigma = deathSeconds * spread;
        const sigma = Math.sqrt(killSigma * killSigma + deathSigma * deathSigma);
        beatsDeath = normalCdf((deathSeconds - killSeconds) / Math.max(1e-6, sigma));
    }

    const clearChance = Math.min(1, Math.max(0, beatsTimer * beatsDeath));
    const reason =
        beatsDeath < beatsTimer ? 'racing the monster' : deathSeconds === Infinity ? 'racing the clock' : 'racing both';

    return {
        clearChance,
        reason,
        killSeconds,
        deathSeconds,
        remainingSeconds: remaining,
        timerKnown: remaining !== null,
        confident,
    };
}

/**
 * The one-line form for the action bar.
 * @param {Object|null} estimate - Result of estimateLiveClearChance
 * @returns {string} Empty when there is nothing worth saying yet
 */
export function formatLiveClearChance(estimate) {
    if (!estimate) return '';
    if (estimate.clearChance === null) return '';
    const pct = (estimate.clearChance * 100).toFixed(0);
    // A number the fight has not yet earned is marked, not hidden: watching it
    // firm up is itself informative
    return estimate.confident ? `Clear ~${pct}%` : `Clear ~${pct}%?`;
}
