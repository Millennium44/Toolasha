/** @vitest-environment happy-dom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const hoisted = vi.hoisted(() => ({
    listings: [],
    observations: {},
    handlers: {},
    marketHandlers: [],
    navigate: vi.fn(),
    setting: true,
    pooled: false,
    inFlight: false,
    mooket: new Map(),
    refresh: vi.fn(async () => {}),
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => (key === 'market_pooledHistory' ? hoisted.pooled : hoisted.setting),
        onSettingChange: vi.fn(),
        Z_FLOATING_PANEL: 10000,
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getMarketListings: () => hoisted.listings,
        getItemDetails: (hrid) => ({ name: hrid.split('/').pop() }),
        on: (event, fn) => {
            (hoisted.handlers[event] ||= []).push(fn);
        },
        off: (event, fn) => {
            hoisted.handlers[event] = (hoisted.handlers[event] || []).filter((f) => f !== fn);
        },
    },
}));
vi.mock('../../api/marketplace.js', () => ({
    default: {
        CACHE_DURATION: 15 * 60 * 1000,
        on: (fn) => hoisted.marketHandlers.push(fn),
        off: (fn) => {
            hoisted.marketHandlers = hoisted.marketHandlers.filter((f) => f !== fn);
        },
    },
}));
vi.mock('../notifications/market-undercut-alerts.js', () => ({
    default: {
        sideObservation: (hrid, level, isSell) =>
            hoisted.observations[`${hrid}:${level}:${isSell ? 'sell' : 'buy'}`] ?? null,
        mooketObservations: hoisted.mooket,
        distinctActiveItems: () => {
            const seen = new Map();
            for (const l of hoisted.listings) {
                if (l.status !== '/market_listing_status/active') continue;
                seen.set(`${l.itemHrid}:${l.enhancementLevel || 0}`, {
                    itemHrid: l.itemHrid,
                    enhancementLevel: l.enhancementLevel || 0,
                });
            }
            return [...seen.values()];
        },
        get mooketRefreshInFlight() {
            return hoisted.inFlight;
        },
        refreshMooketObservations: hoisted.refresh,
    },
}));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: hoisted.navigate }));
vi.mock('../../utils/panel-geometry.js', () => ({
    restoreGeometry: vi.fn(),
    saveGeometry: vi.fn(),
    saveOpenState: vi.fn(),
    reopenIfLeftOpen: vi.fn(),
    saveCollapsed: vi.fn(),
    wasCollapsed: vi.fn(async () => false),
    savedSize: vi.fn(async () => null),
    markPanelInteracted: vi.fn(),
    clampPanelToViewport: vi.fn(),
}));

import overbidPanel, { findBeatenListings } from './overbid-panel.js';

const ACTIVE = '/market_listing_status/active';
const CHEESE = '/items/cheese';
const NOW = 1_000_000_000;
const MAX = 15 * 60 * 1000;

function listing(over) {
    return { id: 1, status: ACTIVE, isSell: true, itemHrid: CHEESE, enhancementLevel: 0, price: 100, ...over };
}
function observe(map) {
    return (hrid, level, isSell) => map[`${hrid}:${level}:${isSell ? 'sell' : 'buy'}`] ?? null;
}
const fresh = (price) => ({ price, timestamp: NOW - 1000 });

describe('findBeatenListings', () => {
    it('flags a sell listing with a cheaper ask', () => {
        const rows = findBeatenListings([listing()], observe({ [`${CHEESE}:0:sell`]: fresh(90) }), NOW, MAX);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ itemHrid: CHEESE, isSell: true, price: 100, bestPrice: 90 });
    });

    it('flags a buy order with a higher bid, not a lower one', () => {
        const buy = listing({ isSell: false, price: 100 });
        expect(findBeatenListings([buy], observe({ [`${CHEESE}:0:buy`]: fresh(110) }), NOW, MAX)).toHaveLength(1);
        expect(findBeatenListings([buy], observe({ [`${CHEESE}:0:buy`]: fresh(90) }), NOW, MAX)).toHaveLength(0);
    });

    it('does not count a matching price, stale data or no data', () => {
        expect(findBeatenListings([listing()], observe({ [`${CHEESE}:0:sell`]: fresh(100) }), NOW, MAX)).toEqual([]);
        const stale = { price: 50, timestamp: NOW - MAX - 1 };
        expect(findBeatenListings([listing()], observe({ [`${CHEESE}:0:sell`]: stale }), NOW, MAX)).toEqual([]);
        expect(findBeatenListings([listing()], observe({}), NOW, MAX)).toEqual([]);
    });

    it('ignores listings that are not active', () => {
        const done = listing({ status: '/market_listing_status/filled' });
        expect(findBeatenListings([done], observe({ [`${CHEESE}:0:sell`]: fresh(1) }), NOW, MAX)).toEqual([]);
    });

    it('does not count a price in front of you that is your own other listing', () => {
        const mine = [listing({ id: 1, price: 100 }), listing({ id: 2, price: 90 })];
        // Best ask 90 is listing 2 itself; listing 1 is behind your own order
        const rows = findBeatenListings(mine, observe({ [`${CHEESE}:0:sell`]: fresh(90) }), NOW, MAX);
        expect(rows).toEqual([]);
        // An own listing at the same price as this one does not hide a real rival
        const same = [listing({ id: 1, price: 100 }), listing({ id: 2, price: 100 })];
        expect(findBeatenListings(same, observe({ [`${CHEESE}:0:sell`]: fresh(90) }), NOW, MAX)).toHaveLength(2);
    });

    it('keeps enhancement levels apart', () => {
        const rows = findBeatenListings(
            [listing({ id: 1, enhancementLevel: 0 }), listing({ id: 2, enhancementLevel: 5 })],
            observe({ [`${CHEESE}:5:sell`]: fresh(10) }),
            NOW,
            MAX
        );
        expect(rows.map((r) => r.id)).toEqual([2]);
        expect(rows[0].enhancementLevel).toBe(5);
        // An own listing at another level never shadows this one
        const mine = [
            listing({ id: 1, enhancementLevel: 0, price: 100 }),
            listing({ id: 2, enhancementLevel: 5, price: 5 }),
        ];
        const kept = findBeatenListings(mine, observe({ [`${CHEESE}:0:sell`]: fresh(90) }), NOW, MAX);
        expect(kept.map((r) => r.id)).toEqual([1]);
    });
});

describe('panel', () => {
    const fire = () => hoisted.handlers.market_listings_updated.forEach((fn) => fn());
    const root = () => document.getElementById('toolasha-overbidPanel-panel');

    beforeEach(async () => {
        hoisted.listings = [];
        hoisted.observations = {};
        hoisted.handlers = {};
        hoisted.marketHandlers = [];
        hoisted.navigate.mockClear();
        hoisted.pooled = false;
        hoisted.inFlight = false;
        hoisted.mooket.clear();
        hoisted.refresh.mockClear();
        document.body.innerHTML = '';
        vi.useFakeTimers();
        vi.setSystemTime(NOW);
        await overbidPanel.initialize();
    });
    afterEach(() => {
        overbidPanel.disable();
        vi.useRealTimers();
    });

    it('stays away while nothing is beaten, opens when something is, closes when resolved', () => {
        expect(root()).toBeNull();
        hoisted.listings = [listing()];
        hoisted.observations[`${CHEESE}:0:sell`] = fresh(90);
        fire();
        expect(root()).not.toBeNull();
        expect(root().textContent).toContain('Overbid table');
        expect(root().querySelectorAll('tbody tr')).toHaveLength(1);
        expect(root().textContent).toContain('Sell');
        hoisted.observations[`${CHEESE}:0:sell`] = fresh(100);
        fire();
        expect(root()).toBeNull();
    });

    it('lists only beaten rows with the enhancement level on the name', () => {
        hoisted.listings = [listing({ id: 1 }), listing({ id: 2, enhancementLevel: 3, isSell: false, price: 50 })];
        hoisted.observations[`${CHEESE}:3:buy`] = fresh(60);
        fire();
        const rows = root().querySelectorAll('tbody tr');
        expect(rows).toHaveLength(1);
        expect(rows[0].textContent).toContain('cheese +3');
        expect(rows[0].textContent).toContain('Buy');
    });

    it('clicking a name navigates with the hrid and level', () => {
        hoisted.listings = [listing({ enhancementLevel: 4 })];
        hoisted.observations[`${CHEESE}:4:sell`] = fresh(1);
        fire();
        root().querySelector('a').click();
        expect(hoisted.navigate).toHaveBeenCalledWith(CHEESE, 4);
    });

    it('minimize folds the body and survives later updates', () => {
        hoisted.listings = [listing()];
        hoisted.observations[`${CHEESE}:0:sell`] = fresh(90);
        fire();
        root().querySelector('.toolasha-minimize-btn').click();
        expect(root().dataset.minimized).toBe('true');
        fire();
        expect(root().dataset.minimized).toBe('true');
    });

    it('a dismissed panel stays away until a different listing is beaten', () => {
        hoisted.listings = [listing({ id: 1 })];
        hoisted.observations[`${CHEESE}:0:sell`] = fresh(90);
        fire();
        root().querySelector('.toolasha-minimize-btn').nextElementSibling.click();
        expect(root()).toBeNull();
        fire();
        expect(root()).toBeNull();
        hoisted.listings = [listing({ id: 1 }), listing({ id: 2, enhancementLevel: 1 })];
        hoisted.observations[`${CHEESE}:1:sell`] = fresh(1);
        fire();
        expect(root()).not.toBeNull();
    });

    it('drops a row once its figure ages past the freshness window, with no event', () => {
        hoisted.listings = [listing()];
        hoisted.observations[`${CHEESE}:0:sell`] = fresh(90);
        fire();
        expect(root()).not.toBeNull();
        vi.advanceTimersByTime(MAX + 10_000);
        expect(root()).toBeNull();
    });

    it('reads the initialized alerts through the bundle namespace when it exists', () => {
        hoisted.listings = [listing()];
        // The bundled copy knows nothing; the namespace copy holds the sighting
        window.Toolasha = {
            UI: { marketUndercutAlerts: { sideObservation: () => ({ price: 50, timestamp: Date.now() - 1000 }) } },
        };
        try {
            fire();
            expect(root()).not.toBeNull();
            expect(root().textContent).toContain('cheese');
        } finally {
            delete window.Toolasha;
        }
    });

    it('a dismissal survives a freshness gap but not fresh evidence of being competitive', () => {
        hoisted.listings = [listing({ id: 1 })];
        hoisted.observations[`${CHEESE}:0:sell`] = fresh(90);
        fire();
        root().querySelector('.toolasha-minimize-btn').nextElementSibling.click();
        expect(root()).toBeNull();
        // The figure goes unknown, then the same beaten price comes back
        delete hoisted.observations[`${CHEESE}:0:sell`];
        fire();
        hoisted.observations[`${CHEESE}:0:sell`] = fresh(90);
        fire();
        expect(root()).toBeNull();
        // Fresh evidence that it is competitive again makes the next beating news
        hoisted.observations[`${CHEESE}:0:sell`] = fresh(100);
        fire();
        hoisted.observations[`${CHEESE}:0:sell`] = fresh(90);
        fire();
        expect(root()).not.toBeNull();
    });

    it('asks the shared refresh for pooled sightings of a newly listed item, once and debounced', async () => {
        hoisted.pooled = true;
        hoisted.listings = [listing({ id: 1 })];
        fire();
        fire();
        expect(hoisted.refresh).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2500);
        expect(hoisted.refresh).toHaveBeenCalledTimes(1);
        // The same unknown item is not asked for again on later messages
        fire();
        await vi.advanceTimersByTimeAsync(2500);
        expect(hoisted.refresh).toHaveBeenCalledTimes(1);
        // A new item is
        hoisted.listings = [listing({ id: 1 }), listing({ id: 2, enhancementLevel: 2 })];
        fire();
        await vi.advanceTimersByTimeAsync(2500);
        expect(hoisted.refresh).toHaveBeenCalledTimes(2);
    });

    it('asks for no sightings unless pooled history is on, or when disabled before the debounce ends', async () => {
        hoisted.listings = [listing({ id: 1 })];
        fire();
        await vi.advanceTimersByTimeAsync(2500);
        expect(hoisted.refresh).not.toHaveBeenCalled();
        hoisted.pooled = true;
        hoisted.listings = [listing({ id: 5, enhancementLevel: 9 })];
        fire();
        overbidPanel.disable();
        await vi.advanceTimersByTimeAsync(2500);
        expect(hoisted.refresh).not.toHaveBeenCalled();
    });

    it('retries a newly listed item after a refresh that was already in flight', async () => {
        hoisted.pooled = true;
        hoisted.inFlight = true;
        hoisted.listings = [listing({ id: 1 })];
        fire();
        await vi.advanceTimersByTimeAsync(2500);
        // The running refresh cannot see the item, so nothing was started and the item is not written off
        expect(hoisted.refresh).not.toHaveBeenCalled();
        hoisted.inFlight = false;
        await vi.advanceTimersByTimeAsync(2500);
        expect(hoisted.refresh).toHaveBeenCalledTimes(1);
    });

    it('cleanup removes the panel and every subscription', () => {
        hoisted.listings = [listing()];
        hoisted.observations[`${CHEESE}:0:sell`] = fresh(90);
        fire();
        overbidPanel.disable();
        expect(root()).toBeNull();
        for (const list of Object.values(hoisted.handlers)) expect(list).toEqual([]);
        expect(hoisted.marketHandlers).toEqual([]);
    });

    it('a character switch tears it down', () => {
        hoisted.handlers.character_switching.forEach((fn) => fn());
        expect(hoisted.handlers.character_switching).toEqual([]);
        expect(hoisted.marketHandlers).toEqual([]);
    });
});
