/**
 * Recommended skilling trial sign-ups: who should go to which of the cycle's skilling trials.
 *
 * Pure. The UI gathers the cycle (drawn trials, roster, slot caps, current sign-ups) and each
 * member's rate inputs; this module scores and searches. Combat assignment is out of scope.
 *
 * ## The rate model
 *
 * A skilling trial is worked the way a Labyrinth skilling room is (the game draws both with
 * one progress component): each action succeeds with the two-slope curve in
 * {@link skillingSuccessAtTier}, a success adds `floor(effectiveLevel × (1 + efficiency))`
 * work, and a double-progress roll doubles it. The one complete recorded reading (Crafting,
 * tier 10: 8.0% success, 161 work power at 61.54% efficiency) is reproduced on both counts by
 * effective level 100 and by no other level, so one effective level drives success and work
 * power alike. Action time and how efficiency is composed have no reading to check against,
 * so they stay inputs.
 *
 * ## Scoring
 *
 * Each trial is walked tier by tier with expected rates: a tier takes
 * `pool(tier, signups) / Σ member work per second at that tier`, and the walk stops when the
 * trial's time runs out, adding the partial-tier credit for the unfinished tier. The walk is
 * repeated under a few fixed rate multipliers ({@link ASSIGN_JITTER}) and averaged, so a
 * roster that clears a tier with a second to spare is not preferred over one that misses it
 * by a second — the rates themselves are not that precise.
 *
 * ## Search
 *
 * Greedy insertion by marginal points, then single moves and pairwise swaps until nothing
 * improves, from a few seeded restarts. Pinned members are fixed. In `'bench'` mode a member
 * may be left out of skilling; in `'fill'` mode every placeable member gets a slot while the
 * slots last.
 */
import { skillingSuccessAtTier, trialRandom } from './guild-trial-model.js';
import { TRIAL_MAX_TIER, tierPoolWork, tierMarginalPoints, partialTierCredit } from '../guild/guild-trials-math.js';
import { yieldToBrowser } from '../../utils/yield-to-browser.js';

/** Rate multipliers each trial is scored under; their mean is the trial's score */
export const ASSIGN_JITTER = Object.freeze([0.9, 0.95, 1, 1.05, 1.1]);

/** A trial's time budget, in seconds */
export const TRIAL_SECONDS = 3600;

/** Base slots per skilling trial before the Skilling Encampment */
export const BASE_SKILLING_SLOTS = 20;

/** The objective modes */
export const ASSIGN_MODES = Object.freeze({ Bench: 'bench', Fill: 'fill' });

/** The pin value that keeps a member out of skilling */
export const BENCH_PIN = 'bench';

const EPSILON = 1e-9;

/** Improvement passes per restart; each pass tries every single move and every swap */
const MAX_PASSES = 25;

/**
 * Expected work per second a member adds at each tier.
 *
 * @param {Object} input - `{workPower, actionSeconds, doubleChance}` plus a success model:
 *   `{effectiveLevel, successBonus}` (the game curve) or `{successRate, referenceTier, successLossPerTier}`
 * @returns {Float64Array} Indexed by tier, 1..{@link TRIAL_MAX_TIER}; index 0 unused
 */
export function memberTierRates(input) {
    const rates = new Float64Array(TRIAL_MAX_TIER + 1);
    const power = Math.floor(Number(input?.workPower));
    const seconds = Number(input?.actionSeconds);
    if (!(power > 0) || !(seconds > 0)) return rates;
    const double = Math.min(1, Math.max(0, Number(input.doubleChance) || 0));
    const curve =
        input.effectiveLevel != null
            ? { effectiveLevel: Number(input.effectiveLevel), successBonus: Number(input.successBonus) || 0 }
            : {
                  successRate: Number(input.successRate),
                  referenceTier: Number(input.referenceTier) || 1,
                  successLossPerTier: Number(input.successLossPerTier ?? 0.08),
              };
    for (let tier = 1; tier <= TRIAL_MAX_TIER; tier++) {
        const success = skillingSuccessAtTier(curve, tier);
        rates[tier] = Number.isFinite(success) ? (power * success * (1 + double)) / seconds : 0;
    }
    return rates;
}

