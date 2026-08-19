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
 * `exportedAt`, newest wins, and the only case that asks a question is the one
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
 * "Has this device changed" is answered by fingerprinting the payload rather
 * than by watching writes. Watching writes would mean a hook on every store; the
 * fingerprint costs one build of a payload we were about to build anyway.
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
import { GistError, findSyncGist, readSyncGist, writeSyncGist, chunkPayload } from './gist-client.js';
import { compressionAvailable, gzipText, gunzipToText } from './sync-compress.js';
import { encryptText, encryptBytes, decryptText, decryptBytes, bytesToBase64, base64ToBytes } from './sync-crypto.js';
import { buildPayloadJSON, applyPayload, contentHash } from './sync-payload.js';

const STORE = 'settings';

/** Which gist this device is using. Never uploaded — see sync-payload.js */
const KEY_GIST_ID = 'toolasha_sync_gistId';

/** `exportedAt` of the payload this device last pushed or pulled */
const KEY_LAST_SYNCED_AT = 'toolasha_sync_lastSyncedAt';

/** Fingerprint of that payload, so local drift since then is detectable */
const KEY_LAST_HASH = 'toolasha_sync_lastHash';

/** How many chunk files the gist holds, so a shrinking payload can delete the rest */
const KEY_CHUNK_COUNT = 'toolasha_sync_chunkCount';

/**
 * How often auto-sync considers pushing.
 *
 * Long, on purpose. Each tick rebuilds the payload to fingerprint it, which for
 * the `everything` scope is a full database read; doing that every minute would
 * be a visible stutter in exchange for freshness nobody asked for.
 */
export const AUTO_PUSH_INTERVAL_MS = 15 * 60 * 1000;

/** How long after a character switch the on-switch push waits for the dust. */
const SWITCH_PUSH_DELAY_MS = 5 * 1000;

/**
 * Startup pulls, staggered. One pull twenty seconds in raced the handoff: a
 * phone logging in pulls before the tab it kicked has finished pushing, and
 * misses it by seconds. The retries are nearly free — a pull whose remote is
 * not newer stops at the manifest read.
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

/** A sync busy longer than this is wedged, and a new one may take over. */
const BUSY_STUCK_MS = 5 * 60 * 1000;

class SyncManager {
    constructor() {
        this.timers = createTimerRegistry();
        this.busy = false;
        this.isInitialized = false;
        this.settingListeners = [];
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
            this.timers.clearAll();
            this.handoffUnregister?.();
            this.handoffUnregister = null;
            this._startAuto();
            this._watchHandoff();
        };
        for (const key of ['sync_enabled', 'sync_auto']) {
            config.onSettingChange(key, restart);
            this.settingListeners.push([key, restart]);
        }

        this._startAuto();
        this._watchHandoff();

