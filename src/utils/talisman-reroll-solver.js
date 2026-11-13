/**
 * Talisman reroll solver
 *
 * Given a talisman and a target (up to four wanted lines, each a modifier type and a minimum grade), finds the
 * strategy that reaches the target for the least expected orb spend, and how many of each orb it uses on average.
 *
 * METHOD — exact dynamic program over a compressed state, solved in increasing order of value (Dijkstra-style).
 *
 * State: the talisman's lines as a multiset, each line reduced to (label, grade): its label is the wanted slot
 * whose type it carries, or "junk" for any other type, and its grade, clamped to G. G is the game's top grade
 * whenever the state space fits under CLAMP_STATE_LIMIT, so the model is exact; only a large target clamps lower
 * (never below its highest minimum + 0..2). The locked line, if any, is kept apart. Junk lines are
 * interchangeable, but their grades are kept, because Focus, Exchange and Attunement can turn a junk line's grade
 * into a wanted one.
 *
 * Moves: every orb in `talismanInfo.rerollInputMap` by its mode (full / types_only / random_lines / permute /
 * grade_shift), a Binding Orb lock on any unlocked line (replacing the old lock), and a free unlock. After every
 * reroll the player keeps the better of the old and the new lines, so a reroll never makes things worse. That makes
 * every reroll a self-loop, which is solved in closed form instead of iterated:
 *
 *     V_a(s) = (c_a + Σ_{s' better than s} p(s') V(s')) / P(better)
 *
 * and, because a state only ever moves to states of lower value, every value can be fixed in increasing order,
 * like Dijkstra's shortest paths. A full reroll's outcome distribution depends only on the locked line, and a
 * Focus reroll's only on the locked line and the unlocked grades, so those are computed once per group and shared
 * by every member state. A second pass in the same order counts how many of each orb the chosen policy spends.
 *
 * LIMITS (stated in the advisor's help text where a player would care):
 *  - When G is below the top grade, grades above G are treated as G, and an Attunement step down from a clamped
 *    line is taken from G (pessimistic). With cheap Attunement this can overstate the cost a lot (measured: 186% on
 *    a two-line G3 target at G = 3), which is why G stays at the top grade whenever the state count allows, and a
 *    clamped result says so.
 *  - Types are drawn without replacement (a talisman never holds one type twice: the game keys rows and the lock by
 *    the modifier hrid). Junk types are lumped: each junk line already on the talisman removes the average junk
 *    weight from the pool rather than its own type's weight.
 *  - Focus draws types line by line in grade order; the server's draw order is unknown.
 *  - Exchange is assumed to be a uniform random permutation of the unlocked grades (not measured).
 *  - Adding lines with talisman cores is not planned: the advisor works with the talisman's current line count.
 *  - Mutation (random_lines) fans out widely; a target whose state space is larger than MUTATION_STATE_LIMIT is
 *    solved without it, and the result says so.
 *
 * The probabilities the client does not carry (grade odds of full rerolls) are in MEASURED_ODDS below.
 */

/**
 * Odds measured live on the test server. Not in the client: the server rolls them.
 * Every figure is a share of lines, with the sample size it came from.
 */
export const MEASURED_ODDS = Object.freeze({
    /** Reforging Orb (full reroll, cap G6), 322 rolls / 1,288 lines, 2026-11-12 (character 32030, talisman 3080) */
    fullRerollGrades: Object.freeze({
        odds: Object.freeze([0.51, 0.239, 0.141, 0.068, 0.03, 0.012]),
        lines: 1288,
    }),
    /**
     * Reshaping Orb (full reroll, cap G4), 200 rolls / 800 lines: 52.4 / 24.9 / 15.1 / 7.6 — the curve above cut at
     * G4 and renormalized (53.2 / 24.9 / 14.7 / 7.1), so a cap is modeled as truncate-and-renormalize.
     */
    cappedCheck: Object.freeze({ odds: Object.freeze([0.524, 0.249, 0.151, 0.076]), lines: 800 }),
    /** Mutation Orb, 150 rolls: exactly two lines change each roll; new grades 53 / 23 / 13 / 7 / 3 / 0.7 */
    mutationCheck: Object.freeze({ odds: Object.freeze([0.53, 0.23, 0.13, 0.07, 0.03, 0.007]), lines: 300 }),
    /** Types: P(type) = weight / Σ weights over the talisman type's pool, checked on 2,088 full-reroll lines */
    typeOddsLines: 2088,
    /** Attunement: 81 rolls on G3/G1 lines (G3: 69% down / 19% same / 12% up), consistent with the data's 65/20/15 */
    attunementRolls: 81,
    /** Focus ×5, 100 rolls focused on Armor: Armor in 33% of rolls (36.9% predicted at ×5), every grade kept */
    focusRolls: 100,
    /**
     * Binding Orb, 2026-11-13 (character 32030): a lock costs one Binding Orb; locking another line while one is
     * locked costs one more and moves the lock; unlocking is free. The lock and unlock edges below model exactly that.
     */
    bindingChecked: true,
});

/** Above this many states the solver leaves Mutation out (its outcome fan-out is the expensive part) */
export const MUTATION_STATE_LIMIT = 25000;

/** The largest state space solved at the game's top grade; above it grades are clamped lower */
export const CLAMP_STATE_LIMIT = 40000;

function choose(n, k) {
    if (k < 0 || k > n) return 0;
    let result = 1;
    for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i;
    return result;
}

/** Multisets of size u from `kinds` kinds */
function multichoose(kinds, u) {
    return u < 0 ? 0 : choose(kinds + u - 1, u);
}

