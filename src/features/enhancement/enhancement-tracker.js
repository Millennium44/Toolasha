/**
 * Enhancement Tracker
 * Main tracker class for monitoring enhancement attempts, costs, and statistics
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import {
    createSession,
    recordSuccess,
    recordFailure,
    addMaterialCost,
    addCoinCost,
    addProtectionCost,
    finalizeSession,
    canExtendSession,
    extendSession,
    validateSession,
    normalizeSession,
    canResumeSession,
    resumeSession,
    planSessionMerge,
    foldSessions,
    calibrationObservation,
    SessionState,
} from './enhancement-session.js';
import enhancementCalibration from '../insights/enhancement-calibration.js';
import {
    saveSessions,
    loadSessions,
    saveCurrentSessionId,
    loadCurrentSessionId,
    sessionsLoaded,
} from './enhancement-storage.js';
import { calculateEnhancementPredictions } from './enhancement-xp.js';
import { getEnhancementMaterialPrice } from './tooltip-enhancement.js';

/**
 * EnhancementTracker class manages enhancement tracking sessions
 */
class EnhancementTracker {
    constructor() {
        this.sessions = {}; // All sessions (keyed by session ID)
        this.currentSessionId = null; // Currently active session ID
        this.isInitialized = false;
        this.pendingSessionStart = false; // Start new session on next action_completed regardless of currentCount
    }

    /**
     * Initialize enhancement tracker
     * @returns {Promise<void>}
     */
    async initialize() {
        if (this.isInitialized) {
            return;
        }

        if (!config.getSetting('enhancementTracker')) {
            return;
        }

        try {
            // Load sessions from storage
            this.sessions = await loadSessions();
            this.currentSessionId = await loadCurrentSessionId();

            // Validate current session still exists — only against a list
            // actually read back; after a read that could not be made the
            // session may well be stored and merely not in hand
            if (this.currentSessionId && sessionsLoaded() && !this.sessions[this.currentSessionId]) {
                this.currentSessionId = null;
                await saveCurrentSessionId(null);
            }

            // Validate all loaded sessions
            for (const [sessionId, session] of Object.entries(this.sessions)) {
                if (!validateSession(session)) {
                    delete this.sessions[sessionId];
                } else {
                    normalizeSession(session);
                }
            }

            this.isInitialized = true;
        } catch (error) {
            console.error('[EnhancementTracker] Failed to initialize:', error);
        }
    }

    /**
     * Start a new enhancement session
     * @param {string} itemHrid - Item HRID being enhanced
     * @param {number} startLevel - Starting enhancement level
     * @param {number} targetLevel - Target enhancement level
     * @param {number} protectFrom - Level to start using protection (0 = never)
     * @returns {Promise<string>} New session ID
     */
    async startSession(itemHrid, startLevel, targetLevel, protectFrom = 0) {
        const gameData = dataManager.getInitClientData();
        if (!gameData) {
            throw new Error('Game data not available');
        }

        // Get item name
        const itemDetails = gameData.itemDetailMap[itemHrid];
        if (!itemDetails) {
            throw new Error(`Item not found: ${itemHrid}`);
        }

        const itemName = itemDetails.name;

        // Create new session
        const session = createSession(itemHrid, itemName, startLevel, targetLevel, protectFrom);

        // Calculate predictions
        const predictions = calculateEnhancementPredictions(itemHrid, startLevel, targetLevel, protectFrom);
        session.predictions = predictions;

        // Store session
        this.sessions[session.id] = session;
        this.currentSessionId = session.id;

        // Save to storage
        await saveSessions(this.sessions);
        await saveCurrentSessionId(session.id);

        return session.id;
    }

    /**
     * Find a completed session that can be extended
     * @param {string} itemHrid - Item HRID
     * @param {number} currentLevel - Current enhancement level
     * @param {Object|null} [action] - Queue action now running, when known
     * @returns {string|null} Session ID if found, null otherwise
     */
    findExtendableSession(itemHrid, currentLevel, action = null) {
        for (const [sessionId, session] of Object.entries(this.sessions)) {
            if (canExtendSession(session, itemHrid, currentLevel, action)) {
                return sessionId;
            }
        }

        return null;
    }

