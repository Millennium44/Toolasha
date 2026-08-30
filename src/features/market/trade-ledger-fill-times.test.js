/**
 * Trade Ledger View — the time-to-fill section's rendering.
 *
 * The bucketing arithmetic is covered in `src/utils/fill-time-analysis.test.js`;
 * what this file is for is that the section actually draws — the failure mode
 * no arithmetic test can catch is a renamed helper or a property read off
 * something that stopped having it, which shows up as a silently missing card.
 */

/** @vitest-environment happy-dom */

import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, store, fallback) => fallback,
        set: async () => true,
        getJSON: async (key, store, fallback) => fallback,
        setJSON: async () => true,
        tryGet: async () => ({ found: false, value: null }),
        delete: async () => true,
        getAllKeys: async () => [],
        putAll: async () => 0,
        isQuotaExceeded: () => false,
    },
}));

const { default: tradeLedgerView } = await import('./trade-ledger-view.js');
const { analyzeFillTimes } = await import('../../utils/fill-time-analysis.js');

const HOUR = 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

/**
 * `n` completed sell listings at one price, each taking `hours` to fill.
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
        listings.push({
            id,
            timestamp: T0,
            itemHrid: '/items/coal',
            enhancementLevel: 0,
            price,
            orderQuantity: 10,
            filledQuantity: 10,
            isSell: true,
            status: 'filled',
        });
        fills.push({ listingId: id, t: T0 + hours * HOUR, quantity: 10 });
    }
    return { listings, fills };
}

/** The rendered text of the fill-time section. */
const sectionText = () => tradeLedgerView.modal.querySelector('.mwi-trade-ledger-fill-times').textContent;

describe('the time-to-fill section', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        tradeLedgerView.minimizeCtl?.destroy();
        tradeLedgerView.minimizeCtl = null;
        tradeLedgerView.modal = null;
        tradeLedgerView.fillTimes = null;
        tradeLedgerView.aggregates = { items: [], weeks: [], totals: {} };
        tradeLedgerView.createModal();
    });

    test('says it is still reading before the listing log arrives', () => {
        tradeLedgerView.renderFillTimes();
        expect(sectionText()).toContain('Reading your listing log');
    });

    test('draws a row per depth bucket with its median and count', () => {
        const shallow = cohort({ startId: 1, n: 3, price: 100, hours: 40 });
        const deep = cohort({ startId: 10, n: 3, price: 90, hours: 2 });
        const analysis = analyzeFillTimes({
            listings: [...shallow.listings, ...deep.listings],
            fills: [...shallow.fills, ...deep.fills],
            isSell: true,
            sources: { book: () => 100 },
        });

        tradeLedgerView.fillTimes = { sell: analysis, buy: analyzeFillTimes({ isSell: false }) };
        tradeLedgerView.renderFillTimes();

        const text = sectionText();
        expect(text).toContain('Time to fill vs undercut depth');
        expect(text).toContain('At/above ask');
        expect(text).toContain('5%+ under');
        expect(text).toContain('Median time to full fill');
        // Four bucket rows drawn, whatever they hold
        const rows = tradeLedgerView.modal.querySelectorAll('.mwi-trade-ledger-fill-times tbody tr');
        expect(rows).toHaveLength(4);
    });

    test('never leaves the section blank when there is data to draw', () => {
        const filled = cohort({ startId: 1, n: 3, price: 90, hours: 2 });
        tradeLedgerView.fillTimes = {
            sell: analyzeFillTimes({ ...filled, isSell: true, sources: { book: () => 100 } }),
            buy: analyzeFillTimes({ isSell: false }),
        };
        tradeLedgerView.renderFillTimes();
        expect(sectionText().trim().length).toBeGreaterThan(0);
        expect(sectionText()).not.toContain('undefined');
        expect(sectionText()).not.toContain('NaN');
    });

    test('reports the censored listings on the row of notes, not in a bucket', () => {
        const filled = cohort({ startId: 1, n: 3, price: 90, hours: 2 });
        const cancelled = [4, 5].map((id) => ({
            id,
            timestamp: T0,
            itemHrid: '/items/coal',
            price: 90,
            orderQuantity: 10,
            filledQuantity: 0,
            isSell: true,
            status: 'canceled',
        }));

        tradeLedgerView.fillTimes = {
            sell: analyzeFillTimes({
                listings: [...filled.listings, ...cancelled],
                fills: filled.fills,
                isSell: true,
                sources: { book: () => 100 },
            }),
            buy: analyzeFillTimes({ isSell: false }),
        };
        tradeLedgerView.renderFillTimes();
        expect(sectionText()).toContain('2 cancelled before filling');
    });

    test('marks a thin bucket instead of showing a median over one listing', () => {
        const thin = cohort({ startId: 1, n: 1, price: 90, hours: 2 });
        tradeLedgerView.fillTimes = {
            sell: analyzeFillTimes({ ...thin, isSell: true, sources: { book: () => 100 } }),
            buy: analyzeFillTimes({ isSell: false }),
        };
        tradeLedgerView.renderFillTimes();
        expect(sectionText()).toContain('too few');
    });

    test('says the depths are approximate every time it draws them', () => {
        const filled = cohort({ startId: 1, n: 3, price: 90, hours: 2 });
        tradeLedgerView.fillTimes = {
            sell: analyzeFillTimes({ ...filled, isSell: true, sources: { book: () => 100 } }),
            buy: analyzeFillTimes({ isSell: false }),
        };
        tradeLedgerView.renderFillTimes();
        expect(sectionText()).toContain('approximate');
    });

    test('says so rather than drawing an empty buy table when there are no buy orders', () => {
        const filled = cohort({ startId: 1, n: 3, price: 90, hours: 2 });
        tradeLedgerView.fillTimes = {
            sell: analyzeFillTimes({ ...filled, isSell: true, sources: { book: () => 100 } }),
            buy: analyzeFillTimes({ isSell: false }),
        };
        tradeLedgerView.renderFillTimes();
        expect(sectionText()).toContain('Sell side only');
        expect(sectionText()).not.toContain('At/below bid');
    });

    test('draws the buy table, in over-the-bid terms, once there are buy orders', () => {
        const buys = cohort({ startId: 1, n: 3, price: 110, hours: 6 });
        buys.listings.forEach((entry) => {
            entry.isSell = false;
        });

        tradeLedgerView.fillTimes = {
            sell: analyzeFillTimes({ isSell: true }),
            buy: analyzeFillTimes({ ...buys, isSell: false, sources: { book: () => 100 } }),
        };
        tradeLedgerView.renderFillTimes();
        expect(sectionText()).toContain('At/below bid');
        expect(sectionText()).not.toContain('Sell side only');
    });

    test('explains itself rather than showing empty tables on a fresh install', () => {
        tradeLedgerView.fillTimes = {
            sell: analyzeFillTimes({ isSell: true }),
            buy: analyzeFillTimes({ isSell: false }),
        };
        tradeLedgerView.renderFillTimes();
        expect(sectionText()).toContain('No completed listings');
        expect(tradeLedgerView.modal.querySelectorAll('.mwi-trade-ledger-fill-times tbody tr')).toHaveLength(0);
    });

    test('says the section failed rather than drawing nothing when the analysis threw', () => {
        tradeLedgerView.fillTimes = { error: true };
        tradeLedgerView.renderFillTimes();
        expect(sectionText()).toContain('could not be drawn');
    });
});
