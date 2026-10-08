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
import {
    isSyncedStore,
    ownsKey,
    partitionOwnedKeys,
    externalKeyRecord,
    learnExternalKeyPrefixes,
    ownershipSnapshot,
} from './sync-ownership.js';
import { ensureExternalKeysLoaded, ensureExternalKeysSaved } from './sync-external-keys.js';
import { importEverything, stripExcludedKeys, tombstoneCompanionKey } from '../../utils/full-backup.js';
import { mergeForKey } from '../../utils/sync-merge-registry.js';
import { GistError } from './gist-client.js';

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
    // Episodes this machine watched go by. Pulling another device's copy over
    // it would drop however many this one had counted, and a sum would
    // double-count every episode that had already travelled — so it stays put
    'stunPersistenceTally',
    // Intervals this machine timed off its own network. Another device's
    // arrival times are not this one's, so pulling or summing them would blend
    // two rulers into one figure that belongs to neither
    'waveGapTally',
    // Periods this machine timed off its own network, on the same reasoning:
    // another device's arrival times are not this one's
    'tickPeriodTally',
];

/**
 * Whether a key written to a store would travel in a payload at all.
 *
 * The same four filters the build applies, asked of one key: the store is one
 * the sync carries, the key is Toolasha's (`ownsKey`), the backup filter does
 * not strip it (`stripExcludedKeys`), and in `settings` it is not local-only.
 * What answers false here can be written as often as it likes without changing
 * a payload — a heartbeat stamped every few seconds, a cache, another script's
 * record — which is what lets the write counter in `sync-dirty.js` ignore it.
 *
 * It errs the safe way: a settings map that would be dropped for being
 * unreadable, or whose only change is a device-local setting inside it, still
 * answers true.
 *
 * @param {string} storeName - Object store the key was written to
 * @param {string} key - Storage key
 * @returns {boolean} True when the key can change a payload
 */
export function payloadCarriesKey(storeName, key) {
    if (!isSyncedStore(storeName) || !ownsKey(storeName, key)) return false;
    const name = String(key);
    if (!(name in (stripExcludedKeys(storeName, { [name]: true }) || {}))) return false;
    return !(storeName === SETTINGS_STORE && LOCAL_ONLY_KEY_PREFIXES.some((prefix) => name.startsWith(prefix)));
}

/**
 * Where each settings map's per-setting change stamps live:
 * `settings_changedAt_<map key>`, a `{settingId: {at, seq}}` record written by
 * `core/settings-storage.js` whenever a setting is changed on this device. The
 * literal is duplicated there (core cannot import a feature) and pinned by a
 * test on each side.
 *
 * A key of its own, not a field inside the map, for the older builds: they
 * read the map entry by entry and would carry an unknown field around in
 * whatever way their save path happens to, while a key they do not own is
 * simply dropped from a payload they pull and never sent in one they push.
 */
export const SETTING_STAMPS_PREFIX = 'settings_changedAt_';

/**
 * A stamps record as an object, whatever form it was stored in.
 * @param {*} value - Stored value
 * @returns {Record<string, {at: number, seq: number|null}>|null} A copy, or null when unreadable
 */
function readStamps(value) {
    let parsed = value;
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value);
        } catch {
            return null;
        }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return { ...parsed };
}

/**
 * One stamp, or null when it is not one.
 * @param {*} stamp - `{at, seq}` as stored
 * @returns {{at: number, seq: number|null}|null} The stamp
 */
function readStamp(stamp) {
    if (!stamp || typeof stamp !== 'object' || !Number.isFinite(stamp.at)) return null;
    return { at: stamp.at, seq: Number.isSafeInteger(stamp.seq) && stamp.seq >= 0 ? stamp.seq : null };
}

/**
 * Whether this side's change to one setting beats the other side's.
 *
 * The later change wins, by the wall clock of the device that made it. The
 * sync counter each side had reached breaks an exact tie of clocks and
 * nothing more. A device whose clock runs fast wins every setting both devices
 * changed within that skew, which is the price of honouring "the change I made
 * last" across devices with no shared clock.
 *
 * A system stamp (`at: 0`: a migration, a default rewrite, the first-load
 * seed) is older than any change a person made, so it never beats one.
 *
 * A stamp beats no stamp. Every write path of this build stamps what it
 * changes, so an unstamped setting is one nobody has changed since this build
 * arrived, or one an older build wrote. The second case is the risk: a change
 * made later on an older build loses to an earlier change stamped here.
 * With no stamp on either side, or an exact tie, the other side wins — on a
 * pull that is the download, as every pull always has been.
 *
 * @param {*} localStamp - This side's stamp for the setting
 * @param {*} incomingStamp - The other side's stamp for it
 * @returns {boolean} True when this side's value is kept
 */
export function localStampWins(localStamp, incomingStamp) {
    const local = readStamp(localStamp);
    const incoming = readStamp(incomingStamp);
    if (!local) return false;
    if (!incoming) return true;
    if (local.at !== incoming.at) return local.at > incoming.at;
    if (local.seq !== null && incoming.seq !== null) return local.seq > incoming.seq;
    return false;
}

/**
 * The payload's `externalKeys` field: the key prefixes other scripts have
 * registered with this sync (see "Keys another script opts in" in
 * `sync-ownership.js`), with the removals that stop a withdrawn prefix being
 * taught back, owners and prefixes sorted. Omitted entirely when nothing was
 * ever registered, so a payload from a device where no other script ever
 * registered is the same text it always was.
 *
 * A top-level field rather than a key in a store: it is not a record to land on
 * disk but a fact about the payload, which every reader learns before it
 * decides what in the payload is carried. `importEverything` and every older
 * build ignore a field they do not know.
 *
 * @returns {string} The field and its trailing comma, or '' when nothing is registered
 */
function externalKeysField(registry = externalKeyRecord()) {
    return Object.keys(registry).length > 0 ? `"externalKeys":${JSON.stringify(registry)},` : '';
}

/**
 * Whether `applyPayload` and `mergeForUpload` would accept this payload: the
 * same refusal ({@link assertApplicable}), asked of the stores this script
 * syncs — the others are dropped before either of them checks.
 * @param {*} payload - Parsed payload
 * @returns {boolean} True when the payload would be applied or merged
 */
function isApplicable(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    const stores = payload.stores;
    if (!stores || typeof stores !== 'object' || Array.isArray(stores)) return false;
    const ours = Object.fromEntries(Object.entries(stores).filter(([name]) => isSyncedStore(name)));
    try {
        assertApplicable({ ...payload, stores: ours });
        return true;
    } catch {
        return false;
    }
}

/**
 * Learn the prefixes a payload says other scripts registered, before anything
 * reads ownership off it. Only from a payload this build would apply or merge
 * whole — a damaged or newer-format one is refused there, and a registry it
 * carries is not a fact to take from it either: the pressed Push that learned
 * one would upload this device's keys under it.
 * @param {*} payload - Parsed payload
 * @returns {boolean} Whether the registry changed
 */
function learnPayloadExternalKeys(payload) {
    if (!isApplicable(payload)) return false;
    return learnExternalKeyPrefixes(payload.externalKeys);
}

/**
 * Learn the registry a payload's text carries.
 *
 * For a caller about to act on this device's payload against a download — a
 * pressed Push, a merged upload — that has to know first whether the download
 * named prefixes this device did not, and rebuild its own payload if so. The
 * whole text is parsed and checked, not only the field: a damaged payload with
 * a readable header must teach nothing.
 *
 * @param {string} text - Payload text
 * @returns {boolean} Whether the registry changed
 */
