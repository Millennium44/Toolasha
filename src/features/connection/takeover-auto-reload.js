/**
 * Reload a tab whose character was taken by another device or window.
 *
 * When the same character is opened somewhere else, the game closes this tab's
 * socket and shows "Disconnected. The game was opened from another device or
 * window." with a Refresh button. It never reconnects by itself; only a reload
 * logs back in, and doing so takes the session back from the other tab. For a
 * player who left a desktop tab running, glanced at the game on a phone and
 * walked away, that tab otherwise sits dead until they come back to it.
 *
 * What identifies a takeover is the close itself — code 1005, clean — not the
 * overlay's English text, which a Chinese client does not show. A network drop
 * closes 1006, not clean, and is left to the game. The overlay is used only as a
 * confirming re-check right before reloading.
 *
 * Safety rules:
 * - One timer per disconnect. A reconnect, a new socket, a character switch,
 *   Cancel, the setting turned off or a teardown each end it.
 * - Never while the page is being used: any pointer, key, touch or wheel input
 *   after the disconnect turns the automatic reload into an offer.
 * - Two tabs both running this would trade the character back and forth for
 *   ever. Each automatic reload is recorded in `sessionStorage` (which survives
 *   the reload) before it is taken; every consecutive one doubles the wait, and
 *   after {@link MAX_AUTO_RELOADS} it stops and says so. The record is cleared
 *   only once a connection has stayed up for at least {@link STABLE_RESET_MS}
 *   and twice the next wait (see `_startStableTimer`), so a takeover after our
 *   own reload — even one a peer tab waited its full delay for — still counts.
 *   The same window, measured from the last reload, expires a record left
 *   while the feature was off, and a record written for another character in
 *   this tab is ignored. A record that cannot be read or written counts as
 *   spent: no reload.
 */

import config from '../../core/config.js';
import connectionState from '../../core/connection-state.js';
import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import { GAME } from '../../utils/selectors.js';
import { showToast } from '../../utils/toast.js';

export const SETTING_KEY = 'takeoverAutoReload';

/** sessionStorage key for the consecutive-auto-reload record */
export const RECORD_KEY = 'toolasha_takeoverAutoReload';

/** Automatic reloads in a row before giving up in this tab */
export const MAX_AUTO_RELOADS = 3;

/** The shortest a connection must stay up after a reload before the count resets */
export const STABLE_RESET_MS = 10 * 60 * 1000;

/** The game's close code for "opened from another device or window" (no status) */
const TAKEOVER_CLOSE_CODE = 1005;

const INTERACTION_EVENTS = ['pointerdown', 'keydown', 'touchstart', 'wheel'];

/**
 * The chosen delay in minutes, or 0 when off.
 * @returns {number} Minutes; 0 means off
 */
export function getConfiguredMinutes() {
    const raw = config.getSettingValue(SETTING_KEY, 'off');
    const minutes = Number(raw);
    return Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
}

/**
 * How long a reload count stays meaningful: at least {@link STABLE_RESET_MS},
 * and twice this tab's next wait, so a peer tab on an equal or shorter setting
 * always takes the character back inside it.
 * @param {number} count - Consecutive automatic reloads so far
 * @returns {number} Milliseconds
 */
export function stableWindowMs(count) {
    const minutes = getConfiguredMinutes() || 60;
    return Math.max(STABLE_RESET_MS, 2 * minutes * 60 * 1000 * 2 ** count);
}

/**
 * Whether a connection-state 'disconnected' payload is a takeover close.
 * @param {Object} data - Payload from connectionState's 'disconnected'
 * @returns {boolean} True for a clean close with code 1005
 */
export function isTakeoverDisconnect(data) {
    if (!data || data.reason !== 'socket_close') return false;
    const event = data.event;
    return event?.code === TAKEOVER_CLOSE_CODE && event?.wasClean === true;
}

/**
 * Format a timestamp as a local clock time for the notice.
 * @param {number} ms - Epoch milliseconds
 * @returns {string} e.g. "14:32"
 */
function formatClock(ms) {
    try {
        return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
        return new Date(ms).toISOString().slice(11, 16);
    }
}

class TakeoverAutoReload {
    constructor() {
        this.initialized = false;
        this.reloadTimer = null;
        this.stableTimer = null;
        this.toast = null;
        this.episode = null;
        this.interactionHandler = null;
        this.unsubscribers = [];
    }

