/**
 * Tab Version Sync
 *
 * When one game tab loads a newer Toolasha than the others have, the others
 * follow: a background tab reloads itself, a tab being used offers a Reload
 * button. A script update otherwise reaches only the tab that happened to load
 * after it, and the rest keep running old code (and old stored-record shapes)
 * until each is refreshed by hand.
 *
 * Tabs talk on a dedicated BroadcastChannel. A channel is same-origin only, so
 * `test.milkywayidle.com` and the live site never hear each other.
 *
 * Why this cannot loop:
 * - A tab acts only on a version STRICTLY newer than its own. A reloaded tab
 *   loads the newest script it can get and announces that; tabs on an equal or
 *   older version ignore it.
 * - Releases are compared as versions, dev builds by build stamp, and a
 *   release is never compared with a dev build (either direction).
 * - If a reload did not upgrade this tab (the userscript manager updates on its
 *   own schedule), the attempt is recorded per target version in
 *   `sessionStorage`, which survives the reload. The next time that version is
 *   heard this tab only offers a notice. A record that cannot be read or
 *   written counts as spent: no reload.
 *
 * Why it does not lose data or the session:
 * - A hidden tab reloads only after it has been hidden for
 *   {@link HIDDEN_RELOAD_DELAY_MS} straight, counted from when it became hidden
 *   or from hearing of the newer version, whichever is later. It then re-checks
 *   it is still hidden, awaits `storage.flushAll()` and re-checks again. A
 *   failed or stuck flush cancels the reload. (A covered window or another
 *   virtual desktop can report hidden; that is accepted.)
 * - A tab that is not connected is never reloaded automatically: its character
 *   may have been taken by another tab, and a reload would take it back.
 * - Becoming visible while a reload is pending turns it into the notice.
 *
 * Setting `tabVersionSync`: `ask` (default; always ask), `auto` (hidden tabs
 * reload, a visible tab asks), `reload` (always reload), `off` (no channel).
 */

import config from '../../core/config.js';
import connectionState from '../../core/connection-state.js';
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import { recordReloadPrompt } from '../../core/reload-log.js';
import { compareVersions } from '../../utils/compare-versions.js';
import { toolashaRoot } from '../../utils/bundle-bridge.js';
import { scriptVersion } from '../../utils/script-version.js';
import { showToast } from '../../utils/toast.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';

export const SETTING_KEY = 'tabVersionSync';
export const CHANNEL_NAME = 'toolasha-tab-version-sync';

/** sessionStorage key: the target ids this tab has already reloaded for */
export const RECORD_KEY = 'toolasha_tabVersionSync';

/** Let the build finish stamping itself before the first announcement */
const ANNOUNCE_DELAY_MS = 3 * 1000;

/** How long a hidden tab waits after hearing before it reloads */
export const HIDDEN_RELOAD_DELAY_MS = 2 * 60 * 1000;

/** "Always reload" waits only this long (a debounce against a burst of announcements) */
export const ALWAYS_RELOAD_DELAY_MS = 5 * 1000;

/** A flush that takes longer than this cancels the automatic reload */
const FLUSH_TIMEOUT_MS = 5 * 1000;

const VERSION_PATTERN = /^\d+(\.\d+)*$/;

/**
 * The configured mode.
 * @returns {'auto'|'reload'|'ask'|'off'} Unknown values read as the default
 */
export function getMode() {
    const raw = config.getSettingValue(SETTING_KEY, 'ask');
    return raw === 'reload' || raw === 'auto' || raw === 'off' ? raw : 'ask';
}

/**
 * The 14-digit build stamp of a dev build, from either source.
 * @param {string|null|undefined} buildStamp - `2026-08-22T15:30:00Z`
 * @param {string|null|undefined} version - `3.19.0.20260822153000`
 * @returns {string|null} `20260822153000`, or null for a release
 */
function stampDigits(buildStamp, version) {
    const fromStamp = String(buildStamp || '')
        .replace(/\D/g, '')
        .slice(0, 14);
    if (fromStamp.length === 14) return fromStamp;
    const match = /\.(\d{14})$/.exec(version || '');
    return match ? match[1] : null;
}

