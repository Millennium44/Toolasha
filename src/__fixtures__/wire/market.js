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

/*
 * BUY orders, captured on the test server 2026-11-28 (#1024). Ids and the character id are synthetic.
 *
 * - There is no "placed with 0 filled" message when an order fills at placement: the first
 *   `market_listings_updated` already shows the fill (`filledQuantity: 4, unclaimedItemCount: 4`). A
 *   price improvement comes back as `unclaimedCoinCount` ((584 - 574) * 4 = 40).
 * - Filled at placement: `status` filled, `filledQuantity == orderQuantity`, `unclaimedItemCount` = filled.
 * - Filled later (a seller hits the resting order): one more update for that id, status filled.
 * - Collect: status stays filled, both unclaimed counts go to 0 (the items arrive in an `items_updated`
 *   just before).
 * - Cancel of a partly filled order: `status` cancelled (British spelling), `filledQuantity` KEPT,
 *   `coinsAvailable` and both unclaimed counts 0; the filled items and the refund land in the inventory.
 * - The own open remainder shows as a bid in the order book (`listingId` is the listing's id).
 * Timestamps: nanoseconds while the order is live, milliseconds once it has been cancelled or collected.
 */

const BUY_ID = 900211;

/**
 * @param {Object} [overrides] - Fields replaced on the row
 * @returns {Object} A resting buy order for 10 cheese at 584, 4 filled at placement (6 still open)
 */
export function buildPartlyFilledBuy(overrides = {}) {
    return buildPlacedListing({
        id: BUY_ID,
        isSell: false,
        orderQuantity: 10,
        filledQuantity: 4,
        coinsAvailable: 3504,
        unclaimedItemCount: 4,
        unclaimedCoinCount: 40,
        ...overrides,
    });
}

/**
 * @param {Object} [overrides] - Fields replaced on the row
 * @returns {Object} A resting buy order for 10 sugar at 36960 with nothing filled yet
 */
export function buildRestingBuy(overrides = {}) {
    return buildPlacedListing({
        id: 900212,
        isSell: false,
        itemHrid: '/items/sugar',
        orderQuantity: 10,
        filledQuantity: 0,
        price: 36960,
        coinsAvailable: 369600,
        ...overrides,
    });
}

/**
 * @param {Object} [overrides] - Fields replaced on the row
 * @returns {Object} A buy for 1 sugar that filled at placement and has not been collected
 */
export function buildFilledBuyUncollected(overrides = {}) {
    return buildPlacedListing({
        id: 900213,
        isSell: false,
        status: '/market_listing_status/filled',
        itemHrid: '/items/sugar',
        orderQuantity: 1,
        filledQuantity: 1,
        price: 45280,
        coinsAvailable: 0,
        unclaimedItemCount: 1,
        unclaimedCoinCount: 1440,
        ...overrides,
    });
}

/**
 * @param {Object} [overrides] - Fields replaced on the row
 * @returns {Object} The same buy once collected: still filled, nothing left to claim, millisecond timestamps
 */
export function buildCollectedBuy(overrides = {}) {
    return buildFilledBuyUncollected({
        unclaimedItemCount: 0,
        unclaimedCoinCount: 0,
        createdTimestamp: '2026-11-28T16:21:05.842Z',
        expirationTimestamp: '2026-12-28T16:21:05.842Z',
        ...overrides,
    });
}

/**
 * @param {Object} [overrides] - Fields replaced on the row
 * @returns {Object} A resting sugar buy that a seller then filled later (nanosecond timestamps kept)
 */
export function buildBuyFilledLater(overrides = {}) {
    return buildRestingBuy({
        status: '/market_listing_status/filled',
        orderQuantity: 10,
        filledQuantity: 10,
        coinsAvailable: 0,
        unclaimedItemCount: 10,
        ...overrides,
    });
}

/**
 * @param {Object} [overrides] - Fields replaced on the row
 * @returns {Object} The partly filled cheese buy after a cancel: `filledQuantity` kept, everything else zeroed
 */
export function buildCancelledPartlyFilledBuy(overrides = {}) {
    return buildPartlyFilledBuy({
        status: '/market_listing_status/cancelled',
        coinsAvailable: 0,
        unclaimedItemCount: 0,
        unclaimedCoinCount: 0,
        createdTimestamp: '2026-11-01T22:46:14.13Z',
        expirationTimestamp: '2026-12-01T22:46:14.13Z',
        ...overrides,
    });
}

/**
 * @param {Array<Object>} rows - Listing rows
 * @returns {Object} A `market_listings_updated` message carrying them
 */
export function buildListingsUpdated(rows) {
    return { type: 'market_listings_updated', endMarketListings: rows };
}

/**
 * @param {Object} [overrides] - Fields replaced on the message
 * @returns {Object} An order book for cheese with the player's own open remainder (6) as a bid
 */
export function buildOrderBookWithOwnBid(overrides = {}) {
    const book = buildOrderBooksUpdated();
    book.marketItemOrderBooks.orderBooks[0].asks = [
        { listingId: 900302, quantity: 1, price: 10000000000 },
        { listingId: 900303, quantity: 5, price: 1000000000000 },
    ];
    book.marketItemOrderBooks.orderBooks[0].bids = [{ listingId: BUY_ID, quantity: 6, price: 584 }];
    return { ...book, ...overrides };
}
