/**
 * Cross-device sync.
 *
 * Two devices, one account, and no server of ours: the settings and history
 * this script accumulates live in IndexedDB, which is per-browser, so a second
 * machine starts empty and a reinstall starts empty again. This carries them
 * across via a single private GitHub gist that the user owns, using a personal
 * access token they supply.
 *
 * The conflict model is deliberately small. Every payload carries an
 * `exportedAt` and — since `KEY_LAST_SYNCED_SEQ` — a Lamport counter that
 * orders the exchanges when the two devices' clocks disagree; newest wins, and
 * the only case that asks a question is the one
 * where both sides moved: the remote is newer than what this device last
 * exchanged *and* this device has changed since then. Anything else resolves
 * without a dialog, because a sync that interrogates you on startup is a sync
 * you turn off.
 *
 * Applying a payload is not an overwrite. Records that can only grow — chest
 * tallies, market listings, XP series, trial records, labyrinth runs — are
 * combined with this device's copy key by key (see `sync-payload.js` and
 * `utils/sync-merge-registry.js`), because there is no reading of "take the
 * remote copy" under which throwing away entries the remote has never seen is
 * what anyone meant. What the conflict dialog actually decides is the fate of
 * the records that *cannot* be combined — settings, watchlists, plans — and
 * whether the union goes straight back up to the gist.
 *
 * "Has this device changed" is answered by fingerprinting the payload. An
 * automatic push first asks a write counter (`sync-dirty.js`, fed by
 * `storage.onWrite`) whether anything synced was written since a build last
 * matched the stored fingerprint, and skips the build when nothing was: the
 * build serializes and hashes every synced store on the main thread, and most
 * ticks it would only confirm that nothing moved.
 *
 * Everything fails soft. A missing token, a spent rate limit, a plane with no
 * wifi — each is a toast and a no-op, never a thrown error into whatever called
 * us, and never a partial write.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import { GAME } from '../../utils/selectors.js';
import storage from '../../core/storage.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { showToast } from '../../utils/toast.js';
import { askChoice } from '../../utils/choice-dialog.js';
import {
    GistError,
    findSyncGist,
    readSyncGist,
    readSyncGistRevision,
    writeSyncGist,
    chunkPayload,
} from './gist-client.js';
import { compressionAvailable, gzipText, gunzipToText } from './sync-compress.js';
import { encryptText, encryptBytes, decryptText, decryptBytes, bytesToBase64, base64ToBytes } from './sync-crypto.js';
import {
    buildPayloadJSON,
    applyPayload,
    contentHash,
    hashPayload,
    addsToRemote,
    mergeForUpload,
    wholeKeyHashes,
    exchangeBaseline,
    registeredKeysDiverge,
    trimmedRegisteredKeys,
    restampRestoredSettings,
    RESTORED_BASELINE,
} from './sync-payload.js';
import { startSyncDirtyTracker, syncWriteGeneration, markSyncClean, unchangedSinceClean } from './sync-dirty.js';
import { registerCommand, unregisterCommand } from '../../utils/command-registry.js';
import { flushPersistedRecords } from '../../utils/persisted-record.js';
import {
    buildPullSummary,
    formatPullSummaryLine,
    rememberPullSummary,
    clearPullSummary,
    lastPullSummary,
} from './pull-summary.js';
import { openPullSummaryPanel } from './pull-summary-panel.js';

const STORE = 'settings';

/** Which gist this device is using. Never uploaded — see sync-payload.js */
const KEY_GIST_ID = 'toolasha_sync_gistId';

/** `exportedAt` of the payload this device last pushed or pulled */
const KEY_LAST_SYNCED_AT = 'toolasha_sync_lastSyncedAt';

/**
 * When this device last pushed its own data to the gist.
 *
 * Separate from KEY_LAST_SYNCED_AT, which a pull overwrites with the *remote's*
 * exportedAt: after a pull that stamp says "this device applied someone else's
 * export", which is not the same question as "is this device's data in the gist".
 * Written only on a successful push.
 */
const KEY_LAST_PUSHED_AT = 'toolasha_sync_lastPushedAt';

/**
 * Lamport counter of the payload this device last pushed or accepted.
 *
 * `exportedAt` is stamped from the pushing device's wall clock, and a clock an
 * hour fast puts an hour of the future in the gist. Every other device records
 * that stamp as `lastSyncedAt`, and every correctly stamped payload after it
 * reads as older — so sync stops applying anything, for an hour, while saying
 * it is up to date. Nothing is destroyed (every merge is a union or a per-field
 * max), which is why it went unnoticed; it just stops.
 *
 * The counter orders the exchanges instead of the clocks: a push carries one
 * above everything this device has seen, and accepting a pull raises this
 * device to the counter it accepted. It decides a comparison only when BOTH
 * sides carry one, so a gist or a device that predates it is unaffected — see
 * {@link isNewer}.
 *
 * Device-local like the rest of this bookkeeping, and under the same
 * `toolasha_sync_` prefix, which is what keeps it out of every payload
 * (`LOCAL_ONLY_KEY_PREFIXES` in sync-payload.js) and per device rather than
 * per account. A counter taken from a payload would be another device's clock.
 */
const KEY_LAST_SYNCED_SEQ = 'toolasha_sync_lastSyncedSeq';

/** Fingerprint of that payload, so local drift since then is detectable */
const KEY_LAST_HASH = 'toolasha_sync_lastHash';

/** Remote payload still has records held back by an unreadable local merge base. */
const KEY_MERGE_HELD = 'toolasha_sync_mergeHeld';

/**
 * Set when an automatic push merged the gist into its upload instead of into
 * this device: the gist then holds another device's changes this device has
 * not applied. `{since}` — the stamp of that push.
 *
 * While it is set, every automatic push merges again (a plain one would drop
 * those changes from the gist), and the next startup or manual pull applies
 * the gist even though its counter is this device's own. Cleared by a pull
 * that applies, and by a pressed Push, which replaces the gist by design.
 */
const KEY_UNAPPLIED = 'toolasha_sync_unapplied';

/**
 * The gist version (a `history` entry) this device's last push produced.
 *
 * GitHub takes every gist write unconditionally, so another device's write
 * can replace this device's without either seeing the other. The replacing
 * device checks its own write (see `_recoverReplaced`); this is how the
 * replaced one can tell too: a newer gist whose manifest is `basedOn` a
 * version older than this push was written by a device that never saw it.
 */
const KEY_LAST_PUSHED_VERSION = 'toolasha_sync_lastPushedVersion';

/** Re-merges one push makes after finding its write replaced someone else's, before it gives up */
const MAX_RACE_ROUNDS = 2;

/**
 * Each whole-value key's hash at this device's last exchange — the common
 * ancestor the merge asks "which side moved this?" of. See `wholeKeyHashes`.
 */
const KEY_BASELINE = 'toolasha_sync_baseline';

/**
 * "Merge and push" remembered for a pressed Push that would trim: `{gistId, scope}` of the answer.
 * Device-local like the rest of this bookkeeping. Honored only for the same gist and scope, and cleared
 * when the token, the scope or the gist link changes, so a new situation is asked about afresh.
 */
const KEY_MERGE_ON_TRIM = 'toolasha_sync_mergeOnTrim';

/** How many chunk files the gist holds, so a shrinking payload can delete the rest */
const KEY_CHUNK_COUNT = 'toolasha_sync_chunkCount';

/**
 * The last gist version this device saw: `{gistId, etag, files, current}`.
 *
 * `etag` and `files` (size by file name) always come from the same response,
 * so a 304 to a conditional request proves the gist still holds exactly those
 * files — which is what lets a push skip downloading the whole gist to learn
 * which chunks are orphans.
 *
 * `current` says more: this device's data already reflects that version,
 * because it pushed it or pulled it to a conclusion ("not newer", or a complete
 * apply). Only then may a silent pull send the ETag and take a 304 as "nothing
 * to do". A pull that stood down, failed to decrypt or applied partly leaves
 * it false, so the next one downloads and tries again.
 */
const KEY_GIST_VERSION = 'toolasha_sync_gistVersion';

/**
 * How often auto-sync considers pushing.
 *
 * Long, on purpose. A tick after any synced write rebuilds the payload to
 * fingerprint it, which for the `everything` scope is a full database read;
 * doing that every minute would be a visible stutter in exchange for freshness
 * nobody asked for. A tick with no write since the last clean build skips it
 * (see `sync-dirty.js`).
 */
/**
 * What this tab's sync did and why, newest last: leadership changes, the schedule starting, and every
 * operation's outcome. Silent ticks report nothing on screen — `another-tab`, `busy`, `unchanged`,
 * `not-modified` — so this is the only record of why an automatic sync made no request.
 * Read it from the console with `Toolasha.debug.syncTrace()`.
 */
const syncTrace = [];
const SYNC_TRACE_LIMIT = 100;

/**
 * Record one sync event for `getSyncTrace`.
 * @param {string} event - What happened
 * @param {Object} [detail] - Anything that says why
 */
function traceSync(event, detail = {}) {
    syncTrace.push({ at: new Date().toISOString(), event, ...detail });
    if (syncTrace.length > SYNC_TRACE_LIMIT) syncTrace.shift();
}

/**
 * This tab's recent sync events, oldest first.
 * @returns {Array<Object>} A copy of the trace
 */
export function getSyncTrace() {
    return syncTrace.map((entry) => ({ ...entry }));
}

export const AUTO_PUSH_INTERVAL_MS = 15 * 60 * 1000;

/** How long after a character switch the on-switch push waits for the dust. */
const SWITCH_PUSH_DELAY_MS = 5 * 1000;

/**
 * Startup pulls, staggered. One pull twenty seconds in raced the handoff: a
 * phone logging in pulls before the tab it kicked has finished pushing, and
 * misses it by seconds. The retries are nearly free when the gist has not
 * changed: a silent pull of a version this device already has is a conditional
 * request that GitHub answers 304, with no body (see KEY_GIST_VERSION).
 */
const STARTUP_PULL_DELAYS_MS = [20 * 1000, 80 * 1000, 200 * 1000];

/** The periodic silent pull sits between the pushes rather than beside them. */
const AUTO_PULL_OFFSET_MS = Math.floor(AUTO_PUSH_INTERVAL_MS / 2);

/**
 * The character the manager last initialised for. Module-scoped on purpose:
 * a character switch tears the feature down and re-initialises it, and the
 * only thing that survives to say "this is a switch, not a page load" is the
 * module itself.
 */
let lastCharacterId = null;

/**
 * Web Lock held by the one tab that runs the automatic schedule. Separate from
 * the `toolasha-sync` operation lock, which every push and pull takes briefly.
 */
const LEADER_LOCK = 'toolasha-sync-leader';

/** A sync busy longer than this is wedged, and a new one may take over. */
const BUSY_STUCK_MS = 5 * 60 * 1000;

class SyncManager {
    constructor() {
        this.timers = createTimerRegistry();
        this.busy = false;
        this.isInitialized = false;
        this.settingListeners = [];
        /** This tab's claim on {@link LEADER_LOCK}, held or queued; null when none */
        this.leadership = null;
        /** Whether this tab currently runs the automatic schedule under the leader lock */
        this.isLeader = false;
    }

