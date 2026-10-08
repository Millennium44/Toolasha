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
 * it commits. A write a payload carries bumps the count for the scopes it
 * reaches. A build that finds the payload matching the stored fingerprint — or
 * a push that stores the fingerprint of the payload it just built — records
 * the count it started from as the clean point; until the count moves, the
 * stored fingerprint is still the payload's, and the push can say "unchanged"
 * without building.
 *
 * Why that is safe, and where it is not:
 *
 * - The generation is taken *after* the flush and before the build. Every
 *   write is counted again when it commits, so a write not yet in IndexedDB
 *   when the count is taken — still queued, requeued after a failure, landing
 *   during the build, another tab's — counts after the snapshot, and the next
 *   push builds again; it can never be absorbed into a clean point it was not
 *   read into. One that committed before the snapshot is in what the build read.
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
import { payloadCarriesKey } from './sync-payload.js';

/** How long a clean point vouches for the database before a push builds anyway. */
export const CLEAN_POINT_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * The one store a `settings`-scope payload carries — `buildPayloadJSON` filters
 * the synced stores down to it for that scope; `everything` carries them all.
 */
const SETTINGS_SCOPE_STORE = 'settings';

/**
 * Writes heard since the tracker started, split by what they can reach: the
 * `settings` store (every scope's payload), the other synced stores (only an
 * `everything` payload), and writes to an unknown store (any payload). Kept
 * apart so that a settings-only device, whose payload `actionProgress` and the
 * histories never touch, is not sent back to building by every action tick.
 */
const generations = { settings: 0, other: 0, unknown: 0 };
/** Unsubscribe from `storage.onWrite`, while listening */
let unsubscribe = null;
/** `{generation, lastHash, scope, at}` of the last proven-clean build, or null */
let cleanPoint = null;

/**
 * Whether a reported write could change a payload.
 *
 * Only keys a payload carries count (`payloadCarriesKey`). Most writes in
 * `settings` are not: the sync's own bookkeeping, the session briefing's
 * heartbeat every few seconds, network tallies, caches, and other scripts'
 * records. Counting those moved the count on nearly every tick, and the push
 * built every time anyway.
 * @param {{storeName: string|null, keys: Array<string>|null}} write - From `storage.onWrite`
 * @returns {boolean} True unless every key it names provably stays out of a payload
 */
function countsAsChange({ storeName, keys }) {
    if (storeName === null || storeName === undefined) return true;
    // A bulk write whose keys were not listed counts if its store syncs at all
    if (!Array.isArray(keys) || keys.length === 0) return isSyncedStore(storeName);
    return keys.some((key) => payloadCarriesKey(storeName, key));
}

/**
 * Start counting writes. Idempotent; the count runs for the life of the page.
 * @returns {boolean} Whether the tracker is listening
 */
export function startSyncDirtyTracker() {
    if (unsubscribe) return true;
    if (typeof storage.onWrite !== 'function') return false;
    unsubscribe = storage.onWrite((write) => {
        if (!countsAsChange(write)) return;
        if (write.storeName === null || write.storeName === undefined) generations.unknown += 1;
        else if (write.storeName === SETTINGS_SCOPE_STORE) generations.settings += 1;
        else generations.other += 1;
    });
    return true;
}

/**
 * The write count for what one scope's payload carries — snapshot it once the
 * flush has landed, just before building.
 * @param {string} scope - 'settings' or 'everything'
 * @returns {number} Writes heard so far that could change that scope's payload
 */
export function syncWriteGeneration(scope) {
    const reach = generations.unknown + generations.settings;
    return scope === 'everything' ? reach + generations.other : reach;
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
    // Scope first: a count is only comparable with one taken for the same scope
    if (!storedHash || cleanPoint.lastHash !== storedHash || cleanPoint.scope !== scope) return false;
    if (cleanPoint.generation !== syncWriteGeneration(scope)) return false;
    return Date.now() - cleanPoint.at < CLEAN_POINT_MAX_AGE_MS;
}

/** Test hook: forget the clean point and stop listening. */
export function _resetSyncDirtyTracker() {
    unsubscribe?.();
    unsubscribe = null;
    cleanPoint = null;
    generations.settings = 0;
    generations.other = 0;
    generations.unknown = 0;
}
