/**
 * Party Status Alerts
 *
 * Says so when the party you are in starts or stops fighting. A party's fight is
 * decided by other people (the leader starts it, the leader or the server ends
 * it), so it is the one combat change you are least likely to be watching for.
 *
 * ## Where it listens
 *
 * `dataManager` already reads every `party_updated` message and emits
 * `party_status_changed` ({status, previousStatus, started, stopped}) when the
 * party enters or leaves 'battling'. It does that only for the character's own
 * socket and not while a character switch is under way, so a stale connection's
 * party never reaches here. This module adds the alert and nothing else.
 *
 * ## When a change is a change
 *
 * Only when the status the party had before is known. The login payload does not
 * always say what state the party is in, and the first `party_updated` after it
 * then arrives with nothing to compare against: that is the game telling us the
 * state, not the party changing it. `previousStatus` is null in that case (and
 * also for a character with no party at all), so a null previous status is never
 * announced. The cost is that a start which is the very first status the tab
 * ever sees goes unannounced; the alternative was an alert on every login that
 * lands in a fight.
 *
 * ## What it cannot say
 *
 * Why the party stopped. `party_updated` carries a status and no reason, so the
 * text names only what the status now is.
 *
 * ## Once per change
 *
 * Every change is its own event, so the key carries a counter that never
 * restarts, and the character: the service's de-duplication map outlives a
 * character switch, and a counter that went back to zero would hand the arriving
 * character a key the departing one had just used.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import notificationService from './notification-service.js';

/** Master switch; nothing below it is consulted while this is off */
export const MASTER_SETTING = 'notifications_partyStatus';

/**
 * The least time between two alerts. `party_updated` has not been captured across a repeating
 * dungeon or zone loop, so whether its status flips between runs is unknown; this caps the cost
 * if it does. A real stop just after a start stays quiet, which is the cheaper mistake.
 */
const MIN_ALERT_GAP_MS = 60_000;

/** Prefix for the notification service's event keys */
const EVENT_KEY_PREFIX = 'party-status';

/**
 * What the party fight is called in the message.
 * @param {Object} [dm] - Injectable for tests
 * @returns {string} The zone's name, or an empty string when it is not known
 */
function zoneName(dm = dataManager) {
    const hrid = dm.characterData?.partyInfo?.party?.actionHrid;
    if (!hrid) return '';
    return dm.getActionDetails?.(hrid)?.name || String(hrid).split('/').pop().replace(/_/g, ' ');
}

/**
 * The text for one change.
 * @param {{status: string|null, started: boolean}} change - From `party_status_changed`
 * @param {string} zone - Where the party fights, or ''
 * @returns {string} The message
 */
export function changeMessage(change, zone) {
    if (change.started) {
        return zone ? `Your party has started fighting in ${zone}.` : 'Your party has started fighting.';
    }
    // No party left at all, or one that was disbanded: the game's two spellings of "it is over"
    if (change.status == null || change.status === 'disbanded') {
        return 'Your party has stopped fighting — it was disbanded or you are no longer in it.';
    }
    return `Your party has stopped fighting and is now ${change.status}.`;
}

class PartyStatusAlerts {
    constructor() {
        /** Changes told so far; part of the event key and never reset (see the module comment) */
        this.changeSeq = 0;
        /** When the last alert fired, for {@link MIN_ALERT_GAP_MS} */
        this.lastFiredAt = 0;
        /** The character this instance was started for */
        this.characterId = null;
        this.changeHandler = null;
        this.characterSwitchingHandler = null;
    }

    /**
     * Start watching the party's status.
     * @returns {Promise<void>}
     */
    async initialize() {
        if (!config.getSetting(MASTER_SETTING)) {
            return;
        }
        // A second initialize without a disable would double every alert
        this.disable();

        this.characterId = dataManager.getCurrentCharacterId?.() ?? null;

        this.changeHandler = (change) => {
            try {
                this.onChange(change);
            } catch (error) {
                console.error('[PartyStatusAlerts] Handling a party status change failed:', error);
            }
        };
        dataManager.on('party_status_changed', this.changeHandler);

        this.characterSwitchingHandler = () => {
            this.disable();
        };
        dataManager.on('character_switching', this.characterSwitchingHandler);
    }

    /**
     * Announce one change.
     *
     * dataManager delivers its events a tick after emitting them, so the setting
     * and the character are checked again here rather than trusted from when
     * the listener was registered.
     *
     * @param {{status: string|null, previousStatus: string|null, started: boolean, stopped: boolean}} change
     * @returns {Object|null} What the service did, for tests
     */
    onChange(change) {
        if (!config.getSetting(MASTER_SETTING)) return null;
        if (!change || (!change.started && !change.stopped)) return null;
        if (dataManager.isCharacterSwitching) return null;

        const current = dataManager.getCurrentCharacterId?.() ?? null;
        if (this.characterId !== current) return null;

        // The party's earlier state was never known: a status arriving, not a status changing
        if (change.previousStatus == null) return null;
        if (Date.now() - this.lastFiredAt < MIN_ALERT_GAP_MS) return null;

        const who = current || 'unknown';
        const key = `${EVENT_KEY_PREFIX}:${who}:${this.changeSeq + 1}`;
        const result = notificationService.notify(key, changeMessage(change, change.started ? zoneName() : ''), {
            title: change.started ? 'Party started' : 'Party stopped',
        });
        if (result?.fired) {
            this.changeSeq += 1;
            this.lastFiredAt = Date.now();
        }
        return result;
    }

    /**
     * Cleanup
     */
    disable() {
        if (this.changeHandler) {
            dataManager.off('party_status_changed', this.changeHandler);
            this.changeHandler = null;
        }
        if (this.characterSwitchingHandler) {
            dataManager.off('character_switching', this.characterSwitchingHandler);
            this.characterSwitchingHandler = null;
        }
        this.characterId = null;
    }
}

const partyStatusAlerts = new PartyStatusAlerts();

export default partyStatusAlerts;
export { PartyStatusAlerts };
