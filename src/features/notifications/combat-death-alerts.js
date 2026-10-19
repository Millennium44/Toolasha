/**
 * Combat Death Alerts
 *
 * Says so when you die, which in an idle game is almost always something you
 * find out about long afterwards by wondering why the loot is thin.
 *
 * ## Where the deaths come from
 *
 * **On the tick, at the moment of death.** A solo death produces no `new_battle`:
 * the player respawns inside the same battle about 15 s later, so waiting for the
 * server's counter announces a death only after it is over. The local player's
 * `battle_updated.pMap` entry going to `cHP` 0 (or `isActive` false) is the
 * signal, once per life: it is re-armed only when the entry shows HP back above
 * 0 or `isActive` true. A tick that omits the entry means "unchanged" and is
 * neither a death nor a respawn.
 *
 * **The server's counter, as the fallback.** `new_battle` carries a `players`
 * array, and each entry has the server's own `deathCount` for the current combat
 * session. A rise is reconciled against the deaths already announced from ticks
 * in the fight that just ended; only the remainder — a tick that was missed, a
 * throttled background tab — is announced from the counter. The count is also
 * what the panel shows, taken from the same place, so the two cannot drift.
 *
 * ## Only your own
 *
 * The party's other members have `deathCount` and tick entries too and they are
 * not reported. A party member dying is their business and their notification;
 * the entry that matches the logged-in character id is the only one read (its
 * position in the battle is what keys `pMap`), and when no entry
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
import { openRecap, SETTING as RECAP_SETTING } from './death-recap.js';
import { seatFromBattle, seatFromTick, guessContradicted, rosterHp } from './own-seat.js';

/** Master switch; nothing below it is consulted while this is off */
export const MASTER_SETTING = 'notifications_combatDeath';

/** One key for the whole feature, so the service's cooldown applies to it */
const EVENT_KEY = 'combat-death';

class CombatDeathAlerts {
    constructor() {
        /** The death count at the last look; null until the first sighting */
        this.lastCount = null;
        /** The local player's position in the battle (the `pMap` key), from the latest `new_battle` */
        this.ownIndex = null;
        /** Whether the seat came from the solo fallback rather than a roster */
        this.seatGuessed = false;
        /** Whether a new_battle has arrived since start */
        this.battleSeen = false;
        /** Whether this life has already been announced from a tick; re-armed by a tick showing us alive */
        this.deadAnnounced = false;
        /** Deaths announced from ticks that no counter reading has reconciled yet */
        this.tickDeaths = 0;
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

        const tickHandler = (data) => {
            try {
                this.checkTick(data);
            } catch (error) {
                console.error('[CombatDeathAlerts] Reading a combat tick failed:', error);
            }
        };

        webSocketHook.on('battle_updated', tickHandler);
        this.unregisterHandlers.push(() => webSocketHook.off('battle_updated', tickHandler));
    }

    /**
     * Announce our own death the tick it happens.
     * @param {Object} data - `battle_updated` payload
     */
    checkTick(data) {
        if (!config.getSetting(MASTER_SETTING)) return;
        if (this.ownIndex === null) {
            // A new_battle that named no seat of ours is an answer (not our fight); only a missing one is a gap
            if (this.battleSeen) return;
            // No new_battle named the seat (a reload in an ongoing fight): the cached battle or a safe solo guess
            const found = seatFromTick(data);
            if (!found) return;
            this.ownIndex = found.index;
            this.seatGuessed = found.guessed;
        } else if (this.seatGuessed && guessContradicted(data)) {
            this.ownIndex = null;
            this.seatGuessed = false;
            return;
        }

        // An omitted entry is "unchanged" — never a death, never a respawn
        const player = data?.pMap?.[this.ownIndex];
        if (!player) return;

        const hp = player.cHP === undefined || player.cHP === null ? NaN : Number(player.cHP);
        const down = (Number.isFinite(hp) && hp <= 0) || player.isActive === false;
        const up = !down && ((Number.isFinite(hp) && hp > 0) || player.isActive === true);

        if (up) {
            this.deadAnnounced = false;
            return;
        }
        if (!down || this.deadAnnounced) return;

        this.deadAnnounced = true;
        this.tickDeaths += 1;
        const total = this.lastCount === null ? 0 : this.lastCount + this.tickDeaths;
        const message =
            total > 0 ? `You died in combat — ${this.totalText(total)} so far this session.` : 'You died in combat.';
        this.announce(message);
    }

    /**
     * @param {number} count - Running total
     * @returns {string} "1 death" / "N deaths"
     */
    totalText(count) {
        return count === 1 ? '1 death' : `${count} deaths`;
    }

    /**
     * Say it, with the recap one click away.
     * @param {string} message - Body text
     */
    announce(message) {
        notificationService.notify(EVENT_KEY, message, {
            title: 'You died',
            // Only while the recap feature is on: with it off there is never a recap to open. Opened on
            // click, by which time the recap module has frozen or confirmed this death's recap
            ...(config.getSetting(RECAP_SETTING)
                ? { action: { label: 'View death recap', onClick: () => openRecap() } }
                : {}),
        });
    }

    /**
     * The logged-in character's death count on this battle, if it is there.
     * @param {Object} data - `new_battle` payload
     * @returns {number|null} The count, or null when this payload does not have one
     */
    ownDeathCount(data) {
        const mine = seatFromBattle(data)?.player;
        if (!mine) return null;

        const count = Number(mine.deathCount ?? 0);
        return Number.isFinite(count) ? count : null;
    }

    /**
     * The local player's position in a `new_battle`, which is the key `pMap` uses.
     * @param {Object} data - `new_battle` payload
     * @returns {{index: string, player: Object}|null} Null when no entry is ours
     */
    ownSeat(data) {
        return seatFromBattle(data);
    }

    /**
     * Announce a rise in the death count that no tick announced.
     * @param {Object} data - `new_battle` payload
     */
    check(data) {
        if (!config.getSetting(MASTER_SETTING)) return;

        // The seat and the fresh life belong to this battle whatever the count says
        const seat = this.ownSeat(data);
        this.ownIndex = seat ? seat.index : null;
        this.seatGuessed = false;
        this.battleSeen = true;
        // Still dead if the roster says so (a new wave starting while we wait to respawn); unknown keeps the state
        const startHp = seat ? rosterHp(seat.player) : NaN;
        this.deadAnnounced = seat ? (Number.isFinite(startHp) ? startHp <= 0 : this.deadAnnounced) : false;

        const count = this.ownDeathCount(data);
        if (count === null) return;

        // A counter that went down is a new session: deaths announced before it are not owed a rise
        // A first reading is only a baseline: it consumes nothing
        if (this.lastCount !== null && count < this.lastCount) this.tickDeaths = 0;
        const died = newDeaths(this.lastCount, count);
        // Recorded whether or not anything is said, so that a session starting
        // over — which takes the count back down — is a new baseline and not a
        // resurrection, and so that switching the setting on mid-session does
        // not announce deaths that happened before anybody was listening
        this.lastCount = count;
        // Deaths the ticks already announced are not announced again. They stay owed until a rise
        // consumes them: the counter can lag the death by several battles
        const consumed = Math.min(died, this.tickDeaths);
        this.tickDeaths -= consumed;
        if (died - consumed <= 0) return;

        this.announce(`You died in combat — ${this.totalText(count)} so far this session.`);
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
        this.ownIndex = null;
        this.seatGuessed = false;
        this.battleSeen = false;
        this.deadAnnounced = false;
        this.tickDeaths = 0;
    }
}

const combatDeathAlerts = new CombatDeathAlerts();

export default combatDeathAlerts;
