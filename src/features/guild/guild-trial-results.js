/**
 * Every finished trial's result, kept long after its week's tiles are gone.
 *
 * `record.history` keeps the last {@link MAX_ARCHIVED_CYCLES} cycles whole —
 * tiles, samples and all — which is right for the "Past weeks" lines and far
 * too heavy to keep for a year. This is the slim half beside it: one entry per
 * finished cycle per trial, holding only what a player asks of a past week
 * ("what tier did we reach on Alchemy?"), in `record.trialResults`.
 *
 * ## Derived from the archive, never written on its own
 *
 * Every entry is read off an archived cycle by {@link resultsFromHistory}, and
 * the stored list is that read unioned with what was kept before
 * ({@link trialResultsOf}). Folding the whole archive each time, rather than
 * appending at the moment a cycle is put away, is what keeps late statements:
 * the guild payload goes on writing into a week after it is archived (the last
 * hour of a cycle running past the rollover), and two devices' archives of one
 * week are folded together later still. The fold is idempotent, so it is run at
 * every write and read the same way by the display.
 *
 * ## One entry per cycle and trial
 *
 * Keyed by week, test-server cycle (`cycleFrom`, null on live) and trial — the
 * same identity `pastCycles` gives a week, so the two blocks never disagree on
 * how many weeks there were. Two copies of one entry are folded as
 * `foldArchivedCycle` folds two archives: the guild payload's tier from the
 * newer statement, the card's fields from the copy that states more. "More"
 * starts with the card's tier, so a week archived again off its zeroed cards
 * (a finite `tier: 0`) never replaces the tier that week reached.
 *
 * Points are kept only where a card stated them. A tier the guild payload stated
 * beyond the card's is priced off the ladder when drawn, with the guild's
 * current Builder's Hall bonus, and marked as derived — the store has no bonus
 * to price it with, and a figure priced once and frozen would look stated.
 *
 * A cycle archived off another guild's record ({@link FOREIGN_CYCLE_REASON}) is
 * never a result of this guild's, and a tile whose name is not a known trial is
 * never a result at all.
 */

import {
    COMBAT_ENCOUNTERS,
    TRIAL_SKILLS,
    guildPoints,
    trialBasePoints,
    trialFromHrid,
    TRIAL_ACTIVE_MS,
    TRIAL_BUDGET_MS,
    TRIAL_MAX_TIER,
    tierFromLevel,
    trialWeekStart,
} from './guild-trials-math.js';
import { matchTrialHrid } from './guild-trials-scrape.js';
import {
    FOREIGN_CYCLE_REASON,
    cardClearedTier,
    clearedTier,
    cycleEndLabel,
    describeCycleAge,
    payloadPoints,
    zeroedCardPoints,
    serverClearedTier,
    statesPoints,
} from './guild-trial-history.js';
import { isTestServer } from '../../utils/game-server.js';
import { formatWithSeparator } from '../../utils/formatters.js';

/** Finished cycles kept on live, where a cycle is a week: a year of them */
export const MAX_RESULT_WEEKS = 52;

/** Finished cycles kept on the test server, which runs several a day */
export const MAX_RESULT_CYCLES_TEST = 120;

/** Every trial as an hrid, for {@link matchTrialHrid} */
const TRIAL_HRIDS = [
    ...COMBAT_ENCOUNTERS.map((key) => `/guild_combat/${key}`),
    ...TRIAL_SKILLS.map((key) => `/guild_skilling/${key}`),
];

/**
 * Which trial a tile is, by the name its card carries.
 * @param {Object} tile - An archived tile
 * @returns {{kind: string, key: string, name: string}|null} As {@link trialFromHrid} names it; null for anything else
 */
export function trialOfTile(tile) {
    const hrid = matchTrialHrid(tile?.name, TRIAL_HRIDS);
    return hrid ? trialFromHrid(hrid) : null;
}

// ─── What a trial leaves besides its tier ───────────────────────────────────

/** Members whose sign-up level is kept per trial; more than a guild roster holds */
export const MAX_SIGNUP_LEVELS = 120;

/** Tiers whose clear stamp is kept per trial; the ladder has 21 */
const MAX_CLEAR_TIERS = 40;

/** Why a trial ended, where that could be told: the ladder finished, the hour ran out, or it stopped with time left */
export const END_REASONS = ['ladder', 'clock', 'early'];

/**
 * A trial's tier-clear stamps, packed for keeping long after the week's tiles are gone.
 *
 * `{from, t}`: `from` is the earliest stamp in client ms and `t` maps each tier
 * to its milliseconds after it — about twelve bytes a tier against twenty-five
 * for the absolute stamp.
 *
 * @param {Object|null} seen - A tile's `tierSeenAt`, `{tier: clientMs}`
 * @returns {{from: number, t: Object<string, number>}|null} Null with no usable stamp
 */
export function encodeClears(seen) {
    const stamps = Object.entries(seen && typeof seen === 'object' ? seen : {})
        .map(([tier, at]) => [Number(tier), Number(at)])
        .filter(([tier, at]) => Number.isInteger(tier) && tier >= 1 && Number.isFinite(at))
        .sort((a, b) => a[0] - b[0])
        .slice(0, MAX_CLEAR_TIERS);
    if (!stamps.length) return null;
    const from = Math.min(...stamps.map(([, at]) => at));
    return { from, t: Object.fromEntries(stamps.map(([tier, at]) => [tier, at - from])) };
}

/**
 * {@link encodeClears} read back.
 * @param {{from: number, t: Object}|null} clears - A stored `clears`
 * @returns {Object<string, number>} `{tier: clientMs}`; empty for anything malformed
 */
