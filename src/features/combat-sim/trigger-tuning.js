/**
 * Trigger Optimizer: the parts that are arithmetic rather than simulation.
 *
 * The optimizer tunes one kind of thing: the numeric `value` of a trigger row
 * that compares an HP or MP reading to a threshold. It never changes a row's
 * dependency, condition or comparator, and never adds or removes a row. This
 * module holds everything about that which does not need a sim to answer —
 * which rows qualify, what thresholds are worth trying, how a round of
 * candidates is whittled down, when a change is believed, how the result is
 * written back into the sim editor's convention and how it reads aloud.
 *
 * The search is written against an injected `measure` function so it can be
 * tested with deterministic fakes; `trigger-optimizer.js` supplies the real one
 * that runs the combat simulator.
 *
 * Nothing here — or anywhere in the optimizer — touches the game. The output is
 * show-only, plus values written into the sim's own editor and text to copy.
 */

/** Setting that gates the "Triggers" chip on the Upgrade tab */
export const TRIGGER_OPTIMIZER_SETTING = 'combatSim_triggerOptimizer';

/** Most rows the sim editor lets a trigger list hold */
export const MAX_TRIGGERS = 4;

const DEP_SELF = '/combat_trigger_dependencies/self';
const DEP_TARGETED_ENEMY = '/combat_trigger_dependencies/targeted_enemy';
const DEP_ALL_ENEMIES = '/combat_trigger_dependencies/all_enemies';
const COND_CURRENT_HP = '/combat_trigger_conditions/current_hp';
const COND_MISSING_HP = '/combat_trigger_conditions/missing_hp';
const COND_CURRENT_MP = '/combat_trigger_conditions/current_mp';
const COND_MISSING_MP = '/combat_trigger_conditions/missing_mp';
const COND_LOWEST_HP_PCT = '/combat_trigger_conditions/lowest_hp_percentage';
const CMP_GTE = '/combat_trigger_comparators/greater_than_equal';
const CMP_LTE = '/combat_trigger_comparators/less_than_equal';

/** Tunable row kinds */
export const KIND_ENEMY_HP = 'enemy_hp';
export const KIND_ENEMY_PCT = 'enemy_pct';
export const KIND_HP_POOL = 'hp_pool';
export const KIND_MP_POOL = 'mp_pool';

/**
 * Precision presets. `pointHours` is the simulated time spent on one candidate
 * value in the first round, split over `seeds` paired seeds; later rounds grow
 * it by `ROUND_GROWTH`. More hours is a tighter error bar, not a bigger search.
 */
export const PRECISIONS = {
    quick: { key: 'quick', label: 'Quick', pointHours: 20, seeds: 4 },
    standard: { key: 'standard', label: 'Standard', pointHours: 40, seeds: 4 },
    precise: { key: 'precise', label: 'Precise', pointHours: 120, seeds: 6 },
};

/** Default precision key */
export const DEFAULT_PRECISION = 'standard';

/** Fraction of a round's candidates that survive into the next, longer round */
export const KEEP_FRACTION = 1 / 3;

/** How much longer each successive-halving round simulates */
export const ROUND_GROWTH = 1.5;

/** A change is accepted only when its paired gain exceeds this many standard errors */
export const ACCEPT_Z = 2;

/** The importance screen keeps a trigger only when its best coarse value beats the current by this many SE */
export const SCREEN_Z = 1;

/** Enemy-HP thresholds are tried from 0 up to this many seconds of party damage */
export const ENEMY_HP_DPS_SPAN = 6;

/** Points in the coarse grid of an absolute threshold */
export const COARSE_POINTS = 12;

/** Points in the pool-scaled coarse grid come from 10% steps */
const POOL_STEPS = 10;

/** Balanced-score points lost per extra death per hour */
export const DEATH_POINTS_PER_PER_HOUR = 10;

const ABILITY_SLOT = 'abilities';
const CONSUMABLE_SLOTS = new Set(['food', 'drinks']);

/**
 * What kind of tunable a trigger row is, if any.
 *
 * Qualifying rows are the ones the design allows: on an ability, a threshold on
 * an enemy's HP (`targeted_enemy` or `all_enemies` current/missing HP, or the
 * `all_enemies` lowest-HP percentage); on a food or drink, a threshold on the
 * player's own HP or MP. The comparator has to actually read the value
 * (`>=` or `<=`) — `is_active` rows carry a meaningless 0.
 * @param {string} slotType - 'abilities', 'food' or 'drinks'
 * @param {Object} row - { dependencyHrid, conditionHrid, comparatorHrid }
 * @returns {string|null} A KIND_* constant, or null when the row is not tunable
 */
