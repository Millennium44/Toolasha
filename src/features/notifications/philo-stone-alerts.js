/**
 * Philosopher's Stone Alerts
 *
 * Says so when transmuting produces a Philosopher's Stone — the rare jackpot
 * of the drop table, worth on the order of hundreds of millions and dropping
 * roughly one attempt in ten. Transmuting runs unattended for hours, and this
 * is exactly the kind of moment the notification system already exists for:
 * the player currently only finds out by looking.
 *
 * ## Read from the game, not from the transmute tracker
 *
 * The same reasoning `enhancement-target-alerts.js` gives applies here
 * verbatim. Toolasha's transmute history tracker sees the same
 * `action_completed` message and could, in principle, say whether a stone
 * came out of it. Asking it would still be wrong: its session state is
 * mutated from a handler on this same message, so which of the two runs
 * first would decide whether the drop is seen, and the tracker is a feature
 * the player can switch off — which would silently take this notification
 * off with it for no reason the player could see. The game's own
 * `endCharacterItems` rows are on the wire either way, and this reads them
 * directly.
 *
 * ## Delta, not absolute total
 *
 * `endCharacterItems` rows carry a stack's new ABSOLUTE total, not the
 * amount gained by this action — the same trap the transmute tracker's own
 * comments warn about. A stone stack sitting at 3 says nothing on its own;
 * only "3, up from 2" is news. This keeps the last-seen total and only
 * speaks when it goes up. The first sighting has nothing to compare against
 * and only establishes that baseline — it is not announced, since it may be
 * describing a stack the player already had rather than one just produced.
 *
 * ## Once per stone, not once per session
 *
 * The event key is built from the new absolute count, which only advances
 * when a further stone actually lands, so two stones earned in the same
 * session are two separate announcements rather than one. A batched message
 * that covers several successful attempts reports the whole gain in one
 * line rather than pretending it was one stone.
 *
 * Scoped to transmute: coinify and decompose do not produce stones, and this
 * does not listen for their actions at all.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import notificationService from './notification-service.js';
import { PHILO_HRID } from '../alchemy/philosophers-stone-hrid.js';

/** Master switch; nothing below it is consulted while this is off */
export const MASTER_SETTING = 'notifications_philosophersStone';

/** The one action this cares about */
export const TRANSMUTE_ACTION_HRID = '/actions/alchemy/transmute';

/** Prefix for the notification service's event keys */
const EVENT_KEY_PREFIX = 'philosophers-stone';

class PhiloStoneAlerts {
    constructor() {
        /** Last known absolute count of the stone stack; null until first seen */
        this.lastCount = null;
        this.unregisterHandlers = [];
        this.characterSwitchingHandler = null;
    }

    /**
     * Start watching transmute results for the stone.
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

    /** Listen for finished transmute attempts */
    registerWebSocketListeners() {
        const handler = (data) => {
            try {
                this.check(data);
            } catch (error) {
                console.error('[PhiloStoneAlerts] Reading a transmute result failed:', error);
            }
        };

        webSocketHook.on('action_completed', handler);
        this.unregisterHandlers.push(() => webSocketHook.off('action_completed', handler));
    }

    /**
     * The name the game gives the stone, falling back to a plain label.
     * @returns {string} Display name
     */
    itemName() {
        try {
            const name = dataManager.getInitClientData()?.itemDetailMap?.[PHILO_HRID]?.name;
            if (name) return name;
        } catch (error) {
            console.error('[PhiloStoneAlerts] Reading the item name failed:', error);
        }
        return "Philosopher's Stone";
    }

    /**
     * Decide whether one `action_completed` message reports a fresh stone, and
     * say so.
     * @param {Object} data - `action_completed`'s payload
     */
    check(data) {
        if (!config.getSetting(MASTER_SETTING)) return;
        if (data?.endCharacterAction?.actionHrid !== TRANSMUTE_ACTION_HRID) return;

        const row = (data.endCharacterItems || []).find((r) => r?.itemHrid === PHILO_HRID);
        if (!row) return;

        const count = Number(row.count);
        if (!Number.isFinite(count)) return;

        const previous = this.lastCount;

        // No baseline yet: this message only establishes one. Whatever this
        // row's total is, it may be a stack the player already had rather than
        // one produced just now, so nothing is announced on the strength of it
        // alone.
        if (previous === null) {
            this.lastCount = count;
            return;
        }

        const gained = count - previous;
        if (gained <= 0) {
            this.lastCount = count;
            return;
        }

        const name = this.itemName();
        const message = gained === 1 ? `Transmuting produced a ${name}!` : `Transmuting produced ${gained} ${name}s!`;

        // The new absolute total is the key: it only advances on a further
        // gain, so each stone (or batch of stones) gets its own announcement
        // rather than being deduplicated against the last one.
        const result = notificationService.notify(`${EVENT_KEY_PREFIX}:${count}`, message, {
            title: "Philosopher's Stone!",
        });

        // Only a delivered alert counts as told; an undelivered one leaves the
        // baseline where it was so the next message recomputes the same gain
        // and retries it
        if (result?.fired) this.lastCount = count;
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
        this.lastCount = null;
    }
}

const philoStoneAlerts = new PhiloStoneAlerts();

export default philoStoneAlerts;
