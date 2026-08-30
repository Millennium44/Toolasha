/**
 * Fill-Time Analysis
 *
 * "How much faster does a listing fill if I undercut harder?" — the arithmetic
 * behind the Ledger tab's time-to-fill section.
 *
 * ## What is being measured
 *
 * Time to **full** fill: from a listing's creation to the fill that completed
 * it. Not time to first fill, and not an average over partial progress — the
 * question this answers is how long capital stays tied up in a listing, and
 * capital comes back only when the last unit goes.
 *
 * A listing that never completed is not a slow fill, it is a fill that has not
 * happened. Folding those in as if they had filled at the moment they were
 * cancelled would drag every bucket's median down exactly where undercutting
 * is thinnest, which is the opposite of the truth. They are counted separately
 * and reported as censored — the survival-analysis sense of the word: their
 * true fill time is unknown and at least as long as the listing lived.
 *
 * ## Why the undercut depth is approximate
 *
 * The offset a listing was placed at is `(reference ask − listing price) /
 * reference ask`. The honest reference would be the order book as it stood the
 * moment the listing was created; nothing in this script keeps one. Both
 * available references — the order-book cache and the mooket price store —
 * hold the *latest* book per item, not a history. So an offset reconstructed
 * for a listing created days ago is measured against today's book, and every
 * offset this module produces is approximate. The caller is expected to say so
 * on screen; `analyzeFillTimes` returns `approximate: true` to make forgetting
 * awkward.
 */

/**
 * Undercut-depth buckets, shallowest first.
 *
 * `max` is the largest offset the bucket accepts; a listing lands in the first
 * bucket whose `max` it does not exceed. Priced at or above the reference ask
 * is its own bucket rather than a negative tail: "I did not undercut at all"
 * is the baseline every other row is being compared against, and lumping a
 * 40%-over stale listing in with a 1%-over one costs nothing, because neither
 * undercut.
 */
export const UNDERCUT_BUCKETS = [
    { id: 'atOrAbove', label: 'At/above ask', buyLabel: 'At/below bid', max: 0 },
    { id: 'under0to2', label: '0–2% under', buyLabel: '0–2% over', max: 0.02 },
    { id: 'under2to5', label: '2–5% under', buyLabel: '2–5% over', max: 0.05 },
    { id: 'under5plus', label: '5%+ under', buyLabel: '5%+ over', max: Infinity },
];

/**
 * How few listings a bucket may hold and still show a median.
 *
 * A median over one or two listings is a single listing's luck wearing a
 * statistic's clothes, and this table exists to be compared row against row.
 * Rows below the gate keep their count — knowing you have only tried a depth
 * twice is itself the answer — and show no time.
 */
export const MIN_BUCKET_N = 3;

/**
 * Which bucket an offset falls in.
 * @param {number} offset - Fraction under the reference ask; negative is over it
 * @returns {string|null} Bucket id, or null when the offset is not a number
 */
export function bucketForOffset(offset) {
    if (typeof offset !== 'number' || !Number.isFinite(offset)) return null;
    for (const bucket of UNDERCUT_BUCKETS) {
        if (offset <= bucket.max) return bucket.id;
    }
    return UNDERCUT_BUCKETS[UNDERCUT_BUCKETS.length - 1].id;
}

/**
 * Fill records grouped by the listing they belong to.
 *
 * Fills carry `listingId`; listing-log entries carry `id`. They are the same
 * number — both come off `listing.id` on the wire — but they are spelled
 * differently on the two sides, which is the whole reason this join is a named
 * function rather than an inline `filter`.
 * @param {Array<Object>} fills - Fill records `{t, listingId, quantity, ...}`
 * @returns {Map<number, Array<Object>>} listingId → its fills, oldest first
 */
export function groupFillsByListing(fills) {
    const byListing = new Map();
    for (const fill of Array.isArray(fills) ? fills : []) {
        if (!fill || fill.listingId === undefined || fill.listingId === null) continue;
        const list = byListing.get(fill.listingId);
        if (list) list.push(fill);
        else byListing.set(fill.listingId, [fill]);
    }
    for (const list of byListing.values()) {
        list.sort((a, b) => a.t - b.t);
    }
    return byListing;
}

/**
 * When a listing's last unit went, from its fills.
 *
 * Quantities are accumulated oldest-first and the timestamp of the fill that
 * reaches `orderQuantity` is the answer — so a listing that filled in four
 * partials is dated by the fourth, not the first. Fills beyond the order
 * quantity (a re-listed id, a duplicate the store did not fold) do not move
 * the answer, because the walk stops at the crossing.
 *
 * Null when the observed fills never reach the order quantity: either the
 * listing is still open, or it ended some other way, or the script was not
 * running for some of its fills. None of those is a fill time.
 * @param {Object} listing - Listing-log entry `{orderQuantity, ...}`
 * @param {Array<Object>} fills - That listing's fills, oldest first
 * @returns {number|null} Timestamp of the completing fill, in ms
 */
export function fullFillTimestamp(listing, fills) {
    const target = listing?.orderQuantity;
    if (typeof target !== 'number' || target <= 0) return null;

    let filled = 0;
    for (const fill of fills || []) {
        filled += fill?.quantity || 0;
        if (filled >= target) return fill.t;
    }
    return null;
}

