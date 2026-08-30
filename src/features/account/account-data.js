/**
 * Account data
 *
 * Every character on the account, read back out of what each of them already
 * wrote down.
 *
 * Nothing here talks to the game about a character you are not logged into,
 * because nothing can. What exists is the residue each character leaves in
 * IndexedDB while you play it — an hourly networth series, a queue snapshot
 * taken on the way out, a loot log, a trade history — and every one of those
 * stores is keyed `<something>_<characterId>`. So the account is enumerated by
 * scanning keys, and each character's figures are whatever its own recorders
 * last managed to store.
 *
 * That makes everything below a *last known* rather than a current value, and
 * the panel says so. The alternative — recomputing a networth for a character
 * whose inventory we cannot see — would be a number with nothing behind it.
 *
 * The arithmetic is exported separately from the reading, because the reading
 * needs a database and the arithmetic is what is worth testing.
 */

import storage from '../../core/storage.js';
import dataManager from '../../core/data-manager.js';
import { SNAPSHOT_PREFIX as BRIEFING_PREFIX, readSnapshotsFromKeys } from '../briefing/briefing-snapshot-store.js';
import { showToast } from '../../utils/toast.js';
import { idsFromRecordKeys, recordKeysFor } from '../../utils/chunked-history.js';

/** Where each recorder puts its per-character keys */
export const NETWORTH_STORE = 'networthHistory';
export const QUEUE_STORE = 'queueSnapshots';
export const LOOT_STORE = 'lootLogHistory';
export const SETTINGS_STORE = 'settings';

const NETWORTH_PREFIX = 'networth_';
const QUEUE_PREFIX = 'queueSnapshot_';
const LOOT_PREFIX = 'lootLog_';
const TRADE_PREFIX = 'tradeHistory_';

/**
 * The chunked recorders, whose keys are `<prefix>_<characterId>_<chunkId>`.
 *
 * The networth series and the loot log are stored one record per month and per
 * hour respectively (see `utils/chunked-history.js`), so a character that has
 * been migrated has no `networth_<id>` key at all and would vanish from the
 * account if only the single-key prefixes were scanned. Both shapes are read,
 * because a character not logged into since the migration shipped still has the
 * old one.
 */
const NETWORTH_RECORD_PREFIX = 'networthSeries';
const LOOT_RECORD_PREFIX = 'lootLogRec';

/** Character id → name, accumulated as you play each one */
const NAMES_KEY = 'accountCharacterNames';

/** Past this, a queue snapshot describes a session long since over */
export const STALE_SNAPSHOT_MS = 7 * 24 * 60 * 60 * 1000;

/** How long a gathered account stays good enough to redraw from */
const CACHE_TTL_MS = 60 * 1000;

/** Enough points for a trend, few enough to keep the merge cheap */
const MAX_COMBINED_POINTS = 400;

/**
 * The character ids a set of keys names.
 *
 * @param {Array<string>} keys - Keys from one store
 * @param {string} prefix - The recorder's prefix, e.g. `networth_`
 * @returns {Array<string>} Character ids, in key order, deduplicated
 */
export function idsFromKeys(keys, prefix) {
    const ids = [];
    const seen = new Set();
    for (const key of keys) {
        if (typeof key !== 'string' || !key.startsWith(prefix)) continue;
        const id = key.slice(prefix.length);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
    }
    return ids;
}

/**
 * One character's networth series, whichever shape it is stored in.
 *
 * The pre-migration single key wins when it is there, because its presence means
 * the split has not happened yet and any records beside it are a half-finished
 * migration rather than the record. Reading is one key per month rather than a
 * whole-store `getAll()`: this store also holds twenty-five item-level detail
 * snapshots per character, and pulling a year of inventories into memory to
 * assemble a list of timestamps and totals is not a trade worth making.
 *
 * @param {Array<string>} keys - Every key in the networth store
 * @param {string} id - Whose series
 * @returns {Promise<Array<{t: number, total: number}>>} The series, oldest first
 */
async function readSeries(keys, id) {
    const legacy = await storage.get(`${NETWORTH_PREFIX}${id}`, NETWORTH_STORE, null);
    if (Array.isArray(legacy) && legacy.length > 0) return legacy;

    const points = [];
    for (const key of recordKeysFor(keys, NETWORTH_RECORD_PREFIX, id)) {
        const chunk = await storage.get(key, NETWORTH_STORE, null);
        if (Array.isArray(chunk)) points.push(...chunk);
    }

    points.sort((a, b) => (a?.t || 0) - (b?.t || 0));
    return points;
}