export function decodeClears(clears) {
    if (!clears || typeof clears !== 'object' || !Number.isFinite(clears.from)) return {};
    const seen = {};
    for (const [tier, offset] of Object.entries(clears.t && typeof clears.t === 'object' ? clears.t : {})) {
        if (Number(tier) >= 1 && Number.isFinite(offset)) seen[tier] = clears.from + offset;
    }
    return seen;
}

/**
 * Two copies of one trial's packed clears as one: every tier either holds, the earlier sighting of a shared one.
 * @param {Object|null} a - One side's `clears`
 * @param {Object|null} b - The other side's
 * @returns {{from: number, t: Object}|null} Null when neither holds a stamp
 */
export function mergeClears(a, b) {
    const merged = {};
    for (const side of [decodeClears(a), decodeClears(b)]) {
        for (const [tier, at] of Object.entries(side)) {
            merged[tier] = Number.isFinite(merged[tier]) ? Math.min(merged[tier], at) : at;
        }
    }
    return encodeClears(merged);
}

/**
 * A sign-up level map as kept: whole-number levels by character id, at most {@link MAX_SIGNUP_LEVELS}.
 * @param {Object|null} levels - `{characterId: level}`
 * @returns {Object<string, number>} Never null; `{}` for no usable entry
 */
export function boundSignupLevels(levels) {
    const entries = Object.entries(levels && typeof levels === 'object' ? levels : {})
        .map(([id, level]) => [id, Number(level)])
        .filter(([, level]) => Number.isFinite(level) && level >= 1 && level <= 1000)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .slice(0, MAX_SIGNUP_LEVELS);
    return Object.fromEntries(entries);
}

/**
 * The end and sign-up facts two copies of one trial hold, as one — shared by a live tile and a result.
 *
 * Neither is overwritten once stated, so the earlier observation of each wins:
 * the first moment the end was seen (its reason with it), and the first
 * non-empty sign-up map (on the test server, of two ends a trial's hour apart, the later cycle's). A map stated empty stands only when the other copy has
 * none; "never loaded" (no `signupLevels` field at all) is told apart from
 * "nobody signed up" (`{}`).
 *
 * @param {Object|null} a - One copy
 * @param {Object|null} b - The other
 * @returns {Object} Spreadable: `endedAt`, `endReason`, `signupLevels`, `signupLevelsAt`, each only where a copy has it
 */
export function mergeTrialFacts(a, b) {
    const out = {};
    const ended = [a, b].filter((side) => Number.isFinite(side?.endedAt));
    if (ended.length) {
        // Earliest wins, except on the test server (several cycles a week): two ends more than a trial's hour
        // apart are two cycles', and the later is the current one. A stale tab's pre-cut end must not outlive it
        const apart =
            ended.length > 1 && isTestServer() && Math.abs(ended[0].endedAt - ended[1].endedAt) > TRIAL_ACTIVE_MS;
        const first = ended.reduce((best, side) =>
            (apart ? side.endedAt > best.endedAt : side.endedAt < best.endedAt) ? side : best
        );
        const reason = [first, ...ended.filter((side) => side.endedAt === first.endedAt)]
            .map((side) => side.endReason)
            .find((value) => END_REASONS.includes(value));
        out.endedAt = first.endedAt;
        if (reason) out.endReason = reason;
    }
    const mapped = [a, b].filter((side) => side?.signupLevels && typeof side.signupLevels === 'object');
    if (mapped.length) {
        const filled = (side) => Object.keys(side.signupLevels).length > 0;
        const at = (side) => (Number.isFinite(side.signupLevelsAt) ? side.signupLevelsAt : Infinity);
        const pool = mapped.some(filled) ? mapped.filter(filled) : mapped;
        const first = pool.reduce((best, side) => (at(side) < at(best) ? side : best));
        out.signupLevels = boundSignupLevels(first.signupLevels);
        if (Number.isFinite(first.signupLevelsAt)) out.signupLevelsAt = first.signupLevelsAt;
    }
    return out;
}

/**
 * A `clears` value as a spreadable field, absent when there is none.
 * @param {Object|null} clears - From {@link encodeClears}
 * @returns {{clears?: Object}} Spreadable
 */
function clearsField(clears) {
    return clears ? { clears } : {};
}

/**
 * The key one result is filed under.
 * @param {Object} result - A result entry
 * @returns {string} `week|cycle|kind:trial`
 */
function resultKey(result) {
    return `${result.weekStart}|${result.cycleFrom ?? ''}|${result.kind}:${result.trial}`;
}

/**
 * The week an archived cycle belongs to.
 * @param {Object} cycle - An archived cycle
 * @returns {number|null} Week start, ms
 */
function cycleWeek(cycle) {
    if (Number.isFinite(cycle?.weekStart)) return cycle.weekStart;
    if (Number.isFinite(cycle?.archivedAt)) return trialWeekStart(cycle.archivedAt);
    return null;
}

/**
 * Whether a tagged combat reading (or the observation filed from one) summed
 * fewer monsters than its wave fields — one Badger card of two, one stream slot.
 * A reading tagged before the game data arrived carries no `waveCount`; the
 * count known now is passed in for it.
 *
 * @param {Object|null} reading - A reading or observation
 * @param {number|null} [waveCount] - The wave's monster count from the game data, for a reading that lacks one
 * @returns {boolean}
 */
export function isPartialWaveReading(reading, waveCount = null) {
    const count = Number.isFinite(reading?.waveCount) ? reading.waveCount : waveCount;
    return (
        typeof reading?.source === 'string' &&
        Number.isFinite(reading.slots) &&
        Number.isFinite(count) &&
        reading.slots < count
    );
}

