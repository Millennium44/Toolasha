/**
 * Tests for the market undercut alert.
 *
 * The comparison is between two things that are each re-read constantly — your
 * listings and a price cache — so the cases that matter are the ones where a
 * message would be *wrong*: a listing that is tied with the best price, an item
 * the cache knows nothing about, a figure too old to prove anything, and the
 * same undercut announced twice. The message itself is also under test, since
 * its honesty about the figure's age is a stated requirement of the feature.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { getSettingDefinition } from '../../core/settings-schema.js';
import marketAPI from '../../api/marketplace.js';

const NOW = new Date('2026-01-01T12:00:00Z').getTime();

const game = vi.hoisted(() => ({
    settings: {},
    listings: [],
    itemNames: {},
    prices: {},
    pricePatchs: {},
    lastFetchTimestamp: 0,
    dmHandlers: {},
    priceListeners: [],
    notified: [],
    // How a forced refresh behaves; default just re-notifies subscribers, as the
    // real fetch() does on success. Tests override this to reshape the snapshot.
    fetchImpl: null,
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback = false) => (key in game.settings ? game.settings[key] : fallback),
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getMarketListings: () => game.listings.map((listing) => ({ ...listing })),
        getItemDetails: (hrid) => (game.itemNames[hrid] ? { name: game.itemNames[hrid] } : null),
        on: (event, handler) => {
            game.dmHandlers[event] = handler;
        },
        off: (event, handler) => {
            if (game.dmHandlers[event] === handler) delete game.dmHandlers[event];
        },
    },
}));
vi.mock('../../api/marketplace.js', () => ({
    default: {
        CACHE_DURATION: 15 * 60 * 1000,
        get lastFetchTimestamp() {
            return game.lastFetchTimestamp;
        },
        get pricePatchs() {
            return game.pricePatchs;
        },
        getPrice: (itemHrid, enhancementLevel = 0) => game.prices[`${itemHrid}:${enhancementLevel}`] || null,
        on: (callback) => {
            game.priceListeners.push(callback);
        },
        off: (callback) => {
            game.priceListeners = game.priceListeners.filter((cb) => cb !== callback);
        },
        fetch: vi.fn((forceFetch) => game.fetchImpl(forceFetch)),
    },
}));
vi.mock('./notification-service.js', () => ({
    default: {
        notify: (key, message, options) => {
            game.notified.push({ key, message, options });
            return { fired: true, channels: ['toast'] };
        },
    },
}));

const { default: marketUndercutAlerts, MASTER_SETTING, REFRESH_SETTING } = await import('./market-undercut-alerts.js');

/** An active sell listing of yours, unless overridden */
function listing(overrides = {}) {
    return {
        id: 1,
        itemHrid: '/items/cheese',
        enhancementLevel: 0,
        price: 280000,
        isSell: true,
        status: '/market_listing_status/active',
        ...overrides,
    };
}

/** Put a dated ask/bid pair in the mocked cache */
function setPrice(itemHrid, enhancementLevel, ask, bid, ageMs = 12 * 60 * 1000) {
    game.prices[`${itemHrid}:${enhancementLevel}`] = { ask, bid };
    game.lastFetchTimestamp = NOW - ageMs;
}

const check = () => game.dmHandlers.market_listings_updated();

