/**
 * What gets uploaded, and what must never be.
 *
 * The payload is deliberately the same shape as a full backup
 * (`utils/full-backup.js`) — `{formatVersion, exportedAt, stores}` — so a gist
 * can be downloaded by hand and fed straight into "Restore Backup", and so the
 * restore path is `importEverything()` rather than a second, subtly different
 * importer that has to be kept in step with it.
 *
 * It is built here rather than by calling `exportEverythingJSON()` for one
 * reason: redaction. The GitHub token is a setting, settings live in the
 * `settings` store, and both sync scopes include that store — so an unmodified
 * full backup would upload the token to the very service it authenticates
 * against, where a second device would then download and store it. The token,
 * the handful of settings that describe the machine rather than the account, and
 * the device-local sync bookkeeping are all stripped on the way out.
 *
 * Like the full backup this serializes one store at a time and releases each
 * before reading the next, so peak memory is the finished text plus one store
 * rather than the whole database twice over.
 */

import storage from '../../core/storage.js';
import settingsStorage from '../../core/settings-storage.js';
import { importEverything, stripExcludedKeys } from '../../utils/full-backup.js';
import { mergeForKey } from '../../utils/sync-merge-registry.js';

/** Matches the full-backup format, because that is what this produces */
const FORMAT_VERSION = 1;

/** The store holding settings, and the only store a `settings` scope carries */
const SETTINGS_STORE = 'settings';

/**
 * Setting IDs removed from every payload.
 *
 * The token is a credential for the transport itself; uploading it would put a
 * gist-scoped GitHub credential inside a gist, and pulling would silently plant
 * it on another machine. The passphrase is the key to the payload's own
 * encryption; uploading it — even inside the ciphertext it unlocks — would be
 * circular, and pulling must never overwrite the one thing that made the pull
 * readable.
 */
export const REDACTED_SETTING_IDS = ['sync_token', 'sync_passphrase'];

/**
 * Setting IDs that describe the machine rather than the account.
 *
 * Not secrets — nothing here would matter if it were read. They are removed for
 * the opposite reason to the credentials above: the value is *true here and
 * wrong elsewhere*. The thread settings are a core count. An eight-core
 * desktop's number arriving on a two-core laptop does not fail loudly; the
 * laptop just oversubscribes itself and every simulation it runs gets slower,
 * with nothing on screen to connect that to a sync that happened days ago. A
 * number that must be measured per machine cannot be carried between machines.
 *
 * These *are* shared across every character on this device — see
 * `SHARED_SETTING_IDS` in `core/settings-storage.js`, which is where the sharing
 * is decided. This list only says they stop at the edge of the device.
 */
export const DEVICE_LOCAL_SETTING_IDS = ['combatSim_maxThreads', 'combatSim_uncapThreads'];

/**
 * Every setting ID that stays on the machine that wrote it, for whichever of the
 * two reasons above.
 *
 * One list because the handling is identical in both directions — stripped from
 * a payload on the way out, and never taken from one on the way in. Deliberately
 * two lists folded into one rather than one flat list of ids: whoever reads this
 * next must not come away thinking a thread count is a credential, or that a
 * credential is merely inconvenient to share.
 */
const LOCAL_ONLY_SETTING_IDS = [...REDACTED_SETTING_IDS, ...DEVICE_LOCAL_SETTING_IDS];

