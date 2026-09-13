/**
 * Saving a finished guild trial for the trial damage board's History view.
 *
 * `guild-trial-damage.js` holds one trial at a time and forgets it on a
 * character switch, on "End & start new" and when the next week's fight arms.
 * This reads its breakdown on the recorder's own fifteen-second cadence and
 * files the trial once it is over, without the damage module or the recorder
 * knowing it exists.
 *
 * ## Archived once, and with the game's totals when they come
 *
 * A trial is over when the breakdown says so (`endedAt`, or `endedByGame`).
 * The game's own per-member totals (`guild_trial_stats_updated`) land on the
 * breakdown as `reported` some seconds later — 28 s in a recorded trial — and
 * the recorder already patches its final snapshot with them. So a trial is
 * saved the moment `reported` is in hand, or {@link RECONCILE_WAIT_MS} after
 * the end without it. The stats message repeats every time the game's own
 * Stats panel is opened; a reading already saved at the same basis and length
 * is not saved again, and a stream reading never replaces one in the game's
 * totals.
 *
 * ## A trial that never ended
 *
 * Cut short by a character switch, tracking switched off, a restart, or a
 * breakdown that simply started over, the last reading is saved marked as cut
 * short. It is filed under the character the reading was taken for, which the
 * reading records — by the time a switch is handled the id has already moved on.
 */

import guildTrialDamage from './guild-trial-damage.js';
import guildTrialAbilities from './guild-trial-abilities.js';
import { guildTrialRecorder, RECONCILE_WAIT_MS, SNAPSHOT_MS } from './guild-trial-recorder.js';
import { isUnnamedRowName } from './guild-trial-units.js';
import { snapshotTierMarks, thinTrialRates, trialRates } from './trial-dps-graph.js';
import { currentCharacterId, historyEnabled, saveHistoryEntry } from '../combat/meter-history.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';

/** How often the breakdown is read: the recorder's cadence */
export const TRIAL_HISTORY_POLL_MS = SNAPSHOT_MS;

/** Watched seconds a trial needs before it is kept, when the game stated no totals */
export const MIN_TRIAL_SECONDS = 30;

/** The latest reading: `{at, characterId, firstSeenAt, breakdown, classes, graph}` */
let last = null;
/** `characterId|id` → `{basis, seconds}` of what was saved, so a repeat is not saved again */
const saved = new Map();
const timers = createTimerRegistry();
let running = false;

/**
 * Copy the numeric and boolean fields of an object.
 * @param {Object} source - Anything
 * @returns {Object}
 */
function scalars(source) {
    const out = {};
    for (const [key, value] of Object.entries(source || {})) {
        if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    }
    return out;
}

/**
 * The breakdown cut down to what the trial damage board draws.
 *
 * Pure. The export-only parts — boss sheets, the stored week of stats, the
 * spectator's counters, cast maps — are left behind.
 *
 * @param {Object} breakdown - From `guildTrialDamage.breakdown()`
 * @returns {Object} A breakdown the board can draw read-only
 */
export function thinTrialBreakdown(breakdown) {
    const b = breakdown || {};
    const support = b.support || {};
    return {
        measured: Boolean(b.measured),
        measuredSupport: Boolean(b.measuredSupport),
        stale: false,
        active: false,
        frozen: true,
        encounter: b.encounter ?? null,
        reason: b.reason ?? null,
        seconds: Number(b.seconds) || 0,
        source: b.source ?? null,
        tier: b.tier ?? null,
        wave: b.wave ?? null,
        fights: b.fights ?? 0,
        endedAt: b.endedAt ?? null,
        endedByGame: Boolean(b.endedByGame),
        endedBy: b.endedBy ?? null,
        bossName: b.bossName ?? null,
        participants: b.participants ?? null,
        roster: Object.fromEntries(
            Object.entries(b.roster || {}).map(([index, entry]) => [
                index,
                typeof entry === 'string' ? entry : (entry?.name ?? null),
            ])
        ),
        countedNames: [...(b.countedNames || [])],
        nameCoverage: b.nameCoverage ?? null,
        damageCeiling: b.damageCeiling ?? null,
        trialNames: [...(b.trialNames || [])],
        tierStarts: { ...(b.tierStarts || {}) },
        reported: b.reported && Object.keys(b.reported).length ? { ...b.reported } : null,
        team: b.team ? { ...b.team } : null,
        totalDamage: Number(b.totalDamage) || 0,
        totalDotDamage: Number(b.totalDotDamage) || 0,
        totalKills: Number(b.totalKills) || 0,
        partyDps: Number.isFinite(b.partyDps) ? b.partyDps : null,
        players: (b.players || []).map((player) => ({
            index: player.index,
            name: player.name,
            measured: player.measured,
            damage: player.damage || 0,
            dotDamage: player.dotDamage || 0,
            hits: player.hits || 0,
            crits: player.crits || 0,
            misses: player.misses || 0,
            deaths: player.deaths || 0,
            kills: player.kills || 0,
            accuracy: player.accuracy ?? null,
            critRate: player.critRate ?? null,
            dps: player.dps ?? null,
            share: player.share ?? null,
            abilities: (player.abilities || []).map((ability) => ({ ...ability })),
        })),
        support: {
            ...scalars(support),
            players: (support.players || []).map((row) => ({
                index: row.index,
                name: row.name,
                healingDone: row.healingDone || 0,
                healingByCaster: row.healingByCaster || 0,
                damageTaken: row.damageTaken || 0,
                manaSpent: row.manaSpent || 0,
                manaRestored: row.manaRestored || 0,
                manaOuts: row.manaOuts || 0,
                starvedOuts: row.starvedOuts || 0,
                lowManaOuts: row.lowManaOuts || 0,
                casts: row.casts || 0,
                healCasts: row.healCasts || 0,
            })),
        },
    };
}

