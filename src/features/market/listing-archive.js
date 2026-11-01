/**
 * The listing archive — where your own market listings go when the 90-day log
 * lets go of them.
 *
 * The personal log (`estimated-listing-age.js`) keeps the last 90 days of your
 * listings, because it is read on every order book, rewritten on every listing
 * event and is the calibration for the age column. It used to simply drop
 * everything older. That was right for the age column and wrong for the Market
 * History table, whose whole point is the past: three thousand listings
 * imported from an older install were discarded by the next retention pass.
 *
 * Retention now *moves* rows here instead of dropping them, and an import of
 * old rows goes here directly. Nothing in this store feeds the age estimation
 * (it reads the log and the anchor pool only), and nothing here is rewritten
 * by a listing event: it is touched when a row is retired, imported or deleted,
 * and read by the history viewer.
 *
 * ## Layout
 *
 * One record per character per month of the listing's own time:
 * `marketListingArchiveRec_<charId>_<YYYY-MM>`, in the same store as the log.
 * A month of a busy trader is a few hundred rows, so a retirement rewrites one
 * or two small records rather than the whole history. Deletions live in
 * `marketListingArchiveRecTomb_<charId>`, written by the chunked-history
 * machinery. The prefix cannot be read as a legacy key of the log
 * (`marketListingTimestamps_<id>`) or of its tombstones
 * (`marketListingGraves_<id>`), the same separation the alchemy session
 * records keep with their `Rec` suffix.
 *
 * ## Deletions are permanent, and the tombstones above are not
 *
 * The chunked history's tombstones age out after thirty days and are capped at five hundred, which is right
 * for pruning and wrong for a record the player deletes on purpose: the gist never loses a row, so a deletion
 * that has aged out comes back with the next pull. The archive therefore keeps a second record, per character,
 * that never ages: `marketListingArchiveGone_<charId>` = `{clearedAt, removed: {id: at}}`. A row is hidden when
 * its archived-at stamp (`archivedAt` or `importedAt`, whichever is later) is no later than `clearedAt`, or
 * than the time its id was individually deleted. Every read applies it; a retirement or an import written
 * after the deletion carries a later stamp and so comes back. Its sync merge is a union (the later time per
 * id, the later `clearedAt`), so no device's pull can take a deletion back. The chunked tombstones are still
 * written, for physically pruning the months; the record is what guarantees the hiding.
 *
 * Identity is the listing's server id. Two copies of one id (a row that was
 * retired on one device and imported on another, or archived at two statuses)
 * fold with {@link mergeListingCopies}, which is deterministic whichever side
 * it meets first.
 */

import storage from '../../core/storage.js';
import { createChunkedHistory, timeChunkId } from '../../utils/chunked-history.js';
import { registerSyncMerge } from '../../utils/sync-merge-registry.js';

/** Same store as the log it spills from */
export const ARCHIVE_STORE = 'marketListings';

/** Record prefix: `marketListingArchiveRec_<charId>_<YYYY-MM>` */
export const ARCHIVE_PREFIX = 'marketListingArchiveRec';

/**
 * The permanent deletion record's key base: `marketListingArchiveGone_<charId>`. Spelled so that neither the
 * archive's record prefix (`...Rec_`) nor its tombstone prefix (`...RecTomb_`) can match it.
 */
export const GONE_BASE = 'marketListingArchiveGone';

/**
 * @param {string} charId - Whose archive
 * @returns {string} The key of that character's permanent deletion record
 */
export function goneKey(charId) {
    return `${GONE_BASE}_${charId}`;
}

/**
 * A permanent deletion record, normalized.
 * @param {*} record - Whatever is stored
 * @returns {{clearedAt: number, removed: Object<string, number>}}
 */
export function goneOf(record) {
    const clearedAt = Number(record?.clearedAt);
    const removed = {};
    if (record && typeof record.removed === 'object' && record.removed !== null) {
        for (const [id, at] of Object.entries(record.removed)) {
            const time = Number(at);
            if (Number.isFinite(time) && time > 0) removed[id] = time;
        }
    }
    return { clearedAt: Number.isFinite(clearedAt) && clearedAt > 0 ? clearedAt : 0, removed };
}

/**
 * Two permanent deletion records folded: the later `clearedAt`, and each id at the later of its times.
 * Union-only, so it is the same fold on a pull, a push and a restore, whichever side is met first. Ids deleted
 * no later than the clear are dropped: the clear already hides everything they could hide.
 * @param {*} local - One record
 * @param {*} incoming - The other
 * @returns {{clearedAt: number, removed: Object<string, number>}}
 */
