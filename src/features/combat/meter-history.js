/**
 * Finished meter sessions, kept after the live board has moved on.
 *
 * The Per-player panel and the trial damage board both measure one session at
 * a time and forget it the moment the next begins: a zone change, a Reset, a
 * character switch or a new trial wipes the table somebody was about to read.
 * This keeps the finished ones — per character, a type each for ordinary
 * combat and guild trials — so either board can redraw one read-only.
 *
 * ## What is kept
 *
 * The last {@link MAX_RECENT} per type, plus up to {@link MAX_FAVOURITES}
 * starred ones that eviction never touches (KikiMeter's `HistoryStore`, by
 * ZhuLiMoon, MIT, has the same rule). A thirty-first star is refused rather than
 * silently pushing an older favourite out.
 *
 * ## How it is stored
 *
 * One index record per character and type — the summaries a list draws — and
 * one record per session body, so starring or renaming rewrites a few hundred
 * bytes rather than every saved session. Bodies are self-contained snapshots
 * whose shape belongs to the module that built them (`combat-history.js`,
 * `guild/trial-history.js`); this module only files them.
 *
 * ## Whose history it is
 *
 * Every read and write names the character explicitly, captured by the caller
 * at the moment the data was the character's — never re-read after an await,
 * because a character switch can land in between. The index cache is keyed by
 * that character too, so a load that finishes after a switch fills the old
 * character's cache and cannot be drawn under the new one.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import { BOARD_COLORS, boardNoteHTML, escapeText } from '../../utils/damage-board.js';
import { formatDateTime, formatKMB } from '../../utils/formatters.js';

/** The setting that turns saving and the History views on */
export const HISTORY_SETTING = 'combatMeterHistory';

/** Object store; combat exports already live here and it carries no key budget */
export const HISTORY_STORE = 'combatExport';

/** Unstarred sessions kept per character and type */
export const MAX_RECENT = 10;

/** Starred sessions kept per character and type */
export const MAX_FAVOURITES = 30;

/**
 * Largest serialized session body, in characters.
 *
 * A trial with sixty players and every ability row is the large case; this is
 * several times that, and exists so one malformed snapshot cannot write megabytes.
 */
export const MAX_ENTRY_CHARS = 400_000;

/** Longest user-given name */
export const MAX_NAME_LENGTH = 60;

/** The two kinds of history */
export const HISTORY_TYPES = ['combat', 'trial'];

/** @returns {boolean} Whether sessions are saved and the History views offered */
export function historyEnabled() {
    return config.getSetting(HISTORY_SETTING, true) === true;
}

/** @returns {string} The character logged in now, or `default` before login */
export function currentCharacterId() {
    return String(dataManager.getCurrentCharacterId?.() ?? 'default');
}

/**
 * @param {string} characterId - Whose
 * @param {string} type - `combat` or `trial`
 * @returns {string} The index record's key
 */
export function historyIndexKey(characterId, type) {
    return `meterHistoryIndex_${characterId}_${type}`;
}

/**
 * @param {string} characterId - Whose
 * @param {string} type - `combat` or `trial`
 * @param {string} id - The session's id
 * @returns {string} The body record's key
 */
export function historyEntryKey(characterId, type, id) {
    return `meterHistory_${characterId}_${type}_${id}`;
}

/**
 * Which summaries survive, newest first.
 *
 * Pure. Starred and unstarred sessions are counted separately, so ten new
 * sessions can never push out a favourite.
 *
 * @param {Array<Object>} index - Summaries, any order
 * @returns {{kept: Array<Object>, dropped: Array<Object>}}
 */
export function trimIndex(index) {
    const sorted = [...(index || [])].sort((a, b) => (Number(b?.endedAt) || 0) - (Number(a?.endedAt) || 0));
    const kept = [];
    const dropped = [];
    let recent = 0;
    let starred = 0;
    for (const summary of sorted) {
        if (summary?.favourite) {
            if (starred < MAX_FAVOURITES) {
                starred += 1;
                kept.push(summary);
            } else dropped.push(summary);
        } else if (recent < MAX_RECENT) {
            recent += 1;
            kept.push(summary);
        } else dropped.push(summary);
    }
    return { kept, dropped };
}

/**
 * Evenly thin an array to at most `limit` items, keeping the last.
 * @param {Array} items - Anything
 * @param {number} limit - Most kept
 * @returns {Array}
 */
