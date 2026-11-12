/**
 * A plain-text report of the last pull, for pasting to a developer.
 *
 * When a pull asks for "Reload now", some keys latched — the stores took the write and refuse more until
 * a reload. Making each of those live-safe takes knowing which they were and what the sync knows about
 * them; this names them. It carries key names and counts only: never a stored value, token, gist id or
 * character name. Character ids are part of key names and stay. A guild's name is part of some key names
 * and is replaced with a placeholder at print time (see {@link redactSyncKey}).
 */

import { mergeForKey } from '../../utils/sync-merge-registry.js';
import { OWNED_KEY_PREFIXES, ownsKey } from './sync-ownership.js';
import { formatPullSummaryLine, formatPullStoreLine, longestStallDuring } from './pull-summary.js';

/** The line the report opens with, so a reader knows what it holds */
export const REPORT_PRIVACY_LINE = 'Contains key names and counts only, no saved values.';

/** The merged count is read before the write's transaction, whose refold can add what another tab saved then */
export const ROW_COUNTS_NOTE =
    'Row counts are from the merge, before the write: a save in that moment can add to what is stored.';

/** Keys named per list before the rest are counted */
const MAX_KEYS = 400;

/**
 * A key with its per-character suffix removed (`watchlist_30404` → `watchlist`).
 * `character-key.js` builds `${base}_${characterId}` (or `_default` before login). A few records lead with the
 * id instead (`603281_inventoryTabs_config`), so a leading `<digits>_` is removed too.
 * @param {string} key - Storage key
 * @returns {string} The base
 */
export function stripCharacterSuffix(key) {
    return String(key)
        .replace(/_(?:default|[0-9]+)$/, '')
        .replace(/^[0-9]+_/, '');
}

/**
 * Key families whose key embeds a guild's name, found by reading every storage-key builder under `src/`:
 *
 * - `guildMemberSkills_<guild>`            (guild-member-skills.js `memberSkillsStorageKey`)
 * - `guildTrialAbilities_<guild>`          (guild-trial-abilities.js `sessionStorageKey`)
 * - `guildTrialAbilityPlan_<guild>`        (guild-trial-plan.js `planStorageKey`)
 * - `guildTrialSession_<guild>`            (guild-trial-recorder.js `trialSessionStorageKey`)
 * - `guildTrials_<guild>`                  (guild-trials-store.js `guildTrialsStorageKey`)
 * - `guildTrialsStats_<guild>`             (guild-trials-store.js `trialStatsStorageKey`)
 * - `guildTrialLedger_<guild>__<weekStart>` (guild-trial-ledger.js `ledgerCycleKey`)
 * - `guildXP_<guild>`                      (guild-xp-tracker.js, inline)
 * - `guildLoadouts_<characterId>_<guild>`  (guild-loadouts.js `guildLoadoutsStorageKey`)
 *
 * No key builder embeds a character's name (the others are id-scoped). Before the guild is known the same
 * builders fall back to `default` or `char_<id>`, which name nobody and stay.
 */
const GUILD_KEY_PREFIXES = [
    'guildMemberSkills',
    'guildTrialAbilities',
    'guildTrialAbilityPlan',
    'guildTrialSession',
    'guildTrials',
    'guildTrialsStats',
    'guildTrialLedger',
    'guildXP',
];

/** What replaces a guild's name in a printed key */
export const GUILD_PLACEHOLDER = '<guild>';

/**
 * A key (or a key with its suffix stripped) with any embedded guild name replaced, for printing only.
 * @param {string} key - Storage key
 * @returns {string} The key, safe to paste
 */
export function redactSyncKey(key) {
    const text = String(key);
    const loadouts = /^(guildLoadouts_(?:default|[0-9]+))_(.+)$/.exec(text);
    if (loadouts) return `${loadouts[1]}_${GUILD_PLACEHOLDER}`;
    for (const prefix of GUILD_KEY_PREFIXES) {
        if (!text.startsWith(`${prefix}_`)) continue;
        let scope = text.slice(prefix.length + 1);
        let tail = '';
        if (prefix === 'guildTrialLedger') {
            const cycle = /^(.*?)(__[0-9]+)?$/.exec(scope);
            scope = cycle[1];
            tail = cycle[2] || '';
        }
        // The fallbacks before a guild name is known name nobody
        if (scope === 'default' || /^char_[0-9]+$/.test(scope)) return text;
        return `${prefix}_${GUILD_PLACEHOLDER}${tail}`;
    }
    return text;
}