    /**
     * Extend a completed session to a new target level
     * @param {string} sessionId - Session ID to extend
     * @param {number} newTargetLevel - New target level
     * @returns {Promise<boolean>} True if extended successfully
     */
    async extendSessionTarget(sessionId, newTargetLevel) {
        if (!this.sessions[sessionId]) {
            return false;
        }

        const session = this.sessions[sessionId];

        // Can only extend completed sessions
        if (session.state !== SessionState.COMPLETED) {
            return false;
        }

        extendSession(session, newTargetLevel);
        this.currentSessionId = sessionId;

        // Recalculate predictions for the new target level
        const predictions = calculateEnhancementPredictions(
            session.itemHrid,
            session.currentLevel,
            newTargetLevel,
            session.protectFrom
        );
        if (predictions) {
            session.predictions = predictions;
        }

        await saveSessions(this.sessions);
        await saveCurrentSessionId(sessionId);

        return true;
    }

    /**
     * The most recently active stored session, ended or not.
     * @returns {Object|null}
     */
    getMostRecentSession() {
        const activity = (s) =>
            Math.max(s?.endTime || 0, s?.lastAttempt?.timestamp || 0, s?.lastUpdateTime || 0, s?.startTime || 0);
        let latest = null;
        for (const session of Object.values(this.sessions)) {
            if (session && (!latest || activity(session) > activity(latest))) latest = session;
        }
        return latest;
    }

    /**
     * The session a new run should continue, when it is the most recent one and the run picks up
     * exactly where it ended (see {@link canResumeSession}). Only with the auto-resume setting on.
     * @param {Object} run - `{itemHrid, startLevel, targetLevel, protectFrom, protectionItemHrid}`
     * @returns {string|null} Session ID, or null
     */
    findResumableSession(run) {
        if (config.getSetting('enhancementTracker_autoResume') !== true) return null;
        const latest = this.getMostRecentSession();
        return latest && canResumeSession(latest, run) ? latest.id : null;
    }

    /**
     * Reopen an ended session as the current one, counting only active time from here on.
     * @param {string} sessionId - Session ID
     * @param {number|null} [startedAt] - When the new run's first attempt began, when known
     * @returns {Promise<boolean>} True when resumed
     */
    async resumeSessionById(sessionId, startedAt = null) {
        const session = this.sessions[sessionId];
        if (!session || session.state !== SessionState.COMPLETED) return false;
        // The resumed run is its own leg, predicted from the stats the player has now; when that
        // cannot be computed it has none rather than the old run's. A run that picks up at the
        // level its leg began at under unchanged stats stays that leg (see resumeSession).
        let predictions = null;
        try {
            predictions =
                calculateEnhancementPredictions(
                    session.itemHrid,
                    session.currentLevel,
                    session.targetLevel,
                    session.protectFrom
                ) || null;
        } catch (error) {
            console.error('[EnhancementTracker] Predicting the resumed leg failed:', error);
        }
        resumeSession(session, Date.now(), { newPredictions: predictions, startedAt });
        if (!session.predictions) session.predictions = predictions;
        this.currentSessionId = sessionId;
        await saveSessions(this.sessions);
        await saveCurrentSessionId(sessionId);
        return true;
    }

    /**
     * Whether the picked sessions can be merged, without changing anything.
     * @param {string[]} sessionIds - Picked session IDs
     * @returns {{ok: boolean, reason?: string, ordered?: Array<Object>, settingsDiffer?: boolean}}
     */
    planMerge(sessionIds) {
        if (!sessionsLoaded()) {
            return { ok: false, reason: 'The stored sessions have not finished loading; try again in a moment.' };
        }
        // Named in a refusal as the panel numbers them: #N in the session list
        const ids = Object.keys(this.sessions);
        const labelOf = (session) => '#' + (ids.indexOf(session.id) + 1);
        return planSessionMerge(
            (sessionIds || []).map((id) => this.sessions[id]),
            { labelOf }
        );
    }