/**
 * How many states a problem has: line multisets with distinct wanted labels, times the lock choices.
 * @param {number} n - Lines
 * @param {number} m - Wanted slots
 * @param {number} G - Grade levels
 * @returns {number}
 */
export function countStates(n, m, G) {
    const lines = (u, wanted) => {
        let total = 0;
        for (let k = 0; k <= Math.min(u, wanted); k++) total += choose(wanted, k) * G ** k * multichoose(G, u - k);
        return total;
    };
    return lines(n, m) + G * lines(n - 1, m) + m * G * lines(n - 1, m - 1);
}

const MODES = {
    full: '/talisman_reroll_modes/full',
    typesOnly: '/talisman_reroll_modes/types_only',
    randomLines: '/talisman_reroll_modes/random_lines',
    gradeShift: '/talisman_reroll_modes/grade_shift',
    permute: '/talisman_reroll_modes/permute',
};

const SPECIAL_GROUP = '/talisman_modifier_groups/special';

/**
 * The weight a focused type is multiplied by. One place, so a measured figure can replace the data's.
 * @param {Object} info - talismanInfo
 * @returns {number}
 */
export function focusMultiplier(info) {
    const weight = Number(info?.focusWeight);
    return weight > 0 ? weight : 5;
}

/**
 * Whether a modifier can be picked for focus. The client blocks Special-group modifiers (the "unique" ✦ lines);
 * the detail map carries no separate unique flag.
 * @param {Object} detail - talismanModifierDetailMap entry
 * @returns {boolean}
 */
export function isFocusable(detail) {
    return !!detail && detail.groupHrid !== SPECIAL_GROUP;
}

/**
 * Grade odds of a full or mutation reroll under a cap: the measured curve truncated at the cap and renormalized.
 * @param {number} cap - Highest grade the orb can roll
 * @returns {number[]} odds[g-1] for g = 1..cap
 */
export function gradeOdds(cap) {
    const base = MEASURED_ODDS.fullRerollGrades.odds;
    const top = Math.max(1, Math.min(base.length, Math.floor(cap) || base.length));
    const slice = base.slice(0, top);
    const total = slice.reduce((sum, p) => sum + p, 0);
    return slice.map((p) => p / total);
}

/**
 * Turn game data and a target into a solver problem, or say why there is nothing to solve.
 * @param {Object} input
 * @param {string} input.talismanTypeHrid
 * @param {number} input.lineCount - Lines on the talisman now
 * @param {Array<{hrid: string, minGrade: number}>} input.targets
 * @param {Object} input.info - talismanInfo
 * @param {Object} input.modifierDetailMap - talismanModifierDetailMap
 * @param {Object<string, number>} input.weights - Cost weight per orb item hrid (one scale for all)
 * @returns {{status: 'ok', problem: Object}|{status: string, reason?: string, hrid?: string}}
 */
export function buildProblem({ talismanTypeHrid, lineCount, targets, info, modifierDetailMap, weights }) {
    if (!info || !modifierDetailMap) return { status: 'noData' };
    const n = Math.floor(lineCount) || 0;
    if (n <= 0) return { status: 'empty' };
    const wantedList = (targets || []).filter((t) => t && t.hrid);
    if (wantedList.length === 0) return { status: 'noTarget' };
    const maxGrade = Number(info.maxGrade) || 6;

    const seen = new Set();
    for (const target of wantedList) {
        if (seen.has(target.hrid)) return { status: 'impossible', reason: 'duplicate', hrid: target.hrid };
        seen.add(target.hrid);
        const detail = modifierDetailMap[target.hrid];
        if (!detail || detail.talismanTypeHrid !== talismanTypeHrid) {
            return { status: 'impossible', reason: 'notInPool', hrid: target.hrid };
        }
        const grade = Math.floor(target.minGrade);
        if (!(grade >= 1) || grade > maxGrade) {
            return { status: 'impossible', reason: 'gradeAboveCap', hrid: target.hrid };
        }
    }
    if (wantedList.length > n) return { status: 'impossible', reason: 'needsMoreLines' };

    const pool = Object.values(modifierDetailMap).filter(
        (d) => d && d.talismanTypeHrid === talismanTypeHrid && Number(d.weight) > 0
    );
    const wanted = wantedList.map((t) => {
        const detail = modifierDetailMap[t.hrid];
        return {
            hrid: t.hrid,
            minGrade: Math.floor(t.minGrade),
            weight: Number(detail.weight) || 0,
            focusable: isFocusable(detail),
        };
    });
    if (wanted.some((w) => !(w.weight > 0))) return { status: 'impossible', reason: 'notInPool' };
    const junkTypes = pool.filter((d) => !seen.has(d.hrid));
    const junkWeight = junkTypes.reduce((sum, d) => sum + Number(d.weight), 0);

    const orbs = [];
    for (const [hrid, input] of Object.entries(info.rerollInputMap || {})) {
        const weight = Number(weights?.[hrid]);
        if (!(weight > 0)) continue;
        if (!Object.values(MODES).includes(input?.modeHrid)) continue;
        orbs.push({
            hrid,
            mode: input.modeHrid,
            cap: Number(input.gradeCap) > 0 ? Math.min(Number(input.gradeCap), maxGrade) : maxGrade,
            lineCount: Number(input.lineCount) || 0,
            minUnlocked: Math.max(1, Number(input.minUnlockedCount) || 1),
            down: Number(input.shiftDownChance) || 0,
            up: Number(input.shiftUpChance) || 0,
            weight,
        });
    }
    orbs.sort((a, b) => a.hrid.localeCompare(b.hrid));
    const bindingHrid = info.lockInputItemHrid || '';
    const bindingWeight = Number(weights?.[bindingHrid]);
    const binding = bindingHrid && bindingWeight > 0 ? { hrid: bindingHrid, weight: bindingWeight } : null;
    if (orbs.length === 0) return { status: 'noOrbs' };

    // The top grade when it fits; otherwise the smallest clamp at or above the highest minimum that does
    const highestMin = Math.max(...wanted.map((w) => w.minGrade));
    let gradeLevels = maxGrade;
    while (gradeLevels > highestMin && countStates(n, wanted.length, gradeLevels) > CLAMP_STATE_LIMIT) gradeLevels--;

    return {
        status: 'ok',
        problem: {
            n,
            m: wanted.length,
            G: gradeLevels,
            gradeClamped: gradeLevels < maxGrade,
            maxGrade,
            wanted,
            junkWeight,
            junkCount: junkTypes.length,
            orbs,
            binding,
            focusMult: focusMultiplier(info),
        },
    };
}