export function tunableKind(slotType, row) {
    if (!row) return null;
    if (row.comparatorHrid !== CMP_GTE && row.comparatorHrid !== CMP_LTE) return null;

    if (slotType === ABILITY_SLOT) {
        const enemy = row.dependencyHrid === DEP_TARGETED_ENEMY || row.dependencyHrid === DEP_ALL_ENEMIES;
        if (!enemy) return null;
        if (row.conditionHrid === COND_CURRENT_HP || row.conditionHrid === COND_MISSING_HP) return KIND_ENEMY_HP;
        if (row.conditionHrid === COND_LOWEST_HP_PCT && row.dependencyHrid === DEP_ALL_ENEMIES) {
            return KIND_ENEMY_PCT;
        }
        return null;
    }

    if (CONSUMABLE_SLOTS.has(slotType)) {
        if (row.dependencyHrid !== DEP_SELF) return null;
        if (row.conditionHrid === COND_CURRENT_HP || row.conditionHrid === COND_MISSING_HP) return KIND_HP_POOL;
        if (row.conditionHrid === COND_CURRENT_MP || row.conditionHrid === COND_MISSING_MP) return KIND_MP_POOL;
    }
    return null;
}

/**
 * The game's default trigger rows for an ability or consumable.
 * @param {string} slotType - 'abilities', 'food' or 'drinks'
 * @param {string} hrid - Ability or item hrid
 * @param {Object} gameData - Game data payload
 * @returns {Array<Object>} Default rows (possibly empty)
 */
export function defaultRows(slotType, hrid, gameData) {
    const defaults =
        slotType === ABILITY_SLOT
            ? gameData?.abilityDetailMap?.[hrid]?.defaultCombatTriggers
            : gameData?.itemDetailMap?.[hrid]?.consumableDetail?.defaultCombatTriggers;
    return Array.isArray(defaults) ? defaults : [];
}

/**
 * Normalize a trigger row to the four fields that matter.
 * @param {Object} t - A trigger row
 * @returns {{dependencyHrid: string, conditionHrid: string, comparatorHrid: string, value: number}}
 */
export function toRow(t) {
    return {
        dependencyHrid: t.dependencyHrid,
        conditionHrid: t.conditionHrid,
        comparatorHrid: t.comparatorHrid,
        value: Number(t.value) || 0,
    };
}

/**
 * The rows that are actually in force for a slot: its custom triggers when it
 * has any (an array, even an empty one), otherwise the game's defaults — the
 * same rule the engine applies (`null` means defaults).
 * @param {Object} slot - DTO slot ({ hrid, triggers })
 * @param {string} slotType - 'abilities', 'food' or 'drinks'
 * @param {Object} gameData - Game data payload
 * @returns {{rows: Array<Object>, fromDefault: boolean}}
 */
export function activeRows(slot, slotType, gameData) {
    if (Array.isArray(slot?.triggers)) return { rows: slot.triggers.map(toRow), fromDefault: false };
    return { rows: defaultRows(slotType, slot?.hrid, gameData).map(toRow), fromDefault: true };
}

/**
 * What the sim editor stores for a trigger list: `null` when it equals the
 * game's defaults (so the slot keeps following them), else the normalized rows.
 * This is the one place that convention lives; the editor's Save button and the
 * optimizer's Apply both go through it.
 * @param {Array<Object>} rows - The trigger rows
 * @param {Array<Object>} defaults - The game's default rows for the slot
 * @returns {Array<Object>|null}
 */
export function triggersForStorage(rows, defaults) {
    const normalized = rows.map((r) => ({ ...r, value: Number(r.value) || 0 }));
    const matchesDefault =
        normalized.length === defaults.length &&
        normalized.every((r, i) => {
            const d = defaults[i];
            return (
                r.dependencyHrid === d.dependencyHrid &&
                r.conditionHrid === d.conditionHrid &&
                r.comparatorHrid === d.comparatorHrid &&
                r.value === (Number(d.value) || 0)
            );
        });
    return matchesDefault ? null : normalized;
}

/**
 * Stable id for one tunable row.
 * @param {string} playerHrid
 * @param {string} slotType
 * @param {string} itemHrid
 * @param {number} rowIndex
 * @returns {string}
 */
export function tunableKey(playerHrid, slotType, itemHrid, rowIndex) {
    return `${playerHrid}|${slotType}|${itemHrid}|${rowIndex}`;
}