    /**
     * Start the feature. Safe to call when sync is off — it wires the setting
     * listeners and returns, so turning sync on later does not need a reload.
     * @returns {Promise<void>}
     */
    async initialize() {
        if (this.isInitialized) return;
        this.isInitialized = true;

        const restart = () => {
            traceSync('restart', { enabled: config.getSetting('sync_enabled', false) });
            this.timers.clearAll();
            this._releaseLeadership();
            this.handoffUnregister?.();
            this.handoffUnregister = null;
            this._startAuto();
            this._watchHandoff();
        };
        for (const key of ['sync_enabled', 'sync_auto']) {
            config.onSettingChange(key, restart);
            this.settingListeners.push([key, restart]);
        }
        // A different token or scope is a different situation: the remembered "Merge and push" no longer applies
        const forgetMergeChoice = async () => {
            try {
                await rememberLocal({ [KEY_MERGE_ON_TRIM]: null });
            } catch (error) {
                console.warn('[Sync] Could not clear the remembered merge choice:', error);
            }
        };
        for (const key of ['sync_token', 'sync_scope']) {
            config.onSettingChange(key, forgetMergeChoice);
            this.settingListeners.push([key, forgetMergeChoice]);
        }

        this._startAuto();
        this._watchHandoff();

        // Offered only when a push or pull could actually succeed. Asked
        // fresh each time the palette opens rather than once here: sync is
        // configured from the settings panel, without a re-initialise
        registerCommand({
            name: 'Sync push',
            hint: 'Push settings and data to GitHub now',
            run: () => this.push(),
            when: () => this.isConfigured(),
        });
        registerCommand({
            name: 'Sync pull',
            hint: 'Pull the GitHub copy onto this device',
            run: () => this.pull(),
            when: () => this.isConfigured(),
        });
        registerCommand({
            name: 'Sync pull summary',
            hint: 'What the last pull on this device reconciled',
            run: () => openPullSummaryPanel(),
            when: () => Boolean(lastPullSummary()),
        });

        // A re-initialise for a DIFFERENT character is a switch: push shortly,
        // so the character just left has its changes on GitHub without waiting
        // out the quarter-hour timer. The unchanged-skip makes this free when
        // nothing moved; the first initialise of a page load never fires it.
        const characterId = dataManager.getCurrentCharacterId?.() ?? null;
        // The summary describes what this device downloaded, not what this
        // character owns; carrying it across a switch would put one character's
        // pull on another character's screen.
        if (characterId !== lastCharacterId) clearPullSummary();
        if (
            lastCharacterId !== null &&
            characterId !== null &&
            characterId !== lastCharacterId &&
            config.getSetting('sync_onSwitch', false) &&
            this.isConfigured()
        ) {
            this.timers.scheduleTimeout(() => {
                this.push({ silent: true, unattended: true });
            }, SWITCH_PUSH_DELAY_MS);
        }
        if (characterId !== null) lastCharacterId = characterId;
    }

    /** Stop timers and setting listeners. */
    cleanup() {
        // Character switches tear this feature down while a GitHub request may
        // still be pending. Invalidate that operation's ownership token so it
        // cannot apply its pull after the next character opens. `busy` itself
        // stays held: an import already under way cannot be stopped, and
        // without Web Locks this flag is the only thing keeping the next
        // character's switch push from uploading a half-imported database.
        // The cancelled operation's own `finally` releases it.
        if (typeof this.busy === 'number') this.lastCancelledToken = this.busy;
        unregisterCommand('Sync push');
        unregisterCommand('Sync pull');
        unregisterCommand('Sync pull summary');
        this.handoffUnregister?.();
        this.handoffUnregister = null;
        this.handoffPushed = false;
        // Timers first: a waiting tab takes the schedule over as soon as the
        // leader lock goes, and this tab's intervals must already be dead
        this.timers.clearAll();
        this._releaseLeadership();
        for (const [key, callback] of this.settingListeners) config.offSettingChange(key, callback);
        this.settingListeners = [];
        this.isInitialized = false;
    }

    /**
     * Whether sync is switched on and has something to authenticate with.
     * @returns {boolean} True when a push or pull could succeed
     */
    isConfigured() {
        return Boolean(config.getSetting('sync_enabled', false) && this._token());
    }

    /**
     * Push local data to the gist.
     * @param {Object} [options] - Options
     * @param {boolean} [options.silent=false] - Skip when nothing changed, and
     *   only speak up on failure. Used by the interval.
     * @param {boolean} [options.unattended=false] - Nobody pressed a button for this push (the
     *   interval, a character switch, a session handoff): it never removes the gist's encryption
     *   and never writes a gist it could not list. See `writeSyncGist`.
     * @returns {Promise<{ok: boolean, skipped?: boolean, reason?: string}>} Outcome
     */
    async push({ silent = false, unattended = false } = {}) {
        return this._run('push', silent, (opToken) => this._doPush(silent, opToken, unattended));
    }

    /**
     * The upload itself, with no guard around it.
     *
     * Split out from `push()` so the conflict dialog's "keep this device" can
     * reach it: calling `push()` from inside a running `pull()` would be turned
     * away by the same `busy` flag that is protecting the pull, and the user's
     * choice would silently do nothing.
     *
     * @param {boolean} silent - Skip an unchanged payload, and say nothing on success
     * @param {number} [opToken] - This call's `busy` ownership token, from `_run`. Checked
     *   before every write that follows a wait a takeover could have happened during (a
     *   confirmation dialog left open, a hung request) — see `_stillOwns`.
     * @param {boolean} [unattended=false] - Nobody pressed a button for this push; see `push`. An unattended
     *   push that finds the gist ahead of this device merges it into the upload rather than writing over it.
     * @param {{text: string, localText: string, known: Object|null, remoteAdds: boolean, remoteAt: string|null,
     *   remoteSeq: number|null}|null} [merged=null] - An upload `_mergeIntoUpload` built: the merged payload,
     *   this device's own payload it was built from, and the gist version it was merged with. Finding the gist
     *   moved past that version again stands down for the next interval, so one tick merges at most once.
     *   `raceRound` counts the re-merges made after finding this push's write replaced another device's.
     * @param {number} [checkRounds=0] - How many times a pressed Push has found the gist moved since its trim
     *   check and checked again
     * @returns {Promise<{ok: boolean, skipped?: boolean, reason?: string}>} Outcome
     * @private
     */
    async _doPush(silent, opToken, unattended = false, merged = null, checkRounds = 0) {
        // A previous pull could not read a local history and deliberately held
        // its downloaded counterpart back. Uploading this incomplete union
        // would replace that counterpart in the gist before it can be retried.
        if (await storage.get(KEY_MERGE_HELD, STORE, null)) return this._heldBackResult(silent);
        const token = this._token();
        const scope = config.getSetting('sync_scope', 'settings');

        // `buildPayloadJSON` reads IndexedDB, and `storage.set` holds a value
        // for three seconds before it gets there — so an unflushed payload is
        // this session's data minus whatever it recorded last. The interval
        // push can shrug that off, because the next tick picks the write up.
        // The two pushes that exist *because* there will be no next tick
        // cannot: the handoff push fires when another device has taken the
        // session over, and the character-switch push fires as the character
        // being left goes away. Both would upload a copy with the final
        // seconds cut off, and nothing would ever put them back.
        //
        // An automatic push first asks the write counter (see `sync-dirty.js`)
        // whether anything synced was written since the last build proved this
        // device matched the stored fingerprint. If not, the build would only
        // find that out again, at the cost of serializing every store on the
        // main thread. The count is taken once the flush has landed what was
        // queued — every write is counted again when it commits, so one that
        // is not on disk by then, or lands during the build, counts after it
        // and is never absorbed into the clean point.
        let localPayload = merged?.localText;
        let builtAtGeneration = null;
        if (!merged) {
            startSyncDirtyTracker();
            await flushPersistedRecords();
            if (silent && unchangedSinceClean(scope, await storage.get(KEY_LAST_HASH, STORE, null))) {
                return { ok: true, skipped: true, reason: 'unchanged' };
            }
            await storage.flushAll?.();
            builtAtGeneration = syncWriteGeneration();
            localPayload = await buildPayloadJSON(scope);
        }
        // What goes up, and what this device holds. They differ only for a
        // merged upload; the fingerprint remembered is always this device's,
        // because "has this device changed since?" is asked of its own data.
        const payload = merged ? merged.text : localPayload;
        const hash = contentHash(payload);
        const localHash = merged ? contentHash(localPayload) : hash;

        if (!merged && silent && localHash === (await storage.get(KEY_LAST_HASH, STORE, null))) {
            markSyncClean({ generation: builtAtGeneration, lastHash: localHash, scope });
            return { ok: true, skipped: true, reason: 'unchanged' };
        }

        const gistId = await this._resolveGistId(token);

        // A device that has never exchanged with the gist has no idea what it
        // would be overwriting — a fresh phone pushing before its first pull
        // would replace a year of data with an empty database. Ask, with the
        // right answer suggested; the interval never asks, it just declines.
        if (gistId && !(await storage.get(KEY_LAST_SYNCED_AT, STORE, null))) {
            if (silent) return { ok: true, skipped: true, reason: 'never-synced' };
            const answer = await askChoice({
                title: 'Overwrite the gist?',
                message:
                    'This device has never synced with the gist already on this account. Pushing replaces ' +
                    "everything in the gist with this device's data. If this device is the new or empty one, " +
                    'Pull first instead.',
                choices: [
                    { value: 'push', label: 'Push and overwrite the gist', tone: 'danger' },
                    { value: null, label: 'Cancel' },
                ],
            });
            if (answer !== 'push') return { ok: true, skipped: true, reason: 'cancelled' };
            // The dialog just above can sit open for as long as the player
            // ignores it — the paradigm case of "wedged" that lets a takeover
            // happen at all (see `_run`). If one did, this push is racing an
            // operation that has already run with a fresher view of both the
            // database and the gist; writing now would stomp whatever it just
            // wrote. Stand down instead of overwriting a newer sync.
            if (!this._stillOwns(opToken)) return this._supersededResult(silent, 'push', opToken);
        }

        // A pressed Push overwrites by design, so a device keeping fewer entries
        // of a registered history than the gist holds would cut the gist's copy
        // to its own. Ask first. One gist download, for a rare user-initiated
        // action; a gist that cannot be read here is left to the push's own refusals.
        // The version that check read is the one the answer applies to: the write below is held to it
        let checked = null;
        if (!unattended && !merged && gistId) {
            const asked = await this._askBeforeTrimming(token, gistId, localPayload, scope, opToken);
            if (asked.choice === 'cancel') return { ok: true, skipped: true, reason: 'cancelled' };
            if (asked.choice === 'superseded') return this._supersededResult(silent, 'push', opToken);
            if (asked.choice === 'merge') {
                return this._mergeIntoUpload(localPayload, opToken, silent, asked.remote, false);
            }
            checked = asked.remote?.seen ?? null;
        }

        // The gist holds changes this device has not applied, so an automatic
        // push can only merge: go straight there rather than list the gist to
        // learn it is ahead and then download it again to merge it
        const unapplied = await storage.get(KEY_UNAPPLIED, STORE, null);
        if (unattended && unapplied && !merged && gistId) return this._mergeIntoUpload(localPayload, opToken, silent);

        // Nor can it go plain when a registered history here is no longer the
        // copy the gist held at the last exchange: a device keeping 20 sessions,
        // after a startup pull of a gist holding 500, would replace the 500 with
        // its 20. A hash cannot tell an addition from a trim, so this costs one
        // gist download on every automatic push whose histories moved since the
        // last exchange; a push that moved only settings or whole keys stays
        // plain. A pressed Push still means this device's copy (see `push`).
        if (unattended && !merged && gistId) {
            const baseline = await storage.get(KEY_BASELINE, STORE, null);
            if (registeredKeysDiverge(localPayload, baseline)) {
                traceSync('history-diverged');
                return this._mergeIntoUpload(localPayload, opToken, silent);
            }
        }

        // The hash above is always of the plaintext — compression and
        // encryption both change the bytes without changing the data (and a
        // fresh salt makes ciphertext different every push), so hashing
        // anything later in the pipeline would make every payload look changed.
        //
        // Pipeline order is gzip first, encrypt second: JSON compresses ~5-10×
        // and ciphertext does not compress at all. This is what fits the
        // "everything" scope under the gist ceiling.
        const { body, compressed, encrypted } = await this._packBody(payload);

        const chunks = chunkPayload(body);
        const previousChunks = Number(await storage.get(KEY_CHUNK_COUNT, STORE, 0)) || 0;

        const exportedAt = new Date().toISOString();
        // Read here rather than at the top of the method: the never-synced
        // dialog above can sit open for as long as the player ignores it, and
        // a counter read before that wait would be one a takeover has since
        // moved past. (A takeover is stood down on by `_stillOwns` below
        // anyway; this keeps the number itself honest.)
        const lastSeq = readSeq(await storage.get(KEY_LAST_SYNCED_SEQ, STORE, null));
        const lastSyncedAt = await storage.get(KEY_LAST_SYNCED_AT, STORE, null);
        const syncSeq = (lastSeq ?? 0) + 1;
        const manifest = {
            toolashaSync: 1,
            scope,
            exportedAt,
            // In the MANIFEST, never the payload. The payload is byte for byte
            // a full backup, restorable by hand through "Restore Backup", and
            // the manifest is the one part of a sync gist that only this
            // feature reads — an older build's `readSyncGist` gates on
            // `toolashaSync` and `chunks` and passes the rest through
            // untouched, so a field it has never heard of costs it nothing.
            syncSeq,
            chunks: chunks.length,
            bytes: payload.length,
            hash,
            ...(compressed ? { compressed } : {}),
            ...(encrypted ? { encrypted } : {}),
        };

        // Last check before the write that actually reaches GitHub. Nothing
        // between the top of this method and here normally takes long enough
        // for a takeover to happen without the dialog above, but a stalled
        // storage read or a gist resolution waiting out its request timeout
        // is the same "wedged" shape, just without a dialog to point at.
        if (!this._stillOwns(opToken)) return this._supersededResult(silent, 'push', opToken);

        // Another tab's pull may have held records back while this payload was
        // being built. The check at the top is too early to cover that.
        if (await storage.get(KEY_MERGE_HELD, STORE, null)) return this._heldBackResult(silent);

        // A remembered listing is handed over only when this device's data
        // already reflects it. One it merely saw — a silent pull that stood
        // down on a conflict — can carry a higher counter than this device's,
        // and a 304 against it would hide that counter from the write below,
        // which raises the manifest's counter above the gist's own.
        // A record written before versions carried the manifest's counter and
        // encryption is not handed over either: a 304 against it would leave
        // the write unable to see either one.
        // Nor while the gist holds changes this device has not applied, or
        // when sending a merge: the write must read the gist's manifest to know
        // whether it moved, and a 304 does not carry one.
        // A merge hands over the version it just downloaded: a 304 against it
        // proves the gist did not move while the merge was built, and saves
        // a third download of the same gist
        const known = merged ? merged.known : await this._knownVersion(gistId);
        const usableKnown =
            (merged || (known?.current && !unapplied)) && typeof known?.encrypted === 'boolean' ? known : null;
        // The version a pressed push is held to: with none on record (no ETag came back) there is nothing to hold to
        const heldTo = unattended ? null : (merged ? merged.known : checked) || null;
        const aheadOf = merged ? { at: merged.remoteAt, seq: merged.remoteSeq } : { at: lastSyncedAt, seq: lastSeq };
        let written;
        try {
            written = await writeSyncGist(token, gistId, manifest, chunks, previousChunks, usableKnown, {
                unattended,
                // Someone pressed Push on a device with no passphrase, over a gist
                // that is encrypted. That may be meant, but it removes the
                // encryption for every device, so it is asked rather than done
                confirmPlaintext: unattended ? null : () => this._confirmPlaintextPush(opToken),
                // An automatic push never overwrites an exchange this device has
                // not taken: that is how a setting changed on the other device
                // was lost on both. It merges first (below). A pressed Push
                // still means "this device's copy", and overwrites.
                // A changed gist whose manifest gives no order at all — damaged, or
                // edited by hand — may hold a newer exchange, so it counts as ahead:
                // the merge then either folds it in or, unable to read it, holds
                // automatic pushes until someone presses Push
                // A pressed Push whose gist was read for the trim check, or whose merge was built from a
                // download, still overwrites that version on purpose, and only that one: a gist that moved
                // since holds history the answer was never about
                isAhead: unattended
                    ? (listed) =>
                          (!merged && Boolean(unapplied)) ||
                          (Boolean(listed.unordered) && listingMoved(listed, known)) ||
                          isNewer(listed.exportedAt, aheadOf.at, listed.syncSeq, aheadOf.seq)
                    : heldTo
                      ? (listed) => listingMoved(listed, heldTo)
                      : null,
            });
        } catch (error) {
            if (error instanceof GistError && error.kind === 'cancelled') {
                return { ok: true, skipped: true, reason: 'cancelled' };
            }
            if (!unattended && error instanceof GistError && error.kind === 'behind') {
                // The gist moved after what the answer was about was read: look again, and ask again if it
                // would now trim. A merge is rebuilt from the new version.
                if (checkRounds < 3) {
                    if (merged)
                        return this._mergeIntoUpload(localPayload, opToken, silent, null, false, checkRounds + 1);
                    return this._doPush(silent, opToken, false, null, checkRounds + 1);
                }
                if (!silent) {
                    showToast('Sync push stopped: the gist kept changing while it was being checked. Try again.', {
                        kind: 'warn',
                        duration: 0,
                    });
                }
                return { ok: false, reason: 'behind' };
            }
            if (unattended && error instanceof GistError && error.kind === 'behind') {
                if (merged) {
                    console.warn(
                        '[Sync] The gist moved again while a merge was being sent; the next interval merges it.'
                    );
                    return { ok: false, reason: 'behind' };
                }
                return this._mergeIntoUpload(localPayload, opToken, silent);
            }
            // Quietly: this device's pulls of the same gist already fail on the
            // missing passphrase and say so, and a second sticky toast every
            // interval would add nothing but noise. A gist that could not be
            // listed is retried by the next interval.
            if (unattended && error instanceof GistError && ['passphrase', 'unlisted'].includes(error.kind)) {
                console.warn(`[Sync] Skipped an automatic push (${error.kind}): ${error.message}`);
                return { ok: false, reason: error.kind };
            }
            throw error;
        }

        // The upload already landed — that part cannot be undone or is not
        // worth undoing, since the takeover's own more-recent write (if any)
        // will win the next read anyway. What must not happen is THIS call's
        // bookkeeping clobbering whatever the takeover has since recorded:
        // this `exportedAt`/`hash` describe a snapshot from before the wait,
        // and stamping them now would make a perfectly good later sync look
        // unsynced again.
        if (!this._stillOwns(opToken)) return this._supersededResult(silent, 'push', opToken);

        // Another device wrote between this push's listing and its write, and
        // this write replaced it (GitHub has no conditional update). Fold what
        // was replaced back in and write again, rather than record a success
        // that leaves that device's push stranded.
        if (unattended && written.intervening?.length) {
            return this._recoverReplaced({
                silent,
                opToken,
                token,
                gistId: written.id,
                written,
                uploadedText: payload,
                localPayload,
                exportedAt,
                encrypted: manifest.encrypted,
                merged,
            });
        }

        await this._remember({
            gistId: written.id,
            exportedAt,
            hash: localHash,
            chunkCount: chunks.length,
            // What the manifest actually carries: the write raises it above a
            // gist another device has since moved further along
            syncSeq: Number.isSafeInteger(written.syncSeq) ? written.syncSeq : syncSeq,
            // The write's own response describes the version it produced, which
            // is this device's data by construction. No ETag, no claim: the
            // next read then downloads in full, as it always did.
            // A merged upload holding changes this device has not applied is
            // not this device's data, so not `current`
            version: gistVersion(written.id, written.etag, written.files, !merged?.remoteAdds, {
                syncSeq: Number.isSafeInteger(written.syncSeq) ? written.syncSeq : syncSeq,
                encrypted: manifest.encrypted,
                version: written.version,
            }),
            // In the same transaction as the counter. Written after it, a page
            // closing between the two kept the advanced counter and lost the
            // note that the gist holds changes not applied here — and the next
            // automatic push, seeing the gist no longer ahead, replaced it
            extra: {
                [KEY_LAST_PUSHED_AT]: exportedAt,
                [KEY_LAST_PUSHED_VERSION]: written.version ?? null,
                // A merged upload records both what went up and what this device
                // holds (see exchangeBaseline); a plain one, where they are the
                // same, records the one
                [KEY_BASELINE]: merged ? exchangeBaseline(payload, localPayload) : wholeKeyHashes(localPayload),
                // A merged upload carried changes this device has not applied, or
                // still carries ones an earlier merge did. A plain push replaced
                // the gist with this device's data, so there are none.
                // `remoteAdds` is read off the merged result, which holds
                // whatever an earlier merge left unapplied too
                [KEY_UNAPPLIED]: merged?.remoteAdds ? { since: exportedAt } : null,
            },
        });
        // The fingerprint just stored is of the payload built above, so the
        // database as it stood then is clean. A merged upload's local text was
        // built by an earlier call; its next push builds once to say so.
        if (builtAtGeneration !== null) markSyncClean({ generation: builtAtGeneration, lastHash: localHash, scope });

        if (!silent) {
            showToast(`Synced to GitHub (${scope === 'everything' ? 'everything' : 'settings only'}).`);
        }
        return { ok: true };
    }

