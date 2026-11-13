/**
 * Talisman orb costs for the line ranking
 *
 * Expected orb spend to reach a target (up to four lines, each with a minimum grade), from the reroll advisor's exact
 * solver (utils/talisman-reroll-solver.js), on the same orb scale (utils/talisman-orb-weights.js):
 *
 * - From a fresh talisman: created, then lines added with cores up to the full count, then rerolled. Lines from
 *   creation and cores were measured (MEASURED_ODDS.freshLineGrades): G1-G3 only, the Reforging curve cut at G3,
 *   whatever the core; types by weight, never repeated. The cores themselves are not priced: they are the same for
 *   every target, and listed apart.
 * - From a talisman the player owns: the solver's own advice for its current lines (a pending roll included).
 *
 * A solve's cost depends only on the line count and the multiset of wanted (draw weight, focusable, minimum grade):
 * every weight-1 line looks the same to the solver, and so does every special line. Solves are cached on that
 * shape and handed to a target with other hrids by renaming the wanted slots, so a whole ranking needs a handful.
 *
 * Solves run in time slices (`solveSteps`), yield to the page between slices, and stop on the abort signal.
 */

import { MEASURED_ODDS, buildProblem, advise, gradeOdds, isFocusable, solveSteps } from './talisman-reroll-solver.js';

/** Time one slice of a solve may take before the page gets a turn */
const SLICE_MS = 8;

/** The orb a cost is counted in: a full reroll at the top grade (Reforging), else the first full-reroll orb */
const FULL_MODE = '/talisman_reroll_modes/full';

/**
 * The orb costs are counted in, and its weight.
 * @param {Object} info - talismanInfo
 * @param {Object<string, number>} weights
 * @returns {{hrid: string, weight: number}|null}
 */
export function referenceOrb(info, weights) {
    const entries = Object.entries(info?.rerollInputMap || {}).filter(([hrid]) => weights?.[hrid] > 0);
    const maxGrade = Number(info?.maxGrade) || 6;
    const pick =
        entries.find(([hrid]) => hrid === '/items/reforging_orb') ||
        entries.find(([, input]) => input?.modeHrid === FULL_MODE && Number(input.gradeCap) >= maxGrade) ||
        entries.find(([, input]) => input?.modeHrid === FULL_MODE) ||
        entries[0];
    return pick ? { hrid: pick[0], weight: weights[pick[0]] } : null;
}

/**
 * What a fresh talisman costs in cores, from `talismanInfo` (create, then one add per extra line).
 * @param {Object} info
 * @param {number} lines
 * @returns {Object<string, number>} Core item hrid to count
 */
export function freshCores(info, lines) {
    const cores = {};
    const add = (hrid, count) => {
        if (hrid && count > 0) cores[hrid] = (cores[hrid] || 0) + count;
    };
    add(info?.createInputItemHrid, 1);
    for (let line = 2; line <= lines; line++) {
        const input = info?.addModifierInputMap?.[line] ?? info?.addModifierInputMap?.[String(line)];
        add(input?.itemHrid, Number(input?.count) || 0);
    }
    return cores;
}

/**
 * A target's solve shape: what the solver's cost depends on.
 * @param {number} n - Lines on the talisman
 * @param {Array<{hrid: string, minGrade: number}>} targets
 * @param {Object} modifierDetailMap
 * @returns {{key: string, sorted: Array<{hrid: string, minGrade: number}>}}
 */
export function solveShape(n, targets, modifierDetailMap) {
    const tag = (t) => {
        const detail = modifierDetailMap?.[t.hrid];
        return `${Number(detail?.weight) || 0}/${isFocusable(detail) ? 1 : 0}/${Math.floor(t.minGrade)}`;
    };
    const sorted = [...targets].sort((a, b) => tag(a).localeCompare(tag(b)) || a.hrid.localeCompare(b.hrid));
    return { key: `${n}|${sorted.map(tag).join(',')}`, sorted };
}

/**
 * A cached solution renamed to other hrids of the same shape (the wanted slots line up by the shape's order).
 * @param {Object} solution
 * @param {Array<{hrid: string, minGrade: number}>} sorted - The target in shape order
 * @returns {Object}
 */