/**
 * What an announcement or this tab says about its build.
 * @param {string|null} version - The `@version`
 * @param {string|null} buildStamp - The dev build stamp, if any
 * @returns {{kind: 'release'|'dev', key: string}|null} Null when unusable
 */
export function describeBuild(version, buildStamp) {
    const stamp = stampDigits(buildStamp, version);
    if (stamp) return { kind: 'dev', key: stamp };
    if (typeof version === 'string' && VERSION_PATTERN.test(version)) return { kind: 'release', key: version };
    return null;
}

/**
 * Whether `other` is strictly newer than `mine`. Never across kinds.
 * @param {{kind: string, key: string}|null} mine - This tab's build
 * @param {{kind: string, key: string}|null} other - The announced build
 * @returns {boolean} True only for a strictly newer build of the same kind
 */
export function isStrictlyNewer(mine, other) {
    if (!mine || !other || mine.kind !== other.kind) return false;
    if (mine.kind === 'dev') return other.key > mine.key; // fixed-width digits sort as text
    return compareVersions(other.key, mine.key) > 0;
}

class TabVersionSync {
    constructor() {
        this.initialized = false;
        this.timerRegistry = createTimerRegistry();
        this.channel = null;
        this.unsubscribers = [];
        /** Targets already dealt with in this page: noticed, dismissed or reloading */
        this.noticed = new Set();
        this.target = null;
        this.timer = null;
        this.toast = null;
        this.visibilityListening = false;
        /** Bumped on cleanup so an in-flight flush cannot reload a torn-down feature */
        this.generation = 0;
        /** Bumped whenever a countdown is cancelled or restarted, so a flush from an earlier one cannot reload */
        this.countdown = 0;
        /** Older builds already answered, so two tabs cannot trade announcements forever */
        this.answered = new Set();
        this.onVisibility = () => this._onVisibility();
        this.onPageHide = () => this._closeChannel();
        this.onPageShow = (event) => {
            if (event?.persisted) this._openChannel();
        };
    }

    initialize() {
        if (this.initialized) return;
        this.initialized = true;

        const off = config.onSettingChange(SETTING_KEY, () => this._applyMode());
        if (typeof off === 'function') this.unsubscribers.push(off);

        window.addEventListener('pagehide', this.onPageHide);
        window.addEventListener('pageshow', this.onPageShow);
        this.unsubscribers.push(() => {
            window.removeEventListener('pagehide', this.onPageHide);
            window.removeEventListener('pageshow', this.onPageShow);
        });

        this._applyMode();
    }

    /** Open or close the channel to match the setting. @private */
    _applyMode() {
        if (!this.initialized) return;
        if (getMode() === 'off') {
            this._stopActing();
            this._closeChannel();
        } else {
            this._openChannel();
            // A newer build already heard under the old mode: act on it under the new one. The reload still
            // goes through _reloadWhenSafe (flush, pending-write guard, countdown generation).
            this._evaluate();
        }
    }

    /** Open the channel and announce this tab's build shortly after. @private */
    _openChannel() {
        if (this.channel || typeof BroadcastChannel !== 'function') return;
        try {
            this.channel = new BroadcastChannel(CHANNEL_NAME);
            this.channel.unref?.();
            this.channel.onmessage = (event) => this._onMessage(event?.data);
        } catch (error) {
            console.warn('[TabVersionSync] Channel unavailable:', error);
            this.channel = null;
            return;
        }
        this.timerRegistry.scheduleTimeout(() => this._announce(), ANNOUNCE_DELAY_MS);
    }

    /** @private */
    _closeChannel() {
        if (!this.channel) return;
        try {
            this.channel.onmessage = null;
            this.channel.close();
        } catch {
            // already closed
        }
        this.channel = null;
    }

    /** This tab's own build. @private */
    _myBuild() {
        return describeBuild(scriptVersion(), toolashaRoot()?.buildStamp);
    }