function thinArray(items, limit) {
    if (!Array.isArray(items) || items.length <= limit) return items;
    const step = Math.ceil(items.length / limit);
    const out = items.filter((_, index) => index % step === 0);
    if (out[out.length - 1] !== items[items.length - 1]) out.push(items[items.length - 1]);
    return out;
}

/**
 * What goes first when a body is too large, least useful first. Each step
 * mutates the clone it is handed.
 */
const TRIM_STEPS = [
    [
        'per-enemy ability rows',
        (entry) => {
            for (const player of entry.dealt?.players || []) {
                for (const enemy of player.enemies || []) delete enemy.abilities;
            }
            for (const enemy of entry.dealt?.enemies || []) delete enemy.abilities;
        },
    ],
    [
        'graph detail',
        (entry) => {
            const graph = entry.graph;
            if (!graph) return;
            if (Array.isArray(graph.points)) graph.points = thinArray(graph.points, 60);
            if (Array.isArray(graph.xs) && graph.xs.length > 60) {
                const step = Math.ceil(graph.xs.length / 60);
                const pick = (values) => (values || []).filter((_, index) => index % step === 0);
                graph.xs = pick(graph.xs);
                graph.party = pick(graph.party);
                for (const name of Object.keys(graph.players || {})) graph.players[name] = pick(graph.players[name]);
            }
        },
    ],
    [
        'rotation history',
        (entry) => {
            if (entry.audit) delete entry.audit.history;
        },
    ],
    [
        'wave table',
        (entry) => {
            if (entry.taken) delete entry.taken.waves;
        },
    ],
    [
        'minor ability rows',
        (entry) => {
            const rows = [...(entry.dealt?.players || []), ...(entry.breakdown?.players || [])];
            for (const row of rows) if (Array.isArray(row.abilities)) row.abilities = row.abilities.slice(0, 6);
        },
    ],
    [
        'per-enemy split',
        (entry) => {
            for (const player of entry.dealt?.players || []) delete player.enemies;
        },
    ],
];

/**
 * A body cloned, and cut down to {@link MAX_ENTRY_CHARS} when it is larger.
 *
 * @param {Object} entry - A session body
 * @param {number} [max] - Size limit, in serialized characters
 * @returns {Object|null} The clone, with `trimmed` naming what was cut, or null when it cannot be made to fit
 */
export function fitEntry(entry, max = MAX_ENTRY_CHARS) {
    if (!entry || typeof entry !== 'object') return null;
    let text;
    try {
        text = JSON.stringify(entry);
    } catch (error) {
        console.error('[MeterHistory] A session could not be serialized:', error);
        return null;
    }
    const copy = JSON.parse(text);
    if (text.length <= max) return copy;

    const trimmed = [];
    for (const [name, step] of TRIM_STEPS) {
        step(copy);
        trimmed.push(name);
        if (JSON.stringify(copy).length <= max) return { ...copy, trimmed };
    }
    return null;
}

/**
 * The summary a list draws, off a body.
 * @param {Object} entry - A session body
 * @returns {Object}
 */
function summaryOf(entry) {
    return {
        id: entry.id,
        type: entry.type,
        startedAt: Number(entry.startedAt) || null,
        endedAt: Number(entry.endedAt) || Date.now(),
        seconds: Number(entry.seconds) || 0,
        basis: entry.basis || 'stream',
        finished: entry.finished !== false,
        label: String(entry.summary?.label || (entry.type === 'trial' ? 'Guild trial' : 'Combat')),
        detail: entry.summary?.detail ? String(entry.summary.detail) : null,
        total: Number(entry.summary?.total) || 0,
        perSecond: Number.isFinite(entry.summary?.perSecond) ? entry.summary.perSecond : null,
        players: Number(entry.summary?.players) || 0,
        favourite: false,
        name: null,
    };
}

/** `characterId:type` → summaries, newest first */
const indexCache = new Map();
/** Cache keys with a read in flight */
const loading = new Set();
/** Index key → the write chain it is on */
const queues = new Map();
/** The last few bodies read, by entry key */
const bodyCache = new Map();
const BODY_CACHE_SIZE = 4;

/**
 * Run a task after every earlier task on the same key, so a save and a rename
 * landing together cannot each write an index missing the other's change.
 * @param {string} key - What the tasks share
 * @param {Function} task - Async work
 * @returns {Promise<*>} The task's result
 */
