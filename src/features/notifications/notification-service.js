/**
 * Notification Service
 *
 * One place that decides *how* the player gets told something, so the features
 * that know *what* to tell them do not each grow their own half of a
 * notification system.
 *
 * The game is an idle game, which means the interesting moments happen while
 * you are not looking. Three channels cover the ways you can not be looking:
 *
 * - **Browser notification** — the tab is hidden, so the only surface left is
 *   the desktop. Gated behind its own setting *and* the browser's permission,
 *   because an unprompted permission dialog is the fastest way to have every
 *   notification from this script blocked forever.
 * - **Tab title flash** — also for a hidden tab, and the fallback when
 *   permission was never given. A prefixed title is visible in the tab strip
 *   without any permission at all, and it is restored the moment you come back.
 * - **Toast** — the tab is visible, so a desktop notification would be noise
 *   over a window you are already looking at. The shared toast stack says it
 *   in-page instead.
 *
 * ## Why the de-duplication is here and not in the callers
 *
 * Every producer is a *predicate over state that keeps being re-evaluated* —
 * the drink panel redraws on every inventory change, the market badge refreshes
 * on every listing message. Each of them could hold its own "did I already say
 * this" flag, and each would get it subtly wrong. A cooldown per event key,
 * held once, means a producer can be as trigger-happy as its data is noisy and
 * the player still hears it once.
 *
 * ## Why the state is on `globalThis`
 *
 * The production build splits the script into per-area bundles, and only
 * modules listed in the rollup config's shared maps are single copies. A module
 * under `src/features/` is not one of those, so the market bundle, the actions
 * bundle and the UI bundle each get their own copy of this file. Sharing the
 * cooldown map and the "already watching settings" flag through a global means
 * the copies behave as one service, which is what matters — the alternative is
 * three permission prompts and three independent cooldowns.
 */

import config from '../../core/config.js';
import { showToast } from '../../utils/toast.js';

/** What a flashed tab title is prefixed with; stripped again on focus */
export const TITLE_FLASH_PREFIX = '❗ ';

/** The same event may not be announced twice inside this window */
export const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;

/** How long a desktop notification sits there before closing itself */
const BROWSER_NOTIFICATION_TTL_MS = 8000;

/** Title on a desktop notification when the caller does not give one */
const DEFAULT_TITLE = 'Milky Way Idle';

/**
 * The settings whose being switched **on** is a user gesture we can ask for
 * notification permission inside.
 *
 * This list is the whole reason permission is not requested at page load: a
 * prompt nobody asked for is usually dismissed, and a dismissed prompt is
 * remembered. Ticking "notify me" is the one moment the player has said yes to
 * being notified, so it is the only moment worth spending the prompt on.
 */
export const NOTIFICATION_SETTING_KEYS = [
    'notifications_browserEnabled',
    'notifications_consumableLow',
    'notifications_marketListingFilled',
    'notifications_marketListingUndercut',
    'notifications_otherCharacterIdle',
    'notifications_communityBuffExpiring',
    'notifications_labyrinthRunFinished',
    'notifications_combatDeath',
    'notifications_enhancementTarget',
    'notifications_trialStarting',
    'notifications_trialResults',
    'notifications_taskSlotsFull',
    'notifiEmptyAction',
];

/** Where the cross-bundle state lives; see the module comment */
const GLOBAL_STATE_KEY = '__toolashaNotificationState';

/**
 * The one piece of state every copy of this module shares.
 * @returns {{lastFired: Map<string, number>, watching: boolean}}
 */
function sharedState() {
    const host = typeof globalThis === 'undefined' ? {} : globalThis;
    if (!host[GLOBAL_STATE_KEY]) {
        host[GLOBAL_STATE_KEY] = { lastFired: new Map(), watching: false };
    }
    return host[GLOBAL_STATE_KEY];
}

/**
 * Whether the player can currently see the page.
 *
 * `document.hidden` rather than focus: a tab that is visible but behind another
 * window still shows toasts fine, and a desktop notification for something you
 * can see on screen is the annoying kind.
 *
 * @returns {boolean} True when the page is not being displayed
 */
export function isPageHidden() {
    if (typeof document === 'undefined') return false;
    return document.hidden === true || document.visibilityState === 'hidden';
}

class NotificationService {
    constructor() {
        /** Overridable so tests do not have to wait ten minutes */
        this.cooldownMs = DEFAULT_COOLDOWN_MS;
        /** Undoes the focus/visibility listeners while a title is flashed */
        this.unwatchFocus = null;
    }

    /** @returns {Map<string, number>} eventKey → when it last went out */
    get lastFired() {
        return sharedState().lastFired;
    }