/**
 * Storage keys removed from every payload.
 *
 * Which gist and how far this device has got with it are facts about the
 * device, not about the account. Syncing them would have each pull overwrite the
 * receiving device's idea of what it had already seen, which is exactly the
 * state conflict detection depends on.
 *
 * `toolasha_local_` is a different kind of never: not bookkeeping that would
 * confuse another device, but data that must not be published at all. The
 * preserved chat history under it
 * (`features/chat/chat-history-persistence.js`) is every tab's markup,
 * whispers and private messages included — stored on disk by the maintainer's
 * explicit choice, and a gist is not disk. Anything else that must stay on the
 * machine that wrote it belongs under this prefix too.
 *
 * Both prefixes are honoured on the way out (`redactSettingsStore`) and on the
 * way in (`applyPayload`), so a payload written by an older build that did not
 * strip them cannot plant one either.
 *
 * `updateCheckState` and `sessionBriefingLastAlive_` are single keys rather than
 * prefixes in the naming-scheme sense — the mechanism matches by `startsWith`,
 * so a literal key matches itself. Both are the same shape as
 * `toolasha_sync_lastSyncedSeq`: a cached
 * answer to "what did this device last see/do", stamped with this device's
 * clock. `updateCheckState` is this device's last update-poll (`checkedAt`,
 * `latestVersion` — see `features/ui/update-check.js`); a pull handing it
 * another device's `checkedAt` would suppress that device's own next check for
 * up to the configured interval. `sessionBriefingLastAlive_` is a per-character
 * prefix for this browser tab's own liveness heartbeat (see
 * `features/briefing/session-briefing.js`), which only means anything compared
 * against this device's clock inside a 60-second window; a foreign timestamp
 * landing in it can misfire that comparison. Neither is a setting a player
 * chose — `updateCheck`/`updateCheckHours` are, and travel normally.
 *
 * `Toolasha_marketAPI_` is the market price cache (`api/marketplace.js`) — the
 * snapshot, its fetch stamp, the order-book patches and the patch migration
 * version. This one is not kept back because it would be *wrong* elsewhere:
 * prices are global, so a copy is as true on the next device as on this one.
 * It is kept back because of what it weighs. The snapshot alone measures around
 * 114 KB, it rides every push and every pull, and the receiving device throws it
 * away and refetches within fifteen minutes (`CACHE_DURATION`) anyway — so the
 * payload pays for a cache that is stale before it lands. The stamp goes with
 * the snapshot because it is only meaningful beside it, and the patches are the
 * same trade at smaller size: this device's own order-book sightings, stamped
 * with this device's clock and purged against this device's last fetch. The
 * migration version is bookkeeping for the patches, and alone it is worse than
 * useless — a higher number arriving from another device would tell this one its
 * patches had already been cleared when they had not.
 */
export const LOCAL_ONLY_KEY_PREFIXES = [
    'toolasha_sync_',
    'toolasha_local_',
    'updateCheckState',
    'sessionBriefingLastAlive_',
    'Toolasha_marketAPI_',
];

/**
 * Strip credentials, device-local settings and device-local bookkeeping from a
 * settings-store dump.
 *
 * Returns a new object; the input is not mutated, because it is a live read of
 * the user's storage and quietly editing it would delete their token.
 *
 * @param {Record<string, *>} entries - Raw settings store contents
 * @returns {Record<string, *>} Safe-to-upload copy
 */
