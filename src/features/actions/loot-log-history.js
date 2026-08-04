/**
 * Loot Log History Storage
 * Persists loot log entries to IndexedDB for extended history
 */

import storage from '../../core/storage.js';
import dataManager from '../../core/data-manager.js';

const STORE_NAME = 'lootLogHistory';
const MAX_ENTRIES = 500;

class LootLogHistory {
    constructor() {
        /**
         * The entries as last merged, for the key they belong to.
         *
         * Debouncing the write means storage is behind memory for up to three
         * seconds, and `loot_log_updated` arrives far more often than that — so
         * a `_load()` that read through to storage would merge onto a stale
         * array and undo the merge before it. Memory is the truth between
         * flushes; storage is where it goes to survive a reload.
         */
        this._cacheKey = null;
        this._cache = null;
    }

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
        if (this._cacheKey === key && this._cache) return this._cache;

        const stored = await storage.get(key, STORE_NAME, []);
        this._cacheKey = key;
        this._cache = stored;
        return stored;
    }

    /**
     * Queue the entries for writing.
     *
     * Deliberately not awaited and not `immediate`: this used to rewrite the
     * whole 500-entry array on every loot message, which for a fast action is
     * several full-array writes a second for a list that changes by one entry.
     * The debounce coalesces those into one write per quiet moment, and the
     * `beforeunload` `flushAll()` in the entrypoint is what makes the last one
     * land. Awaiting here would block the caller on the debounce timer itself.
     * @param {Array} entries
     */
    _save(entries) {
        const key = this._getKey();
        if (!key) return;
        this._cacheKey = key;
        this._cache = entries;
        storage.set(key, entries, STORE_NAME);
    }

    /**
     * Merge entries from a loot_log_updated message into stored history.
     * Deduplicates by characterActionId (incoming entries replace stored copies, so ongoing
     * sessions stay fresh), keeps newest first, caps at MAX_ENTRIES.
     * @param {Array} lootLog - Array from the WebSocket message
     */
    async mergeAndSave(lootLog) {
        if (!lootLog || lootLog.length === 0) return;
        // Nothing that follows can be stored, and building it costs a full
        // merge over 500 entries per loot message
        if (storage.isQuotaExceeded()) return;

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

        this._save(merged.slice(0, MAX_ENTRIES));
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
        this._cacheKey = null;
        this._cache = null;
        await storage.delete(key, STORE_NAME);
    }
}

const lootLogHistory = new LootLogHistory();
export default lootLogHistory;
