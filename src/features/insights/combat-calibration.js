/**
 * Combat calibration
 *
 * Pairs the all-zones simulator's forecast for a zone with what a finished
 * combat session in that zone actually paid and earned.
 *
 * The sim's snapshot ranks every zone by profit/hr and XP/hr, and those numbers
 * steer real decisions — the pinned actions page, the planner, the "best solo
 * zone" comparison — without anyone ever checking one against a run that
 * actually happened. The combat stats collector already archives every finished
 * session with its loot, XP and consumption, so the comparison costs only the
 * bookkeeping.
 *
 * ## What counts as a pair
 *
 * The forecast context is captured while the session is *running*: the zone and
 * difficulty tier from the character's own action queue, the snapshot row for
 * that zone/tier, and the gear worn at that moment signed the same way the sim
 * signs its runs. The pair is written when the session turns up in the archived
 * history — the collector's own signal that it finished. A session never seen
 * live has no honestly-captured context, so it is skipped rather than paired
 * against whatever the character looks like later.
 *
 * ## The two sides use their own arithmetic
 *
 * The predicted side is the snapshot row as saved — `revenue − consumables` per
 * hour, chests at expected value. The actual side is `calculatePlayerStats`,
 * the same function every combat panel displays, read as income minus
 * consumable costs. Dungeon key costs are left out of the actual side because
 * the sim never charges them on the predicted side; subtracting them from one
 * half only would manufacture a permanent "gap" that is really an accounting
 * difference.
 *
 * ## Staleness is carried, not hidden
 *
 * A sim run from last week, or one played in different gear, is not wrong so
 * much as about somebody else. Every pair records the snapshot's age and
 * whether the gear signatures matched (null when either side could not be
 * signed), and the panel shows the flag with the pair.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
// Through the default export rather than as named imports: the combat sim is a
// bundle of its own, and a cross-bundle named import compiles to a property
// read that would be undefined in the production bundles
import combatSimUI from '../combat-sim/combat-sim-ui.js';
// Stateless functions, so the production bundle split can hold a copy on this
// side: both read the same storage the collector writes
import { sessionKey, loadSessions } from '../combat-stats/combat-session-history.js';
import { calculatePlayerStats } from '../combat-stats/combat-stats-calculator.js';
import { predictionCalibration, MIN_DURATION_SEC } from './prediction-calibration.js';
import { loadAllZonesSnapshot } from '../../utils/all-zones-snapshot.js';

/**
 * How many sessions can be awaiting their archive entry at once.
 *
 * Normally one — the running session — plus the finished ones whose archive
 * write has not landed yet. Anything past a handful means the collector is off
 * and the archive is never coming.
 */
const MAX_PENDING = 8;

class CombatCalibration {
    constructor() {
        this.initialized = false;
        this.unregisterHandlers = [];
        /** session key → forecast context captured while it was running */
        this.pending = new Map();
        /** The session the character is in right now, by key */
        this.currentKey = null;
        /** Serialises the async handler against itself */
        this.queue = Promise.resolve();
    }

    /**
     * Start watching battles.
     * @returns {Promise<boolean>} Whether the feature is on
     */
    async initialize() {
        if (this.initialized) return true;
        if (!config.getSetting('insights_calibration', true)) return false;

        const handler = (data) => this._onNewBattle(data);
        webSocketHook.on('new_battle', handler);
        this.unregisterHandlers.push(() => webSocketHook.off('new_battle', handler));

        this.initialized = true;
        return true;
    }

    /**
     * Handle a new_battle message. Queued: capturing a context reads storage
     * and the gear, and two overlapping passes would each capture the same
     * session.
     * @param {Object} data - The message
     */
    _onNewBattle(data) {
        this.queue = this.queue.then(() => this._process(data)).catch(() => {});
    }

    /**
     * Capture the running session's forecast context, and pair any finished
     * sessions that have reached the archive.
     * @param {Object} data - A new_battle payload
     */
    async _process(data) {
        const key = sessionKey(data);
        if (key && key !== this.currentKey) {
            this.currentKey = key;
            if (!this.pending.has(key)) {
                await this._capture(key);
                this._prunePending();
            }
        }

        await this._resolveFinished();
    }

