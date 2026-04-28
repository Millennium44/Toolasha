/**
 * Queue Snapshot
 * Captures queue state on character switch for cross-character monitoring.
 * Pre-computes per-action times while the departing character's data is still live.
 */

import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import { calculateActionStats } from '../../utils/action-calculator.js';

const STORE_NAME = 'queueSnapshots';

class QueueSnapshot {
    constructor() {
        this.snapshots = new Map(); // characterId -> snapshot
        this._boundOnSwitching = null;
    }

    /**
     * Initialize snapshot listener.
     * The character_switching listener is registered once and never removed,
     * because feature-registry disables all features during character_switching
     * which would remove the listener before it can fire.
     */
    initialize() {
        if (!this._boundOnSwitching) {
            this._boundOnSwitching = this._onCharacterSwitching.bind(this);
            dataManager.on('character_switching', this._boundOnSwitching);
        }

        // Load existing snapshots from storage
        this._loadSnapshots();
    }

    /**
     * Disable — UI cleanup only. The switching listener persists intentionally.
     */
    disable() {
        // Intentionally keep the character_switching listener alive.
        // It must fire during the switch to capture the departing character's queue.
    }

    /**
     * Handle character_switching event — snapshot departing character's queue
     * At this point, departing character's data is still live in dataManager
     * @param {Object} event - { oldId, newId, oldName, newName }
     */
    _onCharacterSwitching(event) {
        try {
            const { oldId, oldName } = event;
            if (!oldId) return;

            const actions = dataManager.getCurrentActions();
            const skills = dataManager.getSkills();
            const equipment = dataManager.getEquipment();
            const initData = dataManager.getInitClientData();
            const itemDetailMap = initData?.itemDetailMap;

            if (!actions || !skills || !itemDetailMap) {
                return;
            }

            const snapshotActions = [];
            let totalQueueSeconds = 0;
            let hasInfiniteAction = false;

            for (const action of actions) {
                if (action.isDone) continue;

                const actionDetails = dataManager.getActionDetails(action.actionHrid);
                if (!actionDetails) continue;

                const actionName = actionDetails.name || action.actionHrid;
                const isInfinite = !action.hasMaxCount;

                let estimatedSeconds = null;

                if (!isInfinite) {
                    // Finite action — compute remaining time
                    const stats = calculateActionStats(actionDetails, {
                        skills,
                        equipment,
                        itemDetailMap,
                        actionHrid: action.actionHrid,
                        includeCommunityBuff: true,
                    });

                    if (stats) {
                        const remainingCount = Math.max(0, action.maxCount - action.currentCount);
                        // Each action produces ceil(1 + efficiency/100) items on average
                        // Time = remaining / effectiveRate * actionTime
                        const effectiveRate = 1 + stats.totalEfficiency / 100;
                        estimatedSeconds = Math.ceil(remainingCount / effectiveRate) * stats.actionTime;
                        totalQueueSeconds += estimatedSeconds;
                    }
                } else {
                    hasInfiniteAction = true;
                }

                snapshotActions.push({
                    actionHrid: action.actionHrid,
                    actionName,
                    maxCount: action.maxCount || null,
                    currentCount: action.currentCount || 0,
                    hasMaxCount: action.hasMaxCount,
                    estimatedSeconds,
                    isInfinite,
                });
            }

            const snapshot = {
                characterId: oldId,
                characterName: oldName,
                timestamp: Date.now(),
                actions: snapshotActions,
                totalQueueSeconds,
                hasInfiniteAction,
            };

            this.snapshots.set(oldId, snapshot);

            // Persist to IndexedDB
            storage.set(`queueSnapshot_${oldId}`, snapshot, STORE_NAME);
        } catch (error) {
            console.error('[QueueSnapshot] Failed to create snapshot:', error);
        }
    }

    /**
     * Load all snapshots from IndexedDB
     */
    async _loadSnapshots() {
        try {
            const keys = await storage.getAllKeys(STORE_NAME);
            for (const key of keys) {
                const snapshot = await storage.get(key, STORE_NAME);
                if (snapshot?.characterId) {
                    this.snapshots.set(snapshot.characterId, snapshot);
                }
            }
        } catch (error) {
            console.error('[QueueSnapshot] Failed to load snapshots:', error);
        }
    }

    /**
     * Get all snapshots for characters other than the current one
     * @returns {Array<Object>} Array of snapshot objects
     */
    getOtherCharacterSnapshots() {
        const currentId = dataManager.getCurrentCharacterId();
        const results = [];
        for (const [id, snapshot] of this.snapshots) {
            if (id !== currentId) {
                results.push(snapshot);
            }
        }
        return results;
    }

    /**
     * Get a specific character's snapshot
     * @param {string} characterId
     * @returns {Object|null}
     */
    getSnapshot(characterId) {
        return this.snapshots.get(characterId) || null;
    }

    /**
     * Delete a snapshot
     * @param {string} characterId
     */
    async deleteSnapshot(characterId) {
        this.snapshots.delete(characterId);
        await storage.delete(`queueSnapshot_${characterId}`, STORE_NAME);
    }
}

const queueSnapshot = new QueueSnapshot();
export default queueSnapshot;
