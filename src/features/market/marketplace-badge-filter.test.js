/**
 * Tests for when the sidebar's Marketplace badge is warranted.
 *
 * The rule matters more than it looks: hide too much and uncollected coins sit
 * there silently, hide too little and the badge is back to firing on orders you
 * cannot do anything about.
 */

import { describe, test, expect } from 'vitest';
import { isFinishedWithSpoils, anyFinished } from './marketplace-badge-filter.js';

const listing = (over = {}) => ({
    id: 1,
    status: '/market_listing_status/active',
    orderQuantity: 200,
    filledQuantity: 200,
    unclaimedItemCount: 200,
    unclaimedCoinCount: 0,
    ...over,
});

describe('isFinishedWithSpoils', () => {
    test('a fully filled order with something to collect warrants the badge', () => {
        expect(isFinishedWithSpoils(listing())).toBe(true);
    });

    test('a working order does not, however much it has taken', () => {
        // 30 of 200 bought and still buying — collecting the 30 achieves
        // nothing except silencing the badge until the next fill
        expect(isFinishedWithSpoils(listing({ filledQuantity: 30, unclaimedItemCount: 30 }))).toBe(false);
        expect(isFinishedWithSpoils(listing({ filledQuantity: 199, unclaimedItemCount: 199 }))).toBe(false);
    });

    test('a cancelled order is holding a refund and counts as finished', () => {
        const cancelled = listing({
            status: '/market_listing_status/cancelled',
            filledQuantity: 0,
            unclaimedItemCount: 0,
            unclaimedCoinCount: 500_000,
        });
        expect(isFinishedWithSpoils(cancelled)).toBe(true);
    });

    test('nothing to collect means nothing to say', () => {
        expect(isFinishedWithSpoils(listing({ unclaimedItemCount: 0, unclaimedCoinCount: 0 }))).toBe(false);
        expect(
            isFinishedWithSpoils(
                listing({
                    status: '/market_listing_status/cancelled',
                    unclaimedItemCount: 0,
                    unclaimedCoinCount: 0,
                })
            )
        ).toBe(false);
    });

    test('unclaimed coins count as well as items', () => {
        expect(isFinishedWithSpoils(listing({ unclaimedItemCount: 0, unclaimedCoinCount: 12 }))).toBe(true);
    });

    test('an order for nothing is not finished', () => {
        expect(isFinishedWithSpoils(listing({ orderQuantity: 0, filledQuantity: 0 }))).toBe(false);
    });

    test('says no rather than throwing on nonsense', () => {
        expect(isFinishedWithSpoils(null)).toBe(false);
        expect(isFinishedWithSpoils({})).toBe(false);
    });
});

describe('anyFinished', () => {
    test('one finished listing among many working ones is enough', () => {
        const listings = {
            1: listing({ id: 1, filledQuantity: 30, unclaimedItemCount: 30 }),
            2: listing({ id: 2, filledQuantity: 5, unclaimedItemCount: 5 }),
            3: listing({ id: 3 }),
        };
        expect(anyFinished(listings)).toBe(true);
    });

    test('all working means the badge stays down', () => {
        expect(
            anyFinished({
                1: listing({ id: 1, filledQuantity: 30, unclaimedItemCount: 30 }),
                2: listing({ id: 2, filledQuantity: 1, unclaimedItemCount: 1 }),
            })
        ).toBe(false);
    });

    test('an empty book badges nothing', () => {
        expect(anyFinished({})).toBe(false);
        expect(anyFinished(null)).toBe(false);
    });
});