function humanize(hrid) {
    return String(hrid || '')
        .split('/')
        .pop()
        .replace(/_/g, ' ');
}

/**
 * Every tunable trigger row among the chosen players' abilities, food and drinks.
 * A slot with no custom triggers contributes the game's default rows, so an
 * untouched Fireball still yields its `targeted_enemy current_hp >= 1` row.
 * Items with no qualifying row (a coffee that only watches its own buff) yield
 * nothing.
 * @param {Object} params
 * @param {Array<Object>} params.playerDTOs - All player DTOs
 * @param {Array<number>} params.playerIndices - Which players to tune
 * @param {Object} params.gameData - Game data payload
 * @param {Object} [params.playerNames] - hrid → display name
 * @returns {Array<Object>} Tunables, in player / slot / row order
 */
export function collectTunables({ playerDTOs, playerIndices, gameData, playerNames = {} }) {
    const tunables = [];
    for (const playerIndex of playerIndices) {
        const dto = playerDTOs[playerIndex];
        if (!dto) continue;
        for (const slotType of [ABILITY_SLOT, 'food', 'drinks']) {
            const slots = dto[slotType] || [];
            slots.forEach((slot, slotIndex) => {
                if (!slot?.hrid) return;
                const { rows, fromDefault } = activeRows(slot, slotType, gameData);
                const itemName =
                    (slotType === ABILITY_SLOT
                        ? gameData?.abilityDetailMap?.[slot.hrid]?.name
                        : gameData?.itemDetailMap?.[slot.hrid]?.name) || humanize(slot.hrid);
                rows.forEach((row, rowIndex) => {
                    const kind = tunableKind(slotType, row);
                    if (!kind) return;
                    tunables.push({
                        key: tunableKey(dto.hrid, slotType, slot.hrid, rowIndex),
                        playerIndex,
                        playerHrid: dto.hrid,
                        playerName: playerNames[dto.hrid] || dto.hrid,
                        slotType,
                        slotIndex,
                        itemHrid: slot.hrid,
                        itemName,
                        rowIndex,
                        kind,
                        dependencyHrid: row.dependencyHrid,
                        conditionHrid: row.conditionHrid,
                        comparatorHrid: row.comparatorHrid,
                        original: row.value,
                        fromDefault,
                        baseRows: rows,
                    });
                });
            });
        }
    }
    return tunables;
}

/**
 * The player DTOs with some trigger values replaced. Only the players and slots
 * that change are copied; everything else is shared with the input, which the
 * simulator only reads. A slot that gains an override gets its full row list
 * written out (defaults included), so a slot that was following the game's
 * defaults carries an explicit array for the sim.
 * @param {Array<Object>} playerDTOs - Source DTOs (not mutated)
 * @param {Array<Object>} tunables - From `collectTunables`
 * @param {Object} overrides - tunable key → value; absent keys keep their original
 * @returns {Array<Object>} DTOs for a simulation
 */
export function applyTriggerValues(playerDTOs, tunables, overrides) {
    const changed = tunables.filter((t) => overrides[t.key] !== undefined && overrides[t.key] !== t.original);
    if (changed.length === 0) return playerDTOs;

    const bySlot = new Map();
    for (const t of changed) {
        const id = `${t.playerIndex}|${t.slotType}|${t.slotIndex}`;
        if (!bySlot.has(id)) bySlot.set(id, { t, edits: [] });
        bySlot.get(id).edits.push(t);
    }

    const out = playerDTOs.slice();
    const copied = new Set();
    for (const { t, edits } of bySlot.values()) {
        if (!copied.has(t.playerIndex)) {
            out[t.playerIndex] = { ...out[t.playerIndex] };
            copied.add(t.playerIndex);
        }
        const player = out[t.playerIndex];
        const slots = (player[t.slotType] || []).slice();
        const rows = t.baseRows.map((r) => ({ ...r }));
        for (const e of edits) rows[e.rowIndex].value = overrides[e.key];
        slots[t.slotIndex] = { ...slots[t.slotIndex], triggers: rows };
        player[t.slotType] = slots;
    }
    return out;
}

/**
 * Clamp a candidate threshold: an integer, never negative, a percentage never
 * above 100.
 * @param {string} kind - Tunable kind
 * @param {number} value
 * @returns {number}
 */
export function clampValue(kind, value) {
    const v = Math.max(0, Math.round(Number(value) || 0));
    return kind === KIND_ENEMY_PCT ? Math.min(100, v) : v;
}