/**
 * Whether a tier is the ladder's last, which carries no percent.
 * @param {number|null} tier - Tiers cleared
 * @returns {boolean} True at {@link TRIAL_MAX_TIER} or above
 */
function atLastTier(tier) {
    return Number.isFinite(tier) && tier >= TRIAL_MAX_TIER;
}

/**
 * The trial's end percent into the next tier, as the game states it, for the tier the result reports.
 *
 * The guild payload's `nextTierProgress` of the finished party first (`serverProgress`, 0.6471 → 64): it is
 * the exact figure and arrives whatever tab is open. Failing that, the finished card's "+64%" beside its level
 * (`levelProgress`). Both are kept only once the trial is over (`recordServerTiers`, `recordTileSample`), so
 * this is the end figure and never a running one; nothing else stands in. Each counts only for the tier it was
 * read at — a payload's `highestTier`, a card's level — and only when that is the tier the result reports
 * ({@link clearedTier}), so a percent is never shown against another tier. The last tier has none.
 *
 * @param {Object} tile - An archived tile
 * @returns {{pct: number, tier: number, at: number|null}|null} Null when the trial's end percent was not seen
 */
export function endProgress(tile) {
    const tier = clearedTier(tile);
    if (!Number.isFinite(tier) || atLastTier(tier)) return null;
    const whole = (pct) => Number.isInteger(pct) && pct >= 0 && pct <= 99;
    const at = (value) => (Number.isFinite(value) ? value : null);

    const server = tile?.serverProgress;
    if (server && typeof server === 'object' && whole(server.pct) && server.tier === tier) {
        return { pct: server.pct, tier, at: at(server.at) };
    }
    const card = tile?.levelProgress;
    if (card && typeof card === 'object' && whole(card.pct) && tierFromLevel(card.level) === tier) {
        return { pct: card.pct, tier, at: at(card.at) };
    }
    return null;
}

/**
 * The results one archived cycle states.
 * @param {Object} cycle - An archived cycle from `record.history`
 * @returns {Array<Object>} One entry per trial that stated a result; none for a foreign cycle
 */
export function resultsFromCycle(cycle) {
    if (!cycle || typeof cycle !== 'object' || cycle.reason === FOREIGN_CYCLE_REASON) return [];
    const weekStart = cycleWeek(cycle);
    if (weekStart === null) return [];
    const cycleFrom = Number.isFinite(cycle.cycleFrom) ? cycle.cycleFrom : null;
    const archivedAt = Number.isFinite(cycle.archivedAt) ? cycle.archivedAt : null;

    const results = [];
    for (const tile of Object.values(cycle.tiles || {})) {
        const trial = trialOfTile(tile);
        if (!trial) continue;
        const cardTier = cardClearedTier(tile);
        const serverTier = serverClearedTier(tile);
        // A card nobody saw a result on, with no statement from the payload, is
        // not a result: the week shows "—" for it, never a zero
        if (cardTier === null && serverTier === null) continue;
        // Nor is a card archived off its zeroed state: a finite tier 0 with
        // nothing banked, not finished and no payload statement states nothing
        // (the untouched zero Past weeks prints as "—"). A finished T0 is a result
        if (cardTier === 0 && !(tile.points > 0) && !tile.completed && serverTier === null) continue;
        // The game's own end percent, and nothing else: no bar reading stands in for it
        const figure = endProgress(tile);
        results.push({
            weekStart,
            cycleFrom,
            archivedAt,
            trial: trial.key,
            kind: trial.kind,
            name: trial.name,
            cardTier,
            points: zeroedCardPoints(tile) ?? (statesPoints(tile) ? tile.points : null),
            completed: Boolean(tile.completed),
            serverTier,
            serverTierAt: serverTier !== null && Number.isFinite(tile.serverTierAt) ? tile.serverTierAt : null,
            // Additive: an entry from a build before these existed has none of them, which reads as unknown. A new
            // name rather than `progress`, which older builds filled from bar readings: what is shown is this alone
            ...(figure
                ? {
                      endProgress: figure.pct,
                      endProgressTier: figure.tier,
                      ...(figure.at === null ? {} : { endProgressAt: figure.at }),
                  }
                : {}),
            ...clearsField(encodeClears(tile.tierSeenAt)),
            ...mergeTrialFacts(tile, null),
            // The guild's own figure, an older build's record has none; read as absent
            serverPoints: payloadPoints(tile),
        });
    }
    return results;
}

/**
 * Every result the archived cycles state.
 * @param {Array<Object>} history - `record.history`
 * @returns {Array<Object>} Unfolded; {@link mergeResults} makes them one per key
 */
export function resultsFromHistory(history) {
    return (Array.isArray(history) ? history : []).flatMap(resultsFromCycle);
}

/**
 * How much of a result the card stated: its tier, then its points, then whether it finished.
 * @param {Object} result - A result entry
 * @returns {number[]} Compared in order
 */
function cardWeight(result) {
    return [
        Number.isFinite(result?.cardTier) ? result.cardTier : -1,
        Number.isFinite(result?.points) ? result.points : -1,
        result?.completed ? 1 : 0,
    ];
}

/**
 * Whether one ranking is ahead of another, element by element.
 * @param {number[]} a - One ranking
 * @param {number[]} b - The other
 * @returns {boolean} True when `a` is strictly ahead
 */
function ahead(a, b) {
    const at = a.findIndex((value, index) => value !== b[index]);
    return at >= 0 && a[at] > b[at];
}

/**
 * Two copies of one result as one.
 * @param {Object} held - The copy already kept
 * @param {Object} other - The other copy
 * @returns {Object} The card's fields from the fuller copy, the payload's tier from the newer statement
 */