    /**
     * The automatic push found the gist ahead of this device: fold the gist
     * into the upload, in memory, and send the result.
     *
     * Merging into local storage instead (a pull) would latch every store it
     * touches until a reload and put "Reload now" on screen — on two devices in
     * use, every quarter hour each, with recording stopped in between. Nothing
     * local is written here; this device takes the other's changes at its next
     * startup pull (`KEY_UNAPPLIED` says there are some).
     *
     * When the merge adds nothing the gist does not already hold, nothing is
     * sent: the loop guard that stops two devices trading one union for ever.
     * A gist it cannot read for want of a passphrase is the refusal the push
     * makes for it — logged, not toasted — and one in a format this build does
     * not read is left alone rather than half merged.
     *
     * @param {string} localText - This device's payload
     * @param {number} opToken - The push's ownership token
     * @param {boolean} silent - Whether to stay quiet on success
     * @param {{manifest?: Object, payload?: string, seen?: Object|null}|null} [downloaded=null] - A download of the
     *   gist the caller just made; used instead of reading it again
     * @param {boolean} [unattended=true] - False for a pressed Merge, so a gist that moves before the write is
     *   merged again rather than left for the next interval
     * @param {number} [checkRounds=0] - How many times a pressed push has already gone round
     * @returns {Promise<{ok: boolean, skipped?: boolean, reason?: string}>} Outcome
     * @private
     */
    async _mergeIntoUpload(localText, opToken, silent, downloaded = null, unattended = true, checkRounds = 0) {
        traceSync('merge-into-upload');
        const token = this._token();
        const gistId = await this._resolveGistId(token);
        let remote;
        try {
            remote = downloaded?.payload ? downloaded : await this._readRemote(token, gistId, null);
        } catch (error) {
            if (error instanceof GistError && error.kind === 'passphrase') {
                console.warn(`[Sync] Skipped an automatic merge (passphrase): ${error.message}`);
                return { ok: false, reason: 'passphrase' };
            }
            // A gist that is corrupt or in a newer format stays that way until
            // someone pushes over it on purpose (a pressed Push still does).
            // Saying so every interval is noise; once is the record.
            if (error instanceof GistError && error.kind === 'parse') {
                this._logStuckOnce('parse', error);
                return { ok: false, reason: 'parse' };
            }
            throw error;
        }
        if (!this._stillOwns(opToken)) return this._supersededResult(silent, 'push', opToken);

        const baseline = await storage.get(KEY_BASELINE, STORE, null);
        let merged;
        try {
            merged = mergeForUpload(localText, remote.payload, baseline);
        } catch (error) {
            this._logStuckOnce('unmergeable', error);
            return { ok: false, reason: 'unmergeable' };
        }

        // An upload that only sheds stores this device's scope no longer syncs
        // adds nothing, yet is the write that stops every device downloading them
        const changesRemote = merged.dropsFromRemote || addsToRemote(merged.text, remote.payload);
        if (!changesRemote && !merged.remoteAdds) {
            // The two hold the same data: another device pushed nothing this
            // one lacks. Settle on that version exactly as a pull finding
            // nothing new would, so neither the next startup nor the interval
            // pull imports an identical payload, latches the stores and asks
            // for a reload over nothing.
            const lastSeq = readSeq(await storage.get(KEY_LAST_SYNCED_SEQ, STORE, null));
            await this._remember({
                gistId,
                exportedAt: remote.manifest?.exportedAt ?? null,
                hash: contentHash(localText),
                chunkCount: Number(remote.manifest?.chunks) || 0,
                syncSeq: advanceSeq(lastSeq, readSeq(remote.manifest?.syncSeq)),
                version: remote.seen ? { ...remote.seen, current: true } : null,
                // The gist's side is what the gist holds, not this device's copy:
                // a history trimmed here to this device's retention, recorded as
                // the gist's, would let the next plain push replace the gist's
                // longer copy with it (see `registeredKeysDiverge`)
                extra: { [KEY_BASELINE]: exchangeBaseline(remote.payload, localText), [KEY_UNAPPLIED]: null },
            });
            return { ok: true, skipped: true, reason: 'in-step' };
        }

        if (!changesRemote) {
            // The gist already holds everything here, and more. Nothing to
            // send, but the gist is ahead: note it for the startup pull, and
            // remember this device's data as seen so the next interval does
            // not merge again until something changes here.
            await rememberLocal({
                [KEY_LAST_HASH]: contentHash(localText),
                [KEY_UNAPPLIED]: { since: remote.manifest?.exportedAt ?? null },
                ...(remote.seen ? { [KEY_GIST_VERSION]: remote.seen } : {}),
            });
            return { ok: true, skipped: true, reason: 'gist-has-it' };
        }

        // A pressed Merge stays a pressed push, so a gist that moves before the write is merged again
        return this._doPush(
            silent,
            opToken,
            unattended,
            {
                text: merged.text,
                localText,
                known: remote.seen,
                remoteAdds: merged.remoteAdds,
                remoteAt: remote.manifest?.exportedAt ?? null,
                remoteSeq: readSeq(remote.manifest?.syncSeq),
            },
            checkRounds
        );
    }

