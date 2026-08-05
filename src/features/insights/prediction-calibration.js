/**
 * Prediction calibration
 *
 * Keeps the profit calculators honest by writing down what they promised and
 * what the run actually paid.
 *
 * Every profit figure in this script is a forecast: drop rates times prices
 * times an efficiency model, none of which anybody checks against a finished
 * run. A stale price, a buff the model does not know about or a drop table the
 * game changed all read the same way — a confident number that is quietly wrong
 * for weeks. The loot log already records what each run produced, so the
 * comparison costs nothing but the bookkeeping.
 *
 * ## What counts as a pair
 *
 * A prediction is snapshotted for the **running** action, the moment it is first
 * seen, because that is when the gear, teas and prices behind the forecast are
 * the ones the run is actually being played with. The pair is written when that
 * run is superseded by a newer one — the game's own signal that it finished.
 *
 * Runs that were already over when the page loaded are deliberately skipped. A
 * prediction computed now against a run played under yesterday's gear is not a
 * calibration measurement, it is noise dressed as one.
 *
 * ## Nothing here is written by hand
 *
 * The predicted side calls the same `calculateGatheringProfit` /
 * `calculateProductionProfit` the action panels display, and the actual side
 * uses the loot log's own profit arithmetic. Reimplementing either would mean
 * this feature could disagree with the panels and still call itself calibrated.
 */

import config from '../../core/config.js';
import storage from '../../core/storage.js';
import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import { calculateGatheringProfit } from '../actions/gathering-profit.js';
import { calculateProductionProfit } from '../actions/production-profit.js';
import { LootLogStats } from '../actions/loot-log-stats.js';
import { GATHERING_TYPES, PRODUCTION_TYPES } from '../../utils/profit-constants.js';
import { runInBackground } from '../../utils/background-work.js';

/** Shares the loot log's store; the key is this feature's own */
const STORE_NAME = 'lootLogHistory';

/** Enough history to see a trend, small enough to keep in memory and redraw */
const MAX_RECORDS = 1000;

/** Under a minute a run's actual rate is mostly rounding on the clock */
const MIN_DURATION_SEC = 60;

/**
 * The skill an action belongs to, as the loot log names it.
 * @param {string} actionHrid - e.g. `/actions/milking/cow`
 * @returns {string} e.g. `milking`
 */
export function actionTypeOf(actionHrid) {
    const parts = (actionHrid || '').split('/');
    return parts.length >= 3 ? parts[2] : 'unknown';
}

class PredictionCalibration {
    constructor() {
        this.initialized = false;
        this.records = null;
        this.unregisterHandlers = [];
        /** characterActionId → the forecast taken while it was running */
        this.pending = new Map();
        /** Ids already written, so a repeated loot log message does not double up */
        this.recorded = new Set();
        /** Serialises the async handler against itself */
        this.queue = Promise.resolve();
        this.lootLogMath = null;
    }

    /**
     * Start recording.
     * @returns {Promise<boolean>} Whether the feature is on — the caller puts up
     *   the tile only when it is
     */
    async initialize() {
        if (this.initialized) return true;
        if (!config.getSetting('insights_calibration', true)) return false;

        const handler = (data) => this._onLootLog(data);
        webSocketHook.on('loot_log_updated', handler);
        this.unregisterHandlers.push(() => webSocketHook.off('loot_log_updated', handler));

        // Nobody is looking at the panel yet, and this is a storage read
        this.ready = runInBackground('predictionCalibration', () => this._load());

        this.initialized = true;
        return true;
    }

    /**
     * Where this character's pairs live.
     * @returns {string|null} Storage key, or null before the character is known
     */
    _key() {
        const charId = dataManager.getCurrentCharacterId();
        return charId ? `calibration_${charId}` : null;
    }

    /**
     * Read the stored pairs into memory, once.
     * @returns {Promise<Array<Object>>} The records
     */
    async _load() {
        const key = this._key();
        if (!key) {
            this.records = this.records || [];
            return this.records;
        }
        try {
            this.records = await storage.get(key, STORE_NAME, []);
        } catch (error) {
            console.error('[PredictionCalibration] Could not read history:', error);
            this.records = [];
        }
        for (const record of this.records) this.recorded.add(record.id);
        return this.records;
    }

    /**
     * Handle a loot_log_updated message.
     *
     * Queued rather than run straight away: the messages arrive faster than the
     * profit calculators return, and two overlapping passes would each decide
     * the same run still needed recording.
     *
     * @param {Object} data - The message
     */
    _onLootLog(data) {
        if (!Array.isArray(data?.lootLog) || data.lootLog.length === 0) return;
        const entries = [...data.lootLog];
        this.queue = this.queue.then(() => this._process(entries)).catch(() => {});
    }

