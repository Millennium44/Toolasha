/**
 * Reload log — a device-only record of every time Toolasha asked the player to reload the page.
 *
 * A sync pull or a restore latches the stores it replaced (see `storage.finishRestore`), and the player is
 * then told to reload. Which records force that, and how often, decides which ones are worth making
 * live-safe; this keeps the evidence so it can be pasted to a developer instead of remembered.
 *
 * - One entry per prompt: when, which feature asked, the text, the records that forced it (the sync merge
 *   registry's labels where known), the character, and how it ended.
 * - Last {@link LOG_CAP} entries, stored under a `toolasha_local_` key, which the sync, exports and backups
 *   leave on the device (see `sync-ownership.js` / `LOCAL_ONLY_KEY_PREFIXES`).
 * - Written through `storage.update`, a read-merge-write, so two tabs appending at once keep both entries.
 *   Every change is an upsert of an entry this page tracks, so a write that runs late or in the
 *   `storage.onBeforeTeardown` hook still carries the entry whole.
 * - The page closing is an outcome too: a prompt with no answer when the page goes away is `page-closed`,
 *   which for a prompt that has no button is how a reload by hand shows up.
 *
 * Prompts also reach `onPrompt` listeners whether or not the log is on: the automatic reload is a separate
 * switch, and a player can want either without the other. Turning the log off stops recording and nothing else.
 *
 * Kept free of `config` on purpose: `data-manager` records here, and `config` imports `data-manager`.
 * The setting is supplied through {@link setEnabledProvider}.
 */

import storage from './storage.js';

/** The settings-store key holding the entries. `toolasha_local_` keeps it on this device */
export const LOG_KEY = 'toolasha_local_reloadPromptLog';

const STORE = 'settings';

/** Entries kept */
export const LOG_CAP = 200;

/** Setting id of the on/off switch */
export const ENABLED_SETTING = 'reloadLog_enabled';

/** Records named per entry before the rest are counted */
const MAX_RECORDS = 40;

const MAX_MESSAGE_LENGTH = 400;

/**
 * Prompt kinds. `data-changed`: a pull, restore or newer build changed stored data underneath this page.
 * `newer-build`: another tab runs a newer Toolasha. `recovery`: Toolasha is asking for a reload to repair itself.
 */
export const KINDS = ['data-changed', 'newer-build', 'recovery'];

/** How an entry ended, weakest first. A later outcome replaces an earlier one only when it ranks at least as high */
const OUTCOME_RANK = {
    unknown: 0,
    'page-closed': 1,
    dismissed: 2,
    cancelled: 2,
    reloaded: 3,
    'auto-reloaded': 3,
};

export const OUTCOMES = Object.keys(OUTCOME_RANK);

/** @type {() => boolean} */
let enabledProvider = () => true;

/** Prompts this page raised, by id, newest last. Capped like the log */
const tracked = new Map();

/** @type {Set<Function>} */
const listeners = new Set();

let teardownRegistered = false;
let flushRunning = false;
let flushAgain = false;
let sequence = 0;

/**
 * Supply the on/off switch. The default is on (the setting's default), so a prompt before the setting is
 * readable is still recorded.
 * @param {(() => boolean)|null} provider - Returns whether recording is on
 */
export function setEnabledProvider(provider) {
    enabledProvider = typeof provider === 'function' ? provider : () => true;
}

/** @returns {boolean} Whether prompts are being recorded */
export function isEnabled() {
    try {
        return enabledProvider() !== false;
    } catch {
        return true;
    }
}

/**
 * @param {string} outcome - Outcome name
 * @returns {number} Its rank; unknown names rank as unknown
 */
function rank(outcome) {
    return OUTCOME_RANK[outcome] ?? 0;
}

/**
 * Fold this page's tracked entries into the stored list: add the ones missing, and move an entry's outcome up
 * when this page knows a stronger one. Never lowers an outcome, so another tab's or an earlier write's answer
 * stands.
 * @param {*} current - What is stored
 * @param {Array<Object>} pending - Entries to carry
 * @returns {Array<Object>} The new list, capped
 */
function upsert(current, pending) {
    const list = Array.isArray(current) ? current.filter((entry) => entry && typeof entry === 'object') : [];
    for (const entry of pending) {
        const found = list.find((candidate) => candidate.id === entry.id);
        if (!found) {
            list.push({ ...entry });
            continue;
        }
        if (rank(entry.outcome) > rank(found.outcome) || (entry.outcome === found.outcome && entry.shownMs !== null)) {
            found.outcome = entry.outcome;
            found.shownMs = entry.shownMs;
        }
    }
    return list.slice(-LOG_CAP);
}

/**
 * Entries this page has not yet written at their current state.
 * @returns {Array<Object>} Copies
 */
function dirtyEntries() {
    return [...tracked.values()].filter((meta) => meta.dirty).map((meta) => ({ ...meta.entry }));
}

