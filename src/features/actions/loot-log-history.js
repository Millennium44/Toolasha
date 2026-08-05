/**
 * Loot Log History Storage
 * Persists loot log entries to IndexedDB for extended history
 */

import storage from '../../core/storage.js';
import dataManager from '../../core/data-manager.js';
import { createChunkedHistory, timeChunkId } from '../../utils/chunked-history.js';

const STORE_NAME = 'lootLogHistory';
const MAX_ENTRIES = 500;

/**
 * One record per hour of play.
 *
 * `loot_log_updated` arrives every few seconds while a fast action runs, and
 * each one used to rewrite all five hundred entries. Hourly buckets hold the
 * dozen or so entries recorded since the hour began, so the write is that dozen
 * — and the four hundred and ninety entries from previous hours, which have not
 * changed and cannot change, are never touched again.
 *
 * An hour rather than a day because a day of hard play is most of the window,
 * which would leave the amplification roughly where it started.
 */
const RECORD_PREFIX = 'lootLogRec';

class LootLogHistory {
    constructor() {
        /**
         * Where the entries live, and the memory of what was last written.
         *
         * Debouncing the write means storage is behind memory for up to three
         * seconds, and `loot_log_updated` arrives far more often than that — so
         * a read that went through to storage would merge onto a stale array and
         * undo the merge before it. Memory is the truth between flushes; storage
         * is where it goes to survive a reload.
         */
        this._store = createChunkedHistory({
            storeName: STORE_NAME,
            prefix: RECORD_PREFIX,
            legacyKey: (charId) => `lootLog_${charId}`,
            groupOf: (entry) => timeChunkId(Date.parse(entry?.startTime), 'hour'),
            // Newest first, which is the order the loot panel reads them in
            compare: (a, b) => Date.parse(b?.startTime) - Date.parse(a?.startTime) || 0,
            label: 'LootLogHistory',
        });
    }

    /** @returns {string|null} Whose loot log, or null before login */
    _charId() {
        return dataManager.getCurrentCharacterId() || null;
    }

    /**
     * @returns {Promise<Array>} Every stored entry, newest first
     */
    async _load() {
        const charId = this._charId();
        if (!charId) return [];
        return this._store.load(charId);
    }

    /**
     * Queue the entries for writing.
     *
     * Deliberately not awaited and not `immediate`: the debounce coalesces a
     * burst of loot messages into one write per quiet moment, and the
     * `beforeunload` `flushAll()` in the entrypoint is what makes the last one
     * land. Awaiting here would block the caller on the debounce timer itself.
     * @param {Array} entries - The history as it now stands, newest first
     */
    _save(entries) {
        const charId = this._charId();
        if (!charId) return;
        this._store.save(charId, entries);
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

        // Entries past the cap fall out of the array here; the chunks they were
        // the last of are deleted by the save that notices they have gone
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
        const charId = this._charId();
        if (!charId) return;
        await this._store.clear(charId);
    }
}

const lootLogHistory = new LootLogHistory();
export default lootLogHistory;

// A character switch must not serve the departing character's entries to the
// arriving one, nor write them back under the arriving one's keys
dataManager.on?.('character_switching', () => lootLogHistory._store.forget());