function renamed(solution, sorted) {
    const wanted = solution.problem.wanted.map((w, i) => ({ ...w, hrid: sorted[i].hrid }));
    return { ...solution, problem: { ...solution.problem, wanted } };
}

/**
 * Expected cost from a fresh talisman: the solver's value averaged over the talisman's first lines: types by weight
 * without replacement (junk types lumped as the solver lumps them), grades by the measured creation-and-core curve
 * (G1-G3 only, see MEASURED_ODDS.freshLineGrades).
 * @param {Object} solution
 * @returns {{value: number, counts: Object<string, number>, mass: number, metAtStart: number}} value is Infinity
 *   when some start cannot reach the target
 */
export function freshTalismanCost(solution) {
    const { n, wanted, junkWeight, junkCount, maxGrade } = solution.problem;
    const avgJunk = junkCount > 0 ? junkWeight / junkCount : 0;
    // Creation and cores roll at most G3: the Reforging curve cut there (measured, 396 lines)
    const odds = gradeOdds(Math.min(maxGrade, MEASURED_ODDS.freshLineGrades.cap));
    // Label multisets first (the draw order does not matter to the state), each with its probability
    const labelSets = new Map();
    const draw = (labels, used, junk, p) => {
        if (labels.length === n) {
            const key = [...labels].sort((a, b) => a - b).join(',');
            labelSets.set(key, (labelSets.get(key) || 0) + p);
            return;
        }
        const junkLeft = junkCount > junk ? Math.max(0, junkWeight - junk * avgJunk) : 0;
        let remaining = junkLeft;
        wanted.forEach((w, i) => {
            if (!(used & (1 << (i + 1)))) remaining += w.weight;
        });
        if (!(remaining > 0)) return;
        wanted.forEach((w, i) => {
            const bit = 1 << (i + 1);
            if (!(used & bit)) draw([...labels, i + 1], used | bit, junk, (p * w.weight) / remaining);
        });
        if (junkLeft > 0) draw([...labels, 0], used, junk + 1, (p * junkLeft) / remaining);
    };
    draw([], 0, 0, 1);

    const K = solution.orbHrids.length;
    const acc = { value: 0, mass: 0, met: 0, totals: new Array(K).fill(0) };
    const grades = (labels, i, codes, q) => {
        if (i === labels.length) {
            const index = solution.indexOf(-1, codes);
            const v = index === undefined ? Infinity : solution.V[index];
            acc.mass += q;
            if (v === 0) acc.met += q;
            acc.value += v === 0 ? 0 : q * v;
            if (Number.isFinite(v)) for (let k = 0; k < K; k++) acc.totals[k] += q * solution.E[index * K + k];
            return;
        }
        odds.forEach((o, g) => grades(labels, i + 1, [...codes, solution.codeOf(labels[i], g + 1)], q * o));
    };
    for (const [key, p] of labelSets) grades(key.split(',').map(Number), 0, [], p);
    const { value, mass, met, totals } = acc;
    const counts = {};
    solution.orbHrids.forEach((hrid, k) => {
        if (hrid && totals[k] > 1e-9) counts[hrid] = totals[k] / (mass || 1);
    });
    // `metAtStart`: the chance the talisman's first lines already meet the target
    return { value: mass > 0 ? value / mass : Infinity, counts, mass, metAtStart: mass > 0 ? met / mass : 0 };
}

/**
 * Solves on one orb scale, cached by shape, sliced and cancellable.
 */
export class OrbCostSolver {
    /**
     * @param {Object} params
     * @param {Object} params.info - talismanInfo
     * @param {Object} params.modifierDetailMap
     * @param {{weights: Object, prices: Object, scale: string}} params.scale - From `orbWeights`
     * @param {Function} [params.abortSignal]
     * @param {Function} [params.yieldNow]
     * @param {Function} [params.now]
     * @param {number} [params.maxSolves] - Most distinct solves this solver will run
     */
    constructor({ info, modifierDetailMap, scale, abortSignal, yieldNow, now, maxSolves = 40 }) {
        this.info = info;
        this.modifierDetailMap = modifierDetailMap;
        this.scale = scale;
        this.reference = referenceOrb(info, scale?.weights);
        this.abortSignal = abortSignal || (() => false);
        this.yieldNow = yieldNow || (() => new Promise((resolve) => setTimeout(resolve, 0)));
        this.now = now || (() => Date.now());
        this.maxSolves = maxSolves;
        this.cache = new Map();
        this.solves = 0;
        this.cancelled = false;
        this.limited = false;
        /** Called as each new solve starts: `(solves, maxSolves)`, for a progress line */
        this.onSolve = null;
    }