/**
 * The price a listing's depth is measured against, and where it came from.
 *
 * A sell is measured against the top ask and a buy against the top bid: both
 * questions are "how far past the front of my own side of the book did I go",
 * and comparing a buy order against the ask would measure the spread instead.
 *
 * The order-book cache is preferred over the mooket store because it is the
 * real book for that exact enhancement level; the mooket store's entry may
 * have come from the periodic marketplace snapshot, which carries no depth.
 * Both are current, not historical — see the module doc.
 * @param {Object} listing - Listing-log entry `{itemHrid, enhancementLevel, isSell}`
 * @param {Object} sources - Reference lookups, each `(itemHrid, enhancementLevel, isSell) => number|null`
 * @param {Function} [sources.book] - Top-of-book from the order-book cache
 * @param {Function} [sources.sample] - Fallback top-of-book from the nearest sample
 * @returns {{price: number, source: string}|null} Reference, or null when neither source knows the item
 */
export function referenceAsk(listing, sources = {}) {
    const level = listing?.enhancementLevel || 0;
    const isSell = listing?.isSell !== false;
    const fromBook = sources.book ? sources.book(listing?.itemHrid, level, isSell) : null;
    if (typeof fromBook === 'number' && fromBook > 0) {
        return { price: fromBook, source: 'book' };
    }
    const fromSample = sources.sample ? sources.sample(listing?.itemHrid, level, isSell) : null;
    if (typeof fromSample === 'number' && fromSample > 0) {
        return { price: fromSample, source: 'sample' };
    }
    return null;
}

/**
 * The middle value of a sorted-on-the-way numeric list.
 * @param {Array<number>} values - Numbers, any order
 * @returns {number|null} Median, or null for an empty list
 */
export function median(values) {
    if (!values || values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Whether a listing ended without ever completing — the censored population.
 *
 * `expired` counts alongside `canceled`: both are "this listing came off the
 * market with units still on it", which is the same fact about undercut depth.
 *
 * A listing that was cancelled after *some* of it filled is stamped `filled`
 * upstream with its order quantity rewritten down to what actually went (see
 * `estimated-listing-age.js`'s status stamping), so it cannot be told apart
 * from one that filled naturally and is counted as a fill. Nothing in the
 * stored log distinguishes them; this is a known, documented overcount of the
 * fast end rather than a bug to fix here.
 * @param {Object} listing - Listing-log entry
 * @returns {boolean}
 */
export function isCensored(listing) {
    return listing?.status === 'canceled' || listing?.status === 'expired';
}

/**
 * Time-to-full-fill by undercut depth, for one side of the book.
 *
 * @param {Object} params - Inputs
 * @param {Array<Object>} params.listings - Personal listing log entries
 * @param {Array<Object>} params.fills - Trade-ledger fill records
 * @param {boolean} params.isSell - Which side to analyze
 * @param {Object} [params.sources] - Reference-ask lookups, see {@link referenceAsk}
 * @returns {{rows: Array<Object>, censored: number, unpriced: number, filled: number,
 *   sources: {book: number, sample: number}, approximate: boolean}}
 *   `rows` is one entry per bucket in {@link UNDERCUT_BUCKETS} order, each
 *   `{id, label, count, medianMs, thin}`; `medianMs` is null on a thin row.
 */
export function analyzeFillTimes({ listings, fills, isSell, sources = {} } = {}) {
    const byListing = groupFillsByListing(fills);
    const durations = new Map(UNDERCUT_BUCKETS.map((bucket) => [bucket.id, []]));

    let censored = 0;
    let unpriced = 0;
    let filled = 0;
    const sourceCounts = { book: 0, sample: 0 };

    for (const listing of Array.isArray(listings) ? listings : []) {
        if (!listing || listing.isSell !== isSell) continue;

        if (isCensored(listing)) {
            censored += 1;
            continue;
        }
        if (listing.status !== 'filled') continue;

        const created =
            typeof listing.timestamp === 'number' ? listing.timestamp : Date.parse(listing.createdTimestamp);
        const completedAt = fullFillTimestamp(listing, byListing.get(listing.id));
        if (!Number.isFinite(created) || completedAt === null || completedAt < created) continue;
        filled += 1;

        const reference = referenceAsk(listing, sources);
        if (!reference) {
            unpriced += 1;
            continue;
        }
        sourceCounts[reference.source] += 1;

        // Aggressiveness relative to the front of my own side of the book:
        // a sell gets more aggressive as it goes *below* the ask, a buy as it
        // goes *above* the bid. One sign flip keeps both sides in one set of
        // buckets, so the two tables read the same way round.
        const gap = isSell ? reference.price - listing.price : listing.price - reference.price;
        const bucketId = bucketForOffset(gap / reference.price);
        if (!bucketId) {
            unpriced += 1;
            continue;
        }
        durations.get(bucketId).push(completedAt - created);
    }

    const rows = UNDERCUT_BUCKETS.map((bucket) => {
        const values = durations.get(bucket.id);
        const thin = values.length < MIN_BUCKET_N;
        return {
            id: bucket.id,
            label: isSell ? bucket.label : bucket.buyLabel,
            count: values.length,
            medianMs: thin ? null : median(values),
            thin,
        };
    });

    return { rows, censored, unpriced, filled, sources: sourceCounts, approximate: true };
}
