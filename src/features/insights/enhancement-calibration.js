/**
 * Enhancement calibration
 *
 * Writes down, for every enhancement session that reached its target, where the
 * run landed in the distribution the calculator predicted for it.
 *
 * The enhancement tracker already keeps both halves: the prediction taken at
 * session start (mean, variance and physical minimum of the attempt count, all
 * off one Markov chain) and the attempts the run actually took. Nobody compares
 * them, so a chain that is quietly wrong about a tier of gear reads exactly
 * like one that is right. Unlike the profit calibrations, one session is never
 * "predicted 41, took 63, therefore off by 54%" — the distribution is heavy
 * tailed and a single draw only means anything as a percentile. That percentile
 * is what gets stored, and a *pattern* in the percentiles is what would convict
 * the chain: a calibrated model scatters them evenly, a flattering one piles
 * them up at the unlucky end.
 *
 * ## What counts as an observation
 *
 * A session that reached the target it was predicted for, whose prediction
 * carries its distribution. A session stopped by hand is censored — its attempt
 * count says where the player gave up, not where the run would have ended — and
 * a session recorded before the variance was stored has no distribution to be
 * a percentile of. Neither is an observation; recording them anyway would be
 * filling the ledger with numbers that mean nothing.
 *
 * The observed count is the current leg's — after an extension the prediction
 * was recomputed from the extension point, so the attempts diffed against it
 * must start there too.
 */

import config from '../../core/config.js';
import storage from '../../core/storage.js';
import dataManager from '../../core/data-manager.js';
import { SessionState, getCurrentLegCounters } from '../enhancement/enhancement-session.js';
import { attemptTailProbability } from '../enhancement/attempt-percentile.js';

/** Shares the calibration pairs' store; the key below is this recorder's own */
const STORE_NAME = 'lootLogHistory';

/** Plenty to see whether the percentiles scatter or pile up */
const MAX_RECORDS = 200;

class EnhancementCalibration {
    constructor() {
        this.records = null;
        /** Serialises writes against each other and against the first load */
        this.queue = Promise.resolve();
    }

    /**
     * Where this character's observations live.
     * @returns {string|null} Storage key, or null before the character is known
     */
    _key() {
        const charId = dataManager.getCurrentCharacterId();
        return charId ? `calibrationEnhancing_${charId}` : null;
    }

    /**
     * Read the stored observations into memory, once.
     * @returns {Promise<Array<Object>>} The records
     */
    async _load() {
        if (this.records) return this.records;
        const key = this._key();
        if (!key) {
            this.records = [];
            return this.records;
        }
        try {
            this.records = await storage.get(key, STORE_NAME, []);
        } catch (error) {
            console.error('[EnhancementCalibration] Could not read history:', error);
            this.records = [];
        }
        return this.records;
    }

    /** Persist the observations. */
    async _save() {
        const key = this._key();
        if (!key) return;
        try {
            await storage.set(key, this.records, STORE_NAME);
        } catch (error) {
            console.error('[EnhancementCalibration] Could not save history:', error);
        }
    }

    /**
     * Record a session that just reached its target.
     *
     * Safe to call for any session in any state — everything that is not an
     * observation is declined here rather than at every call site.
     *
     * @param {Object} session - An enhancement session (see enhancement-session.js)
     * @returns {Promise<boolean>} Whether an observation was written
     */
    async recordCompletion(session) {
        if (!config.getSetting('insights_calibration', true)) return false;
        // Only a run that actually reached its target is a draw from the
        // predicted distribution; a hand-stopped one is censored at the moment
        // the player walked away
        if (!session || session.state !== SessionState.COMPLETED) return false;
        if (session.currentLevel < session.targetLevel) return false;

        const prediction = session.predictions;
        const observed = getCurrentLegCounters(session).attempts;
        if (!(observed > 0)) return false;

        const tail = attemptTailProbability(prediction, observed);
        // Null means the prediction carries no distribution — an old session,
        // or one predicted without character stats
        if (tail === null) return false;

        const record = {
            // One observation per session and target: an extended session is a
            // new prediction and may become a second observation
            id: `${session.id}:${session.targetLevel}`,
            t: session.endTime || Date.now(),
            itemHrid: session.itemHrid,
            itemName: session.itemName,
            targetLevel: session.targetLevel,
            protectFrom: session.protectFrom || 0,
            expectedAttempts: Math.round(prediction.expectedAttemptsExact ?? prediction.expectedAttempts),
            observedAttempts: observed,
            /** P(attempts ≥ observed) under the predicted distribution */
            tailProbability: tail,
        };

        let written = false;
        this.queue = this.queue
            .then(async () => {
                await this._load();
                if (this.records.some((held) => held.id === record.id)) return;
                this.records.push(record);
                if (this.records.length > MAX_RECORDS) {
                    this.records.splice(0, this.records.length - MAX_RECORDS);
                }
                await this._save();
                written = true;
            })
            .catch((error) => {
                console.error('[EnhancementCalibration] Recording failed:', error);
            });
        await this.queue;
        return written;
    }

    // ─── Read API ────────────────────────────────────────────────────────────

    /**
     * The observations already in memory, for a panel drawing synchronously.
     * @returns {Array<Object>|null} Records, or null before the first load lands
     */
    getCachedRecords() {
        return this.records;
    }

    /**
     * The observations, loading them if this is the first ask.
     * @returns {Promise<Array<Object>>} Records, oldest first
     */
    async getRecords() {
        return await this._load();
    }

    /** Forget every observation. */
    async clear() {
        this.records = [];
        await this._save();
    }
}

const enhancementCalibration = new EnhancementCalibration();

export { enhancementCalibration, EnhancementCalibration };
export default enhancementCalibration;