function uniqueSorted(values) {
    return [...new Set(values)].sort((a, b) => a - b);
}

/**
 * The largest threshold worth trying for a kind.
 * @param {Object} tunable - A tunable
 * @param {Object} ctx - { partyDps, pools: { [playerHrid]: { hp, mp } } }
 * @returns {number}
 */
export function gridMaximum(tunable, ctx) {
    const fallback = Math.max(1000, tunable.original * 2);
    if (tunable.kind === KIND_ENEMY_PCT) return 100;
    if (tunable.kind === KIND_ENEMY_HP) {
        const dps = Number(ctx?.partyDps);
        return dps > 0 ? Math.round(dps * ENEMY_HP_DPS_SPAN) : fallback;
    }
    const pool = ctx?.pools?.[tunable.playerHrid]?.[tunable.kind === KIND_HP_POOL ? 'hp' : 'mp'];
    return pool > 0 ? Math.round(pool) : fallback;
}

/**
 * The spacing between coarse grid points; the fine pass works in fractions of it.
 * @param {Object} tunable - A tunable
 * @param {Object} ctx - Baseline context
 * @returns {number}
 */
export function coarseStep(tunable, ctx) {
    const max = gridMaximum(tunable, ctx);
    if (tunable.kind === KIND_ENEMY_PCT) return 10;
    if (tunable.kind === KIND_ENEMY_HP) return max / (COARSE_POINTS - 1);
    return max / POOL_STEPS;
}

/**
 * The coarse candidate values for a tunable, always including the current value
 * so the grid can be read against it.
 *
 * Enemy-HP thresholds run from 0 ("no gate") up to about six seconds of party
 * damage in twelve even steps; percentages run 0–100 in tens; food thresholds
 * run in 10% steps of the relevant pool. Everything is an integer and clamped.
 * @param {Object} tunable - A tunable
 * @param {Object} ctx - { partyDps, pools }
 * @returns {Array<number>} Ascending, unique
 */
export function coarseGrid(tunable, ctx) {
    const step = coarseStep(tunable, ctx);
    const count =
        tunable.kind === KIND_ENEMY_PCT ? 11 : tunable.kind === KIND_ENEMY_HP ? COARSE_POINTS : POOL_STEPS + 1;
    const values = [];
    for (let i = 0; i < count; i++) values.push(clampValue(tunable.kind, i * step));
    values.push(clampValue(tunable.kind, tunable.current ?? tunable.original));
    return uniqueSorted(values);
}

/**
 * Candidate values just around a center: ±5 and ±2 for percentages, otherwise
 * ± half and a quarter of the coarse step. Values already tried are left out,
 * as is the center itself (it is the reference, measured anyway).
 * @param {Object} tunable - A tunable
 * @param {Object} ctx - { partyDps, pools }
 * @param {number} center - The value to refine around
 * @param {Set<number>} [tried] - Values to skip
 * @returns {Array<number>} Ascending, unique
 */
export function fineGrid(tunable, ctx, center, tried = new Set()) {
    const offsets =
        tunable.kind === KIND_ENEMY_PCT
            ? [-5, -2, 2, 5]
            : (() => {
                  const step = coarseStep(tunable, ctx);
                  return [-step / 2, -step / 4, step / 4, step / 2];
              })();
    const values = offsets
        .map((o) => clampValue(tunable.kind, center + o))
        .filter((v) => v !== center && !tried.has(v));
    return uniqueSorted(values);
}

// ─── Objective ──────────────────────────────────────────────────────────────

/**
 * One sim's figures for the players being judged: sums across them, with the
 * zone's encounter rate (which belongs to the whole party) carried through.
 * @param {Object} sample - { perPlayer: { [hrid]: { xp, profit, deaths, dps } }, encounters }
 * @param {Array<string>} hrids - Whose figures count
 * @returns {{xp: number, profit: number, deaths: number, dps: number, encounters: number}}
 */
export function scopeMetrics(sample, hrids) {
    const out = { xp: 0, profit: 0, deaths: 0, dps: 0, encounters: sample?.encounters || 0 };
    for (const hrid of hrids) {
        const p = sample?.perPlayer?.[hrid];
        if (!p) continue;
        out.xp += p.xp || 0;
        out.profit += p.profit || 0;
        out.deaths += p.deaths || 0;
        out.dps += p.dps || 0;
    }
    return out;
}