/** A small indexed binary min-heap with decrease-key */
class IndexedHeap {
    constructor(capacity) {
        this.keys = new Float64Array(capacity).fill(Infinity);
        this.pos = new Int32Array(capacity).fill(-1);
        this.heap = [];
    }

    get size() {
        return this.heap.length;
    }

    /** Insert or lower an item's key (a higher key is ignored) */
    push(id, key) {
        if (this.pos[id] === -1) {
            this.keys[id] = key;
            this.heap.push(id);
            this.pos[id] = this.heap.length - 1;
            this.up(this.heap.length - 1);
        } else if (this.pos[id] >= 0 && key < this.keys[id]) {
            this.keys[id] = key;
            this.up(this.pos[id]);
        }
    }

    /** Remove and return the item with the smallest key; it can never be pushed again */
    pop() {
        const top = this.heap[0];
        const last = this.heap.pop();
        if (this.heap.length > 0) {
            this.heap[0] = last;
            this.pos[last] = 0;
            this.down(0);
        }
        this.pos[top] = -2;
        return top;
    }

    up(i) {
        const { heap, keys, pos } = this;
        const id = heap[i];
        const key = keys[id];
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (keys[heap[parent]] <= key) break;
            heap[i] = heap[parent];
            pos[heap[i]] = i;
            i = parent;
        }
        heap[i] = id;
        pos[id] = i;
    }

    down(i) {
        const { heap, keys, pos } = this;
        const length = heap.length;
        const id = heap[i];
        const key = keys[id];
        for (;;) {
            let child = 2 * i + 1;
            if (child >= length) break;
            if (child + 1 < length && keys[heap[child + 1]] < keys[heap[child]]) child++;
            if (keys[heap[child]] >= key) break;
            heap[i] = heap[child];
            pos[heap[i]] = i;
            i = child;
        }
        heap[i] = id;
        pos[id] = i;
    }
}

function insertSorted(codes, code) {
    const out = codes.slice();
    let i = out.length;
    out.push(code);
    while (i > 0 && out[i - 1] > code) {
        out[i] = out[i - 1];
        i--;
    }
    out[i] = code;
    return out;
}

function removeAt(codes, index) {
    return codes.slice(0, index).concat(codes.slice(index + 1));
}

function combinations(length, k) {
    const out = [];
    const pick = [];
    const rec = (start) => {
        if (pick.length === k) {
            out.push(pick.slice());
            return;
        }
        for (let i = start; i < length; i++) {
            pick.push(i);
            rec(i + 1);
            pick.pop();
        }
    };
    rec(0);
    return out;
}

function permutations(items) {
    if (items.length <= 1) return [items.slice()];
    const out = [];
    items.forEach((item, i) => {
        for (const rest of permutations(removeAt(items, i))) out.push([item, ...rest]);
    });
    return out;
}

/**
 * Solve a problem: the value (expected weighted orb spend to the target) and best move of every state, and the
 * expected count of each orb under that policy.
 * @param {Object} problem - From buildProblem
 * @param {Object} [options]
 * @param {boolean} [options.mutation=true] - Consider Mutation (left out anyway above MUTATION_STATE_LIMIT)
 * @returns {Object} solution
 */
export function solve(problem, options = {}) {
    const runner = solveSteps(problem, options);
    let step = runner.next();
    while (!step.done) step = runner.next();
    return step.value;
}

/**
 * The solver as a generator that yields now and then, so a UI can spread the work over frames.
 * @param {Object} problem
 * @param {Object} [options]
 * @returns {Generator<undefined, Object>}
 */