    /**
     * Take the forecast for the session that is running now.
     *
     * Taken while the run is live because that is the only moment the tier and
     * the gear are knowably the session's own — the archive stores neither, and
     * by archive time the character is already fighting the next session.
     *
     * @param {string} key - The session's key
     */
    async _capture(key) {
        try {
            const zone = this._currentZone();
            if (!zone) return;

            const snapshot = await loadAllZonesSnapshot();
            const row = (snapshot?.zones || []).find(
                (candidate) =>
                    candidate?.zoneHrid === zone.actionHrid && (candidate.difficultyTier ?? 0) === zone.difficultyTier
            );
            // No row for this zone/tier means the sim has nothing on record to
            // be checked — not a pair, not even a bad one
            if (!row || !Number.isFinite(row.profitPerHour)) return;

            // Only a mismatch between two known signatures means anything; an
            // unsigned snapshot or unreadable gear is "unknown", not "changed"
            let fingerprintMatch = null;
            const worn = await combatSimUI.currentGearFingerprint();
            if (snapshot.fingerprint && worn) fingerprintMatch = snapshot.fingerprint === worn;

            this.pending.set(key, {
                actionHrid: zone.actionHrid,
                difficultyTier: zone.difficultyTier,
                predicted: row.profitPerHour,
                predictedXpPerHour: Number.isFinite(row.xpPerHour) ? row.xpPerHour : null,
                snapshotSavedAt: snapshot.savedAt ?? null,
                fingerprintMatch,
                capturedAt: Date.now(),
            });
        } catch (error) {
            console.error('[CombatCalibration] Capturing the forecast failed:', error);
        }
    }

    /**
     * The combat action the character is on, with its difficulty tier.
     *
     * The same read the collector's `currentCombatAction` does, plus the tier —
     * which only the live action queue knows; the archived session does not
     * keep it.
     *
     * @returns {{actionHrid: string, difficultyTier: number}|null}
     */
    _currentZone() {
        try {
            const actions = dataManager.getCurrentActions?.();
            if (!Array.isArray(actions)) return null;
            const combat = actions.find(
                (action) => action?.actionHrid?.startsWith('/actions/combat/') && !action.isDone
            );
            return combat ? { actionHrid: combat.actionHrid, difficultyTier: combat.difficultyTier || 0 } : null;
        } catch {
            return null;
        }
    }

    /**
     * Write pairs for pending sessions that have reached the archive.
     *
     * Polled from each battle rather than hooked into the archiver: the
     * collector lives in another bundle and archives asynchronously, so "is it
     * in the stored history yet" is the one signal that cannot race it.
     */
    async _resolveFinished() {
        const finished = [...this.pending.keys()].filter((key) => key !== this.currentKey);
        if (!finished.length) return;

        const archived = await loadSessions();
        for (const key of finished) {
            const session = archived.find((entry) => entry.key === key);
            if (!session) continue;

            const context = this.pending.get(key);
            this.pending.delete(key);
            await this._record(key, context, session);
        }
    }

    /**
     * Write one pair.
     * @param {string} key - The session's key
     * @param {Object} context - The forecast captured while it ran
     * @param {Object} session - The archived session
     */
    async _record(key, context, session) {
        try {
            const durationSec = session.durationSeconds || 0;
            // Below the same floor the other calibrations use, the "rate" is
            // mostly the clock
            if (!(durationSec >= MIN_DURATION_SEC)) return;

            // The zone the archive remembers must be the zone the forecast was
            // for; a mismatch means the queue moved between capture and battle
            if (session.actionHrid && session.actionHrid !== context.actionHrid) return;

            const player = (session.players || []).find((entry) => entry.isCurrentPlayer);
            if (!player) return;

            const stats = calculatePlayerStats(player, durationSec);

            // Income minus consumables, matching what the sim's netPerHour
            // covers — key costs are deliberately on neither side (see header)
            const actual = (stats.dailyIncome.ask - stats.dailyConsumableCosts) / 24;
            const actualBid = (stats.dailyIncome.bid - stats.dailyConsumableCosts) / 24;
            if (!Number.isFinite(actual)) return;

            await predictionCalibration.addRecord({
                id: `combat|${key}`,
                actionHrid: context.actionHrid,
                actionType: 'combat',
                t: Date.now(),
                durationSec,
                actionCount: session.battleId || 0,
                predicted: context.predicted,
                actual,
                actualBid,
                // Combat-only context, additive on the shared record shape
                difficultyTier: context.difficultyTier,
                predictedXpPerHour: context.predictedXpPerHour,
                actualXpPerHour: Number.isFinite(stats.expPerHour) ? stats.expPerHour : null,
                snapshotAgeMs:
                    context.snapshotSavedAt !== null ? Math.max(0, context.capturedAt - context.snapshotSavedAt) : null,
                fingerprintMatch: context.fingerprintMatch,
            });
        } catch (error) {
            console.error('[CombatCalibration] Recording a pair failed:', error);
        }
    }

    /** Keep the pending map from collecting sessions whose archive never comes. */
    _prunePending() {
        while (this.pending.size > MAX_PENDING) {
            const oldest = this.pending.keys().next().value;
            this.pending.delete(oldest);
        }
    }

    /** Cleanup when disabled. */
    disable() {
        for (const unregister of this.unregisterHandlers) unregister();
        this.unregisterHandlers = [];
        this.pending.clear();
        this.currentKey = null;
        this.initialized = false;
    }
}

const combatCalibration = new CombatCalibration();

export { combatCalibration, CombatCalibration };
export default combatCalibration;