const pct = (value, base) => {
    if (!(Math.abs(base) > 0)) return 0;
    return Math.max(-100, Math.min(100, ((value - base) / Math.abs(base)) * 100));
};

/**
 * The balanced objective: the average of five terms, each a change against the
 * untouched setup — EXP/h, profit/h, DPS and encounters/h as a percentage, and
 * deaths as `DEATH_POINTS_PER_PER_HOUR` points per extra death per hour. It
 * reads as "roughly, the average percent better", and zero is the baseline.
 *
 * It mirrors the five axes the Upgrade tab's Score (balanced) blends, but not
 * its arithmetic: that score ranks candidates against each other by gold spent
 * per 0.01% gained, and a trigger change costs nothing, so there is nothing to
 * divide by. Each term is clamped to ±100 so a near-zero baseline cannot
 * dominate.
 * @param {Object} metrics - From `scopeMetrics`
 * @param {Object} base - The baseline's `scopeMetrics`
 * @returns {number} Score points
 */
export function balancedScore(metrics, base) {
    const deathsTerm = Math.max(
        -100,
        Math.min(100, -DEATH_POINTS_PER_PER_HOUR * ((metrics.deaths || 0) - (base.deaths || 0)))
    );
    const terms = [
        pct(metrics.xp, base.xp),
        pct(metrics.profit, base.profit),
        pct(metrics.dps, base.dps),
        pct(metrics.encounters, base.encounters),
        deathsTerm,
    ];
    return terms.reduce((sum, t) => sum + t, 0) / terms.length;
}

// ─── Statistics ─────────────────────────────────────────────────────────────

/**
 * Mean of a list.
 * @param {Array<number>} xs
 * @returns {number}
 */