/**
 * What the sync knows about one key.
 * @param {string} store - Object store
 * @param {string} key - Storage key
 * @returns {{base: string, registered: boolean, label: string|null, liveSafe: boolean, owned: boolean,
 *   ownerPrefix: string|null}} The facts
 */
export function describeSyncKey(store, key) {
    let registration = null;
    try {
        registration = mergeForKey(store, key);
    } catch {
        registration = null;
    }
    let owned = false;
    try {
        owned = ownsKey(store, key);
    } catch {
        owned = false;
    }
    return {
        base: stripCharacterSuffix(key),
        registered: Boolean(registration),
        label: registration?.label || null,
        liveSafe: registration?.liveSafe === true,
        owned,
        ownerPrefix: OWNED_KEY_PREFIXES.find((prefix) => String(key).startsWith(prefix)) || null,
    };
}

/**
 * The records a pull latched, named for the reload log: the sync merge registry's label where the key has one,
 * otherwise the key with its character suffix removed and any guild name replaced.
 * @param {Array<{store: string, key: string}>} [latchedKeys] - From the import result
 * @returns {Array<string>} Unique labels, in first-seen order
 */
export function latchedRecordLabels(latchedKeys = []) {
    const labels = new Set();
    for (const entry of latchedKeys || []) {
        if (!entry?.key) continue;
        const described = describeSyncKey(entry.store, entry.key);
        labels.add(described.label || redactSyncKey(described.base));
    }
    return [...labels];
}

/**
 * One row count, or `n/a` for a value with no rows to count (a string, a number).
 * @param {number|null|undefined} count - From the summary
 * @returns {string} Text
 */
function formatCount(count) {
    return Number.isFinite(count) ? String(count) : 'n/a';
}

/**
 * @param {{local: number|null, pulled: number|null, merged: number|null}|undefined} counts - A combined key's
 *   row counts; undefined when the summary predates them
 * @returns {string} `rows: local 12, pulled 15, merged 15`, or `rows: unknown`
 */
function formatRows(counts) {
    if (!counts || typeof counts !== 'object') return 'rows: unknown';
    return `rows: local ${formatCount(counts.local)}, pulled ${formatCount(counts.pulled)}, merged ${formatCount(counts.merged)}`;
}

/**
 * @param {number} ms - Milliseconds
 * @returns {string} Seconds with a decimal, and hours once it is long enough to matter
 */
function formatSeconds(ms) {
    const seconds = ms / 1000;
    return seconds >= 3600 ? `${seconds.toFixed(1)} s (${(seconds / 3600).toFixed(1)} h)` : `${seconds.toFixed(1)} s`;
}

/**
 * The longest stall for the report: the one noted when the pull ended, or the one the heartbeat's ring shows
 * now, whichever is larger. A stall that began during the pull is only recorded when the late beat runs, which
 * can be after the pull is over, so the ring is read again here; the pull's own snapshot is kept because the
 * ring is short and may have rolled over by the time the report is made.
 * @param {Object|null} stored - `summary.timing.stall`
 * @param {Object} fresh - `longestStallDuring` against the ring as it stands now
 * @returns {{status: string, lostMs: number|null, visibility: string|null}} The answer to print
 */
function combineStall(stored, fresh) {
    const candidates = [stored, fresh].filter(Boolean);
    const found = candidates.filter((c) => c.status === 'found').sort((a, b) => b.lostMs - a.lostMs)[0];
    if (found) return found;
    for (const status of ['none', 'rolled-off']) {
        const hit = candidates.find((c) => c.status === status);
        if (hit) return hit;
    }
    return { status: 'unmeasured', lostMs: null, visibility: null };
}

/**
 * The lines about when the pull ran and what the page was doing.
 * @param {Object} summary - From `buildPullSummary`
 * @param {Object|null|undefined} lostTime - `storage.diagnostics().lostTime`, when the caller could read it
 * @returns {string[]} Report lines
 */