/**
 * Add several characters' networth series into one line.
 *
 * The series are independent — each character records only while you are
 * playing it — so the timestamps never line up and summing point for point is
 * not available. Each character instead holds its last recorded total forward
 * until it records another, which is the same assumption the number itself
 * makes: an alt you have not logged into is worth what it was worth when you
 * left it.
 *
 * A character contributes nothing before its first point rather than zero, so
 * the combined line does not step up every time a character's history begins.
 * `contributors` says how many were actually counted at each point, which is
 * what lets the panel avoid presenting a partial total as the account.
 *
 * @param {Object<string, Array<{t: number, total: number}>>} seriesById - Per character, oldest first
 * @param {Object} [options] - Options
 * @param {number} [options.maxPoints] - Downsample beyond this many points
 * @returns {Array<{t: number, total: number, contributors: number}>} Combined, oldest first
 */
export function combineSeries(seriesById, { maxPoints = MAX_COMBINED_POINTS } = {}) {
    const entries = Object.entries(seriesById || {})
        .map(([id, series]) => [id, (series || []).filter((p) => p && Number.isFinite(p.t)).sort((a, b) => a.t - b.t)])
        .filter(([, series]) => series.length > 0);

    if (entries.length === 0) return [];

    const stamps = [...new Set(entries.flatMap(([, series]) => series.map((p) => p.t)))].sort((a, b) => a - b);

    const cursors = new Map(entries.map(([id]) => [id, 0]));
    const held = new Map();
    const combined = [];

    for (const t of stamps) {
        for (const [id, series] of entries) {
            let index = cursors.get(id);
            while (index < series.length && series[index].t <= t) {
                held.set(id, series[index].total || 0);
                index += 1;
            }
            cursors.set(id, index);
        }

        let total = 0;
        for (const value of held.values()) total += value;
        combined.push({ t, total, contributors: held.size });
    }

    return downsample(combined, maxPoints);
}

/**
 * Thin a series to a point budget, keeping the ends.
 *
 * The last point is the one every figure in the panel is drawn from, so it is
 * the one thinning must not drop.
 *
 * @param {Array<Object>} points - Series, oldest first
 * @param {number} maxPoints - Budget
 * @returns {Array<Object>} At most `maxPoints` points
 */
export function downsample(points, maxPoints) {
    if (!Array.isArray(points) || points.length <= maxPoints || maxPoints < 2) return points;

    const step = (points.length - 1) / (maxPoints - 1);
    const thinned = [];
    for (let i = 0; i < maxPoints - 1; i++) thinned.push(points[Math.round(i * step)]);
    thinned.push(points[points.length - 1]);
    return thinned;
}

/**
 * What a series did over the last `windowMs`.
 *
 * The baseline is the last point at or before the window opens rather than the
 * first point inside it — a character recorded hourly and then not touched for
 * a week has no point inside a 24-hour window at all, and comparing the latest
 * point against itself would report a flat line where the honest answer is
 * "nothing has changed since the last reading".
 *
 * @param {Array<{t: number, total: number}>} points - Series, oldest first
 * @param {number} windowMs - How far back the window opens
 * @param {number} [now] - Clock, injectable for tests
 * @returns {{delta: number, percent: number|null, from: number, to: number, spanMs: number}|null}
 *   Null when there is nothing to compare against
 */
export function windowChange(points, windowMs, now = Date.now()) {
    if (!Array.isArray(points) || points.length < 2) return null;

    const last = points[points.length - 1];
    const cutoff = now - windowMs;

    let base = null;
    for (const point of points) {
        if (point.t <= cutoff) base = point;
    }
    if (!base) base = points[0];
    if (base === last || base.t >= last.t) return null;

    const delta = last.total - base.total;
    return {
        delta,
        percent: base.total ? (delta / base.total) * 100 : null,
        from: base.total,
        to: last.total,
        spanMs: last.t - base.t,
    };
}

