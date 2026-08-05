/**
 * Enhancement Target Alerts
 *
 * Says so when an item reaches the level you told the game to stop at.
 *
 * Enhancing is the longest unattended thing in the game and the one whose
 * ending is easiest to miss: the queue does not empty, no action completes in
 * any visible sense, the item simply stops changing. So this is the moment
 * worth a message.
 *
 * ## Read from the game, not from the tracker
 *
 * The target comes off the action itself. Every `action_completed` for
 * `/actions/enhancing/enhance` carries `enhancingMaxLevel` — the "enhance until
 * +N" the player set in the game's own panel — and `primaryItemHash`, whose
 * last segment is the level the item is at *after* that attempt. Those two are
 * the whole feature.
 *
 * Toolasha's enhancement tracker knows the same thing, and asking it would have
 * been the obvious move. It is the wrong one twice over. Its session state is
 * mutated from a handler on the same message this one listens to, so which of
 * the two runs first would decide whether the completing attempt is visible —
 * a race whose losing side is silence at exactly the moment that matters. And
 * the tracker is a feature that can be switched off, which would take this
 * notification off with it for no reason the player could see. The game's own
 * numbers are on the wire either way.
 *
 * ## Re-arming
 *
 * An item/target pair is announced once and then stays quiet, because the
 * server keeps describing the finished action for a while and every one of
 * those messages still reads as "at target". Seeing that same pair *below* its
 * target again — a fresh item, or a target raised and the grind resumed — is
 * what arms it for the next ending.
 *
 * A target of zero means no target: the game was told to enhance until stopped,
 * and there is no ending to announce.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import notificationService from './notification-service.js';

/** Master switch; nothing below it is consulted while this is off */
export const MASTER_SETTING = 'notifications_enhancementTarget';

/** The one action this cares about */
export const ENHANCE_ACTION_HRID = '/actions/enhancing/enhance';

/** Prefix for the notification service's event keys */
const EVENT_KEY_PREFIX = 'enhancement-target';

/**
 * The item and its level, out of an enhancing action's primary item hash.
 *
 * The hash is a `::`-joined tuple whose shape has varied — with and without a
 * leading item id — so it is read by finding the parts rather than by counting
 * them: the segment starting `/items/` is the item, and a trailing segment that
 * parses as a number is the enhancement level. A hash with no item in it yields
 * a null hrid, which callers treat as "nothing to say" rather than as level 0
 * of something unknown.
 *
 * @param {string} primaryItemHash - As sent on the action
 * @returns {{itemHrid: string|null, level: number}} What the hash names
 */
export function parseEnhancedItem(primaryItemHash) {
    if (typeof primaryItemHash !== 'string' || !primaryItemHash) {
        return { itemHrid: null, level: 0 };
    }

    const parts = primaryItemHash.split('::');
    const itemHrid = parts.find((part) => part.startsWith('/items/')) || null;

    let level = 0;
    const last = parts[parts.length - 1];
    if (last && !last.startsWith('/')) {
        const parsed = Number.parseInt(last, 10);
        if (Number.isFinite(parsed)) level = parsed;
    }

    return { itemHrid, level };
}

class EnhancementTargetAlerts {
    constructor() {
        /** `itemHrid:target` pairs already announced, until seen below target again */
        this.announced = new Set();
        this.unregisterHandlers = [];
        this.characterSwitchingHandler = null;
    }

    /**
     * Start watching enhancing actions for their target.
     * @returns {Promise<void>}
     */
    async initialize() {
        if (!config.getSetting(MASTER_SETTING)) {
            return;
        }

        this.registerWebSocketListeners();

        this.characterSwitchingHandler = () => {
            this.disable();
        };
        dataManager.on('character_switching', this.characterSwitchingHandler);
    }

    /** Listen for finished enhancing attempts */
    registerWebSocketListeners() {
        const handler = (data) => {
            try {
                this.check(data?.endCharacterAction);
            } catch (error) {
                console.error('[EnhancementTargetAlerts] Reading an enhancing attempt failed:', error);
            }
        };

        webSocketHook.on('action_completed', handler);
        this.unregisterHandlers.push(() => webSocketHook.off('action_completed', handler));
    }

    /**
     * The name the game gives an item, falling back to the tail of its hrid.
     * @param {string} itemHrid - Item hrid
     * @returns {string} Display name
     */
    itemName(itemHrid) {
        try {
            const name = dataManager.getInitClientData()?.itemDetailMap?.[itemHrid]?.name;
            if (name) return name;
        } catch (error) {
            console.error('[EnhancementTargetAlerts] Reading an item name failed:', error);
        }
        return itemHrid.split('/').pop() || itemHrid;
    }

    /**
     * Decide whether one finished attempt was the last one, and say so.
     * @param {Object} action - `action_completed`'s `endCharacterAction`
     */
    check(action) {
        if (!config.getSetting(MASTER_SETTING)) return;
        if (action?.actionHrid !== ENHANCE_ACTION_HRID) return;

        const target = Math.floor(Number(action.enhancingMaxLevel) || 0);
        // No target is not a target of zero — it is "keep going", which has no
        // ending to announce
        if (!(target > 0)) return;

        const { itemHrid, level } = parseEnhancedItem(action.primaryItemHash);
        if (!itemHrid) return;

        const pair = `${itemHrid}:${target}`;
        if (level < target) {
            // Below the target again: whatever was announced for this pair is
            // over and a new grind is under way
            this.announced.delete(pair);
            return;
        }
        if (this.announced.has(pair)) return;

        const name = this.itemName(itemHrid);
        const overshot = level > target ? ` (+${level}, past your +${target})` : ` (+${target})`;
        const result = notificationService.notify(
            `${EVENT_KEY_PREFIX}:${pair}`,
            `${name} has reached your enhancement target${overshot}.`,
            { title: 'Enhancement target reached' }
        );

        // Only a delivered alert counts as told; an undelivered one is left
        // un-announced so the next attempt message can retry it
        if (result?.fired) this.announced.add(pair);
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
        this.announced.clear();
    }
}

const enhancementTargetAlerts = new EnhancementTargetAlerts();

export default enhancementTargetAlerts;
