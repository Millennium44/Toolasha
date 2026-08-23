/**
 * Community Buff Expiry Alerts
 *
 * Says so shortly before a server-wide community buff runs out, so there is
 * still time to donate minutes and keep it alive rather than discovering it
 * lapsed an hour ago.
 *
 * ## Where the expiry comes from
 *
 * `init_character_data.communityBuffs` is an array of buff records, one per
 * buff type that is currently running, and each carries an absolute
 * `expireTime` — an ISO-8601 instant like `"2025-09-10T14:19:11.088Z"` — next
 * to `startTime`, `level`, `isDone` and the contributor ledger. That absolute
 * instant is the whole reason this feature can be honest: nothing here counts
 * down from a duration string scraped out of the DOM, and nothing extrapolates
 * from "it said five hours a while ago". A buff either has a parseable
 * `expireTime` or it is skipped.
 *
 * The list is refreshed by `community_buffs_updated`, which the server sends
 * whenever anybody donates. Its payload is read defensively — if a future
 * server build stops including `communityBuffs` on that message, the last known
 * list simply keeps being used and the alert is early rather than absent.
 *
 * ## Re-arming
 *
 * A donation pushes `expireTime` out, and an alert that had already fired for
 * the old instant must be allowed to fire again for the new one. So what is
 * remembered is not "this buff was announced" but *which expiry* was announced:
 * `hrid → expireTime`. A new expiry is a different value, which re-arms on its
 * own, and the notification service sees a different event key too because the
 * expiry is baked into it.
 *
 * De-duplication is per page load. The notification service holds its cooldowns
 * in memory (`globalThis`), and this feature's own map is an instance field, so
 * reloading the tab inside the lead window can produce one repeat alert for an
 * expiry already announced. That is the failure worth having: the alternative
 * risks a persisted "already told you" surviving into a window where the buff
 * really is about to lapse.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import notificationService from './notification-service.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { timeReadable } from '../../utils/formatters.js';

/** Master switch; nothing below it is consulted while this is off */
export const MASTER_SETTING = 'notifications_communityBuffExpiring';

/** How many minutes before expiry to speak up */
export const LEAD_MINUTES_SETTING = 'notifications_communityBuffLeadMinutes';

/** Bounds the lead time to the range the settings control offers */
export const MIN_LEAD_MINUTES = 5;
export const MAX_LEAD_MINUTES = 120;
export const DEFAULT_LEAD_MINUTES = 15;

/**
 * Every community buff type the game has, with the setting that governs it.
 *
 * Enumerated rather than derived from `communityBuffTypeDetailMap` because the
 * settings schema is a static object literal read at import time by the
 * settings UI, the "what's new" diff and the defaults builder — a per-buff
 * toggle that only exists once `init_client_data` has arrived would be missing
 * from all three on a cold load. The list is five entries long and has not
 * changed since community buffs shipped, so the cost of pinning it is a test
 * (see the schema check in community-buff-alerts.test.js) rather than a
 * maintenance burden. Display names still come from game data at notify time;
 * only the *existence* of a toggle is pinned here.
 */
export const COMMUNITY_BUFF_TYPES = [
    {
        hrid: '/community_buff_types/experience',
        label: 'Experience',
        settingKey: 'notifications_communityBuff_experience',
    },
    {
        hrid: '/community_buff_types/gathering_quantity',
        label: 'Gathering Quantity',
        settingKey: 'notifications_communityBuff_gatheringQuantity',
    },
    {
        hrid: '/community_buff_types/production_efficiency',
        label: 'Production Efficiency',
        settingKey: 'notifications_communityBuff_productionEfficiency',
    },
    {
        hrid: '/community_buff_types/enhancing_speed',
        label: 'Enhancing Speed',
        settingKey: 'notifications_communityBuff_enhancingSpeed',
    },
    {
        hrid: '/community_buff_types/combat_drop_quantity',
        label: 'Combat Drop Quantity',
        settingKey: 'notifications_communityBuff_combatDropQuantity',
    },
];

const BUFF_TYPES_BY_HRID = new Map(COMMUNITY_BUFF_TYPES.map((type) => [type.hrid, type]));

/**
 * How often expiries are re-checked.
 *
 * Nothing announces "the buff is now nearly over" — crossing the lead-time
 * threshold is the passage of time, not an event — so it has to be polled. Half
 * a minute is fine against a lead time measured in tens of minutes and costs a
 * five-element loop.
 */
export const CHECK_INTERVAL_MS = 30 * 1000;

/** Prefix for the notification service's event keys */
const EVENT_KEY_PREFIX = 'community-buff-expiring';

/**
 * Pull the buff list out of a websocket payload, if it carries one.
 * @param {Object} payload - Parsed websocket message
 * @returns {Array<Object>|null} The buff records, or null when the message has none
 */
export function readBuffList(payload) {
    return Array.isArray(payload?.communityBuffs) ? payload.communityBuffs : null;
}

class CommunityBuffAlerts {
    constructor() {
        /** Last known buff records, newest wins */
        this.buffs = [];
        /** hrid → the expireTime that has already been announced */
        this.notifiedExpiry = new Map();
        this.timers = createTimerRegistry();
        this.unregisterHandlers = [];
        this.characterSwitchingHandler = null;
    }

