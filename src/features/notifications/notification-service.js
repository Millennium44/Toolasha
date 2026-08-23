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
 *
 * ## Digesting, quiet hours, and the log
 *
 * Three things sit between "a feature decided to say something" and "a channel
 * said it", and all three are here rather than in the features, because none of
 * them is about *what* is worth saying:
 *
 * - **The log.** Every notice is recorded before any delivery decision is
 *   taken, including ones about to be batched, silenced, or dropped for want of
 *   a channel. It is the only reason the other two are safe.
 * - **Digest mode.** Low-urgency notices are held and go out as one summary
 *   every N minutes. Twelve undercut toasts in an afternoon is not twelve times
 *   the information of one line saying there were twelve.
 * - **Quiet hours.** A wall-clock window in which the desktop channel is shut
 *   off. Not the in-page ones — a toast on a tab you are looking at at midnight
 *   is a thing you chose to be looking at.
 *
 * A category on the critical allow-list — dying, an empty queue, drinks running
 * out, by default — bypasses both. Those are the notifications the script was
 * switched on for, and a feature that delays them by a quarter of an hour is a
 * downgrade however well it summarises.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { showToast } from '../../utils/toast.js';
import { appendNotice } from './notice-log.js';
import {
    categoryForEventKey,
    kindForEventKey,
    isCriticalCategory,
    isDigestCategory,
    isWithinQuietHours,
    summarizeDigest,
    DEFAULT_CRITICAL_CATEGORIES,
    DEFAULT_DIGEST_CATEGORIES,
} from './notice-policy.js';

/** What a flashed tab title is prefixed with; stripped again on focus */
export const TITLE_FLASH_PREFIX = '❗ ';

/** The same event may not be announced twice inside this window */
export const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;

/** How long a desktop notification sits there before closing itself */
const BROWSER_NOTIFICATION_TTL_MS = 8000;

/** Title on a desktop notification when the caller does not give one */
const DEFAULT_TITLE = 'Milky Way Idle';

/** Title on the summary toast a digest goes out as */
export const DIGEST_TITLE = 'While you were busy';

/** How long a digest window is when the setting is missing or nonsense */
export const DEFAULT_DIGEST_MINUTES = 15;

/** A digest window may not be shorter than this; a one-second digest is not a digest */
const MIN_DIGEST_MINUTES = 1;

/** …nor longer than this, or the summary outlives the thing it summarises */
const MAX_DIGEST_MINUTES = 240;

/** The settings this file reads, named once so the schema and the code can be diffed */
export const DELIVERY_SETTING_KEYS = {
    digestEnabled: 'notifications_digestEnabled',
    digestMinutes: 'notifications_digestMinutes',
    digestCategories: 'notifications_digestCategories',
    criticalCategories: 'notifications_criticalCategories',
    quietHoursEnabled: 'notifications_quietHoursEnabled',
    quietHoursStart: 'notifications_quietHoursStart',
    quietHoursEnd: 'notifications_quietHoursEnd',
};

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
    'notifications_combatConsumableLow',
    'notifications_labyrinthEntryAvailable',
    'notifications_combatDeath',
    'notifications_skillLevelUp',
    'notifications_ttlTargetReached',
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
 *
 * The digest buffer is in here for the same reason the cooldown map is: three
 * private buffers would be three summary toasts a quarter of an hour apart,
 * each covering a third of what happened.
 *
 * @returns {{lastFired: Map<string, number>, watching: boolean, digest: Array<Object>, digestTimer: any}}
 */