    /** @returns {boolean} */
    stopped() {
        if (this.abortSignal()) this.cancelled = true;
        return this.cancelled;
    }

    /**
     * The solution for a target on an n-line talisman, or null (cancelled, over the solve limit, nothing to solve).
     * @param {string} typeHrid
     * @param {number} n
     * @param {Array<{hrid: string, minGrade: number}>} targets
     * @returns {Promise<Object|null>}
     */
    async solutionFor(typeHrid, n, targets) {
        const { key, sorted } = solveShape(n, targets, this.modifierDetailMap);
        const fullKey = `${typeHrid}|${key}`;
        if (!this.cache.has(fullKey)) {
            if (this.stopped()) return null;
            if (this.solves >= this.maxSolves) {
                this.limited = true;
                return null;
            }
            this.solves++;
            this.onSolve?.(this.solves, this.maxSolves);
            const built = buildProblem({
                talismanTypeHrid: typeHrid,
                lineCount: n,
                targets: sorted,
                info: this.info,
                modifierDetailMap: this.modifierDetailMap,
                weights: this.scale?.weights,
            });
            if (built.status !== 'ok') {
                this.cache.set(fullKey, null);
            } else {
                const runner = solveSteps(built.problem);
                let step = runner.next();
                let sliceStart = this.now();
                while (!step.done) {
                    if (this.now() - sliceStart > SLICE_MS) {
                        await this.yieldNow();
                        if (this.stopped()) return null;
                        sliceStart = this.now();
                    }
                    step = runner.next();
                }
                this.cache.set(fullKey, step.value);
            }
        }
        const solution = this.cache.get(fullKey);
        return solution ? renamed(solution, sorted) : null;
    }

    /**
     * The solver's own limits on a solution, as the reroll advisor states them: grades clamped below the top (an
     * Attunement step down from a clamped line is taken from the clamp, pessimistic) and Mutation left out of a large
     * state space. Either one makes the cost an upper bound.
     * @param {Object} solution
     * @returns {{limits: {gradeClamped: boolean, clampGrade: number, mutationLeftOut: boolean}, upperBound: boolean}}
     */
    limitsOf(solution) {
        const limits = {
            gradeClamped: Boolean(solution?.problem?.gradeClamped),
            clampGrade: Number(solution?.problem?.G) || 0,
            mutationLeftOut: solution?.mutationUsed === false,
        };
        return { limits, upperBound: limits.gradeClamped || limits.mutationLeftOut };
    }

    /** Weighted value in reference orbs */
    inOrbs(value) {
        return this.reference?.weight > 0 ? value / this.reference.weight : value;
    }

    /**
     * Expected cost of a target from a fresh talisman with the full line count.
     * @returns {Promise<{orbs: number, counts: Object, assumedFresh: true}|null>}
     */
    async freshCost(typeHrid, targets) {
        const n = Number(this.info?.maxModifierCount) || 4;
        const solution = await this.solutionFor(typeHrid, n, targets);
        if (!solution) return null;
        const { value, counts } = freshTalismanCost(solution);
        if (!Number.isFinite(value)) return null;
        return { orbs: this.inOrbs(value), counts, fresh: true, ...this.limitsOf(solution) };
    }

    /**
     * Expected cost of a target from an owned talisman's current lines.
     * @returns {Promise<{orbs: number, counts: Object, status: string}|null>}
     */
    async ownedCost(talisman, targets) {
        const n = (talisman?.modifiers || []).length;
        if (n === 0 || targets.length > n) return null;
        const solution = await this.solutionFor(talisman.talismanTypeHrid, n, targets);
        if (!solution) return null;
        const advice = advise(solution, talisman, targets);
        if (!Number.isFinite(advice?.value)) return null;
        return {
            orbs: this.inOrbs(advice.value),
            counts: advice.counts || {},
            status: advice.status,
            ...this.limitsOf(solution),
        };
    }
}