async function runQueued(key, task) {
    const previous = queues.get(key);
    let release;
    const gate = new Promise((resolve) => {
        release = resolve;
    });
    queues.set(key, gate);
    try {
        if (previous) await previous;
        return await task();
    } finally {
        release();
        if (queues.get(key) === gate) queues.delete(key);
    }
}

/**
 * The stored index, through the cache.
 * @param {string} characterId - Whose
 * @param {string} type - Which
 * @returns {Promise<Array<Object>>}
 */
async function readIndex(characterId, type) {
    const cacheKey = `${characterId}:${type}`;
    if (indexCache.has(cacheKey)) return indexCache.get(cacheKey);
    const stored = await storage.get(historyIndexKey(characterId, type), HISTORY_STORE, []);
    const index = Array.isArray(stored) ? stored.filter((summary) => summary?.id) : [];
    // A write queued behind this read may already have filled the cache
    if (!indexCache.has(cacheKey)) indexCache.set(cacheKey, index);
    return indexCache.get(cacheKey);
}

/**
 * Write an index and the cache together.
 * @param {string} characterId - Whose
 * @param {string} type - Which
 * @param {Array<Object>} index - Summaries
 */
async function writeIndex(characterId, type, index) {
    indexCache.set(`${characterId}:${type}`, index);
    await storage.set(historyIndexKey(characterId, type), index, HISTORY_STORE, true);
}

/**
 * A character's saved sessions of one type.
 * @param {string} type - `combat` or `trial`
 * @param {string} [characterId] - Whose; the character logged in now by default
 * @returns {Promise<Array<Object>>} Summaries, newest first
 */
export async function loadHistoryIndex(type, characterId = currentCharacterId()) {
    try {
        return trimIndex(await readIndex(String(characterId), type)).kept;
    } catch (error) {
        console.error('[MeterHistory] Reading saved sessions failed:', error);
        return [];
    }
}

/**
 * The saved sessions already in memory, without reading storage.
 * @param {string} type - `combat` or `trial`
 * @param {string} [characterId] - Whose
 * @returns {Array<Object>|null} Summaries newest first, or null when not read yet
 */
export function cachedHistoryIndex(type, characterId = currentCharacterId()) {
    const index = indexCache.get(`${characterId}:${type}`);
    return index ? trimIndex(index).kept : null;
}

/**
 * Read the list for the character logged in now, then redraw — unless the
 * character changed while it was being read.
 * @param {string} type - `combat` or `trial`
 * @param {Function} redraw - Called once the list is in memory
 */
export async function ensureHistoryLoaded(type, redraw) {
    const characterId = currentCharacterId();
    const cacheKey = `${characterId}:${type}`;
    if (indexCache.has(cacheKey) || loading.has(cacheKey)) return;
    loading.add(cacheKey);
    try {
        await loadHistoryIndex(type, characterId);
    } finally {
        loading.delete(cacheKey);
    }
    if (currentCharacterId() === characterId) redraw?.();
}

/**
 * File a finished session.
 *
 * A body with the id of one already saved replaces it and keeps its star and
 * name: the same session saved again is a fuller reading of it (the panel was
 * switched off and on, or a trial went quiet and resumed). A stream reading
 * never replaces one restated in the game's own totals.
 *
 * @param {Object} entry - A session body with `id`, `type`, `endedAt` and `summary`
 * @param {string} characterId - Whose session it was, captured when its data was read
 * @returns {Promise<Object|null>} The summary filed, or null when nothing was written
 */
export async function saveHistoryEntry(entry, characterId) {
    const type = entry?.type;
    if (!HISTORY_TYPES.includes(type) || !entry?.id) return null;
    const owner = String(characterId ?? 'default');

    const fitted = fitEntry(entry);
    if (!fitted) {
        console.warn('[MeterHistory] A finished session is too large to save:', entry.id);
        return null;
    }

    try {
        return await runQueued(historyIndexKey(owner, type), async () => {
            const index = await readIndex(owner, type);
            const existing = index.find((summary) => summary.id === fitted.id);
            if (existing?.basis === 'game' && fitted.basis !== 'game') return null;

            const summary = {
                ...summaryOf(fitted),
                favourite: Boolean(existing?.favourite),
                name: existing?.name ?? null,
            };
            const { kept, dropped } = trimIndex([summary, ...index.filter((held) => held.id !== summary.id)]);
            if (!kept.includes(summary)) return null;

            const wrote = await storage.set(historyEntryKey(owner, type, summary.id), fitted, HISTORY_STORE, true);
            if (wrote === false) return null;
            bodyCache.delete(historyEntryKey(owner, type, summary.id));
            await writeIndex(owner, type, kept);

            for (const gone of dropped) {
                const key = historyEntryKey(owner, type, gone.id);
                bodyCache.delete(key);
                await storage.delete(key, HISTORY_STORE);
            }
            return summary;
        });
    } catch (error) {
        console.error('[MeterHistory] Saving a finished session failed:', error);
        return null;
    }
}

