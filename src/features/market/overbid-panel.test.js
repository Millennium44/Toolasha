/** @vitest-environment happy-dom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const hoisted = vi.hoisted(() => ({
    listings: [],
    observations: {},
    handlers: {},
    marketHandlers: [],
    navigate: vi.fn(),
    setting: true,
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => hoisted.setting,
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
