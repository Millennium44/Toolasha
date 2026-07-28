/**
 * Loot Log History Storage
 * Persists loot log entries to IndexedDB for extended history
 */

import storage from '../../core/storage.js';
import dataManager from '../../core/data-manager.js';

const STORE_NAME = 'lootLogHistory';
const MAX_ENTRIES = 500;

class LootLogHistory {
    _getKey() {
        const charId = dataManager.getCurrentCharacterId();
        return charId ? `lootLog_${charId}` : null;
    }

    /**
     * @returns {Promise<Array>}
     */
    async _load() {
        const key = this._getKey();
        if (!key) return [];
        return await storage.get(key, STORE_NAME, []);
    }

    /**
     * @param {Array} entries
     */
    async _save(entries) {
        const key = this._getKey();
        if (!key) return;
        await storage.set(key, entries, STORE_NAME, true);
    }

    /**
     * Merge entries from a loot_log_updated message into stored history.
     * Deduplicates by characterActionId (incoming entries replace stored copies, so ongoing
     * sessions stay fresh), keeps newest first, caps at MAX_ENTRIES.
     * @param {Array} lootLog - Array from the WebSocket message
     */
    async mergeAndSave(lootLog) {
        if (!lootLog || lootLog.length === 0) return;

        const existing = await this._load();
        const byId = new Map(existing.map((e) => [e.characterActionId, e]));

        let changed = false;
        for (const entry of lootLog) {
            const stored = byId.get(entry.characterActionId);
            if (!stored || stored.endTime !== entry.endTime || stored.actionCount !== entry.actionCount) {
                byId.set(entry.characterActionId, entry);
                changed = true;
            }
        }
        if (!changed) return;

        const merged = [...byId.values()];
        merged.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));

        await this._save(merged.slice(0, MAX_ENTRIES));
    }

    /**
     * Get entries that are in storage but not in the current game-provided set.
     * @param {Set<number>} currentIds - characterActionIds from the current loot_log_updated
     * @returns {Promise<Array>}
     */
    async getHistoricalEntries(currentIds) {
        const all = await this._load();
        return all.filter((e) => !currentIds.has(e.characterActionId));
    }

    async clearHistory() {
        const key = this._getKey();
        if (!key) return;
        await storage.delete(key, STORE_NAME);
    }
}

const lootLogHistory = new LootLogHistory();
export default lootLogHistory;