/**
 * The graph a saved trial draws: the leaders' rates and the tier changes.
 * @param {Object|null} session - The recorder's session
 * @param {Object} breakdown - The live breakdown, as the newest reading
 * @returns {{rates: Object, marks: Array<Object>}|null}
 */
export function trialGraphFor(session, breakdown) {
    const snapshots = session?.snapshots || [];
    const rates = trialRates(snapshots, breakdown);
    if (rates.xs.length < 2) return null;
    return { rates: thinTrialRates(rates), marks: snapshotTierMarks(snapshots) };
}

/**
 * What a trial is called in the list.
 * @param {Object} breakdown - A thinned breakdown
 * @returns {string}
 */
function trialLabel(breakdown) {
    const name =
        breakdown.bossName ||
        String(breakdown.encounter || '')
            .split('/')
            .pop()
            .replace(/_/g, ' ')
            .replace(/\b\w/g, (letter) => letter.toUpperCase()) ||
        'Guild trial';
    const tiers = [
        ...Object.keys(breakdown.tierStarts || {}).map(Number),
        ...(Number.isFinite(breakdown.tier) ? [breakdown.tier] : []),
    ].filter(Number.isFinite);
    if (!tiers.length) return name;
    const from = Math.min(...tiers);
    const to = Math.max(...tiers);
    return `${name} ${from === to ? `T${from}` : `T${from}–T${to}`}`;
}

/**
 * A saved trial's body, or null when there is too little to keep.
 *
 * Pure. Kept when the game stated totals for it, or when it was watched for
 * {@link MIN_TRIAL_SECONDS} and anybody has a row.
 *
 * @param {Object} sample - A reading
 * @param {boolean} finished - Whether the trial ended, as against being cut short
 * @returns {Object|null}
 */
export function buildTrialEntry(sample, finished) {
    const breakdown = sample?.breakdown;
    if (!breakdown) return null;
    const reported = breakdown.reported;
    const hasRows = breakdown.players.length > 0 || breakdown.support.players.length > 0;
    if (!reported && (breakdown.seconds < MIN_TRIAL_SECONDS || !hasRows)) return null;

    const starts = Object.values(breakdown.tierStarts || {})
        .map(Number)
        .filter((at) => Number.isFinite(at) && at > 0);
    const startedAt = starts.length ? Math.min(...starts) : Number(sample.firstSeenAt) || Number(sample.at);
    const gameTotal = reported
        ? Object.values(reported).reduce((sum, stats) => sum + (Number(stats?.damage) || 0), 0)
        : null;
    // The unnamed row is slots nobody could name, most of them members counted
    // again under their names from later tiers — not another player
    const players = new Set(
        [...breakdown.players, ...breakdown.support.players, ...Object.keys(reported || {}).map((name) => ({ name }))]
            .filter((row) => !isUnnamedRowName(row?.name))
            .map((row) => String(row?.name || '').toLowerCase())
            .filter(Boolean)
    ).size;

    return {
        version: 1,
        type: 'trial',
        id: `trial_${String(breakdown.encounter || 'trial').replace(/[^\w-]/g, '_')}_${startedAt}`,
        startedAt,
        endedAt: Number.isFinite(breakdown.endedAt) ? breakdown.endedAt : Number(sample.at),
        seconds: breakdown.seconds,
        basis: reported ? 'game' : 'stream',
        finished: Boolean(finished),
        summary: {
            label: trialLabel(breakdown),
            detail: `${players} player${players === 1 ? '' : 's'}`,
            total: gameTotal ?? (Number(breakdown.team?.damage) || breakdown.totalDamage),
            perSecond: breakdown.partyDps,
            players,
        },
        breakdown,
        classes: sample.classes || {},
        graph: sample.graph || null,
    };
}

/**
 * Save a reading, unless the same reading is saved already.
 * @param {Object} sample - The reading
 * @param {boolean} finished - Whether the trial ended
 * @returns {Promise<Object|null>} The summary filed
 */
async function archive(sample, finished) {
    try {
        if (!historyEnabled()) return null;
        const entry = buildTrialEntry(sample, finished);
        if (!entry) return null;

        const key = `${sample.characterId}|${entry.id}`;
        const held = saved.get(key);
        if (held) {
            if (held.basis === 'game' && entry.basis !== 'game') return null;
            if (held.basis === entry.basis && entry.seconds <= held.seconds + 1 && held.finished >= finished) {
                return null;
            }
        }
        saved.set(key, { basis: entry.basis, seconds: entry.seconds, finished });
        return await saveHistoryEntry(entry, sample.characterId);
    } catch (error) {
        console.error('[TrialHistory] Saving a finished trial failed:', error);
        return null;
    }
}

