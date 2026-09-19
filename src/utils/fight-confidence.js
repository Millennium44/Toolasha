/**
 * Fight-count confidence: how many fights to queue so a kill target is
 * actually *met*, not merely expected.
 *
 * Two surfaces pre-fill a fight count from a prediction — the Bestiary
 * planner's per-step count and the combat task Go button — and both used to
 * quote the expectation, `kills needed ÷ kills per fight`. That number is the
 * count you clear the target with about half the time. The other half you stop
 * one kill short and have to go back, which is exactly the trip the pre-fill
 * existed to save.
 *
 * Padding it by a flat percentage does not fix that, because the error is not
 * a percentage. The number of kills in `n` fights is binomial, so its relative
 * spread shrinks as 1/√n: a flat 5% is far too little when six more kills are
 * wanted (≈60 fights, σ ≈ 2.3 kills — a whole 38% of the target) and absurdly
 * too much when three thousand are (≈13,800 fights, σ ≈ 47 kills — 1.2%). The
 * honest question is a quantile, not a margin:
 *
 * > given that I need `k` more kills of a monster I kill at rate `p` per
 * > fight, how many fights `n` must I queue so that P(kills ≥ k) ≥ c?
 *
 * ## The model, and why it is exact
 *
 * Kills in `n` fights are Binomial(n, p) — each fight is one draw from the
 * zone's spawn table, independent of the last — so the count of fights needed
 * for the k-th kill is negative binomial, and the two are the same statement:
 * P(fights ≤ n) = P(Binomial(n, p) ≥ k). The answer is the smallest `n` whose
 * binomial upper tail reaches `c`.
 *
 * ## When a fight hands out more than one kill
 *
 * "One draw per fight" is the special case `p < 1`. A fight is really a *batch*
 * of draws: an ordinary zone's encounter fills up to `maxSpawnCount` monster
 * slots from the table, and a dungeon *clear* — which is what the planner
 * quotes a dungeon in — is fifty-odd waves of four or five slots each. Those
 * zones hand out `p` kills a fight with `p` well above one, and the count is
 * every bit as random as a rare monster's.
 *
 * The batch is modelled as what it is: `b` independent slots per fight, each
 * one this monster with probability `p / b`. Then kills in `n` fights are
 * Binomial(n·b, p/b) and the machinery above applies *unchanged* — search on
 * slots for the smallest `m` with P(Binomial(m, p/b) ≥ k) ≥ c, then quote
 * `⌈m / b⌉` fights, which is exact because the tail is monotone in `m` and a
 * fight buys exactly `b` slots.
 *
 * `b = 1` is the old Bernoulli fight, so nothing that quoted one moves. The
 * per-fight variance `p(1 − p/b)` *rises* with `b` toward the Poisson limit
 * `p`, so more slots means more padding, and the slot count is therefore a
 * claim that has to come from the game data rather than be guessed generously.
 * It does: `randomSpawnInfo.maxSpawnCount` for a zone, and, for a dungeon, the
 * waves that are not on `fixedSpawnsMap` times their table's `maxSpawnCount`.
 *
 * A slot count that is genuinely unknown while `p > 1` falls back to the
 * variance-maximizing reading — {@link UNKNOWN_SLOT_RESOLUTION} slots per
 * expected kill, which is Poisson to within 2% of the variance. That over-pads
 * rather than strands, and it is the only guess in here.
 *
 * ## What is *not* padded
 *
 * A kill count that is arithmetic rather than luck. Two cases reach that, and
 * both are read off the game data, never inferred from the rate:
 *
 * - a boss, which arrives on a fixed wave (`dataManager.isBossMonster`);
 * - a dungeon monster that appears only in `fixedSpawnsMap` rosters, which is
 *   handed out the same number of times every single clear.
 *
 * `p / b ≥ 1` — every slot in the fight is this monster — is the third, and it
 * is the same statement: there is nothing left to be uncertain about.
 *
 * A normal approximation to that tail is not good enough where it matters
 * most. At k = 6 the distribution is visibly skewed and a continuity-corrected
 * normal is off by several fights — and six is precisely the case that
 * motivated this. So the tail is summed exactly, in log space, and the answer
 * found by bisection on it. The normal approximation survives only as the
 * opening guess that makes the bracket tight, so every exact evaluation
 * happens near the answer and costs O(√n) terms rather than O(k).
 *
 * ## What "confidence" is measured over
 *
 * Per threshold, never jointly across a row. A Bestiary step can cross several
 * monsters' thresholds in the same stay, and the count that gets filled is the
 * largest of their individual requirements. It is deliberately *not* raised so
 * that all of them clear together with probability `c`:
 *
 * - Those crossings are not independent. Every fight in a zone spawns exactly
 *   one monster, so kills of two monsters in the same stay are negatively
 *   correlated. Multiplying `c` five times over would not be the joint
 *   probability; it would be a number with no referent.
 * - It would also be invisible. Two rows quoting the same "90%" would ask for
 *   very different counts purely because one of them happens to list five
 *   monsters, and nothing on screen would say why.
 *
 * So `c` reads as: for the threshold this count is sized by, you clear it this
 * often. Every other threshold in the step clears at least that often, since
 * the binding one is by construction the hungriest.
 *
 * Pure: everything is an argument and nothing is read from the game.
 */