/**
 * Rate inputs for a member known only by effective level, under assumed efficiency and timing.
 *
 * @param {number} effectiveLevel - Skill level plus any level bonuses
 * @param {{efficiency: number, actionSeconds: number, doubleChance?: number, successBonus?: number}} assumed
 * @returns {Object|null} Inputs for {@link memberTierRates}, or null for an unusable level
 */
export function rateInputFromLevel(effectiveLevel, assumed) {
    const level = Number(effectiveLevel);
    if (!Number.isFinite(level) || level < 1 || level > 1000) return null;
    return {
        effectiveLevel: level,
        successBonus: Number(assumed?.successBonus) || 0,
        workPower: level * (1 + (Number(assumed?.efficiency) || 0)),
        actionSeconds: Number(assumed?.actionSeconds) || 10,
        doubleChance: Number(assumed?.doubleChance) || 0,
    };
}

/**
 * One trial's expected outcome from its summed rates.
 *
 * @param {Float64Array|number[]} rates - Summed work per second by tier
 * @param {number} participants - Sign-ups, each adding 1% to every tier's pool
 * @param {{baseWork: number, seconds?: number, jitter?: readonly number[]}} options
 * @returns {{points: number, tiers: number, nominalTiers: number, nominalProgress: number}}
 *   Mean base points and banked tiers over the jitter, and the tiers/progress at the nominal rate
 */
export function scoreTrial(rates, participants, { baseWork, seconds = TRIAL_SECONDS, jitter = ASSIGN_JITTER }) {
    let points = 0;
    let tiers = 0;
    let nominalTiers = 0;
    let nominalProgress = 0;
    for (const factor of jitter) {
        let left = seconds;
        let cleared = 0;
        let earned = 0;
        let progress = 0;
        for (let tier = 1; tier <= TRIAL_MAX_TIER; tier++) {
            const rate = rates[tier] * factor;
            if (!(rate > 0)) break;
            const pool = tierPoolWork({ baseWork, tier, participants });
            const time = pool / rate;
            if (time <= left) {
                left -= time;
                cleared = tier;
                earned += tierMarginalPoints('skilling', tier);
                continue;
            }
            progress = (left * rate) / pool;
            earned += tierMarginalPoints('skilling', tier) * partialTierCredit(progress);
            break;
        }
        points += earned;
        tiers += cleared;
        if (factor === 1) {
            nominalTiers = cleared;
            nominalProgress = progress;
        }
    }
    return { points: points / jitter.length, tiers: tiers / jitter.length, nominalTiers, nominalProgress };
}

/**
 * Validate and normalize an assignment problem.
 * @param {Object} problem - See {@link optimizeTrialAssignment}
 * @returns {Object} Internal state
 */