/**
 * Whether a breakdown belongs to a different trial than the reading before it.
 * @param {Object} previous - The last reading
 * @param {Object} breakdown - The breakdown now
 * @param {string} characterId - Who is logged in now
 * @returns {boolean}
 */
function startedOver(previous, breakdown, characterId) {
    if (previous.characterId !== characterId) return true;
    const before = previous.breakdown;
    const seconds = Number(breakdown?.seconds) || 0;
    if (seconds < before.seconds - 1) return true;
    const encounter = breakdown?.encounter ?? null;
    return Boolean(before.encounter && encounter && before.encounter !== encounter);
}

/** @returns {Object|null} The live breakdown, or null when it cannot be read */
function readBreakdown() {
    try {
        return guildTrialDamage.breakdown?.() || null;
    } catch (error) {
        console.error('[TrialHistory] Reading the trial breakdown failed:', error);
        return null;
    }
}

/**
 * Take one reading; save the trial when it has ended, or the one before when
 * this reading belongs to another.
 *
 * @param {number} [now] - Clock
 * @param {Object} [inputs] - Injectable for tests
 * @param {Object} [inputs.breakdown] - `guildTrialDamage.breakdown()`
 * @param {string} [inputs.characterId] - Whose reading this is
 * @param {Object|null} [inputs.session] - The recorder's session
 * @param {Object} [inputs.classes] - `guildTrialAbilities.classes()`
 * @returns {Array<Promise>} The saves started, for tests
 */
export function sampleTrialHistory(now = Date.now(), inputs = {}) {
    const breakdown = inputs.breakdown !== undefined ? inputs.breakdown : readBreakdown();
    const characterId = inputs.characterId ?? currentCharacterId();
    const saves = [];

    if (last && startedOver(last, breakdown, characterId)) {
        saves.push(archive(last, false));
        last = null;
    }

    const hasData = Boolean(breakdown?.players?.length || breakdown?.support?.players?.length);
    if (!hasData) return saves;

    const session = inputs.session !== undefined ? inputs.session : guildTrialRecorder?.session;
    let classes = inputs.classes;
    if (classes === undefined) {
        try {
            classes = guildTrialAbilities.classes?.() || {};
        } catch (error) {
            console.error('[TrialHistory] Reading classes failed:', error);
            classes = {};
        }
    }

    last = {
        at: now,
        characterId,
        firstSeenAt: last?.firstSeenAt ?? now,
        breakdown: thinTrialBreakdown(breakdown),
        classes: { ...classes },
        graph: trialGraphFor(session, breakdown),
    };

    const endedAt = Number.isFinite(breakdown.endedAt) ? breakdown.endedAt : null;
    if (endedAt !== null || breakdown.endedByGame === true) {
        const reported = Boolean(last.breakdown.reported);
        if (reported || now - (endedAt ?? now) > RECONCILE_WAIT_MS) saves.push(archive(last, true));
    }
    return saves;
}

/**
 * Save the trial in hand as it stands, and let go of it.
 *
 * Reads the breakdown once more under the character the last reading was
 * taken for, since a character switch has already moved the current id on by
 * the time this runs; a breakdown already reset is caught as a new trial and
 * the old reading is saved instead.
 *
 * @returns {Promise<Array>} The saves started
 */
export async function flushTrialHistory() {
    if (!last) return [];
    const held = last;
    const saves = sampleTrialHistory(Date.now(), { characterId: held.characterId });
    // A breakdown that started over had the held reading saved by the sample;
    // whatever it read afterwards is not provably this character's
    const finished = last && last.firstSeenAt === held.firstSeenAt ? last : null;
    last = null;
    if (finished) saves.push(archive(finished, false));
    return Promise.all(saves);
}

/** Start reading. Idempotent */
export function startTrialHistory() {
    if (running) return;
    running = true;
    timers.registerInterval(
        setInterval(() => {
            try {
                if (historyEnabled()) sampleTrialHistory();
            } catch (error) {
                console.error('[TrialHistory] Reading the trial failed:', error);
            }
        }, TRIAL_HISTORY_POLL_MS),
        'trialHistory.poll'
    );
}

/**
 * Stop reading, saving what is in hand first.
 * @returns {Promise<Array>} The saves started
 */
export function stopTrialHistory() {
    const flushed = flushTrialHistory();
    timers.clearAll();
    running = false;
    return flushed;
}

/** Back to the opening state — for tests */
export function _resetTrialHistory() {
    timers.clearAll();
    running = false;
    last = null;
    saved.clear();
}

/** @returns {string|null} Who the reading in hand belongs to — for tests */
export function _heldCharacter() {
    return last?.characterId ?? null;
}

export default {
    start: startTrialHistory,
    stop: stopTrialHistory,
    flush: flushTrialHistory,
    sample: sampleTrialHistory,
};