/** Beyond this the answer has stopped being a number anyone would queue. */
const MAX_FIGHTS = 1e9;

/** The same cap, applied to the slot search that sits underneath it. */
const MAX_SLOTS = 1e9;

/**
 * Slots assumed per expected kill when a fight hands out more than one and
 * nothing said how many slots it has.
 *
 * At 64 the per-slot chance is 1/64, so the per-fight variance is
 * `p(1 − 1/64)` — 98.4% of the Poisson limit a batch of unknown width can
 * reach. The cost of being wrong this way is a queue a few percent long; the
 * cost of the other way is the stranding the module exists to stop.
 */
const UNKNOWN_SLOT_RESOLUTION = 64;

/** Confidence is clamped below 1 — P = 1 needs infinitely many fights. */
const MAX_CONFIDENCE = 0.99999;

/** Lanczos coefficients, g = 7 */
const LANCZOS = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];

/**
 * log Γ(x) for x > 0, by the Lanczos approximation.
 *
 * Only ever called on integers here, but factorials of fourteen thousand
 * overflow a double long before their logarithms do, which is the whole point.
 * @param {number} x
 * @returns {number}
 */
function logGamma(x) {
    if (x < 0.5) {
        // Reflection, for completeness; the callers never reach it.
        return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
    }
    const z = x - 1;
    let series = LANCZOS[0];
    for (let i = 1; i < LANCZOS.length; i += 1) series += LANCZOS[i] / (z + i);
    const t = z + LANCZOS.length - 1.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(series);
}

/** Acklam's rational approximation to the standard normal quantile. */
const ACKLAM_A = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1,
    2.506628277459239,
];
const ACKLAM_B = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1,
];
const ACKLAM_C = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968,
    2.938163982698783,
];
const ACKLAM_D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];

/**
 * The standard normal quantile Φ⁻¹(p), accurate to about 1e-9.
 *
 * Used only to place the opening guess; the answer itself is exact.
 * @param {number} p - in (0, 1)
 * @returns {number}
 */
function inverseNormalCdf(p) {
    if (!(p > 0)) return -Infinity;
    if (!(p < 1)) return Infinity;
    const low = 0.02425;
    if (p < low) {
        const q = Math.sqrt(-2 * Math.log(p));
        return (
            (((((ACKLAM_C[0] * q + ACKLAM_C[1]) * q + ACKLAM_C[2]) * q + ACKLAM_C[3]) * q + ACKLAM_C[4]) * q +
                ACKLAM_C[5]) /
            ((((ACKLAM_D[0] * q + ACKLAM_D[1]) * q + ACKLAM_D[2]) * q + ACKLAM_D[3]) * q + 1)
        );
    }
    if (p > 1 - low) return -inverseNormalCdf(1 - p);
    const q = p - 0.5;
    const r = q * q;
    return (
        ((((((ACKLAM_A[0] * r + ACKLAM_A[1]) * r + ACKLAM_A[2]) * r + ACKLAM_A[3]) * r + ACKLAM_A[4]) * r +
            ACKLAM_A[5]) *
            q) /
        (((((ACKLAM_B[0] * r + ACKLAM_B[1]) * r + ACKLAM_B[2]) * r + ACKLAM_B[3]) * r + ACKLAM_B[4]) * r + 1)
    );
}

/**
 * P(Binomial(n, p) ≥ k), summed exactly.
 *
 * The lower tail P(X ≤ k−1) is accumulated by walking *down* from i = k−1,
 * seeding that one term through `logGamma` so nothing under- or overflows on
 * the way, and stepping with the pmf ratio. Where this is called — a bracket
 * placed around the normal-approximation guess — k−1 sits at or below the
 * mode, so the terms shrink monotonically and the walk ends after a few
 * standard deviations rather than after k terms.
 * @param {number} n - fights
 * @param {number} k - kills wanted
 * @param {number} p - kill chance per fight, in (0, 1)
 * @returns {number} the upper tail, in [0, 1]
 */