export function redactSettingsStore(entries) {
    const safe = {};

    for (const [key, value] of Object.entries(entries || {})) {
        if (LOCAL_ONLY_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;

        // The settings map is one key whose value is every setting; the token
        // and the thread count are entries inside it, not keys of their own.
        // The account-wide map (`script_settingsMap_shared`) shares the prefix
        // deliberately, so it is cleaned here too.
        if (!key.startsWith('script_settingsMap')) {
            safe[key] = value;
            continue;
        }

        const wasString = typeof value === 'string';
        let map = value;
        if (wasString) {
            try {
                map = JSON.parse(value);
            } catch {
                // Unparseable settings map: pass it through rather than drop it,
                // and accept that we cannot prove it is token-free
                safe[key] = value;
                continue;
            }
        }

        if (!map || typeof map !== 'object') {
            safe[key] = value;
            continue;
        }

        const cleaned = { ...map };
        for (const settingId of LOCAL_ONLY_SETTING_IDS) delete cleaned[settingId];
        safe[key] = wasString ? JSON.stringify(cleaned) : cleaned;
    }

    return safe;
}

/**
 * Build the JSON text to upload.
 *
 * @param {'settings'|'everything'} scope - How much to carry
 * @returns {Promise<string>} Payload text, in full-backup format
 */
export async function buildPayloadJSON(scope = 'settings') {
    const allStores = await storage.listStores();
    const storeNames = scope === 'everything' ? allStores : allStores.filter((name) => name === SETTINGS_STORE);

    const parts = [
        `{"formatVersion":${FORMAT_VERSION},`,
        `"exportedAt":${JSON.stringify(new Date().toISOString())},`,
        `"syncScope":${JSON.stringify(scope)},`,
        '"stores":{',
    ];

    let first = true;
    for (const storeName of storeNames) {
        const entries = stripExcludedKeys(storeName, await storage.getAll(storeName));
        const safe = storeName === SETTINGS_STORE ? redactSettingsStore(entries) : entries;
        parts.push(`${first ? '' : ','}${JSON.stringify(storeName)}:${JSON.stringify(safe)}`);
        first = false;
    }

    parts.push('}}');
    return parts.join('');
}

/**
 * Fold this device's histories into an incoming payload, key by key.
 *
 * Everything `importEverything` writes, it writes whole — which for a history
 * that both devices added to means the loser's additions are gone. Every such
 * record already owns a fold (it needs one for two tabs on one machine); the
 * owning feature declares it through `utils/sync-merge-registry.js`, and this
 * is where a pull consults it.
 *
 * The payload value is *replaced* with the fold rather than written separately,
 * so the import that follows is still one transaction per store and there is
 * still exactly one writer.
 *
 * A key with no registration, or one this device has never stored, is left as
 * it came down — nothing to combine, so the whole-key write is correct.
 *
 * A key whose local value cannot be *read* is a different case, and the one
 * that has to be got right: `storage.tryGet` answers `null` for a read that
 * failed and `{found: false}` for a key that is simply not here, and treating
 * them alike meant an aborted read handed the record straight to the whole-key
 * write — this device's entries destroyed by the exact failure that made them
 * invisible, with nothing said about it. So the key is *dropped from the
 * payload* instead: whatever is on disk stays, and the caller is told, because
 * the record it names did not get the downloaded copy.
 *
 * The caller must have quiesced writers first. `storage.tryGet` reads
 * IndexedDB, and `storage.set` debounces for three seconds — so a base read
 * while writes are still queued omits everything recorded in that window,
 * `importEverything` flushes the queue on its way in, and the union computed
 * from the stale base is then written straight back over the entry that just
 * landed. See {@link applyPayload}.
 *
 * A merge that throws is not fatal to the pull — the key falls back to the
 * whole-key write it would have had anyway — but it is not nothing either: this
 * device's entries for that record are the ones being discarded, and a pull that
 * reports plain success over it tells the player their histories were combined
 * when one of them was overwritten. So the failures come back beside the
 * successes, for the caller to say so.
 *
 * @param {Object} payload - Parsed payload; its store values are mutated in place
 * @returns {Promise<{merged: Array<{store: string, key: string, label: string}>,
 *   failed: Array<{store: string, key: string, label: string}>,
 *   held: Array<{store: string, key: string, label: string}>}>} What was combined, what took
 *   the remote copy anyway, and what was held back because the local copy could not be read
 */
async function mergeLocalHistories(payload) {
    const merged = [];
    const failed = [];
    const held = [];

    for (const [storeName, entries] of Object.entries(payload?.stores || {})) {
        if (!entries || typeof entries !== 'object') continue;

        // Keys captured up front: an unreadable base deletes its own key below
        for (const key of Object.keys(entries)) {
            const registration = mergeForKey(storeName, key);
            if (!registration) continue;

            try {
                const probed = await storage.tryGet(key, storeName);
                if (probed === null) {
                    // Read failed — not "nothing stored". This device may hold
                    // entries the union would have kept, and they are exactly
                    // what a whole-key write would destroy. Hold the download
                    // back rather than overwrite a base we could not see.
                    console.error(`[Sync] ${storeName}/${key} could not be read; keeping this device's copy.`);
                    delete entries[key];
                    held.push({ store: storeName, key, label: registration.label });
                    continue;
                }
                if (!probed.found || probed.value == null) continue;
                entries[key] = registration.merge(probed.value, entries[key]);
                merged.push({ store: storeName, key, label: registration.label });
            } catch (error) {
                console.error(`[Sync] Merging ${storeName}/${key} failed; taking the remote copy:`, error);
                failed.push({ store: storeName, key, label: registration.label });
            }
        }
    }

    return { merged, failed, held };
}

/**
 * Write a downloaded payload into local storage.
 *
 * The local token is never overwritten — it was redacted before upload, so a
 * payload cannot carry one, and `importEverything` writes whole keys. The
 * settings map is one such key, so the incoming map is merged over the local one
 * with the local token put back, rather than replacing it wholesale and leaving
 * this device unable to sync again. The device-local settings
 * ({@link DEVICE_LOCAL_SETTING_IDS}) are held back the same way, for a different
 * reason: this machine's core count is the only true one here.
 *
 * Additive histories are combined rather than replaced, always — see
 * {@link mergeLocalHistories}. A record that can only gain entries has no
 * reading of "apply the remote copy" under which discarding this device's
 * entries is what the user meant, so there is no option to; the pull's only
 * real choice is what happens to the records that *can't* be combined, and
 * those still take the remote wholesale.
 *
 * @param {string} json - Payload text as produced by `buildPayloadJSON()`
 * @returns {Promise<{restored: Record<string, number>, expected: Record<string, number>,
 *   failed: Array<Object>, complete: boolean, merged: Array<Object>, mergeFailed: Array<Object>,
 *   mergeHeld: Array<Object>, exportedAt: string|null, applied: string}>}
 *   What landed, how many keys each store was asked for (the figure the pull summary
 *   subtracts the folds from), whether all of it did, which records could not be
 *   combined, which were held back because this device's copy could not be read, and
 *   the payload text as actually applied
 */
export async function applyPayload(json) {
    const payload = JSON.parse(json);
    const settingsStore = payload?.stores?.[SETTINGS_STORE];

    if (settingsStore) {
        const local = await storage.getAll(SETTINGS_STORE);
        for (const [key, incoming] of Object.entries(settingsStore)) {
            if (!key.startsWith('script_settingsMap')) continue;
            settingsStore[key] = preserveLocalOnlySettings(local[key], incoming);
        }
        // Device-local bookkeeping is never taken from a payload, even one
        // written by an older build that did not redact it
        for (const key of Object.keys(settingsStore)) {
            if (LOCAL_ONLY_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) delete settingsStore[key];
        }
        // A settings map here lands the same way copySettingsFromCharacter and
        // importSettings do: whole, from somewhere else. A payload written by a
        // build older than a merge carries the retired ids and none of the ids
        // that replaced them, while this profile's key-migration record still
        // says those carries are done — so the settings the merge produced read
        // as never chosen and fall back to schema defaults. Forget the record
        // for exactly the maps that did not bring their own (see
        // reconcileKeyMigrationState), so the next load reconciles what this
        // pull actually landed.
        await settingsStorage.reconcileKeyMigrationState(Object.keys(settingsStore));
    }

    // Land the debounce queue BEFORE reading merge bases, not on the way into
    // `importEverything`. A history writes through `storage.set`, which holds
    // the value for three seconds; `mergeLocalHistories` reads through
    // `storage.tryGet`, which goes to IndexedDB and cannot see it. Flushing
    // afterwards — which is what `importEverything` does — makes the queued
    // value land and then be overwritten by a union computed without it, so a
    // pull arriving in the seconds after a kill, a fill or an XP sample threw
    // exactly those entries away. Flushing here makes the base current; the
    // flush inside `importEverything` then finds nothing left to do.
    await storage.beginRestore?.();

    try {
        const { merged, failed: mergeFailed, held: mergeHeld } = await mergeLocalHistories(payload);

        // What is remembered as "the state of this device" has to be what was
        // actually written. `mergeLocalHistories` (and the settings fix-ups
        // above) mutate the payload, so the downloaded text no longer describes
        // what landed — hashing it made every later rebuild compare unequal,
        // which read as "this device has changed" and raised a conflict on
        // every silent pull until an auto-push happened to reset it.
        // Re-serialising only when something was rewritten keeps the common
        // no-op pull free.
        const rewrote = merged.length > 0 || mergeHeld.length > 0 || Boolean(settingsStore);
        const applied = rewrote ? JSON.stringify(payload) : json;

        const { restored, expected, failed, complete } = await importEverything(payload);
        return {
            restored,
            expected,
            failed,
            complete,
            merged,
            mergeFailed,
            mergeHeld,
            exportedAt: payload?.exportedAt ?? null,
            applied,
        };
    } finally {
        // `importEverything` ends the hold itself on its way out; this covers
        // a throw between the flush above and reaching it, which would
        // otherwise leave every debounced write in the script held until the
        // unload flush. Ending an already-ended hold is a no-op.
        await storage.endRestore?.();
    }
}

/**
 * Fold an incoming settings map onto this device's, entry by entry.
 *
 * A settings map is a per-setting structure, not one record: taking the
 * incoming map whole meant every setting the *local* map had and the incoming
 * one did not was erased. That is not "the remote's choice wins" — the remote
 * expressed no choice. It happens whenever the two devices are on different
 * builds (the newer one's settings are simply absent from the older one's
 * saved map, which is written whole from whatever schema wrote it), and the
 * erased entries came back as shipped defaults on the next load, so settings
 * the player had turned off turned themselves back on after a pull.
 *
 * Per setting the incoming value still wins outright, which is the whole of
 * what the conflict dialog promises about settings. Only the entries the
 * payload says nothing about are kept.
 *
 * {@link LOCAL_ONLY_SETTING_IDS} are the one exception in the other direction:
 * they were stripped before upload, so an incoming map either lacks them or was
 * written by a build that did not strip them — some other device's token, or
 * some other machine's core count. This device's own value wins, and where it
 * has none the id is dropped rather than taken, so a stale payload cannot plant
 * one. That is not the usual "the payload said nothing, so keep what is here":
 * here the payload may well have said something, and it is not entitled to.
 *
 * @param {*} localValue - The settings map already on this device
 * @param {*} incomingValue - The settings map from the payload
 * @returns {*} Merged map, in whatever form the incoming value used
 */
function preserveLocalOnlySettings(localValue, incomingValue) {
    const wasString = typeof incomingValue === 'string';
    const parse = (value) => {
        if (typeof value !== 'string') return value;
        try {
            return JSON.parse(value);
        } catch {
            return null;
        }
    };

    const incoming = parse(incomingValue);
    const local = parse(localValue);
    if (!incoming || typeof incoming !== 'object') return incomingValue;

    const merged = local && typeof local === 'object' ? { ...local, ...incoming } : { ...incoming };
    for (const settingId of LOCAL_ONLY_SETTING_IDS) {
        if (local && typeof local === 'object' && local[settingId] !== undefined) {
            merged[settingId] = local[settingId];
        } else {
            delete merged[settingId];
        }
    }

    return wasString ? JSON.stringify(merged) : merged;
}

/**
 * A cheap content fingerprint, used to answer "has anything changed since the
 * last push?" without keeping a second copy of the payload around.
 *
 * FNV-1a: not a cryptographic hash and not meant to be. The consequence of a
 * collision is one skipped auto-push, which the next interval corrects.
 *
 * @param {string} text - Text to fingerprint
 * @returns {string} Hex digest
 */
export function hashPayload(text) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        // FNV prime, via shifts so the multiply stays in 32-bit range
        hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

/**
 * Hash a payload by its CONTENT, ignoring the `exportedAt` stamp.
 *
 * The payload text embeds the moment it was built, so hashing the raw text
 * makes every build look different: the auto-push's "unchanged, skip" never
 * fired, and worse, the hash remembered after a pull (the remote text, with
 * the remote's stamp) could never equal a local rebuild — so every later pull
 * read "this device has changed", raised the conflict dialog even from the
 * silent startup pull, and the unanswered modal held the sync busy for days.
 *
 * @param {string} text - Payload text as produced by `buildPayloadJSON()`
 * @returns {string} Hash of the payload with its `exportedAt` removed
 */
export function contentHash(text) {
    return hashPayload(String(text).replace(/"exportedAt":"[^"]*",/, ''));
}

/**
 * The `exportedAt` of a payload without parsing the whole thing.
 *
 * A full-scope payload can be megabytes; `JSON.parse` on it just to read one
 * timestamp is the sort of thing that makes a startup check feel like a freeze.
 *
 * @param {string} json - Payload text
 * @returns {string|null} ISO timestamp, or null when it is not there
 */
export function readExportedAt(json) {
    const match = /"exportedAt"\s*:\s*"([^"]+)"/.exec(json.slice(0, 512));
    return match ? match[1] : null;
}

export default {
    buildPayloadJSON,
    applyPayload,
    hashPayload,
    readExportedAt,
    redactSettingsStore,
};