/**
 * One saved session's body.
 * @param {string} type - `combat` or `trial`
 * @param {string} id - The session's id
 * @param {string} [characterId] - Whose
 * @returns {Promise<Object|null>}
 */
export async function getHistoryEntry(type, id, characterId = currentCharacterId()) {
    const key = historyEntryKey(String(characterId), type, id);
    if (bodyCache.has(key)) return bodyCache.get(key);
    try {
        const entry = await storage.get(key, HISTORY_STORE, null);
        if (!entry || typeof entry !== 'object') return null;
        bodyCache.set(key, entry);
        while (bodyCache.size > BODY_CACHE_SIZE) bodyCache.delete(bodyCache.keys().next().value);
        return entry;
    } catch (error) {
        console.error('[MeterHistory] Reading a saved session failed:', error);
        return null;
    }
}

/**
 * A saved session's body, for the character logged in now — or null when the
 * character changed while it was being read.
 * @param {string} type - `combat` or `trial`
 * @param {string} id - The session's id
 * @returns {Promise<Object|null>}
 */
export async function openHistoryEntry(type, id) {
    const characterId = currentCharacterId();
    const entry = await getHistoryEntry(type, id, characterId);
    return currentCharacterId() === characterId ? entry : null;
}

/**
 * Change one summary in place.
 * @param {string} type - Which
 * @param {string} id - Whose summary
 * @param {string} characterId - Whose history
 * @param {Function} change - `(summary, index) => {ok, reason}|undefined`, may mutate a copy it is given
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function updateSummary(type, id, characterId, change) {
    const owner = String(characterId);
    try {
        return await runQueued(historyIndexKey(owner, type), async () => {
            const index = await readIndex(owner, type);
            const held = index.find((summary) => summary.id === id);
            if (!held) return { ok: false, reason: 'missing' };
            const copy = { ...held };
            const verdict = change(copy, index);
            if (verdict && verdict.ok === false) return verdict;
            await writeIndex(
                owner,
                type,
                index.map((summary) => (summary.id === id ? copy : summary))
            );
            return { ok: true };
        });
    } catch (error) {
        console.error('[MeterHistory] Updating a saved session failed:', error);
        return { ok: false, reason: 'error' };
    }
}

/**
 * Star or unstar a saved session.
 *
 * Unstarring does not evict on the spot; the next save trims, so a session
 * unstarred by mistake can be starred again before it goes.
 *
 * @param {string} type - `combat` or `trial`
 * @param {string} id - The session's id
 * @param {boolean} on - Star it or not
 * @param {string} [characterId] - Whose
 * @returns {Promise<{ok: boolean, reason?: string}>} `reason: 'full'` when thirty are starred already
 */
export async function setFavourite(type, id, on, characterId = currentCharacterId()) {
    return updateSummary(type, id, characterId, (summary, index) => {
        if (on && !summary.favourite && index.filter((held) => held.favourite).length >= MAX_FAVOURITES) {
            return { ok: false, reason: 'full' };
        }
        summary.favourite = Boolean(on);
        return undefined;
    });
}

/**
 * Name a saved session; an empty name goes back to the automatic label.
 * @param {string} type - `combat` or `trial`
 * @param {string} id - The session's id
 * @param {string} name - The new name
 * @param {string} [characterId] - Whose
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function renameEntry(type, id, name, characterId = currentCharacterId()) {
    const clean = String(name ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_NAME_LENGTH);
    return updateSummary(type, id, characterId, (summary) => {
        summary.name = clean || null;
        return undefined;
    });
}

/**
 * Delete a saved session, starred or not.
 * @param {string} type - `combat` or `trial`
 * @param {string} id - The session's id
 * @param {string} [characterId] - Whose
 * @returns {Promise<boolean>} Whether it was there
 */