function mergeResult(held, other) {
    const card = ahead(cardWeight(other), cardWeight(held)) ? other : held;
    // Newest statement wins, as `latestServerTier` has it — not the highest
    // tier. Known limit: a later statement of a lower tier (another party's,
    // filed under the same trial) would stand over an earlier higher one
    const stated = [held, other].filter((result) => Number.isFinite(result?.serverTier));
    const rank = (result) => [
        Number.isFinite(result.serverTierAt) ? result.serverTierAt : -1,
        result.serverTier,
        Number.isFinite(result.serverPoints) ? result.serverPoints : -1,
    ];
    const server = stated.length
        ? stated.reduce((best, result) => (ahead(rank(result), rank(best)) ? result : best))
        : null;
    const stamps = [held.archivedAt, other.archivedAt].filter(Number.isFinite);
    // The card's copy is kept whole, but the other copy can carry what it lacks: stamps, the end, the sign-ups
    const rest = { ...card };
    // The percent belongs to the card's tier: from either copy at that tier, the further one
    const progresses = [held, other]
        .filter((result) => result.cardTier === card.cardTier && Number.isFinite(result.progress))
        .map((result) => result.progress);
    if (progresses.length) rest.progress = Math.max(...progresses);
    else delete rest.progress;
    // The trial's end percent, with the tier it was read for: the newest read of the copies, never a stale one
    // over a fresh one nor the higher percent. Its tier travels with it, so it is never re-attached to another
    const figures = [held, other].filter(
        (result) =>
            Number.isInteger(result.endProgress) &&
            result.endProgress >= 0 &&
            result.endProgress <= 99 &&
            Number.isInteger(result.endProgressTier)
    );
    for (const field of ['endProgress', 'endProgressTier', 'endProgressAt']) delete rest[field];
    if (figures.length) {
        const readAt = (result) => (Number.isFinite(result.endProgressAt) ? result.endProgressAt : -1);
        const newest = figures.reduce((best, result) => (readAt(result) > readAt(best) ? result : best));
        rest.endProgress = newest.endProgress;
        rest.endProgressTier = newest.endProgressTier;
        if (Number.isFinite(newest.endProgressAt)) rest.endProgressAt = newest.endProgressAt;
    }
    for (const field of ['endedAt', 'endReason', 'signupLevels', 'signupLevelsAt', 'clears']) delete rest[field];
    // The payload's figure only stands while the card has not outrun it, the rule `payloadPoints` applies
    const outrun = server && Number.isFinite(card.cardTier) && card.cardTier > server.serverTier;
    return {
        ...rest,
        ...clearsField(mergeClears(held.clears, other.clears)),
        ...mergeTrialFacts(held, other),
        archivedAt: stamps.length ? Math.min(...stamps) : null,
        serverTier: server ? server.serverTier : null,
        serverTierAt: server ? (server.serverTierAt ?? null) : null,
        serverPoints: server && !outrun && Number.isFinite(server.serverPoints) ? server.serverPoints : null,
    };
}

/**
 * When a result's cycle happened, for ordering: its week, then within the week
 * the cycle it closed (test server) or when it was archived.
 * @param {Object} result - A result entry
 * @returns {number[]} `[week, within]`
 */
function resultOrder(result) {
    const within = Number.isFinite(result.cycleFrom)
        ? result.cycleFrom
        : Number.isFinite(result.archivedAt)
          ? result.archivedAt
          : -Infinity;
    return [result.weekStart, within];
}

/**
 * The cycle a result belongs to, as one string.
 * @param {Object} result - A result entry
 * @returns {string} `week|cycle`
 */
function cycleKeyOf(result) {
    return `${result.weekStart}|${result.cycleFrom ?? ''}`;
}

/**
 * How many finished cycles are kept here.
 * @returns {number} {@link MAX_RESULT_WEEKS} on live, {@link MAX_RESULT_CYCLES_TEST} on the test server
 */
export function resultCycleCap() {
    return isTestServer() ? MAX_RESULT_CYCLES_TEST : MAX_RESULT_WEEKS;
}

/**
 * Whether a stored entry is shaped like a result.
 * @param {*} result - A stored entry
 * @returns {boolean}
 */
function isResult(result) {
    return (
        Boolean(result) &&
        typeof result === 'object' &&
        Number.isFinite(result.weekStart) &&
        typeof result.trial === 'string' &&
        typeof result.kind === 'string' &&
        typeof result.name === 'string'
    );
}

/**
 * Several lists of results as one: one entry per cycle and trial, oldest first,
 * capped to the newest {@link resultCycleCap} cycles.
 *
 * Sorted before the cap, never by the order the lists came in: a stale device's
 * record appends its older weeks last, and capping by position would keep those
 * and drop the newer weeks.
 *
 * @param {...Array<Object>} lists - Lists of results
 * @returns {Array<Object>} A new array
 */
export function mergeResults(...lists) {
    const byKey = new Map();
    for (const list of lists) {
        for (const result of Array.isArray(list) ? list : []) {
            if (!isResult(result)) continue;
            const key = resultKey(result);
            const held = byKey.get(key);
            byKey.set(key, held ? mergeResult(held, result) : result);
        }
    }
    const sorted = [...byKey.values()].sort((a, b) => {
        const [aw, ai] = resultOrder(a);
        const [bw, bi] = resultOrder(b);
        if (aw !== bw) return aw - bw;
        if (ai !== bi) return ai - bi;
        return resultKey(a) < resultKey(b) ? -1 : resultKey(a) > resultKey(b) ? 1 : 0;
    });

    // Each cycle once, in the order its first result sorts
    const cycles = [...new Set(sorted.map(cycleKeyOf))];
    const kept = new Set(cycles.slice(-resultCycleCap()));
    return sorted.filter((result) => kept.has(cycleKeyOf(result)));
}