function sharedState() {
    const host = typeof globalThis === 'undefined' ? {} : globalThis;
    if (!host[GLOBAL_STATE_KEY]) {
        host[GLOBAL_STATE_KEY] = {
            lastFired: new Map(),
            watching: false,
            watchingCharacter: false,
            digest: [],
            digestTimer: null,
        };
    }
    const state = host[GLOBAL_STATE_KEY];
    // Defensive: a bundle built before digesting existed may have created the
    // object already, and an undefined buffer would throw on the first notice
    if (!Array.isArray(state.digest)) state.digest = [];
    if (state.digestTimer === undefined) state.digestTimer = null;
    return state;
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
     * @param {string} [options.subject] - What it is *about* — an item, a buff, a
     *   skill. Shown as its own column in the notice log and named in the digest
     *   summary, which is the difference between "3 undercuts" and "3 undercuts
     *   (Cheese, Milk, Flax)". Optional: falls back to the title
     * @param {string} [options.category] - Override the category derived from the
     *   event key. Almost never wanted; the derivation is the point
     * @returns {{fired: boolean, channels: string[], reason?: string, category: string, urgency: string}}
     *   What went out, and where. `fired` still means "the player has been told,
     *   do not repeat it" — a digested notice counts, because it will be
     *   summarised; a notice that reached nothing does not
     */
    notify(
        eventKey,
        message,
        { title = DEFAULT_TITLE, cooldownMs = this.cooldownMs, subject = '', category = '' } = {}
    ) {
        if (!eventKey || !message) {
            return { fired: false, channels: [], reason: 'nothing to say', category: 'other', urgency: 'normal' };
        }

        const kind = kindForEventKey(eventKey);
        const resolved = category || categoryForEventKey(eventKey);
        const critical = this.isCritical(resolved);
        const urgency = critical ? 'critical' : 'normal';

        const now = Date.now();
        const last = this.lastFired.get(eventKey);
        if (last !== undefined && now - last < cooldownMs) {
            return { fired: false, channels: [], reason: 'cooldown', category: resolved, urgency };
        }

        // Whatever happens to it below, it happened. The log is written first so
        // that a notice which is batched, silenced by quiet hours, or reaches no
        // channel at all is still recoverable
        const named = subject || (title === DEFAULT_TITLE ? '' : title);

        if (!critical && this.shouldDigest(resolved)) {
            this.recordNotice({ eventKey, resolved, named, message, urgency, channels: ['digest'] });
            sharedState().digest.push({ category: resolved, noun: kind.noun, subject: named });
            this.scheduleDigest();
            this.lastFired.set(eventKey, now);
            return { fired: true, channels: ['digest'], reason: 'digested', category: resolved, urgency };
        }

        const channels = this.deliver(message, title, critical);
        this.recordNotice({ eventKey, resolved, named, message, urgency, channels });

        // Only a delivered message starts the clock. Burning the cooldown on a
        // notification that reached no channel — permission refused, no DOM yet
        // — would silence the next attempt, which is the one that might work
        if (!channels.length) {
            return { fired: false, channels, reason: 'no channel available', category: resolved, urgency };
        }

        this.lastFired.set(eventKey, now);
        return { fired: true, channels, category: resolved, urgency };
    }

    /**
     * Put a message on whichever channels are open right now.
     *
     * The only thing quiet hours change here is the desktop channel. The tab
     * title still gets its mark and a visible tab still gets its toast, because
     * both of those are things you have to be looking at the page to see, and
     * being asleep is precisely not looking at the page.
     *
     * @param {string} message - Body text
     * @param {string} title - Desktop notification title
     * @param {boolean} critical - Whether it may ignore quiet hours
     * @returns {string[]} Channels it actually reached
     */
    deliver(message, title, critical = false) {
        const channels = [];
        const quiet = !critical && this.inQuietHours();

        try {
            if (isPageHidden()) {
                if (!quiet && this.sendBrowserNotification(message, title)) channels.push('browser');
                if (this.flashTitle()) channels.push('title');
            } else if (this.showInPage(message)) {
                channels.push('toast');
            }
        } catch (error) {
            console.error('[NotificationService] Failed to deliver notification:', error);
        }

        return channels;
    }

    /**
     * Write one notice to the log, and never let that failure stop delivery.
     * @param {Object} notice - What happened
     * @returns {void}
     */
    recordNotice({ eventKey, resolved, named, message, urgency, channels }) {
        try {
            appendNotice({
                key: eventKey,
                category: resolved,
                subject: named,
                text: message,
                urgency,
                channels,
            });
        } catch (error) {
            console.error('[NotificationService] Could not log a notice:', error);
        }
    }

    /**
     * Whether a category is on the critical allow-list.
     * @param {string} category - Category key
     * @returns {boolean} True when it ignores digesting and quiet hours
     */
    isCritical(category) {
        const list = config.getSetting(DELIVERY_SETTING_KEYS.criticalCategories, DEFAULT_CRITICAL_CATEGORIES);
        return isCriticalCategory(category, list || DEFAULT_CRITICAL_CATEGORIES);
    }

    /**
     * Whether a category's notices are being batched at the moment.
     * @param {string} category - Category key
     * @returns {boolean} True when the notice should be held for the summary
     */
    shouldDigest(category) {
        if (!config.getSetting(DELIVERY_SETTING_KEYS.digestEnabled, false)) return false;
        const list = config.getSetting(DELIVERY_SETTING_KEYS.digestCategories, DEFAULT_DIGEST_CATEGORIES);
        return isDigestCategory(category, list ?? DEFAULT_DIGEST_CATEGORIES);
    }

    /**
     * Whether the wall clock is inside the player's quiet window.
     * @param {Date|number} [when] - The moment to test, injectable for tests
     * @returns {boolean} True while desktop notifications are to be held back
     */
    inQuietHours(when = Date.now()) {
        if (!config.getSetting(DELIVERY_SETTING_KEYS.quietHoursEnabled, false)) return false;
        return isWithinQuietHours(
            when,
            config.getSetting(DELIVERY_SETTING_KEYS.quietHoursStart, ''),
            config.getSetting(DELIVERY_SETTING_KEYS.quietHoursEnd, '')
        );
    }

    /**
     * How long a digest window is, in milliseconds.
     * @returns {number} Clamped to something a summary can usefully cover
     */
    digestWindowMs() {
        const minutes = Number(config.getSetting(DELIVERY_SETTING_KEYS.digestMinutes, DEFAULT_DIGEST_MINUTES));
        const safe = Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_DIGEST_MINUTES;
        return Math.min(MAX_DIGEST_MINUTES, Math.max(MIN_DIGEST_MINUTES, safe)) * 60 * 1000;
    }

    /**
     * Start the digest clock, if it is not already running.
     *
     * Started by the *first* held notice and not restarted by the ones after it,
     * so the summary arrives a fixed time after the batch opened rather than a
     * fixed time after it went quiet. A sliding window would mean a steady
     * trickle of undercuts never produced a summary at all.
     *
     * @returns {void}
     */
    scheduleDigest() {
        const state = sharedState();
        if (state.digestTimer) return;
        if (typeof setTimeout !== 'function') return;

        state.digestTimer = setTimeout(() => {
            state.digestTimer = null;
            this.flushDigest();
        }, this.digestWindowMs());
    }

    /**
     * Say everything that has been held, as one line, and empty the buffer.
     *
     * The summary is not itself logged: every notice in it was written to the
     * log as it arrived, and a summary row beside its own constituents would
     * double-count the afternoon.
     *
     * @returns {{fired: boolean, channels: string[], message: string}} What went out
     */
    flushDigest() {
        const state = sharedState();
        if (state.digestTimer) {
            clearTimeout(state.digestTimer);
            state.digestTimer = null;
        }

        const held = state.digest;
        state.digest = [];
        if (!held.length) return { fired: false, channels: [], message: '' };

        const message = summarizeDigest(held);
        const channels = this.deliver(message, DIGEST_TITLE, false);
        return { fired: channels.length > 0, channels, message };
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

    /**
     * Empty the digest and the cooldowns when the character changes.
     *
     * Both are about a character who is no longer logged in: the buffer holds
     * "your listing was undercut" lines belonging to the account that just
     * left, and the cooldown map would silence the arriving character's first
     * notice of an event the departing one had already been told about. The
     * held notices are flushed rather than dropped — every one of them was true
     * when it was recorded, and the log already has them either way — and only
     * then is the state cleared.
     *
     * Installed at import time beside {@link watchSettings}, and once across
     * every bundle copy, for the same reasons.
     */
    watchCharacterSwitch() {
        const state = sharedState();
        if (state.watchingCharacter) return;
        if (typeof dataManager?.on !== 'function') return;
        state.watchingCharacter = true;

        dataManager.on('character_switching', () => {
            try {
                this.flushDigest();
            } catch (error) {
                console.warn('[NotificationService] Flushing the digest on a character switch failed:', error);
            }
            this.reset();
        });
    }

    /** Forget every cooldown and put the title back. For teardown and for tests. */
    reset() {
        const state = sharedState();
        if (state.digestTimer) clearTimeout(state.digestTimer);
        state.digestTimer = null;
        state.digest = [];
        this.lastFired.clear();
        this.restoreTitle();
        this.cooldownMs = DEFAULT_COOLDOWN_MS;
    }
}

const notificationService = new NotificationService();

// Side effect at module scope, deliberately: see `watchSettings`
notificationService.watchSettings();
notificationService.watchCharacterSwitch();

export default notificationService;
