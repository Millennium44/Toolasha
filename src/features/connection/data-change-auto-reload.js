/**
 * Reload the tab by itself after stored data changed underneath it.
 *
 * A sync pull or a backup restore replaces stored records, and the stores it replaced refuse new saves until
 * the page reloads (see `storage.finishRestore`). Toolasha says so and waits. With this on, the wait ends in a
 * reload after the chosen time, unless the player is in the way.
 *
 * Only prompts the reload log files as `data-changed`. A repair prompt (`recovery`) is never reloaded for
 * the player, and the newer-version-in-another-tab notice (`newer-build`) has a setting of its own.
 *
 * Safety rules:
 * - A visible countdown with Reload now and Cancel; the notice is checked again right before reloading.
 * - Any pointer, key, touch or wheel input after the prompt turns the automatic reload into an offer.
 * - A Combat Sim or Lab Sim run in progress, or a focused text box inside a Toolasha window, delays the
 *   reload; it is checked again every {@link RECHECK_MS}.
 * - Pending saves are written first; a write that does not finish turns the reload into an offer.
 * - Loop guard: {@link MAX_AUTO_RELOADS} automatic reloads within {@link GUARD_WINDOW_MS} (kept in
 *   `sessionStorage`, which survives the reload) stop it, and it says so. A record that cannot be read or
 *   written counts as spent.
 * - A character switch, Cancel, the setting turned off or a teardown each end the wait.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import { onPrompt } from '../../core/reload-log.js';
import syncManager from '../sync/sync-manager.js';
import { toolashaRoot } from '../../utils/bundle-bridge.js';
import {
    addInteractionListeners,
    formatClock,
    removeInteractionListeners,
    setNoticeText,
    showReloadNotice,
} from '../../utils/reload-countdown.js';

export const SETTING_KEY = 'dataChangeAutoReload';

/** sessionStorage key: when this tab last reloaded itself for this feature */
export const RECORD_KEY = 'toolasha_dataChangeAutoReload';

/** Automatic reloads allowed inside {@link GUARD_WINDOW_MS} */
export const MAX_AUTO_RELOADS = 3;

/** The window the loop guard counts in */
export const GUARD_WINDOW_MS = 10 * 60 * 1000;

/** How often a delayed reload checks again */
export const RECHECK_MS = 5 * 1000;

/** A flush that takes longer than this turns the reload into an offer */
const FLUSH_TIMEOUT_MS = 5 * 1000;

const USING_PAGE =
    'Stored data changed and needs a reload. Toolasha did not reload by itself because you were using the page. ' +
    'Reload when you are ready.';

/**
 * The chosen delay in seconds, or 0 when off.
 * @returns {number} Seconds; 0 means off
 */