    /**
     * Log, once per session and cause, that an automatic push is held up by
     * a gist it cannot merge. The gist does not change by itself, so the
     * second interval's line would say nothing the first did not.
     * @param {string} reason - 'parse' or 'unmergeable'
     * @param {Error} error - What was thrown
     * @private
     */
    _logStuckOnce(reason, error) {
        this._stuckLogged = this._stuckLogged || new Set();
        const key = `${reason}:${error?.message ?? ''}`;
        if (this._stuckLogged.has(key)) return;
        this._stuckLogged.add(key);
        console.warn(
            `[Sync] Automatic pushes are held: the gist cannot be merged (${reason}). A pressed Push replaces it.`,
            error
        );
    }

    /**
     * This push's write replaced versions another device wrote after this
     * push listed the gist. Read each back, fold it into what was just
     * written with the same upload merge, and write the result.
     *
     * The rewrite lists against the version just written, so its own check
     * catches a third device writing meanwhile. After `MAX_RACE_ROUNDS` such
     * rounds it stops without recording success: this device stays "changed"
     * (its fingerprint was never moved), so the next interval tries again, and
     * the device whose push is still missing can tell from the gist's
     * manifest (see KEY_LAST_PUSHED_VERSION).
     *
     * @param {Object} state - The push so far
     * @returns {Promise<{ok: boolean, skipped?: boolean, reason?: string}>} Outcome
     * @private
     */
    async _recoverReplaced({
        silent,
        opToken,
        token,
        gistId,
        written,
        uploadedText,
        localPayload,
        exportedAt,
        encrypted,
        merged,
    }) {
        const round = (merged?.raceRound ?? 0) + 1;
        traceSync('write-replaced', { versions: written.intervening.length, round });
        if (round > MAX_RACE_ROUNDS) {
            console.warn('[Sync] Other devices kept writing over this push; the next interval tries again.');
            return { ok: false, reason: 'raced' };
        }

        // More revisions were replaced than one check reads back. The older ones
        // cannot be folded in, and a rewrite built from the newest few would be
        // recorded as a success that leaves them stranded in the gist's history
        // with nothing left to look for them. Undo this write instead, the way
        // an unreadable revision is: the gist is put back as the newest replaced
        // push, a normal revision, so this device's fingerprint stays "changed"
        // and the next interval merges onto it as an ordinary push. Not a hold:
        // nothing about the gist is unmergeable, only this write's view of it.
        if (written.interveningTruncated) {
            console.warn(
                `[Sync] More than ${written.intervening.length} other pushes landed while this one was written; ` +
                    'undid it and will merge onto the latest on the next interval.'
            );
            await this._restoreReplaced(token, gistId, written.intervening.at(-1), written.intervening.slice(0, -1));
            return { ok: false, reason: 'raced' };
        }

        const baseline = await storage.get(KEY_BASELINE, STORE, null);
        let text = uploadedText;
        let remoteAdds = Boolean(merged?.remoteAdds);
        for (const version of written.intervening) {
            try {
                const replaced = await this._readRemote(token, gistId, null, null, version);
                text = mergeForUpload(text, replaced.payload, baseline).text;
            } catch (error) {
                // A revision this device cannot read (no passphrase, a corrupt
                // one) or cannot merge (a newer build's format) cannot be folded
                // in, and this write has just replaced it. Left that way, the
                // next interval lists this device's own write as current and the
                // other device's data survives only in the gist's history; an
                // encrypted one is replaced in the clear again at every interval.
                // Put the gist back as it was, under a counter above this write,
                // so the next automatic push finds it ahead and refuses it there
                console.warn(`[Sync] Could not fold in a revision this push replaced (${version}):`, error);
                await this._restoreReplaced(token, gistId, written.intervening.at(-1));
                if (error instanceof GistError && error.kind === 'passphrase') {
                    return { ok: false, reason: 'passphrase' };
                }
                if (!(error instanceof GistError) || error.kind === 'parse') {
                    this._logStuckOnce('unmergeable', error);
                    return { ok: false, reason: 'unmergeable' };
                }
                return { ok: false, reason: 'raced' };
            }
        }
        if (!this._stillOwns(opToken)) return this._supersededResult(silent, 'push', opToken);
        remoteAdds = remoteAdds || addsToRemote(text, localPayload, { forUpload: false });

        return this._doPush(silent, opToken, true, {
            text,
            localText: localPayload,
            // What was just written is the base of the rewrite
            known: gistVersion(gistId, written.etag, written.files, false, {
                syncSeq: written.syncSeq,
                encrypted,
                version: written.version,
            }),
            remoteAdds,
            remoteAt: exportedAt,
            remoteSeq: Number.isSafeInteger(written.syncSeq) ? written.syncSeq : null,
            raceRound: round,
        });
    }

    /**
     * Run a payload through the push pipeline: gzip first, then encrypt with
     * this device's passphrase when it has one.
     * @param {string} payload - Plaintext payload
     * @returns {Promise<{body: string, compressed: ?string, encrypted: ?Object}>} The wire body and its manifest flags
     * @private
     */
    async _packBody(payload) {
        const passphrase = this._passphrase();
        const compressed = compressionAvailable() ? 'gzip' : null;
        const bodyBytes = compressed ? await gzipText(payload) : null;

        let body;
        let encrypted = null;
        if (passphrase) {
            const sealed = compressed
                ? await encryptBytes(bodyBytes, passphrase)
                : await encryptText(payload, passphrase);
            body = sealed.ciphertext;
            encrypted = {
                v: 1,
                algorithm: sealed.algorithm,
                kdf: sealed.kdf,
                iterations: sealed.iterations,
                salt: sealed.salt,
                iv: sealed.iv,
            };
        } else {
            body = compressed ? bytesToBase64(bodyBytes) : payload;
        }
        return { body, compressed, encrypted };
    }

    /**
     * Restore the newest replaced revision with the older replaced ones folded
     * into it, so data unique to any of them stays in the gist.
     * @param {string} token - GitHub token
     * @param {string} gistId - Gist id
     * @param {string} version - The newest replaced revision
     * @param {Array<string>} older - Older replaced revisions, oldest first
     * @returns {Promise<boolean>} True when the folded restore was written; false leaves the byte restore to the caller
     * @private
     */
    async _restoreFolded(token, gistId, version, older) {
        try {
            const newest = await this._readRemote(token, gistId, null, null, version);
            // Oldest first, each later revision as the incoming side: a value the merges cannot combine goes
            // to the newest revision, not the oldest. A revision fold, so this device's baseline cannot turn
            // that round, and the result carries the newest revision's scope whatever the older ones synced
            const scope = JSON.parse(newest.payload)?.syncScope ?? 'settings';
            const payloads = [];
            for (const olderVersion of older) {
                payloads.push((await this._readRemote(token, gistId, null, null, olderVersion)).payload);
            }
            payloads.push(newest.payload);
            let text = payloads[0];
            for (const incoming of payloads.slice(1)) {
                text = mergeForUpload(text, incoming, null, { revisionFold: true, scope }).text;
            }
            const { body, compressed, encrypted } = await this._packBody(text);
            const chunks = chunkPayload(body);
            // The manifest is the newest revision's, repacked: its size, hash and encoding describe the new body
            const { basedOn: _basedOn, compressed: _c, encrypted: _e, ...manifest } = newest.manifest;
            await writeSyncGist(
                token,
                gistId,
                {
                    ...manifest,
                    chunks: chunks.length,
                    bytes: text.length,
                    hash: contentHash(text),
                    ...(compressed ? { compressed } : {}),
                    ...(encrypted ? { encrypted } : {}),
                },
                chunks,
                0,
                null,
                { unattended: true }
            );
            console.warn("[Sync] Put back the other devices' pushes this device replaced, folded together.");
            return true;
        } catch (error) {
            console.warn(
                '[Sync] Could not fold the replaced pushes together; putting back the newest as it was:',
                error
            );
            return false;
        }
    }

    /**
     * Write a revision this push replaced back over it, byte for byte: its
     * manifest and its chunks as they were, under a counter above the write
     * it undoes. For a revision this device cannot decrypt, read or merge.
     * Best effort: a failure is logged, and the next interval's push is
     * refused or merges as it would have before.
     * @param {string} token - GitHub token
     * @param {string} gistId - Gist id
     * @param {string} version - The newest revision the push replaced
     * @param {Array<string>} [older=[]] - Older replaced revisions, oldest first. When given and every one
     *   reads and merges, the restore is the newest folded with them (never this device's own payload, so
     *   the push still backs off); otherwise it is the newest byte for byte
     * @returns {Promise<void>}
     * @private
     */
    async _restoreReplaced(token, gistId, version, older = []) {
        if (older.length && (await this._restoreFolded(token, gistId, version, older))) return;
        try {
            const revision = await readSyncGistRevision(token, gistId, version);
            const chunks = chunkPayload(revision.payload);
            // `basedOn` is the write's own: the restore is based on what it undoes
            const { basedOn: _basedOn, ...manifest } = revision.manifest;
            await writeSyncGist(token, gistId, { ...manifest, chunks: chunks.length }, chunks, 0, null, {
                unattended: true,
            });
            console.warn("[Sync] Put back another device's push that this device replaced and could not merge.");
        } catch (error) {
            console.error("[Sync] Could not put back another device's push that this device replaced:", error);
        }
    }

    /**
     * Download the gist and undo the push pipeline: decrypt, decompress, and
     * check the result against its manifest.
     * @param {string} token - GitHub token
     * @param {string} gistId - Gist id
     * @param {Object|null} known - The remembered version, for `seen`
     * @param {string|null} [etag] - Ask conditionally against this ETag
     * @param {string|null} [revision] - Read this past version instead of the current one
     * @returns {Promise<{notModified?: boolean, manifest?: Object, payload?: string, seen?: Object|null}>}
     *   The plaintext payload and its manifest, and the version record this download proves
     * @private
     */
    async _readRemote(token, gistId, known, etag = null, revision = null) {
        const remote = revision
            ? await readSyncGistRevision(token, gistId, revision)
            : await readSyncGist(token, gistId, etag ? { etag } : undefined);
        if (remote.notModified) return { notModified: true };
        const manifest = remote.manifest;
        // What this download proves about the gist's file set, whatever the
        // caller goes on to decide. It stays `current` only if it already was;
        // the outcomes that settle the content upgrade it.
        const seen = gistVersion(gistId, remote.etag, remote.files, known?.current && known.etag === remote.etag, {
            ...manifest,
            version: remote.version,
        });
        let payload = remote.payload;

        // Decrypt first, then decompress. A manifest without either flag is a
        // payload from before they existed, and reads exactly as it always did.
        if (manifest?.encrypted) {
            const passphrase = this._passphrase();
            if (!passphrase) {
                throw new GistError(
                    'passphrase',
                    'This sync gist is encrypted, and no sync passphrase is set on this device.'
                );
            }
            const sealed = { ...manifest.encrypted, ciphertext: payload };
            payload = manifest.compressed
                ? await gunzipToText(await decryptBytes(sealed, passphrase))
                : await decryptText(sealed, passphrase);
        } else if (manifest?.compressed) {
            payload = await gunzipToText(base64ToBytes(payload));
        }

        verifyAgainstManifest(manifest, payload);
        return { manifest, payload, seen, history: remote.history ?? null };
    }

    /**
     * Whether the gist's newest write replaced this device's last push without
     * having seen it: the manifest says which version that write was based on,
     * and the history puts this device's push after it.
     *
     * Undecidable — and answered no — without a recorded push version, a
     * `basedOn` (a write from before it was recorded), or a history that still
     * lists both.
     *
     * @param {{manifest?: Object, history?: Array<string>|null}} remote - What a pull downloaded
     * @param {string|null} lastPushed - KEY_LAST_PUSHED_VERSION
     * @returns {boolean} True when this device's push is not in the gist
     * @private
     */
    _pushWasReplaced(remote, lastPushed) {
        const basedOn = remote?.manifest?.basedOn;
        const history = remote?.history;
        if (!lastPushed || !basedOn || !Array.isArray(history)) return false;
        const mine = history.indexOf(lastPushed);
        const base = history.indexOf(basedOn);
        return mine > 0 && base > mine;
    }

