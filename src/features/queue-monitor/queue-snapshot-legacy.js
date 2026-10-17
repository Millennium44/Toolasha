/**
 * Reading snapshots saved by older builds. Kept apart from queue-snapshot.js so the account panel can use it
 * without pulling in the action calculator.
 */

import dataManager from '../../core/data-manager.js';

/**
 * Whether a row is a counted fight, by the rule the writer uses to leave it untimed.
 * @param {Object} row - Snapshot row
 * @returns {boolean}
 */
function isCountedFightRow(row) {
    if (!row || row.isInfinite) return false;
    let details = null;
    try {
        details = dataManager.getActionDetails?.(row.actionHrid) ?? null;
    } catch {
        details = null;
    }
    return details?.type === '/action_types/combat' || String(row.actionHrid || '').includes('/combat/');
}

/**
 * Bring a snapshot saved before `hasUnknownAction` existed in line with what the writer produces now.
 * Such a snapshot timed a counted fight as battles x action time; that estimate is dropped from the row and,
 * when the row comes before the first endless one, from the total, and the snapshot is marked as having an
 * unknown tail. Returns a new object only when something had to change.
 * @param {Object} snapshot - As loaded from storage
 * @returns {Object} The snapshot, normalized
 */
export function normalizeLegacySnapshot(snapshot) {
    if (!snapshot || snapshot.hasUnknownAction !== undefined || !Array.isArray(snapshot.actions)) return snapshot;
    let total = Math.max(0, Number(snapshot.totalQueueSeconds) || 0);
    let seenInfinite = false;
    let hasUnknownAction = false;
    const actions = snapshot.actions.map((row) => {
        if (!row) return row;
        if (row.isInfinite) {
            seenInfinite = true;
            return row;
        }
        const timed = typeof row.estimatedSeconds === 'number' && Number.isFinite(row.estimatedSeconds);
        if (timed && isCountedFightRow(row)) {
            if (!seenInfinite) {
                total = Math.max(0, total - row.estimatedSeconds);
                hasUnknownAction = true;
            }
            return { ...row, estimatedSeconds: null };
        }
        if (!timed && !seenInfinite) hasUnknownAction = true;
        return row;
    });
    return { ...snapshot, actions, totalQueueSeconds: total, hasUnknownAction };
}