    /**
     * Subscribe to the connection, socket, switch and setting events.
     */
    initialize() {
        if (this.initialized) return;
        this.initialized = true;

        const onDisconnected = (data) => this._onDisconnected(data);
        const onReconnected = () => this._onConnected();
        const onSocketOpen = () => this._cancelEpisode();
        const onSwitching = () => this._cancelEpisode();

        connectionState.on('disconnected', onDisconnected);
        connectionState.on('reconnected', onReconnected);
        webSocketHook.onSocketEvent('open', onSocketOpen);
        dataManager.on('character_switching', onSwitching);

        this.unsubscribers.push(
            () => connectionState.off('disconnected', onDisconnected),
            () => connectionState.off('reconnected', onReconnected),
            () => webSocketHook.offSocketEvent('open', onSocketOpen),
            () => dataManager.off('character_switching', onSwitching)
        );

        const offSetting = config.onSettingChange(SETTING_KEY, () => this._onSettingChanged());
        if (typeof offSetting === 'function') this.unsubscribers.push(offSetting);

        // Typically started on a live connection — this is the page a previous
        // automatic reload came back to, and its count may now be reset once it
        // has stayed up.
        if (connectionState.isConnected()) this._startStableTimer();
    }

    /**
     * Tear everything down: timers, listeners, notice. The reload record is
     * kept — it is the ping-pong guard and has to outlive this page.
     */
    disable() {
        this._cancelEpisode();
        this._clearStableTimer();
        for (const off of this.unsubscribers.splice(0)) {
            try {
                off();
            } catch (error) {
                console.error('[TakeoverAutoReload] Unsubscribe failed:', error);
            }
        }
        this.initialized = false;
    }

    cleanup() {
        this.disable();
    }

    /**
     * Read the consecutive-auto-reload record.
     *
     * A record left by another character in this tab, or older than its own
     * stability window (see {@link stableWindowMs}), counts as no record: the
     * count is about this character being traded back and forth, and a gap
     * that long — the feature off, the tab idle — means the trading stopped.
     * Both still let two fighting tabs reach the cap, since each is taken
     * back a peer's wait after writing its record.
     *
     * Age is judged at `asOf`. During an episode that is the disconnect, not
     * now: the stability window measures how long the connection survived, and
     * the episode's own countdown is time spent disconnected. Judged at fire
     * time, a backed-off countdown could age the record out and restart the
     * count at 1 for ever (#532).
     * @param {number} [asOf] - Epoch ms to judge the record's age at
     * @returns {{count: number, lastAt: number}|null} Null when storage cannot be read
     * @private
     */
    _readRecord(asOf = Date.now()) {
        try {
            const raw = window.sessionStorage.getItem(RECORD_KEY);
            if (raw === null) return { count: 0, lastAt: 0 };
            const parsed = JSON.parse(raw);
            const count = Number(parsed?.count);
            if (!Number.isFinite(count) || count < 0) return null;
            const record = { count: Math.floor(count), lastAt: Number(parsed?.lastAt) || 0 };

            const owner = parsed?.characterId ?? null;
            const current = this._currentCharacterId();
            // An unknown current character keeps the count: the side that cannot loop
            if (owner !== null && current !== null && String(owner) !== String(current)) {
                return { count: 0, lastAt: 0 };
            }
            if (record.count > 0 && record.lastAt > 0 && asOf - record.lastAt >= stableWindowMs(record.count)) {
                return { count: 0, lastAt: 0 };
            }
            return record;
        } catch {
            return null;
        }
    }

    /**
     * @returns {string|number|null} The character this tab is logged in as
     * @private
     */
    _currentCharacterId() {
        try {
            return dataManager.getCurrentCharacterId?.() ?? null;
        } catch {
            return null;
        }
    }

    /**
     * Record an automatic reload before taking it.
     * @param {number} count - The new consecutive count
     * @returns {boolean} False when the write failed; the caller must not reload
     * @private
     */
    _writeRecord(count) {
        try {
            window.sessionStorage.setItem(
                RECORD_KEY,
                JSON.stringify({ count, lastAt: Date.now(), characterId: this._currentCharacterId() })
            );
            return true;
        } catch (error) {
            console.error('[TakeoverAutoReload] Could not record the reload; not reloading:', error);
            return false;
        }
    }

    /** @private */
    _clearRecord() {
        try {
            window.sessionStorage.removeItem(RECORD_KEY);
        } catch {
            // Left in place: the count stays where it is, which can only make a
            // later reload less likely, never a loop
        }
    }