export function mergeArchiveGone(local, incoming) {
    const a = goneOf(local);
    const b = goneOf(incoming);
    const clearedAt = Math.max(a.clearedAt, b.clearedAt);
    const removed = {};
    for (const source of [a.removed, b.removed]) {
        for (const [id, at] of Object.entries(source)) {
            if (at > clearedAt && !(removed[id] >= at)) removed[id] = at;
        }
    }
    return { clearedAt, removed };
}

/**
 * When a row entered the archive: the later of its `archivedAt` (a retirement) and `importedAt` (an import).
 * @param {Object} listing
 * @returns {number} Epoch ms; 0 for a row written before the stamps existed
 */
export function archivedStamp(listing) {
    return Math.max(Number(listing?.archivedAt) || 0, Number(listing?.importedAt) || 0);
}

/**
 * Whether the permanent deletion record hides an archived row.
 * @param {Object} listing
 * @param {{clearedAt: number, removed: Object<string, number>}} gone - From {@link goneOf}
 * @param {number} [stamp] - The row's stamp, when it is not the one it carries
 * @returns {boolean}
 */
export function isGone(listing, gone, stamp = archivedStamp(listing)) {
    if (gone.clearedAt > 0 && stamp <= gone.clearedAt) return true;
    const at = gone.removed[String(listing?.id)];
    return at !== undefined && stamp <= at;
}

/**
 * When a listing was created, for retention and for the archive's month: its
 * recorded `timestamp`, else its `createdTimestamp`, else 0 (undatable rows
 * sort as the oldest).
 * @param {Object} listing
 * @returns {number} Epoch ms
 */
