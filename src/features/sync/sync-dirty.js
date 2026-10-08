/**
 * "Has anything the sync carries been written since the last exchange?" —
 * answered without reading the database.
 *
 * The automatic push asks that question every quarter hour, and the only way it
 * had of answering was to build the whole payload — every synced store read,
 * serialized and hashed on the main thread — and compare the fingerprint with
 * the one it last exchanged. Nearly every tick the answer is "no", and the
 * build that found it out is a long task: on a large `everything` scope it
 * blocks the page long enough that IndexedDB transactions queued behind it
 * (this tab's and, for the stores it holds, every other tab's) time out.
 *
 * So writes are counted instead. `storage.onWrite` reports every write this
 * tab asks for, as it is asked for, and every write another tab commits, after
 * it commits. A write to a synced store bumps {@link generation}. A build that
 * finds the payload matching the stored fingerprint — or a push that stores
 * the fingerprint of the payload it just built — records the generation it
 * started from as the clean point; until the count moves, the stored
 * fingerprint is still the payload's, and the push can say "unchanged" without
 * building.
 *
 * Why that is safe, and where it is not:
 *
 * - The generation is taken *before* the flush and the build. A write that
 *   lands during the build counts after the snapshot, so the next push builds
 *   again; it can never be absorbed into a clean point it was not read into.
 * - Another tab's write is announced only after it commits. Heard before the
 *   snapshot, it committed before the build read the store; heard after, it
 *   counts against the next push. The one gap is a write committed in another
 *   tab whose announcement has not arrived when the push checks: that push
 *   skips, the announcement lands a moment later, and the next push sends it.
 *   Late by one interval, never lost.
 * - The comparison also requires the stored fingerprint and the scope to be
 *   what they were at the clean point, so a pull, a forgotten gist or a scope
 *   change (in any tab) sends the push back to building.
 * - Writers that cannot announce — no BroadcastChannel, a tab still running
 *   an older build of the script, another script writing our stores directly —
 *   are why the clean point also expires after {@link CLEAN_POINT_MAX_AGE_MS}:
 *   whatever they wrote goes up within the hour at worst, which is still four
 *   builds in five avoided.
 *
 * Only pushes nobody pressed use this. A pressed Push always builds.
 */

import storage from '../../core/storage.js';
import { isSyncedStore } from './sync-ownership.js';

/**
 * The store the device-local sync bookkeeping lives in, and its prefix — one of
 * `LOCAL_ONLY_KEY_PREFIXES` in `sync-payload.js`, so never in a payload. Every
 * push and pull writes these; counting them would make every push dirty the next.
 */
const BOOKKEEPING_STORE = 'settings';
const BOOKKEEPING_PREFIX = 'toolasha_sync_';

/** How long a clean point vouches for the database before a push builds anyway. */
export const CLEAN_POINT_MAX_AGE_MS = 60 * 60 * 1000;

/** Writes to synced stores this tab has heard of since the tracker started */
let generation = 0;
/** Unsubscribe from `storage.onWrite`, while listening */
let unsubscribe = null;
/** `{generation, lastHash, scope, at}` of the last proven-clean build, or null */
let cleanPoint = null;

/**
 * Whether a reported write could change a payload.
 * @param {{storeName: string|null, keys: Array<string>|null}} write - From `storage.onWrite`
 * @returns {boolean} True unless it provably touched only bookkeeping or unsynced stores
 */
function countsAsChange({ storeName, keys }) {
    if (storeName === null || storeName === undefined) return true;
    if (!isSyncedStore(storeName)) return false;
    if (storeName === BOOKKEEPING_STORE && Array.isArray(keys) && keys.length > 0) {
        return !keys.every((key) => typeof key === 'string' && key.startsWith(BOOKKEEPING_PREFIX));
    }
    return true;
}

/**
 * Start counting writes. Idempotent; the count runs for the life of the page.
 * @returns {boolean} Whether the tracker is listening
 */
export function startSyncDirtyTracker() {
    if (unsubscribe) return true;
    if (typeof storage.onWrite !== 'function') return false;
    unsubscribe = storage.onWrite((write) => {
        if (countsAsChange(write)) generation += 1;
    });
    return true;
}

/**
 * The current write count — snapshot it before flushing and building.
 * @returns {number} Writes to synced stores heard so far
 */
export function syncWriteGeneration() {
    return generation;
}

/**
 * Record that the payload built from the database as it stood at `atGeneration`
 * fingerprints to `lastHash`, and that `lastHash` is what is stored as the last
 * exchange.
 * @param {{generation: number, lastHash: string, scope: string}} point - The clean point
 */
export function markSyncClean({ generation: atGeneration, lastHash, scope }) {
    if (!unsubscribe || !lastHash || !Number.isSafeInteger(atGeneration)) return;
    cleanPoint = { generation: atGeneration, lastHash, scope, at: Date.now() };
}

/**
 * Whether a push may call the payload unchanged without building it.
 * @param {string} scope - The sync scope the push would build
 * @param {string|null} storedHash - The fingerprint stored as the last exchange
 * @returns {boolean} True only when nothing synced was written since a clean point that still holds
 */
export function unchangedSinceClean(scope, storedHash) {
    if (!unsubscribe || !cleanPoint) return false;
    if (!storage.crossTabWritesVisible?.()) return false;
    if (cleanPoint.generation !== generation) return false;
    if (!storedHash || cleanPoint.lastHash !== storedHash || cleanPoint.scope !== scope) return false;
    return Date.now() - cleanPoint.at < CLEAN_POINT_MAX_AGE_MS;
}

/** Test hook: forget the clean point and stop listening. */
export function _resetSyncDirtyTracker() {
    unsubscribe?.();
    unsubscribe = null;
    cleanPoint = null;
    generation = 0;
}
