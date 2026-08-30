import { describe, it, expect } from 'vitest';
import {
    UNDERCUT_BUCKETS,
    MIN_BUCKET_N,
    bucketForOffset,
    groupFillsByListing,
    fullFillTimestamp,
    referenceAsk,
    median,
    isCensored,
    analyzeFillTimes,
} from './fill-time-analysis.js';

const HOUR = 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

/**
 * A listing-log entry with sane defaults.
 * @param {Object} overrides - Fields to override
 * @returns {Object} Listing entry
 */
function listing(overrides = {}) {
    return {
        id: 1,
        timestamp: T0,
        createdTimestamp: new Date(T0).toISOString(),
        itemHrid: '/items/coal',
        enhancementLevel: 0,
        price: 100,
        orderQuantity: 10,
        filledQuantity: 10,
        isSell: true,
        status: 'filled',
        ...overrides,
    };
}

/**
 * A fill record.
 * @param {number} listingId - Listing the fill belongs to
 * @param {number} t - When it landed
 * @param {number} quantity - Units
 * @returns {Object} Fill record
 */
function fill(listingId, t, quantity) {
    return { listingId, t, quantity, side: 'sell', itemHrid: '/items/coal', enhancementLevel: 0, price: 100 };
}

describe('bucketForOffset', () => {
    it('puts a listing priced above the ask in the at/above bucket', () => {
        expect(bucketForOffset(-0.5)).toBe('atOrAbove');
        expect(bucketForOffset(-0.001)).toBe('atOrAbove');
    });

    it('treats exactly at-ask as not undercutting', () => {
        expect(bucketForOffset(0)).toBe('atOrAbove');
    });

    it('walks the bands by upper edge, inclusive', () => {
        expect(bucketForOffset(0.0001)).toBe('under0to2');
        expect(bucketForOffset(0.02)).toBe('under0to2');
        expect(bucketForOffset(0.0201)).toBe('under2to5');
        expect(bucketForOffset(0.05)).toBe('under2to5');
        expect(bucketForOffset(0.0501)).toBe('under5plus');
        expect(bucketForOffset(0.9)).toBe('under5plus');
    });

    it('rejects non-numbers rather than bucketing them', () => {
        expect(bucketForOffset(NaN)).toBeNull();
        expect(bucketForOffset(Infinity)).toBeNull();
        expect(bucketForOffset(null)).toBeNull();
        expect(bucketForOffset(undefined)).toBeNull();
    });

    it('covers the whole line with four buckets', () => {
        expect(UNDERCUT_BUCKETS).toHaveLength(4);
        expect(UNDERCUT_BUCKETS[UNDERCUT_BUCKETS.length - 1].max).toBe(Infinity);
    });
});

describe('groupFillsByListing', () => {
    it('joins fills to listings on listingId', () => {
        const grouped = groupFillsByListing([fill(1, T0, 2), fill(2, T0, 5), fill(1, T0 + HOUR, 8)]);
        expect([...grouped.keys()].sort()).toEqual([1, 2]);
        expect(grouped.get(1)).toHaveLength(2);
        expect(grouped.get(2)).toHaveLength(1);
    });

    it('sorts each listing’s fills oldest first however they arrived', () => {
        const grouped = groupFillsByListing([fill(1, T0 + 3 * HOUR, 1), fill(1, T0, 1), fill(1, T0 + HOUR, 1)]);
        expect(grouped.get(1).map((f) => f.t)).toEqual([T0, T0 + HOUR, T0 + 3 * HOUR]);
    });

    it('drops fills with no listing id instead of grouping them together', () => {
        const grouped = groupFillsByListing([{ t: T0, quantity: 1 }, fill(1, T0, 1), null]);
        expect(grouped.size).toBe(1);
        expect(grouped.has(undefined)).toBe(false);
    });

    it('handles a missing fill array', () => {
        expect(groupFillsByListing(undefined).size).toBe(0);
    });
});