export function getConfiguredSeconds() {
    const seconds = Number(config.getSettingValue(SETTING_KEY, 'off'));
    return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

/**
 * Whether a Combat Sim or Lab Sim run is in progress.
 * @returns {boolean} True while either is busy
 */
export function isSimRunning() {
    try {
        const sim = toolashaRoot()?.Sim;
        return Boolean(sim?.combatSimUI?._isBusy?.() || sim?.labSim?.isBusy?.());
    } catch {
        return false;
    }
}

/**
 * Whether a text box inside a Toolasha window has focus.
 * @returns {boolean} True when one does
 */
export function isToolashaInputFocused() {
    try {
        const active = document.activeElement;
        if (!active || active === document.body) return false;
        const tag = String(active.tagName || '').toLowerCase();
        const editable = tag === 'input' || tag === 'textarea' || tag === 'select' || active.isContentEditable === true;
        if (!editable) return false;
        return Boolean(active.closest?.('[data-toolasha-surface], [class*="toolasha"], [id*="toolasha"]'));
    } catch {
        return false;
    }
}

class DataChangeAutoReload {
    constructor() {
        this.initialized = false;
        this.reloadTimer = null;
        this.toast = null;
        this.countdownTicker = null;
        this.episode = null;
        this.interactionHandler = null;
        this.unsubscribers = [];
    }

    initialize() {
        if (this.initialized) return;
        this.initialized = true;

        const offPrompt = onPrompt((handle) => this._onPrompt(handle));
        const onSwitching = () => this._cancelEpisode('cancelled');
        dataManager.on('character_switching', onSwitching);
        this.unsubscribers.push(offPrompt, () => dataManager.off('character_switching', onSwitching));

        const offSetting = config.onSettingChange(SETTING_KEY, () => this._onSettingChanged());
        if (typeof offSetting === 'function') this.unsubscribers.push(offSetting);
    }

    /** Tear everything down: timers, listeners, notice. The reload record stays; it has to outlive this page. */
    disable() {
        this._cancelEpisode('cancelled');
        for (const off of this.unsubscribers.splice(0)) {
            try {
                off();
            } catch (error) {
                console.error('[DataChangeAutoReload] Unsubscribe failed:', error);
            }
        }
        this.initialized = false;
    }

    cleanup() {
        this.disable();
    }

    /**
     * @param {Object} handle - From the reload log
     * @private
     */
    _onPrompt(handle) {
        if (handle?.kind !== 'data-changed') return;
        const seconds = getConfiguredSeconds();
        if (seconds <= 0) return;

        if (this.episode && !this.episode.offered) {
            this.episode.handles.push(handle);
            return;
        }
        this._cancelEpisode();
        this.episode = { handles: [handle], startedAt: Date.now(), lastInteractionAt: 0, offered: false };
        this._installInteractionWatch();
        this._arm(seconds);
    }

    /**
     * Read the recent automatic reloads.
     * @returns {number[]|null} Times of reloads inside the window; null when storage cannot be read
     * @private
     */
    _readRecord() {
        try {
            const raw = window.sessionStorage.getItem(RECORD_KEY);
            if (raw === null) return [];
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return null;
            const now = Date.now();
            return parsed.filter((at) => Number.isFinite(at) && now - at < GUARD_WINDOW_MS);
        } catch {
            return null;
        }
    }

    /**
     * Record an automatic reload before taking it.
     * @param {number[]} recent - From {@link _readRecord}
     * @returns {boolean} False when the write failed; the caller must not reload
     * @private
     */
    _writeRecord(recent) {
        try {
            window.sessionStorage.setItem(RECORD_KEY, JSON.stringify([...recent, Date.now()]));
            return true;
        } catch (error) {
            console.error('[DataChangeAutoReload] Could not record the reload; not reloading:', error);
            return false;
        }
    }

    /**
     * Start the countdown, or offer instead when the loop guard says so.
     * @param {number} seconds - Configured delay
     * @private
     */
    _arm(seconds) {
        this._clearReloadTimer();
        const recent = this._readRecord();
        if (!recent) {
            this._endWithOffer(
                'Stored data changed and needs a reload. Toolasha cannot keep count of its automatic reloads ' +
                    'in this tab, so it will not reload by itself. Reload when you are ready.'
            );
            return;
        }
        if (recent.length >= MAX_AUTO_RELOADS) {
            this._endWithOffer(
                `Stored data changed and needs a reload. Toolasha has already reloaded this tab ${MAX_AUTO_RELOADS} ` +
                    'times in the last 10 minutes, so it has stopped reloading by itself. Reload when you are ready.'
            );
            return;
        }

        const fireAt = this.episode.startedAt + seconds * 1000;
        this.episode.fireAt = fireAt;
        this._showCountdown(fireAt);
        this.reloadTimer = setTimeout(() => this._fire(), Math.max(0, fireAt - Date.now()));
    }

    /**
     * Whatever is in the way of reloading right now, or null.
     * @returns {string|null} 'sim', 'input', 'restore', or null
     * @private
     */
    _blockedBy() {
        if (isSimRunning()) return 'sim';
        if (isToolashaInputFocused()) return 'input';
        if (storage.isRestoreInProgress?.()) return 'restore';
        if (syncManager.isOperationInFlight?.()) return 'sync';
        return null;
    }

    /**
     * The timer ran out: check everything again, then reload.
     * @private
     */
    async _fire() {
        this.reloadTimer = null;
        const episode = this.episode;
        if (!episode || episode.offered) return;

        if (getConfiguredSeconds() <= 0) {
            this._cancelEpisode('cancelled');
            return;
        }
        if (!this.toast?.element?.isConnected) {
            this._endWithOffer(
                'Stored data changed and needs a reload. Toolasha did not reload by itself because its notice ' +
                    'was no longer showing. Reload when you are ready.'
            );
            return;
        }
        if (episode.lastInteractionAt > 0) {
            this._endWithOffer(USING_PAGE);
            return;
        }

        const blocked = this._blockedBy();
        if (blocked) {
            const reason =
                blocked === 'sim'
                    ? 'a simulator run is going'
                    : blocked === 'input'
                      ? 'a text box is being edited'
                      : blocked === 'sync'
                        ? 'a sync is still running'
                        : 'a restore is still writing';
            setNoticeText(
                this.toast,
                `Stored data changed. Toolasha will reload this tab once ${reason} is over, unless you use the page first.`
            );
            this.reloadTimer = setTimeout(() => this._fire(), RECHECK_MS);
            return;
        }

        // Pending saves first: a reload with writes still queued would drop them
        let flushed = false;
        let flushTimer = null;
        try {
            const timeout = new Promise((resolve) => {
                flushTimer = setTimeout(() => resolve(false), FLUSH_TIMEOUT_MS);
            });
            flushed = await Promise.race([Promise.resolve(storage.flushAll?.()).then(() => true), timeout]);
        } catch {
            flushed = false;
        } finally {
            clearTimeout(flushTimer);
        }
        // Anything could have happened during the flush
        if (this.episode !== episode || episode.offered) return;
        if (getConfiguredSeconds() <= 0) {
            this._cancelEpisode('cancelled');
            return;
        }
        if (episode.lastInteractionAt > 0 || !this.toast?.element?.isConnected) {
            this._endWithOffer(USING_PAGE);
            return;
        }
        if (this._blockedBy()) {
            this.reloadTimer = setTimeout(() => this._fire(), RECHECK_MS);
            return;
        }
        if (!flushed || (storage.pendingWriteCount?.() ?? 0) > 0) {
            this._endWithOffer(
                'Stored data changed and needs a reload. Toolasha did not reload by itself because some saves ' +
                    'had not finished writing. Reload when you are ready.'
            );
            return;
        }

        const recent = this._readRecord();
        if (!recent || recent.length >= MAX_AUTO_RELOADS || !this._writeRecord(recent)) {
            this._endWithOffer(
                'Stored data changed and needs a reload. Toolasha could not safely reload by itself. Reload when ' +
                    'you are ready.'
            );
            return;
        }

        for (const handle of episode.handles) handle.settle('auto-reloaded');
        this._cancelEpisode();
        this._performReload();
    }

    /** @private */
    _onSettingChanged() {
        if (!this.episode) return;
        const seconds = getConfiguredSeconds();
        if (seconds <= 0) {
            this._cancelEpisode('cancelled');
            return;
        }
        // Only a live countdown is re-timed; an offer already shown stays as it is
        if (this.reloadTimer && !this.episode.offered) this._arm(seconds);
    }

    /**
     * @param {number} fireAt - Epoch ms the reload is due
     * @private
     */
    _showCountdown(fireAt) {
        const wording = () => {
            const left = Math.max(1, Math.round((fireAt - Date.now()) / 1000));
            return (
                `Stored data changed and this tab needs a reload. Toolasha will reload it at ${formatClock(fireAt)} ` +
                `(in about ${left} s), unless you use the page first.`
            );
        };
        this._showToast(wording(), { withCancel: true });
        const handle = this.toast;
        if (!handle) return;
        this.countdownTicker = setInterval(() => {
            if (this.toast !== handle || this.reloadTimer === null) return;
            if (Date.now() < fireAt) setNoticeText(handle, wording());
        }, 5_000);
    }

    /**
     * End the automatic part and leave a manual offer up.
     * @param {string} message - What to say
     * @private
     */
    _endWithOffer(message) {
        this._clearReloadTimer();
        this._removeInteractionWatch();
        if (this.episode) this.episode.offered = true;
        this._showToast(message, { withCancel: false });
    }

    /**
     * @param {string} message - Notice text
     * @param {{withCancel: boolean}} options - Whether to add a Cancel button
     * @private
     */
    _showToast(message, { withCancel }) {
        this._dismissToast();
        const handle = showReloadNotice(message, {
            withCancel,
            onReloadNow: () => this._reloadNow(),
            onDismissClick: (shown) => {
                if (this.toast === shown) {
                    this.toast = null;
                    this._cancelEpisode('cancelled');
                }
            },
            onCancel: () => this._cancelEpisode('cancelled'),
            cancelClass: 'toolasha-data-change-cancel',
            logPrefix: '[DataChangeAutoReload]',
        });
        if (handle) this.toast = handle;
    }

    /** @private */
    _reloadNow() {
        this.toast = null;
        for (const handle of this.episode?.handles || []) handle.settle('reloaded');
        this._cancelEpisode();
        this._performReload();
    }

    /**
     * Stop the episode: timer, interaction watch, notice.
     * @param {string} [outcome] - Outcome to record for the prompts it was waiting on
     * @private
     */
    _cancelEpisode(outcome) {
        if (outcome) for (const handle of this.episode?.handles || []) handle.settle(outcome);
        this._clearReloadTimer();
        this._removeInteractionWatch();
        this._dismissToast();
        this.episode = null;
    }

    /** @private */
    _clearReloadTimer() {
        if (this.reloadTimer) {
            clearTimeout(this.reloadTimer);
            this.reloadTimer = null;
        }
    }

    /** @private */
    _dismissToast() {
        if (this.countdownTicker) {
            clearInterval(this.countdownTicker);
            this.countdownTicker = null;
        }
        const toast = this.toast;
        this.toast = null;
        try {
            toast?.dismiss?.();
        } catch {
            // Already gone
        }
    }

    /** @private */
    _installInteractionWatch() {
        if (this.interactionHandler || typeof window === 'undefined') return;
        this.interactionHandler = () => {
            if (this.episode) this.episode.lastInteractionAt = Date.now();
        };
        addInteractionListeners(this.interactionHandler);
    }

    /** @private */
    _removeInteractionWatch() {
        if (!this.interactionHandler) return;
        removeInteractionListeners(this.interactionHandler);
        this.interactionHandler = null;
    }

    /** Reload the page. Its own method so tests can watch for it. @private */
    _performReload() {
        window.location.reload();
    }
}

const dataChangeAutoReload = new DataChangeAutoReload();

export default dataChangeAutoReload;