/**
 * A record's results: what it kept, with everything its archive states folded in.
 * @param {Object|null} record - A trial record
 * @returns {Array<Object>} Oldest first
 */
export function trialResultsOf(record) {
    return mergeResults(record?.trialResults, resultsFromHistory(record?.history));
}

/**
 * A record with its results brought up to date with its archive.
 * @param {Object} record - A trial record (not mutated)
 * @returns {Object} A copy with `trialResults` set
 */
export function withTrialResults(record) {
    if (!record || typeof record !== 'object') return record;
    const cycleTrials = cycleTrialsOf(record);
    const rest = { ...record };
    delete rest.cycleTrials;
    return { ...rest, trialResults: trialResultsOf(record), ...(cycleTrials.length ? { cycleTrials } : {}) };
}

// ─── Which trials the game said ran each cycle ──────────────────────────────

/*
 * The game's `currentTrials` lists exactly the trials a cycle runs — a test
 * cycle ran 6 of the 15 — and a trial it did not list leaves no result and no
 * tile. Without the list, "did not run" cannot be told from "ran, and this
 * client saw nothing", which is why the list is saved with each cycle.
 *
 * Three shapes, all additive and all absent when unknown:
 *
 * - `record.scheduled` — the running cycle's lists, one per kind, each
 *   `{trials: ['alchemy', …], at}` (trial keys, `at` the client ms the list is
 *   placed at). A kind is written on its own: combat starts an hour after
 *   skilling, so one kind's list says nothing about the other's.
 * - `cycle.scheduled` — the same, on the archived cycle the record put away.
 * - `record.cycleTrials` — `[{weekStart, cycleFrom, skilling?: [...], combat?: [...]}]`,
 *   the slim list beside `trialResults`, derived from the archive the same way
 *   and kept as long. A kind with no list in it is unknown, never "nothing ran".
 */

/** The two kinds a cycle runs, in the order the hours come */
const SCHEDULE_KINDS = ['skilling', 'combat'];

/**
 * A list of trial keys as kept: strings only, once each, sorted.
 * @param {*} trials - A stored list
 * @returns {string[]} Never null; empty for anything malformed
 */
function cleanTrialKeys(trials) {
    if (!Array.isArray(trials)) return [];
    return [...new Set(trials.filter((key) => typeof key === 'string' && key))].sort();
}

/**
 * One kind's stored list, or nothing.
 * @param {*} side - `{trials, at}` as stored
 * @returns {{trials: string[], at: number}|null} Null unless it holds a trial and a finite stamp
 */
export function cleanScheduledSide(side) {
    const trials = cleanTrialKeys(side?.trials);
    if (!trials.length || !Number.isFinite(side?.at)) return null;
    return { trials, at: side.at };
}

/**
 * A stored `scheduled` as kept: the kinds that hold a usable list.
 * @param {*} scheduled - `{skilling?, combat?}`
 * @returns {Object|null} Null when no kind holds one
 */
export function cleanScheduled(scheduled) {
    const out = {};
    for (const kind of SCHEDULE_KINDS) {
        const side = cleanScheduledSide(scheduled?.[kind]);
        if (side) out[kind] = side;
    }
    return Object.keys(out).length ? out : null;
}

/**
 * How far apart two lists of one kind can be placed and still be one cycle's.
 *
 * A kind's placements within a cycle all fall inside that kind's hour (its start, or its newest
 * stamp, an hour later at most), so they are an hour apart at most, plus the skew between two
 * devices' clocks. The next cycle's list of the same kind is a cycle later: a day on the test
 * server, a week on live, two hours at the very least. The window sits between the two.
 *
 * It is a distance and not a grid of hour-wide slots: a cycle's hour starts on the hour or
 * half past, so a grid put one cycle's start-of-hour list and its end-of-hour list in
 * neighboring slots, and a fuller list was replaced by a partial one.
 */
export const SAME_CYCLE_WINDOW_MS = 1.5 * TRIAL_BUDGET_MS;

/**
 * Whether two lists of one kind are one cycle's, stated twice.
 * @param {{at: number}} a - A cleaned side
 * @param {{at: number}} b - Another
 * @returns {boolean} True when they are placed within {@link SAME_CYCLE_WINDOW_MS} of each other
 */
export function sameScheduleCycle(a, b) {
    return Math.abs(a.at - b.at) < SAME_CYCLE_WINDOW_MS;
}

/**
 * Two copies of one kind's list as one.
 *
 * Lists of one cycle are one statement made more than once, and the fuller (the union) stands:
 * a `parties` list fills in as the cycle goes, and a copy placed later is not a fuller one.
 * Lists of two cycles are not added: the later cycle's wins whole, and an earlier cycle's list
 * must not be added to it. Which is which is {@link sameScheduleCycle}. A kind's placements
 * never span more than the window, so the rule gives one answer whichever way round, and in
 * whatever grouping, copies are folded: a merge between devices converges.
 *
 * @param {Object|null} a - One side
 * @param {Object|null} b - The other
 * @returns {{trials: string[], at: number}|null} Null when neither holds a list
 */
export function mergeScheduledSide(a, b) {
    const left = cleanScheduledSide(a);
    const right = cleanScheduledSide(b);
    if (!left || !right) return left || right;
    if (!sameScheduleCycle(left, right)) return left.at > right.at ? left : right;
    return { trials: cleanTrialKeys([...left.trials, ...right.trials]), at: Math.max(left.at, right.at) };
}

/**
 * Two `scheduled` objects as one, kind by kind.
 * @param {Object|null} a - One side
 * @param {Object|null} b - The other
 * @returns {Object|null} Null when neither holds a list
 */