    /**
     * Snapshot the running action's forecast, and write pairs for the runs it
     * has replaced.
     * @param {Array<Object>} entries - Loot log entries
     */
    async _process(entries) {
        if (this.ready) await this.ready;
        if (!this.records) await this._load();

        const sorted = entries
            .filter((entry) => entry?.characterActionId && entry.actionHrid)
            .sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
        if (!sorted.length) return;

        const [running, ...finished] = sorted;

        // The forecast belongs to the run that is happening now — taken later it
        // would be measured against whatever the character is wearing later
        if (!this.pending.has(running.characterActionId) && !this.recorded.has(running.characterActionId)) {
            const predicted = await this._predict(running.actionHrid);
            if (predicted !== null) {
                this.pending.set(running.characterActionId, { predicted, at: Date.now() });
            }
        }

        let changed = false;
        for (const entry of finished) {
            if (await this._record(entry)) changed = true;
        }

        if (changed) await this._save();
    }

    /**
     * Write one finished run, if it has a forecast waiting for it.
     * @param {Object} entry - Loot log entry
     * @returns {Promise<boolean>} Whether anything was added
     */
    async _record(entry) {
        const id = entry.characterActionId;
        if (this.recorded.has(id)) return false;

        const forecast = this.pending.get(id);
        // No forecast means the run was over before the script saw it start
        if (!forecast) return false;
        this.pending.delete(id);

        const durationSec = (new Date(entry.endTime) - new Date(entry.startTime)) / 1000;
        if (!Number.isFinite(durationSec) || durationSec < MIN_DURATION_SEC) return false;

        const actual = this._actual(entry, durationSec);
        if (actual === null) return false;

        this.records.push({
            id,
            actionHrid: entry.actionHrid,
            actionType: actionTypeOf(entry.actionHrid),
            t: new Date(entry.endTime).getTime() || Date.now(),
            durationSec,
            actionCount: entry.actionCount || 0,
            predicted: forecast.predicted,
            actual: actual.perHour,
            actualBid: actual.perHourBid,
        });
        this.recorded.add(id);

        if (this.records.length > MAX_RECORDS) {
            const dropped = this.records.splice(0, this.records.length - MAX_RECORDS);
            for (const record of dropped) this.recorded.delete(record.id);
        }
        return true;
    }

    /**
     * What the calculators say this action is worth per hour, right now.
     * @param {string} actionHrid - Action HRID
     * @returns {Promise<number|null>} Profit per hour, or null when not forecastable
     */
    async _predict(actionHrid) {
        try {
            const type = dataManager.getActionDetails(actionHrid)?.type;
            let data = null;
            if (GATHERING_TYPES.includes(type)) {
                data = await calculateGatheringProfit(actionHrid);
            } else if (PRODUCTION_TYPES.includes(type)) {
                data = await calculateProductionProfit(actionHrid);
            }
            // Combat, alchemy and enhancing have no per-action forecast to check
            if (!data || data.hasMissingPrices) return null;
            return Number.isFinite(data.profitPerHour) ? data.profitPerHour : null;
        } catch (error) {
            console.error('[PredictionCalibration] Prediction failed:', error);
            return null;
        }
    }

    /**
     * What the run actually paid per hour, by the loot log's own arithmetic.
     * @param {Object} entry - Loot log entry
     * @param {number} durationSec - How long the run took
     * @returns {{perHour: number, perHourBid: number}|null}
     */
    _actual(entry, durationSec) {
        try {
            if (!this.lootLogMath) this.lootLogMath = new LootLogStats();
            const profit = this.lootLogMath.calculateProfit(entry);
            if (!profit || !Number.isFinite(profit.askProfit)) return null;
            const hours = durationSec / 3600;
            if (hours <= 0) return null;
            return { perHour: profit.askProfit / hours, perHourBid: profit.bidProfit / hours };
        } catch (error) {
            console.error('[PredictionCalibration] Actual profit failed:', error);
            return null;
        }
    }

    /** Persist the pairs. */
    async _save() {
        const key = this._key();
        if (!key) return;
        try {
            await storage.set(key, this.records, STORE_NAME);
        } catch (error) {
            console.error('[PredictionCalibration] Could not save history:', error);
        }
    }

    // ─── Read API ────────────────────────────────────────────────────────────

    /**
     * The pairs already in memory, for a panel that must draw synchronously.
     * @returns {Array<Object>|null} Records, or null before the first load lands
     */
    getCachedRecords() {
        return this.records;
    }

    /**
     * The pairs, loading them if this is the first ask.
     * @returns {Promise<Array<Object>>} Records, newest last
     */
    async getRecords() {
        if (!this.records) await this._load();
        return this.records;
    }

    /** Forget every recorded pair. */
    async clear() {
        this.records = [];
        this.recorded.clear();
        this.pending.clear();
        await this._save();
    }

    /** Cleanup when disabled. */
    disable() {
        for (const unregister of this.unregisterHandlers) unregister();
        this.unregisterHandlers = [];
        this.pending.clear();
        this.initialized = false;
    }
}

const predictionCalibration = new PredictionCalibration();

// The feature module lives in `index.js`, which also brings up the panel — this
// file is only the recorder, so the panel can import it without a cycle.
export { predictionCalibration, PredictionCalibration };
export default predictionCalibration;