    /**
     * Merge the picked sessions into one persisted session; the originals are removed.
     *
     * The most recently active session absorbs the others (see {@link foldSessions}), so when it
     * is the run in progress it stays the current session and keeps receiving attempts. Only runs
     * that continue each other can merge (planSessionMerge).
     *
     * No combined prediction is made: one computed now would use today's stats for attempts made
     * on the stats the player had then. The merged session shows none and is not calibrated; each
     * run's own prediction stays in `legPredictions`.
     * @param {string[]} sessionIds - Picked session IDs
     * @returns {Promise<{ok: boolean, reason?: string, id?: string}>}
     */
    async mergeSessionsIntoOne(sessionIds) {
        const plan = this.planMerge(sessionIds);
        if (!plan.ok) return { ok: false, reason: plan.reason };

        const { ordered } = plan;
        const merged = foldSessions(ordered);
        for (const session of ordered.slice(0, -1)) delete this.sessions[session.id];

        // The pointer only ever names a running session; a removed one cannot be current
        if (this.currentSessionId && !this.sessions[this.currentSessionId]) {
            this.currentSessionId = merged.state === SessionState.TRACKING ? merged.id : null;
            await saveCurrentSessionId(this.currentSessionId);
        }
        await saveSessions(this.sessions);
        return { ok: true, id: merged.id };
    }

    /**
     * Get current active session
     * @returns {Object|null} Current session or null
     */
    getCurrentSession() {
        if (!this.currentSessionId) return null;
        return this.sessions[this.currentSessionId] || null;
    }

    /** Whether an asynchronous continuation still belongs to this session list. */
    _ownsSessions(sessions, owner) {
        return this.sessions === sessions && dataManager.getCurrentCharacterId() === owner;
    }

    /**
     * Finalize current session (mark as completed)
     * @param {number} [endTime] - When the run ended, when that was not now (a run that ended
     *   while no page was connected ended at some point after its last recorded attempt)
     * @returns {Promise<void>}
     */
    async finalizeCurrentSession(endTime) {
        const session = this.getCurrentSession();
        if (!session) {
            return;
        }

        const sessions = this.sessions;
        const owner = dataManager.getCurrentCharacterId();
        finalizeSession(session, endTime);
        await saveSessions(sessions);

        // A new session (or an extension of this one) may have started while
        // saving. Only clear the finished session that this call captured.
        if (
            this._ownsSessions(sessions, owner) &&
            this.getCurrentSession() === session &&
            session.state === SessionState.COMPLETED
        ) {
            this.currentSessionId = null;
            await saveCurrentSessionId(null);
        }
    }

    /**
     * Record a successful enhancement attempt
     * @param {number} previousLevel - Level before success
     * @param {number} newLevel - New level after success
     * @param {boolean} wasBlessed - Whether this success jumped +2 or more levels (Blessed Tea)
     * @returns {Promise<void>}
     */
    async recordSuccess(previousLevel, newLevel, wasBlessed = false) {
        const session = this.getCurrentSession();
        if (!session) {
            return;
        }

        const sessions = this.sessions;
        const owner = dataManager.getCurrentCharacterId();
        recordSuccess(session, previousLevel, newLevel, wasBlessed);
        // An extension mutates this same object and its prediction. Preserve
        // the completed leg before yielding so calibration sees that draw.
        const completed = session.state === SessionState.COMPLETED ? structuredClone(session) : null;
        await saveSessions(sessions);

        // Check if target reached
        if (completed && this._ownsSessions(sessions, owner)) {
            if (this.getCurrentSession() === session && session.state === SessionState.COMPLETED) {
                this.currentSessionId = null;
                await saveCurrentSessionId(null);
            }
            if (!this._ownsSessions(sessions, owner)) return;
            // A merged session that reaches a target one of its folded-in runs already reached (and
            // was recorded for) is measured on its own leg alone, or not at all (calibrationObservation)
            const observation = calibrationObservation(completed);
            if (!observation) return;

            // The run just became one finished draw from the distribution its
            // prediction quoted; the recorder declines anything that is not
            // (no distribution stored, target not actually reached). Errors
            // stay its problem — a calibration ledger must never break a run.
            try {
                await enhancementCalibration.recordCompletion(observation);
            } catch (error) {
                console.error('[EnhancementTracker] Recording the calibration observation failed:', error);
            }
        }
    }