export function learnExternalKeysFromText(text) {
    if (typeof text !== 'string') return false;
    let payload;
    try {
        payload = JSON.parse(text);
    } catch {
        return false;
    }
    return learnPayloadExternalKeys(payload);
}

/**
 * Refuse to go on when the registry this device holds — including anything a
 * download just taught it — is not saved. A pull that applied keys under a
 * prefix it then forgot on reload, or a push that uploaded them, leaves the
 * next push from this device dropping them and their prefix from the gist.
 * Raised like {@link requireExternalKeys}, so the sync reports it and retries.
 * @returns {Promise<void>}
 * @throws {GistError} With kind 'storage' when the registry could not be saved
 */
export async function assertExternalKeysSaved() {
    if (await ensureExternalKeysSaved()) return;
    throw new GistError(
        'storage',
        'This device could not save the key prefixes other scripts registered, so nothing was synced. Try ' +
            'again; reload the page if it keeps happening.'
    );
}

/**
 * Load this device's remembered registry, or refuse to go on without it.
 *
 * A payload built or applied without it would leave out the other scripts'
 * keys it carries — an upload that erases them from the gist, a pull that
 * drops them from the download. Raised as a GistError so the sync reports it
 * the way it reports any failure it can say something about, and the next
 * sync tries again. See {@link assertExternalKeysSaved} for the other half:
 * what a download taught it must be saved before the sync acts on it.
 *
 * @returns {Promise<void>}
 * @throws {GistError} With kind 'storage' when the record could not be read
 */
async function requireExternalKeys() {
    if (await ensureExternalKeysLoaded()) return;
    throw new GistError(
        'storage',
        "This device's sync records could not be read, so nothing was synced. Try again; reload the page if " +
            'it keeps happening.'
    );
}

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

        // A map's change stamps travel with it, minus the stamps of the
        // settings that do not: when the token was last changed is no business
        // of the gist's, and the merge ignores those ids anyway
        if (key.startsWith(SETTING_STAMPS_PREFIX)) {
            const stamps = readStamps(value);
            if (!stamps) continue;
            for (const settingId of LOCAL_ONLY_SETTING_IDS) delete stamps[settingId];
            safe[key] = stamps;
            continue;
        }

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
                // An unreadable settings map cannot be proven credential-free.
                // Leave it out of the remote payload rather than risk copying a
                // token or passphrase into the gist.
                continue;
            }
        }

        if (!map || typeof map !== 'object' || Array.isArray(map)) {
            // A settings map is always a keyed object. Anything else cannot be
            // inspected using the setting IDs below and therefore fails closed.
            continue;
        }

        const cleaned = { ...map };
        for (const settingId of LOCAL_ONLY_SETTING_IDS) delete cleaned[settingId];
        safe[key] = wasString ? JSON.stringify(cleaned) : cleaned;
    }

    return safe;
}

// Last "left out" summary logged, so an unchanged one is not repeated per build
let lastLeftOutSummary = null;

/** Test-only: forget the last logged "left out" summary. */
export function resetLeftOutLogForTests() {
    lastLeftOutSummary = null;
}

/**
 * Build the JSON text to upload.
 *
 * The stores come from `sync-ownership.js`, not from `listStores()`. The
 * database is shared with other userscripts: walking it uploaded their object
 * stores along with ours and wrote them back on every pull. Inside the stores
 * that are shared key-by-key, the keys are filtered the same way and for the
 * same reason.
 *
 * What was left behind is logged as a count and a byte total, and deliberately
 * no more than that — it is the number that says whether the foreign share is
 * growing, and naming another script's keys in a log line would publish what
 * that script stores.
 *
 * @param {'settings'|'everything'} scope - How much to carry
 * @returns {Promise<string>} Payload text, in full-backup format
 */