    /** @private */
    _announce() {
        if (!this.channel) return;
        const version = scriptVersion();
        if (!describeBuild(version, toolashaRoot()?.buildStamp)) return;
        try {
            this.channel.postMessage({ type: 'version', version, buildStamp: toolashaRoot()?.buildStamp || null });
        } catch (error) {
            console.warn('[TabVersionSync] Announce failed:', error);
        }
    }

    /**
     * Another tab announced a build.
     * @param {Object} data - The message
     * @private
     */
    _onMessage(data) {
        if (!data || data.type !== 'version' || getMode() === 'off') return;
        const other = describeBuild(data.version, data.buildStamp);
        const mine = this._myBuild();
        if (isStrictlyNewer(other, mine)) {
            // A tab still on an older build (its reload loaded the old script) cannot learn of this one
            // unless told. Answer once per older build; a newer announcement is never answered.
            const olderId = `${other.kind}:${other.key}`;
            if (!this.answered.has(olderId)) {
                this.answered.add(olderId);
                this._announce();
            }
            return;
        }
        if (!isStrictlyNewer(mine, other)) return;

        const id = `${other.kind}:${other.key}`;
        if (this.target?.id === id) return;
        // A newer one replaces an older target; the notice shows once per id
        this.target = { id };
        this._evaluate();
    }

    /**
     * Decide what the current target needs given the mode and visibility now:
     * a countdown to reload, the notice, or waiting for the tab to be hidden.
     * @private
     */
    _evaluate() {
        if (!this.target || !this.initialized) return;
        const { id } = this.target;
        const mode = getMode();
        if (mode === 'off') return;
        this._cancelTimer();
        this._listenVisibility();

        const hidden = document.visibilityState === 'hidden';
        const wantsReload = mode === 'reload' || (mode === 'auto' && hidden);
        if (wantsReload && this._mayReload(id)) {
            // A hidden tab must stay hidden the whole delay; "always reload" is the player's explicit choice
            const delay = mode === 'reload' ? ALWAYS_RELOAD_DELAY_MS : HIDDEN_RELOAD_DELAY_MS;
            this.timer = this.timerRegistry.scheduleTimeout(() => {
                this.timer = null;
                this._reloadWhenSafe(id, mode).catch((error) => {
                    console.error('[TabVersionSync] Reload aborted:', error);
                    this._showNotice(id);
                });
            }, delay);
        } else if (!hidden) {
            this._showNotice(id);
        }
        // Hidden and not reloading (ask mode, or a spent record): the notice waits for the tab to be seen
    }

    /**
     * Whether an automatic reload for this target is allowed at all.
     * @param {string} id - The target
     * @returns {boolean} False after one try, an unreadable record, or while not connected
     * @private
     */
    _mayReload(id) {
        const record = this._readRecord();
        if (record === null || record.includes(id)) return false;
        return connectionState.isConnected();
    }

    /** @returns {string[]|null} Targets reloaded for; null when unreadable @private */
    _readRecord() {
        try {
            const raw = window.sessionStorage.getItem(RECORD_KEY);
            if (raw === null) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : null;
        } catch {
            return null;
        }
    }

    /** @returns {boolean} Whether the record was written @private */
    _writeRecord(id) {
        const record = this._readRecord();
        if (record === null) return false;
        try {
            window.sessionStorage.setItem(RECORD_KEY, JSON.stringify([...record, id].slice(-20)));
            return true;
        } catch {
            return false;
        }
    }