export function* solveSteps(problem, options = {}) {
    const { n, m, G, wanted, junkWeight, junkCount, orbs, binding, focusMult } = problem;
    const C = (m + 1) * G;
    const codeOf = (label, grade) => label * G + (Math.min(Math.max(grade, 1), G) - 1);
    const labelOf = (code) => Math.floor(code / G);
    const gradeOf = (code) => (code % G) + 1;
    const avgJunk = junkCount > 0 ? junkWeight / junkCount : 0;
    const keyOf = (lock, codes) => {
        // The length leads, so a lock-free state never shares a key with a locked one a line shorter
        let key = codes.length * (C + 1) + lock + 1;
        for (const code of codes) key = key * (C + 1) + code + 1;
        return key;
    };

    // ---- Enumerate states ----
    const stateIndex = new Map();
    const stLock = [];
    const stCodes = [];
    const addState = (lock, codes) => {
        stateIndex.set(keyOf(lock, codes), stLock.length);
        stLock.push(lock);
        stCodes.push(codes);
    };
    const wantedMaskOf = (codes, lock) => {
        let mask = 0;
        for (const code of lock >= 0 ? [...codes, lock] : codes) {
            const label = labelOf(code);
            if (label > 0) mask |= 1 << label;
        }
        return mask;
    };
    const enumerate = (lock, length, start, codes, mask) => {
        if (codes.length === length) {
            addState(lock, codes);
            return;
        }
        for (let code = start; code < C; code++) {
            const label = labelOf(code);
            if (label > 0 && mask & (1 << label)) continue;
            enumerate(lock, length, code, [...codes, code], label > 0 ? mask | (1 << label) : mask);
        }
    };
    enumerate(-1, n, 0, [], 0);
    for (let lock = 0; lock < C; lock++) {
        const label = labelOf(lock);
        enumerate(lock, n - 1, 0, [], label > 0 ? 1 << label : 0);
    }
    const S = stLock.length;
    const useMutation = options.mutation !== false && S <= (options.mutationStateLimit ?? MUTATION_STATE_LIMIT);
    yield;

    const isGoal = (s) => {
        const lock = stLock[s];
        const all = lock >= 0 ? [...stCodes[s], lock] : stCodes[s];
        for (let j = 1; j <= m; j++) {
            if (!all.some((code) => labelOf(code) === j && gradeOf(code) >= wanted[j - 1].minGrade)) return false;
        }
        return true;
    };

    // ---- Type draws ----
    const labelOptions = (mask, junkUsed, focus) => {
        const options = [];
        let total = 0;
        for (let j = 1; j <= m; j++) {
            if (mask & (1 << j)) continue;
            const w = wanted[j - 1];
            const weight = w.weight * (focus && w.focusable ? focusMult : 1);
            options.push([j, weight]);
            total += weight;
        }
        if (junkCount - junkUsed > 0) {
            const weight = Math.max(0, junkWeight - junkUsed * avgJunk);
            if (weight > 0) {
                options.push([0, weight]);
                total += weight;
            }
        }
        return total > 0 ? options.map(([label, weight]) => [label, weight / total]) : [];
    };
    const gradeDists = new Map();
    const gradeDist = (cap) => {
        if (!gradeDists.has(cap)) {
            const clamped = new Array(G).fill(0);
            gradeOdds(cap).forEach((p, i) => {
                clamped[Math.min(i, G - 1)] += p;
            });
            gradeDists.set(
                cap,
                clamped.map((p, i) => [i + 1, p]).filter(([, p]) => p > 0)
            );
        }
        return gradeDists.get(cap);
    };
    /**
     * New lines: `count` lines drawn without replacement. `grades` fixes each line's grade (Focus); otherwise
     * grades come from `cap`'s distribution. Returns sorted code lists with their probability.
     */
    const drawLines = (count, keptMask, keptJunk, { cap = 0, grades = null, focus = false }) => {
        let current = new Map([['', { codes: [], mask: keptMask, junk: keptJunk, p: 1 }]]);
        for (let i = 0; i < count; i++) {
            const next = new Map();
            for (const entry of current.values()) {
                const lineGrades = grades ? [[grades[i], 1]] : gradeDist(cap);
                for (const [label, pl] of labelOptions(entry.mask, entry.junk, focus)) {
                    for (const [grade, pg] of lineGrades) {
                        const codes = insertSorted(entry.codes, codeOf(label, grade));
                        const key = codes.join(',');
                        const found = next.get(key);
                        if (found) found.p += entry.p * pl * pg;
                        else
                            next.set(key, {
                                codes,
                                mask: label > 0 ? entry.mask | (1 << label) : entry.mask,
                                junk: label > 0 ? entry.junk : entry.junk + 1,
                                p: entry.p * pl * pg,
                            });
                    }
                }
            }
            current = next;
        }
        return [...current.values()];
    };

    // ---- Moves ----
    // nodes: reroll actions with an outcome list. kind 0 = group (members share the value), 1 = one state,
    // 2 = a mutation part (kept lines K), combined per state.
    const nodes = [];
    const rev = Array.from({ length: S }, () => []);
    const addNode = (kind, orb, outcomes, extra) => {
        const id = nodes.length;
        const out = [];
        const node = { kind, orb, cost: orb >= 0 ? orbs[orb].weight : 0, N: 0, D: 0, done: false, out, ...extra };
        nodes.push(node);
        for (const { codes, lock, p } of outcomes) {
            const s = stateIndex.get(keyOf(lock, codes));
            if (s === undefined || !(p > 0)) continue;
            rev[s].push(id, p);
            out.push(s, p);
        }
        return id;
    };
    const stateMembers = (predicate) => {
        const members = [];
        for (let s = 0; s < S; s++) if (predicate(s)) members.push(s);
        return members;
    };
    const lockMask = (lock) => (lock >= 0 && labelOf(lock) > 0 ? 1 << labelOf(lock) : 0);
    const lockJunk = (lock) => (lock >= 0 && labelOf(lock) === 0 ? 1 : 0);

    const groupOfState = Array.from({ length: S }, () => []);
    const singleNodes = Array.from({ length: S }, () => []);
    const mutationParts = Array.from({ length: S }, () => []);
    const mutationNodes = new Map();

    for (let o = 0; o < orbs.length; o++) {
        const orb = orbs[o];
        if (orb.mode === MODES.full) {
            for (let lock = -1; lock < C; lock++) {
                const u = lock >= 0 ? n - 1 : n;
                if (u < orb.minUnlocked) continue;
                const members = stateMembers((s) => stLock[s] === lock);
                if (members.length === 0) continue;
                const draws = drawLines(u, lockMask(lock), lockJunk(lock), { cap: orb.cap });
                const id = addNode(
                    0,
                    o,
                    draws.map((d) => ({ codes: d.codes, lock, p: d.p })),
                    { members }
                );
                for (const s of members) groupOfState[s].push(id);
            }
        } else if (orb.mode === MODES.typesOnly) {
            const groups = new Map();
            for (let s = 0; s < S; s++) {
                if ((s & 2047) === 2047) yield;
                const u = stCodes[s].length;
                if (u < orb.minUnlocked) continue;
                const lock = stLock[s];
                const open = wanted.some((w, i) => w.focusable && !(lockMask(lock) & (1 << (i + 1))));
                if (!open) continue;
                const grades = stCodes[s].map(gradeOf).sort((a, b) => a - b);
                const key = `${lock}|${grades.join(',')}`;
                if (!groups.has(key)) groups.set(key, { lock, grades, members: [] });
                groups.get(key).members.push(s);
            }
            for (const { lock, grades, members } of groups.values()) {
                const draws = drawLines(grades.length, lockMask(lock), lockJunk(lock), { grades, focus: true });
                const id = addNode(
                    0,
                    o,
                    draws.map((d) => ({ codes: d.codes, lock, p: d.p })),
                    { members }
                );
                for (const s of members) groupOfState[s].push(id);
            }
        } else if (orb.mode === MODES.randomLines) {
            if (!useMutation) continue;
            const take = Math.max(1, orb.lineCount);
            for (let s = 0; s < S; s++) {
                if ((s & 2047) === 2047) yield;
                const codes = stCodes[s];
                const u = codes.length;
                if (u < Math.max(orb.minUnlocked, take)) continue;
                const lock = stLock[s];
                const picks = combinations(u, take);
                const parts = new Map();
                for (const pick of picks) {
                    const kept = codes.filter((_, i) => !pick.includes(i));
                    const key = `${o}|${lock}|${kept.join(',')}`;
                    let nodeId = mutationNodes.get(key);
                    if (nodeId === undefined) {
                        const keptMask = wantedMaskOf(kept, lock);
                        const keptJunk = kept.filter((c) => labelOf(c) === 0).length + lockJunk(lock);
                        const draws = drawLines(take, keptMask, keptJunk, { cap: orb.cap });
                        nodeId = addNode(
                            2,
                            o,
                            draws.map((d) => ({
                                codes: d.codes.reduce((acc, c) => insertSorted(acc, c), kept),
                                lock,
                                p: d.p,
                            })),
                            { deps: [] }
                        );
                        mutationNodes.set(key, nodeId);
                    }
                    parts.set(nodeId, (parts.get(nodeId) || 0) + 1 / picks.length);
                }
                const list = [...parts.entries()];
                mutationParts[s].push({ orb: o, parts: list });
                for (const [nodeId, weight] of list) nodes[nodeId].deps.push(s, weight);
            }
        } else if (orb.mode === MODES.permute) {
            for (let s = 0; s < S; s++) {
                if ((s & 2047) === 2047) yield;
                const codes = stCodes[s];
                if (codes.length < Math.max(2, orb.minUnlocked)) continue;
                const labels = codes.map(labelOf);
                const grades = codes.map(gradeOf);
                const perms = permutations(grades);
                const outcomes = new Map();
                for (const perm of perms) {
                    const next = labels.map((label, i) => codeOf(label, perm[i])).sort((a, b) => a - b);
                    const key = next.join(',');
                    if (!outcomes.has(key)) outcomes.set(key, { codes: next, lock: stLock[s], p: 0 });
                    outcomes.get(key).p += 1 / perms.length;
                }
                singleNodes[s].push(addNode(1, o, [...outcomes.values()], { member: s }));
            }
        } else if (orb.mode === MODES.gradeShift) {
            const same = Math.max(0, 1 - orb.down - orb.up);
            for (let s = 0; s < S; s++) {
                if ((s & 2047) === 2047) yield;
                const codes = stCodes[s];
                if (codes.length < orb.minUnlocked) continue;
                let current = new Map([['', { codes: [], p: 1 }]]);
                for (const code of codes) {
                    const label = labelOf(code);
                    const grade = gradeOf(code);
                    const shifts = [
                        [Math.max(1, grade - 1), orb.down],
                        [grade, same],
                        [Math.min(G, problem.maxGrade, grade + 1), orb.up],
                    ];
                    const next = new Map();
                    for (const entry of current.values()) {
                        for (const [g, p] of shifts) {
                            if (!(p > 0)) continue;
                            const nextCodes = insertSorted(entry.codes, codeOf(label, g));
                            const key = nextCodes.join(',');
                            if (!next.has(key)) next.set(key, { codes: nextCodes, p: 0 });
                            next.get(key).p += entry.p * p;
                        }
                    }
                    current = next;
                }
                const outcomes = [...current.values()].map((e) => ({ ...e, lock: stLock[s] }));
                singleNodes[s].push(addNode(1, o, outcomes, { member: s }));
            }
        }
        yield;
    }

    // Deterministic moves: lock a line (Binding Orb, replaces the old lock) and unlock (free)
    const predecessors = Array.from({ length: S }, () => []);
    for (let s = 0; s < S; s++) {
        if ((s & 2047) === 2047) yield;
        const codes = stCodes[s];
        const lock = stLock[s];
        if (binding) {
            const tried = new Set();
            codes.forEach((code, i) => {
                if (tried.has(code)) return;
                tried.add(code);
                let rest = removeAt(codes, i);
                if (lock >= 0) rest = insertSorted(rest, lock);
                const target = stateIndex.get(keyOf(code, rest));
                if (target !== undefined) predecessors[target].push(s, binding.weight, code);
            });
        }
        if (lock >= 0) {
            const target = stateIndex.get(keyOf(-1, insertSorted(codes, lock)));
            if (target !== undefined) predecessors[target].push(s, 0, -1);
        }
    }
    yield;

    // ---- Solve in increasing value ----
    const V = new Float64Array(S).fill(Infinity);
    const best = new Float64Array(S).fill(Infinity);
    // Action per state: type 0 none/goal, 1 orb node, 2 mutation (orb index), 3 lock (code), 4 unlock
    const actType = new Int8Array(S);
    const actArg = new Int32Array(S).fill(-1);
    const bestType = new Int8Array(S);
    const bestArg = new Int32Array(S).fill(-1);
    const stepOf = new Int32Array(S).fill(-1);
    const finalized = new Uint8Array(S);
    const heap = new IndexedHeap(S + nodes.length);

    const offer = (s, value, type, arg) => {
        if (finalized[s] || !(value < best[s])) return;
        best[s] = value;
        bestType[s] = type;
        bestArg[s] = arg;
        heap.push(s, value);
    };
    const mutationValue = (s, entry) => {
        let num = orbs[entry.orb].weight;
        let den = 0;
        for (const [nodeId, weight] of entry.parts) {
            num += weight * nodes[nodeId].N;
            den += weight * nodes[nodeId].D;
        }
        return den > 0 ? num / den : Infinity;
    };

    for (let s = 0; s < S; s++) if (isGoal(s)) offer(s, 0, 0, -1);

    let step = 0;
    let work = 0;
    const finalize = (s, value, type, arg) => {
        finalized[s] = 1;
        V[s] = value;
        actType[s] = type;
        actArg[s] = arg;
        stepOf[s] = step;
        const refs = rev[s];
        for (let r = 0; r < refs.length; r += 2) {
            const node = nodes[refs[r]];
            const p = refs[r + 1];
            node.N += p * value;
            node.D += p;
            if (node.done) continue;
            if (node.kind === 0) {
                heap.push(S + refs[r], (node.cost + node.N) / node.D);
            } else if (node.kind === 1) {
                offer(node.member, (node.cost + node.N) / node.D, 1, refs[r]);
            } else {
                const deps = node.deps;
                for (let d = 0; d < deps.length; d += 2) {
                    const t = deps[d];
                    if (finalized[t]) continue;
                    for (const entry of mutationParts[t]) {
                        if (entry.orb === node.orb) offer(t, mutationValue(t, entry), 2, entry.orb);
                    }
                }
                work += deps.length;
            }
        }
        const preds = predecessors[s];
        for (let r = 0; r < preds.length; r += 3) {
            const cost = preds[r + 1];
            offer(preds[r], cost + value, preds[r + 2] >= 0 ? 3 : 4, preds[r + 2]);
        }
        work += refs.length;
    };

    while (heap.size > 0) {
        const id = heap.pop();
        const value = heap.keys[id];
        if (!Number.isFinite(value)) break;
        if (id < S) {
            if (finalized[id]) continue;
            finalize(id, value, bestType[id], bestArg[id]);
        } else {
            const node = nodes[id - S];
            if (node.done) continue;
            node.done = true;
            for (const s of node.members) if (!finalized[s]) finalize(s, value, 1, id - S);
        }
        step++;
        if (work > 200000) {
            work = 0;
            yield;
        }
    }

    // ---- What a locked state could do by rerolling as it stands, for "keeping the lock costs more" ----
    const rerollValue = new Float64Array(S).fill(Infinity);
    const groupValue = new Map();
    for (let s = 0; s < S; s++) {
        if ((s & 2047) === 2047) yield;
        if (stLock[s] < 0 || !Number.isFinite(V[s])) continue;
        let bestValue = Infinity;
        for (const id of groupOfState[s]) {
            if (!groupValue.has(id)) groupValue.set(id, fixedPoint(V, nodes[id].cost, [[nodes[id].out, 1]]));
            bestValue = Math.min(bestValue, groupValue.get(id));
        }
        for (const id of singleNodes[s]) {
            bestValue = Math.min(bestValue, fixedPoint(V, nodes[id].cost, [[nodes[id].out, 1]]));
        }
        for (const entry of mutationParts[s]) {
            const lists = entry.parts.map(([id, weight]) => [nodes[id].out, weight]);
            bestValue = Math.min(bestValue, fixedPoint(V, orbs[entry.orb].weight, lists));
        }
        rerollValue[s] = bestValue;
    }

    // The orb behind each state's chosen reroll
    const actOrb = new Int8Array(S).fill(-1);
    for (let s = 0; s < S; s++) {
        if (actType[s] === 1) actOrb[s] = nodes[actArg[s]].orb;
        else if (actType[s] === 2) actOrb[s] = actArg[s];
    }

    // ---- Expected orb counts under the chosen policy, in the same order ----
    const K = orbs.length + 1; // last slot: Binding Orb
    const E = new Float64Array(S * K);
    const order = [];
    for (let s = 0; s < S; s++) if (finalized[s]) order.push(s);
    order.sort((a, b) => stepOf[a] - stepOf[b]);
    const NE = nodes.map(() => new Float64Array(K));
    const DE = new Float64Array(nodes.length);
    let i = 0;
    let sinceYield = 0;
    while (i < order.length) {
        if (++sinceYield > 2000) {
            sinceYield = 0;
            yield;
        }
        let j = i;
        while (j < order.length && stepOf[order[j]] === stepOf[order[i]]) j++;
        for (let x = i; x < j; x++) {
            const s = order[x];
            const base = s * K;
            const type = actType[s];
            const arg = actArg[s];
            if (type === 1) {
                const node = nodes[arg];
                for (let k = 0; k < K; k++) E[base + k] = (NE[arg][k] + (k === node.orb ? 1 : 0)) / DE[arg];
            } else if (type === 2) {
                const entry = mutationParts[s].find((e) => e.orb === arg);
                let den = 0;
                const num = new Float64Array(K);
                num[arg] = 1;
                for (const [nodeId, weight] of entry.parts) {
                    den += weight * DE[nodeId];
                    for (let k = 0; k < K; k++) num[k] += weight * NE[nodeId][k];
                }
                for (let k = 0; k < K; k++) E[base + k] = num[k] / den;
            } else if (type === 3 || type === 4) {
                const codes = stCodes[s];
                const lock = stLock[s];
                let target;
                if (type === 3) {
                    let rest = removeAt(codes, codes.indexOf(arg));
                    if (lock >= 0) rest = insertSorted(rest, lock);
                    target = stateIndex.get(keyOf(arg, rest));
                } else {
                    target = stateIndex.get(keyOf(-1, insertSorted(codes, lock)));
                }
                for (let k = 0; k < K; k++) E[base + k] = E[target * K + k] + (type === 3 && k === K - 1 ? 1 : 0);
            }
        }
        for (let x = i; x < j; x++) {
            const s = order[x];
            const refs = rev[s];
            for (let r = 0; r < refs.length; r += 2) {
                const nodeId = refs[r];
                const p = refs[r + 1];
                DE[nodeId] += p;
                const acc = NE[nodeId];
                for (let k = 0; k < K; k++) acc[k] += p * E[s * K + k];
            }
        }
        i = j;
    }

    // Keep only what advice needs. The solution is built outside this scope, so the closures above (and the
    // reverse edges, heap and accumulators they reach) are not pinned by a cached solution.
    return makeSolution({
        problem,
        mutationUsed: useMutation || !orbs.some((o) => o.mode === MODES.randomLines),
        V,
        E,
        actType,
        actArg,
        actOrb,
        rerollValue,
        orbHrids: [...orbs.map((o) => o.hrid), binding ? binding.hrid : ''],
        stateIndex,
    });
}