function timingLines(summary, lostTime) {
    const timing = summary.timing && typeof summary.timing === 'object' ? summary.timing : null;
    if (!timing) return ['Pull timing: unknown', 'Longest stall overlapping the pull: unknown'];
    const since = Number.isFinite(timing.sinceLoadMs)
        ? `${formatSeconds(timing.sinceLoadMs)} after page load`
        : 'unknown';
    const took = Number.isFinite(timing.durationMs) ? formatSeconds(timing.durationMs) : 'unknown';
    const lines = [`Pull timing: started ${since}, tab ${timing.visibility || 'unknown'} at the start, took ${took}`];

    let fresh = { status: 'unmeasured', lostMs: null, visibility: null };
    try {
        fresh = longestStallDuring(lostTime, timing.startPerf, timing.endPerf);
    } catch {
        // A diagnostics object of an unexpected shape costs this line, never the report
    }
    const stall = combineStall(timing.stall, fresh);
    let text = 'not measured';
    if (stall.status === 'found') text = `${stall.lostMs} ms (tab ${stall.visibility || 'unknown'})`;
    else if (stall.status === 'none') text = 'none';
    else if (stall.status === 'rolled-off') text = 'none retained (older stalls have rolled off the heartbeat history)';
    lines.push(`Longest stall overlapping the pull: ${text}`);
    return lines;
}

/**
 * The trade ledger repair line.
 * @param {{charId?: string, runs?: number, cut?: number, recording?: boolean}|null|undefined} repair - From the ledger store's
 *   `repairStats()` for the character on screen; undefined when the caller could not ask
 * @returns {string} Report line
 */
function repairLine(repair) {
    if (!repair || typeof repair !== 'object') return 'Ledger repair this session: unknown';
    // A character id only ever looks like this; anything else is left out rather than printed
    const who = /^[A-Za-z0-9_-]{1,32}$/.test(String(repair.charId ?? '')) ? ` (character ${repair.charId})` : '';
    if (!Number.isFinite(repair.runs) || !Number.isFinite(repair.cut))
        return `Ledger repair this session${who}: unknown`;
    if (repair.runs <= 0) {
        return `Ledger repair this session${who}: not run yet${repair.recording === false ? ' (the trade ledger is off)' : ''}`;
    }
    const runs = `${repair.runs} ${repair.runs === 1 ? 'run' : 'runs'}`;
    return `Ledger repair this session${who}: ${repair.cut} ${repair.cut === 1 ? 'listing' : 'listings'} cut (${runs})`;
}

/**
 * @param {string} store - Store name
 * @param {string} key - Storage key
 * @param {string} status - `LATCHED`, `MERGE FAILED`, `combined`, or `written whole`, joined as needed
 * @param {string|null} [rows] - A combined key's `rows: ...` text; null for a key that was not combined
 * @returns {string} One report line
 */
function keyLine(store, key, status, rows = null) {
    const info = describeSyncKey(store, key);
    const registration = info.registered
        ? `registered="${info.label}"${info.liveSafe ? ' live-safe' : ' NOT live-safe'}`
        : 'unregistered';
    const owner = info.owned
        ? info.ownerPrefix
            ? `prefix ${info.ownerPrefix}`
            : 'owned (store or pattern)'
        : 'not owned';
    // No `writer=` field: neither the gist's manifest nor its payload records which build or device wrote it
    // (the manifest carries only `exportedAt`, `syncSeq`, `server` and the size/hash/encoding fields), so the
    // field could only ever say it did not know
    return [
        `${store} / ${redactSyncKey(key)}`,
        status,
        `base=${redactSyncKey(info.base)}`,
        registration,
        `owner=${owner}`,
        ...(rows ? [rows] : []),
    ].join(' | ');
}

/**
 * Build the report text.
 * @param {Object|null} summary - From `buildPullSummary`
 * @param {Object} [env] - Where the report was made
 * @param {string|null} [env.version] - Script version, with the build stamp when there is one
 * @param {string|null} [env.host] - `location.hostname`
 * @param {Object|null} [env.lostTime] - `storage.diagnostics().lostTime`, to find stalls recorded since the pull
 * @param {{charId?: string, runs?: number, cut?: number, recording?: boolean}|null} [env.ledgerRepair] - The trade ledger store's
 *   `repairStats()` for the character on screen; left out when the caller could not ask
 * @returns {string} The report
 */