export function mergeScheduled(a, b) {
    const out = {};
    for (const kind of SCHEDULE_KINDS) {
        const side = mergeScheduledSide(a?.[kind], b?.[kind]);
        if (side) out[kind] = side;
    }
    return Object.keys(out).length ? out : null;
}

/**
 * Divide a record's lists at a cycle's start: what was placed before it, and what was not.
 *
 * `from` is per kind, as the tile cut is; a kind with no boundary is left where it is.
 *
 * @param {Object|null} scheduled - A record's `scheduled`
 * @param {{skilling: number|null, combat: number|null}} from - Client ms the cycle began, per kind
 * @returns {{earlier: Object|null, current: Object|null}} Either null when it has none
 */
export function splitScheduled(scheduled, from) {
    const earlier = {};
    const current = {};
    for (const kind of SCHEDULE_KINDS) {
        const side = cleanScheduledSide(scheduled?.[kind]);
        if (!side) continue;
        if (Number.isFinite(from?.[kind]) && side.at < from[kind]) earlier[kind] = side;
        else current[kind] = side;
    }
    return {
        earlier: Object.keys(earlier).length ? earlier : null,
        current: Object.keys(current).length ? current : null,
    };
}

/**
 * The lists an archived cycle states, as a `cycleTrials` entry.
 * @param {Object} cycle - An archived cycle from `record.history`
 * @returns {Object|null} Null for a foreign cycle, one with no week, or one that kept no list
 */
export function cycleTrialsFromCycle(cycle) {
    if (!cycle || typeof cycle !== 'object' || cycle.reason === FOREIGN_CYCLE_REASON) return null;
    const weekStart = cycleWeek(cycle);
    const scheduled = cleanScheduled(cycle.scheduled);
    if (weekStart === null || !scheduled) return null;
    return {
        weekStart,
        cycleFrom: Number.isFinite(cycle.cycleFrom) ? cycle.cycleFrom : null,
        ...Object.fromEntries(Object.entries(scheduled).map(([kind, side]) => [kind, side.trials])),
    };
}

/**
 * Every list the archived cycles state.
 * @param {Array<Object>} history - `record.history`
 * @returns {Array<Object>} Unfolded; {@link mergeCycleTrials} makes them one per cycle
 */
export function cycleTrialsFromHistory(history) {
    return (Array.isArray(history) ? history : []).map(cycleTrialsFromCycle).filter(Boolean);
}

/**
 * Several lists of cycle lists as one: one entry per cycle, a kind's list the union of the copies,
 * oldest first, capped to the newest {@link resultCycleCap} cycles.
 *
 * Two copies of one cycle are one statement made twice, so they are unioned; a kind only one copy
 * has stays that copy's. A cycle is a week on live and a week and `cycleFrom` on the test server,
 * the identity the results use.
 *
 * @param {...Array<Object>} lists - Lists of entries
 * @returns {Array<Object>} A new array
 */
export function mergeCycleTrials(...lists) {
    const byCycle = new Map();
    for (const list of lists) {
        for (const entry of Array.isArray(list) ? list : []) {
            if (!entry || typeof entry !== 'object' || !Number.isFinite(entry.weekStart)) continue;
            const cycleFrom = Number.isFinite(entry.cycleFrom) ? entry.cycleFrom : null;
            const key = `${entry.weekStart}|${cycleFrom ?? ''}`;
            const held = byCycle.get(key) || { weekStart: entry.weekStart, cycleFrom };
            for (const kind of SCHEDULE_KINDS) {
                const trials = cleanTrialKeys(entry[kind]);
                if (trials.length) held[kind] = cleanTrialKeys([...(held[kind] || []), ...trials]);
            }
            byCycle.set(key, held);
        }
    }
    const order = (entry) => [entry.weekStart, entry.cycleFrom ?? -Infinity];
    const sorted = [...byCycle.values()]
        .filter((entry) => SCHEDULE_KINDS.some((kind) => entry[kind]))
        .sort((a, b) => {
            const [aw, ai] = order(a);
            const [bw, bi] = order(b);
            return aw !== bw ? aw - bw : ai !== bi ? ai - bi : 0;
        });
    return sorted.slice(-resultCycleCap());
}

/**
 * A record's cycle lists: what it kept, with everything its archive states folded in.
 * @param {Object|null} record - A trial record
 * @returns {Array<Object>} Oldest first; empty when no cycle kept a list
 */
export function cycleTrialsOf(record) {
    return mergeCycleTrials(record?.cycleTrials, cycleTrialsFromHistory(record?.history));
}

/**
 * The tier a result reached: the higher of the card's and the guild payload's.
 * @param {Object} result - A result entry
 * @returns {number|null} Tiers cleared
 */
export function resultTier(result) {
    const card = Number.isFinite(result?.cardTier) ? result.cardTier : null;
    const server = Number.isFinite(result?.serverTier) ? result.serverTier : null;
    if (card === null) return server;
    return server === null ? card : Math.max(card, server);
}

/**
 * What a result was worth in Guild Points.
 *
 * The card's stated figure where the card saw the tier reached; a tier only the
 * guild payload stated is priced off the ladder at the bonus passed in, and
 * marked derived. With no usable bonus, nothing.
 *
 * @param {Object} result - A result entry
 * @param {number|null} [buildersHallBonus] - Builder's Hall bonus fraction
 * @returns {{points: number, derived: boolean}|null} The figure
 */