export async function deleteEntry(type, id, characterId = currentCharacterId()) {
    const owner = String(characterId);
    try {
        return await runQueued(historyIndexKey(owner, type), async () => {
            const index = await readIndex(owner, type);
            if (!index.some((summary) => summary.id === id)) return false;
            await writeIndex(
                owner,
                type,
                index.filter((summary) => summary.id !== id)
            );
            const key = historyEntryKey(owner, type, id);
            bodyCache.delete(key);
            await storage.delete(key, HISTORY_STORE);
            return true;
        });
    } catch (error) {
        console.error('[MeterHistory] Deleting a saved session failed:', error);
        return false;
    }
}

/**
 * A duration as a person reads it.
 * @param {number} seconds - Length
 * @returns {string} `45s`, `12m 05s`, `1h 02m`
 */
export function formatSessionDuration(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = total % 60;
    if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
    if (minutes) return `${minutes}m ${String(rest).padStart(2, '0')}s`;
    return `${rest}s`;
}

/**
 * When a session ended, in the user's own date and clock format.
 * @param {number} at - Epoch ms
 * @returns {string}
 */
export function formatSessionDate(at) {
    const date = new Date(Number(at) || 0);
    return formatDateTime(date, { includeSeconds: false });
}

/**
 * The name a session is listed under: the user's, or the automatic label.
 * @param {Object} summaryOrEntry - A summary, or a body with `summary`
 * @returns {string}
 */
export function sessionTitle(summaryOrEntry) {
    return String(summaryOrEntry?.name || summaryOrEntry?.label || summaryOrEntry?.summary?.label || 'Saved session');
}

/**
 * The first line of a copied saved session.
 * @param {Object} entry - A session body
 * @param {Object|null} [summary] - Its summary, for the user's name
 * @returns {string}
 */
export function entryHeading(entry, summary = null) {
    const title = summary?.name || entry?.summary?.label || 'Saved session';
    return (
        `Saved ${entry?.type === 'trial' ? 'trial' : 'session'} — ${title} — ` +
        `${formatSessionDate(entry?.endedAt)}, ${formatSessionDuration(entry?.seconds)}` +
        (entry?.basis === 'game' ? ' (game totals)' : '') +
        (entry?.finished === false ? ' (cut short)' : '')
    );
}

/** Per type: which row is being renamed or confirmed for deletion, and a one-off notice */
const uiState = {
    combat: { renaming: null, confirming: null, notice: null },
    trial: { renaming: null, confirming: null, notice: null },
};

/**
 * @param {string} type - `combat` or `trial`
 * @returns {{renaming: string|null, confirming: string|null, notice: string|null}} Live state, mutable
 */
export function historyUiState(type) {
    return uiState[type] || uiState.combat;
}

/**
 * A small text button for a history row.
 * @param {string} attr - Its data attribute
 * @param {string} id - The session id it acts on
 * @param {string} label - What it says
 * @param {string} title - Its tooltip
 * @param {string} [color] - Ink
 * @returns {string} HTML
 */
function rowButton(attr, id, label, title, color = BOARD_COLORS.dim) {
    return (
        `<button ${attr}="${escapeText(id)}" title="${escapeText(title)}" style="cursor:pointer; padding:0 5px;` +
        ` border-radius:3px; font-size:9.5px; line-height:1.5; color:${color}; background:transparent;` +
        ` border:1px solid ${color}55;">${escapeText(label)}</button>`
    );
}

/**
 * The saved-sessions list.
 *
 * @param {Array<Object>|null} index - Summaries newest first, or null while loading
 * @param {Object} options - What to draw
 * @param {string} options.type - `combat` or `trial`
 * @param {string|null} [options.renaming] - The row showing a name field
 * @param {string|null} [options.confirming] - The row asking to confirm deletion
 * @param {string|null} [options.notice] - A one-off line above the rows
 * @returns {string} HTML
 */
