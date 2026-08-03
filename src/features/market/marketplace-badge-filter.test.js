/**
 * Tests for when the sidebar's Marketplace badge is warranted.
 *
 * The rule matters more than it looks: hide too much and uncollected coins sit
 * there silently, hide too little and the badge is back to firing on orders you
 * cannot do anything about.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ listings: null, styles: new Set() }));

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterData() {
            return game.listings === null ? null : { myMarketListings: game.listings };
        },
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../utils/dom.js', () => ({
    addStyles: (_css, id) => game.styles.add(id),
    removeStyles: (id) => game.styles.delete(id),
}));

const { isFinishedWithSpoils, anyFinished, default: badgeFilter } = await import('./marketplace-badge-filter.js');

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

describe('starting up with listings already on the books', () => {
    /** Whether the badge is currently being hidden */
    const hiding = () => game.styles.has('mwi-marketplace-badge-filter');

    beforeEach(() => {
        game.styles.clear();
        game.listings = null;
        badgeFilter.hidden = false;
        badgeFilter.unregister = null;
    });

    test('a filled order sitting there through a reload still badges', () => {
        // The reported bug. Features are initialized from inside the
        // `character_initialized` handler, so subscribing to that event and
        // waiting is subscribing to something that has already happened — the
        // badge stayed hidden until an unrelated listing happened to change.
        game.listings = [listing()];

        badgeFilter.initialize();

        expect(hiding()).toBe(false);
    });

    test('and a book of working orders is still quietened at start-up', () => {
        game.listings = [listing({ filledQuantity: 30, unclaimedItemCount: 30 })];

        badgeFilter.initialize();

        expect(hiding()).toBe(true);
    });

    test('no character data yet hides, and says nothing it cannot know', () => {
        badgeFilter.initialize();

        expect(hiding()).toBe(true);
    });

    test('a later update is still followed', () => {
        game.listings = [listing({ filledQuantity: 30, unclaimedItemCount: 30 })];
        badgeFilter.initialize();
        expect(hiding()).toBe(true);

        game.listings = [listing()];
        badgeFilter.refresh();

        expect(hiding()).toBe(false);
    });

    test('a listing that leaves the book stops badging for it', () => {
        // Which a privately accumulated copy could not do: the listing would
        // linger at whatever state it was last seen in
        game.listings = [listing()];
        badgeFilter.initialize();
        expect(hiding()).toBe(false);

        game.listings = [];
        badgeFilter.refresh();

        expect(hiding()).toBe(true);
    });
});