    /** @private */
    async _reloadWhenSafe(id, mode) {
        const generation = this.generation;
        const countdown = this.countdown;
        const stillOk = () =>
            generation === this.generation &&
            countdown === this.countdown &&
            this.target?.id === id &&
            getMode() === mode &&
            (mode === 'reload' || document.visibilityState === 'hidden') &&
            connectionState.isConnected();

        if (!stillOk()) {
            this._showNotice(id);
            return;
        }

        let flushed = false;
        let flushTimer = null;
        try {
            const timeout = new Promise((resolve) => {
                flushTimer = setTimeout(() => resolve(false), FLUSH_TIMEOUT_MS);
            });
            flushed = await Promise.race([storage.flushAll().then(() => true), timeout]);
        } finally {
            clearTimeout(flushTimer);
        }

        // flushAll() can resolve with a failed write still queued, and writes made during the flush stay queued.
        // During a backup restore or sync pull flushAll() holds and resolves at once: a reload then would cut
        // the restore off part-way, so the tab asks instead.
        if (
            !flushed ||
            storage.pendingWriteCount() > 0 ||
            storage.isRestoreInProgress?.() ||
            !stillOk() ||
            !this._writeRecord(id)
        ) {
            this._showNotice(id);
            return;
        }
        this.target = null;
        window.location.reload();
    }

    /** Show the notice once per version, and only if someone can see it. @private */
    _showNotice(id) {
        if (!this.initialized || getMode() === 'off' || this.noticed.has(id)) return;
        if (document.visibilityState === 'hidden') return; // shown when the tab is next seen
        this.noticed.add(id); // dismissed or not, this version does not nag again
        const message = 'A newer Toolasha version loaded in another tab';
        const logEntry = recordReloadPrompt({
            source: 'tab-version',
            kind: 'newer-build',
            message,
            records: [`Toolasha version ${id}`],
            characterId: dataManager.getCurrentCharacterId?.() ?? null,
        });
        this.toast = showToast(message, {
            kind: 'info',
            duration: 0,
            action: {
                label: 'Reload',
                onClick: () => {
                    logEntry.settle('reloaded');
                    this._userReload();
                },
            },
            onClose: () => logEntry.settle('dismissed'),
        });
    }

    /** The Reload button: the player asked, so no hidden/connected conditions. @private */
    _userReload() {
        Promise.resolve()
            .then(() => Promise.race([storage.flushAll(), new Promise((r) => setTimeout(r, FLUSH_TIMEOUT_MS))]))
            .catch((error) => console.warn('[TabVersionSync] Flush before reload failed:', error))
            .then(() => window.location.reload());
    }

    /** @private */
    _listenVisibility() {
        if (this.visibilityListening) return;
        this.visibilityListening = true;
        document.addEventListener('visibilitychange', this.onVisibility);
    }

    /**
     * Visible: cancel any countdown and ask. Hidden: start the countdown from now.
     * @private
     */
    _onVisibility() {
        if (!this.target || getMode() === 'off') return;
        if (document.visibilityState === 'visible') {
            this._cancelTimer();
            this._showNotice(this.target.id);
        } else {
            this._evaluate();
        }
    }

    /** @private */
    _cancelTimer() {
        this.countdown += 1;
        if (this.timer) this.timerRegistry.cancelTimeout(this.timer);
        this.timer = null;
    }

    /** Stop anything in progress: countdown, notice. @private */
    _stopActing() {
        this.generation += 1;
        this._cancelTimer();
        this.target = null;
        if (this.visibilityListening) {
            document.removeEventListener('visibilitychange', this.onVisibility);
            this.visibilityListening = false;
        }
        this.timerRegistry.clearAll();
        try {
            this.toast?.dismiss();
        } catch {
            // already gone
        }
        this.toast = null;
    }

    cleanup() {
        this._stopActing();
        this._closeChannel();
        for (const off of this.unsubscribers.splice(0)) {
            try {
                off();
            } catch (error) {
                console.error('[TabVersionSync] Unsubscribe failed:', error);
            }
        }
        this.noticed.clear();
        this.answered.clear();
        this.initialized = false;
    }
}

const tabVersionSync = new TabVersionSync();

export default {
    name: 'Tab Version Sync',
    initialize: async () => tabVersionSync.initialize(),
    cleanup: () => {
        try {
            tabVersionSync.cleanup();
        } catch (error) {
            console.warn('[TabVersionSync] Disable failed part-way:', error);
        }
    },
};

export { tabVersionSync };