/**
 * What a queue snapshot still implies about a character, given the clock.
 *
 * Same projection `queue-alerts.js` makes, and it inherits the same limits: a
 * snapshot is taken when you switch *away*, so a character queued from another
 * browser, or one that ran out early, is not visible here. `stale` marks the
 * snapshots too old for the projection to mean anything at all.
 *
 * @param {Object|null} snapshot - A `queueSnapshot_<id>` value
 * @param {number} [now] - Clock, injectable for tests
 * @returns {{state: string, remainingSeconds: number|null, stale: boolean, ageMs: number|null}}
 *   State is `unknown`, `idle`, `busy` or `endless`
 */
export function queueState(snapshot, now = Date.now()) {
    if (!snapshot || !Number.isFinite(snapshot.timestamp)) {
        return { state: 'unknown', remainingSeconds: null, stale: false, ageMs: null };
    }

    const ageMs = now - snapshot.timestamp;
    const stale = ageMs > STALE_SNAPSHOT_MS;
    const remaining = Math.max(0, (snapshot.totalQueueSeconds || 0) - ageMs / 1000);

    if (remaining > 0) return { state: 'busy', remainingSeconds: remaining, stale, ageMs };
    if (snapshot.hasInfiniteAction) return { state: 'endless', remainingSeconds: null, stale, ageMs };
    return { state: 'idle', remainingSeconds: 0, stale, ageMs };
}

/**
 * One row per character, richest first.
 *
 * @param {Object} input - Everything gathered
 * @param {Array<string>} input.ids - Every character id found
 * @param {Object<string, Array<Object>>} input.seriesById - Networth series per character
 * @param {Object<string, Object>} input.snapshotsById - Queue snapshots per character
 * @param {Object<string, string>} input.namesById - Known names
 * @param {string|null} input.currentId - Who is logged in
 * @param {number} [input.now] - Clock, injectable for tests
 * @returns {Array<Object>} Rows with id, name, networth, lastSeen, queue, isCurrent
 */
export function summarizeCharacters({ ids, seriesById, snapshotsById, namesById, currentId, now = Date.now() }) {
    const rows = ids.map((id) => {
        const series = seriesById?.[id] || [];
        const last = series.length ? series[series.length - 1] : null;
        const snapshot = snapshotsById?.[id] || null;

        const seenAt = Math.max(last?.t || 0, snapshot?.timestamp || 0) || null;

        return {
            id,
            name: namesById?.[id] || snapshot?.characterName || `Character ${id}`,
            named: Boolean(namesById?.[id] || snapshot?.characterName),
            networth: last ? last.total : null,
            networthAt: last ? last.t : null,
            lastSeen: seenAt,
            points: series.length,
            queue: queueState(snapshot, now),
            isCurrent: id === currentId,
        };
    });

    // Richest first, but whoever is logged in leads — it is the one row the
    // reader can check against the game itself
    rows.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || (b.networth ?? -1) - (a.networth ?? -1));
    return rows;
}

/** The gathered account, and when it was gathered */
let cached = null;
let inFlight = null;

/** Why the last read failed, so the panel can say so instead of "Reading…" forever */
let lastFailure = null;

/** One toast per session, not one per refresh — see `noteFailure` */
let warned = false;

/**
 * Say once that storage would not answer.
 *
 * Everything in this module was console-only, which for a panel that reads on a
 * timer is the worst of both: the console fills with the same line every minute
 * and the panel sits on "Reading the account…" saying nothing. So the panel is
 * told (via `accountReadFailure`) and the player is told once — a second toast
 * about the same broken database is noise, and the refresh that produced it runs
 * every sixty seconds.
 *
 * @param {string} what - Which operation failed, for the console line
 * @param {Error} error - What went wrong
 */
function noteFailure(what, error) {
    lastFailure = error?.message || String(error);
    console.error(`[AccountData] ${what}:`, error);
    if (warned) return;
    warned = true;
    showToast(
        'Toolasha could not read your characters from storage — the Account panel will be empty or out of date. ' +
            'Reload the page; if it keeps happening, run Toolasha.debug.storage() in the console.',
        { kind: 'error' }
    );
}

/**
 * Why the last read failed, for the panel to show in place of a spinner.
 * @returns {string|null} The failure, or null when the last read was fine
 */
export function accountReadFailure() {
    return lastFailure;
}

/**
 * Forget that anything failed. For tests — a session does not get a second
 * chance at "once per session".
 */
export function resetAccountReadFailure() {
    lastFailure = null;
    warned = false;
}