    /**
     * Start watching community buff expiries.
     * @returns {Promise<void>}
     */
    async initialize() {
        if (!config.getSetting(MASTER_SETTING)) {
            return;
        }

        this.seedFromCharacterData();
        this.registerWebSocketListeners();

        this.timers.registerInterval(setInterval(() => this.check(), CHECK_INTERVAL_MS));

        this.characterSwitchingHandler = () => {
            this.disable();
        };
        dataManager.on('character_switching', this.characterSwitchingHandler);

        // A buff can already be inside the lead window when the page loads, and
        // waiting out a full interval to notice would waste the warning
        this.check();
    }

    /**
     * Take the buff list dataManager already holds from `init_character_data`.
     *
     * Features initialize after the character is up, so this is normally where
     * the first list comes from — the websocket handlers below only ever see
     * later messages.
     */
    seedFromCharacterData() {
        const buffs = readBuffList(dataManager.characterData);
        if (buffs) {
            this.buffs = buffs;
        }
    }

    /**
     * Listen for the messages that change a buff's expiry.
     */
    registerWebSocketListeners() {
        const update = (data) => {
            const buffs = readBuffList(data);
            if (!buffs) return;
            this.buffs = buffs;
            this.check();
        };

        for (const messageType of ['init_character_data', 'community_buffs_updated']) {
            webSocketHook.on(messageType, update);
            this.unregisterHandlers.push(() => webSocketHook.off(messageType, update));
        }
    }

    /**
     * The configured lead time, clamped to what the control can express.
     * @returns {number} Minutes before expiry to notify
     */
    leadMinutes() {
        const raw = Number(config.getSetting(LEAD_MINUTES_SETTING, DEFAULT_LEAD_MINUTES));
        if (!Number.isFinite(raw)) return DEFAULT_LEAD_MINUTES;
        return Math.min(MAX_LEAD_MINUTES, Math.max(MIN_LEAD_MINUTES, raw));
    }

    /**
     * The name the game gives a buff type, falling back to the pinned label.
     * @param {Object} type - Entry from COMMUNITY_BUFF_TYPES
     * @returns {string} Display name
     */
    buffName(type) {
        try {
            const detail = dataManager.getInitClientData()?.communityBuffTypeDetailMap?.[type.hrid];
            return detail?.name || type.label;
        } catch (error) {
            console.error('[CommunityBuffAlerts] Failed to read buff name:', error);
            return type.label;
        }
    }

    /**
     * Announce any enabled buff whose expiry has come inside the lead window.
     */
    check() {
        if (!config.getSetting(MASTER_SETTING)) {
            return;
        }

        const leadMs = this.leadMinutes() * 60 * 1000;
        const now = Date.now();

        for (const buff of this.buffs) {
            try {
                this.checkBuff(buff, now, leadMs);
            } catch (error) {
                console.error('[CommunityBuffAlerts] Failed to check a community buff:', error);
            }
        }
    }

    /**
     * Decide whether one buff record is worth speaking about, and say it.
     * @param {Object} buff - A record from `communityBuffs`
     * @param {number} now - Current epoch milliseconds
     * @param {number} leadMs - How far ahead of expiry to warn
     */
    checkBuff(buff, now, leadMs) {
        const type = BUFF_TYPES_BY_HRID.get(buff?.hrid);
        // An unknown hrid is a buff type added after this was written; there is
        // no toggle for it, so staying quiet is the only honest option
        if (!type) return;
        if (buff.isDone) return;
        // Per-buff toggles default on: the master switch is what the player
        // turned on, and it meaning "all of them" is the least surprising
        if (!config.getSetting(type.settingKey, true)) return;

        const expiresAt = Date.parse(buff.expireTime ?? '');
        if (!Number.isFinite(expiresAt)) return;

        const msLeft = expiresAt - now;
        // Already gone is not "about to go" — there is nothing left to save
        if (msLeft <= 0 || msLeft > leadMs) return;

        // Keyed on the expiry, not the buff: a donation that pushes expireTime
        // out is a different value here, which re-arms the alert by itself
        if (this.notifiedExpiry.get(buff.hrid) === buff.expireTime) return;

        const name = this.buffName(type);
        const remaining = timeReadable(Math.round(msLeft / 1000));
        const result = notificationService.notify(
            `${EVENT_KEY_PREFIX}:${buff.hrid}:${buff.expireTime}`,
            `Community buff ${name} runs out in ${remaining} — donate minutes to keep it going.`,
            // The subject is delivery metadata, not a second opinion about what
            // is worth saying: it is what a digest names when it says "Buffs: 2
            // lapsing (Experience, Enhancing Speed)"
            { title: 'Community buff expiring', subject: name }
        );

        // Only a delivered alert counts as told. One that reached no channel
        // should be retried on the next tick, which is the service's own rule
        if (result?.fired) {
            this.notifiedExpiry.set(buff.hrid, buff.expireTime);
        }
    }

    /**
     * Cleanup
     */
    disable() {
        if (this.characterSwitchingHandler) {
            dataManager.off('character_switching', this.characterSwitchingHandler);
            this.characterSwitchingHandler = null;
        }

        this.unregisterHandlers.forEach((unregister) => unregister());
        this.unregisterHandlers = [];
        this.timers.clearAll();
        this.buffs = [];
        this.notifiedExpiry.clear();
    }
}

const communityBuffAlerts = new CommunityBuffAlerts();

export default communityBuffAlerts;
