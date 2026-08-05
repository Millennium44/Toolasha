/**
 * Enhancement Tracker Storage
 * Handles persistence of enhancement sessions using IndexedDB
 *
 * Sessions belong to the character that ran them: the iron cow's overnight
 * enhancing run has nothing to do with the market cow's, and a shared key put
 * both in the same list. Keys are therefore scoped per character and derived at
 * every read and write — the user switches characters without reloading the
 * page, so a key resolved once at module load would be the wrong one afterwards.
 * The legacy global value is adopted by the main character exactly once.
 */

import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import { characterKey, readScoped, writeScoped } from '../../utils/character-key.js';

const STORAGE_KEY = 'enhancementTracker_sessions';
const CURRENT_SESSION_KEY = 'enhancementTracker_currentSession';
const STORAGE_STORE = 'settings'; // Use existing 'settings' store

/**
 * What has been handed to the debounced writer but may not have landed yet.
 *
 * Every session update used to write all sessions as one immediate blob into
 * the settings store — an enhancement run is a write per attempt, of a document
 * containing every session ever kept. Debouncing coalesces a run into one write,
 * at the cost of storage lagging memory; these hold the truth in the meantime so
 * a load during the lag cannot read back a stale blob.
 */
let pendingSessions = null;
let pendingCurrentSessionId;
let hasPendingCurrentSessionId = false;

/**
 * Save all sessions to storage.
 *
 * Queued rather than awaited: the debounced write's promise resolves when its
 * timer fires, so awaiting it would stall every caller for the debounce delay.
 * `storage.flushAll()` on `beforeunload` is what makes the last one land.
 * @param {Object} sessions - Sessions object (keyed by session ID)
 * @returns {Promise<void>}
 */
export async function saveSessions(sessions) {
    pendingSessions = sessions;
    writeScoped(STORAGE_KEY, sessions, STORAGE_STORE);
}

/**
 * Load all sessions from storage
 * @returns {Promise<Object>} Sessions object (keyed by session ID)
 */
export async function loadSessions() {
    if (pendingSessions !== null) return pendingSessions;
    try {
        return await readScoped(STORAGE_KEY, STORAGE_STORE, {}, { migrate: 'adopt' });
    } catch (error) {
        console.error('[EnhancementStorage] Failed to load sessions:', error);
        return {};
    }
}

/**
 * Save current session ID
 * @param {string|null} sessionId - Current session ID (null if no active session)
 * @returns {Promise<void>}
 */
export async function saveCurrentSessionId(sessionId) {
    pendingCurrentSessionId = sessionId;
    hasPendingCurrentSessionId = true;
    writeScoped(CURRENT_SESSION_KEY, sessionId, STORAGE_STORE);
}

/**
 * Load current session ID
 * @returns {Promise<string|null>} Current session ID or null
 */
export async function loadCurrentSessionId() {
    if (hasPendingCurrentSessionId) return pendingCurrentSessionId;
    try {
        return await readScoped(CURRENT_SESSION_KEY, STORAGE_STORE, null, { migrate: 'adopt' });
    } catch (error) {
        console.error('[EnhancementStorage] Failed to load current session ID:', error);
        return null;
    }
}

/**
 * Delete a session
 * @param {Object} sessions - Sessions object
 * @param {string} sessionId - Session ID to delete
 * @returns {Promise<void>}
 */
export async function deleteSession(sessions, sessionId) {
    if (sessions[sessionId]) {
        delete sessions[sessionId];
        await saveSessions(sessions);
    }
}

/**
 * Archive old completed sessions (keep only recent N sessions)
 * @param {Object} sessions - Sessions object
 * @param {number} maxSessions - Maximum sessions to keep (default: 50)
 * @returns {Promise<void>}
 */
export async function archiveOldSessions(sessions, maxSessions = 50) {
    const sessionArray = Object.entries(sessions);

    // Skip if under limit
    if (sessionArray.length <= maxSessions) {
        return;
    }

    // Sort by start time (oldest first)
    sessionArray.sort(([, a], [, b]) => a.startTime - b.startTime);

    // Keep only the newest sessions
    const sessionsToKeep = sessionArray.slice(-maxSessions);
    const newSessions = Object.fromEntries(sessionsToKeep);

    await saveSessions(newSessions);
}

/**
 * Export session data as JSON string
 * @param {Object} session - Session object
 * @returns {string} JSON string
 */
export function exportSession(session) {
    return JSON.stringify(session, null, 2);
}

/**
 * Import session data from JSON string
 * @param {string} jsonStr - JSON string
 * @returns {Object|null} Session object or null if invalid
 */
export function importSession(jsonStr) {
    try {
        const session = JSON.parse(jsonStr);

        // Basic validation
        if (!session.id || !session.itemHrid) {
            return null;
        }

        return session;
    } catch {
        return null;
    }
}

/**
 * Clear all sessions (for testing/reset)
 * @returns {Promise<void>}
 */
export async function clearAllSessions() {
    try {
        pendingSessions = {};
        pendingCurrentSessionId = null;
        hasPendingCurrentSessionId = true;
        // Immediate: a clear is a one-off the user asked for and waited on, and
        // awaiting the debounced path would mean waiting out its timer
        await storage.set(characterKey(STORAGE_KEY), {}, STORAGE_STORE, true);
        await storage.set(characterKey(CURRENT_SESSION_KEY), null, STORAGE_STORE, true);
    } catch (error) {
        console.error('[EnhancementStorage] Failed to clear sessions:', error);
    }
}

/**
 * Drop the in-memory mirror of the queued writes — for tests, and for anything
 * that needs the next load to come from storage.
 */
export function resetPendingSessionCache() {
    pendingSessions = null;
    pendingCurrentSessionId = undefined;
    hasPendingCurrentSessionId = false;
}

// The mirror holds one character's sessions. Switching characters without a
// reload would otherwise serve the departing character's list to the arriving
// one — and, worse, write it back under the arriving character's key.
dataManager.on('character_switching', () => resetPendingSessionCache());
