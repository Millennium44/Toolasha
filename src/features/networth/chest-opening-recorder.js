/**
 * Chest openings, recorded per day.
 *
 * ## Why the treasure tracker's ledger cannot answer this
 *
 * `utils/chest-tally.js` already folds every `loot_opened` message into a
 * ledger, and the treasure tracker already persists it — but that ledger is a
 * LIFETIME aggregate per chest with no timestamps in it at all. It can say that
 * four hundred purple chests have paid out a hundred and twelve rares; it
 * cannot say that eleven of them were opened last Tuesday. The gold attribution
 * is a per-day table, so a lifetime total is not a thing it can spend.
 *
 * So this records the same messages a second time, day by day. The duplication
 * is deliberate: adding timestamps to the tally would change a store that a
 * whole panel already reads and syncs, for a consumer that needs a different
 * shape anyway.
 *
 * ## What a day's openings are worth
 *
 * The fork prices an unopened chest at its *expected* value — that is what
 * `expected-value-calculator.js` is for, and it is what the chest contributes
 * to net worth while it sits in the inventory. So opening one is, in net worth
 * terms, an exchange of one expectation for one realisation, and the difference
 * between them is the only thing that moved:
 *
 *     what came out (at market) − how many were opened × the chest's own price
 *
 * That figure is realised luck against expectation, plus whatever the two
 * valuations drift by. It is small when the chests pay what they owe and large
 * when they do not, and either way it is a slice of the residual that opening
 * chests creates and nothing else was recording.
 *
 * ## Recorded even when the tracker's UI is off
 *
 * The listener is this module's own rather than a hook into
 * `treasure-tracker.js`, because that feature returns early from `initialize`
 * when its setting is off and would then record nothing. A history that only
 * exists when a panel happens to be enabled is a history the attribution cannot
 * rely on. Recording is gated on the gold sources setting, which is the feature
 * this data is for.
 *
 * ## Storage
 *
 * One record per calendar month in the `networthHistory` store, exactly as
 * `production-income-recorder.js` does it and for the same reasons.
 */

import storage from '../../core/storage.js';
import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import { createChunkedHistory, timeChunkId } from '../../utils/chunked-history.js';
import { localDayId, dayStart } from './gold-sources.js';

const STORE_NAME = 'networthHistory';
const RECORD_PREFIX = 'chestOpenRec';

/** Beyond this, a day's row is dropped — the panel's longest window is 30 days */
const RETENTION_DAYS = 400;

/**
 * Which chunk a day row belongs to.
 * @param {Object} row - A day row
 * @returns {string} Chunk id
 */
const rowChunkId = (row) => timeChunkId(dayStart(row?.d), 'month');

/**
 * A day's chest openings.
 *
 * @typedef {Object} ChestOpeningDay
 * @property {string} d - Local day id, `YYYY-MM-DD`
 * @property {Object<string, {count: number, gained: Object<string, number>}>} openings -
 *   Keyed by chest hrid: how many were opened, and everything that came out
 */

/**
 * Fold one opening into a day's row, in place.
 *
 * Separate from the class and pure in everything but the row it is handed, so
 * the arithmetic that decides what a day of chest opening looked like can be
 * tested without a socket behind it.
 *
 * @param {ChestOpeningDay} row - The day's row, mutated
 * @param {string} chestHrid - What was opened
 * @param {number} count - How many
 * @param {Array<{itemHrid: string, count: number}>} gainedItems - What came out
 * @returns {ChestOpeningDay} The same row
 */
export function foldOpening(row, chestHrid, count, gainedItems) {
    if (!row) return row;
    if (!chestHrid || !(count > 0)) return row;

    if (!row.openings) row.openings = {};
    const entry = row.openings[chestHrid] || { count: 0, gained: {} };
    entry.count += count;

    for (const item of gainedItems || []) {
        if (!item?.itemHrid) continue;
        const gained = Number(item.count) || 0;
        if (gained === 0) continue;
        entry.gained[item.itemHrid] = (entry.gained[item.itemHrid] || 0) + gained;
    }

    row.openings[chestHrid] = entry;
    return row;
}