/**
 * The solution object advice reads: values, moves and counts per state, and the state lookup.
 * @param {Object} parts
 * @returns {Object}
 */
function makeSolution(parts) {
    const { problem, stateIndex } = parts;
    const G = problem.G;
    const C = (problem.m + 1) * G;
    const keyOf = (lock, codes) => {
        let key = codes.length * (C + 1) + lock + 1;
        for (const code of codes) key = key * (C + 1) + code + 1;
        return key;
    };
    return {
        ...parts,
        stateCount: parts.V.length,
        /** @returns {number|undefined} state index of a compressed state */
        indexOf: (lock, codes) =>
            stateIndex.get(
                keyOf(
                    lock,
                    [...codes].sort((a, b) => a - b)
                )
            ),
        codeOf: (label, grade) => label * G + (Math.min(Math.max(grade, 1), G) - 1),
        labelOf: (code) => Math.floor(code / G),
        gradeOf: (code) => (code % G) + 1,
    };
}

/**
 * Compress a real list of modifiers into the solver's state.
 * @param {Object} solution
 * @param {Array<{hrid: string, grade: number}>} modifiers
 * @param {string} lockedHrid
 * @returns {{index: number|undefined, lineCodes: number[], lockIndex: number}}
 */
export function encodeLines(solution, modifiers, lockedHrid) {
    const { wanted } = solution.problem;
    const used = new Set();
    const lineCodes = modifiers.map((mod) => {
        let label = wanted.findIndex((w) => w.hrid === mod.hrid) + 1;
        // A talisman never holds one type twice; a malformed one is read with the extra copy as junk
        if (label > 0 && used.has(label)) label = 0;
        if (label > 0) used.add(label);
        return solution.codeOf(label, Number(mod.grade) || 1);
    });
    const lockIndex = lockedHrid ? modifiers.findIndex((mod) => mod.hrid === lockedHrid) : -1;
    const lock = lockIndex >= 0 ? lineCodes[lockIndex] : -1;
    const unlocked = lineCodes.filter((_, i) => i !== lockIndex);
    return { index: solution.indexOf(lock, unlocked), lineCodes, lockIndex };
}