/**
 * Write the dirty entries. One write at a time; a change made during a write asks for another.
 * @returns {Promise<void>}
 */
async function flush() {
    if (flushRunning) {
        flushAgain = true;
        return;
    }
    flushRunning = true;
    try {
        do {
            flushAgain = false;
            const pending = dirtyEntries();
            if (pending.length === 0) break;
            const sent = pending.map((entry) => `${entry.id}|${entry.outcome}`);
            let result = null;
            try {
                result = await storage.update?.(LOG_KEY, (current) => upsert(current, pending), STORE);
            } catch (error) {
                console.error('[ReloadLog] Could not write the log:', error);
            }
            // Only what was written stays clean; a failed write leaves it dirty for the next change or teardown
            if (result && result.written !== false) {
                for (const meta of tracked.values()) {
                    if (sent.includes(`${meta.entry.id}|${meta.entry.outcome}`)) meta.dirty = false;
                }
            }
        } while (flushAgain);
    } finally {
        flushRunning = false;
    }
}

/**
 * The page is going away: whatever is unanswered is `page-closed`, and everything dirty is written in one
 * transaction. `storage.update` opens it before its first await, which is why it can run here.
 */
function onTeardown() {
    const now = Date.now();
    for (const meta of tracked.values()) {
        if (meta.entry.outcome === 'unknown') {
            meta.entry.outcome = 'page-closed';
            meta.entry.shownMs = Math.max(0, now - meta.entry.at);
            meta.dirty = true;
        }
    }
    const pending = dirtyEntries();
    if (pending.length === 0) return;
    try {
        const writing = storage.update?.(LOG_KEY, (current) => upsert(current, pending), STORE);
        if (writing && typeof writing.catch === 'function') writing.catch(() => {});
    } catch (error) {
        console.error('[ReloadLog] Could not write the log on close:', error);
    }
}

/** Hook the page-close write once */
function ensureTeardownHook() {
    if (teardownRegistered) return;
    teardownRegistered = true;
    try {
        storage.onBeforeTeardown?.(onTeardown);
    } catch (error) {
        console.error('[ReloadLog] Could not register the close hook:', error);
    }
}

/**
 * Trim and dedupe a list of record labels.
 * @param {Array<string>} records - Labels
 * @returns {Array<string>} At most {@link MAX_RECORDS} unique labels; a final entry counts the rest
 */
function cleanRecords(records) {
    const unique = [...new Set((Array.isArray(records) ? records : []).map((label) => String(label)).filter(Boolean))];
    if (unique.length <= MAX_RECORDS) return unique;
    return [...unique.slice(0, MAX_RECORDS), `…and ${unique.length - MAX_RECORDS} more`];
}

/**
 * @typedef {Object} ReloadPromptHandle
 * @property {string} id - Entry id
 * @property {string} kind - One of {@link KINDS}
 * @property {string} source - Which feature asked
 * @property {string} message - What the player was told
 * @property {Array<string>} records - Labels of what forced it
 * @property {string|number|null} characterId - Character the prompt was raised for
 * @property {number} shownAt - Epoch ms
 * @property {(outcome: string) => void} settle - Record how it ended (a stronger outcome replaces a weaker one)
 * @property {() => string} outcome - The outcome so far
 */

/**
 * Record that the player was asked to reload.
 *
 * Always returns a handle and always tells `onPrompt` listeners; whether it is written down is the setting's.
 * Never throws.
 *
 * @param {Object} prompt - The prompt
 * @param {string} prompt.source - 'sync-pull', 'restore', 'tab-version', 'recovery', …
 * @param {string} prompt.message - What the player was told
 * @param {Array<string>} [prompt.records] - Labels of the records, stores or keys that forced it
 * @param {string|number|null} [prompt.characterId] - The character
 * @param {'data-changed'|'newer-build'|'recovery'} [prompt.kind='data-changed'] - Why the reload is wanted
 * @returns {ReloadPromptHandle} The handle
 */