class ChestOpeningRecorder {
    constructor() {
        this._store = createChunkedHistory({
            storeName: STORE_NAME,
            prefix: RECORD_PREFIX,
            // Never written by any build — this recorder was chunked from its
            // first line — but the store reads and deletes it on every load, so
            // it has to be a key of this recorder's own and not a shared one
            legacyKey: (charId) => `chestOpenings_${charId}`,
            groupOf: rowChunkId,
            compare: (a, b) => String(a?.d || '').localeCompare(String(b?.d || '')),
            label: 'ChestOpenings',
        });

        /** The rows as they stand, which is the truth between debounced writes */
        this._rows = [];
        /** Months whose rows moved since the last save */
        this._touchedChunks = new Set();
        /** Whose rows those are */
        this._charId = null;
        /** The read in flight, so concurrent recordings wait on one of them */
        this._loading = null;
        /** Bumped on every character change; rows read under an old one are not ours */
        this._generation = 0;
        this._handlers = null;
        this.isActive = false;
    }

    /** @returns {string|null} Whose record, or null before login */
    _currentCharId() {
        return dataManager.getCurrentCharacterId?.() || null;
    }

    /**
     * Start recording.
     * @returns {Promise<void>}
     */
    async initialize() {
        if (this.isActive) return;

        this._handlers = {
            lootOpened: (data) => this._onLootOpened(data),
            characterSwitching: () => this._forget(),
        };

        webSocketHook.on('loot_opened', this._handlers.lootOpened);
        dataManager.on?.('character_switching', this._handlers.characterSwitching);

        this.isActive = true;
        await this.load();
    }

    /** Stop recording and drop the listeners. */
    cleanup() {
        if (!this._handlers) return;
        webSocketHook.off('loot_opened', this._handlers.lootOpened);
        dataManager.off?.('character_switching', this._handlers.characterSwitching);
        this._handlers = null;
        this.isActive = false;
    }

    /** Forget the departing character's rows, so they are never written under the arriving one's key. */
    _forget() {
        this._generation += 1;
        this._rows = [];
        this._touchedChunks.clear();
        this._charId = null;
        this._loading = null;
        this._store.forget();
    }

    /**
     * Every recorded day, oldest first.
     *
     * A save hands the chunked store the whole list as the truth, so every write
     * goes through this first and concurrent callers share the one read.
     *
     * @returns {Promise<Array<ChestOpeningDay>>} The rows
     */
    async load() {
        const charId = this._currentCharId();
        if (!charId) return [];
        if (this._charId === charId && !this._loading) return [...this._rows];

        const generation = this._generation;

        if (!this._loading) {
            this._charId = charId;
            this._loading = (async () => {
                const rows = await this._store.load(charId);
                if (this._generation !== generation) return;
                this._rows = rows;
            })();
        }

        try {
            await this._loading;
        } finally {
            if (this._generation === generation) this._loading = null;
        }
        return this._generation === generation ? [...this._rows] : [];
    }

    /**
     * The row for a day, created if the day is new.
     * @param {string} day - Local day id
     * @returns {ChestOpeningDay} The live row
     */
    _rowFor(day) {
        let row = this._rows.find((entry) => entry.d === day);
        if (!row) {
            row = { d: day, openings: {} };
            this._rows.push(row);
        }
        this._touchedChunks.add(rowChunkId(row));
        return row;
    }

    /**
     * Drop rows past retention and queue the write.
     *
     * Not awaited: the write is debounced, and `flushAll()` on unload lands the
     * last one.
     */
    _save() {
        if (!this._charId) return;

        const floor = localDayId(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
        const kept = this._rows.filter((row) => row.d >= floor);
        if (kept.length !== this._rows.length) this._rows = kept;

        const changedChunks = this._touchedChunks;
        this._touchedChunks = new Set();
        this._store.save(this._charId, this._rows, { changedChunks });
    }

    /**
     * Record one `loot_opened` message.
     * @param {Object} data - The message
     * @returns {Promise<void>}
     */
    async _onLootOpened(data) {
        try {
            if (!config.getSetting('networth_goldSources')) return;
            if (storage.isQuotaExceeded?.()) return;

            const chestHrid = data?.openedItem?.itemHrid;
            if (!chestHrid) return;
            const count = Number(data.openedItem.count) || 1;
            if (!(count > 0)) return;
            if (!this._currentCharId()) return;

            const generation = this._generation;
            await this.load();
            // The character switched while the rows were being read; this
            // opening belongs to whoever left
            if (this._generation !== generation) return;

            foldOpening(this._rowFor(localDayId(Date.now())), chestHrid, count, data.gainedItems);
            this._save();
        } catch (error) {
            console.error('[ChestOpenings] Recording an opening failed:', error);
        }
    }
}

const chestOpeningRecorder = new ChestOpeningRecorder();
export default chestOpeningRecorder;