    /** @private */
    _onConnected() {
        this._cancelEpisode();
        this._startStableTimer();
    }

    /**
     * Clear the reload count once this connection has stayed up long enough to
     * show the other side has stopped taking the character back.
     *
     * "Long enough" scales with the wait the other tab would use: two tabs on
     * the same setting (the usual case — settings are shared by tabs and, with
     * sync, by devices) take turns at each other's full delay, which outlasts
     * any fixed window. Twice this tab's own next wait covers an equal or
     * shorter peer, so their counts climb to the cap instead of resetting.
     * @private
     */
    _startStableTimer() {
        this._clearStableTimer();
        const record = this._readRecord();
        // Nothing to reset, or unreadable — and an unreadable record already
        // means no reload
        if (!record || record.count <= 0) return;

        // Measured from the last reload, like the read-time expiry in
        // _readRecord, and on the current setting, so the two always agree
        const windowMs = stableWindowMs(record.count);
        const delayMs = record.lastAt > 0 ? Math.max(0, record.lastAt + windowMs - Date.now()) : windowMs;
        this.stableTimer = setTimeout(() => {
            this.stableTimer = null;
            if (connectionState.isConnected()) this._clearRecord();
        }, delayMs);
    }

    /** @private */
    _clearStableTimer() {
        if (this.stableTimer) {
            clearTimeout(this.stableTimer);
            this.stableTimer = null;
        }
    }

    /**
     * @param {Object} data - Payload from connectionState's 'disconnected'
     * @private
     */
    _onDisconnected(data) {
        // Any disconnect stops the connection counting as stable
        this._clearStableTimer();

        if (!isTakeoverDisconnect(data)) return;
        // Toolasha's own recovery close (closeActiveGameSocket) is also a clean
        // 1005; it reconnects by itself and is not a takeover
        if (webSocketHook.wasClosedByToolasha?.(data.socket ?? data.event?.target)) return;
        if (this.episode) return;

        const minutes = getConfiguredMinutes();
        if (minutes <= 0) return;

        this.episode = { disconnectedAt: Date.now(), lastInteractionAt: 0 };
        this._installInteractionWatch();
        this._arm(minutes);
    }

    /**
     * Start (or restart) the timer for the current episode.
     * @param {number} minutes - Configured base delay
     * @private
     */
    _arm(minutes) {
        this._clearReloadTimer();

        const record = this._readRecord(this.episode.disconnectedAt);
        if (!record) {
            this._endWithOffer(
                'This character was opened from another device or window. Toolasha cannot keep count of its ' +
                    'reloads in this tab, so it will not reload by itself. Reload when you are ready.'
            );
            return;
        }
        if (record.count >= MAX_AUTO_RELOADS) {
            this._endWithOffer(
                `This character was opened from another device or window again. Toolasha has already reloaded ` +
                    `this tab ${MAX_AUTO_RELOADS} times in a row and it was taken back each time — another tab may ` +
                    `be doing the same — so it has stopped reloading by itself here.`
            );
            return;
        }

        const delayMs = minutes * 60 * 1000 * 2 ** record.count;
        const fireAt = this.episode.disconnectedAt + delayMs;
        this.episode.fireAt = fireAt;
        this.episode.count = record.count;

        this._showCountdown(fireAt);
        this.reloadTimer = setTimeout(() => this._fire(), Math.max(0, fireAt - Date.now()));
    }

    /**
     * The timer ran out: check everything again, then reload.
     * @private
     */
    _fire() {
        this.reloadTimer = null;
        if (!this.episode) return;

        if (getConfiguredMinutes() <= 0) {
            this._cancelEpisode();
            return;
        }

        const overlayPresent = typeof document !== 'undefined' && !!document.querySelector(GAME.CONNECTION_MESSAGE);
        if (!overlayPresent || connectionState.isConnected()) {
            // The game is no longer showing the takeover; nothing to recover
            this._cancelEpisode();
            return;
        }

        // Never reload without a visible notice: the toast stack drops its
        // oldest past four, which removes the countdown without a Cancel
        if (!this.toast?.element?.isConnected) {
            this._endWithOffer(
                'This character was opened from another device or window. Toolasha did not reload by itself ' +
                    'because its notice was no longer showing. Reload when you are ready.'
            );
            return;
        }

        if (this.episode.lastInteractionAt > 0) {
            this._endWithOffer(
                'This character was opened from another device or window. Toolasha did not reload by itself ' +
                    'because you were using the page. Reload when you are ready.'
            );
            return;
        }

        const record = this._readRecord(this.episode.disconnectedAt);
        if (!record || record.count >= MAX_AUTO_RELOADS || !this._writeRecord(record.count + 1)) {
            this._endWithOffer(
                'This character was opened from another device or window. Toolasha could not safely reload by ' +
                    'itself. Reload when you are ready.'
            );
            return;
        }

        this._cancelEpisode();
        this._performReload();
    }