export function mean(xs) {
    return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

/**
 * Paired difference between two score lists measured on the same seeds.
 * @param {Array<number>} a - Candidate scores, one per seed
 * @param {Array<number>} b - Reference scores on the same seeds
 * @returns {{mean: number, se: number, n: number}} Mean of a−b and its standard error
 */
export function pairedDiff(a, b) {
    const n = Math.min(a.length, b.length);
    if (n === 0) return { mean: 0, se: Infinity, n: 0 };
    const diffs = [];
    for (let i = 0; i < n; i++) diffs.push(a[i] - b[i]);
    const m = mean(diffs);
    if (n < 2) return { mean: m, se: Infinity, n };
    const variance = diffs.reduce((s, d) => s + (d - m) ** 2, 0) / (n - 1);
    return { mean: m, se: Math.sqrt(variance / n), n };
}

/**
 * The acceptance rule: a candidate replaces the current value only when its
 * paired gain is positive and exceeds `ACCEPT_Z` standard errors.
 * @param {{mean: number, se: number}} diff - From `pairedDiff`
 * @param {number} [z] - Standard errors required
 * @returns {boolean}
 */
export function accepts(diff, z = ACCEPT_Z) {
    return diff.mean > 0 && Number.isFinite(diff.se) && diff.mean > z * diff.se;
}

// ─── Successive halving ─────────────────────────────────────────────────────

/**
 * Successive halving over one trigger's candidate values.
 *
 * Every candidate and the current value (the reference) are measured on the
 * same seeds; the best third survive into a round that simulates 1.5× longer,
 * and so on until the next cut would leave a single survivor. That survivor is
 * the winner, and its gain over the reference — paired per seed, from the last
 * round's samples — decides whether it is believed.
 * @param {Object} params
 * @param {Array<number>} params.values - Candidate values, excluding the reference
 * @param {number} params.reference - The current value
 * @param {number} params.hours - Hours per seed in the first round
 * @param {Function} params.measure - `(value, hours) => Promise<Array<Sample>|null>`; null means stopped
 * @param {Function} params.score - `(sample) => number`
 * @param {Function} [params.aborted] - `() => boolean`
 * @returns {Promise<Object|null>} `{ winner, diff, rounds, means, winnerSamples, referenceSamples,
 *   accepted }`, or null when the run was stopped before a first round finished
 */
export async function successiveHalving({ values, reference, hours, measure, score, aborted }) {
    let alive = [...values];
    let roundHours = hours;
    let rounds = 0;
    let firstMeans = null;
    let last = null;

    while (alive.length > 0) {
        if (aborted?.()) break;
        const entries = [reference, ...alive];
        const thisRoundHours = roundHours;
        const measured = await Promise.all(entries.map((v) => measure(v, thisRoundHours)));
        if (aborted?.() || measured.some((m) => !m)) break;

        const scores = new Map();
        const samples = new Map();
        entries.forEach((v, i) => {
            samples.set(v, measured[i]);
            scores.set(
                v,
                measured[i].map((s) => score(s))
            );
        });
        rounds++;
        if (!firstMeans) firstMeans = new Map([...scores].map(([v, s]) => [v, mean(s)]));

        const ranked = [...alive].sort((a, b) => mean(scores.get(b)) - mean(scores.get(a)) || a - b);
        last = { ranked, scores, samples, hours: roundHours };

        const keep = Math.ceil(ranked.length * KEEP_FRACTION);
        if (keep <= 1) break;
        alive = ranked.slice(0, keep);
        roundHours *= ROUND_GROWTH;
    }

    if (!last) return null;
    const winner = last.ranked[0];
    const diff = pairedDiff(last.scores.get(winner), last.scores.get(reference));
    return {
        winner,
        diff,
        rounds,
        means: firstMeans,
        winnerSamples: last.samples.get(winner),
        referenceSamples: last.samples.get(reference),
        accepted: accepts(diff),
    };
}

// ─── The whole search ───────────────────────────────────────────────────────

/**
 * Estimate how many sims a search will run, for the progress bar. It is an
 * estimate: the real count depends on how many triggers the screen drops.
 * @param {number} tunableCount - Tunable rows
 * @param {string} [precision] - Precision key
 * @returns {number}
 */
export function estimateTriggerSims(tunableCount, precision = DEFAULT_PRECISION) {
    const seeds = (PRECISIONS[precision] || PRECISIONS[DEFAULT_PRECISION]).seeds;
    // screen 13 points; coarse halving 13 + 5 + 3; fine halving 5 + 3; second pass 8
    const perTunable = (13 + 21 + 8 + 8) * seeds;
    return seeds + tunableCount * perTunable + 2 * (seeds + 2);
}

function metricsMean(samples, hrids) {
    const ms = samples.map((s) => scopeMetrics(s, hrids));
    return {
        xp: mean(ms.map((m) => m.xp)),
        profit: mean(ms.map((m) => m.profit)),
        deaths: mean(ms.map((m) => m.deaths)),
    };
}

/**
 * Run the full trigger search against an injected measuring function.
 *
 * 1. Baseline on the original setup: scope figures, party DPS, HP/MP pools.
 * 2. Importance screen: each tunable across its coarse grid alone; ordered by
 *    how far its scores spread, and dropped when no value beats the current by
 *    `SCREEN_Z` standard errors.
 * 3. Coordinate descent, most impactful first, keeping earlier winners: a
 *    coarse halving, then a fine halving around the winner; then one more fine
 *    pass over every kept trigger once the others have moved.
 * 4. A fresh-seed head-to-head of the original setup against all the winners.
 *
 * Stopping keeps whatever has been accepted so far (and skips the final
 * head-to-head).
 * @param {Object} params
 * @param {Array<Object>} params.tunables - From `collectTunables`
 * @param {Array<string>} params.scopeHrids - Players whose figures are judged
 * @param {Function} params.measure - `(overrides, hoursPerSeed, seedSet) => Promise<Array<Sample>|null>`;
 *   `seedSet` is 'search' or 'final'. Samples are `{ perPlayer, encounters, pools }`.
 * @param {Object} params.precision - An entry of PRECISIONS
 * @param {Function} [params.onProgress] - Called with `{ description }`
 * @param {Function} [params.aborted] - `() => boolean`
 * @returns {Promise<Object|null>} See `buildResult`; null when stopped before the baseline
 */
export async function runTriggerSearch({ tunables, scopeHrids, measure, precision, onProgress, aborted }) {
    const hoursPerSeed = precision.pointHours / precision.seeds;
    const overrides = {};
    const progress = (description) => onProgress?.({ description });

    const measureWith = (extra, hours, seedSet = 'search') => measure({ ...overrides, ...extra }, hours, seedSet);

    progress('Triggers: measuring the baseline');
    const baselineSamples = await measureWith({}, hoursPerSeed * ROUND_GROWTH);
    if (!baselineSamples || aborted?.()) return null;

    const baseScope = (() => {
        const ms = baselineSamples.map((s) => scopeMetrics(s, scopeHrids));
        return {
            xp: mean(ms.map((m) => m.xp)),
            profit: mean(ms.map((m) => m.profit)),
            deaths: mean(ms.map((m) => m.deaths)),
            dps: mean(ms.map((m) => m.dps)),
            encounters: mean(ms.map((m) => m.encounters)),
        };
    })();
    const score = (sample) => balancedScore(scopeMetrics(sample, scopeHrids), baseScope);

    const partyDps = mean(
        baselineSamples.map((s) => Object.values(s.perPlayer || {}).reduce((sum, p) => sum + (p.dps || 0), 0))
    );
    const pools = {};
    for (const [hrid, p] of Object.entries(baselineSamples[0]?.pools || {})) pools[hrid] = p;
    const ctx = { partyDps, pools };

    const state = new Map(tunables.map((t) => [t.key, { tunable: t, current: t.original, step: null }]));
    const currentOf = (t) => state.get(t.key).current;
    const tried = new Map(tunables.map((t) => [t.key, new Set([t.original])]));

    // Run one halving for a tunable over candidate values, against its current value
    const halve = async (t, values, label) => {
        const candidates = values.filter((v) => v !== currentOf(t));
        if (candidates.length === 0) return null;
        for (const v of candidates) tried.get(t.key).add(v);
        progress(`Triggers: ${t.itemName} (${label})`);
        return successiveHalving({
            values: candidates,
            reference: currentOf(t),
            hours: hoursPerSeed,
            measure: (value, hours) => measureWith({ [t.key]: value }, hours),
            score,
            aborted,
        });
    };

    // 2. Importance screen
    const screen = [];
    for (const t of tunables) {
        if (aborted?.()) break;
        const grid = coarseGrid(t, ctx).filter((v) => v !== t.original);
        progress(`Triggers: screening ${t.itemName}`);
        const entries = [t.original, ...grid];
        const measured = await Promise.all(entries.map((v) => measureWith({ [t.key]: v }, hoursPerSeed)));
        if (aborted?.() || measured.some((m) => !m)) break;
        const scores = entries.map((_, i) => measured[i].map((s) => score(s)));
        const means = scores.map(mean);
        const refScores = scores[0];
        let bestIndex = 1;
        for (let i = 2; i < entries.length; i++) if (means[i] > means[bestIndex]) bestIndex = i;
        const bestDiff = bestIndex < entries.length ? pairedDiff(scores[bestIndex], refScores) : { mean: 0, se: 1 };
        screen.push({
            tunable: t,
            range: Math.max(...means) - Math.min(...means),
            promising: grid.length > 0 && bestDiff.mean > SCREEN_Z * bestDiff.se,
        });
    }
    const stopped = () => Boolean(aborted?.());
    screen.sort((a, b) => b.range - a.range);

    // 3. Coordinate descent
    const changeLog = new Map();
    const record = (t, result, before) => {
        const after = currentOf(t);
        if (after === before) return;
        const entry = changeLog.get(t.key) || { deltaScore: 0, variance: 0, xp: 0, profit: 0, deaths: 0 };
        const refM = metricsMean(result.referenceSamples, scopeHrids);
        const winM = metricsMean(result.winnerSamples, scopeHrids);
        entry.deltaScore += result.diff.mean;
        entry.variance += result.diff.se ** 2;
        entry.xp += winM.xp - refM.xp;
        entry.profit += winM.profit - refM.profit;
        entry.deaths += winM.deaths - refM.deaths;
        changeLog.set(t.key, entry);
    };
    const tune = async (t, values, label) => {
        const before = currentOf(t);
        const result = await halve(t, values, label);
        if (!result || stopped()) return false;
        if (result.accepted) {
            state.get(t.key).current = result.winner;
            overrides[t.key] = result.winner;
            record(t, result, before);
            return true;
        }
        return false;
    };

    const keepers = screen.filter((s) => s.promising).map((s) => s.tunable);
    let anyChange = false;
    for (const t of keepers) {
        if (stopped()) break;
        const coarse = await tune(t, coarseGrid({ ...t, current: currentOf(t) }, ctx), 'coarse');
        if (stopped()) break;
        const fine = await tune(t, fineGrid(t, ctx, currentOf(t), tried.get(t.key)), 'fine');
        anyChange = anyChange || coarse || fine;
    }
    if (anyChange && !stopped()) {
        for (const t of keepers) {
            if (stopped()) break;
            await tune(t, fineGrid(t, ctx, currentOf(t), tried.get(t.key)), 'second pass');
        }
    }

    // 4. Combined re-measure on fresh seeds
    let combined = null;
    const changedKeys = Object.keys(overrides).filter((k) => overrides[k] !== state.get(k).tunable.original);
    if (changedKeys.length > 0 && !stopped()) {
        progress('Triggers: confirming all changes together');
        const finalHours = hoursPerSeed * ROUND_GROWTH * ROUND_GROWTH;
        const [orig, tuned] = await Promise.all([
            measure({}, finalHours, 'final'),
            measure({ ...overrides }, finalHours, 'final'),
        ]);
        if (orig && tuned && !stopped()) {
            const diff = pairedDiff(
                tuned.map((s) => score(s)),
                orig.map((s) => score(s))
            );
            const a = metricsMean(tuned, scopeHrids);
            const b = metricsMean(orig, scopeHrids);
            combined = {
                deltaScore: diff.mean,
                se: diff.se,
                deltaXp: a.xp - b.xp,
                deltaProfit: a.profit - b.profit,
                deltaDeaths: a.deaths - b.deaths,
                seeds: diff.n,
            };
        }
    }

    const changes = [];
    const unchanged = [];
    for (const t of tunables) {
        const to = currentOf(t);
        const log = changeLog.get(t.key);
        if (to === t.original || !log) {
            unchanged.push(t);
            continue;
        }
        changes.push({
            ...t,
            from: t.original,
            to,
            deltaScore: log.deltaScore,
            se: Math.sqrt(log.variance),
            deltaXp: log.xp,
            deltaProfit: log.profit,
            deltaDeaths: log.deaths,
        });
    }
    changes.sort((a, b) => b.deltaScore - a.deltaScore);

    return {
        stopped: stopped(),
        baseline: baseScope,
        partyDps,
        screened: screen.map((s) => ({ key: s.tunable.key, range: s.range, promising: s.promising })),
        changes,
        unchanged,
        combined,
    };
}

// ─── Writing back and reading aloud ─────────────────────────────────────────

/**
 * The edits to hand the sim editor: one per changed row, carrying enough of the
 * row's identity for the editor to refuse an edit whose row has since changed.
 * @param {Object} result - From `runTriggerSearch`
 * @returns {Array<Object>}
 */
export function buildEditorChanges(result) {
    return (result?.changes || []).map((c) => ({
        playerHrid: c.playerHrid,
        slotType: c.slotType,
        itemHrid: c.itemHrid,
        rowIndex: c.rowIndex,
        dependencyHrid: c.dependencyHrid,
        conditionHrid: c.conditionHrid,
        comparatorHrid: c.comparatorHrid,
        from: c.from,
        to: c.to,
    }));
}

const COMPARATOR_SYMBOLS = { [CMP_GTE]: '≥', [CMP_LTE]: '≤' };

/**
 * A trigger row read the way the game words it: "Targeted enemy: Current HP ≥ 600".
 * @param {Object} row - { dependencyHrid, conditionHrid, comparatorHrid }
 * @param {Object} gameData - Game data payload (for display names)
 * @param {number} value - The threshold
 * @returns {string}
 */
export function describeRow(row, gameData, value) {
    const dep = gameData?.combatTriggerDependencyDetailMap?.[row.dependencyHrid]?.name || humanize(row.dependencyHrid);
    const cond = gameData?.combatTriggerConditionDetailMap?.[row.conditionHrid]?.name || humanize(row.conditionHrid);
    const suffix = row.conditionHrid === COND_LOWEST_HP_PCT ? '%' : '';
    return `${dep}: ${cond} ${COMPARATOR_SYMBOLS[row.comparatorHrid] || humanize(row.comparatorHrid)} ${value}${suffix}`;
}

/**
 * One human-readable line for a change, for pasting somewhere or entering in
 * the game by hand.
 * @param {Object} change - A change from the result
 * @param {Object} gameData - Game data payload
 * @param {boolean} [withPlayer] - Prefix the player's name (party runs)
 * @returns {string}
 */
export function formatChangeLine(change, gameData, withPlayer = false) {
    const where = change.slotType === ABILITY_SLOT ? 'ability' : change.slotType === 'food' ? 'food' : 'drink';
    const prefix = withPlayer ? `${change.playerName}: ` : '';
    return `${prefix}${change.itemName} (${where}) — ${describeRow(change, gameData, change.to)} (was ${change.from})`;
}

/**
 * The whole result as text, one line per change.
 * @param {Object} result - From `runTriggerSearch`
 * @param {Object} gameData - Game data payload
 * @returns {string}
 */
export function formatChangesText(result, gameData) {
    const players = new Set((result?.changes || []).map((c) => c.playerHrid));
    return (result?.changes || []).map((c) => formatChangeLine(c, gameData, players.size > 1)).join('\n');
}
