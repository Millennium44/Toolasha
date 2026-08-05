/**
 * Combat Death Alerts
 *
 * Says so when you die, which in an idle game is almost always something you
 * find out about long afterwards by wondering why the loot is thin.
 *
 * ## Where the deaths come from
 *
 * `new_battle` carries a `players` array, and each entry has the server's own
 * `deathCount` for the current combat session next to the character it belongs
 * to. That is the same figure the deaths panel shows, taken from the same
 * place, for the same reason: two sources for one number is two numbers that
 * eventually disagree, and this one is the server's.
 *
 * Nothing here watches health bars. A health bar crossing zero is visible on
 * the combat ticks, and it is also visible when a monster is replaced, when a
 * party member is swapped and whenever a tick is missed — deriving deaths from
 * it means deriving them wrong occasionally, and a notification that cries wolf
 * once is a notification that gets switched off.
 *
 * ## Only your own
 *
 * The party's other members have `deathCount` too and it is not reported. A
 * party member dying is their business and their notification; the entry that
 * matches the logged-in character id is the only one read, and when no entry
 * matches — a payload shaped in some way this does not expect — nothing is
 * announced rather than something being guessed at.
 *
 * ## Repeats
 *
 * One event key for the whole feature, so the service's cooldown caps a bad
 * zone at one message rather than one per corpse. The message carries the
 * running total, so the next one after the cooldown says how much worse it got.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import notificationService from './notification-service.js';
import { newDeaths } from './notification-predicates.js';

/** Master switch; nothing below it is consulted while this is off */
export const MASTER_SETTING = 'notifications_combatDeath';

/** One key for the whole feature, so the service's cooldown applies to it */
const EVENT_KEY = 'combat-death';

class CombatDeathAlerts {
    constructor() {
        /** The death count at the last look; null until the first sighting */
        this.lastCount = null;
        this.unregisterHandlers = [];
        this.characterSwitchingHandler = null;
    }

    /**
     * Start watching for deaths.
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

    /** Listen for the message that carries the death count */
    registerWebSocketListeners() {
        const handler = (data) => {
            try {
                this.check(data);
            } catch (error) {
                console.error('[CombatDeathAlerts] Reading a battle failed:', error);
            }
        };

        webSocketHook.on('new_battle', handler);
        this.unregisterHandlers.push(() => webSocketHook.off('new_battle', handler));
    }

    /**
     * The logged-in character's death count on this battle, if it is there.
     * @param {Object} data - `new_battle` payload
     * @returns {number|null} The count, or null when this payload does not have one
     */
    ownDeathCount(data) {
        const players = data?.players;
        if (!Array.isArray(players) || !players.length) return null;

        const characterId = dataManager.getCurrentCharacterId();
        if (!characterId) return null;

        const mine = players.find((player) => player?.character?.id === characterId);
        if (!mine) return null;

        const count = Number(mine.deathCount ?? 0);
        return Number.isFinite(count) ? count : null;
    }

    /**
     * Announce a rise in the death count.
     * @param {Object} data - `new_battle` payload
     */
    check(data) {
        if (!config.getSetting(MASTER_SETTING)) return;

        const count = this.ownDeathCount(data);
        if (count === null) return;

        const died = newDeaths(this.lastCount, count);
        // Recorded whether or not anything is said, so that a session starting
        // over — which takes the count back down — is a new baseline and not a
        // resurrection, and so that switching the setting on mid-session does
        // not announce deaths that happened before anybody was listening
        this.lastCount = count;
        if (died <= 0) return;

        const total = count === 1 ? '1 death' : `${count} deaths`;
        notificationService.notify(EVENT_KEY, `You died in combat — ${total} so far this session.`, {
            title: 'You died',
        });
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

const combatDeathAlerts = new CombatDeathAlerts();

export default combatDeathAlerts;