    /** @private */
    _onSettingChanged() {
        if (!this.episode) {
            // The stability window scales with the delay: re-time it so a
            // changed setting cannot clear the count on the old window
            if (getConfiguredMinutes() > 0 && connectionState.isConnected()) this._startStableTimer();
            return;
        }
        const minutes = getConfiguredMinutes();
        if (minutes <= 0) {
            this._cancelEpisode();
            return;
        }
        // Only a live countdown is re-timed; an offer already shown stays as it is
        if (this.reloadTimer) this._arm(minutes);
    }

    /**
     * Show the waiting notice with Reload now and Cancel.
     * @param {number} fireAt - Epoch ms the reload is due
     * @private
     */
    _showCountdown(fireAt) {
        const minutesLeft = Math.max(1, Math.round((fireAt - Date.now()) / 60000));
        this._showToast(
            `This character was opened from another device or window. Toolasha will reload this tab at ` +
                `${formatClock(fireAt)} (in about ${minutesLeft} min) to take it back, unless you use the page first.`,
            { withCancel: true }
        );
    }

    /**
     * End the automatic part of the episode and leave a manual offer up.
     * @param {string} message - What to say
     * @private
     */
    _endWithOffer(message) {
        this._clearReloadTimer();
        this._removeInteractionWatch();
        // The episode stays set so a repeated disconnect event cannot re-arm
        // it; a reconnect, socket open or switch clears it
        if (this.episode) this.episode.offered = true;
        this._showToast(message, { withCancel: false });
    }

    /**
     * Replace the current notice.
     * @param {string} message - Notice text
     * @param {{withCancel: boolean}} options - Whether to add a Cancel button
     * @private
     */
    _showToast(message, { withCancel }) {
        this._dismissToast();
        let handle = null;
        try {
            handle = showToast(message, {
                kind: 'warn',
                duration: 0,
                action: { label: 'Reload now', onClick: () => this._reloadNow() },
            });
        } catch (error) {
            console.error('[TakeoverAutoReload] Could not show the notice:', error);
        }
        if (!handle) return;
        this.toast = handle;

        const element = handle.element;
        // The ✕ ends the episode too: a hidden countdown would be a surprise reload
        element?.querySelector?.('.toolasha-toast-dismiss')?.addEventListener('click', () => {
            if (this.toast === handle) {
                this.toast = null;
                this._cancelEpisode();
            }
        });

        if (withCancel && element) {
            const cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.className = 'toolasha-takeover-cancel';
            cancel.textContent = 'Cancel';
            Object.assign(cancel.style, {
                marginTop: '6px',
                background: 'none',
                border: '1px solid currentColor',
                borderRadius: '4px',
                color: 'inherit',
                cursor: 'pointer',
                fontSize: '12px',
                padding: '2px 8px',
            });
            cancel.addEventListener('click', (event) => {
                // The whole toast is the Reload now target
                event.stopPropagation();
                this._cancelEpisode();
            });
            (element.firstElementChild || element).appendChild(cancel);
        }
    }

    /** @private */
    _reloadNow() {
        // The toast removes itself after its action runs
        this.toast = null;
        this._cancelEpisode();
        this._performReload();
    }

    /**
     * Stop the episode: timer, interaction watch, notice.
     * @private
     */
    _cancelEpisode() {
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
        for (const type of INTERACTION_EVENTS) {
            window.addEventListener(type, this.interactionHandler, { capture: true, passive: true });
        }
    }

    /** @private */
    _removeInteractionWatch() {
        if (!this.interactionHandler) return;
        for (const type of INTERACTION_EVENTS) {
            window.removeEventListener(type, this.interactionHandler, { capture: true });
        }
        this.interactionHandler = null;
    }

    /**
     * Reload the page. Its own method so tests can watch for it.
     * @private
     */
    _performReload() {
        window.location.reload();
    }
}

const takeoverAutoReload = new TakeoverAutoReload();

export default takeoverAutoReload;