    /**
     * Record a failed enhancement attempt
     * @param {number} previousLevel - Level that failed
     * @param {number} newLevel - Actual level after failure
     * @returns {Promise<void>}
     */
    async recordFailure(previousLevel, newLevel) {
        const session = this.getCurrentSession();
        if (!session) {
            return;
        }

        recordFailure(session, previousLevel, newLevel);
        await saveSessions(this.sessions);
    }

    /**
     * Track material costs for current session
     * @param {string} itemHrid - Material item HRID
     * @param {number} count - Quantity used
     * @param {number} [unitCost] - Price per unit, for a cost the material price rules do not
     *   cover (a Philosopher's Mirror attempt's enhanced base-item copy)
     * @returns {Promise<void>}
     */
    async trackMaterialCost(itemHrid, count, unitCost) {
        const session = this.getCurrentSession();
        if (!session) return;

        // Same pricing rules the tooltip and XPH calculator use, so a tracked run and its
        // prediction cost the same materials the same way
        const price = Number.isFinite(unitCost) ? unitCost : getEnhancementMaterialPrice(itemHrid, 'ask');

        addMaterialCost(session, itemHrid, count, price);
        await saveSessions(this.sessions);
    }

    /**
     * Track coin cost for current session
     * @param {number} amount - Coin amount spent
     * @returns {Promise<void>}
     */
    async trackCoinCost(amount) {
        const session = this.getCurrentSession();
        if (!session) return;

        addCoinCost(session, amount);
        await saveSessions(this.sessions);
    }

    /**
     * Track protection item cost for current session
     * @param {string} protectionItemHrid - Protection item HRID
     * @param {number} cost - Protection item cost
     * @returns {Promise<void>}
     */
    async trackProtectionCost(protectionItemHrid, cost) {
        const session = this.getCurrentSession();
        if (!session) return;

        addProtectionCost(session, protectionItemHrid, cost);
        await saveSessions(this.sessions);
    }

    /**
     * Get all sessions
     * @returns {Object} All sessions
     */
    getAllSessions() {
        return this.sessions;
    }

    /**
     * Get session by ID
     * @param {string} sessionId - Session ID
     * @returns {Object|null} Session or null
     */
    getSession(sessionId) {
        return this.sessions[sessionId] || null;
    }

    /**
     * Save sessions to storage (can be called directly)
     * @returns {Promise<void>}
     */
    async saveSessions() {
        await saveSessions(this.sessions);
    }

    /**
     * Set flag so the next action_completed starts a new session regardless of currentCount.
     * Used when the tracker is cleared mid-session or when a new action queue is detected.
     */
    setPendingStart() {
        this.pendingSessionStart = true;
    }

    /**
     * Clear all sessions and flag that the next attempt should start a new session.
     * @returns {Promise<void>}
     */
    async clearSessions() {
        this.sessions = {};
        this.currentSessionId = null;
        this.pendingSessionStart = true;
        await saveSessions(this.sessions);
        await saveCurrentSessionId(null);
    }

    /**
     * Disable and cleanup
     */
    disable() {
        // Clear in-memory session data (will be reloaded from storage on next init)
        this.sessions = {};
        this.currentSessionId = null;
        this.isInitialized = false;

        // A character switch can land while actions_updated has flagged a pending
        // start but the action_completed that would consume it hasn't arrived yet
        // (the queue was mid-attempt when the user switched away). Left set, that
        // flag survives into the next character: its first "no active session"
        // attempt then takes the shouldStartNew path — which always creates a
        // fresh session — instead of the normal !currentSession path, which tries
        // findExtendableSession() first. A character resuming a COMPLETED session
        // at a matching level would get a brand-new fragment instead of its
        // existing session extended, losing the extension baseline the leg
        // counters and predictions depend on.
        this.pendingSessionStart = false;
    }
}

const enhancementTracker = new EnhancementTracker();

export default enhancementTracker;