export function listingTime(listing) {
    if (Number.isFinite(listing.timestamp)) return listing.timestamp;
    const parsed = Date.parse(listing.createdTimestamp);
    return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * How settled a status is: a resolved listing outranks one still open, which
 * outranks one nobody has classified.
 * @param {string|undefined} status
 * @returns {number}
 */
function statusRank(status) {
    if (status === 'filled' || status === 'canceled' || status === 'expired') return 2;
    if (status === 'active') return 1;
    return 0;
}

/**
 * How far along a copy of a listing is: its status first, then how much of it has filled. The order
 * {@link mergeListingCopies} prefers, as one number, which is what a deletion's tombstone compares.
 * @param {Object} listing
 * @returns {number}
 */
export function listingRevision(listing) {
    return statusRank(listing?.status) * 1e13 + (Number(listing?.filledQuantity) || 0);
}

/**
 * The one listing two copies of the same id become.
 *
 * The more final status wins (filled / canceled / expired over active over
 * unknown), then the higher filled quantity, and a tie falls to the copy whose
 * JSON sorts later, so the answer does not depend on which side was met first.
 * @param {Object} a - One copy
 * @param {Object} b - The other
 * @returns {Object} The copy to keep (one of the two, by reference)
 */
export function mergeListingCopies(a, b) {
    if (!a) return b;
    if (!b) return a;
    const winner = pickCopy(a, b);
    // Whichever copy wins, the row keeps the later archived-at stamp: a re-import after a deletion must not
    // lose its stamp to a stale copy that is further along, or the deletion would hide it again
    const stamp = Math.max(archivedStamp(a), archivedStamp(b));
    if (stamp > archivedStamp(winner)) return { ...winner, archivedAt: stamp };
    return winner;
}

/**
 * The copy {@link mergeListingCopies} prefers, before the stamp is carried over.
 * @param {Object} a
 * @param {Object} b
 * @returns {Object}
 */
function pickCopy(a, b) {
    const rankA = statusRank(a.status);
    const rankB = statusRank(b.status);
    if (rankA !== rankB) return rankB > rankA ? b : a;
    const filledA = Number(a.filledQuantity) || 0;
    const filledB = Number(b.filledQuantity) || 0;
    if (filledA !== filledB) return filledB > filledA ? b : a;
    return JSON.stringify(b) > JSON.stringify(a) ? b : a;
}

class ListingArchive {
    constructor() {
        this.store = createChunkedHistory({
            storeName: ARCHIVE_STORE,
            prefix: ARCHIVE_PREFIX,
            // The archive never had a single-array key. The store wants one to look for; this one is
            // never written, so the legacy path is never taken.
            legacyKey: (charId) => `marketListingArchiveNever_${charId}`,
            groupOf: (listing) => timeChunkId(listingTime(listing), 'month'),
            compare: (a, b) => a.id - b.id,
            identityOf: (listing) => listing?.id,
            mergeCopies: mergeListingCopies,
            // A deletion covers every copy no further along than the one deleted, whatever else differs
            // between devices' copies (an import stamps its own moment), except one stamped after it
            revisionOf: listingRevision,
            editedAtOf: archivedStamp,
            // A retirement is rare and small, and the caller must know whether it landed
            immediate: true,
            label: 'ListingArchive',
        });
        /** Archive operations run one at a time: each is a read, a fold and a write */
        this._chain = Promise.resolve();
    }

    /**
     * @template T
     * @param {() => Promise<T>} task
     * @returns {Promise<T>} The task's result, after every earlier task settled
     * @private
     */
    _enqueue(task) {
        const next = this._chain.then(task, task);
        this._chain = next.then(
            () => undefined,
            () => undefined
        );
        return next;
    }

    /**
     * A character's permanent deletion record, read from storage.
     * @param {string} charId - Whose archive
     * @returns {Promise<{clearedAt: number, removed: Object<string, number>}|null>} Null when it could not
     *   be read, which says nothing about what it holds
     * @private
     */
    async _readGone(charId) {
        try {
            const probe = await storage.tryGet(goneKey(charId), ARCHIVE_STORE);
            if (probe === null || probe === undefined) return null;
            return goneOf(probe.found ? probe.value : null);
        } catch (error) {
            console.error('[ListingArchive] Failed to read the deletion record:', error);
            return null;
        }
    }

    /**
     * Fold deletions into the permanent record and wait until they are written.
     *
     * A read-merge-write through {@link mergeArchiveGone}, so a deletion made on another tab or pulled from a
     * peer is kept. Recorded whether or not this device's archive holds the rows: a peer's archive may.
     * @param {string} charId - Whose archive
     * @param {{ids?: Array<number>, clearAll?: boolean}} deletion - Ids deleted now, or everything
     * @returns {Promise<boolean>} Whether the record now holds them
     * @private
     */
    async _recordGone(charId, { ids = [], clearAll = false }) {
        const current = await this._readGone(charId);
        if (current === null) return false;
        const at = Date.now();
        const fresh = { clearedAt: clearAll ? at : 0, removed: {} };
        for (const id of ids) {
            if (Number.isFinite(id)) fresh.removed[String(id)] = at;
        }
        const next = mergeArchiveGone(current, fresh);
        try {
            return (await storage.set(goneKey(charId), next, ARCHIVE_STORE, true)) === true;
        } catch (error) {
            console.error('[ListingArchive] Failed to write the deletion record:', error);
            return false;
        }
    }

    /**
     * Every archived listing of a character that has not been deleted.
     *
     * Reads storage afresh each time: another tab may have cleared, deleted or archived since this one last
     * looked, and a stale memory is what this tab would then write back.
     * @param {string} charId - Whose archive
     * @returns {Promise<Array<Object>|null>} Copies, sorted by id; null when the archive (or its deletion
     *   record) cannot be read, which is not the same as an empty archive
     */
    read(charId) {
        return this._enqueue(async () => {
            try {
                this.store.forget();
                const gone = await this._readGone(charId);
                if (gone === null) return null;
                const rows = await this.store.load(charId);
                if (this.store.wasUnreadable(charId)) return null;
                return rows.filter((row) => !isGone(row, gone)).map((row) => ({ ...row }));
            } catch (error) {
                console.error('[ListingArchive] Failed to read the archive:', error);
                return null;
            }
        });
    }

    /**
     * Fold listings into the archive and wait until they are written.
     *
     * Rows already archived are merged by {@link mergeListingCopies}; a row that adds nothing writes nothing.
     * A failure leaves the caller's rows where they are: the caller drops nothing unless this says `ok`.
     *
     * A row the permanent deletion record hides is treated as absent, and a retirement (no `importedAt`) of a
     * row the record covers is skipped as a stale copy of something deleted: the log's row carries no stamp
     * unless it was imported, so its listing time stands in for one. Both count as handled (`ok`), since the
     * log should let go of them.
     * @param {string} charId - Whose archive
     * @param {Array<Object>} rows - Listings to archive
     * @param {Object} [options]
     * @param {number} [options.importedAt] - Stamp copies with the moment of an import. A deletion matches
     *   what was stamped before it, so a row deleted and then imported again outlives the deletion
     * @returns {Promise<{ok: boolean, added: number}>} `added` counts ids the archive did not hold before
     */
    add(charId, rows, { importedAt } = {}) {
        return this._enqueue(async () => {
            try {
                this.store.forget();
                const gone = await this._readGone(charId);
                if (gone === null) return { ok: false, added: 0 };
                const existing = await this.store.load(charId);
                if (this.store.wasUnreadable(charId)) return { ok: false, added: 0 };
                const byId = new Map(existing.map((row) => [row.id, row]));
                const changedChunks = new Set();
                const now = importedAt === undefined ? Date.now() : importedAt;
                let added = 0;
                for (const incoming of rows || []) {
                    if (!incoming || !Number.isFinite(incoming.id)) continue;
                    const held = byId.get(incoming.id);
                    const previous = held && !isGone(held, gone) ? held : undefined;
                    // An import never rewrites a row the archive already holds
                    if (previous && importedAt !== undefined) continue;
                    if (!previous && importedAt === undefined) {
                        // Retiring a row the log still held after it was deleted or cleared elsewhere
                        const stamp = archivedStamp(incoming) || listingTime(incoming);
                        if (isGone(incoming, gone, stamp)) continue;
                    }
                    let row = incoming;
                    if (importedAt !== undefined) row = { ...incoming, importedAt, archivedAt: now };
                    else if (!previous) row = { ...incoming, archivedAt: now };
                    const next = previous ? mergeListingCopies(previous, row) : row;
                    if (previous && (next === previous || JSON.stringify(next) === JSON.stringify(previous))) continue;
                    if (!previous) added += 1;
                    if (held) changedChunks.add(this.store.groupOf(held));
                    byId.set(row.id, next);
                    changedChunks.add(this.store.groupOf(next));
                }
                if (changedChunks.size === 0) return { ok: true, added: 0 };
                const ok = await this._save(charId, [...byId.values()], { changedChunks });
                return { ok, added: ok ? added : 0 };
            } catch (error) {
                console.error('[ListingArchive] Failed to archive listings:', error);
                this.store.forget();
                return { ok: false, added: 0 };
            }
        });
    }

    /**
     * Delete listings on purpose: recorded permanently first, then taken out of this device's months.
     *
     * The permanent record (see the top of this file) is what keeps a peer's copy from bringing them back,
     * and it is written whether or not this device's archive holds the rows. The chunked tombstones the
     * physical removal leaves are only for pruning the months.
     * @param {string} charId - Whose archive
     * @param {Array<number>} ids - Listing ids
     * @returns {Promise<boolean>} Whether the deletion is recorded. A failed physical removal after that
     *   leaves the rows hidden, which is what the player asked for, and is logged
     */
    remove(charId, ids) {
        return this._enqueue(async () => {
            try {
                this.store.forget();
                if (!(await this._recordGone(charId, { ids }))) return false;
            } catch (error) {
                console.error('[ListingArchive] Failed to record the deletion:', error);
                return false;
            }
            try {
                const wanted = new Set(ids);
                const existing = await this.store.load(charId);
                if (this.store.wasUnreadable(charId)) return true;
                const deleted = existing.filter((row) => wanted.has(row.id));
                if (deleted.length === 0) return true;
                const changedChunks = new Set(deleted.map((row) => this.store.groupOf(row)));
                const rest = existing.filter((row) => !wanted.has(row.id));
                if (!(await this._save(charId, rest, { changedChunks, deleted }))) {
                    console.warn('[ListingArchive] Deleted rows are hidden but could not be removed from storage');
                }
            } catch (error) {
                console.error('[ListingArchive] Failed to delete from the archive:', error);
                this.store.forget();
            }
            return true;
        });
    }

    /**
     * Empty a character's archive: a permanent clear watermark first, then this device's months.
     * @param {string} charId - Whose archive
     * @returns {Promise<boolean>} Whether it is gone: the watermark written and the months deleted
     */
    clear(charId) {
        return this._enqueue(async () => {
            try {
                this.store.forget();
                if (!(await this._recordGone(charId, { clearAll: true }))) return false;
                return await this.store.clear(charId);
            } catch (error) {
                console.error('[ListingArchive] Failed to clear the archive:', error);
                return false;
            }
        });
    }

    /**
     * Drop the in-memory copy, so the next read comes from storage. For tests and for a pull the store
     * did not see.
     * @returns {void}
     */
    reset() {
        this.store.forget();
    }

    /**
     * One store save, resolved when its writes have landed.
     * @param {string} charId - Whose archive
     * @param {Array<Object>} list - The whole archive as it should now be
     * @param {Object} options - `changedChunks`, `deleted`
     * @returns {Promise<boolean>} Whether every write landed
     * @private
     */
    async _save(charId, list, options) {
        let report;
        const landed = new Promise((resolve) => {
            report = resolve;
        });
        const saved = await this.store.save(charId, list, { ...options, onLanded: (ok) => report(ok) });
        const ok = saved && (await landed) === true;
        // The store takes the list it was handed as its memory before the write is made. A write that did not
        // land leaves memory ahead of the disk, and the next call would find its rows "already archived" and
        // report success over rows that were never written. Dropped, so the next call reads what is on disk.
        if (!ok) this.store.forget();
        return ok;
    }
}

const listingArchive = new ListingArchive();

/*
 * The permanent deletion record is carried by sync like the months it hides, and folded as a union so no
 * device's pull or push takes a deletion back. Not liveSafe: every archive operation reads it afresh, but it
 * is written read-merge-write in two steps.
 */
registerSyncMerge({
    store: ARCHIVE_STORE,
    base: GONE_BASE,
    merge: (local, incoming) => mergeArchiveGone(local, incoming),
    label: 'ListingArchive permanent deletions',
});

export default listingArchive;
export { listingArchive, ListingArchive };