    /**
     * For a pressed Push: when replacing the gist would cut a registered history it holds, ask whether to
     * merge instead.
     * @param {string} token - GitHub token
     * @param {string} gistId - Gist id
     * @param {string} localPayload - This device's payload
     * @param {string} scope - The scope `localPayload` was built for, which the remembered answer is keyed to:
     *   rereading the setting here would key it to a scope changed while the gist was downloading
     * @param {number} opToken - The push's ownership token; a takeover during the dialog stands the push down
     * @returns {Promise<{choice: 'push'|'merge'|'cancel'|'superseded', remote: Object|null}>} What to do ('push'
     *   replaces as before), and the download it was decided on; null when the gist could not be read
     * @private
     */
    async _askBeforeTrimming(token, gistId, localPayload, scope, opToken) {
        let remote;
        try {
            remote = await this._readRemote(token, gistId, null);
        } catch (error) {
            console.warn('[Sync] Could not check whether a push would trim the gist; pushing as asked:', error);
            return { choice: 'push', remote: null };
        }
        const trimmed = remote?.payload ? trimmedRegisteredKeys(localPayload, remote.payload) : [];
        if (!trimmed.length) return { choice: 'push', remote: remote ?? null };
        const remembered = await storage.get(KEY_MERGE_ON_TRIM, STORE, null);
        const rememberedHere = remembered?.gistId === gistId && remembered?.scope === scope;
        traceSync('push-would-trim', {
            keys: trimmed.map(({ store, key }) => `${store}/${key}`),
            remembered: rememberedHere,
        });
        if (rememberedHere) return { choice: 'merge', remote };
        const labels = [...new Set(trimmed.map(({ label }) => label))];
        const named = labels.slice(0, 4).join(', ') + (labels.length > 4 ? `, and ${labels.length - 4} more` : '');
        const answer = await askChoice({
            title: 'Replace longer history on GitHub?',
            message:
                `GitHub has more: ${named}.\n\n` +
                'The copy on GitHub holds more history than this device does (for example, older sessions or ' +
                'records this device no longer keeps). Pushing as is replaces it with this device’s ' +
                'shorter copy, and the extra history is gone from GitHub.\n\n' +
                'Merging keeps everything from both sides and pushes the result. Choosing it also merges ' +
                'future pushes from this device without asking.',
            choices: [
                { value: 'merge', label: 'Merge and push (recommended)', tone: 'primary' },
                { value: 'replace', label: 'Replace anyway', tone: 'danger' },
                { value: null, label: 'Cancel' },
            ],
        });
        if (!this._stillOwns(opToken)) return { choice: 'superseded', remote };
        if (answer === 'merge') {
            await rememberLocal({ [KEY_MERGE_ON_TRIM]: { gistId, scope } });
            return { choice: 'merge', remote };
        }
        if (answer === 'replace') return { choice: 'push', remote };
        return { choice: 'cancel', remote };
    }

    /**
     * Ask before a push in the clear replaces an encrypted gist.
     * @param {number} opToken - The push's ownership token; a takeover during the dialog cancels it
     * @returns {Promise<boolean>} True to go ahead
     * @private
     */
    async _confirmPlaintextPush(opToken) {
        const answer = await askChoice({
            title: 'Remove the gist\u2019s encryption?',
            message:
                'The sync gist is encrypted, and this device has no sync passphrase. Pushing replaces it with an ' +
                'UNENCRYPTED copy, which removes the encryption for every device that shares the gist. To keep it ' +
                'encrypted, cancel and enter the same passphrase here first.',
            choices: [
                { value: 'push', label: 'Push unencrypted', tone: 'danger' },
                { value: null, label: 'Cancel' },
            ],
        });
        return answer === 'push' && this._stillOwns(opToken);
    }

    /**
     * What a push returns when a pull's held-back records have not landed yet.
     * @param {boolean} silent - Whether to say anything about it
     * @returns {{ok: boolean, reason: string}} Outcome
     * @private
     */
    _heldBackResult(silent) {
        if (!silent) {
            showToast(
                'Sync push paused: some downloaded records are still waiting. Pull again after storage recovers.',
                { kind: 'warn', duration: 0 }
            );
        }
        return { ok: false, reason: 'held-back' };
    }

    /**
     * Pull remote data down, newest-wins, asking first if both sides moved.
     * @param {Object} [options] - Options
     * @param {boolean} [options.silent=false] - Only act when the remote is
     *   strictly newer, and stay quiet otherwise. Used at startup.
     * @param {boolean} [options.startup=false] - One of the page-load pulls. It also takes what an automatic
     *   merge left in the gist for this device, and merges when both sides moved instead of standing down.
     * @returns {Promise<{ok: boolean, skipped?: boolean, reason?: string}>} Outcome
     */
    async pull({ silent = false, startup = false } = {}) {
        return this._run('pull', silent, (opToken) => this._doPull(silent, opToken, startup));
    }

    /**
     * The download itself, with no guard around it.
     * @param {boolean} silent - Only act on a strictly newer remote, and stay quiet otherwise
     * @param {number} [opToken] - This call's `busy` ownership token, from `_run`. See `_stillOwns`.
     * @param {boolean} [startup=false] - A page-load pull; see `pull`
     * @returns {Promise<{ok: boolean, skipped?: boolean, reason?: string}>} Outcome
     * @private
     */
    async _doPull(silent, opToken, startup = false) {
        const token = this._token();
        const gistId = await this._resolveGistId(token);
        if (!gistId) {
            if (!silent) {
                showToast('No sync gist found for this token yet. Push once to create it.', { kind: 'warn' });
            }
            return { ok: true, skipped: true, reason: 'no-gist' };
        }

        // A silent pull asks GitHub whether the gist moved before downloading
        // it. Held-back records are the exception: they wait on a re-read of
        // the very version this device already has. So is a gist an automatic
        // merge left changes in for this device, for the pulls that take them.
        const unapplied = await storage.get(KEY_UNAPPLIED, STORE, null);
        const takeUnapplied = Boolean(unapplied) && (startup || !silent);
        const known = await this._knownVersion(gistId);
        // Asked conditionally whether or not this device's data reflects the
        // version: one it saw and stood down on, or merged into an upload, has
        // already been weighed, and downloading it again every interval to
        // weigh it again the same way costs the whole gist each time. A change
        // to the gist still comes down in full; the next automatic push merges
        // whatever is left.
        const conditional =
            silent && !takeUnapplied && known && !(await storage.get(KEY_MERGE_HELD, STORE, null)) ? known.etag : null;
        const remote = await this._readRemote(token, gistId, known, conditional);
        if (!this._stillOwns(opToken)) return this._supersededResult(silent, 'pull', opToken);
        if (remote.notModified) return { ok: true, skipped: true, reason: 'not-modified' };
        const { manifest, seen } = remote;
        const payload = remote.payload;

        const remoteAt = manifest?.exportedAt ?? null;
        const lastSyncedAt = await storage.get(KEY_LAST_SYNCED_AT, STORE, null);
        const remoteSeq = readSeq(manifest?.syncSeq);
        const lastSeq = readSeq(await storage.get(KEY_LAST_SYNCED_SEQ, STORE, null));

        // A partially applied pull records its stamp so other changes are not
        // replayed indefinitely, but its held-back keys still need the same
        // remote payload. Only retry the exact download, not an older gist.
        const held = await storage.get(KEY_MERGE_HELD, STORE, null);
        const retryHeld = held?.exportedAt === remoteAt && held?.hash === contentHash(payload);

        // This device's own last push may be missing from the gist: another
        // device wrote over it without having seen it (the gist's manifest is
        // based on a version older than that push). Then the gist is not a
        // fast-forward of this device, whatever the fingerprint says — and not
        // old news either: that write took the counter under this device's
        // push, so it carries the same one, and its stamp is from before it
        const replaced = this._pushWasReplaced(remote, await storage.get(KEY_LAST_PUSHED_VERSION, STORE, null));

        if (!retryHeld && !takeUnapplied && !replaced && !isNewer(remoteAt, lastSyncedAt, remoteSeq, lastSeq)) {
            // Settled: nothing in this version is news to this device
            if (seen) await rememberLocal({ [KEY_GIST_VERSION]: { ...seen, current: true } });
            if (!silent) showToast('Already up to date with GitHub.');
            return { ok: true, skipped: true, reason: 'not-newer' };
        }

        // The very content this device last exchanged — its own push, put back
        // over a write that replaced it (see `_restoreReplaced`) — holds nothing
        // to apply, whatever its counter says. Settled the way a merge that adds
        // nothing settles: the counter taken, nothing imported, no reload asked
        const lastHash = await storage.get(KEY_LAST_HASH, STORE, null);
        if (!retryHeld && !takeUnapplied && Boolean(lastHash) && contentHash(payload) === lastHash) {
            await this._remember({
                gistId,
                exportedAt: remoteAt,
                hash: lastHash,
                chunkCount: Number(manifest?.chunks) || 0,
                syncSeq: advanceSeq(lastSeq, remoteSeq),
                version: seen ? { ...seen, current: true } : null,
            });
            if (!silent) showToast('Already up to date with GitHub.');
            return { ok: true, skipped: true, reason: 'in-step' };
        }

        // Both sides moved: the remote is ahead of what we last exchanged, and so
        // are we. Newest-wins would throw away whichever is older without saying
        // so, which is not a thing to do to a year of history.
        // Fingerprinting reads IndexedDB, not the debounce queue. Land recent
        // edits first so a pull cannot mistake an edited list for the last
        // synced copy and replace it without the conflict decision.
        await flushPersistedRecords();
        await storage.flushAll?.();
        const localHash = contentHash(await buildPayloadJSON(config.getSetting('sync_scope', 'settings')));
        const localChanged = replaced || (Boolean(lastHash) && localHash !== lastHash);

        /** Whether the union this pull produces is sent straight back up */
        let pushBack = false;

        // The silent paths never ask: a modal they raised sat unanswered
        // behind the game while `busy` stayed held — the "auto-sync randomly
        // stops until I reload" report. The interval pull applies only a clean
        // fast-forward and stands down when both sides moved; the next
        // automatic push merges the gist into its upload instead of
        // overwriting it (see `_mergeIntoUpload`), so nothing is lost by
        // waiting. A startup pull merges into this device — it is the moment
        // a reload is expected anyway — with settings by their change stamps,
        // histories by their folds and other keys by the baseline.
        if (localChanged && silent && !startup) {
            // Not settled, so not `current`: the next silent pull downloads
            // again. The listing is still true, and the next push uses it.
            // A gist that replaced this device's push can carry its counter, so
            // the push would not find it ahead: the note sends it to the merge
            const standDown = {
                ...(seen ? { [KEY_GIST_VERSION]: seen } : {}),
                ...(replaced ? { [KEY_UNAPPLIED]: { since: remoteAt } } : {}),
            };
            if (Object.keys(standDown).length) await rememberLocal(standDown);
            console.warn('[Sync] Silent pull found both sides changed; the next automatic push merges them.');
            return { ok: true, skipped: true, reason: 'conflict' };
        }
        if (localChanged && !silent) {
            const answer = await askChoice({
                title: 'Sync conflict',
                message:
                    `The copy on GitHub is newer (${formatWhen(remoteAt)}), and this device has changed ` +
                    'since it last synced.\n\n' +
                    'Histories that only ever grow — treasure tallies, market listings, XP series, trial ' +
                    'records, labyrinth runs — are combined either way, so nothing recorded on either side ' +
                    'is lost. Settings and edited lists (watchlists, plans, custom tabs) can only take one ' +
                    "side, and that is what this asks: applying the GitHub copy replaces this device's.",
                choices: [
                    { value: 'merge', label: 'Merge and push the result back', tone: 'primary' },
                    { value: 'pull', label: 'Apply the GitHub copy here only' },
                    { value: 'push', label: 'Keep this device and push' },
                    { value: null, label: 'Do nothing' },
                ],
            });
            // The dialog above is the one this file's "wedged" comments are
            // about — it can sit open for as long as the player ignores it.
            // A takeover during that wait means an operation with a fresher
            // view of both the database and the gist has already run; this
            // pull's decision was made against a snapshot that no longer
            // exists, and applying it now would silently undo whatever that
            // operation just did.
            if (!this._stillOwns(opToken)) return this._supersededResult(silent, 'pull', opToken);
            if (answer === 'push') return this._doPush(false, opToken);
            if (answer !== 'pull' && answer !== 'merge') return { ok: true, skipped: true, reason: 'cancelled' };
            pushBack = answer === 'merge';
        }

        // Last check before the write that actually lands in IndexedDB. On the
        // no-dialog path this catches a slow download or fingerprint taking
        // long enough for a takeover — the same "wedged" shape as the dialog
        // above, just without a dialog to point at.
        if (!this._stillOwns(opToken)) return this._supersededResult(silent, 'pull', opToken);

        const baseline = await storage.get(KEY_BASELINE, STORE, null);
        const { merged, mergeFailed, mergeHeld, complete, failed, applied, expected } = await applyPayload(payload, {
            mode: silent ? 'merge' : 'pull',
            baseline,
        });
        const pendingHeld = mergeHeld?.length ? { exportedAt: remoteAt, hash: contentHash(payload) } : null;

        // An import already in progress cannot be cancelled between its store
        // transactions. If cleanup happened during it, leave the remote stamp
        // alone so a fresh session can retry instead of claiming completion.
        // The import may have held back an unreadable local history and latched
        // restored stores against further writes. Guard the remote copy from a
        // switch push and tell the new screen to reload, even though the old
        // operation no longer owns its normal success toast.
        if (!this._stillOwns(opToken)) {
            if (pendingHeld) await rememberLocal({ [KEY_MERGE_HELD]: pendingHeld });
            console.warn('[Sync] Pull import finished after cleanup; leaving the sync stamp for a retry.');
            showToast('Sync imported data during a character switch. Reload now before making more changes.', {
                kind: 'warn',
                duration: 0,
            });
            return { ok: false, reason: 'stopped-after-apply' };
        }

        // A pull that wrote nothing must not move the stamp. Remembering the
        // remote's `exportedAt` after a failed apply makes every later pull
        // answer 'not-newer' — the data never arrives and sync reports success
        // for ever. One store aborting its transaction is enough to get here.
        if (complete === false) {
            const stores = (failed || []).map((entry) => entry.store).join(', ');
            console.error('[Sync] The pull did not apply cleanly; leaving the sync stamp alone.', failed);
            showToast(
                `Sync pull could not write ${stores || 'some stores'}. Nothing was recorded as synced — ` +
                    'free some space or reload and try again.',
                { kind: 'error', duration: 0 }
            );
            return { ok: false, reason: 'incomplete-apply' };
        }

        // If rebuilding the post-import fingerprint fails, the pull has still
        // applied other records. Leave a durable guard before that read, so a
        // later push cannot replace the records this pull held back.
        if (pendingHeld) await rememberLocal({ [KEY_MERGE_HELD]: pendingHeld });

        // The loop guard. An automatic merge goes back up only when this
        // device's copy, folded into the gist's the way the other device will
        // fold it, would change something. Otherwise the two devices would
        // trade the same union back and forth for ever. The fingerprint
        // remembered follows: the gist's own text when a push is owed (so the
        // push, and its retry if it fails, sees this device as changed), and
        // the rebuilt copy when not (so nothing does).
        let mergedRebuild = null;
        let pushOwed = false;
        if (silent && !mergeHeld?.length) {
            mergedRebuild = await buildPayloadJSON(config.getSetting('sync_scope', 'settings'));
            pushOwed = addsToRemote(mergedRebuild, payload);
            // Also owed when this device's scope or cleaning would take something
            // out of the gist (a Settings-only device pulling a gist that still
            // holds history stores): the trimmed upload is what stops every
            // device downloading them. The remembered fingerprint then stays the
            // gist's, so the push is not 'unchanged'; once it lands, it is.
            if (!pushOwed) {
                try {
                    pushOwed = mergeForUpload(mergedRebuild, payload, null).dropsFromRemote;
                } catch (error) {
                    console.warn('[Sync] Could not check whether the gist holds more than this device syncs:', error);
                }
            }
        }

        await this._remember({
            gistId,
            exportedAt: remoteAt,
            // The CONTENT hash of what was APPLIED — remembered so the next
            // local rebuild of the same content compares equal. Not the raw
            // download: a merging pull rewrites the payload before importing
            // it, so the downloaded text describes something that was never
            // stored. The manifest's own hash (older devices hashed the raw
            // text, stamp included) could never match a rebuild either, and
            // manufactured a permanent conflict.
            // Held-back records remain on this device even though they were
            // removed from `applied`; fingerprint the actual local snapshot
            // so a retry does not mistake that expected difference for an edit.
            hash: mergedRebuild
                ? contentHash(pushOwed ? payload : mergedRebuild)
                : mergeHeld?.length
                  ? contentHash(await buildPayloadJSON(config.getSetting('sync_scope', 'settings')))
                  : contentHash(applied ?? payload),
            chunkCount: Number(manifest?.chunks) || 0,
            // Lamport's rule on receive: this device is now at least as far
            // along as the payload it accepted. Written only here, after the
            // `complete === false` return above — a counter advanced by a
            // half-applied pull would make the retry answer 'not-newer' and
            // the data would never arrive, which is the same trap the stamp
            // already has to avoid.
            syncSeq: advanceSeq(lastSeq, remoteSeq),
            mergeHeld: pendingHeld,
            // Applied whole, this version is now this device's. Held-back
            // records mean it is not yet, and the retry must re-download it.
            version: seen ? { ...seen, current: !pendingHeld } : null,
            // One transaction with the stamp and counter, as on the push side
            extra: {
                // The gist's values are now the last exchange: a key this device
                // kept over an unmoved gist value stays "moved here" against it
                [KEY_BASELINE]: wholeKeyHashes(payload),
                // Whatever an automatic merge left in the gist has landed now —
                // unless records were held back, which the retry has to take
                ...(pendingHeld ? {} : { [KEY_UNAPPLIED]: null }),
            },
        });

        // Every figure below comes out of the apply result; nothing here re-reads
        // storage to find out what changed. See `pull-summary.js` for what that
        // bounds — the unchanged count among them, which is reported as unknown.
        const summary = buildPullSummary({
            merged,
            mergeFailed,
            mergeHeld,
            expected,
            at: new Date().toISOString(),
        });
        rememberPullSummary(summary);

        // A record whose fold threw took the remote copy whole, which is this
        // device's entries for it gone. The pull still succeeded, so this is a
        // sentence rather than an error — but an unqualified "records were
        // combined" over it would be a claim about data that was in fact
        // overwritten.
        const notCombined = mergeFailed?.length
            ? ` ${mergeFailed.length} could not be combined and took the downloaded copy ` +
              `(${mergeFailed.map((entry) => entry.label).join(', ')}).`
            : '';
        // A record whose local copy could not be READ kept that copy and did
        // not take the download at all — the opposite outcome to the line
        // above, and one the player has to be able to tell apart, because the
        // fix is different: this one says the database is unhealthy and the
        // downloaded entries are still waiting on the next pull.
        // The count is in the summary line above, so this fragment only has to
        // name the records and say what to do about them.
        const heldBack = mergeHeld?.length
            ? ` The records kept from this device (${mergeHeld.map((entry) => entry.label).join(', ')}) ` +
              'could not be read here; pull again once storage is healthy. Pushes are paused until then.'
            : '';
        // Not politeness: the stores this pull replaced stop accepting writes
        // until the reload (see `storage.finishRestore`), because anything this
        // session still holds in memory is the pre-pull copy and writing it
        // back would undo the pull. Saying so is the difference between a
        // reload the player chooses and changes they lose without being told.
        showToast(
            `Synced from GitHub. ${formatPullSummaryLine(summary)}${notCombined}${heldBack} Reload now — ` +
                'changes made before reloading will not be kept.',
            {
                duration: 0,
                kind: notCombined || heldBack ? 'warn' : 'info',
                action: { label: 'What changed?', onClick: () => openPullSummaryPanel() },
            }
        );

        // The union only exists on this device until it is sent up. Pushing it
        // now is what stops the other device pulling the pre-merge copy back
        // and re-opening the same conflict. `_remember` above already recorded
        // the remote's stamp, so this push is no longer a "never synced" one
        // and will not stop to ask.
        if (pushBack && !mergeHeld?.length) {
            const pushed = await this._doPush(false, opToken);
            return { ok: true, merged: merged?.length || 0, pushedBack: pushed?.ok === true && !pushed?.skipped };
        }

        if (pushBack && mergeHeld?.length) return { ok: true, merged: merged?.length || 0, pushedBack: false };

        return { ok: true, merged: merged?.length || 0 };
    }