export function resultPoints(result, buildersHallBonus = null) {
    // The guild payload's own figure, where it stood: exact, so not derived, and
    // it needs no bonus. A result an older build stored has none and falls through
    if (Number.isFinite(result?.serverPoints) && result.serverPoints > 0) {
        return { points: result.serverPoints, derived: false };
    }
    const tier = resultTier(result);
    const cardSawIt = Number.isFinite(result?.cardTier) && result.cardTier === tier;
    // A zero above T0 is a card zeroed by the cycle's roll, not a result: every
    // tier pays something, so it is priced off the ladder or left unknown
    const statedZero = result?.points === 0 && tier > 0;
    if (cardSawIt && Number.isFinite(result?.points) && !statedZero) return { points: result.points, derived: false };
    if (!Number.isFinite(tier) || !Number.isFinite(buildersHallBonus) || buildersHallBonus <= -1) return null;
    return { points: guildPoints(trialBasePoints(result.kind, tier), buildersHallBonus), derived: true };
}

/**
 * When a cycle was, as the history prints it.
 * @param {{weekStart: number, cycleFrom: number|null}} cycle - A cycle
 * @param {number} now - Clock
 * @returns {string} e.g. `Last week`, or `Tue 3:00 PM` on the test server
 */
function cycleLabel(cycle, now) {
    return cycleEndLabel(describeCycleAge({ weekStart: cycle.weekStart }, now), cycle.cycleFrom);
}

/**
 * The results as one row per trial, for the history block, the card hover and the report.
 *
 * The cycles are every finished cycle any trial has a result for, newest first,
 * so every row lines up under the same weeks: a trial absent from one has no
 * entry for it, which prints "—". The live week's own archive is the live
 * record rather than a past week and is left out, as "Past weeks" leaves it out;
 * a test-server cycle of this week is a past cycle and is kept.
 *
 * @param {Array<Object>} results - From {@link trialResultsOf}
 * @param {Object} [options] - Context
 * @param {number} [options.now] - Clock
 * @param {number|null} [options.buildersHallBonus] - For pricing a tier only the payload stated
 * @param {Array<Object>} [options.cycleTrials] - From {@link cycleTrialsOf}. A cell with no result is marked `notRun`
 *   only when the cycle's list for the trial's kind is there and omits the trial; with no list it is unknown, as before.
 *   Never read for a tier, a point or a best
 * @returns {{cycles: Array<{key: string, label: string}>, rows: Array<Object>}} The history
 */
export function trialResultsHistory(results, { now = Date.now(), buildersHallBonus = null, cycleTrials = [] } = {}) {
    const thisWeek = trialWeekStart(now);
    const past = (Array.isArray(results) ? results : []).filter(
        (result) => isResult(result) && !(result.weekStart >= thisWeek && !Number.isFinite(result.cycleFrom))
    );

    const cycleMap = new Map();
    for (const result of past) {
        const key = cycleKeyOf(result);
        const order = resultOrder(result);
        const held = cycleMap.get(key);
        if (!held || order[1] > held.order[1]) {
            cycleMap.set(key, { key, weekStart: result.weekStart, cycleFrom: result.cycleFrom ?? null, order });
        }
    }
    const cycles = [...cycleMap.values()]
        .sort((a, b) => (a.order[0] !== b.order[0] ? b.order[0] - a.order[0] : b.order[1] - a.order[1]))
        .map((cycle) => ({ key: cycle.key, label: cycleLabel(cycle, now) }));

    const listed = new Map();
    for (const entry of Array.isArray(cycleTrials) ? cycleTrials : []) {
        if (!entry || typeof entry !== 'object' || !Number.isFinite(entry.weekStart)) continue;
        listed.set(`${entry.weekStart}|${Number.isFinite(entry.cycleFrom) ? entry.cycleFrom : ''}`, entry);
    }
    // The game's list for this cycle and kind says the trial was not on it. No list is no answer
    const didNotRun = (cycleKey, kind, trial) => {
        const list = listed.get(cycleKey)?.[kind];
        return Array.isArray(list) && list.length > 0 && !list.includes(trial);
    };

    const byTrial = new Map();
    for (const result of past) {
        const id = `${result.kind}:${result.trial}`;
        if (!byTrial.has(id)) {
            byTrial.set(id, { id, trial: result.trial, kind: result.kind, name: result.name, byCycle: new Map() });
        }
        byTrial.get(id).byCycle.set(cycleKeyOf(result), result);
    }

    const rows = [...byTrial.values()]
        .map((entry) => {
            const weeks = cycles.map((cycle) => {
                const result = entry.byCycle.get(cycle.key);
                if (!result) {
                    const empty = { key: cycle.key, label: cycle.label, tier: null, points: null };
                    if (didNotRun(cycle.key, entry.kind, entry.trial)) empty.notRun = true;
                    return empty;
                }
                const tier = resultTier(result);
                // The game's end percent, shown only against the tier it was read for; the last tier has none. An
                // older entry's `progress` was the last bar reading, not the game's end figure: kept stored, not shown
                const progress =
                    Number.isInteger(result.endProgress) && result.endProgressTier === tier && !atLastTier(tier)
                        ? result.endProgress
                        : null;
                return {
                    key: cycle.key,
                    label: cycle.label,
                    tier,
                    progress,
                    points: resultPoints(result, buildersHallBonus),
                    completed: Boolean(result.completed),
                };
            });
            // The best ever, and the most recent cycle that reached it
            let best = null;
            for (const week of weeks) {
                // The highest tier, and at a tie the further one; a tie of those keeps the newest
                const further = (week.progress ?? -1) > (best?.progress ?? -1);
                if (
                    Number.isFinite(week.tier) &&
                    (best === null || week.tier > best.tier || (week.tier === best.tier && further))
                ) {
                    best = week;
                }
            }
            return {
                id: entry.id,
                trial: entry.trial,
                kind: entry.kind,
                name: entry.name,
                weeks,
                best: best ? { tier: best.tier, progress: best.progress ?? null, label: best.label } : null,
            };
        })
        .sort((a, b) =>
            a.kind !== b.kind ? (a.kind === 'combat' ? -1 : 1) : String(a.name).localeCompare(String(b.name))
        );

    return { cycles, rows };
}