        // A re-initialise for a DIFFERENT character is a switch: push shortly,
        // so the character just left has its changes on GitHub without waiting
        // out the quarter-hour timer. The unchanged-skip makes this free when
        // nothing moved; the first initialise of a page load never fires it.
        const characterId = dataManager.getCurrentCharacterId?.() ?? null;
        if (
            lastCharacterId !== null &&
            characterId !== null &&
            characterId !== lastCharacterId &&
            config.getSetting('sync_onSwitch', false) &&
            this.isConfigured()
        ) {
            this.timers.registerTimeout(
                setTimeout(() => {
                    this.push({ silent: true });
                }, SWITCH_PUSH_DELAY_MS)
            );
        }
        if (characterId !== null) lastCharacterId = characterId;
    }

    /** Stop timers and setting listeners. */
    cleanup() {
        this.handoffUnregister?.();
        this.handoffUnregister = null;
        this.handoffPushed = false;
        this.timers.clearAll();
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
     * @returns {Promise<{ok: boolean, skipped?: boolean, reason?: string}>} Outcome
     */
    async push({ silent = false } = {}) {
        return this._run('push', silent, () => this._doPush(silent));
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
     * @returns {Promise<{ok: boolean, skipped?: boolean, reason?: string}>} Outcome
     * @private
     */
    async _doPush(silent) {
        const token = this._token();
        const scope = config.getSetting('sync_scope', 'settings');

        const payload = await buildPayloadJSON(scope);
        const hash = contentHash(payload);

        if (silent && hash === (await storage.get(KEY_LAST_HASH, STORE, null))) {
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
        }

        // The hash above is always of the plaintext — compression and
        // encryption both change the bytes without changing the data (and a
        // fresh salt makes ciphertext different every push), so hashing
        // anything later in the pipeline would make every payload look changed.
        //
        // Pipeline order is gzip first, encrypt second: JSON compresses ~5-10×
        // and ciphertext does not compress at all. This is what fits the
        // "everything" scope under the gist ceiling.
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

        const chunks = chunkPayload(body);
        const previousChunks = Number(await storage.get(KEY_CHUNK_COUNT, STORE, 0)) || 0;

        const exportedAt = new Date().toISOString();
        const manifest = {
            toolashaSync: 1,
            scope,
            exportedAt,
            chunks: chunks.length,
            bytes: payload.length,
            hash,
            ...(compressed ? { compressed } : {}),
            ...(encrypted ? { encrypted } : {}),
        };

        const written = await writeSyncGist(token, gistId, manifest, chunks, previousChunks);
        await this._remember({ gistId: written.id, exportedAt, hash, chunkCount: chunks.length });

        if (!silent) {
            showToast(`Synced to GitHub (${scope === 'everything' ? 'everything' : 'settings only'}).`);
        }
        return { ok: true };
    }

    /**
     * Pull remote data down, newest-wins, asking first if both sides moved.
     * @param {Object} [options] - Options
     * @param {boolean} [options.silent=false] - Only act when the remote is
     *   strictly newer, and stay quiet otherwise. Used at startup.
     * @returns {Promise<{ok: boolean, skipped?: boolean, reason?: string}>} Outcome
     */
    async pull({ silent = false } = {}) {
        return this._run('pull', silent, () => this._doPull(silent));
    }

    /**
     * The download itself, with no guard around it.
     * @param {boolean} silent - Only act on a strictly newer remote, and stay quiet otherwise
     * @returns {Promise<{ok: boolean, skipped?: boolean, reason?: string}>} Outcome
     * @private
     */
    async _doPull(silent) {
        const token = this._token();
        const gistId = await this._resolveGistId(token);
        if (!gistId) {
            if (!silent) {
                showToast('No sync gist found for this token yet. Push once to create it.', { kind: 'warn' });
            }
            return { ok: true, skipped: true, reason: 'no-gist' };
        }

        const remote = await readSyncGist(token, gistId);
        const manifest = remote.manifest;
        let payload = remote.payload;

        // Unwind the push pipeline: decrypt first, then decompress. A manifest
        // without either flag is a payload from before they existed, and reads
        // exactly as it always did.
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

        const remoteAt = manifest?.exportedAt ?? null;
        const lastSyncedAt = await storage.get(KEY_LAST_SYNCED_AT, STORE, null);

        if (!isNewer(remoteAt, lastSyncedAt)) {
            if (!silent) showToast('Already up to date with GitHub.');
            return { ok: true, skipped: true, reason: 'not-newer' };
        }

        // Both sides moved: the remote is ahead of what we last exchanged, and so
        // are we. Newest-wins would throw away whichever is older without saying
        // so, which is not a thing to do to a year of history.
        const localHash = contentHash(await buildPayloadJSON(config.getSetting('sync_scope', 'settings')));
        const lastHash = await storage.get(KEY_LAST_HASH, STORE, null);
        const localChanged = Boolean(lastHash) && localHash !== lastHash;

        /** Whether the union this pull produces is sent straight back up */
        let pushBack = false;

        if (localChanged) {
            // The silent path is the unattended one (the startup pull). A
            // modal it raises sits unanswered behind the game while `busy`
            // stays held, and every 15-minute auto-push for the rest of the
            // session returns 'busy' without a word — the "auto-sync randomly
            // stops until I reload" report. Unattended pulls stand down and
            // leave the decision to a human-initiated sync.
            if (silent) {
                console.warn('[Sync] Startup pull found both sides changed; leaving it for a manual sync.');
                return { ok: true, skipped: true, reason: 'conflict' };
            }
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
            if (answer === 'push') return this._doPush(false);
            if (answer !== 'pull' && answer !== 'merge') return { ok: true, skipped: true, reason: 'cancelled' };
            pushBack = answer === 'merge';
        }

        const { merged } = await applyPayload(payload);
        await this._remember({
            gistId,
            exportedAt: remoteAt,
            // The CONTENT hash of what was applied — remembered so the next
            // local rebuild of the same content compares equal. The manifest's
            // own hash (older devices hashed the raw text, stamp included)
            // could never match a rebuild and manufactured a permanent conflict
            hash: contentHash(payload),
            chunkCount: Number(manifest?.chunks) || 0,
        });

        const combined = merged?.length
            ? ` ${merged.length} ${merged.length === 1 ? 'record was' : 'records were'} combined rather than replaced.`
            : '';
        showToast(`Synced from GitHub.${combined} Reload the page to pick everything up.`, { duration: 0 });

        // The union only exists on this device until it is sent up. Pushing it
        // now is what stops the other device pulling the pre-merge copy back
        // and re-opening the same conflict. `_remember` above already recorded
        // the remote's stamp, so this push is no longer a "never synced" one
        // and will not stop to ask.
        if (pushBack) {
            const pushed = await this._doPush(false);
            return { ok: true, merged: merged?.length || 0, pushedBack: pushed?.ok === true };
        }

        return { ok: true, merged: merged?.length || 0 };
    }

    /**
     * Forget which gist this device uses, without touching the gist itself.
     * The next push discovers or creates one.
     * @returns {Promise<void>}
     */
    async forgetGist() {
        await storage.set(KEY_GIST_ID, null, STORE, true);
        await storage.set(KEY_LAST_SYNCED_AT, null, STORE, true);
        await storage.set(KEY_LAST_HASH, null, STORE, true);
        await storage.set(KEY_CHUNK_COUNT, 0, STORE, true);
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
     * @private
     */
    _startAuto() {
        if (!config.getSetting('sync_auto', false) || !this.isConfigured()) return;

        for (const delay of STARTUP_PULL_DELAYS_MS) {
            this.timers.registerTimeout(
                setTimeout(() => {
                    this.pull({ silent: true });
                }, delay)
            );
        }

        this.timers.registerInterval(
            setInterval(() => {
                this.push({ silent: true });
            }, AUTO_PUSH_INTERVAL_MS)
        );

        // The other half of a two-device loop: the pushes above put changes up,
        // and this brings the other device's changes down while both stay open.
        // A silent pull is safe to run unattended — it applies only a clean
        // fast-forward (remote newer, nothing changed here) and stands down on
        // a conflict without asking.
        this.timers.registerTimeout(
            setTimeout(() => {
                this.timers.registerInterval(
                    setInterval(() => {
                        this.pull({ silent: true });
                    }, AUTO_PUSH_INTERVAL_MS)
                );
                this.pull({ silent: true });
            }, AUTO_PULL_OFFSET_MS)
        );
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
            this.push({ silent: true });
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
            await storage.set(KEY_GIST_ID, found, STORE, true);
            return found;
        }

        return null;
    }

    /**
     * Record what this device now believes about the gist.
     * @param {{gistId: string, exportedAt: string, hash: string, chunkCount: number}} state - New state
     * @private
     */
    async _remember({ gistId, exportedAt, hash, chunkCount }) {
        await storage.set(KEY_GIST_ID, gistId, STORE, true);
        await storage.set(KEY_LAST_SYNCED_AT, exportedAt, STORE, true);
        await storage.set(KEY_LAST_HASH, hash, STORE, true);
        await storage.set(KEY_CHUNK_COUNT, chunkCount, STORE, true);
    }

    /**
     * Guard, classify and report one sync operation.
     *
     * The single `busy` flag is not politeness: two pushes racing can interleave
     * chunk writes and leave a gist whose manifest describes neither payload.
     *
     * @param {string} label - 'push' or 'pull', for messages
     * @param {boolean} silent - Suppress the "nothing to do" chatter
     * @param {Function} operation - The work
     * @returns {Promise<{ok: boolean, skipped?: boolean, reason?: string}>} Outcome
     * @private
     */
    async _run(label, silent, operation) {
        if (!config.getSetting('sync_enabled', false)) {
            if (!silent) showToast('Cross-device sync is turned off.', { kind: 'warn' });
            return { ok: false, reason: 'disabled' };
        }
        if (!this._token()) {
            if (!silent) showToast('Add a GitHub token in Settings → Cross-Device Sync first.', { kind: 'warn' });
            return { ok: false, reason: 'no-token' };
        }
        if (this.busy) {
            // A sync that has been "running" this long is a wedged one — a
            // hung request or an abandoned dialog — and honouring its lock
            // forever is how auto-push died quietly for days. Take over.
            if (Date.now() - (this.busySince || 0) > BUSY_STUCK_MS) {
                console.warn(
                    `[Sync] A ${label} is taking over a sync stuck busy since ${new Date(this.busySince).toISOString()}.`
                );
            } else {
                if (!silent) showToast('A sync is already running.', { kind: 'warn' });
                return { ok: false, reason: 'busy' };
            }
        }

        this.busy = true;
        this.busySince = Date.now();
        try {
            return await operation();
        } catch (error) {
            // GistError messages are written to be shown; anything else is a bug
            // here and gets a generic message with the detail in the console.
            // Neither path can carry the token: it only ever appears in a header.
            if (error instanceof GistError) {
                console.warn(`[Sync] ${label} failed (${error.kind})`, error.githubMessage || '');
                if (error.kind === 'not-found') await this.forgetGist();
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
            this.busy = false;
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
 * Is `candidate` strictly after `reference`? An absent reference counts as
 * "never synced", so anything at all is newer.
 * @param {string|null} candidate - ISO timestamp
 * @param {string|null} reference - ISO timestamp
 * @returns {boolean} True when candidate wins
 */
function isNewer(candidate, reference) {
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