    /**
     * Ready a full backup for restoring: stamp the settings it lands as
     * changed now (see `restampRestoredSettings`). Call before importing it.
     * @param {Object} payload - The parsed backup, mutated in place
     * @returns {void}
     */
    prepareFullRestore(payload) {
        restampRestoredSettings(payload);
    }

    /**
     * Record that a full backup was restored, so the next merge takes the keys
     * it wrote as this device's newer copy instead of reverting them to the
     * gist's (see `RESTORED_BASELINE`). Call after the restore, with the stores
     * that landed whole — a partial restore latched those, and they are as
     * much the player's choice as a complete one.
     *
     * Only the keys the backup held are recorded. Anything else in those
     * stores — a key created after the backup was taken — was left as it
     * was, and is merged against its last exchange as before.
     *
     * @param {Object} payload - The backup that was restored
     * @param {Array<string>} storeNames - Stores the restore wrote in full
     * @returns {Promise<void>}
     */
    async noteFullRestore(payload, storeNames = []) {
        const keys = {};
        for (const storeName of storeNames) {
            const entries = payload?.stores?.[storeName];
            if (entries && typeof entries === 'object') keys[storeName] = Object.keys(entries);
        }
        if (Object.keys(keys).length === 0) return;
        // Added to the baseline rather than replacing it: a key the restore
        // did not write keeps its last exchange to be merged against
        const baseline = (await storage.get(KEY_BASELINE, STORE, null)) || {};
        await rememberLocal({
            [KEY_BASELINE]: { ...baseline, [RESTORED_BASELINE]: { at: Date.now(), keys } },
        });
    }

    /**
     * Forget which gist this device uses, without touching the gist itself.
     * The next push discovers or creates one.
     * @returns {Promise<void>}
     */
    async forgetGist() {
        await rememberLocal({
            [KEY_GIST_ID]: null,
            [KEY_LAST_SYNCED_AT]: null,
            [KEY_LAST_HASH]: null,
            [KEY_CHUNK_COUNT]: 0,
            // The counter counts exchanges with the gist we just forgot. Kept,
            // it would make the first push to a NEW gist claim a counter above
            // everything that gist has ever carried, and the devices already
            // on it would read their own newer payloads as older.
            [KEY_LAST_SYNCED_SEQ]: null,
            // The push stamp belongs to the gist we just forgot. Leaving it behind makes
            // the next gist look like somewhere this device has already pushed to, which
            // is exactly the check that decides whether a first push stops to ask.
            [KEY_LAST_PUSHED_AT]: null,
            [KEY_MERGE_HELD]: null,
            [KEY_GIST_VERSION]: null,
            [KEY_UNAPPLIED]: null,
            [KEY_BASELINE]: null,
            [KEY_LAST_PUSHED_VERSION]: null,
            [KEY_MERGE_ON_TRIM]: null,
        });
    }

    /**
     * A one-line summary for the settings panel.
     * @returns {Promise<string>} Status text
     */
    async describeStatus() {
        if (!config.getSetting('sync_enabled', false)) return 'Sync is off.';
        if (!this._token()) return 'Sync is on, but no GitHub token is set.';
        const gistId = await storage.get(KEY_GIST_ID, STORE, null);
        const lastSyncedAt = await storage.get(KEY_LAST_SYNCED_AT, STORE, null);
        if (!gistId) return 'Ready. No gist yet — press Push to create one.';
        return lastSyncedAt ? `Last synced ${formatWhen(lastSyncedAt)}.` : 'Linked to a gist, not yet synced.';
    }

    /**
     * The token, trimmed. Never logged, never put in a URL, never returned to
     * anything outside this module.
     * @returns {string} Token, or empty string
     * @private
     */
    _token() {
        const raw = config.getSetting('sync_token', '');
        return typeof raw === 'string' ? raw.trim() : '';
    }

    /**
     * The sync passphrase, trimmed. Empty means "sync in the clear", which is
     * what every gist written before this setting existed is.
     * @returns {string} Passphrase, or empty string
     * @private
     */
    _passphrase() {
        const raw = config.getSetting('sync_passphrase', '');
        return typeof raw === 'string' ? raw.trim() : '';
    }

    /**
     * Start (or decline to start) the automatic schedule.
     *
     * One tab per browser runs it. Every tab used to run its own, so four
     * characters open meant four quarter-hourly pushes and four silent pulls of
     * one and the same device-wide database — the operation lock only stopped
     * them overlapping. The leader is whichever tab holds the
     * {@link LEADER_LOCK} Web Lock; the others queue on it, and the browser
     * hands it to one of them when the leader's tab closes or its feature is
     * cleaned up. Without Web Locks every tab schedules, as before.
     * @private
     */
    _startAuto() {
        if (!config.getSetting('sync_auto', false) || !this.isConfigured()) return;

        // Every tab that starts pulls a few times early, leader or not: a tab opened on a character another
        // device just handed off must collect that handoff now, not at the leader's next interval. Only
        // the repeating schedule is the leader's. An unchanged gist answers these with an empty 304.
        for (const delay of STARTUP_PULL_DELAYS_MS) {
            this.timers.scheduleTimeout(() => {
                this.pull({ silent: true, startup: true });
            }, delay);
        }

        const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
        if (typeof locks?.request !== 'function') {
            this._scheduleAuto();
            return;
        }
        this._requestLeadership(locks);
    }