export function historyListHTML(index, { type, renaming = null, confirming = null, notice = null } = {}) {
    const { accent, dim, good, warn } = BOARD_COLORS;
    const what = type === 'trial' ? 'trials' : 'sessions';
    const intro =
        `<div data-history-list="${escapeText(type)}" style="color:${accent}; font-size:12px; font-weight:700;` +
        ` margin-bottom:2px;">Saved ${what}</div>` +
        boardNoteHTML(
            type === 'trial'
                ? `The last ${MAX_RECENT} finished trials for this character, plus up to ${MAX_FAVOURITES} starred. ` +
                      'A trial is saved once, when the game’s own totals arrive — or two minutes after it ends ' +
                      'without them. Click one to open it.'
                : `The last ${MAX_RECENT} finished sessions for this character, plus up to ${MAX_FAVOURITES} ` +
                      'starred. A session is saved when it ends — a zone or party change, Reset, a character ' +
                      'switch — if it lasted 30 seconds of fighting. Click one to open it.'
        );

    const noticeHTML = notice ? boardNoteHTML(escapeText(notice), { color: warn }) : '';
    if (index === null) return intro + noticeHTML + boardNoteHTML('Reading saved sessions…');
    if (!index.length) {
        return intro + noticeHTML + boardNoteHTML(`Nothing saved yet — finished ${what} appear here.`);
    }

    const rows = index
        .map((summary) => {
            const id = summary.id;
            const star = summary.favourite
                ? rowButton('data-history-star', id, '★', 'Starred: never evicted. Click to unstar.', warn)
                : rowButton('data-history-star', id, '☆', 'Star: keep this one past the last ten.');
            const title = sessionTitle(summary);
            const name =
                renaming === id
                    ? `<input data-history-label="${escapeText(id)}" maxlength="${MAX_NAME_LENGTH}" ` +
                      `value="${escapeText(summary.name || '')}" placeholder="${escapeText(summary.label)}" ` +
                      `style="flex:1; min-width:0; font-size:11px; padding:1px 4px; border-radius:3px;` +
                      ` border:1px solid ${accent}; background:rgba(0,0,0,0.3); color:#e8ecf5;">`
                    : `<span data-history-open="${escapeText(id)}" role="button" tabindex="0" ` +
                      `title="${escapeText(`Open ${title}`)}" style="flex:1; min-width:0; font-weight:600;` +
                      ` cursor:pointer; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">` +
                      `${escapeText(title)}</span>`;
            const figures =
                `${formatKMB(Math.round(summary.total))} ${type === 'trial' ? 'damage' : 'team damage'}` +
                (summary.perSecond === null ? '' : ` · ${formatKMB(Math.round(summary.perSecond))} dps`) +
                (summary.basis === 'game' ? ' · game totals' : '') +
                (summary.finished === false ? ' · cut short' : '');
            const confirm = confirming === id;
            return (
                `<div data-history-row="${escapeText(id)}" style="margin:3px 0; padding:4px 6px; border-radius:3px;` +
                ` background:rgba(255,255,255,0.04);">` +
                `<div style="display:flex; gap:6px; align-items:center;">${star}${name}` +
                `<span style="color:${dim}; font-size:10px; white-space:nowrap;">` +
                `${escapeText(formatSessionDuration(summary.seconds))}</span></div>` +
                `<div style="color:${dim}; font-size:10px; line-height:1.5;">` +
                `${escapeText(formatSessionDate(summary.endedAt))}` +
                (summary.name ? ` · ${escapeText(summary.label)}` : '') +
                (summary.detail ? ` · ${escapeText(summary.detail)}` : '') +
                `</div>` +
                `<div style="display:flex; gap:4px; align-items:center; color:${good}; font-size:10px;">` +
                `<span style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">` +
                `${escapeText(figures)}</span>` +
                rowButton('data-history-copy', id, 'Copy', 'Copy this session as text') +
                rowButton('data-history-rename', id, 'Rename', 'Give this session a name') +
                rowButton(
                    'data-history-delete',
                    id,
                    confirm ? 'Delete?' : 'Delete',
                    confirm ? 'Click again to delete it for good' : 'Delete this session',
                    confirm ? warn : dim
                ) +
                `</div></div>`
            );
        })
        .join('');

    return intro + noticeHTML + rows;
}

/**
 * The bar across the top of a board redrawn from a saved session.
 * @param {Object} entry - A session body
 * @param {Object|null} [summary] - Its summary, for the user's name
 * @returns {string} HTML carrying a `data-action="live"` button
 */