describe('fullFillTimestamp', () => {
    it('dates a single-fill listing by that fill', () => {
        expect(fullFillTimestamp(listing(), [fill(1, T0 + HOUR, 10)])).toBe(T0 + HOUR);
    });

    it('dates a partially filled listing by the fill that completed it, not the first', () => {
        const fills = [fill(1, T0 + HOUR, 3), fill(1, T0 + 2 * HOUR, 3), fill(1, T0 + 9 * HOUR, 4)];
        expect(fullFillTimestamp(listing(), fills)).toBe(T0 + 9 * HOUR);
    });

    it('returns null while the observed fills fall short of the order', () => {
        expect(fullFillTimestamp(listing(), [fill(1, T0 + HOUR, 3), fill(1, T0 + 2 * HOUR, 4)])).toBeNull();
    });

    it('stops at the crossing, so surplus fills do not move the answer', () => {
        const fills = [fill(1, T0 + HOUR, 10), fill(1, T0 + 5 * HOUR, 10)];
        expect(fullFillTimestamp(listing(), fills)).toBe(T0 + HOUR);
    });

    it('counts a fill that overshoots as the completing one', () => {
        expect(fullFillTimestamp(listing({ orderQuantity: 10 }), [fill(1, T0 + HOUR, 25)])).toBe(T0 + HOUR);
    });

    it('returns null with no fills, no order quantity, or a zero order', () => {
        expect(fullFillTimestamp(listing(), [])).toBeNull();
        expect(fullFillTimestamp(listing({ orderQuantity: 0 }), [fill(1, T0, 5)])).toBeNull();
        expect(fullFillTimestamp(listing({ orderQuantity: undefined }), [fill(1, T0, 5)])).toBeNull();
        expect(fullFillTimestamp(null, [fill(1, T0, 5)])).toBeNull();
    });
});

describe('referenceAsk', () => {
    const book = (hrid, level) => (hrid === '/items/coal' && level === 0 ? 120 : null);
    const sample = (hrid) => (hrid === '/items/coal' ? 111 : null);

    it('prefers the order book over the mooket sample', () => {
        expect(referenceAsk(listing(), { book, sample })).toEqual({ price: 120, source: 'book' });
    });

    it('falls back to the sample when the book does not know the item', () => {
        expect(referenceAsk(listing({ enhancementLevel: 3 }), { book, sample })).toEqual({
            price: 111,
            source: 'sample',
        });
    });

    it('returns null when neither source knows the item', () => {
        expect(referenceAsk(listing({ itemHrid: '/items/gold' }), { book, sample })).toBeNull();
    });

    it('ignores a zero or negative reference price rather than dividing by it', () => {
        expect(referenceAsk(listing(), { book: () => 0, sample: () => -1 })).toBeNull();
        expect(referenceAsk(listing(), { book: () => 0, sample })).toEqual({ price: 111, source: 'sample' });
    });

    it('returns null with no sources configured at all', () => {
        expect(referenceAsk(listing(), {})).toBeNull();
        expect(referenceAsk(listing())).toBeNull();
    });
});

describe('median', () => {
    it('takes the middle of an odd list', () => {
        expect(median([5, 1, 3])).toBe(3);
    });

    it('averages the two middles of an even list', () => {
        expect(median([1, 2, 3, 10])).toBe(2.5);
    });

    it('is null for nothing', () => {
        expect(median([])).toBeNull();
        expect(median(undefined)).toBeNull();
    });

    it('does not mutate its input', () => {
        const values = [3, 1, 2];
        median(values);
        expect(values).toEqual([3, 1, 2]);
    });
});

describe('isCensored', () => {
    it('counts cancelled and expired listings as censored', () => {
        expect(isCensored(listing({ status: 'canceled' }))).toBe(true);
        expect(isCensored(listing({ status: 'expired' }))).toBe(true);
    });

    it('does not censor filled, active or unknown listings', () => {
        expect(isCensored(listing({ status: 'filled' }))).toBe(false);
        expect(isCensored(listing({ status: 'active' }))).toBe(false);
        expect(isCensored(listing({ status: 'unknown' }))).toBe(false);
    });
});