    /**
     * Queue for the leader lock, and run the automatic schedule while holding it.
     *
     * The lock is held by a promise that only `_releaseLeadership` settles, so
     * leadership lasts until cleanup, a restart, or the tab going away. A
     * request still queued at release is aborted, so a torn-down instance never
     * becomes leader afterwards.
     * @param {LockManager} locks - `navigator.locks`
     * @private
     */
    _requestLeadership(locks) {
        this._releaseLeadership();
        const ticket = {};
        const controller = typeof AbortController === 'function' ? new AbortController() : null;
        let release;
        const held = new Promise((resolve) => {
            release = resolve;
        });
        this.leadership = { ticket, release, controller };

        const options = controller ? { signal: controller.signal } : {};
        // A lock manager that refuses outright (a SecurityError, an unsupported option) must not leave
        // this tab with no schedule at all: it runs the schedule itself, as with no Web Locks
        const unled = (error) => {
            if (this.leadership?.ticket !== ticket || this.isLeader) return;
            console.warn('[Sync] Could not take the sync-leader lock; this tab runs its own schedule:', error);
            this.isLeader = true;
            this._scheduleAuto();
        };
        let granted;
        try {
            traceSync('leader-requested');
            granted = locks.request(LEADER_LOCK, options, async () => {
                if (this.leadership?.ticket !== ticket) {
                    traceSync('leader-granted-stale');
                    return;
                }
                traceSync('leader-granted');
                this.isLeader = true;
                this._scheduleAuto();
                await held;
            });
        } catch (error) {
            unled(error);
            return;
        }
        Promise.resolve(granted).catch((error) => {
            // Aborted while queued is our own release, not a failure
            if (error?.name === 'AbortError') return;
            unled(error);
        });
    }

    /**
     * Give up leadership, or stop queueing for it. Timers are the caller's to
     * clear; this only lets the lock go.
     * @private
     */
    _releaseLeadership() {
        const current = this.leadership;
        if (current) traceSync('leader-released', { wasLeader: this.isLeader });
        this.leadership = null;
        this.isLeader = false;
        if (!current) return;
        current.release();
        current.controller?.abort();
    }

    /**
     * The leader's repeating schedule (the startup pulls are every tab's, see `_startAuto`): the push
     * interval, and the silent-pull interval offset between pushes.
     * @private
     */
    _scheduleAuto() {
        traceSync('schedule-started');
        this.timers.registerInterval(
            setInterval(() => {
                this.push({ silent: true, unattended: true });
            }, AUTO_PUSH_INTERVAL_MS)
        );

        // The other half of a two-device loop: the pushes above put changes up,
        // and this brings the other device's changes down while both stay open.
        // A silent pull is safe to run unattended — it applies only a clean
        // fast-forward (remote newer, nothing changed here) and stands down on
        // a conflict without asking.
        this.timers.scheduleTimeout(() => {
            this.timers.registerInterval(
                setInterval(() => {
                    this.pull({ silent: true });
                }, AUTO_PUSH_INTERVAL_MS)
            );
            this.pull({ silent: true });
        }, AUTO_PULL_OFFSET_MS);
    }

    /**
     * Push the moment another login takes this session over.
     *
     * The game replaces the page with its connection banner when a second
     * device logs the character in; the socket is gone but GitHub is not, so
     * this is the last, best moment to hand the session's changes to the
     * device that just took over — whose own staggered startup pulls will
     * collect them seconds later. Once per banner: the flag rearms only after
     * the banner goes away (a reconnect), so a flickering connection does not
     * hammer the gist.
     * @private
     */
    _watchHandoff() {
        if (!config.getSetting('sync_onSwitch', false) || !this.isConfigured()) return;
        this.handoffUnregister = domObserver.onClass('SyncHandoff', 'GamePage_connectionMessage', () => {
            if (this.handoffPushed) return;
            if (!document.querySelector(GAME.CONNECTION_MESSAGE)) return;
            this.handoffPushed = true;
            this.push({ silent: true, unattended: true });
            // Rearm when the banner clears — checked lazily on the next appearance
            const rearm = setInterval(() => {
                if (!document.querySelector(GAME.CONNECTION_MESSAGE)) {
                    this.handoffPushed = false;
                    clearInterval(rearm);
                }
            }, 30 * 1000);
            this.timers.registerInterval(rearm);
        });
    }

    /**
     * The gist to use: the one this device remembers, else one already on the
     * account (which is how a second device finds the first one's gist from
     * nothing but the same token), else none.
     *
     * Null is the answer for "there isn't one", which `push` reads as "create
     * it" and `pull` reads as "nothing to read yet".
     *
     * @param {string} token - GitHub token
     * @returns {Promise<string|null>} Gist id, or null when the account has none
     * @private
     */
    async _resolveGistId(token) {
        const stored = await storage.get(KEY_GIST_ID, STORE, null);
        if (stored) return stored;

        const found = await findSyncGist(token);
        if (found) {
            await rememberLocal({ [KEY_GIST_ID]: found });
            return found;
        }

        return null;
    }

    /**
     * Record what this device now believes about the gist.
     * @param {{gistId: string, exportedAt: string, hash: string, chunkCount: number,
     *   syncSeq?: number|null, mergeHeld?: Object|null, version?: Object|null, extra?: Object}} state - New state. `syncSeq`
     *   is null for an exchange with a gist that carries no counter, which must not invent one. `mergeHeld`
     *   is passed only by a pull, which is the one exchange that can land or hold back records; a push leaves
     *   the marker alone. `version` is the gist version the exchange leaves behind (see KEY_GIST_VERSION).
     *   `extra` is any other bookkeeping that must land in the same transaction.
     * @private
     */
    async _remember({
        gistId,
        exportedAt,
        hash,
        chunkCount,
        syncSeq = null,
        mergeHeld = undefined,
        version,
        extra = {},
    }) {
        await rememberLocal({
            ...extra,
            [KEY_GIST_ID]: gistId,
            [KEY_LAST_SYNCED_AT]: exportedAt,
            [KEY_LAST_HASH]: hash,
            [KEY_CHUNK_COUNT]: chunkCount,
            [KEY_LAST_SYNCED_SEQ]: syncSeq,
            // In the same transaction as the stamp it vouches for: a version
            // marked current with an older stamp beside it would let a 304
            // skip a pull the stamp says is still owed
            [KEY_GIST_VERSION]: version ?? null,
            ...(mergeHeld === undefined ? {} : { [KEY_MERGE_HELD]: mergeHeld }),
        });
    }

    /**
     * The remembered gist version, if it is for this gist and well formed.
     * @param {string|null} gistId - The gist about to be read or written
     * @returns {Promise<{gistId: string, etag: string, files: Record<string, number>, current: boolean}|null>}
     *   The version, or null
     * @private
     */
    async _knownVersion(gistId) {
        if (!gistId) return null;
        const stored = await storage.get(KEY_GIST_VERSION, STORE, null);
        if (!stored || stored.gistId !== gistId || typeof stored.etag !== 'string' || !stored.etag) return null;
        if (!stored.files || typeof stored.files !== 'object') return null;
        return stored;
    }

    /**
     * Guard, classify and report one sync operation.
     *
     * The `busy` lock is not politeness: two pushes racing can interleave chunk
     * writes and leave a gist whose manifest describes neither payload, and a
     * push racing a pull tears `buildPayloadJSON`, which reads the stores one
     * after another while the pull is rewriting them.
     *
     * It holds a token rather than `true` because of the takeover below. When a
     * wedged operation is taken over, the wedged one is still running — and its
     * own `finally` would clear a flag it no longer owns, unlocking mid-takeover
     * and admitting a third operation alongside the second. Each operation
     * clears the lock only if the token in it is still the one it took.
     *
     * @param {string} label - 'push' or 'pull', for messages
     * @param {boolean} silent - Suppress the "nothing to do" chatter
     * @param {Function} operation - The work
     * @returns {Promise<{ok: boolean, skipped?: boolean, reason?: string}>} Outcome
     * @private
     */
    /**
     * Run a sync under a browser-wide lock, so tabs queue instead of racing.
     *
     * The automatic schedule runs in one tab (see `_startAuto`), but manual,
     * character-switch and handoff syncs run in whichever tab asked, and two
     * pushes to one gist at once get the loser a 409. The `busy` flag above is
     * per-tab; this is the cross-tab half, and it never waits: the lock is
     * taken only if free (a held lock is a sync running in another tab), and
     * Web Locks release on their own when a tab dies, so nothing can wedge it
     * open for ever. A takeover of a stuck same-tab sync bypasses this — the
     * stuck operation is the one holding the lock. No Web Locks API (an old
     * browser) runs unguarded, as before.
     *
     * @param {boolean} silent - Whether this is an interval sync nobody asked for
     * @param {Function} operation - What to run, called with this call's `busy` token
     * @param {number} opToken - This call's `busy` ownership token, forwarded to `operation`
     * @returns {Promise<*>} The operation's result, or a skipped outcome
     * @private
     */
    async _withCrossTabLock(silent, operation, opToken) {
        const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
        if (typeof locks?.request !== 'function') return operation(opToken);

        let ran = false;
        let outcome;
        await locks.request('toolasha-sync', { ifAvailable: true }, async (lock) => {
            if (!lock) return;
            ran = true;
            outcome = await operation(opToken);
        });
        if (ran) return outcome;

        // Another tab's sync holds the lock right now. An interval tick has
        // nothing to add — the next tick re-checks. A manual operation must
        // be reported, not run outside the lock: a 409 retry merely replays a
        // stale whole-gist snapshot and cannot protect the other tab's update.
        if (silent) return { ok: true, skipped: true, reason: 'another-tab' };
        showToast('Sync is running in another tab. Try again when it finishes.', { kind: 'warn' });
        return { ok: false, reason: 'another-tab' };
    }

    /**
     * Whether the `busy` lock this call took is still the one in effect.
     *
     * A takeover (see `_run`) does not stop the operation it replaces — it
     * cannot; there is nothing to cancel a hung request or a dialog nobody has
     * answered. It only stops *honouring* that operation's lock. The operation
     * itself is still running, and when it finally gets an answer — a user
     * clicking a conflict dialog they left open ten minutes ago, or a `fetch`
     * fallback's request finally resolving — it is about to act on a
     * database and a gist that have since moved on under a newer operation.
     * Every write that follows such a wait checks this first, so a superseded
     * operation stands down instead of overwriting what the takeover wrote.
     *
     * @param {number} opToken - The token this operation's `_run` call took
     * @returns {boolean} True while this operation still owns `busy` and was not cancelled by cleanup
     * @private
     */
    _stillOwns(opToken) {
        // Cleanup keeps a cancelled operation's lock held (see `cleanup`) but
        // stops honouring its work, the same way a takeover does.
        return this.busy === opToken && opToken > (this.lastCancelledToken || 0);
    }

    /**
     * What a push or pull returns when it discovers, after a wait, that a
     * takeover has already run in its place.
     * @param {boolean} silent - Whether to say anything about it
     * @param {string} label - 'push' or 'pull'
     * @param {number} opToken - The superseded operation's ownership token
     * @returns {{ok: boolean, skipped: boolean, reason: string}} Outcome
     * @private
     */
    _supersededResult(silent, label, opToken) {
        const stopped = opToken <= (this.lastCancelledToken || 0);
        console.warn(
            stopped
                ? `[Sync] A ${label} finished after cleanup; discarding its result.`
                : `[Sync] A ${label} was superseded by a takeover while it was waiting; discarding its result.`
        );
        // Cleanup means the old character has gone away. A status toast from
        // that operation belongs to the previous screen, not the new one.
        if (!silent && !stopped) {
            showToast(
                `Sync ${label} was overtaken by a newer sync while it waited. Nothing was lost — try again if needed.`
            );
        }
        return { ok: true, skipped: true, reason: 'superseded' };
    }

    async _run(label, silent, operation) {
        const outcome = await this._runUntraced(label, silent, operation);
        traceSync(label, {
            silent,
            isLeader: this.isLeader,
            ok: outcome?.ok,
            reason: outcome?.reason ?? (outcome?.skipped ? 'skipped' : null),
        });
        return outcome;
    }