describe('market undercut alerts', () => {
    beforeEach(async () => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        game.settings = { [MASTER_SETTING]: true };
        game.listings = [];
        game.itemNames = { '/items/cheese': 'Cheese' };
        game.prices = {};
        game.pricePatchs = {};
        game.lastFetchTimestamp = 0;
        game.dmHandlers = {};
        game.priceListeners = [];
        game.notified = [];
        // A forced refresh, by default, just re-notifies subscribers — the real
        // fetch() calls notifyListeners() on success. Runs synchronously so a
        // faked-timer tick fully re-runs the undercut check before returning.
        game.fetchImpl = async () => {
            game.priceListeners.forEach((cb) => cb());
        };
        marketAPI.fetch.mockClear();
        marketUndercutAlerts.disable();
        await marketUndercutAlerts.initialize();
    });

    afterEach(() => {
        marketUndercutAlerts.disable();
        vi.useRealTimers();
    });

    test('the master switch off wires nothing at all', async () => {
        marketUndercutAlerts.disable();
        game.settings[MASTER_SETTING] = false;
        await marketUndercutAlerts.initialize();

        expect(game.dmHandlers.market_listings_updated).toBeUndefined();
        expect(game.dmHandlers.character_switching).toBeUndefined();
        expect(game.priceListeners).toHaveLength(0);
    });

    test('an undercut sell listing is announced with both prices and the figure age', () => {
        game.listings = [listing()];
        setPrice('/items/cheese', 0, 274000, 270000);

        check();

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toBe(
            'Cheese sell listing undercut: ask now 274K (as of ~12m ago), your listing 280K.'
        );
        expect(game.notified[0].options.title).toBe('Listing undercut');
    });

    test('a figure seconds old says so instead of claiming an age it does not have', () => {
        game.listings = [listing()];
        setPrice('/items/cheese', 0, 274000, 270000, 30 * 1000);

        check();

        expect(game.notified[0].message).toContain('(as of just now)');
    });

    test('holding the best ask is not being undercut, tied or outright', () => {
        game.listings = [listing()];
        setPrice('/items/cheese', 0, 280000, 270000);
        check();

        setPrice('/items/cheese', 0, 290000, 270000);
        check();

        expect(game.notified).toHaveLength(0);
    });

    test('an item with no cached market data is unknown, not undercut', () => {
        game.listings = [listing({ itemHrid: '/items/obscure_thing' })];

        check();

        expect(game.notified).toHaveLength(0);
    });

    test('a cached entry with no asks at all is also unknown', () => {
        game.listings = [listing()];
        setPrice('/items/cheese', 0, null, 270000);

        check();

        expect(game.notified).toHaveLength(0);
    });

    test('a figure older than the cache validity window fires nothing', () => {
        game.listings = [listing()];
        setPrice('/items/cheese', 0, 274000, 270000, 20 * 60 * 1000);

        check();

        expect(game.notified).toHaveLength(0);
    });

    test('one undercut is one message however often the same state is re-read', () => {
        game.listings = [listing()];
        setPrice('/items/cheese', 0, 274000, 270000);

        check();
        check();
        check();

        expect(game.notified).toHaveLength(1);
    });

    test('the situation resolving re-arms the listing for the next undercut', () => {
        game.listings = [listing()];
        setPrice('/items/cheese', 0, 274000, 270000);
        check();

        // The undercutter sold out; your price is best again
        setPrice('/items/cheese', 0, 280000, 270000);
        check();

        setPrice('/items/cheese', 0, 273000, 270000);
        check();

        expect(game.notified).toHaveLength(2);
    });

    test('repricing the listing re-arms it, even while still beaten', () => {
        game.listings = [listing()];
        setPrice('/items/cheese', 0, 274000, 270000);
        check();

        game.listings = [listing({ price: 275000 })];
        check();

        expect(game.notified).toHaveLength(2);
        expect(game.notified[1].message).toContain('your listing 275K');
    });

    test('a buy order below the best bid is outbid', () => {
        game.listings = [listing({ isSell: false, price: 280000 })];
        setPrice('/items/cheese', 0, 320000, 300000);

        check();

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toBe(
            'Cheese buy order outbid: bid now 300K (as of ~12m ago), your order 280K.'
        );
        expect(game.notified[0].options.title).toBe('Buy order outbid');
    });

    test('a buy order holding the best bid is silent', () => {
        game.listings = [listing({ isSell: false, price: 300000 })];
        setPrice('/items/cheese', 0, 320000, 300000);

        check();

        expect(game.notified).toHaveLength(0);
    });

    test('a listing that is no longer active has no price to defend', () => {
        game.listings = [listing({ status: '/market_listing_status/filled', unclaimedCoinCount: 100 })];
        setPrice('/items/cheese', 0, 274000, 270000);

        check();

        expect(game.notified).toHaveLength(0);
    });

    test('enhancement levels are separate markets, and named in the message', () => {
        game.listings = [listing({ itemHrid: '/items/cheese_sword', enhancementLevel: 5, price: 2000000 })];
        game.itemNames['/items/cheese_sword'] = 'Cheese Sword';
        setPrice('/items/cheese_sword', 5, 1800000, 1500000);
        // The +0 market being cheaper than your +5 listing proves nothing
        setPrice('/items/cheese_sword', 0, 100000, 90000);

        check();

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toContain('Cheese Sword +5 sell listing undercut');
        expect(game.notified[0].message).toContain('ask now 1.80M');
    });

    test('an order-book patch fresher than the API snapshot dates the figure', () => {
        game.listings = [listing()];
        // API snapshot too old to count on its own...
        setPrice('/items/cheese', 0, 274000, 270000, 20 * 60 * 1000);
        // ...but an order book seen five minutes ago carries the same figure
        game.pricePatchs['/items/cheese:0'] = { a: 274000, b: 270000, timestamp: NOW - 5 * 60 * 1000 };

        check();

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toContain('(as of ~5m ago)');
    });

    test('the event key carries the listing id, so each listing cools down on its own', () => {
        game.listings = [listing({ id: 7 }), listing({ id: 8, price: 281000 })];
        setPrice('/items/cheese', 0, 274000, 270000);

        check();

        expect(game.notified.map((entry) => entry.key)).toEqual(['market-undercut-7', 'market-undercut-8']);
    });

    test('a price update alone re-runs the comparison, without a market message', () => {
        game.listings = [listing()];
        setPrice('/items/cheese', 0, 274000, 270000);

        game.priceListeners.forEach((cb) => cb());

        expect(game.notified).toHaveLength(1);
    });

    test('the master switch is re-checked per look, not only at initialize', () => {
        game.listings = [listing()];
        setPrice('/items/cheese', 0, 274000, 270000);
        game.settings[MASTER_SETTING] = false;

        check();

        expect(game.notified).toHaveLength(0);
    });

    test('a character switch tears the listeners down and forgets every listing', () => {
        game.listings = [listing()];
        setPrice('/items/cheese', 0, 274000, 270000);
        check();

        game.dmHandlers.character_switching();

        expect(game.dmHandlers.market_listings_updated).toBeUndefined();
        expect(game.priceListeners).toHaveLength(0);
        expect(marketUndercutAlerts.listingStates.size).toBe(0);
    });

    // The active refresh is the whole point of this feature's newer half: without
    // it, nothing calls fetch() after startup, the bulk snapshot goes stale, and
    // an undercut on an item the player never opened reads as "still best". These
    // re-initialize with the refresh setting on, since the shared beforeEach wires
    // the feature up with the refresh interval unset (so no timer).
    describe('active snapshot refresh', () => {
        /** Re-wire the feature with the active refresh set to `minutes`. */
        async function initWithRefresh(minutes) {
            marketUndercutAlerts.disable();
            game.settings[REFRESH_SETTING] = minutes;
            marketAPI.fetch.mockClear();
            await marketUndercutAlerts.initialize();
        }

        test('an undercut against a stale snapshot is finally caught on the next refresh', async () => {
            // The player holds the best ask in the snapshot the script currently
            // has, and has never opened this item, so no fresher order-book patch
            // exists — the comparison must read the snapshot itself.
            game.listings = [listing()]; // sell at 280K
            setPrice('/items/cheese', 0, 285000, 270000, 5 * 60 * 1000); // 5m-old, ask above theirs
            check();
            expect(game.notified).toHaveLength(0); // reads as still-best

            await initWithRefresh(5);
            // The refreshed snapshot shows a competitor now cheaper than the listing
            game.fetchImpl = async () => {
                game.prices['/items/cheese:0'] = { ask: 274000, bid: 270000 };
                game.lastFetchTimestamp = Date.now();
                game.priceListeners.forEach((cb) => cb());
            };

            await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

            expect(marketAPI.fetch).toHaveBeenCalledWith(true);
            expect(game.notified).toHaveLength(1);
            expect(game.notified[0].message).toContain('sell listing undercut');
        });

        test('the refresh forces a whole-snapshot fetch once per interval', async () => {
            await initWithRefresh(2);

            await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
            await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

            expect(marketAPI.fetch).toHaveBeenCalledTimes(2);
            marketAPI.fetch.mock.calls.forEach((args) => expect(args[0]).toBe(true));
        });

        test('no timer runs while the feature itself is off', async () => {
            marketUndercutAlerts.disable();
            game.settings[MASTER_SETTING] = false;
            game.settings[REFRESH_SETTING] = 5;
            marketAPI.fetch.mockClear();
            await marketUndercutAlerts.initialize();

            await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

            expect(marketAPI.fetch).not.toHaveBeenCalled();
        });

        test('an interval of zero means no active refresh — the lazy cache stands', async () => {
            await initWithRefresh(0);

            await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

            expect(marketAPI.fetch).not.toHaveBeenCalled();
        });

        test('an interval at or above the 15-minute cache means no active refresh', async () => {
            await initWithRefresh(15);

            await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

            expect(marketAPI.fetch).not.toHaveBeenCalled();
        });

        test('a tick is skipped while the previous refresh is still in flight', async () => {
            let releaseFetch;
            game.fetchImpl = () =>
                new Promise((resolve) => {
                    releaseFetch = resolve;
                });
            await initWithRefresh(1);

            await vi.advanceTimersByTimeAsync(60 * 1000); // tick 1 starts, never settles
            await vi.advanceTimersByTimeAsync(60 * 1000); // tick 2 must skip the in-flight fetch

            expect(marketAPI.fetch).toHaveBeenCalledTimes(1);

            releaseFetch();
        });

        test('disable clears the refresh timer', async () => {
            await initWithRefresh(5);
            await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
            expect(marketAPI.fetch).toHaveBeenCalledTimes(1);

            marketUndercutAlerts.disable();
            await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

            expect(marketAPI.fetch).toHaveBeenCalledTimes(1); // no ticks after teardown
        });
    });
});

describe('settings schema backs the undercut alert', () => {
    test('the switch exists and is off until asked for', () => {
        const definition = getSettingDefinition(MASTER_SETTING);
        expect(definition).toBeTruthy();
        expect(definition.type).toBe('checkbox');
        expect(definition.default).toBe(false);
        expect(definition.help).toMatch(/15 minutes/i);
    });

    test('the active-refresh interval setting is a 1–15 minute number that defaults to 5', () => {
        const definition = getSettingDefinition(REFRESH_SETTING);
        expect(definition).toBeTruthy();
        expect(definition.type).toBe('number');
        expect(definition.default).toBe(5);
        expect(definition.min).toBe(1);
        expect(definition.max).toBe(15);
        // Its dependency on the undercut toggle is expressed the way the other
        // notification sub-options express theirs: named in the help text.
        expect(definition.help).toMatch(/undercut/i);
    });
});