export function recordReloadPrompt({ source, message, records = [], characterId = null, kind = 'data-changed' } = {}) {
    const at = Date.now();
    sequence += 1;
    const entry = {
        id: `${at.toString(36)}-${sequence.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        at,
        source: String(source || 'unknown'),
        kind: KINDS.includes(kind) ? kind : 'data-changed',
        message: String(message || '').slice(0, MAX_MESSAGE_LENGTH),
        records: cleanRecords(records),
        characterId: characterId ?? null,
        outcome: 'unknown',
        shownMs: null,
    };
    const meta = { entry, dirty: false, recorded: false };

    const handle = {
        id: entry.id,
        kind: entry.kind,
        source: entry.source,
        message: entry.message,
        records: entry.records,
        characterId: entry.characterId,
        shownAt: at,
        outcome: () => entry.outcome,
        settle: (outcome) => {
            try {
                if (!(outcome in OUTCOME_RANK) || rank(outcome) < rank(entry.outcome)) return;
                if (outcome === 'unknown') return;
                entry.outcome = outcome;
                entry.shownMs = Math.max(0, Date.now() - at);
                if (!meta.recorded) return;
                meta.dirty = true;
                flush();
            } catch (error) {
                console.error('[ReloadLog] Could not settle a prompt:', error);
            }
        },
    };

    try {
        if (isEnabled()) {
            meta.recorded = true;
            meta.dirty = true;
            tracked.set(entry.id, meta);
            while (tracked.size > LOG_CAP) tracked.delete(tracked.keys().next().value);
            ensureTeardownHook();
            flush();
        }
    } catch (error) {
        console.error('[ReloadLog] Could not record a prompt:', error);
    }

    for (const listener of [...listeners]) {
        try {
            listener(handle);
        } catch (error) {
            console.error('[ReloadLog] A listener failed:', error);
        }
    }
    return handle;
}

/**
 * Hear about every prompt, as it is raised, whether or not the log is on.
 * @param {(handle: ReloadPromptHandle) => void} listener - Called synchronously
 * @returns {Function} Unsubscribe
 */
export function onPrompt(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/**
 * The stored entries, oldest first.
 * @returns {Promise<Array<Object>>} Empty when nothing is stored or it cannot be read
 */
export async function readEntries() {
    try {
        // Our own unwritten changes first, so a read right after a prompt sees it
        await flush();
        const stored = await storage.get(LOG_KEY, STORE, []);
        return Array.isArray(stored) ? stored.filter((entry) => entry && typeof entry === 'object') : [];
    } catch (error) {
        console.error('[ReloadLog] Could not read the log:', error);
        return [];
    }
}

/**
 * Empty the log. Prompts still on screen are forgotten too, so a later outcome cannot write them back.
 * @returns {Promise<boolean>} Whether the log was emptied
 */
export async function clearLog() {
    tracked.clear();
    try {
        const result = await storage.update?.(LOG_KEY, () => [], STORE);
        return Boolean(result) && result.written !== false;
    } catch (error) {
        console.error('[ReloadLog] Could not clear the log:', error);
        return false;
    }
}

/**
 * @param {Array<string>} items - Items to count
 * @returns {Array<[string, number]>} [item, count], most first, ties alphabetical
 */
function countBy(items) {
    const counts = new Map();
    for (const item of items) counts.set(item, (counts.get(item) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * @param {number} ms - Epoch ms
 * @returns {string} ISO time without milliseconds
 */
function isoTime(ms) {
    try {
        return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
    } catch {
        return String(ms);
    }
}

/**
 * A compact plain-text summary, then the entries, for pasting into a chat.
 * Names records and counts only; the message text is Toolasha's own wording.
 * @param {Array<Object>} entries - From {@link readEntries}
 * @returns {string} Text
 */
export function formatReloadLog(entries) {
    const list = Array.isArray(entries) ? entries : [];
    if (list.length === 0) return 'Toolasha reload log: no reload prompts recorded.';

    const lines = [`Toolasha reload log: ${list.length} prompt${list.length === 1 ? '' : 's'}`];
    lines.push('Contains record labels, counts and times only, no saved values.');

    lines.push('', 'By source:');
    for (const [source, count] of countBy(list.map((entry) => entry.source || 'unknown'))) {
        lines.push(`  ${source}: ${count}`);
    }

    lines.push('', 'By outcome:');
    for (const [outcome, count] of countBy(list.map((entry) => entry.outcome || 'unknown'))) {
        lines.push(`  ${outcome}: ${count}`);
    }

    const labelCounts = countBy(list.flatMap((entry) => (Array.isArray(entry.records) ? entry.records : [])));
    lines.push('', 'By record (prompts it was part of):');
    if (labelCounts.length === 0) lines.push('  (none named)');
    for (const [label, count] of labelCounts) lines.push(`  ${label}: ${count}`);

    lines.push('', 'Entries (oldest first):');
    for (const entry of list) {
        const shown = Number.isFinite(entry.shownMs) ? ` after ${Math.round(entry.shownMs / 1000)}s` : '';
        const records = Array.isArray(entry.records) && entry.records.length ? entry.records.join(', ') : 'none named';
        lines.push(
            `- ${isoTime(entry.at)} [${entry.source}${entry.kind ? `/${entry.kind}` : ''}] ` +
                `${entry.outcome || 'unknown'}${shown}; character ${entry.characterId ?? 'unknown'}`
        );
        lines.push(`    records: ${records}`);
        lines.push(`    said: ${entry.message}`);
    }
    return lines.join('\n');
}

/**
 * Forget everything held in memory. For tests and a character switch's clean slate; stored entries stay.
 */
export function resetReloadLog() {
    tracked.clear();
    listeners.clear();
    enabledProvider = () => true;
    teardownRegistered = false;
    flushRunning = false;
    flushAgain = false;
}
