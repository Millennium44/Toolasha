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

/**
 * Smallest score gain worth offering, in score points. A change that is
 * statistically real but worth less than this (a food that saves a few coins
 * and moves nothing else) is not recommended.
 */
export const MIN_GAIN = 0.5;

/** Minimum-gain choices the Triggers chip offers */
export const MIN_GAIN_OPTIONS = [0.25, 0.5, 1, 2];

/** Seeds in a confirmation or the final head-to-head, at least; enough for a t test that is not near-useless */
export const CONFIRM_SEEDS_MIN = 8;

/**
 * The importance screen keeps a trigger only when its best coarse value beats
 * the current by this many SE and by `MIN_GAIN`. Picking the best of ~12 values
 * makes a bar of 1 SE pass nearly every trigger that does nothing.
 */
export const SCREEN_Z = 2;

/**
 * Enemy-HP thresholds are tried from 0 up to this many seconds of party damage, when the zone's
 * monsters' HP cannot be read (see `zoneEnemyHp`, which is the normal source)
 */
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

/** What the Triggers chip may tune: ability gates, food and drink thresholds, or both */
export const TUNABLE_SCOPES = ['both', 'abilities', 'consumables'];
export const DEFAULT_TUNABLE_SCOPE = 'both';
const TUNABLE_SCOPE_SLOTS = {
    both: [ABILITY_SLOT, 'food', 'drinks'],
    abilities: [ABILITY_SLOT],
    consumables: ['food', 'drinks'],
};

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
 * @param {string} [params.include] - 'both' (default), 'abilities' or 'consumables' (food and drinks);
 *   anything else counts as 'both'
 * @returns {Array<Object>} Tunables, in player / slot / row order
 */
