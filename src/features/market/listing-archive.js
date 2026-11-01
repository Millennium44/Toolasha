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
 * Identity is the listing's server id. Two copies of one id (a row that was
 * retired on one device and imported on another, or archived at two statuses)
 * fold with {@link mergeListingCopies}, which is deterministic whichever side
 * it meets first.
 */

import { createChunkedHistory, timeChunkId } from '../../utils/chunked-history.js';

/** Same store as the log it spills from */
export const ARCHIVE_STORE = 'marketListings';

/** Record prefix: `marketListingArchiveRec_<charId>_<YYYY-MM>` */
export const ARCHIVE_PREFIX = 'marketListingArchiveRec';

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
function listingRevision(listing) {
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
            // between devices' copies (an import stamps its own moment), except one imported after it
            revisionOf: listingRevision,
            editedAtOf: (listing) => Number(listing?.importedAt) || 0,
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
     * Every archived listing of a character.
     * @param {string} charId - Whose archive
     * @returns {Promise<Array<Object>>} Copies, sorted by id; empty when the archive cannot be read
     */
    read(charId) {
        return this._enqueue(async () => {
            try {
                const rows = await this.store.load(charId);
                return rows.map((row) => ({ ...row }));
            } catch (error) {
                console.error('[ListingArchive] Failed to read the archive:', error);
                return [];
            }
        });
    }

    /**
     * Fold listings into the archive and wait until they are written.
     *
     * Rows already archived are merged by {@link mergeListingCopies}; a row that adds nothing writes nothing.
     * A failure leaves the caller's rows where they are: the caller drops nothing unless this says `ok`.
     * @param {string} charId - Whose archive
     * @param {Array<Object>} rows - Listings to archive
     * @param {Object} [options]
     * @param {number} [options.importedAt] - Stamp copies with the moment of an import. A deletion tombstone
     *   matches the exact content that was deleted, so a row deleted and then imported again is a new copy
     *   that outlives the deletion instead of being buried by it
     * @returns {Promise<{ok: boolean, added: number}>} `added` counts ids the archive did not hold before
     */
    add(charId, rows, { importedAt } = {}) {
        return this._enqueue(async () => {
            try {
                const existing = await this.store.load(charId);
                const byId = new Map(existing.map((row) => [row.id, row]));
                const changedChunks = new Set();
                let added = 0;
                for (const incoming of rows || []) {
                    if (!incoming || !Number.isFinite(incoming.id)) continue;
                    const row = importedAt === undefined ? incoming : { ...incoming, importedAt };
                    const previous = byId.get(row.id);
                    // An import never rewrites a row the archive already holds
                    if (previous && importedAt !== undefined) continue;
                    const next = previous ? mergeListingCopies(previous, row) : row;
                    if (previous && (next === previous || JSON.stringify(next) === JSON.stringify(previous))) continue;
                    if (!previous) added += 1;
                    else changedChunks.add(this.store.groupOf(previous));
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
     * Delete listings from the archive on purpose, leaving a tombstone for each so a peer's copy
     * does not bring them back.
     * @param {string} charId - Whose archive
     * @param {Array<number>} ids - Listing ids
     * @returns {Promise<boolean>} Whether the archive no longer holds them (true when it never did)
     */
    remove(charId, ids) {
        return this._enqueue(async () => {
            try {
                const wanted = new Set(ids);
                const existing = await this.store.load(charId);
                const deleted = existing.filter((row) => wanted.has(row.id));
                if (deleted.length === 0) return true;
                const changedChunks = new Set(deleted.map((row) => this.store.groupOf(row)));
                const rest = existing.filter((row) => !wanted.has(row.id));
                return await this._save(charId, rest, { changedChunks, deleted });
            } catch (error) {
                console.error('[ListingArchive] Failed to delete from the archive:', error);
                this.store.forget();
                return false;
            }
        });
    }

    /**
     * Empty a character's archive, leaving the store's own tombstones for what it held.
     * @param {string} charId - Whose archive
     * @returns {Promise<boolean>} Whether it is gone
     */
    clear(charId) {
        return this._enqueue(async () => {
            try {
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

export default listingArchive;
export { listingArchive, ListingArchive };
