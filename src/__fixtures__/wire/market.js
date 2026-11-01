/**
 * `market_listings_updated` and `market_item_order_books_updated`. Captured on the test
 * server, 2026-11-01. Listing ids and the character id are synthetic.
 *
 * Listing: the same listing placed (`/market_listing_status/active`) and then cancelled
 * (`/market_listing_status/cancelled`, British spelling). The two messages differ in more
 * than status: the placed one carries nanosecond timestamps (`...14.129627384Z`) and the
 * cancel carries millisecond ones (`...14.13Z`), so a timestamp is not a stable key
 * across a listing's messages. The field is `characterID` (capital ID).
 *
 * Order book: `marketItemOrderBooks` holds arrays indexed by enhancement level (here only
 * level 0). `bids` is an empty array when nobody is buying, a real case. Prices are whole
 * coins; `marketValues` is a fractional average.
 */

const LISTING_ID = 900201;

/**
 * @param {Object} [overrides] - Fields replaced on the listing row
 * @returns {Object} A placed (active) listing row
 */
export function buildPlacedListing(overrides = {}) {
    return {
        id: LISTING_ID,
        characterID: 900001,
        status: '/market_listing_status/active',
        isSell: true,
        itemHrid: '/items/cheese',
        enhancementLevel: 0,
        orderQuantity: 1,
        filledQuantity: 0,
        price: 584,
        coinsAvailable: 0,
        taxTaken: 0,
        unclaimedItemCount: 0,
        unclaimedCoinCount: 0,
        createdTimestamp: '2026-11-01T22:46:14.129627384Z',
        expirationTimestamp: '2026-12-01T22:46:14.129627484Z',
        ...overrides,
    };
}

/**
 * @param {Object} [overrides] - Fields replaced on the listing row
 * @returns {Object} The same listing as the cancel message carries it
 */
export function buildCancelledListing(overrides = {}) {
    return buildPlacedListing({
        status: '/market_listing_status/cancelled',
        createdTimestamp: '2026-11-01T22:46:14.13Z',
        expirationTimestamp: '2026-12-01T22:46:14.13Z',
        ...overrides,
    });
}

/**
 * @param {Object} [overrides] - Fields replaced on the message
 * @returns {Object} The listing-placed `market_listings_updated` message
 */
export function buildListingPlaced(overrides = {}) {
    return { type: 'market_listings_updated', endMarketListings: [buildPlacedListing()], ...overrides };
}

/**
 * @param {Object} [overrides] - Fields replaced on the message
 * @returns {Object} The listing-cancelled `market_listings_updated` message
 */
export function buildListingCancelled(overrides = {}) {
    return { type: 'market_listings_updated', endMarketListings: [buildCancelledListing()], ...overrides };
}

/**
 * @param {Object} [overrides] - Fields replaced on the message
 * @returns {Object} A `market_item_order_books_updated` message (cheese, three asks, no bids)
 */
export function buildOrderBooksUpdated(overrides = {}) {
    return {
        type: 'market_item_order_books_updated',
        marketItemOrderBooks: {
            itemHrid: '/items/cheese',
            orderBooks: [
                {
                    asks: [
                        { listingId: 900301, quantity: 1000000, price: 1000000000 },
                        { listingId: 900302, quantity: 1, price: 10000000000 },
                        { listingId: 900303, quantity: 5, price: 1000000000000 },
                    ],
                    bids: [],
                },
            ],
            marketValues: [527.8339752108598],
            priceBandMins: [476],
            priceBandMaxs: [584],
        },
        ...overrides,
    };
}