export function collectTunables({ playerDTOs, playerIndices, gameData, playerNames = {}, include = 'both' }) {
    const slotTypes = TUNABLE_SCOPE_SLOTS[include] || TUNABLE_SCOPE_SLOTS.both;
    const tunables = [];
    for (const playerIndex of playerIndices) {
        const dto = playerDTOs[playerIndex];
        if (!dto) continue;
        for (const slotType of slotTypes) {
            const slots = dto[slotType] || [];
            slots.forEach((slot, slotIndex) => {
                if (!slot?.hrid) return;
                const { rows, fromDefault } = activeRows(slot, slotType, gameData);
                // The sim editor cannot store more rows than this, so Apply could never write them back
                if (rows.length > MAX_TRIGGERS) return;
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
 *
 * An enemy-HP threshold's range is the HP the zone's monsters actually have: a
 * `targeted_enemy` current/missing HP row reads one monster, so it runs up to the
 * largest single monster's max HP; an `all_enemies` row reads the sum over every
 * living enemy, so it runs up to the largest group that can be up at once
 * (`zoneEnemyHp`). Without monster data it falls back to about six seconds of
 * party damage, times the zone's largest spawn for `all_enemies`.
 * @param {Object} tunable - A tunable
 * @param {Object} ctx - { partyDps, pools: { [playerHrid]: { hp, mp } }, maxEnemies, enemyHp: { single, total } }
 * @returns {number}
 */
export function gridMaximum(tunable, ctx) {
    const fallback = Math.max(1000, tunable.original * 2);
    if (tunable.kind === KIND_ENEMY_PCT) return 100;
    if (tunable.kind === KIND_ENEMY_HP) {
        const allEnemies = tunable.dependencyHrid === DEP_ALL_ENEMIES;
        const fromMonsters = Number(allEnemies ? ctx?.enemyHp?.total : ctx?.enemyHp?.single);
        if (fromMonsters > 0) return Math.round(fromMonsters);
        const dps = Number(ctx?.partyDps);
        // Fallback. The count is the zone's maximum spawn, not the average, so the top can overshoot.
        const count = allEnemies ? Math.max(1, Number(ctx?.maxEnemies) || 1) : 1;
        return dps > 0 ? Math.round(dps * ENEMY_HP_DPS_SPAN * count) : fallback;
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
 * Enemy-HP thresholds run from 0 ("no gate") up to the zone's largest monster
 * HP (or largest group, for `all_enemies`) in twelve even steps; percentages run
 * 0–100 in tens; food thresholds run in 10% steps of the relevant pool.
 * Everything is an integer and clamped.
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

/**
 * The most enemies a zone or dungeon can have up at once, from its spawn tables.
 * @param {Object} gameData - Game data payload
 * @param {string} zoneHrid - Zone action hrid
 * @returns {number} At least 1
 */
export function zoneMaxEnemies(gameData, zoneHrid) {
    const info = gameData?.actionDetailMap?.[zoneHrid]?.combatZoneInfo;
    const counts = [info?.fightInfo?.randomSpawnInfo?.maxSpawnCount, info?.fightInfo?.bossSpawns?.length];
    for (const spawn of Object.values(info?.dungeonInfo?.randomSpawnInfoMap || {})) counts.push(spawn?.maxSpawnCount);
    for (const wave of Object.values(info?.dungeonInfo?.fixedSpawnsMap || {})) counts.push(wave?.length);
    return Math.max(1, ...counts.map((c) => Number(c) || 0));
}

/**
 * The tunables whose threshold could not have changed the baseline runs, so screening them would only
 * spend sims measuring noise.
 *
 * The rule rests on how the engine reads a trigger. A threshold enters a run only when its slot's rows
 * are read (`Trigger.isActive`), and the rows are read only when the slot is ready: off cooldown, the
 * player alive and not stunned (or silenced, for an ability), and — for an ability — no earlier ability
 * slot already used that turn. The engine counts those reads per slot (`SimResult.triggerChecks`); casts
 * and uses are added on top. A slot with no reads on any baseline seed ran exactly as it would have with
 * any other threshold, so its rows are skipped. A gate that read false every time has reads and is kept —
 * it blocked every cast, and that is precisely what tuning it can change. So is an ability that passed
 * its gate but could never afford the mana: its rows were read.
 *
 * One exception keeps an unread ability: when an earlier ability slot of the same player is being tuned.
 * Ability slots are tried in order and the first that fires ends the turn, so a later slot is reached
 * only when an earlier one declines; changing the earlier slot's threshold can bring the later one into
 * play. Food and drinks are each read on their own, with no such ordering.
 *
 * The evidence is the baseline seeds, not every seed there could be; it is a long run of the actual setup.
 * When the samples carry no read counts (an engine that does not record them), nothing is skipped.
 * @param {Array<Object>} tunables - From `collectTunables`
 * @param {Array<Object>} samples - Baseline samples, each with `triggerUse: { [playerHrid]: { [hrid]: n } }`
 * @returns {Array<Object>} The tunables to skip, in input order
 */
export function unusedTunables(tunables, samples) {
    if (!samples?.length || samples.some((sample) => !sample?.triggerUse)) return [];
    const reached = (t) => samples.some((sample) => (Number(sample.triggerUse[t.playerHrid]?.[t.itemHrid]) || 0) > 0);
    const skip = new Set();
    for (const t of tunables) {
        if (t.slotType !== ABILITY_SLOT && !reached(t)) skip.add(t.key);
    }
    // Abilities in slot order per player, so an earlier slot's verdict is known before a later one's
    const abilities = tunables
        .filter((t) => t.slotType === ABILITY_SLOT)
        .sort((a, b) => a.playerIndex - b.playerIndex || a.slotIndex - b.slotIndex);
    const tunedSlots = new Map();
    for (const t of abilities) {
        const earlierTuned = (tunedSlots.get(t.playerHrid) || []).some((slotIndex) => slotIndex < t.slotIndex);
        if (!reached(t) && !earlierTuned) {
            skip.add(t.key);
            continue;
        }
        if (!tunedSlots.has(t.playerHrid)) tunedSlots.set(t.playerHrid, []);
        tunedSlots.get(t.playerHrid).push(t.slotIndex);
    }
    return tunables.filter((t) => skip.has(t.key));
}

/** Above this many spawn entries or picks, the largest random group is bounded rather than searched */
const MAX_GROUP_SEARCH = { spawns: 12, picks: 10 };

/**
 * The largest total max HP one random spawn table can put up at once: up to
 * `maxSpawnCount` draws (repeats allowed) whose summed strength stays within
 * `maxTotalStrength`, the same limits `Zone.getRandomEncounter` applies.
 * @param {Object} info - A randomSpawnInfo: { spawns, maxSpawnCount, maxTotalStrength }
 * @param {Function} hpOf - (spawn) => max HP, 0 when unknown
 * @returns {number}
 */
function largestRandomGroup(info, hpOf) {
    const spawns = (info?.spawns || [])
        .map((spawn) => ({ hp: hpOf(spawn), strength: Number(spawn.strength) || 0 }))
        .filter((spawn) => spawn.hp > 0);
    const picks = Math.max(0, Number(info?.maxSpawnCount) || 0);
    if (spawns.length === 0 || picks === 0) return 0;
    const cap = Number(info?.maxTotalStrength);
    const capped = Number.isFinite(cap) && cap > 0;
    if (!capped || spawns.length > MAX_GROUP_SEARCH.spawns || picks > MAX_GROUP_SEARCH.picks) {
        return picks * Math.max(...spawns.map((spawn) => spawn.hp));
    }
    let best = 0;
    const search = (from, left, strength, hp) => {
        best = Math.max(best, hp);
        if (left === 0) return;
        for (let i = from; i < spawns.length; i++) {
            const next = strength + spawns[i].strength;
            if (next <= cap) search(i, left - 1, next, hp + spawns[i].hp);
        }
    };
    search(0, picks, 0, 0);
    return best;
}

/**
 * The HP an enemy-HP trigger can read in a zone at a tier, from its spawn tables:
 * the largest single monster's max HP, and the largest total max HP that can be
 * up at once (one random draw, a boss wave, a dungeon's random tables or fixed
 * waves). Monsters a fight adds later (summons, promotions) are not counted.
 * @param {Object} gameData - Game data payload
 * @param {string} zoneHrid - Zone action hrid
 * @param {number} tier - The zone's difficulty tier
 * @param {Function} monsterMaxHp - (monsterHrid, tier) => max HP; the sim's own monster stats
 * @returns {{single: number, total: number}|null} null when no monster's HP could be read
 */
export function zoneEnemyHp(gameData, zoneHrid, tier, monsterMaxHp) {
    const info = gameData?.actionDetailMap?.[zoneHrid]?.combatZoneInfo;
    if (!info || typeof monsterMaxHp !== 'function') return null;
    const memo = new Map();
    const hpOf = (spawn) => {
        const hrid = spawn?.combatMonsterHrid;
        if (!hrid) return 0;
        const at = (Number(spawn.difficultyTier) || 0) + (Number(tier) || 0);
        const id = `${hrid}|${at}`;
        if (!memo.has(id)) {
            let hp = 0;
            try {
                hp = Number(monsterMaxHp(hrid, at)) || 0;
            } catch (error) {
                console.error('[TriggerTuning] Monster HP read failed:', error);
            }
            memo.set(id, hp > 0 ? hp : 0);
        }
        return memo.get(id);
    };
    const groupSum = (wave) => (wave || []).reduce((sum, spawn) => sum + hpOf(spawn), 0);

    const totals = [largestRandomGroup(info.fightInfo?.randomSpawnInfo, hpOf), groupSum(info.fightInfo?.bossSpawns)];
    for (const table of Object.values(info.dungeonInfo?.randomSpawnInfoMap || {})) {
        totals.push(largestRandomGroup(table, hpOf));
    }
    for (const wave of Object.values(info.dungeonInfo?.fixedSpawnsMap || {})) totals.push(groupSum(wave));

    const single = Math.max(0, ...memo.values());
    const total = Math.max(0, ...totals);
    return single > 0 ? { single, total: Math.max(total, single) } : null;
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
    const out = { xp: 0, profit: 0, revenue: 0, cost: 0, deaths: 0, dps: 0, encounters: sample?.encounters || 0 };
    for (const hrid of hrids) {
        const p = sample?.perPlayer?.[hrid];
        if (!p) continue;
        out.xp += p.xp || 0;
        out.profit += p.profit || 0;
        out.revenue += p.revenue || 0;
        out.cost += p.cost || 0;
        out.deaths += p.deaths || 0;
        out.dps += p.dps || 0;
    }
    return out;
}

/**
 * Smallest scale each percentage term is taken against, so a baseline of zero
 * (or next to it) still registers a change in either direction instead of
 * reading as no signal (zero) or as an enormous swing. Each is about the
 * smallest rate that means anything in a fight:
 * - XP: 100 EXP/h
 * - DPS: 1 damage per second
 * - Encounters: 1 per hour
 * - Profit: 1 gold/h, but see `profitScale`, which is what actually sets it
 */
export const SCORE_FLOORS = { xp: 100, dps: 1, encounters: 1, profit: 1 };

/**
 * What a profit change is a percentage of: the larger of the baseline's gross
 * loot value per hour and its consumable (and key) cost per hour, and never less
 * than the baseline profit itself or `SCORE_FLOORS.profit`.
 *
 * Profit is a small difference of two large numbers, so taking a change as a
 * percentage of the profit alone made the term meaningless near break-even: a
 * baseline of exactly 0 scored every gain and loss as 0, and a baseline of
 * +0.10 gold/h scored a few gold as +100. Against the gold actually moving
 * through the fight, a 45k gold/h loss on a 5k gold/h fight is the full -100.
 * @param {Object} base - The baseline's `scopeMetrics`
 * @returns {number} Always positive
 */
export function profitScale(base) {
    return Math.max(Math.abs(base.profit || 0), base.revenue || 0, base.cost || 0, SCORE_FLOORS.profit);
}

/**
 * Percent change against a scale, clamped to ±100 so no one term can dominate.
 * @param {number} value - The candidate's rate
 * @param {number} base - The baseline's rate
 * @param {number} scale - What 100% is: `max(|base|, floor)`
 * @returns {number}
 */
const pct = (value, base, scale) => {
    if (!(scale > 0)) return 0;
    return Math.max(-100, Math.min(100, (((value || 0) - (base || 0)) / scale) * 100));
};

/** The percent-change term of one metric, against its floored scale */
const term = (metrics, base, key) => {
    const scale = key === 'profit' ? profitScale(base) : Math.max(Math.abs(base[key] || 0), SCORE_FLOORS[key]);
    return pct(metrics[key], base[key], scale);
};

/**
 * The balanced objective: the average of four percentage changes against the
 * untouched setup — EXP/h, profit/h, DPS and encounters/h — less
 * `DEATH_POINTS_PER_PER_HOUR` points per extra death per hour. The deaths term
 * sits outside the average so it costs the full stated points, not a fifth of
 * them. It reads as "roughly, the average percent better", and zero is the
 * baseline.
 *
 * It mirrors the five axes the Upgrade tab's Score (balanced) blends, but not
 * its arithmetic: that score ranks candidates against each other by gold spent
 * per 0.01% gained, and a trigger change costs nothing, so there is nothing to
 * divide by. Each term is taken against `max(|baseline|, floor)` (see
 * `SCORE_FLOORS` and `profitScale`), so a zero baseline still counts a change
 * either way, and clamped to ±100 so no one term can dominate.
 * @param {Object} metrics - From `scopeMetrics`
 * @param {Object} base - The baseline's `scopeMetrics`
 * @returns {number} Score points
 */
export function balancedScore(metrics, base) {
    const terms = [
        term(metrics, base, 'xp'),
        term(metrics, base, 'profit'),
        term(metrics, base, 'dps'),
        term(metrics, base, 'encounters'),
    ];
    return terms.reduce((sum, t) => sum + t, 0) / terms.length + deathsTerm(metrics, base);
}

/**
 * Score points lost to extra deaths: `DEATH_POINTS_PER_PER_HOUR` per extra death
 * per hour, clamped to ±100 like the percentage terms.
 * @param {Object} metrics - From `scopeMetrics`
 * @param {Object} base - The baseline's `scopeMetrics`
 * @returns {number}
 */
function deathsTerm(metrics, base) {
    return Math.max(-100, Math.min(100, -DEATH_POINTS_PER_PER_HOUR * ((metrics.deaths || 0) - (base.deaths || 0))));
}

/** What the search optimizes: the balanced score, or one rate alone */
export const OBJECTIVES = [
    { key: 'balanced', label: 'Balanced' },
    { key: 'xp', label: 'XP/h' },
    { key: 'profit', label: 'Profit/h' },
];
export const DEFAULT_OBJECTIVE = 'balanced';

/**
 * The score the search maximizes. Balanced is `balancedScore`; XP/h and Profit/h
 * are the percentage change of that one rate, less the same deaths term, so the
 * minimum gain and the confirmation work in that rate's percent points.
 * @param {Object} metrics - From `scopeMetrics`
 * @param {Object} base - The baseline's `scopeMetrics`
 * @param {string} [objective] - An OBJECTIVES key; anything else is balanced
 * @returns {number} Score points
 */
export function objectiveScore(metrics, base, objective = DEFAULT_OBJECTIVE) {
    if (objective === 'xp') return term(metrics, base, 'xp') + deathsTerm(metrics, base);
    if (objective === 'profit') return term(metrics, base, 'profit') + deathsTerm(metrics, base);
    return balancedScore(metrics, base);
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

/** Two-sided 95% Student t critical values for 1..30 degrees of freedom */
const T_95 = [
    12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11,
    2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
];

/**
 * The two-sided 95% t critical value for a number of degrees of freedom.
 * @param {number} df - Degrees of freedom (seeds - 1)
 * @returns {number}
 */
export function tCritical(df) {
    if (!(df >= 1)) return Infinity;
    return df > T_95.length ? 1.96 : T_95[Math.floor(df) - 1];
}

/**
 * The acceptance rule: a paired gain is believed only when it is at least
 * `minGain` points and exceeds the 95% t bound for its own number of seeds.
 * @param {{mean: number, se: number, n?: number}} diff - From `pairedDiff`
 * @param {number} [minGain] - Smallest gain worth having
 * @returns {boolean}
 */
export function accepts(diff, minGain = MIN_GAIN) {
    if (!Number.isFinite(diff.se) || diff.mean < minGain || !(diff.mean > 0)) return false;
    return diff.mean > tCritical((diff.n ?? 0) - 1) * diff.se;
}

// ─── Sequential confirmation ────────────────────────────────────────────────

/**
 * Where a confirmation looks at its data, as fractions of its full seed count.
 * Each look adds seeds to the ones already run; none is ever re-run.
 */
export const CONFIRM_LOOK_FRACTIONS = [0.5, 0.75, 1];

/**
 * The confirmation's one-sided false-acceptance budget: the chance a change that
 * does nothing gets accepted. The fixed-length test it replaced (two-sided 95% t)
 * spent exactly this.
 */
export const CONFIRM_ALPHA = 0.025;

/**
 * Spent on stopping early for success at each interim look (a Haybittle-Peto
 * boundary); the final look gets what is left, so the budgets add up to
 * `CONFIRM_ALPHA` and the whole sequence keeps it (a union bound: no
 * correlation between looks is assumed). Stopping early for futility only ever
 * removes chances to accept, so it spends nothing.
 */
export const INTERIM_ALPHA = 0.001;

/**
 * The seed counts a confirmation of `total` seeds looks at.
 * @param {number} total - Full seed count
 * @returns {Array<number>} Ascending, unique, each at least 3 (a t test needs 2 df to say anything), ending at `total`
 */
export function confirmLooks(total) {
    const n = Math.max(1, Math.round(total));
    const looks = CONFIRM_LOOK_FRACTIONS.map((f) => Math.min(n, Math.max(3, Math.ceil(n * f))));
    return [...new Set([...looks, n])].sort((a, b) => a - b);
}

/** Log gamma (Lanczos), for the incomplete beta below */
function lnGamma(x) {
    const g = [
        676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905,
        -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
    ];
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
    const z = x - 1;
    let a = 0.99999999999980993;
    const t = z + 7.5;
    for (let i = 0; i < 8; i++) a += g[i] / (z + i + 1);
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued fraction for the regularized incomplete beta (modified Lentz) */
function betaContinuedFraction(a, b, x) {
    const tiny = 1e-300;
    let c = 1;
    let d = 1 - ((a + b) * x) / (a + 1);
    if (Math.abs(d) < tiny) d = tiny;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= 300; m++) {
        const m2 = 2 * m;
        let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
        d = 1 + aa * d;
        if (Math.abs(d) < tiny) d = tiny;
        c = 1 + aa / c;
        if (Math.abs(c) < tiny) c = tiny;
        d = 1 / d;
        h *= d * c;
        aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
        d = 1 + aa * d;
        if (Math.abs(d) < tiny) d = tiny;
        c = 1 + aa / c;
        if (Math.abs(c) < tiny) c = tiny;
        d = 1 / d;
        const delta = d * c;
        h *= delta;
        if (Math.abs(delta - 1) < 1e-14) break;
    }
    return h;
}

/** Regularized incomplete beta I_x(a, b) */
function betaIncomplete(a, b, x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(a, b, x)) / a;
    return 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/**
 * Student t cumulative distribution.
 * @param {number} t
 * @param {number} df - Degrees of freedom
 * @returns {number} P(T <= t)
 */
export function tCdf(t, df) {
    const tail = 0.5 * betaIncomplete(df / 2, 0.5, df / (df + t * t));
    return t > 0 ? 1 - tail : tail;
}

/**
 * Student t quantile, by bisection on `tCdf`.
 * @param {number} p - Probability in (0, 1)
 * @param {number} df - Degrees of freedom
 * @returns {number} t with P(T <= t) = p
 */
export function tQuantile(p, df) {
    if (!(df >= 1) || !(p > 0 && p < 1)) return NaN;
    if (p < 0.5) return -tQuantile(1 - p, df);
    const id = `${p}|${df}`;
    if (!T_QUANTILES.has(id)) T_QUANTILES.set(id, solveTQuantile(p, df));
    return T_QUANTILES.get(id);
}

/** Memo for tQuantile: the confirmation asks the same few (p, df) pairs over and over */
const T_QUANTILES = new Map();

function solveTQuantile(p, df) {
    let lo = 0;
    let hi = 1;
    while (tCdf(hi, df) < p && hi < 1e7) hi *= 2;
    for (let i = 0; i < 200 && hi - lo > 1e-10 * hi; i++) {
        const mid = (lo + hi) / 2;
        if (tCdf(mid, df) < p) lo = mid;
        else hi = mid;
    }
    return (lo + hi) / 2;
}

/**
 * One look of the sequential confirmation.
 *
 * - Interim look, success: the gain exceeds `minGain` by the t bound at
 *   one-sided `INTERIM_ALPHA`, a boundary so strict only an unmistakable gain
 *   crosses it. Testing against `minGain` rather than 0 keeps the early stop
 *   from accepting a gain that only looked big enough on its first few seeds.
 * - Interim look, futility: even the upper 95% bound of the gain is below
 *   `minGain`, so the remaining seeds could not plausibly rescue it.
 * - Final look: the old fixed-length rule with the budget the interim looks left
 *   (`CONFIRM_ALPHA - interims x INTERIM_ALPHA`, one-sided), and `minGain`.
 * @param {{mean: number, se: number, n: number}} diff - Paired difference so far
 * @param {number} look - 0-based look index
 * @param {number} lookCount - How many looks the confirmation has
 * @param {number} [minGain] - Smallest gain worth having
 * @returns {'accept'|'reject'|'continue'}
 */
export function sequentialVerdict(diff, look, lookCount, minGain = MIN_GAIN) {
    const final = look >= lookCount - 1;
    const df = (diff.n ?? 0) - 1;
    if (!Number.isFinite(diff.se) || !(df >= 1)) return final ? 'reject' : 'continue';
    const worthIt = diff.mean >= minGain && diff.mean > 0;
    if (final) {
        const alpha = CONFIRM_ALPHA - INTERIM_ALPHA * (lookCount - 1);
        return worthIt && diff.mean > tQuantile(1 - alpha, df) * diff.se ? 'accept' : 'reject';
    }
    if (worthIt && diff.mean - minGain > tQuantile(1 - INTERIM_ALPHA, df) * diff.se) return 'accept';
    if (diff.mean + tCritical(df) * diff.se < minGain) return 'reject';
    return 'continue';
}

// ─── Successive halving ─────────────────────────────────────────────────────

/**
 * Successive halving over one trigger's candidate values.
 *
 * Every candidate and the current value (the reference) are measured on the
 * same seeds; the best third survive into a round that simulates 1.5× longer,
 * and so on until the next cut would leave a single survivor. That survivor is
 * the winner, and its gain over the reference — paired per seed, from the last
 * round's samples is only a hint: the winner was picked on those samples, so
 * the caller must confirm it on seeds that took no part in the selection.
 * @param {Object} params
 * @param {Array<number>} params.values - Candidate values, excluding the reference
 * @param {number} params.reference - The current value
 * @param {number} params.hours - Hours per seed in the first round
 * @param {Function} params.measure - `(value, hours) => Promise<Array<Sample>|null>`; null means stopped
 * @param {Function} params.score - `(sample) => number`
 * @param {Function} [params.aborted] - `() => boolean`
 * @returns {Promise<Object|null>} `{ winner, diff, rounds, means, winnerSamples, referenceSamples }`, or null when the run was stopped before a first round finished
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
    };
}

// ─── The whole search ───────────────────────────────────────────────────────

/**
 * Estimate how many sims a search will run, for the progress bar. It is an
 * estimate: the real count depends on how many triggers the screen drops and
 * how many winners reach confirmation.
 * @param {number} tunableCount - Tunable rows
 * @param {string} [precision] - Precision key
 * @returns {number}
 */
export function estimateTriggerSims(tunableCount, precision = DEFAULT_PRECISION) {
    const seeds = (PRECISIONS[precision] || PRECISIONS[DEFAULT_PRECISION]).seeds;
    const confirmSeeds = Math.max(CONFIRM_SEEDS_MIN, seeds);
    // screen 13 points; coarse halving 13 + 5 + 3; fine halving 5 + 3; second pass 8
    const selection = (13 + 21 + 8 + 8) * seeds;
    // about one confirmation (winner and reference) per trigger that is worth it
    const confirmation = 2 * confirmSeeds;
    return seeds + tunableCount * (selection + confirmation) + 2 * confirmSeeds;
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
 * Selection and confirmation never share data. Choosing the best of many
 * candidates on a set of seeds and then testing it on those same seeds reports
 * the luck that made it win, so:
 *
 * 1. Baseline on the original setup: scope figures, party DPS, HP/MP pools.
 *    Rows whose slot never came into play are set aside (`unusedTunables`).
 * 2. Importance screen: each tunable across its coarse grid alone, on its own
 *    seeds; ordered by how far its scores spread and dropped unless some value
 *    clearly beats the current one.
 * 3. Coordinate descent, most impactful first, keeping earlier winners. Each
 *    step (a coarse halving, a fine halving, then a second fine pass) picks a
 *    winner on its own seeds, then runs winner against current on fresh seeds;
 *    only that second measurement can accept it (a sequential t test that may
 *    stop early either way, within a 2.5% one-sided error budget, and at least
 *    `MIN_GAIN` points).
 * 4. A fresh-seed head-to-head of the original setup against all the winners
 *    gates the whole result: if it is not significantly better, nothing is
 *    recommended.
 *
 * Stopping keeps whatever has been accepted so far (each already confirmed) and
 * skips the final head-to-head.
 * @param {Object} params
 * @param {Array<Object>} params.tunables - From `collectTunables`
 * @param {Array<string>} params.scopeHrids - Players whose figures are judged
 * @param {Function} params.measure - `(overrides, hoursPerSeed, stream, count, offset) => Promise<Array<Sample>|null>`;
 *   `stream` names a set of seeds (equal names share seeds, different names never do), `count` is how
 *   many seeds, `offset` (default 0) the index of the first, so a sequential look can add seeds 4..5
 *   to seeds 0..3 already run. Samples are `{ perPlayer, encounters, pools, triggerUse? }`; null means stopped.
 * @param {Object} params.precision - An entry of PRECISIONS
 * @param {number} [params.maxEnemies] - Most enemies up at once in the zone (the fallback enemy-HP range)
 * @param {{single: number, total: number}|null} [params.enemyHp] - From `zoneEnemyHp`: the enemy-HP range
 * @param {number} [params.minGain] - Smallest score gain worth offering (the 95% test always applies too)
 * @param {string} [params.objective] - What the score is: 'balanced' (default), 'xp' or 'profit' (`objectiveScore`)
 * @param {Function} [params.onProgress] - Called with `{ description }`
 * @param {Function} [params.aborted] - `() => boolean`
 * @returns {Promise<Object|null>} See the return below; null when stopped before the baseline
 */
export async function runTriggerSearch({
    tunables,
    scopeHrids,
    measure,
    precision,
    maxEnemies = 1,
    enemyHp = null,
    objective = DEFAULT_OBJECTIVE,
    minGain = MIN_GAIN,
    onProgress,
    aborted,
}) {
    const hoursPerSeed = precision.pointHours / precision.seeds;
    const confirmSeeds = Math.max(CONFIRM_SEEDS_MIN, precision.seeds);
    const confirmHours = hoursPerSeed * ROUND_GROWTH * ROUND_GROWTH;
    const overrides = {};
    const progress = (description) => onProgress?.({ description });
    const stopped = () => Boolean(aborted?.());

    const measureWith = (extra, hours, stream, count = precision.seeds, offset = 0) =>
        measure({ ...overrides, ...extra }, hours, stream, count, offset);

    progress('Triggers: measuring the baseline');
    const baselineSamples = await measureWith({}, hoursPerSeed * ROUND_GROWTH, 'baseline');
    if (!baselineSamples || stopped()) return null;

    const baseScope = (() => {
        const ms = baselineSamples.map((s) => scopeMetrics(s, scopeHrids));
        return {
            xp: mean(ms.map((m) => m.xp)),
            profit: mean(ms.map((m) => m.profit)),
            revenue: mean(ms.map((m) => m.revenue)),
            cost: mean(ms.map((m) => m.cost)),
            deaths: mean(ms.map((m) => m.deaths)),
            dps: mean(ms.map((m) => m.dps)),
            encounters: mean(ms.map((m) => m.encounters)),
        };
    })();
    const score = (sample) => objectiveScore(scopeMetrics(sample, scopeHrids), baseScope, objective);

    const partyDps = mean(
        baselineSamples.map((s) => Object.values(s.perPlayer || {}).reduce((sum, p) => sum + (p.dps || 0), 0))
    );
    const pools = {};
    for (const [hrid, p] of Object.entries(baselineSamples[0]?.pools || {})) pools[hrid] = p;
    const ctx = { partyDps, pools, maxEnemies, enemyHp };

    // 1b. Drop rows the baseline shows cannot matter (never read); they are reported, not tuned
    const unused = unusedTunables(tunables, baselineSamples);
    const unusedKeys = new Set(unused.map((t) => t.key));
    const live = tunables.filter((t) => !unusedKeys.has(t.key));

    const state = new Map(tunables.map((t) => [t.key, { tunable: t, current: t.original }]));
    const currentOf = (t) => state.get(t.key).current;
    const tried = new Map(tunables.map((t) => [t.key, new Set([t.original])]));

    // 2. Importance screen, each trigger on its own seeds
    const screen = [];
    for (const t of live) {
        if (stopped()) break;
        const grid = coarseGrid(t, ctx).filter((v) => v !== t.original);
        progress(`Triggers: screening ${t.itemName}`);
        const entries = [t.original, ...grid];
        const measured = await Promise.all(
            entries.map((v) => measureWith({ [t.key]: v }, hoursPerSeed, `screen:${t.key}`))
        );
        if (stopped() || measured.some((m) => !m)) break;
        const scores = entries.map((_, i) => measured[i].map((s) => score(s)));
        const means = scores.map(mean);
        let bestIndex = 1;
        for (let i = 2; i < entries.length; i++) if (means[i] > means[bestIndex]) bestIndex = i;
        const bestDiff = grid.length > 0 ? pairedDiff(scores[bestIndex], scores[0]) : { mean: 0, se: Infinity };
        screen.push({
            tunable: t,
            range: Math.max(...means) - Math.min(...means),
            promising: bestDiff.mean >= minGain && bestDiff.mean > SCREEN_Z * bestDiff.se,
        });
    }
    screen.sort((a, b) => b.range - a.range);

    // 3. Coordinate descent
    const changeLog = new Map();
    let stepCounter = 0;
    const record = (t, diff, winnerSamples, referenceSamples) => {
        const entry = changeLog.get(t.key) || { deltaScore: 0, variance: 0, xp: 0, profit: 0, deaths: 0 };
        const refM = metricsMean(referenceSamples, scopeHrids);
        const winM = metricsMean(winnerSamples, scopeHrids);
        entry.deltaScore += diff.mean;
        entry.variance += diff.se ** 2;
        entry.xp += winM.xp - refM.xp;
        entry.profit += winM.profit - refM.profit;
        entry.deaths += winM.deaths - refM.deaths;
        changeLog.set(t.key, entry);
    };
    const tune = async (t, values, label) => {
        const candidates = values.filter((v) => v !== currentOf(t));
        if (candidates.length === 0) return false;
        for (const v of candidates) tried.get(t.key).add(v);
        const step = ++stepCounter;
        progress(`Triggers: ${t.itemName} (${label})`);
        const before = currentOf(t);

        const selection = await successiveHalving({
            values: candidates,
            reference: before,
            hours: hoursPerSeed,
            measure: (value, hours) => measureWith({ [t.key]: value }, hours, `select:${step}`),
            score,
            aborted,
        });
        if (!selection || stopped()) return false;
        // The selection gain is inflated by having been chosen; half the bar is a cheap way to skip hopeless ones
        if (selection.winner === before || selection.diff.mean < minGain / 2) return false;

        progress(`Triggers: ${t.itemName} (confirming)`);
        // Sequential: look after half, three quarters and all of the seeds, stopping as soon as the answer
        // is clear either way (see sequentialVerdict). Each look only adds seeds.
        const stream = `confirm:${step}`;
        const looks = confirmLooks(confirmSeeds);
        let referenceSamples = [];
        let winnerSamples = [];
        let diff = null;
        let verdict = 'continue';
        for (let look = 0; look < looks.length && verdict === 'continue'; look++) {
            const from = look > 0 ? looks[look - 1] : 0;
            const count = looks[look] - from;
            const [moreReference, moreWinner] = await Promise.all([
                measureWith({ [t.key]: before }, confirmHours, stream, count, from),
                measureWith({ [t.key]: selection.winner }, confirmHours, stream, count, from),
            ]);
            if (!moreReference || !moreWinner || stopped()) return false;
            referenceSamples = referenceSamples.concat(moreReference);
            winnerSamples = winnerSamples.concat(moreWinner);
            diff = pairedDiff(
                winnerSamples.map((s) => score(s)),
                referenceSamples.map((s) => score(s))
            );
            verdict = sequentialVerdict(diff, look, looks.length, minGain);
        }
        if (verdict !== 'accept') return false;

        state.get(t.key).current = selection.winner;
        overrides[t.key] = selection.winner;
        record(t, diff, winnerSamples, referenceSamples);
        return true;
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

    // 4. The combination, on seeds nothing above has seen, gates the whole result
    let combined = null;
    let reliable = null;
    const buildChanges = () => {
        const out = [];
        for (const t of tunables) {
            const log = changeLog.get(t.key);
            if (currentOf(t) === t.original || !log) continue;
            out.push({
                ...t,
                from: t.original,
                to: currentOf(t),
                deltaScore: log.deltaScore,
                se: Math.sqrt(log.variance),
                deltaXp: log.xp,
                deltaProfit: log.profit,
                deltaDeaths: log.deaths,
            });
        }
        return out.sort((a, b) => b.deltaScore - a.deltaScore);
    };
    let changes = buildChanges();
    let rejected = [];
    if (changes.length > 0 && !stopped()) {
        progress('Triggers: confirming all changes together');
        const [orig, tuned] = await Promise.all([
            measure({}, confirmHours, 'final', confirmSeeds),
            measure({ ...overrides }, confirmHours, 'final', confirmSeeds),
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
            reliable = accepts(diff, minGain);
            if (!reliable) {
                rejected = changes;
                changes = [];
            }
        }
    }

    const kept = new Set(changes.map((c) => c.key));
    return {
        stopped: stopped(),
        objective,
        baseline: baseScope,
        partyDps,
        screened: screen.map((s) => ({ key: s.tunable.key, range: s.range, promising: s.promising })),
        changes,
        rejected,
        unchanged: tunables.filter((t) => !kept.has(t.key) && !unusedKeys.has(t.key)),
        unused,
        combined,
        reliable,
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