/** The cell for a cycle the game's own list says a trial did not run in: empty */
export const NOT_RUN_CELL = '';

/**
 * A tier with the percent reached in the next one, e.g. `T15 63%`; the tier alone where no percent was kept.
 * @param {number} tier - Tiers cleared
 * @param {number|null} [progress] - Whole percent into the next tier
 * @returns {string} The text
 */
function tierWithProgress(tier, progress) {
    return Number.isFinite(progress) ? `T${tier} ${progress}%` : `T${tier}`;
}

/**
 * One week's tier as a cell: `T15 63%` (the tier and the progress reached in the next one; the tier
 * alone for a cycle recorded before the percent was), empty when the game's list for that cycle did not
 * include the trial, or "—" when it is not tracked (it ran, or this client has no list for the cycle).
 * @param {Object} week - A row's week
 * @returns {string} The cell
 */
export function trialHistoryCell(week) {
    if (Number.isFinite(week?.tier)) return tierWithProgress(week.tier, week.progress);
    return week?.notRun ? NOT_RUN_CELL : '—';
}

/** How many of a trial's cycles the inline line shows */
export const INLINE_CYCLES = 6;

/**
 * A trial's last cycles as plain tiers, newest first.
 * @param {Object} row - A row from {@link trialResultsHistory}
 * @param {number} [inline] - How many cycles to show
 * @returns {string} e.g. `T20 · n/r · —`, with `+3 earlier` after them when some are left out
 */
export function trialHistoryTiers(row, inline = INLINE_CYCLES) {
    // Written text keeps "n/r" for a cycle the table leaves blank, so the line still reads
    const shown = (row?.weeks || []).slice(0, inline).map((week) => trialHistoryCell(week) || 'n/r');
    const hidden = Math.max(0, (row?.weeks || []).length - inline);
    return [...shown, ...(hidden ? [`+${hidden} earlier`] : [])].join(' · ');
}

/**
 * A trial's best tier, without the date (that is the hover's).
 * @param {Object} row - A row from {@link trialResultsHistory}
 * @returns {string} `T20`, or "—" when no cycle has a result
 */
export function trialHistoryBest(row) {
    return row?.best ? tierWithProgress(row.best.tier, row.best.progress) : '—';
}

/**
 * Where a cycle label reads inside a sentence: a relative age ("Last week") drops
 * its capital, a plain end time ("Mon 3:00 PM") keeps it.
 * @param {string} label - A cycle label
 * @returns {string} The label for the middle of a sentence
 */
function inSentence(label) {
    return /^[A-Z][a-z]{2} \d/.test(label) ? label : `${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

/**
 * A trial's history as one compact line: its last cycles, newest first, then its best.
 * Used by the text report; the panel draws {@link trialHistoryTiers} and {@link trialHistoryBest}.
 * @param {Object} row - A row from {@link trialResultsHistory}
 * @param {number} [inline] - How many cycles to show
 * @returns {string} e.g. `T7 · T9 · — · T8 · best T9 (2 weeks ago)`
 */
export function trialHistoryCells(row, inline = INLINE_CYCLES) {
    const best = row?.best
        ? `best ${tierWithProgress(row.best.tier, row.best.progress)} (${inSentence(row.best.label)})`
        : 'best —';
    return [trialHistoryTiers(row, inline), best].filter(Boolean).join(' · ');
}

/**
 * Every cycle of a trial's history, one per line, for a hover.
 * @param {Object} row - A row from {@link trialResultsHistory}
 * @returns {string} Plain text
 */
export function trialHistoryDetail(row) {
    const lines = (row?.weeks || []).map((week) => {
        if (!Number.isFinite(week.tier)) return `${week.label}: ${week.notRun ? 'did not run' : '—'}`;
        // An unknown figure is "—", never 0: a tier above T0 always paid something
        const points = week.points
            ? `${week.points.derived ? '~' : ''}${formatWithSeparator(Math.round(week.points.points))} pts`
            : '— pts';
        return `${week.label}: ${tierWithProgress(week.tier, week.progress)} · ${points}`;
    });
    return [
        `${row?.name ?? 'Trial'} — tier and progress reached each finished cycle, newest first.`,
        '"T15 63%" is tier 15 cleared and 63% of the way through the next; the last tier, T21, has no next and shows the tier alone, as does a cycle whose end percent this client never saw.',
        '"—" is a cycle this client has not tracked (the trial ran, or this client has no list of what ran) or a points figure it never saw; T0 is a real result.',
        'A blank cell is a cycle the game’s own list says the trial did not run in.',
        '~ marks points priced from a tier the guild payload stated, at today’s Builder’s Hall bonus.',
        ...(row?.best
            ? [`Best: ${tierWithProgress(row.best.tier, row.best.progress)}, ${inSentence(row.best.label)}.`]
            : []),
        '',
        ...lines,
    ].join('\n');
}

/**
 * A trial's row in a history, by the name a card carries.
 * @param {{rows: Array<Object>}} history - From {@link trialResultsHistory}
 * @param {string} name - A card's name
 * @returns {Object|null} The row, or null when the trial has no past results
 */
export function historyRowFor(history, name) {
    const trial = trialOfTile({ name });
    if (!trial) return null;
    return (history?.rows || []).find((row) => row.trial === trial.key && row.kind === trial.kind) || null;
}