export function buildPullReport(summary, { version = null, host = null, lostTime = null, ledgerRepair } = {}) {
    const lines = [REPORT_PRIVACY_LINE, ''];
    if (!summary) {
        lines.push('No pull has run in this session.');
        return lines.join('\n');
    }
    const lower = String(host || '').toLowerCase();
    const server = lower.startsWith('test.') ? 'test' : lower ? 'live' : 'unknown';
    lines.push(`Toolasha: ${version || 'unknown'}`);
    lines.push(`Host: ${host || 'unknown'} (${server})`);
    lines.push(`Pull time: ${summary.at || 'unknown'}`);
    lines.push(...timingLines(summary, lostTime));
    lines.push(repairLine(ledgerRepair));
    lines.push(`Summary: ${formatPullSummaryLine(summary)}`);
    const latchedCount = Number.isFinite(summary.latched) ? summary.latched : null;
    const advice = latchedCount === null ? 'unknown' : latchedCount > 0 ? 'yes' : 'no';
    lines.push(`Reload advice shown: ${advice} (latched keys: ${latchedCount === null ? 'unknown' : latchedCount})`);

    // A summary from an older caller may lack a list; an absent one reads as empty rather than throwing
    const summaryStores = Array.isArray(summary.stores) ? summary.stores : [];
    const failed = summaryStores.flatMap((store) =>
        (store.overwrittenRecords || []).map((record) => `${store.store}/${record.label}`)
    );
    const held = summaryStores.flatMap((store) =>
        (store.heldRecords || []).map((record) => `${store.store}/${record.label}`)
    );
    if (failed.length) lines.push(`Merge failed: ${failed.join(', ')}`);
    if (held.length) lines.push(`Held: ${held.join(', ')}`);

    lines.push('', 'Stores:');
    for (const store of summaryStores) lines.push(`  ${formatPullStoreLine(store)}`);

    // Every key the pull did something to: [store, key, status, rank, rows]. A key is listed once, under the
    // strongest reason it has
    const keyed = [];
    // Whether the summary says which keys latched: its count is known, and either nothing latched or the keys were
    // named. A result from a caller that did neither cannot say a combined key stayed unlatched
    const latchKnown =
        latchedCount === 0 || (latchedCount !== null && summaryStores.some((s) => (s.latchedRecords || []).length > 0));
    for (const store of summaryStores) {
        const latched = new Set((store.latchedRecords || []).map((record) => record.key));
        const failed = new Set((store.overwrittenRecords || []).map((record) => record.key));
        const combined = new Map();
        for (const record of store.combinedRecords || []) {
            if (!combined.has(record.key)) combined.set(record.key, record);
        }
        const named = new Set([...latched, ...failed, ...combined.keys()]);
        for (const key of named) {
            const record = combined.get(key);
            const status = [
                latched.has(key) ? 'LATCHED' : null,
                failed.has(key) ? 'MERGE FAILED' : null,
                record ? 'combined' : null,
                // A folded key that did not latch took the write without asking for a reload: the importer
                // skips the latch for a registration whose readers fold storage under memory
                record && !latched.has(key)
                    ? !latchKnown
                        ? 'latch unknown'
                        : describeSyncKey(store.store, key).liveSafe
                          ? 'live-safe'
                          : 'not latched'
                    : null,
            ];
            const rank = latched.has(key) ? 0 : failed.has(key) ? 1 : 2;
            keyed.push([
                store.store,
                key,
                status.filter(Boolean).join(', '),
                rank,
                record ? formatRows(record.counts) : null,
            ]);
        }
        for (const record of store.wholeRecords || []) {
            if (!named.has(record.key)) keyed.push([store.store, record.key, 'written whole', 3, null]);
        }
    }
    // Latched keys first: they are what forced the reload; failed folds next, then the other folds
    keyed.sort((a, b) => a[3] - b[3]);
    lines.push('', `Keys (latched, merge failed, combined or written whole): ${keyed.length}`);
    if (keyed.some((entry) => entry[4])) lines.push(ROW_COUNTS_NOTE);
    for (const [store, key, status, , rows] of keyed.slice(0, MAX_KEYS)) {
        lines.push(`  ${keyLine(store, key, status, rows)}`);
    }
    if (keyed.length > MAX_KEYS) lines.push(`  ...and ${keyed.length - MAX_KEYS} more`);
    return lines.join('\n');
}

export default {
    REPORT_PRIVACY_LINE,
    stripCharacterSuffix,
    describeSyncKey,
    redactSyncKey,
    latchedRecordLabels,
    buildPullReport,
};