    /**
     * Tell the player something, once.
     *
     * @param {string} eventKey - Identity of the thing being announced. The same
     *   key is silent until its cooldown expires, so it should name the *event*
     *   ("market-listing-filled") and not the message text
     * @param {string} message - Plain text; what actually happened
     * @param {Object} [options] - Options
     * @param {string} [options.title] - Desktop notification title
     * @param {number} [options.cooldownMs] - Override the de-duplication window
     * @returns {{fired: boolean, channels: string[], reason?: string}} What went out, and where
     */
    notify(eventKey, message, { title = DEFAULT_TITLE, cooldownMs = this.cooldownMs } = {}) {
        if (!eventKey || !message) {
            return { fired: false, channels: [], reason: 'nothing to say' };
        }

        const now = Date.now();
        const last = this.lastFired.get(eventKey);
        if (last !== undefined && now - last < cooldownMs) {
            return { fired: false, channels: [], reason: 'cooldown' };
        }

        const channels = [];
        try {
            if (isPageHidden()) {
                if (this.sendBrowserNotification(message, title)) channels.push('browser');
                if (this.flashTitle()) channels.push('title');
            } else if (this.showInPage(message)) {
                channels.push('toast');
            }
        } catch (error) {
            console.error('[NotificationService] Failed to deliver notification:', error);
        }

        // Only a delivered message starts the clock. Burning the cooldown on a
        // notification that reached no channel — permission refused, no DOM yet
        // — would silence the next attempt, which is the one that might work
        if (!channels.length) {
            return { fired: false, channels, reason: 'no channel available' };
        }

        this.lastFired.set(eventKey, now);
        return { fired: true, channels };
    }

    /**
     * The desktop channel.
     * @param {string} message - Body text
     * @param {string} title - Notification title
     * @returns {boolean} Whether one was actually shown
     */
    sendBrowserNotification(message, title) {
        if (!config.getSetting('notifications_browserEnabled')) return false;
        if (typeof Notification === 'undefined') return false;
        if (Notification.permission !== 'granted') return false;

        const notification = new Notification(title, {
            body: message,
            icon: 'https://www.milkywayidle.com/favicon.ico',
            // Same tag for everything we send: a stack of desktop notifications
            // for one game is worse than the newest replacing the last
            tag: 'toolasha',
            requireInteraction: false,
        });

        notification.onclick = () => {
            window.focus();
            notification.close();
        };
        notification.onerror = (error) => {
            console.error('[NotificationService] Notification error:', error);
        };

        setTimeout(() => notification.close(), BROWSER_NOTIFICATION_TTL_MS);
        return true;
    }

    /**
     * The in-page channel.
     * @param {string} message - What to say
     * @returns {boolean} Whether a toast went up
     */
    showInPage(message) {
        return !!showToast(message, { kind: 'warn', duration: 10000 });
    }

    /**
     * Mark the tab title, and arrange for it to be unmarked.
     *
     * Prefixing rather than replacing, because the game writes its own title and
     * whatever it says is still worth reading — and checking for the prefix
     * first means several notifications in a row leave one mark, not five.
     *
     * @returns {boolean} Whether the title now carries the mark
     */
    flashTitle() {
        if (typeof document === 'undefined') return false;

        const current = document.title || '';
        if (!current.startsWith(TITLE_FLASH_PREFIX)) {
            document.title = TITLE_FLASH_PREFIX + current;
        }
        this._watchForReturn();
        return true;
    }

    /**
     * Put the title back the way the game left it.
     *
     * Strips the prefix rather than restoring a remembered string: the game
     * rewrites its own title while you are away, and restoring what it said an
     * hour ago would show a stale action name.
     */
    restoreTitle() {
        if (typeof document === 'undefined') return;

        const current = document.title || '';
        if (current.startsWith(TITLE_FLASH_PREFIX)) {
            document.title = current.slice(TITLE_FLASH_PREFIX.length);
        }
        this.unwatchFocus?.();
        this.unwatchFocus = null;
    }

    /** Listen for the player coming back, once per flash */
    _watchForReturn() {
        if (this.unwatchFocus || typeof window === 'undefined') return;

        const onReturn = () => {
            if (!isPageHidden()) this.restoreTitle();
        };
        window.addEventListener('focus', onReturn);
        document.addEventListener('visibilitychange', onReturn);
        this.unwatchFocus = () => {
            window.removeEventListener('focus', onReturn);
            document.removeEventListener('visibilitychange', onReturn);
        };
    }

    /**
     * Ask for notification permission, and only from a user gesture.
     *
     * @returns {Promise<boolean>} Whether notifications may now be sent
     */
    async requestPermission() {
        if (typeof Notification === 'undefined') {
            console.warn('[NotificationService] Browser notifications are not supported here');
            return false;
        }
        if (Notification.permission === 'granted') return true;
        // A refusal is permanent until the player changes it in the browser, and
        // asking again does nothing but throw
        if (Notification.permission === 'denied') return false;

        try {
            return (await Notification.requestPermission()) === 'granted';
        } catch (error) {
            console.warn('[NotificationService] Permission request failed:', error);
            return false;
        }
    }

    /**
     * Ask for permission whenever a notification setting is switched on.
     *
     * This is the whole of the "do not prompt at page load" fix. It runs at
     * import time rather than from a feature's `initialize`, because every
     * notification setting defaults to off — so the feature that would have
     * installed the hook is exactly the feature that is not running yet.
     */
    watchSettings() {
        const state = sharedState();
        if (state.watching) return;
        state.watching = true;

        for (const key of NOTIFICATION_SETTING_KEYS) {
            config.onSettingChange(key, (enabled) => {
                if (enabled) this.requestPermission();
            });
        }
    }

    /** Forget every cooldown and put the title back. For teardown and for tests. */
    reset() {
        this.lastFired.clear();
        this.restoreTitle();
        this.cooldownMs = DEFAULT_COOLDOWN_MS;
    }
}

const notificationService = new NotificationService();

// Side effect at module scope, deliberately: see `watchSettings`
notificationService.watchSettings();

export default notificationService;