/**
 * Whether real lines meet the target (checked on the raw grades, never the compressed state).
 * @param {Array<{hrid: string, grade: number}>} modifiers
 * @param {Array<{hrid: string, minGrade: number}>} targets
 * @returns {boolean}
 */
export function meetsTarget(modifiers, targets) {
    const wanted = (targets || []).filter((t) => t && t.hrid);
    if (wanted.length === 0) return false;
    return wanted.every((t) => (modifiers || []).some((mod) => mod.hrid === t.hrid && mod.grade >= t.minGrade));
}

/**
 * The value of rerolling from a state with one orb and keeping the better roll each time:
 * the least x with x = cost + Σ p·min(x, V(s')), over outcome lists (state, p) with a weight each.
 */
function fixedPoint(V, cost, lists) {
    const outcomes = [];
    for (const [out, weight] of lists) {
        for (let r = 0; r < out.length; r += 2) {
            const value = V[out[r]];
            if (Number.isFinite(value)) outcomes.push([value, out[r + 1] * weight]);
        }
    }
    outcomes.sort((a, b) => a[0] - b[0]);
    let num = cost;
    let den = 0;
    let best = Infinity;
    for (const [value, p] of outcomes) {
        if (den > 0 && value >= num / den) break;
        num += p * value;
        den += p;
        best = Math.min(best, num / den);
    }
    return best;
}