/**
 * Note the name of whoever is logged in, so the other characters can be named
 * later.
 *
 * Nothing else on the account stores a name against an id except the queue
 * snapshot, and that only exists for characters you have switched *away* from
 * since the feature shipped. Writing one line per login fills the gap for every
 * character you actually play.
 *
 * @returns {Promise<void>}
 */
export async function rememberCurrentCharacter() {
    try {
        const id = dataManager.getCurrentCharacterId();
        const name = dataManager.getCurrentCharacterName();
        if (!id || !name) return;

        const names = (await storage.get(NAMES_KEY, SETTINGS_STORE, {})) || {};
        if (names[id] === name) return;
        await storage.set(NAMES_KEY, { ...names, [id]: name }, SETTINGS_STORE);
    } catch (error) {
        // Same database, same one-per-session notice: a name that cannot be
        // written is the first sign of the read that is about to fail too
        noteFailure('Could not record the character name', error);
    }
}

/**
 * Read every character's residue out of storage.
 *
 * @param {number} [now] - Clock, injectable for tests
 * @returns {Promise<Object>} `{at, currentId, characters, combined, briefings}`
 */
export async function readAccount(now = Date.now()) {
    const currentId = dataManager.getCurrentCharacterId();

    const [networthKeys, queueValues, lootKeys, settingsKeys] = await Promise.all([
        storage.getAllKeys(NETWORTH_STORE),
        storage.getAll(QUEUE_STORE),
        storage.getAllKeys(LOOT_STORE),
        storage.getAllKeys(SETTINGS_STORE),
    ]);

    // Enumerate from every recorder, so a character that only ever had one of
    // them switched on is still an account member
    const ids = new Set([
        ...idsFromKeys(networthKeys, NETWORTH_PREFIX),
        ...idsFromRecordKeys(networthKeys, `${NETWORTH_RECORD_PREFIX}_`),
        ...idsFromKeys(Object.keys(queueValues), QUEUE_PREFIX),
        ...idsFromKeys(lootKeys, LOOT_PREFIX),
        ...idsFromRecordKeys(lootKeys, `${LOOT_RECORD_PREFIX}_`),
        ...idsFromKeys(settingsKeys, TRADE_PREFIX),
        ...idsFromKeys(settingsKeys, BRIEFING_PREFIX),
    ]);
    if (currentId) ids.add(currentId);

    const snapshotsById = {};
    for (const snapshot of Object.values(queueValues)) {
        if (snapshot?.characterId) snapshotsById[snapshot.characterId] = snapshot;
    }

    const namesById = (await storage.get(NAMES_KEY, SETTINGS_STORE, {})) || {};

    const seriesById = {};
    for (const id of ids) {
        seriesById[id] = await readSeries(networthKeys, id);
    }

    const characters = summarizeCharacters({
        ids: [...ids],
        seriesById,
        snapshotsById,
        namesById,
        currentId,
        now,
    });

    return {
        at: now,
        currentId,
        characters,
        combined: combineSeries(seriesById),
        // Read off the key list already in hand rather than with a scan of its
        // own — a snapshot lives in the settings store beside everything else
        // keyed per character
        briefings: await readSnapshotsFromKeys(settingsKeys),
    };
}

/**
 * The account as last read, without reading it again.
 * @returns {Object|null} Null until the first read lands
 */
export function cachedAccount() {
    return cached;
}

/**
 * Read the account if what we have has gone off.
 *
 * Never awaited by the panel: a redraw on a three-second timer has no business
 * blocking on a dozen IndexedDB reads, and the next redraw shows the result.
 * Concurrent callers share the one read in flight.
 *
 * @param {number} [ttlMs] - How old is too old
 * @returns {Promise<Object|null>} The account, or null if the read failed
 */
export async function refreshAccount(ttlMs = CACHE_TTL_MS) {
    if (cached && Date.now() - cached.at < ttlMs) return cached;
    if (inFlight) return inFlight;

    inFlight = (async () => {
        try {
            cached = await readAccount();
            lastFailure = null;
            return cached;
        } catch (error) {
            noteFailure('Could not read the account', error);
            return cached;
        } finally {
            inFlight = null;
        }
    })();

    return inFlight;
}

/** Forget what was read, so the next refresh goes to storage. */
export function clearAccountCache() {
    cached = null;
}