export async function buildPayloadJSON(scope = 'settings') {
    // Before ownership is read: a prefix another script registered on an
    // earlier page load counts from the first exchange of this one
    await requireExternalKeys();
    // A registry change this device could not save would be published, then
    // undone by a reload, and the next push would erase it from the gist
    await assertExternalKeysSaved();
    const allStores = await storage.listStores();
    const ours = allStores.filter(isSyncedStore);
    const storeNames = scope === 'everything' ? ours : ours.filter((name) => name === SETTINGS_STORE);
    // One view of ownership for the whole build. The stores are read one at a
    // time, and a registration landing between two reads must not leave the
    // field naming one registry and the stores carrying another's keys
    const ownership = ownershipSnapshot();

    const parts = [
        `{"formatVersion":${FORMAT_VERSION},`,
        `"exportedAt":${JSON.stringify(new Date().toISOString())},`,
        `"syncScope":${JSON.stringify(scope)},`,
        externalKeysField(ownership.record),
        '"stores":{',
    ];

    let first = true;
    let foreignKeys = 0;
    let foreignBytes = 0;
    for (const storeName of storeNames) {
        const entries = stripExcludedKeys(storeName, await storage.getAll(storeName));
        const partition = partitionOwnedKeys(storeName, entries, ownership.owns);
        foreignKeys += partition.foreignKeys;
        foreignBytes += partition.foreignBytes;
        const safe = storeName === SETTINGS_STORE ? redactSettingsStore(partition.owned) : partition.owned;
        parts.push(`${first ? '' : ','}${JSON.stringify(storeName)}:${JSON.stringify(safe)}`);
        first = false;
    }

    const skippedStores = scope === 'everything' ? allStores.length - ours.length : 0;
    if (foreignKeys > 0 || skippedStores > 0) {
        // Every payload build reaches here; say it once per distinct summary
        const summary = `${foreignKeys}|${Math.round(foreignBytes / 1024)}|${skippedStores}`;
        if (summary !== lastLeftOutSummary) {
            lastLeftOutSummary = summary;
            console.info(
                `[Sync] Left out of the payload: ${foreignKeys} key(s) in shared stores (~${Math.round(foreignBytes / 1024)} KB)` +
                    `${skippedStores > 0 ? ` and ${skippedStores} store(s) this script does not own` : ''}.`
            );
        }
    } else {
        // Nothing left out now, so the next omission is news again
        lastLeftOutSummary = null;
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
                entries[key] = registration.mergeForPull(probed.value, entries[key]);
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
 * Settings maps are folded per setting. A pull someone asked for keeps the
 * rule it always had — the download wins every setting it names — while the
 * automatic paths pass `{mode: 'merge'}`, where the newer change wins by its
 * stamp ({@link localStampWins}). Either way each map's stamps record is
 * rewritten to match the values that were kept, so it stays true of them.
 *
 * In `merge` mode a whole-value key (no registered merge, not a settings map)
 * keeps this device's value when the download's value is the one this device
 * last exchanged and this device's has moved since — see {@link wholeKeyHashes}
 * for the baseline. Otherwise, and always outside `merge` mode, the download
 * is written as before.
 *
 * @param {string} json - Payload text as produced by `buildPayloadJSON()`
 * @param {{mode?: 'pull'|'merge', baseline?: Record<string, string>|null}} [options] - How settings both
 *   sides set are decided, and this device's per-key hashes of the last exchange
 * @returns {Promise<{restored: Record<string, number>, expected: Record<string, number>,
 *   failed: Array<Object>, complete: boolean, merged: Array<Object>, mergeFailed: Array<Object>,
 *   mergeHeld: Array<Object>, exportedAt: string|null, applied: string}>}
 *   What landed, how many keys each store was asked for (the figure the pull summary
 *   subtracts the folds from), whether all of it did, which records could not be
 *   combined, which were held back because this device's copy could not be read, and
 *   the payload text as actually applied
 */
export async function applyPayload(json, { mode = 'pull', baseline = null } = {}) {
    const payload = JSON.parse(json);
    // Before anything is dropped as unowned: keys another script registered,
    // on this device on an earlier load or on another device, are carried
    await requireExternalKeys();
    // ...and saved before anything lands: a key applied under a prefix this
    // device then forgets on reload is one its next push drops from the gist
    learnPayloadExternalKeys(payload);
    await assertExternalKeysSaved();
    // After the foreign stores are dropped: what another script keeps in a
    // gist written by an older build is not this pull's to judge
    const droppedUnowned = dropUnownedFromPayload(payload);
    assertApplicable(payload);
    const settingsStore = payload?.stores?.[SETTINGS_STORE];

    // Land the debounce queue before ANY local reads, including the settings
    // preserved below. Both getAll and tryGet read IndexedDB, so preserving a
    // token or a recent setting before this flush would write its old value
    // back over the queued edit, just like merging a history from a stale base.
    /** This device's key-migration records, as they were before the pull forgot any */
    let migrationRecords = null;
    try {
        await storage.beginRestore?.();

        if (settingsStore) {
            const local = await storage.getAll(SETTINGS_STORE);
            for (const [key, incoming] of Object.entries(settingsStore)) {
                if (!key.startsWith('script_settingsMap')) continue;
                const stampKey = `${SETTING_STAMPS_PREFIX}${key}`;
                const folded = foldSettingsMap(
                    local[key],
                    incoming,
                    readStamps(local[stampKey]),
                    readStamps(settingsStore[stampKey]),
                    mode === 'merge'
                );
                settingsStore[key] = folded.value;
                if (folded.stamps) settingsStore[stampKey] = folded.stamps;
                else delete settingsStore[stampKey];
            }
            // Stamps describe the map they sit beside. A payload carrying stamps
            // for a map it does not carry has nothing to say about this one's
            for (const key of Object.keys(settingsStore)) {
                if (!key.startsWith(SETTING_STAMPS_PREFIX)) continue;
                if (!Object.hasOwn(settingsStore, key.slice(SETTING_STAMPS_PREFIX.length))) delete settingsStore[key];
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
            migrationRecords = Object.fromEntries(
                Object.entries(local || {}).filter(([key]) => key.startsWith(MIGRATION_RECORD_PREFIX))
            );
            // A map that comes down exactly as this device holds it does not
            // land (see `dropUnchangedKeys`), so its record still matches it
            const landing = Object.keys(settingsStore).filter(
                (key) =>
                    !key.startsWith('script_settingsMap') ||
                    !Object.hasOwn(local || {}, key) ||
                    stableStringify(local[key]) !== stableStringify(settingsStore[key])
            );
            await settingsStorage.reconcileKeyMigrationState(landing);
        }

        const histories = await mergeLocalHistories(payload);
        const mergeHeld = histories.held;
        // One store read at a time, each let go before the next: what this
        // device moved since the last exchange is kept (merge mode), and what it
        // already holds is noted, to be left out once `applied` is taken below
        const sameByStore = await weighAgainstLocal(payload, mode === 'merge' ? baseline : null);

        // What is remembered as "the state of this device" has to be what was
        // actually written. `mergeLocalHistories` (and the settings fix-ups
        // above) mutate the payload, so the downloaded text no longer describes
        // what landed — hashing it made every later rebuild compare unequal,
        // which read as "this device has changed" and raised a conflict on
        // every silent pull until an auto-push happened to reset it.
        // Re-serialising only when something was rewritten keeps the common
        // no-op pull free.
        const rewrote = histories.merged.length > 0 || mergeHeld.length > 0 || droppedUnowned || Boolean(settingsStore);
        const applied = rewrote ? JSON.stringify(payload) : json;

        // After `applied`, which describes the data as it now stands here: a
        // key left out below already holds its value
        const { unchanged, unchangedKeys } = dropUnchangedKeys(payload, sameByStore);
        const changed = (entry) => !unchangedKeys.has(baselineId(entry.store, entry.key));
        const merged = histories.merged.filter(changed);
        const mergeFailed = histories.failed.filter(changed);

        let imported;
        try {
            imported = await importEverything(payload);
        } catch (error) {
            await restoreMigrationRecords(migrationRecords);
            throw error;
        }
        const { restored, expected, failed, complete } = imported;
        // The records were forgotten because the maps were about to land. A
        // settings store that did not land kept its old maps, which still match
        // the old records — one aborted transaction takes every key with it
        if ((failed || []).some((entry) => entry.store === SETTINGS_STORE)) {
            await restoreMigrationRecords(migrationRecords);
        }
        return {
            restored,
            expected,
            failed,
            complete,
            merged,
            mergeFailed,
            mergeHeld,
            unchanged,
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
 * Where `core/settings-storage.js` keeps the key-migration records — the
 * per-map `settings_key_migrations_applied_<map>` and the legacy
 * `settings_key_migrations_v1`/`_v2` flags all share it.
 */
const MIGRATION_RECORD_PREFIX = 'settings_key_migrations_';

/**
 * Put back the key-migration records a pull forgot, when the settings maps
 * they were forgotten for did not land.
 *
 * Written down the bulk path with `bypassRestoreLatch`, because a restore may
 * already have latched the settings store. A failure here is logged, not
 * thrown: the pull has already failed, and its own error is the one to report.
 *
 * @param {Record<string, *>|null} records - The records as they were, or null when none were touched
 * @returns {Promise<boolean>} Whether every record is back
 */
async function restoreMigrationRecords(records) {
    const wanted = records ? Object.keys(records).length : 0;
    if (wanted === 0) return true;
    // putAll reports a failed transaction as a short count, not a throw; one retry covers a
    // transient abort, and a second short write is said plainly because the next load would
    // re-run those migrations over the player's settings
    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const written = await storage.putAll(SETTINGS_STORE, records, { bypassRestoreLatch: true });
            if (written === wanted) return true;
        } catch (error) {
            console.error('[Sync] Could not put the settings migration records back after a failed pull:', error);
        }
    }
    console.error(
        '[Sync] The settings migration records could not be restored after a failed pull; the next load may ' +
            're-run settings migrations. Keys:',
        Object.keys(records)
    );
    return false;
}

/**
 * Refuse a payload `importEverything` would refuse, before anything is written.
 *
 * `importEverything` validates the format and every store's shape before its
 * first write — but `applyPayload` writes before it gets there: it forgets the
 * key-migration record of every settings map the payload carries
 * (`reconcileKeyMigrationState`), on the understanding that those maps are
 * about to land. A payload the import then rejects — a newer build's
 * `formatVersion`, a store that is not a keyed object — left the local maps
 * where they were with their records gone, and the next load replayed the
 * reconciling migrations over choices the player had since made by hand.
 *
 * @param {*} payload - Parsed payload text
 * @returns {void}
 * @throws {Error} When the payload is not one this build can apply
 */
function assertApplicable(payload) {
    if (!payload || typeof payload !== 'object' || payload.formatVersion !== FORMAT_VERSION) {
        throw new GistError(
            'parse',
            `The sync gist holds data in format ${payload?.formatVersion ?? 'none'}; this build reads ` +
                `${FORMAT_VERSION}. Update Toolasha on this device, or push from one whose data is good.`
        );
    }
    const isRecordMap = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!isRecordMap(payload.stores)) throw new GistError('parse', 'The downloaded payload has no stores to apply.');
    for (const [storeName, entries] of Object.entries(payload.stores)) {
        if (!isRecordMap(entries)) {
            throw new GistError('parse', `The downloaded payload's ${storeName} store is not a keyed object.`);
        }
    }
}

/**
 * Remove anything the incoming payload carries that is not Toolasha's.
 *
 * Gists written before the ownership registry existed hold another script's
 * whole object stores and its keys inside `settings`, and older builds will go
 * on writing such payloads for as long as they are installed — so a pull has to
 * cope with them, not merely stop producing them.
 *
 * Removed from the payload, never deleted from storage. `importEverything`
 * writes the keys a payload names and touches nothing else, so a key dropped
 * here keeps whatever value this device already had, which is the only correct
 * answer for a record this script does not own. Deleting them would be this
 * script reaching into another's data on the strength of a download.
 *
 * @param {{stores?: Record<string, Record<string, *>>}} payload - Parsed payload, mutated in place
 * @returns {boolean} Whether anything was removed, so the caller knows the text
 *   it downloaded no longer describes what it is about to apply
 */
function dropUnownedFromPayload(payload) {
    const stores = payload?.stores;
    if (!stores || typeof stores !== 'object') return false;

    let dropped = false;
    for (const storeName of Object.keys(stores)) {
        if (!isSyncedStore(storeName)) {
            delete stores[storeName];
            dropped = true;
            continue;
        }
        const entries = stores[storeName];
        // A store this script owns in the wrong shape is left as it came, for
        // assertApplicable to refuse: filtering an array's indices as foreign keys
        // would turn it into an empty map that passes and applies nothing
        if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
        const { owned } = partitionOwnedKeys(storeName, entries);
        if (owned !== entries) {
            stores[storeName] = owned;
            dropped = true;
        }
    }
    return dropped;
}

/**
 * Fold an incoming settings map onto this device's, entry by entry, and the
 * two stamps records with it.
 *
 * A settings map is a per-setting structure, not one record: taking the
 * incoming map whole meant every setting the *local* map had and the incoming
 * one did not was erased. That is not "the remote's choice wins" — the remote
 * expressed no choice. It happens whenever the two devices are on different
 * builds (the newer one's settings are simply absent from the older one's
 * saved map, which is written whole from whatever schema wrote it), and the
 * erased entries came back as shipped defaults on the next load, so settings
 * the player had turned off turned themselves back on after a pull. So the
 * entries the payload says nothing about are always kept.
 *
 * A setting both sides have goes to the download on a pull someone asked for —
 * the whole of what the conflict dialog promises about settings — and to the
 * newer change on an automatic one (`byStamp`, see {@link localStampWins}).
 * Each kept value keeps its own side's stamp, so the record stays a true
 * account of where every value came from and when.
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
 * @param {Record<string, *>|null} localStamps - This device's stamps for the map
 * @param {Record<string, *>|null} incomingStamps - The payload's stamps for it
 * @param {boolean} byStamp - Decide a setting both sides have by its stamps rather than for the download
 * @returns {{value: *, stamps: Record<string, *>|null}} The merged map, in whatever form the incoming value
 *   used, and the stamps of the values kept (null when neither side had any)
 */
function foldSettingsMap(localValue, incomingValue, localStamps, incomingStamps, byStamp) {
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
    const parsedLocal = parse(localValue);
    const local = parsedLocal && typeof parsedLocal === 'object' ? parsedLocal : null;
    if (!incoming || typeof incoming !== 'object') return { value: incomingValue, stamps: localStamps };

    const merged = local ? { ...local, ...incoming } : { ...incoming };
    const stamps = {};
    for (const settingId of Object.keys(merged)) {
        const inLocal = Boolean(local) && Object.hasOwn(local, settingId);
        const inIncoming = Object.hasOwn(incoming, settingId);
        const keepLocal =
            inLocal &&
            (!inIncoming || (byStamp && localStampWins(localStamps?.[settingId], incomingStamps?.[settingId])));
        const from = keepLocal ? localStamps : incomingStamps;
        if (keepLocal) merged[settingId] = local[settingId];
        if (from?.[settingId] !== undefined) stamps[settingId] = from[settingId];
        else delete stamps[settingId];
    }
    for (const settingId of LOCAL_ONLY_SETTING_IDS) {
        delete stamps[settingId];
        if (local && local[settingId] !== undefined) {
            merged[settingId] = local[settingId];
        } else {
            delete merged[settingId];
        }
    }

    const hadStamps = Boolean(localStamps || incomingStamps);
    return { value: wasString ? JSON.stringify(merged) : merged, stamps: hadStamps ? stamps : null };
}

/**
 * Handed to a registered merge as its third argument when the fold builds an
 * upload rather than a local apply.
 *
 * A merge may cap what it keeps by this device's own settings (the labyrinth
 * room log keeps the player's chosen number of sessions). That is right for
 * local storage and wrong for the gist: a device set to keep 20 would upload
 * 20 and delete the other device's 480 from the gist. A merge that caps by
 * live local config skips the cap when it sees `forUpload`; a merge with a
 * build-wide constant cap folds the same on every device and needs nothing.
 */
const UPLOAD_CONTEXT = Object.freeze({ forUpload: true });

/**
 * Whether a key is written whole by sync — neither a settings map (merged per
 * setting), nor a settings map's stamps, nor a key with a registered merge.
 * @param {string} storeName - Object store
 * @param {string} key - Storage key
 * @returns {boolean} True for a whole-value key
 */
function isWholeKey(storeName, key) {
    return !isSettingsMapKey(storeName, key) && !mergeForKey(storeName, key);
}

/**
 * Whether a key is a settings map or a map's stamps — the keys merged per
 * setting, and the only ones the baseline does not cover.
 * @param {string} storeName - Object store
 * @param {string} key - Storage key
 * @returns {boolean} True for a settings map or its stamps
 */
function isSettingsMapKey(storeName, key) {
    return (
        storeName === SETTINGS_STORE && (key.startsWith('script_settingsMap') || key.startsWith(SETTING_STAMPS_PREFIX))
    );
}

/** One whole-value key's baseline id: store and key, joined by a character neither can hold */
const baselineId = (storeName, key) => `${storeName}\u0000${key}`;

/** A value's fingerprint for the baseline, the same whatever order its object keys were written in */
const valueHash = (value) => hashPayload(stableStringify(value));

/**
 * Fingerprint every key in a payload but the settings maps: the baseline a
 * later merge compares against.
 *
 * "Which side changed it?" has to be asked of a common ancestor, and this is a
 * cheap one: after every exchange, each key's hash as it then stood. A key
 * whose current value still hashes to its baseline has not moved on that side
 * since; the side that did move it wins. With no baseline, or both sides
 * moved, a whole-value key keeps the gist's value, because that is what a
 * pull always did, and a key with a registered merge is folded with the gist
 * as the side that wins what the fold cannot combine.
 *
 * Stored device-local (`toolasha_sync_baseline`), never uploaded.
 *
 * @param {string} text - Payload text
 * @returns {Record<string, string>} Hash by `store\u0000key`
 */
export function wholeKeyHashes(text) {
    const hashes = {};
    let stores;
    try {
        stores = JSON.parse(text)?.stores || {};
    } catch {
        return hashes;
    }
    for (const [storeName, entries] of Object.entries(stores)) {
        if (!entries || typeof entries !== 'object') continue;
        for (const [key, value] of Object.entries(entries)) {
            if (!isSettingsMapKey(storeName, key)) hashes[baselineId(storeName, key)] = valueHash(value);
        }
    }
    return hashes;
}

/**
 * Which of two values of one whole-value key to keep.
 * @param {string} id - Its baseline id
 * @param {*} mine - This side's value
 * @param {*} theirs - The other side's value (the gist's, or the download)
 * @param {Record<string, string>|null} baseline - Hashes at the last exchange
 * @returns {boolean} True to keep `mine`
 */
function keepMine(id, mine, theirs, baseline, { allowRestored = false, storeName = null, key = null } = {}) {
    // A full-backup restore made the keys it wrote a choice made now, whatever
    // the last exchange was (see RESTORED_BASELINE) — those keys, and no others
    if (allowRestored && restoredKey(baseline?.[RESTORED_BASELINE], storeName, key)) {
        return valueHash(mine) !== valueHash(theirs);
    }
    const was = readBaselineEntry(baseline?.[id]);
    if (!was) return false;
    // The gist's side unmoved since the exchange, and this side moved since
    return valueHash(theirs) === was.gist && valueHash(mine) !== was.local;
}

/** Each restore marker's key lists as sets, built once per marker */
const restoredKeySets = new WeakMap();

/**
 * Whether a restore wrote this key.
 *
 * Only a key the backup actually held counts. A store the restore landed can
 * still hold keys the backup never had — created after it was taken — and
 * those were left exactly as they were, so they are no more this device's
 * choice than before the restore; a merge must weigh them as usual.
 *
 * A marker from before restores were recorded per key (a bare time, or
 * `{at, stores}`) cannot say which keys were written, so it counts for none.
 *
 * @param {*} marker - The baseline's RESTORED_BASELINE entry: `{at, keys: {store: [key]}}`
 * @param {string|null} storeName - The key's store
 * @param {string|null} key - The key
 * @returns {boolean} True when the restore wrote that key
 */
function restoredKey(marker, storeName, key) {
    if (!marker || typeof marker !== 'object' || !marker.keys || typeof marker.keys !== 'object') return false;
    let sets = restoredKeySets.get(marker);
    if (!sets) {
        sets = new Map();
        for (const [store, keys] of Object.entries(marker.keys)) {
            if (Array.isArray(keys)) sets.set(store, new Set(keys));
        }
        restoredKeySets.set(marker, sets);
    }
    return Boolean(sets.get(storeName)?.has(key));
}

/**
 * One key's baseline entry as its two halves: what the gist held after the
 * exchange, and what this device held. They are one hash — stored as a plain
 * string — after every exchange but a merged upload, where the gist can take
 * a value this device has not applied yet.
 * @param {*} entry - A stored entry
 * @returns {{gist: string, local: string|null}|null} The halves, or null when there is none
 */
function readBaselineEntry(entry) {
    if (typeof entry === 'string' && entry) return { gist: entry, local: entry };
    if (entry && typeof entry === 'object' && typeof entry.gist === 'string') {
        return { gist: entry.gist, local: typeof entry.local === 'string' ? entry.local : null };
    }
    return null;
}

/**
 * The baseline a merged upload leaves: per key, what the gist now holds (the
 * merge's winner) beside what this device holds.
 *
 * Both halves are needed, and for opposite questions. "Did this device change
 * the key since?" is asked of its own value: recording only the uploaded
 * winner made a key the gist won look locally edited at the next startup
 * pull, which then kept the stale local value. "Did the gist change it
 * since?" is asked of the gist's value: recording only the local value made
 * a key the gist won look moved on the gist's side forever, so an edit made
 * here after the merge lost to it at the next push.
 *
 * @param {string} uploadedText - The merged payload that went up
 * @param {string} localText - This device's payload it was built from
 * @returns {Record<string, string|{gist: string, local: string|null}>} The baseline
 */
export function exchangeBaseline(uploadedText, localText) {
    const gist = wholeKeyHashes(uploadedText);
    const local = wholeKeyHashes(localText);
    const baseline = {};
    for (const [id, hash] of Object.entries(gist)) {
        baseline[id] = local[id] === hash ? hash : { gist: hash, local: local[id] ?? null };
    }
    return baseline;
}

/**
 * Whether a plain push of this device's payload could drop history the gist
 * holds: a key with a registered merge whose value here is no longer the one
 * the gist held at the last exchange (or that this device no longer has).
 *
 * A plain push replaces the gist with this device's copy, and a registered
 * history here can be trimmed to this device's own retention — a device
 * keeping 20 sessions, after a startup pull of a gist holding 500, would
 * upload its 20. Only a value still hashing to the gist side of the baseline
 * proves the gist holds nothing this copy lacks; a hash cannot tell an
 * addition from a trim, so any other value counts. A key the baseline does
 * not list was not in the gist at the last exchange, so it cannot drop
 * anything there; a store the payload does not carry at all is one this
 * device's scope does not sync. With no baseline, any registered key counts.
 *
 * @param {string} localText - This device's payload, as `buildPayloadJSON` built it
 * @param {Record<string, string|{gist: string, local: string|null}>|null} baseline - Hashes at the last exchange
 * @returns {boolean} True when the push should merge the gist into its upload first
 */
export function registeredKeysDiverge(localText, baseline) {
    let stores;
    try {
        stores = JSON.parse(localText)?.stores || {};
    } catch {
        return false;
    }
    const hasBaseline = Boolean(baseline && typeof baseline === 'object');
    for (const [storeName, entries] of Object.entries(stores)) {
        if (!entries || typeof entries !== 'object') continue;
        for (const [key, value] of Object.entries(entries)) {
            if (!mergeForKey(storeName, key)) continue;
            if (!hasBaseline) return true;
            const was = readBaselineEntry(baseline[baselineId(storeName, key)]);
            if (was && valueHash(value) !== was.gist) return true;
        }
    }
    if (!hasBaseline) return false;
    for (const id of Object.keys(baseline)) {
        if (id === RESTORED_BASELINE) continue;
        const split = id.indexOf('\u0000');
        if (split <= 0) continue;
        const storeName = id.slice(0, split);
        const key = id.slice(split + 1);
        const entries = stores[storeName];
        if (!entries || typeof entries !== 'object' || Object.hasOwn(entries, key)) continue;
        if (mergeForKey(storeName, key) && readBaselineEntry(baseline[id])) return true;
    }
    return false;
}

/**
 * The baseline entry a full-backup restore adds: the keys it wrote, per
 * store (`{at, keys: {store: [key]}}`), each of which the next merge takes as
 * this device's newer copy, so it neither reverts the restore nor counts it
 * as unmoved. A key with a registered merge is still folded — a restore must not
 * drop entries the other device recorded. Replaced by the next exchange's
 * real baseline.
 */
export const RESTORED_BASELINE = '\u0000restoredAt';

/**
 * Stamp every setting a full-backup restore is about to land as changed now.
 *
 * A backup's stamps are as old as the backup (or absent, from an older
 * build), so the gist's newer stamps would take every setting back at the
 * next merge and silently undo the restore. Restoring is a choice made now,
 * exactly as importing a settings file is, and is stamped the same way.
 *
 * @param {{stores?: Object}} payload - The backup, mutated in place
 * @param {number} [now] - The time to stamp
 * @returns {void}
 */
export function restampRestoredSettings(payload, now = Date.now()) {
    const settings = payload?.stores?.[SETTINGS_STORE];
    if (!settings || typeof settings !== 'object') return;
    for (const [key, value] of Object.entries(settings)) {
        if (!key.startsWith('script_settingsMap')) continue;
        let map = value;
        if (typeof value === 'string') {
            try {
                map = JSON.parse(value);
            } catch {
                continue;
            }
        }
        if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
        const stamps = {};
        for (const settingId of Object.keys(map)) {
            if (!LOCAL_ONLY_SETTING_IDS.includes(settingId)) stamps[settingId] = { at: now, seq: null };
        }
        settings[`${SETTING_STAMPS_PREFIX}${key}`] = stamps;
    }
}

/**
 * Weigh a download against this device's stores, one store read at a time, so
 * no more than one store's local copy is held at once.
 *
 * With a baseline — the startup pull's half of the whole-value rule — each key
 * this device moved since the last exchange while the gist's copy did not is
 * dropped from the download, so the import leaves this device's newer value
 * where it is.
 *
 * Then each remaining key this device already holds with the same value is
 * noted (compared with object keys sorted, as `addsToRemote` compares), for
 * {@link dropUnchangedKeys} to leave out. A record and its tombstones are kept
 * together whenever either moved (see `tombstoneCompanionKey`), so the restore
 * still reconciles the pair. A store that cannot be read is noted as having
 * nothing the same: an import that writes an identical value is the old
 * behavior, never a loss.
 *
 * @param {Object} payload - Parsed payload, after every fold; mutated in place by the baseline rule
 * @param {Record<string, string>|null} baseline - Hashes at the last exchange, or null outside merge mode
 * @returns {Promise<Map<string, Set<string>>>} Per store, the keys that hold this device's value already
 */
async function weighAgainstLocal(payload, baseline) {
    const sameByStore = new Map();
    for (const [storeName, entries] of Object.entries(payload?.stores || {})) {
        if (!entries || typeof entries !== 'object') continue;
        // Before the baseline rule removes any: a companion it kept as this
        // device's is not one the download lacked
        const carried = new Set(Object.keys(entries));
        let local;
        try {
            local = await storage.getAll(storeName);
        } catch (error) {
            // The baseline rule always needed this read; only the comparison is optional
            if (baseline) throw error;
            console.warn(`[Sync] Could not read ${storeName} to compare; writing all of it:`, error);
            continue;
        }
        if (baseline) {
            for (const key of Object.keys(entries)) {
                if (!isWholeKey(storeName, key) || !Object.hasOwn(local || {}, key)) continue;
                if (
                    keepMine(baselineId(storeName, key), local[key], entries[key], baseline, {
                        allowRestored: true,
                        storeName,
                        key,
                    })
                ) {
                    delete entries[key];
                }
            }
        }
        if (!local || typeof local !== 'object' || Array.isArray(entries)) continue;
        const same = new Set(
            Object.keys(entries).filter(
                (key) => Object.hasOwn(local, key) && stableStringify(local[key]) === stableStringify(entries[key])
            )
        );
        for (const key of Object.keys(entries)) {
            const companion = tombstoneCompanionKey(storeName, key);
            if (!companion) continue;
            if (!same.has(key)) {
                same.delete(companion);
            } else if (
                tombstoneCompanionKey(storeName, key, { recordOnly: true }) &&
                !carried.has(companion) &&
                !addedSinceExchange(baseline, storeName, companion) &&
                hidesAny(local[companion], entries[key])
            ) {
                // The download carries no tombstones for this record, and this
                // device's would hide some of it: the restore has to see the
                // record to clear them
                same.delete(key);
            }
        }
        if (same.size > 0) sameByStore.set(storeName, same);
    }
    return sameByStore;
}

/**
 * Whether a key this device holds is one it created after the last exchange: a
 * merge has a baseline, and the key is not in it. Such tombstones are this
 * device's newer deletions, not ones the gist dropped.
 * @param {Record<string, *>|null} baseline - Hashes at the last exchange, or null outside merge mode
 * @param {string} storeName - Object store
 * @param {string} key - Storage key
 * @returns {boolean} True when the key is newer than the last exchange
 */
function addedSinceExchange(baseline, storeName, key) {
    return Boolean(baseline) && !Object.hasOwn(baseline, baselineId(storeName, key));
}

/**
 * Whether a tombstones map names any id the record holds.
 * @param {*} graves - Tombstones, `{id: at}`
 * @param {*} record - The record, `{id: value}`
 * @returns {boolean} True when some id is in both
 */
function hidesAny(graves, record) {
    if (!graves || typeof graves !== 'object' || !record || typeof record !== 'object') return false;
    return Object.keys(graves).some((id) => Object.hasOwn(record, id));
}

/**
 * Leave out of an import every key {@link weighAgainstLocal} found this device
 * already holds, so a pull writes — and latches until the reload — only what it
 * changes. A pull of what this device already has then writes nothing and asks
 * for no reload.
 *
 * @param {Object} payload - Parsed payload; its stores are mutated in place
 * @param {Map<string, Set<string>>} sameByStore - Per store, the keys to leave out
 * @returns {{unchanged: Record<string, number>, unchangedKeys: Set<string>}} Per store, how many keys were
 *   left out; and those keys, as `baselineId`s
 */
function dropUnchangedKeys(payload, sameByStore) {
    const unchanged = {};
    const unchangedKeys = new Set();
    for (const [storeName, same] of sameByStore) {
        const entries = payload.stores[storeName];
        for (const key of same) {
            delete entries[key];
            unchangedKeys.add(baselineId(storeName, key));
        }
        unchanged[storeName] = same.size;
    }
    return { unchanged, unchangedKeys };
}

/**
 * Whether cleaning one of the gist's stores took anything out of it.
 *
 * A key gone is a removal. So is a settings map or stamps record that came out
 * different: the redaction drops device-local entries from inside them. Those
 * are compared as data, since a map stored as text is re-serialized whether or
 * not anything left it.
 *
 * @param {Record<string, *>} entries - The store as the gist holds it
 * @param {Record<string, *>} cleaned - The same store after cleaning
 * @returns {boolean} True when the gist holds something the cleaned copy does not
 */
function cleaningRemoved(entries, cleaned) {
    if (cleaned === entries) return false;
    if (Object.keys(cleaned).length !== Object.keys(entries || {}).length) return true;
    const asData = (value) => {
        if (typeof value !== 'string') return value;
        try {
            return JSON.parse(value);
        } catch {
            return value;
        }
    };
    for (const [key, value] of Object.entries(cleaned)) {
        if (value === entries[key]) continue;
        if (stableStringify(asData(value)) !== stableStringify(asData(entries[key]))) return true;
    }
    return false;
}

/**
 * Fold the gist's payload into this device's, in memory, for an automatic push
 * that found the gist ahead of it.
 *
 * Nothing local is written. Applying a payload latches every store it touches
 * until the page reloads (`storage.finishRestore`) and asks for that reload on
 * screen, which is right for a pull and wrong every fifteen minutes on two
 * devices that are both in use. So the union is built here and uploaded; this
 * device takes the other device's changes at its next startup pull.
 *
 * Per key:
 * - settings maps per setting, the later change winning ({@link localStampWins}), each kept value with its
 *   stamp;
 * - a key with a registered merge always folded with it, never taken whole (this device's copy may be trimmed
 *   to its own retention): this device as the base and the gist as the incoming side, so what the fold cannot
 *   combine goes to the gist — every pull folds the same way round, which is what lets two devices settle —
 *   except when the gist's value is still the one this device last exchanged (see {@link wholeKeyHashes}),
 *   when this device's side is the incoming one;
 * - any other key whose gist value is still the one this device last exchanged: this device's value;
 * - otherwise the gist's value;
 * - a key on one side only, kept from that side.
 *
 * The gist's copy is cleaned the way a pull cleans it first — other scripts'
 * stores and keys, excluded keys, device-local keys and settings — and refused
 * the way a pull refuses it, so a payload from a newer format is never merged
 * into something this build half understands.
 *
 * @param {string} localText - This device's payload, as `buildPayloadJSON` built it
 * @param {string} remoteText - The gist's payload, decrypted
 * A revision fold (`revisionFold`) is the other use: restoring gist revisions
 * other devices pushed, folded oldest first into the newest, with no payload of
 * this device's in it. Two of the rules above are this device's and do not
 * apply there. This device's baseline says nothing about which of two other
 * devices' revisions moved, so none is used: the later revision is always the
 * incoming side, for whole-value keys and registered folds alike. And the scope
 * is the newest revision's (`scope`), on both sides: a Settings-only newest
 * revision must not have older revisions' histories put back, nor an older
 * Settings-only one strip the newest's.
 *
 * @param {Record<string, string>|null} baseline - This device's hashes at its last exchange
 * @param {Object} [options] - Fold options
 * @param {boolean} [options.revisionFold=false] - Fold two gist revisions rather than this device over the gist
 * @param {string|null} [options.scope=null] - For a revision fold, the newest revision's sync scope
 * @returns {{text: string, remoteAdds: boolean, dropsFromRemote: boolean}} The merged payload; whether it holds
 *   anything this device does not (so its next startup pull has something to take); and whether it leaves out
 *   stores the gist holds that this device's scope does not sync (so it is worth uploading even when it adds
 *   nothing)
 * @throws {Error} When the gist's payload is not one this build can apply
 */
export function mergeForUpload(localText, remoteText, baseline, { revisionFold = false, scope = null } = {}) {
    const local = JSON.parse(localText);
    const remote = JSON.parse(remoteText);
    // Every prefix either side knows another script registered is carried, so
    // the gist's copies of those keys survive an upload from a device that has
    // never run that script (the registry is written back with the result)
    learnPayloadExternalKeys(local);
    learnPayloadExternalKeys(remote);
    const droppedUnowned = dropUnownedFromPayload(remote);
    assertApplicable(remote);
    // A revision fold weighs no baseline of this device's (see above)
    const exchanged = revisionFold ? null : baseline;
    const uploadScope = revisionFold ? (scope ?? remote.syncScope ?? 'settings') : (local?.syncScope ?? 'settings');
    if (revisionFold && uploadScope !== 'everything') {
        for (const storeName of Object.keys(local?.stores || {})) {
            if (storeName !== SETTINGS_STORE) delete local.stores[storeName];
        }
    }
    // The upload carries what this device's scope carries. A device switched
    // to "Settings only" while the gist still holds a full-scope push must not
    // keep re-uploading every history store it no longer syncs — that is the
    // size the switch was made to shed — nor hand them to its next startup.
    // The upload is then smaller than the gist although it adds nothing to it,
    // which `addsToRemote` cannot see: it asks only of what the upload holds.
    // The same goes for whatever the cleaning below takes out of a store the
    // upload keeps — another script's keys, a device-local key or a token an
    // older build uploaded — so those count too, or the gist would keep them
    let dropsFromRemote = droppedUnowned;
    if (uploadScope !== 'everything') {
        for (const storeName of Object.keys(remote.stores)) {
            if (storeName === SETTINGS_STORE) continue;
            if (Object.keys(remote.stores[storeName] || {}).length) dropsFromRemote = true;
            delete remote.stores[storeName];
        }
    }
    for (const [storeName, entries] of Object.entries(remote.stores)) {
        let cleaned = stripExcludedKeys(storeName, entries);
        if (storeName === SETTINGS_STORE) cleaned = redactSettingsStore(cleaned);
        if (!dropsFromRemote && cleaningRemoved(entries, cleaned)) dropsFromRemote = true;
        remote.stores[storeName] = cleaned;
    }

    const stores = {};
    const storeNames = new Set([...Object.keys(remote.stores), ...Object.keys(local?.stores || {})]);
    for (const storeName of storeNames) {
        const mine = local?.stores?.[storeName] || {};
        const theirs = remote.stores[storeName] || {};
        const out = { ...theirs };
        for (const [key, value] of Object.entries(mine)) {
            if (!Object.hasOwn(theirs, key)) {
                out[key] = value;
                continue;
            }
            if (storeName === SETTINGS_STORE && key.startsWith(SETTING_STAMPS_PREFIX)) continue;
            if (storeName === SETTINGS_STORE && key.startsWith('script_settingsMap')) {
                const stampKey = `${SETTING_STAMPS_PREFIX}${key}`;
                const folded = foldSettingsMap(
                    value,
                    theirs[key],
                    readStamps(mine[stampKey]),
                    readStamps(theirs[stampKey]),
                    true
                );
                out[key] = folded.value;
                if (folded.stamps) out[stampKey] = folded.stamps;
                else delete out[stampKey];
                continue;
            }
            // The gist moved nowhere since this device last exchanged it: this
            // device's copy is the newer one
            const registration = mergeForKey(storeName, key);
            const mineMoved = keepMine(baselineId(storeName, key), value, theirs[key], exchanged, {
                allowRestored: !registration,
                storeName,
                key,
            });
            // Whole, for a key with no fold. A key with one is still folded:
            // this device's copy may be trimmed to its own retention setting,
            // and taken whole it would delete from the gist history the other
            // device keeps — a device keeping 20 sessions, after a startup
            // pull of a gist holding 500, would upload its 20
            if (mineMoved && !registration) {
                out[key] = value;
                continue;
            }
            if (registration) {
                try {
                    // This device as the base and the gist as the incoming side,
                    // the way every pull folds: whatever a fold cannot combine
                    // — a sort order, a direction, a tie — goes to the gist.
                    // The other way round, each device's scalar beat the
                    // gist's on every upload, the next device's beat that,
                    // and two devices traded one setting every interval.
                    // Except when only this device moved: then its side is the
                    // incoming one, so its newer scalars win as they did when
                    // it was taken whole, and the gist's entries stay.
                    // Uncapped: a fold that trims to this device's own retention
                    // setting would upload the trimmed copy and delete, from the
                    // gist, history the other device keeps (see UPLOAD_CONTEXT)
                    out[key] = mineMoved
                        ? registration.merge(theirs[key], value, UPLOAD_CONTEXT)
                        : registration.merge(value, theirs[key], UPLOAD_CONTEXT);
                } catch (error) {
                    console.error(
                        `[Sync] Merging ${storeName}/${key} for upload failed; keeping the gist's copy:`,
                        error
                    );
                }
                continue;
            }
        }
        // Stamps for a map only this device has came across with it above;
        // stamps the gist holds for a map it alone has stay with that map
        stores[storeName] = out;
    }

    const externalKeys = externalKeyRecord();
    const text = JSON.stringify({
        formatVersion: FORMAT_VERSION,
        exportedAt: new Date().toISOString(),
        syncScope: revisionFold ? uploadScope : (local?.syncScope ?? remote.syncScope ?? 'settings'),
        // Same place and form as `buildPayloadJSON` writes it, so equal content hashes equally
        ...(Object.keys(externalKeys).length > 0 ? { externalKeys } : {}),
        stores,
    });
    // Whether applying the result here would change anything — not whether
    // the gist differs from this device, which it does even when this device
    // won every difference. That case left a note that the gist held news,
    // and the next startup imported an identical payload, latched the stores
    // and asked for a reload over nothing.
    // Asked the way a local apply would fold, retention and all: entries this
    // device's own cap would drop on arrival are not news it can take
    return { text, remoteAdds: addsToRemote(text, localText, { forUpload: false }), dropsFromRemote };
}

/**
 * Whether this device's data holds anything the gist's does not.
 *
 * The loop guard for an automatic merge: after folding the gist into this
 * device, the result is sent back up only when it would add something. Two
 * plain comparisons both loop. Hashing the text does, because two devices that
 * agree on every value still write them in different orders. So does
 * comparing values, because a union keeps its base's order: each device's
 * merge of the same two lists comes out in its own order, each reads the
 * other's as different, and they push the one list back and forth for ever.
 *
 * So the question asked is the one that matters: folded INTO the gist's copy
 * the way the other device's pull will fold it, does this device's copy change
 * anything? A key with a registered merge is folded with that merge, gist side
 * as the base; any other key is compared by value (object keys sorted). A key
 * the gist lacks is new. Keys only the gist has add nothing from here.
 *
 * A settings map's stamps are compared like any other key. A stamp that moved
 * with no value moving beside it still decides a later merge — a change back
 * to the value the gist already shows has to beat an earlier change elsewhere
 * — so it is news. The cost is one upload after each push from an older build,
 * which drops the stamps record from the gist.
 *
 * @param {string} localText - This device's payload, rebuilt after the merge
 * @param {string} remoteText - The gist's payload, as downloaded
 * @param {{forUpload?: boolean}} [options] - `forUpload` (the default) folds the way the upload does, with no
 *   retention cap; false folds the way a pull applies here, cap included — for asking whether a local apply
 *   would change anything
 * @returns {boolean} True when pushing would change what the gist holds
 */
export function addsToRemote(localText, remoteText, { forUpload = true } = {}) {
    let local;
    let remote;
    try {
        local = JSON.parse(localText)?.stores || {};
        remote = JSON.parse(remoteText)?.stores || {};
    } catch {
        return true;
    }
    for (const [storeName, entries] of Object.entries(local)) {
        const theirs = remote[storeName] && typeof remote[storeName] === 'object' ? remote[storeName] : {};
        for (const [key, value] of Object.entries(entries || {})) {
            if (!Object.hasOwn(theirs, key)) return true;
            const registration = mergeForKey(storeName, key);
            let folded = value;
            if (registration) {
                try {
                    // Folded the way the gist takes an upload, or — asked of a
                    // local apply — the way a pull here would fold it
                    folded = forUpload
                        ? registration.merge(theirs[key], value, UPLOAD_CONTEXT)
                        : registration.mergeForPull(theirs[key], value);
                } catch {
                    folded = value;
                }
            }
            if (stableStringify(folded) !== stableStringify(theirs[key])) return true;
        }
    }
    return false;
}

/**
 * Whether replacing the gist with this device's payload would cut a history this
 * device deliberately keeps shorter: a registered key whose fold caps by a device-local
 * setting (a device keeping 20 sessions against a gist holding 500). Asked of a pressed
 * Push, which overwrites by design, so the player can be told before it happens.
 *
 * A key counts only when the fold of the gist onto this device's copy comes out different
 * as an upload (no cap) than with the default, capped context. A fold with no
 * context-dependent cap never reports, whatever else differs between the copies
 * (compaction, a stale same-day row, normalization).
 *
 * @param {string} localText - This device's payload
 * @param {string} remoteText - The gist's payload, as downloaded
 * @returns {boolean} True when the gist holds history this device's copy lacks
 */
export function pushTrimsRegisteredKeys(localText, remoteText) {
    return trimmedRegisteredKeys(localText, remoteText).length > 0;
}

/**
 * Which registered keys a push replacing the gist would cut: the same test as
 * {@link pushTrimsRegisteredKeys}, naming each key so the question can say what
 * GitHub holds more of and a trace can show which key raised it.
 *
 * @param {string} localText - This device's payload
 * @param {string} remoteText - The gist's payload, as downloaded
 * @returns {Array<{store: string, key: string, label: string}>} The keys the gist holds more of, with the
 *   registration's label
 */
export function trimmedRegisteredKeys(localText, remoteText) {
    let local;
    let remote;
    try {
        local = JSON.parse(localText)?.stores || {};
        remote = JSON.parse(remoteText)?.stores || {};
    } catch {
        return [];
    }
    const trimmed = [];
    for (const [storeName, theirs] of Object.entries(remote)) {
        if (!theirs || typeof theirs !== 'object' || !local[storeName]) continue;
        const mine = local[storeName];
        for (const [key, theirValue] of Object.entries(theirs)) {
            const registration = mergeForKey(storeName, key);
            // Opt-in: only a registration that says it caps by this device's own setting can report a trim.
            // A generic "uncapped differs from capped" test misfires on folds that stamp a time, mutate
            // their inputs or order unstably
            if (!registration?.capsLocally) continue;
            try {
                const mineValue = Object.hasOwn(mine, key) ? mine[key] : undefined;
                // Deep clones into every call so a fold that mutates its inputs cannot skew the comparison
                const fold = (context) => registration.merge(clone(mineValue), clone(theirValue), context);
                const uncapped = fold(UPLOAD_CONTEXT);
                // The gist must hold something this device's copy lacks, else a push loses nothing. This
                // device's copy folded onto itself is the baseline, so normalization is not read as news
                const alone = registration.merge(clone(mineValue), clone(mineValue), UPLOAD_CONTEXT);
                if (stableStringify(uncapped) === stableStringify(alone)) continue;
                // ...and this device's own cap must be what would drop it
                const capped = fold(undefined);
                if (stableStringify(uncapped) !== stableStringify(capped)) {
                    trimmed.push({ store: storeName, key, label: registration.label });
                }
            } catch {
                // A fold that throws is not evidence of a trim
            }
        }
    }
    return trimmed;
}

/**
 * A deep copy of a JSON value (undefined stays undefined).
 * @param {*} value - Any JSON value
 * @returns {*} An independent copy
 */
function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * JSON with every object's keys in sorted order, so equal values serialize equally.
 * @param {*} value - Any JSON value
 * @returns {string} Canonical text
 */
function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
        const keys = Object.keys(value)
            .filter((key) => value[key] !== undefined)
            .sort();
        return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
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
    mergeForUpload,
    wholeKeyHashes,
    exchangeBaseline,
    registeredKeysDiverge,
    pushTrimsRegisteredKeys,
    trimmedRegisteredKeys,
    restampRestoredSettings,
    addsToRemote,
    hashPayload,
    readExportedAt,
    redactSettingsStore,
};