export function binomialAtLeast(n, k, p) {
    if (k <= 0) return 1;
    if (n < k) return 0;
    if (p >= 1) return 1;
    if (p <= 0) return 0;

    const q = 1 - p;
    const top = k - 1;
    const logTop =
        logGamma(n + 1) - logGamma(top + 1) - logGamma(n - top + 1) + top * Math.log(p) + (n - top) * Math.log(q);
    let term = Math.exp(logTop);
    if (!Number.isFinite(term)) return term > 0 ? 0 : 1;
    let lower = term;
    const ratio = q / p;
    for (let i = top; i >= 1; i -= 1) {
        term *= (i / (n - i + 1)) * ratio;
        if (!Number.isFinite(term)) break;
        lower += term;
        if (term <= lower * 1e-17) break;
    }
    return Math.max(0, Math.min(1, 1 - lower));
}

/**
 * How many independent monster slots one fight draws, given its mean.
 *
 * A caller that knows is believed, except that a slot count below the mean is
 * arithmetically impossible (it would need a per-slot chance above one), so it
 * is raised until it is not. A caller that does not know keeps the Bernoulli
 * fight while the mean allows it, and otherwise takes the conservative reading
 * described on {@link UNKNOWN_SLOT_RESOLUTION}.
 *
 * @param {number} p - kills of this monster per fight
 * @param {number|null|undefined} slotsPerFight - what the caller knows, if anything
 * @returns {number} slots per fight, at least 1
 */
function resolveSlots(p, slotsPerFight) {
    const given = Math.floor(Number(slotsPerFight));
    if (Number.isFinite(given) && given >= 1) return Math.max(given, Math.ceil(p - 1e-9));
    if (p <= 1) return 1;
    return Math.ceil(p * UNKNOWN_SLOT_RESOLUTION);
}

/**
 * The smallest number of slots whose binomial upper tail reaches `confidence`.
 *
 * Opening guess: continuity-corrected normal, solved for the slot count as a
 * quadratic in its square root. Close enough that the bracket below is a
 * handful of slots wide, so every exact evaluation happens near the answer.
 *
 * @param {number} k - kills wanted
 * @param {number} p - chance one slot is this monster, in (0, 1)
 * @param {number} confidence - in (0, 1)
 * @returns {number} slots, capped at {@link MAX_SLOTS}
 */
function slotsForKillConfidence(k, p, confidence) {
    const z = inverseNormalCdf(confidence);
    const root = (z * Math.sqrt(p * (1 - p)) + Math.sqrt(z * z * p * (1 - p) + 4 * p * (k - 0.5))) / (2 * p);
    let guess = Math.ceil(root * root);
    if (!Number.isFinite(guess) || guess < k) guess = k;
    if (guess > MAX_SLOTS) return MAX_SLOTS;

    // Bracket the exact answer around the guess, then bisect. The tail is
    // increasing in the slot count for fixed k and p, so this is a clean
    // monotone search.
    const reaches = (n) => binomialAtLeast(n, k, p) >= confidence;
    let lo = Math.max(k - 1, Math.floor(guess * 0.9) - 4);
    let hi = Math.max(lo + 1, Math.ceil(guess * 1.1) + 4);
    let span = Math.max(8, hi - lo);
    while (reaches(lo) && lo > k - 1) {
        hi = lo;
        lo = Math.max(k - 1, lo - span);
        span *= 2;
    }
    while (!reaches(hi)) {
        lo = hi;
        hi = Math.min(MAX_SLOTS, hi + span);
        span *= 2;
        if (hi >= MAX_SLOTS) return MAX_SLOTS;
    }
    while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (reaches(mid)) hi = mid;
        else lo = mid;
    }
    return hi;
}

/**
 * The fights needed to land `killsNeeded` kills with probability at least
 * `confidencePercent`.
 *
 * A fight is `slotsPerFight` independent draws, each this monster with chance
 * `killsPerFight / slotsPerFight`; the default of one slot is the ordinary
 * Bernoulli fight. Only two things return the plain unpadded requirement: a
 * confidence of zero, which is the documented off switch, and a per-slot
 * chance that has reached one, where every slot is this monster and there is
 * no randomness left to pad. A mean above one kill a fight is *not* by itself
 * either of those — see the module doc.
 *
 * Whether a monster is handed out on a fixed schedule (a boss, a dungeon's
 * fixed-wave roster) is a fact about the game data, not about `p`, so it is the
 * caller's to state — see {@link padFightCount}'s `deterministic`.
 *
 * @param {Object} input
 * @param {number} input.killsNeeded - kills still wanted, `k`
 * @param {number} input.killsPerFight - kills of this monster per fight, `p`
 * @param {number} [input.slotsPerFight] - monster slots one fight draws, `b`;
 *   omitted or unusable means "not known", which keeps the single-draw fight
 *   while `p ≤ 1` and is conservative above it
 * @param {number} [input.confidencePercent=90] - how often the queue should suffice
 * @returns {number|null} fights to queue, or null when `p` is unknown or not positive
 */