export function savedBannerHTML(entry, summary = null) {
    const { warn } = BOARD_COLORS;
    const title = summary?.name || entry?.summary?.label || 'a saved session';
    return (
        `<div data-history-banner style="display:flex; gap:6px; align-items:center; margin:0 0 6px; padding:4px 6px;` +
        ` border-radius:4px; border:1px solid ${warn}66; background:${warn}1a; color:${warn}; font-size:10.5px;` +
        ` line-height:1.4;">` +
        `<span style="flex:1; min-width:0;">Viewing saved ${entry?.type === 'trial' ? 'trial' : 'session'} from ` +
        `${escapeText(formatSessionDate(entry?.endedAt))} — ${escapeText(title)}, ` +
        `${escapeText(formatSessionDuration(entry?.seconds))}. Read-only.</span>` +
        `<button data-action="live" style="cursor:pointer; padding:1px 6px; border-radius:3px; font-size:10px;` +
        ` color:${warn}; background:transparent; border:1px solid ${warn}88; white-space:nowrap;">Back to live</button>` +
        `</div>`
    );
}

/**
 * Wire a drawn list's star, open, rename, copy and delete controls.
 *
 * Every action captures the character before it awaits and redraws only if
 * that character is still the one logged in.
 *
 * @param {HTMLElement} body - Where the list was drawn
 * @param {Object} handlers - What the panel does
 * @param {string} handlers.type - `combat` or `trial`
 * @param {Function} handlers.redraw - Draw the panel again
 * @param {Function} handlers.onOpen - `(entry, summary) => void`, with the body read
 * @param {Function} handlers.copyText - `(entry, summary) => string`
 */
export function wireHistoryList(body, { type, redraw, onOpen, copyText }) {
    const state = historyUiState(type);
    const summaryFor = (id) => (cachedHistoryIndex(type) || []).find((summary) => summary.id === id) || null;
    const guarded = async (work) => {
        const characterId = currentCharacterId();
        try {
            await work(characterId);
        } catch (error) {
            console.error('[MeterHistory] A history action failed:', error);
        }
        if (currentCharacterId() === characterId) redraw();
    };

    body.querySelectorAll('[data-history-star]').forEach((button) => {
        button.addEventListener('click', () => {
            const id = button.dataset.historyStar;
            guarded(async (characterId) => {
                const on = !summaryFor(id)?.favourite;
                const result = await setFavourite(type, id, on, characterId);
                state.notice =
                    result.ok || result.reason !== 'full'
                        ? null
                        : `${MAX_FAVOURITES} are starred already — unstar one before starring another.`;
            });
        });
    });

    body.querySelectorAll('[data-history-open]').forEach((element) => {
        const open = async () => {
            const id = element.dataset.historyOpen;
            const summary = summaryFor(id);
            const entry = await openHistoryEntry(type, id);
            if (!entry) {
                state.notice = 'That session could not be read back.';
                redraw();
                return;
            }
            state.notice = null;
            onOpen(entry, summary);
        };
        element.addEventListener('click', open);
        element.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            open();
        });
    });

    body.querySelectorAll('[data-history-copy]').forEach((button) => {
        button.addEventListener('click', async () => {
            const id = button.dataset.historyCopy;
            const entry = await openHistoryEntry(type, id);
            if (!entry) return;
            try {
                await navigator.clipboard?.writeText?.(copyText(entry, summaryFor(id)));
                button.textContent = 'Copied';
            } catch (error) {
                console.error('[MeterHistory] Copying a saved session failed:', error);
            }
        });
    });

    body.querySelectorAll('[data-history-rename]').forEach((button) => {
        button.addEventListener('click', () => {
            state.renaming = button.dataset.historyRename;
            state.confirming = null;
            redraw();
            body.querySelector('[data-history-label]')?.focus?.();
        });
    });

    body.querySelectorAll('[data-history-label]').forEach((input) => {
        const id = input.dataset.historyLabel;
        const commit = () => {
            if (state.renaming !== id) return;
            state.renaming = null;
            guarded((characterId) => renameEntry(type, id, input.value, characterId));
        };
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                commit();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                state.renaming = null;
                redraw();
            }
        });
        input.addEventListener('blur', commit);
    });

    body.querySelectorAll('[data-history-delete]').forEach((button) => {
        button.addEventListener('click', () => {
            const id = button.dataset.historyDelete;
            if (state.confirming !== id) {
                state.confirming = id;
                redraw();
                return;
            }
            state.confirming = null;
            guarded((characterId) => deleteEntry(type, id, characterId));
        });
    });
}

/** Forget every cache and list state — for tests */
export function _resetMeterHistory() {
    indexCache.clear();
    loading.clear();
    queues.clear();
    bodyCache.clear();
    for (const state of Object.values(uiState)) {
        state.renaming = null;
        state.confirming = null;
        state.notice = null;
    }
}