/**
 * The cheapest way to lock an unlocked line that already meets its slot, then go on from there.
 * @returns {{modifierHrid: string, value: number}|null} null when no such line or no Binding Orb
 */
function lockFirstValue(solution, modifiers, lineCodes, lockIndex) {
    const binding = solution.problem.binding;
    if (!binding) return null;
    const { wanted } = solution.problem;
    const lock = lockIndex >= 0 ? lineCodes[lockIndex] : -1;
    let best = null;
    lineCodes.forEach((code, i) => {
        if (i === lockIndex) return;
        const label = solution.labelOf(code);
        if (label === 0 || modifiers[i].grade < wanted[label - 1].minGrade) return;
        const rest = lineCodes.filter((_, k) => k !== i && k !== lockIndex);
        if (lock >= 0) rest.push(lock);
        const index = solution.indexOf(code, rest);
        const value = index === undefined ? Infinity : binding.weight + solution.V[index];
        if (Number.isFinite(value) && (!best || value < best.value)) {
            best = { modifierHrid: modifiers[i].hrid, value, index };
        }
    });
    return best;
}

function countsAt(solution, index) {
    const K = solution.orbHrids.length;
    const counts = {};
    for (let k = 0; k < K; k++) {
        const value = solution.E[index * K + k];
        if (solution.orbHrids[k] && value > 1e-9) counts[solution.orbHrids[k]] = value;
    }
    return counts;
}

