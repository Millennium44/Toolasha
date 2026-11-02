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
    trialWeekStart,
} from './guild-trials-math.js';
import { matchTrialHrid } from './guild-trials-scrape.js';
import {
    FOREIGN_CYCLE_REASON,
    cardClearedTier,
    describeCycleAge,
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
        results.push({
            weekStart,
            cycleFrom,
            archivedAt,
            trial: trial.key,
            kind: trial.kind,
            name: trial.name,
            cardTier,
            points: statesPoints(tile) ? tile.points : null,
            completed: Boolean(tile.completed),
            serverTier,
            serverTierAt: serverTier !== null && Number.isFinite(tile.serverTierAt) ? tile.serverTierAt : null,
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
    const rank = (result) => [Number.isFinite(result.serverTierAt) ? result.serverTierAt : -1, result.serverTier];
    const server = stated.length
        ? stated.reduce((best, result) => (ahead(rank(result), rank(best)) ? result : best))
        : null;
    const stamps = [held.archivedAt, other.archivedAt].filter(Number.isFinite);
    return {
        ...card,
        archivedAt: stamps.length ? Math.min(...stamps) : null,
        serverTier: server ? server.serverTier : null,
        serverTierAt: server ? (server.serverTierAt ?? null) : null,
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
    return { ...record, trialResults: trialResultsOf(record) };
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
    const tier = resultTier(result);
    const cardSawIt = Number.isFinite(result?.cardTier) && result.cardTier === tier;
    if (cardSawIt && Number.isFinite(result?.points)) return { points: result.points, derived: false };
    if (!Number.isFinite(tier) || !Number.isFinite(buildersHallBonus) || buildersHallBonus <= -1) return null;
    return { points: guildPoints(trialBasePoints(result.kind, tier), buildersHallBonus), derived: true };
}

/**
 * When a cycle was, as the history prints it.
 * @param {{weekStart: number, cycleFrom: number|null}} cycle - A cycle
 * @param {number} now - Clock
 * @returns {string} e.g. `Last week`, `This week (ended Tue 3:00 PM)`
 */
function cycleLabel(cycle, now) {
    const age = describeCycleAge({ weekStart: cycle.weekStart }, now) || '—';
    const when = age.charAt(0).toUpperCase() + age.slice(1);
    if (!Number.isFinite(cycle.cycleFrom)) return when;
    const ended = new Date(cycle.cycleFrom).toLocaleString('en-US', {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
    });
    return `${when} (ended ${ended})`;
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
 * @returns {{cycles: Array<{key: string, label: string}>, rows: Array<Object>}} The history
 */
export function trialResultsHistory(results, { now = Date.now(), buildersHallBonus = null } = {}) {
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
                if (!result) return { key: cycle.key, label: cycle.label, tier: null, points: null };
                return {
                    key: cycle.key,
                    label: cycle.label,
                    tier: resultTier(result),
                    points: resultPoints(result, buildersHallBonus),
                    completed: Boolean(result.completed),
                };
            });
            // The best ever, and the most recent cycle that reached it
            let best = null;
            for (const week of weeks) {
                if (Number.isFinite(week.tier) && (best === null || week.tier > best.tier)) best = week;
            }
            return {
                id: entry.id,
                trial: entry.trial,
                kind: entry.kind,
                name: entry.name,
                weeks,
                best: best ? { tier: best.tier, label: best.label } : null,
            };
        })
        .sort((a, b) =>
            a.kind !== b.kind ? (a.kind === 'combat' ? -1 : 1) : String(a.name).localeCompare(String(b.name))
        );

    return { cycles, rows };
}

/**
 * One week's tier as a cell: `T7`, or "—" when the trial has no result for it.
 * @param {Object} week - A row's week
 * @returns {string} The cell
 */
function tierCell(week) {
    return Number.isFinite(week?.tier) ? `T${week.tier}` : '—';
}

/** How many of a trial's cycles the inline line shows */
export const INLINE_CYCLES = 6;

/**
 * A trial's history as one compact line: its last cycles, newest first, then its best.
 * @param {Object} row - A row from {@link trialResultsHistory}
 * @param {number} [inline] - How many cycles to show
 * @returns {string} e.g. `T7 · T9 · — · T8 · best T9 (2 weeks ago)`
 */
export function trialHistoryCells(row, inline = INLINE_CYCLES) {
    const shown = (row?.weeks || []).slice(0, inline).map(tierCell);
    const hidden = Math.max(0, (row?.weeks || []).length - inline);
    const best = row?.best
        ? `best T${row.best.tier} (${row.best.label.charAt(0).toLowerCase()}${row.best.label.slice(1)})`
        : 'best —';
    return [...shown, ...(hidden ? [`+${hidden} earlier`] : []), best].join(' · ');
}

/**
 * Every cycle of a trial's history, one per line, for a hover.
 * @param {Object} row - A row from {@link trialResultsHistory}
 * @returns {string} Plain text
 */
export function trialHistoryDetail(row) {
    const lines = (row?.weeks || []).map((week) => {
        if (!Number.isFinite(week.tier)) return `${week.label}: —`;
        const points = week.points
            ? ` · ${week.points.derived ? '~' : ''}${formatWithSeparator(Math.round(week.points.points))} pts`
            : '';
        return `${week.label}: T${week.tier}${points}`;
    });
    return [
        `${row?.name ?? 'Trial'} — tier reached each finished cycle, newest first.`,
        '"—" is a cycle this client never saw a result for; T0 is a real result.',
        '~ marks points priced from a tier the guild payload stated, at today’s Builder’s Hall bonus.',
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