    /**
     * `_run`'s body: the guards and the operation, without the trace entry.
     * @private
     */
    async _runUntraced(label, silent, operation) {
        if (!config.getSetting('sync_enabled', false)) {
            if (!silent) showToast('Cross-device sync is turned off.', { kind: 'warn' });
            return { ok: false, reason: 'disabled' };
        }
        if (!this._token()) {
            if (!silent) showToast('Add a GitHub token in Settings → Cross-Device Sync first.', { kind: 'warn' });
            return { ok: false, reason: 'no-token' };
        }
        let takingOver = false;
        if (this.busy) {
            // A sync that has been "running" this long is a wedged one — a
            // hung request or an abandoned dialog — and honouring its lock
            // forever is how auto-push died quietly for days. Take over.
            if (Date.now() - (this.busySince || 0) > BUSY_STUCK_MS) {
                console.warn(
                    `[Sync] A ${label} is taking over a sync stuck busy since ${new Date(this.busySince).toISOString()}.`
                );
                takingOver = true;
            } else {
                if (!silent) showToast('A sync is already running.', { kind: 'warn' });
                return { ok: false, reason: 'busy' };
            }
        }

        const token = (this._busySeq = (this._busySeq || 0) + 1);
        this.busy = token;
        this.busySince = Date.now();
        try {
            // A takeover skips the cross-tab lock: the wedged operation it is
            // replacing is the very thing still holding it
            return await (takingOver ? operation(token) : this._withCrossTabLock(silent, operation, token));
        } catch (error) {
            if (!this._stillOwns(token)) return this._supersededResult(silent, label, token);
            // GistError messages are written to be shown; anything else is a bug
            // here and gets a generic message with the detail in the console.
            // Neither path can carry the token: it only ever appears in a header.
            if (error instanceof GistError) {
                console.warn(`[Sync] ${label} failed (${error.kind})`, error.githubMessage || '');
                if (error.kind === 'not-found') await this.forgetGist();
                // A corrupt or newer-format gist fails every unattended sync the
                // same way until someone pushes over it. One sticky toast says
                // so; repeating it every interval only stacks them.
                const repeat = `${error.kind}:${error.message}`;
                this._toastedSilently = this._toastedSilently || new Set();
                if (silent && error.kind === 'parse' && this._toastedSilently.has(repeat)) {
                    return { ok: false, reason: error.kind };
                }
                if (silent && error.kind === 'parse') this._toastedSilently.add(repeat);
                showToast(describeFailure(label, error), {
                    kind: error.kind === 'rate-limit' ? 'warn' : 'error',
                    // A failure the player has to act on must not fade before
                    // they have read what to do about it
                    duration: ACTIONABLE_KINDS.has(error.kind) ? 0 : undefined,
                });
            } else {
                console.error(`[Sync] ${label} failed:`, error);
                showToast(
                    `Sync ${label} failed: ${error?.message || 'unexpected error'}. Try again; if it keeps ` +
                        'happening, reload the page — the console has the detail.',
                    { kind: 'error' }
                );
            }
            return { ok: false, reason: error instanceof GistError ? error.kind : 'error' };
        } finally {
            // Only if nobody took over: the wedged operation this one replaced
            // may still be in flight, and its `finally` must not unlock ours
            if (this.busy === token) this.busy = false;
        }
    }
}

/**
 * What to do about each kind of failure.
 *
 * `GistError.message` already says what went wrong, and for the two failures
 * that resolve themselves — a rate limit, a dead network — it also says when to
 * come back, so those get nothing added. The rest need a next step, because a
 * toast that says only "GitHub rejected the token" leaves the reader with no
 * idea that the token is a text box two clicks away.
 */
const REMEDIES = {
    auth: 'Check the token in Settings → Cross-Device Sync — it needs the "gist" scope.',
    'not-found': 'This device has forgotten that gist; press Push to make a new one.',
    'too-large': 'Set Sync scope to "Settings only" in Settings → Cross-Device Sync.',
    passphrase: 'Enter the same sync passphrase in Settings → Cross-Device Sync on every device that shares the gist.',
    parse: 'Push from a device whose data is good to replace what is in the gist.',
    http: 'Try again shortly; githubstatus.com says whether GitHub itself is unwell.',
};

/** Failures the player has to do something about, so their toast stays up */
const ACTIONABLE_KINDS = new Set(Object.keys(REMEDIES));

/**
 * One line saying which half of sync failed, why, and what to do about it.
 * @param {string} label - 'push' or 'pull'
 * @param {GistError} error - The classified failure
 * @returns {string} Toast text
 */
function describeFailure(label, error) {
    const remedy = REMEDIES[error.kind];
    return `Sync ${label} failed: ${error.message}${remedy ? ` ${remedy}` : ''}`;
}

/**
 * Write this device's sync bookkeeping.
 *
 * Through `putAll` rather than `set`, for one reason: applying a pull latches
 * the stores it replaced against pre-restore writes (see
 * `storage.finishRestore`), and the settings store is always one of them. This
 * bookkeeping is written *after* the apply and is not pre-restore state — it is
 * the record that the apply happened — so it goes down the bulk path and says
 * so explicitly with `bypassRestoreLatch`. Written through `set` it would be
 * silently refused, and a pull that cannot record its own stamp re-applies the
 * same payload for ever. The flag is deliberate rather than inherited: the bulk
 * path is latched like every other write now, because the recorders that hold a
 * store in memory flush through it too.
 *
 * One transaction for the lot is also simply what these four keys want.
 *
 * @param {Record<string, *>} entries - Bookkeeping keys to write
 * @returns {Promise<void>}
 */
async function rememberLocal(entries) {
    const written = await storage.putAll(STORE, entries, { bypassRestoreLatch: true });
    const expected = Object.keys(entries).length;
    if (written !== expected) {
        console.error(`[Sync] Only ${written}/${expected} sync bookkeeping keys were written`);
    }
}

/**
 * Check a reassembled payload against what the manifest says it should be.
 *
 * The manifest already carries the plaintext length and a content hash, and
 * nothing was checking either — so a chunk file truncated by a hand edit, a
 * half-written push, or a gist the API returned short would be parsed as far as
 * it went and applied. A pull that fails loudly is recoverable; a pull that
 * applies half a database is not.
 *
 * Both fields are optional: a gist written by a build from before they existed
 * has neither, and must still read. `hash` is accepted in either of the two
 * forms this script has written — the content hash, and the older raw-text hash
 * that included the `exportedAt` stamp.
 *
 * @param {Object} manifest - The gist's manifest
 * @param {string} payload - The decrypted, decompressed payload text
 * @returns {void}
 * @throws {GistError} With kind 'parse' when the payload is not what was pushed
 */
function verifyAgainstManifest(manifest, payload) {
    const expectedBytes = Number(manifest?.bytes);
    if (Number.isFinite(expectedBytes) && expectedBytes > 0 && payload.length !== expectedBytes) {
        throw new GistError(
            'parse',
            `The sync gist is incomplete: its manifest describes ${expectedBytes} characters but ` +
                `${payload.length} came back.`
        );
    }

    const expectedHash = manifest?.hash;
    if (typeof expectedHash === 'string' && expectedHash) {
        if (contentHash(payload) !== expectedHash && hashPayload(payload) !== expectedHash) {
            throw new GistError(
                'parse',
                'The sync gist does not match its own manifest checksum — it looks corrupted or edited by hand.'
            );
        }
    }
}

/**
 * A gist version record (see KEY_GIST_VERSION), or null when the response did
 * not carry what one needs.
 * @param {string} gistId - Gist id
 * @param {string|null|undefined} etag - The response's ETag
 * @param {Record<string, number>|null|undefined} files - File sizes from the same response
 * @param {boolean} current - This device's data already reflects this version
 * @param {{syncSeq?: *, encrypted?: *}|null|undefined} manifest - The manifest of that version. Its counter
 *   and whether it is encrypted are kept beside the ETag, because a push that gets a 304 against this record
 *   reads both from it rather than from the gist (see `writeSyncGist`).
 * @returns {{gistId: string, etag: string, files: Record<string, number>, current: boolean,
 *   syncSeq: number|null, encrypted: boolean}|null} Record
 */
function gistVersion(gistId, etag, files, current, manifest) {
    if (!gistId || typeof etag !== 'string' || !etag || !files || typeof files !== 'object') return null;
    return {
        gistId,
        etag,
        files,
        current: Boolean(current),
        syncSeq: readSeq(manifest?.syncSeq),
        encrypted: Boolean(manifest?.encrypted),
        // The history version it is, so a write listed against it by a 304
        // still knows what it was based on
        version: typeof manifest?.version === 'string' ? manifest.version : null,
    };
}

/**
 * Whether a gist listing is a different version from the one this device last
 * saw. Only a matching history version, or failing that a matching ETag, proves
 * it is the same; with no record to compare against, it may have moved.
 * @param {{version?: string|null, etag?: string|null}} listed - The fresh listing
 * @param {{version?: string|null, etag?: string|null}|null} seen - The version record this device holds
 * @returns {boolean} True unless the listing is provably the version already seen
 */
function listingMoved(listed, seen) {
    if (typeof listed?.version === 'string' && typeof seen?.version === 'string') {
        return listed.version !== seen.version;
    }
    if (typeof listed?.etag === 'string' && listed.etag && typeof seen?.etag === 'string') {
        return listed.etag !== seen.etag;
    }
    return true;
}

/**
 * A Lamport counter, or null for "this side carries none".
 *
 * Null is the whole compatibility story: a gist written before the counter
 * existed has no `syncSeq`, a device that has only ever exchanged with such a
 * gist has none stored, and both must go on being ordered by their timestamps.
 * So anything that is not a plain non-negative integer — absent, a boolean, a
 * hand-edited string, a float, `Infinity` — reads as "none" rather than as a
 * number to compare against.
 *
 * @param {*} value - Raw manifest field or stored bookkeeping value
 * @returns {number|null} The counter, or null when there isn't one
 */
function readSeq(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    if (typeof value === 'string' && value.trim() === '') return null;
    const seq = Number(value);
    return Number.isSafeInteger(seq) && seq >= 0 ? seq : null;
}

/**
 * This device's counter after accepting a payload — Lamport's receive rule.
 *
 * A payload with no counter must not reset one this device already has (that is
 * the mixed fleet: an old device's push would otherwise drag the new device
 * back to zero and let it re-apply payloads it has already taken), and must not
 * start one either, because a device with a counter and a gist without one
 * still has nothing to compare.
 *
 * @param {number|null} localSeq - What this device had
 * @param {number|null} incomingSeq - What the accepted payload carried
 * @returns {number|null} The counter to store
 */
function advanceSeq(localSeq, incomingSeq) {
    if (localSeq === null && incomingSeq === null) return null;
    return Math.max(localSeq ?? 0, incomingSeq ?? 0);
}

/**
 * Is `candidate` strictly after `reference`? An absent reference counts as
 * "never synced", so anything at all is newer.
 *
 * The counters decide it only when both sides have one, and only when they
 * differ. Two reasons for that shape, and both are compatibility:
 *
 * - One side without a counter is an old gist or an old device, and there is
 *   nothing to compare — the stamps answer it exactly as they always did.
 * - EQUAL counters are two devices that pushed from the same base without
 *   seeing each other. Reading that as "not newer" would make each device skip
 *   the other's push for ever and the two would never converge, so a tie falls
 *   through to the stamps, which raise the conflict the tie actually is and
 *   let the merge take both.
 *
 * @param {string|null} candidate - ISO timestamp
 * @param {string|null} reference - ISO timestamp
 * @param {number|null} [candidateSeq] - Counter the candidate carries, if any
 * @param {number|null} [referenceSeq] - Counter this device has recorded, if any
 * @returns {boolean} True when candidate wins
 */
function isNewer(candidate, reference, candidateSeq = null, referenceSeq = null) {
    if (candidateSeq !== null && referenceSeq !== null && candidateSeq !== referenceSeq) {
        return candidateSeq > referenceSeq;
    }
    if (!candidate) return false;
    if (!reference) return true;
    const a = Date.parse(candidate);
    const b = Date.parse(reference);
    if (!Number.isFinite(a)) return false;
    if (!Number.isFinite(b)) return true;
    return a > b;
}

/**
 * A timestamp a person can read.
 * @param {string|null} iso - ISO timestamp
 * @returns {string} Local string, or 'unknown'
 */
function formatWhen(iso) {
    if (!iso) return 'unknown';
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? 'unknown' : date.toLocaleString();
}

const syncManager = new SyncManager();
export default syncManager;
export { SyncManager, isNewer };