export function fightsForKillConfidence({
    killsNeeded,
    killsPerFight,
    slotsPerFight = null,
    confidencePercent = 90,
} = {}) {
    const k = Math.ceil(Number(killsNeeded) || 0);
    const p = Number(killsPerFight);
    if (!(k > 0)) return 0;
    if (!Number.isFinite(p) || !(p > 0)) return null;

    const expected = Math.ceil(k / p - 1e-9);
    const slots = resolveSlots(p, slotsPerFight);
    const perSlot = p / slots;
    if (!(perSlot < 1)) return expected;

    const confidence = Math.min(MAX_CONFIDENCE, Math.max(0, (Number(confidencePercent) || 0) / 100));
    if (!(confidence > 0)) return expected;

    const slotsNeeded = slotsForKillConfidence(k, perSlot, confidence);
    return Math.min(MAX_FIGHTS, Math.ceil(slotsNeeded / slots));
}

/**
 * One kill threshold a queued stay has to clear.
 * @typedef {Object} FightThreshold
 * @property {number} killsNeeded - kills still wanted
 * @property {number} killsPerFight - kills of this monster per fight
 * @property {number} [slotsPerFight] - monster slots one fight draws; a
 *   dungeon clear has as many as its random waves have spawn slots, and
 *   omitting it means "not known"
 * @property {boolean} [deterministic] - true for a kill count the game hands
 *   out on a schedule rather than out of a spawn table — a boss, or a dungeon
 *   monster that only ever appears in `fixedSpawnsMap` — which needs no padding
 */

/**
 * Size a fight count so every threshold in it clears at the stated confidence.
 *
 * The count never shrinks: `unpaddedFights` is a floor, and so is the flat
 * `floorPercent` buffer, which is kept so that nobody's existing padding gets
 * smaller than it was. The one exception is the case that flat buffer was
 * always wrong for — a stay whose every threshold is deterministic gets no
 * flat buffer either, because there is no variance there to buffer against.
 *
 * When no threshold can be priced (the fights-per-hour a rate needs is not
 * known), this falls back to the flat buffer rather than guessing at a rate.
 *
 * @param {Object} input
 * @param {number} input.unpaddedFights - the prediction as it stands, the floor
 * @param {Array<FightThreshold>} [input.thresholds] - what the stay has to clear
 * @param {number} [input.confidencePercent=90] - 0 turns the variance padding off
 * @param {number} [input.floorPercent=0] - the flat minimum buffer, in percent
 * @returns {{fights: number, basis: 'confidence'|'flat'|'deterministic'|'unpadded'}}
 *   `basis` names what set the number: the confidence quantile, the flat floor,
 *   a deterministic requirement, or the untouched prediction.
 */
export function padFightCount({ unpaddedFights, thresholds = [], confidencePercent = 90, floorPercent = 0 } = {}) {
    const base = Math.max(0, Math.ceil(Number(unpaddedFights) || 0));
    const list = (thresholds || []).filter((t) => t && Number(t.killsNeeded) > 0);

    let required = 0;
    let priced = 0;
    let randomCount = 0;
    const confidence = Math.max(0, Number(confidencePercent) || 0);
    for (const threshold of list) {
        const p = Number(threshold.killsPerFight);
        if (!Number.isFinite(p) || !(p > 0)) continue;
        priced += 1;
        // Deterministic is a statement about the game data — a boss, a fixed
        // dungeon wave — plus the one case the rate settles by itself: every
        // slot in the fight is this monster. A mean above one kill a fight is
        // not enough on its own; a dungeon's spawn table is random *within* a
        // clear, and treating it as arithmetic is what stranded people.
        const slots = resolveSlots(p, threshold.slotsPerFight);
        const deterministic = Boolean(threshold.deterministic) || p / slots >= 1;
        if (!deterministic) randomCount += 1;
        const need = deterministic
            ? Math.ceil(Number(threshold.killsNeeded) / p - 1e-9)
            : fightsForKillConfidence({
                  killsNeeded: threshold.killsNeeded,
                  killsPerFight: p,
                  slotsPerFight: threshold.slotsPerFight,
                  confidencePercent: confidence,
              });
        if (Number.isFinite(need)) required = Math.max(required, need);
    }

    // No flat buffer where there is no randomness to buffer: a boss-only stay
    // is the fix, not a regression. An unpriced stay keeps the flat buffer,
    // because "we could not form a rate" is not "there is no variance".
    const flatApplies = priced === 0 || randomCount > 0;
    const floor = Math.max(0, Number(floorPercent) || 0);
    const flat = flatApplies && floor > 0 ? Math.ceil(base * (1 + floor / 100) - 1e-9) : base;

    const fights = Math.max(base, flat, required);
    let basis = 'unpadded';
    if (fights > base) basis = required >= fights ? 'confidence' : 'flat';
    if (basis === 'confidence' && randomCount === 0) basis = 'deterministic';
    return { fights, basis };
}