function prepare(problem) {
    const trials = [...new Set((problem?.trials || []).filter((hrid) => /^\/guild_skilling\/[a-z_]+$/.test(hrid)))];
    if (!trials.length) throw new Error('No skilling trials to assign.');
    const baseWork = Number(problem.baseWork);
    if (!(baseWork > 0)) throw new Error('Base work must be positive.');
    const seconds = Number(problem.seconds ?? TRIAL_SECONDS);
    if (!(seconds > 0 && seconds <= TRIAL_SECONDS)) throw new Error('Trial time must be between 0 and 60 minutes.');
    const mode = problem.mode === ASSIGN_MODES.Fill ? ASSIGN_MODES.Fill : ASSIGN_MODES.Bench;
    const caps = trials.map((hrid) => {
        const cap = Math.floor(Number(problem.caps?.[hrid] ?? problem.cap));
        return Number.isFinite(cap) && cap >= 0 ? cap : BASE_SKILLING_SLOTS;
    });
    const seen = new Set();
    const members = [];
    for (const raw of problem.members || []) {
        const id = String(raw?.id ?? '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const rates = trials.map((hrid) => (raw.rates?.[hrid] ? memberTierRates(raw.rates[hrid]) : null));
        // A pin to a trial that was not drawn is no pin at all; a pin to a drawn trial the member
        // has no rate for still counts them as a participant
        const pinned = raw.pin === BENCH_PIN ? -1 : trials.indexOf(raw.pin);
        const current = trials.indexOf(raw.current);
        const inCombat = raw.inCombat === true;
        members.push({
            id,
            name: String(raw.name || id),
            rates,
            pin: raw.pin === BENCH_PIN || pinned >= 0 ? pinned : null,
            current: current >= 0 ? current : -1,
            inCombat,
            // Leaving skilling costs the weekly participation bonus unless the member is in combat,
            // so only combat sign-ups are benched for points; anyone else is benched only for slots
            mustPlace: mode === ASSIGN_MODES.Fill || !inCombat,
        });
    }
    dropOverflowPins(members, caps);
    return {
        trials,
        caps,
        mode,
        options: { baseWork, seconds, jitter: problem.jitter || ASSIGN_JITTER },
        members,
        zero: new Float64Array(TRIAL_MAX_TIER + 1),
        marginal: Float64Array.from({ length: TRIAL_MAX_TIER + 1 }, (_, tier) =>
            tier ? tierMarginalPoints('skilling', tier) : 0
        ),
        poolsBySignups: new Map(),
    };
}

/**
 * Every tier's pool for a sign-up count, computed once per count rather than per tier walked.
 * @param {Object} state - Prepared problem
 * @param {number} participants - Sign-ups
 * @returns {Float64Array} Indexed by tier
 */
function poolsFor(state, participants) {
    let pools = state.poolsBySignups.get(participants);
    if (!pools) {
        pools = new Float64Array(TRIAL_MAX_TIER + 1);
        for (let tier = 1; tier <= TRIAL_MAX_TIER; tier++) {
            pools[tier] = tierPoolWork({ baseWork: state.options.baseWork, tier, participants });
        }
        state.poolsBySignups.set(participants, pools);
    }
    return pools;
}

/**
 * Pins past a trial's slots cannot all be honored: keep members already signed up there first,
 * then the rest in roster order, and let the others be placed freely, marked `pinDropped`.
 */
function dropOverflowPins(members, caps) {
    const order = members
        .map((member, index) => ({ member, index }))
        .filter(({ member }) => member.pin != null && member.pin >= 0)
        .sort((a, b) => (b.member.current === b.member.pin) - (a.member.current === a.member.pin) || a.index - b.index);
    const used = caps.map(() => 0);
    for (const { member } of order) {
        if (used[member.pin] < caps[member.pin]) used[member.pin]++;
        else {
            member.pin = null;
            member.pinDropped = true;
        }
    }
}

/** Per-trial running sums for one assignment */
class Sheet {
    constructor(state, assignment) {
        this.state = state;
        this.assignment = Int32Array.from(assignment);
        this.sums = state.trials.map(() => new Float64Array(TRIAL_MAX_TIER + 1));
        this.counts = state.trials.map(() => 0);
        for (const [m, t] of this.assignment.entries()) if (t >= 0) this.add(m, t);
        this.scores = state.trials.map((_, t) => this.score(t));
    }

    rate(m, t) {
        return this.state.members[m].rates[t] || this.state.zero;
    }

    add(m, t, sign = 1) {
        const rates = this.rate(m, t);
        const sum = this.sums[t];
        for (let i = 1; i < sum.length; i++) sum[i] += sign * rates[i];
        this.counts[t] += sign;
    }

    /**
     * {@link scoreTrial}'s mean points for trial `t`, optionally without member `out` and with
     * member `inn`. The search's hot path: it walks the summed rates in place, with pools cached
     * per sign-up count, instead of copying the rates and building a pool per tier. The arithmetic
     * is the same, operation for operation, so the scores are identical.
     */
    score(t, out = null, inn = null) {
        const { options, marginal } = this.state;
        const sum = this.sums[t];
        const outRates = out != null ? this.rate(out, t) : null;
        const inRates = inn != null ? this.rate(inn, t) : null;
        const count = this.counts[t] - (out != null ? 1 : 0) + (inn != null ? 1 : 0);
        const pools = poolsFor(this.state, count);
        const jitter = options.jitter;
        let points = 0;
        for (let j = 0; j < jitter.length; j++) {
            const factor = jitter[j];
            let left = options.seconds;
            let earned = 0;
            for (let tier = 1; tier <= TRIAL_MAX_TIER; tier++) {
                let work = sum[tier];
                if (outRates) work -= outRates[tier];
                if (inRates) work += inRates[tier];
                if (work < 0) work = 0;
                const rate = work * factor;
                if (!(rate > 0)) break;
                const pool = pools[tier];
                const time = pool / rate;
                if (time <= left) {
                    left -= time;
                    earned += marginal[tier];
                    continue;
                }
                earned += marginal[tier] * partialTierCredit((left * rate) / pool);
                break;
            }
            points += earned;
        }
        return points / jitter.length;
    }

    total() {
        return this.scores.reduce((sum, points) => sum + points, 0);
    }

    move(m, to) {
        const from = this.assignment[m];
        if (from === to) return;
        // When each trial (the bench last) last changed, so an evaluation of an unchanged pair of
        // trials can be skipped: its answer cannot have changed
        const bench = this.state.trials.length;
        this.clock = (this.clock || 0) + 1;
        this.changedAt ||= new Float64Array(bench + 1);
        this.changedAt[from < 0 ? bench : from] = this.clock;
        this.changedAt[to < 0 ? bench : to] = this.clock;
        if (from >= 0) this.add(m, from, -1);
        if (to >= 0) this.add(m, to, 1);
        this.assignment[m] = to;
        if (from >= 0) this.scores[from] = this.score(from);
        if (to >= 0) this.scores[to] = this.score(to);
    }

    /** Gain from moving `m` to trial `to` (-1 benches) */
    moveGain(m, to) {
        const from = this.assignment[m];
        if (from === to) return 0;
        let gain = 0;
        if (from >= 0) gain += this.score(from, m) - this.scores[from];
        if (to >= 0) gain += this.score(to, null, m) - this.scores[to];
        return gain;
    }

    /** Gain from exchanging the places of `a` and `b` */
    swapGain(a, b) {
        const ta = this.assignment[a];
        const tb = this.assignment[b];
        if (ta === tb) return 0;
        let gain = 0;
        if (ta >= 0) gain += this.score(ta, a, b) - this.scores[ta];
        if (tb >= 0) gain += this.score(tb, b, a) - this.scores[tb];
        return gain;
    }
}

/** Whether a member may be placed in trial `t` (-1 is the bench) */
function canPlace(state, m, t) {
    const member = state.members[m];
    if (member.pin != null) return member.pin === t;
    if (t < 0) return true;
    return member.rates[t] != null;
}

/** Members the search may move */
function freeMembers(state) {
    const free = [];
    for (const [m, member] of state.members.entries()) if (member.pin == null) free.push(m);
    return free;
}

/** Pinned members placed, everyone else benched */
function pinnedStart(state) {
    return state.members.map((member) => (member.pin != null ? member.pin : -1));
}

/**
 * Greedy insertion. Without `order`, each step places the (member, trial) pair with the largest
 * marginal points; with it, members are placed one at a time in that order at their best trial.
 */
function* greedy(state, order = null) {
    const sheet = new Sheet(state, pinnedStart(state));
    const free = new Set(freeMembers(state));
    const room = (t) => sheet.counts[t] < state.caps[t];
    const best = (m) => {
        let pick = null;
        for (let t = 0; t < state.trials.length; t++) {
            if (!room(t) || !canPlace(state, m, t)) continue;
            const gain = sheet.moveGain(m, t);
            if (!pick || gain > pick.gain + EPSILON) pick = { m, t, gain };
        }
        return pick;
    };
    const accept = (pick) => pick && (state.members[pick.m].mustPlace || pick.gain > EPSILON);
    if (order) {
        for (const m of order) {
            if (!free.has(m)) continue;
            const pick = best(m);
            if (accept(pick)) sheet.move(m, pick.t);
            yield;
        }
        return sheet;
    }
    while (free.size) {
        let pick = null;
        for (const m of free) {
            const candidate = best(m);
            if (accept(candidate) && (!pick || candidate.gain > pick.gain + EPSILON)) pick = candidate;
        }
        if (!accept(pick)) break;
        sheet.move(pick.m, pick.t);
        free.delete(pick.m);
        yield;
    }
    return sheet;
}

/**
 * Place every member who must be placed wherever any placement can, before points decide anything.
 *
 * Greedy insertion can fill the one trial a member is eligible for with somebody who could have
 * gone elsewhere, and no single move or swap that loses points undoes it. This is a maximum
 * bipartite matching with capacities (Kuhn's augmenting paths): for each benched must-place
 * member, look for a trial with room, a trial holding an optional member who can be benched, or
 * a trial whose must-place occupant can itself be moved on along such a path. A member who fails
 * once cannot succeed later, so one try each gives the most members placed. Pinned members stay.
 */
function* placeEveryone(state, sheet) {
    const occupants = (t) => {
        const out = [];
        for (const [m, at] of sheet.assignment.entries()) if (at === t && state.members[m].pin == null) out.push(m);
        return out;
    };
    const augment = (m, visited) => {
        const eligible = [];
        for (let t = 0; t < state.trials.length; t++) {
            if (!visited.has(t) && canPlace(state, m, t)) eligible.push(t);
        }
        for (const t of eligible) visited.add(t);
        for (const t of eligible) {
            if (sheet.counts[t] < state.caps[t]) {
                sheet.move(m, t);
                return true;
            }
            const optional = occupants(t).find((x) => !state.members[x].mustPlace);
            if (optional != null) {
                sheet.move(optional, -1);
                sheet.move(m, t);
                return true;
            }
        }
        for (const t of eligible) {
            for (const x of occupants(t)) {
                if (augment(x, visited)) {
                    sheet.move(m, t);
                    return true;
                }
            }
        }
        return false;
    };
    for (const m of freeMembers(state)) {
        if (!state.members[m].mustPlace || sheet.assignment[m] >= 0) continue;
        augment(m, new Set());
        yield;
    }
    return sheet;
}

/** One improving pass of single moves then swaps; true when anything changed */
function* improve(state, sheet) {
    const free = freeMembers(state);
    const bench = state.trials.length;
    sheet.changedAt ||= new Float64Array(bench + 1);
    sheet.clock ||= 0;
    // Clock readings at which a member's moves, or a pair's swap, were last found not to improve.
    // Moves and swaps read only the trials involved, so while none of them has changed since,
    // re-evaluating would give the same answer and is skipped. Results are unchanged.
    sheet.moveStamp ||= new Float64Array(state.members.length).fill(-1);
    sheet.pairStamp ||= new Float64Array(free.length * free.length).fill(-1);
    const slot = (t) => (t < 0 ? bench : t);
    const unchangedSince = (stamp) => {
        if (stamp < 0) return false;
        for (let t = 0; t <= bench; t++) if (sheet.changedAt[t] > stamp) return false;
        return true;
    };
    let changed = false;
    for (const m of free) {
        if (unchangedSince(sheet.moveStamp[m])) {
            yield;
            continue;
        }
        const from = sheet.assignment[m];
        let pick = null;
        for (let t = -1; t < state.trials.length; t++) {
            if (t === from || !canPlace(state, m, t)) continue;
            // A member who must be placed stays placed; a full trial is reached by a swap instead
            if (t < 0 && state.members[m].mustPlace) continue;
            if (t >= 0 && sheet.counts[t] >= state.caps[t]) continue;
            const gain = sheet.moveGain(m, t);
            if (gain > EPSILON && (!pick || gain > pick.gain)) pick = { t, gain };
        }
        if (pick) {
            sheet.move(m, pick.t);
            changed = true;
        } else sheet.moveStamp[m] = sheet.clock;
        yield;
    }
    for (let i = 0; i < free.length; i++) {
        yield;
        for (let j = i + 1; j < free.length; j++) {
            const a = free[i];
            const b = free[j];
            const ta = sheet.assignment[a];
            const tb = sheet.assignment[b];
            const key = i * free.length + j;
            const stamp = sheet.pairStamp[key];
            if (stamp >= 0 && sheet.changedAt[slot(ta)] <= stamp && sheet.changedAt[slot(tb)] <= stamp) continue;
            sheet.pairStamp[key] = sheet.clock;
            if (ta === tb || !canPlace(state, a, tb) || !canPlace(state, b, ta)) continue;
            // Benching a member who must be placed is only a trade for another such member
            // left out for want of slots
            const benched = tb < 0 ? a : ta < 0 ? b : null;
            const joining = tb < 0 ? b : ta < 0 ? a : null;
            if (benched != null && state.members[benched].mustPlace && !state.members[joining].mustPlace) continue;
            if (sheet.swapGain(a, b) > EPSILON) {
                sheet.move(a, -1);
                sheet.move(b, ta);
                sheet.move(a, tb);
                changed = true;
            }
        }
    }
    return changed;
}

/** Deterministic Fisher–Yates order of `items` */
function shuffled(items, random) {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

/**
 * Describe a finished sheet.
 * @param {Object} state - Prepared problem
 * @param {Sheet} sheet - The chosen assignment
 * @returns {Object} See {@link optimizeTrialAssignment}
 */
function describe(state, sheet) {
    const trials = state.trials.map((hrid, t) => {
        const detail = scoreTrial(sheet.sums[t], sheet.counts[t], state.options);
        return {
            trialHrid: hrid,
            cap: state.caps[t],
            signups: sheet.counts[t],
            points: detail.points,
            meanTiers: detail.tiers,
            nominalTiers: detail.nominalTiers,
            nominalProgress: detail.nominalProgress,
            memberIds: [],
        };
    });
    const members = state.members.map((member, m) => {
        const t = sheet.assignment[m];
        if (t >= 0) trials[t].memberIds.push(member.id);
        return {
            id: member.id,
            name: member.name,
            trialHrid: t >= 0 ? state.trials[t] : null,
            currentTrialHrid: member.current >= 0 ? state.trials[member.current] : null,
            marginalPoints: t >= 0 ? sheet.scores[t] - sheet.score(t, m) : 0,
            pinned: member.pin != null,
            pinDropped: member.pinDropped === true,
            inCombat: member.inCombat,
            hasRate: t >= 0 ? member.rates[t] != null : null,
            losesBonus: t < 0 && !member.inCombat,
        };
    });
    const moves = members
        .filter((member) => member.trialHrid !== member.currentTrialHrid)
        .map((member) => ({ id: member.id, name: member.name, from: member.currentTrialHrid, to: member.trialHrid }));
    return { totalPoints: sheet.total(), trials, members, moves };
}

/** Score of the current sign-ups, for comparison; members are kept where they are */
function currentSheet(state) {
    return new Sheet(
        state,
        state.members.map((member) => member.current)
    );
}

/**
 * Recommend skilling trial sign-ups.
 *
 * @param {Object} problem
 * @param {string[]} problem.trials - The cycle's skilling trial hrids (`/guild_skilling/<skill>`)
 * @param {Array<Object>} problem.members - Eligible members: `{id, name, rates: {trialHrid: rateInput|null},
 *   pin?: trialHrid|'bench', current?: trialHrid|null, inCombat?: boolean}`. A rate input is what
 *   {@link memberTierRates} takes; a trial without one is closed to that member unless pinned.
 * @param {Object<string, number>} [problem.caps] - Slots per trial
 * @param {number} [problem.cap] - Slots for any trial not in `caps`
 * @param {'bench'|'fill'} [problem.mode] - Whether members may be left out of skilling
 * @param {number} problem.baseWork - Tier 1 work before participants
 * @param {number} [problem.seconds] - Trial time
 * @param {number} [problem.seed] - Restart seed
 * @param {number} [problem.restarts] - Randomized restarts after the greedy start
 * @returns {{totalPoints: number, currentPoints: number, trials: Array<Object>, members: Array<Object>,
 *   moves: Array<{id: string, name: string, from: string|null, to: string|null}>}}
 */
export function optimizeTrialAssignment(problem) {
    return runSearch(problem, null);
}

/**
 * {@link optimizeTrialAssignment}, handing the browser a frame between search steps.
 * @param {Object} problem - As for {@link optimizeTrialAssignment}
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<Object>} As for {@link optimizeTrialAssignment}
 */
export async function optimizeTrialAssignmentAsync(problem, { signal } = {}) {
    const started = performance.now();
    const timing = { wallMs: 0, computeMs: 0, yields: 0 };
    let sliceStart = started;
    // Synchronous unless a frame is due: awaiting on every step cost more than the steps did.
    // A hidden page has no frames to keep, and its timers may be throttled to a second, so it is
    // not yielded to; Cancel is still checked at every step.
    const pause = () => {
        if (signal?.aborted) throw new Error('Assignment canceled.');
        const now = performance.now();
        if (now - sliceStart <= YIELD_SLICE_MS || pageHidden()) return null;
        timing.computeMs += now - sliceStart;
        timing.yields++;
        return (async () => {
            await yieldToBrowser();
            sliceStart = performance.now();
            if (signal?.aborted) throw new Error('Assignment canceled.');
        })();
    };
    const result = await runSearch(problem, pause);
    const end = performance.now();
    timing.computeMs += end - sliceStart;
    timing.wallMs = end - started;
    result.timing = timing;
    return result;
}

/** Work between frames handed to the browser, in milliseconds */
const YIELD_SLICE_MS = 12;

/** Whether the page is in a background tab or minimized */
function pageHidden() {
    return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function runSearch(problem, pause) {
    const state = prepare(problem);
    const restarts = Math.max(0, Math.min(20, Math.floor(Number(problem.restarts ?? 4))));
    const random = trialRandom(Number(problem.seed ?? 1) >>> 0);
    const free = freeMembers(state);
    const finish = (best) => {
        const result = describe(state, best);
        result.currentPoints = currentSheet(state).total();
        return result;
    };
    // One search as a sequence of steps; each `yield` is a point the async path may hand the
    // browser a frame, so both paths do exactly the same work in the same order
    function* search() {
        let best = null;
        for (let r = 0; r <= restarts; r++) {
            yield;
            const sheet = yield* greedy(state, r === 0 ? null : shuffled(free, random));
            yield* placeEveryone(state, sheet);
            for (let pass = 0; pass < MAX_PASSES; pass++) {
                yield;
                if (!(yield* improve(state, sheet))) break;
            }
            if (!best || sheet.total() > best.total() + EPSILON) best = sheet;
        }
        return best;
    }
    const steps = search();
    if (!pause) {
        let step = steps.next();
        while (!step.done) step = steps.next();
        return finish(step.value);
    }
    return (async () => {
        let step = steps.next();
        while (!step.done) {
            const wait = pause();
            if (wait) await wait;
            step = steps.next();
        }
        return finish(step.value);
    })();
}

/**
 * The slot cap per skilling trial: 20, plus the Skilling Encampment's slots per level.
 *
 * Mirrors the game's `partyCapForKind`: `min(level, maxLevel) × skillingTrialSlotsPerLevel`.
 *
 * @param {Object} buildingDetailMap - `guildBuildingDetailMap` from the client data
 * @param {Object} levelMap - `guildBuildingLevelMap`
 * @returns {number} Slots per skilling trial
 */
export function skillingSlotCap(buildingDetailMap, levelMap) {
    for (const [hrid, detail] of Object.entries(buildingDetailMap || {})) {
        const perLevel = Number(detail?.skillingTrialSlotsPerLevel);
        if (!(perLevel > 0)) continue;
        const level = Math.max(0, Math.min(Number(levelMap?.[hrid]) || 0, Number(detail.maxLevel) || 0));
        return BASE_SKILLING_SLOTS + Math.floor(level * perLevel);
    }
    return BASE_SKILLING_SLOTS;
}

/** UTF-8 length of a string */
function bytes(text) {
    return new TextEncoder().encode(text).length;
}

/**
 * Chat-ready sign-up messages, each within the chat's byte limit.
 *
 * Each trial is written `Name: A, B, C`; trials are joined with ` | `. A trial too long for one
 * message continues in the next, prefixed `Name (cont.):`.
 *
 * @param {Array<{label: string, names: string[]}>} groups - One per trial, in display order
 * @param {{maxBytes?: number, prefix?: string}} [options]
 * @returns {string[]} Messages
 */
export function signupMessages(groups, { maxBytes = 400, prefix = 'Skilling sign-ups' } = {}) {
    const messages = [];
    let current = `${prefix} — `;
    let empty = true;
    const flush = () => {
        if (!empty) messages.push(current);
        current = `${prefix} — `;
        empty = true;
    };
    for (const group of groups) {
        const names = (group.names || []).filter(Boolean);
        if (!names.length) continue;
        let head = `${group.label}: `;
        let index = 0;
        while (index < names.length) {
            const opener = `${empty ? '' : ' | '}${head}`;
            if (bytes(current + opener + names[index]) > maxBytes) {
                if (empty) {
                    // A single name past the limit is cut rather than dropped or looped on
                    // Cut by code point so a surrogate pair is never split
                    const points = [...names[index]];
                    while (points.length && bytes(current + opener + points.join('')) > maxBytes) points.pop();
                    messages.push(current + opener + points.join(''));
                    index++;
                    head = `${group.label} (cont.): `;
                    continue;
                }
                flush();
                continue;
            }
            current += opener + names[index];
            empty = false;
            index++;
            while (index < names.length && bytes(`${current}, ${names[index]}`) <= maxBytes) {
                current += `, ${names[index]}`;
                index++;
            }
            if (index < names.length) {
                flush();
                head = `${group.label} (cont.): `;
            }
        }
    }
    flush();
    return messages;
}