/**
 * The recommended move for a real talisman.
 * @param {Object} solution
 * @param {Object} talisman - characterTalismans entry
 * @param {Array<{hrid: string, minGrade: number}>} targets
 * @returns {Object} advice: {status, move?, value?, counts?}
 *   status 'met' | 'accept' | 'discard' | 'move' | 'unreachable' | 'unknownState'
 */
export function advise(solution, talisman, targets) {
    const modifiers = talisman?.modifiers || [];
    const pending = Array.isArray(talisman?.pendingModifiers) ? talisman.pendingModifiers : null;
    const locked = talisman?.lockedModifierHrid || '';

    if (pending && pending.length > 0) {
        // Hard rule: a pending result that meets the target is always taken
        if (meetsTarget(pending, targets)) return { status: 'accept', value: 0, counts: {}, met: true };
        const current = encodeLines(solution, modifiers, locked).index;
        const next = encodeLines(solution, pending, locked).index;
        if (current === undefined || next === undefined) return { status: 'unknownState' };
        const keep = solution.V[current];
        const take = solution.V[next];
        if (!Number.isFinite(keep) && !Number.isFinite(take)) return { status: 'unreachable' };
        // A new roll that already meets the current lines' worth is taken only when strictly better
        if (meetsTarget(modifiers, targets) || keep <= take) {
            return { status: 'discard', value: keep, counts: countsAt(solution, current), otherValue: take };
        }
        return { status: 'accept', value: take, counts: countsAt(solution, next), otherValue: keep };
    }

    // Hard rule: a met target recommends nothing
    if (meetsTarget(modifiers, targets)) return { status: 'met', value: 0, counts: {} };

    const { index, lineCodes, lockIndex } = encodeLines(solution, modifiers, locked);
    if (index === undefined) return { status: 'unknownState' };
    const value = solution.V[index];
    if (!Number.isFinite(value)) return { status: 'unreachable' };
    const type = solution.actType[index];
    const arg = solution.actArg[index];
    const counts = countsAt(solution, index);
    const { orbs, wanted } = solution.problem;

    if (type === 1 || type === 2) {
        const orb = orbs[solution.actOrb[index]];
        const move = { kind: 'orb', itemHrid: orb.hrid, mode: orb.mode };
        if (orb.mode === MODES.typesOnly) {
            move.focusHrids = wanted
                .filter((w) => w.focusable && !(lockIndex >= 0 && modifiers[lockIndex].hrid === w.hrid))
                .map((w) => w.hrid);
        }
        // A line that meets its slot is rerolled unlocked only when locking it is shown to cost more
        const lockFirst = lockFirstValue(solution, modifiers, lineCodes, lockIndex);
        if (lockFirst && lockFirst.value <= value * (1 + 1e-9)) {
            // A tie goes to the lock
            const lockCounts = countsAt(solution, lockFirst.index);
            const bindingHrid = solution.problem.binding.hrid;
            lockCounts[bindingHrid] = (lockCounts[bindingHrid] || 0) + 1;
            return {
                status: 'move',
                move: { kind: 'lock', itemHrid: bindingHrid, modifierHrid: lockFirst.modifierHrid },
                value: lockFirst.value,
                counts: lockCounts,
            };
        }
        return { status: 'move', move, value, counts, ...(lockFirst ? { lockFirst } : {}) };
    }
    if (type === 3) {
        const line = lineCodes.findIndex((code, i) => code === arg && i !== lockIndex);
        return {
            status: 'move',
            move: { kind: 'lock', itemHrid: solution.problem.binding?.hrid, modifierHrid: modifiers[line]?.hrid },
            value,
            counts,
        };
    }
    if (type === 4) {
        return {
            status: 'move',
            move: { kind: 'unlock' },
            value,
            counts,
            stayLockedValue: solution.rerollValue[index],
        };
    }
    return { status: 'unknownState' };
}

export const REROLL_MODES = MODES;