describe('analyzeFillTimes', () => {
    const book = () => 100;

    /**
     * `n` filled sell listings at one price, each taking `hours` to complete.
     * @param {Object} params - Inputs
     * @param {number} params.startId - First listing id
     * @param {number} params.n - How many
     * @param {number} params.price - Listing price
     * @param {number} params.hours - Hours to full fill
     * @returns {{listings: Array<Object>, fills: Array<Object>}} Log and ledger
     */
    function cohort({ startId, n, price, hours }) {
        const listings = [];
        const fills = [];
        for (let i = 0; i < n; i++) {
            const id = startId + i;
            listings.push(listing({ id, price }));
            fills.push(fill(id, T0 + hours * HOUR, 10));
        }
        return { listings, fills };
    }

    it('buckets by undercut depth and reports the median per bucket', () => {
        // ask 100: price 100 is at-ask, 99 is 1% under, 96 is 4% under, 90 is 10% under
        const shallow = cohort({ startId: 1, n: 3, price: 100, hours: 40 });
        const mid = cohort({ startId: 10, n: 3, price: 99, hours: 20 });
        const deep = cohort({ startId: 20, n: 3, price: 96, hours: 8 });
        const deepest = cohort({ startId: 30, n: 3, price: 90, hours: 1 });

        const result = analyzeFillTimes({
            listings: [...shallow.listings, ...mid.listings, ...deep.listings, ...deepest.listings],
            fills: [...shallow.fills, ...mid.fills, ...deep.fills, ...deepest.fills],
            isSell: true,
            sources: { book },
        });

        expect(result.rows.map((row) => [row.id, row.count, row.medianMs])).toEqual([
            ['atOrAbove', 3, 40 * HOUR],
            ['under0to2', 3, 20 * HOUR],
            ['under2to5', 3, 8 * HOUR],
            ['under5plus', 3, 1 * HOUR],
        ]);
        expect(result.filled).toBe(12);
        expect(result.sources).toEqual({ book: 12, sample: 0 });
    });

    it('always flags its offsets as approximate', () => {
        expect(analyzeFillTimes({ listings: [], fills: [], isSell: true }).approximate).toBe(true);
    });

    it('takes the median of the durations, not the mean', () => {
        const listings = [1, 2, 3, 4, 5].map((id) => listing({ id, price: 90 }));
        const hours = [1, 2, 3, 4, 500];
        const fills = listings.map((entry, index) => fill(entry.id, T0 + hours[index] * HOUR, 10));

        const result = analyzeFillTimes({ listings, fills, isSell: true, sources: { book } });
        const deep = result.rows.find((row) => row.id === 'under5plus');
        expect(deep.medianMs).toBe(3 * HOUR);
    });

    it('dates a partially filled listing by its completing fill', () => {
        const listings = [1, 2, 3].map((id) => listing({ id, price: 90 }));
        const fills = listings.flatMap((entry) => [fill(entry.id, T0 + 1 * HOUR, 4), fill(entry.id, T0 + 6 * HOUR, 6)]);

        const result = analyzeFillTimes({ listings, fills, isSell: true, sources: { book } });
        expect(result.rows.find((row) => row.id === 'under5plus').medianMs).toBe(6 * HOUR);
    });

    it('reports cancelled listings as censored and keeps them out of every bucket', () => {
        const filledCohort = cohort({ startId: 1, n: 3, price: 90, hours: 2 });
        const dead = [
            listing({ id: 50, price: 90, status: 'canceled', filledQuantity: 0 }),
            listing({ id: 51, price: 90, status: 'expired', filledQuantity: 0 }),
        ];

        const result = analyzeFillTimes({
            listings: [...filledCohort.listings, ...dead],
            fills: filledCohort.fills,
            isSell: true,
            sources: { book },
        });

        expect(result.censored).toBe(2);
        expect(result.filled).toBe(3);
        expect(result.rows.reduce((sum, row) => sum + row.count, 0)).toBe(3);
        expect(result.rows.find((row) => row.id === 'under5plus').medianMs).toBe(2 * HOUR);
    });

    it('skips still-open listings entirely — neither filled nor censored', () => {
        const result = analyzeFillTimes({
            listings: [listing({ id: 1, status: 'active' }), listing({ id: 2, status: 'unknown' })],
            fills: [fill(1, T0 + HOUR, 4)],
            isSell: true,
            sources: { book },
        });
        expect(result.filled).toBe(0);
        expect(result.censored).toBe(0);
        expect(result.rows.every((row) => row.count === 0)).toBe(true);
    });

    it('drops a listing whose fills never reach its order quantity', () => {
        const result = analyzeFillTimes({
            listings: [listing({ id: 1, price: 90 })],
            fills: [fill(1, T0 + HOUR, 4)],
            isSell: true,
            sources: { book },
        });
        expect(result.filled).toBe(0);
    });

    it('drops a completing fill that predates the listing rather than reporting a negative time', () => {
        const result = analyzeFillTimes({
            listings: [listing({ id: 1, price: 90 })],
            fills: [fill(1, T0 - HOUR, 10)],
            isSell: true,
            sources: { book },
        });
        expect(result.filled).toBe(0);
        expect(result.rows.every((row) => row.count === 0)).toBe(true);
    });

    it('counts an unpriced listing separately instead of bucketing it at zero offset', () => {
        const priced = cohort({ startId: 1, n: 3, price: 90, hours: 2 });
        const result = analyzeFillTimes({
            listings: [...priced.listings, listing({ id: 60, itemHrid: '/items/mystery' })],
            fills: [...priced.fills, fill(60, T0 + HOUR, 10)],
            isSell: true,
            sources: { book: (hrid) => (hrid === '/items/coal' ? 100 : null) },
        });

        expect(result.unpriced).toBe(1);
        expect(result.filled).toBe(4);
        expect(result.rows.reduce((sum, row) => sum + row.count, 0)).toBe(3);
    });

    it('labels which reference each offset came from so the fallback is visible', () => {
        const result = analyzeFillTimes({
            listings: [listing({ id: 1, price: 90 }), listing({ id: 2, price: 90, itemHrid: '/items/tin' })],
            fills: [fill(1, T0 + HOUR, 10), fill(2, T0 + HOUR, 10)],
            isSell: true,
            sources: {
                book: (hrid) => (hrid === '/items/coal' ? 100 : null),
                sample: () => 100,
            },
        });
        expect(result.sources).toEqual({ book: 1, sample: 1 });
    });

    it('marks a bucket thin and withholds its median below the minimum n', () => {
        const listings = [1, 2].map((id) => listing({ id, price: 90 }));
        const fills = listings.map((entry) => fill(entry.id, T0 + 2 * HOUR, 10));

        const result = analyzeFillTimes({ listings, fills, isSell: true, sources: { book } });
        const deep = result.rows.find((row) => row.id === 'under5plus');
        expect(MIN_BUCKET_N).toBe(3);
        expect(deep.count).toBe(2);
        expect(deep.thin).toBe(true);
        expect(deep.medianMs).toBeNull();
    });

    it('separates the two sides of the book', () => {
        const sells = cohort({ startId: 1, n: 3, price: 90, hours: 2 });
        // A buy is aggressive when it is *above* the reference bid, so 110
        // against a 100 bid is the buy-side mirror of the 90 sells
        const buys = cohort({ startId: 10, n: 3, price: 110, hours: 50 });
        buys.listings.forEach((entry) => {
            entry.isSell = false;
        });
        const all = { listings: [...sells.listings, ...buys.listings], fills: [...sells.fills, ...buys.fills] };

        const sellSide = analyzeFillTimes({ ...all, isSell: true, sources: { book } });
        const buySide = analyzeFillTimes({ ...all, isSell: false, sources: { book } });

        expect(sellSide.rows.find((row) => row.id === 'under5plus').medianMs).toBe(2 * HOUR);
        expect(buySide.rows.find((row) => row.id === 'under5plus').medianMs).toBe(50 * HOUR);
    });

    it('flips the offset sign for buys, so bidding under the bid is the passive bucket', () => {
        const buys = cohort({ startId: 1, n: 3, price: 90, hours: 30 });
        buys.listings.forEach((entry) => {
            entry.isSell = false;
        });

        const result = analyzeFillTimes({ ...buys, isSell: false, sources: { book } });
        expect(result.rows.find((row) => row.id === 'atOrAbove').count).toBe(3);
        expect(result.rows.find((row) => row.id === 'under5plus').count).toBe(0);
    });

    it('labels the buy side in over-the-bid terms rather than undercut terms', () => {
        const sell = analyzeFillTimes({ listings: [], fills: [], isSell: true });
        const buy = analyzeFillTimes({ listings: [], fills: [], isSell: false });
        expect(sell.rows.map((row) => row.label)).toEqual(['At/above ask', '0–2% under', '2–5% under', '5%+ under']);
        expect(buy.rows.map((row) => row.label)).toEqual(['At/below bid', '0–2% over', '2–5% over', '5%+ over']);
    });

    it('asks the reference source for the right side of the book', () => {
        const seen = [];
        analyzeFillTimes({
            listings: [listing({ id: 1, isSell: false, price: 110 })],
            fills: [fill(1, T0 + HOUR, 10)],
            isSell: false,
            sources: {
                book: (hrid, level, isSell) => {
                    seen.push(isSell);
                    return 100;
                },
            },
        });
        expect(seen).toEqual([false]);
    });

    it('falls back to the ISO createdTimestamp when the numeric one is missing', () => {
        const listings = [1, 2, 3].map((id) =>
            listing({ id, price: 90, timestamp: undefined, createdTimestamp: new Date(T0).toISOString() })
        );
        const fills = listings.map((entry) => fill(entry.id, T0 + 4 * HOUR, 10));

        const result = analyzeFillTimes({ listings, fills, isSell: true, sources: { book } });
        expect(result.rows.find((row) => row.id === 'under5plus').medianMs).toBe(4 * HOUR);
    });

    it('survives an empty log', () => {
        const result = analyzeFillTimes({ listings: [], fills: [], isSell: true, sources: { book } });
        expect(result.filled).toBe(0);
        expect(result.censored).toBe(0);
        expect(result.rows).toHaveLength(4);
    });

    it('survives being called with nothing at all', () => {
        const result = analyzeFillTimes();
        expect(result.rows).toHaveLength(4);
        expect(result.filled).toBe(0);
    });
});
