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
    tabs: null,
    settingCallbacks: {},
    mooket: new Map(),
    refresh: vi.fn(async () => {}),
    characterId: 'c1',
    store: {},
    storageSet: vi.fn(),
    storageGet: null,
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) =>
            hoisted.storageGet ? hoisted.storageGet(key) : (hoisted.store[key] ?? fallback),
        set: (...args) => {
            hoisted.storageSet(...args);
            hoisted.store[args[0]] = args[1];
        },
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => (key === 'market_pooledHistory' ? hoisted.pooled : hoisted.setting),
        onSettingChange: (key, fn) => {
            (hoisted.settingCallbacks[key] ||= []).push(fn);
            return () => {
                hoisted.settingCallbacks[key] = hoisted.settingCallbacks[key].filter((f) => f !== fn);
            };
        },
        Z_FLOATING_PANEL: 10000,
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getMarketListings: () => hoisted.listings,
        getCurrentCharacterId: () => hoisted.characterId,
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
vi.mock('../../utils/marketplace-tabs.js', () => ({
    navigateToMarketplace: hoisted.navigate,
    visibleTabsContainer: () => hoisted.tabs,
    insertTabInOrder: (container, tab) => container.appendChild(tab),
}));
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
        hoisted.tabs = null;
        hoisted.mooket.clear();
        hoisted.refresh.mockClear();
        hoisted.characterId = 'c1';
        hoisted.store = {};
        hoisted.storageSet.mockClear();
        hoisted.storageGet = null;
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
        expect(root().textContent).not.toContain('Your items have been overbid');
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

    it('fetches missing sightings when pooled history is turned on mid-session, with no listing event', async () => {
        hoisted.listings = [listing({ id: 1 })];
        fire();
        await vi.advanceTimersByTimeAsync(2500);
        expect(hoisted.refresh).not.toHaveBeenCalled();
        hoisted.pooled = true;
        hoisted.settingCallbacks.market_pooledHistory.forEach((fn) => fn(true));
        hoisted.settingCallbacks.market_pooledHistory.forEach((fn) => fn(true));
        await vi.advanceTimersByTimeAsync(2500);
        expect(hoisted.refresh).toHaveBeenCalledTimes(1);
    });

    it('turning pooled history off and on again asks afresh for an item already requested', async () => {
        hoisted.pooled = true;
        hoisted.listings = [listing({ id: 1 })];
        fire();
        await vi.advanceTimersByTimeAsync(2500);
        expect(hoisted.refresh).toHaveBeenCalledTimes(1);
        hoisted.pooled = false;
        hoisted.settingCallbacks.market_pooledHistory.forEach((fn) => fn(false));
        hoisted.pooled = true;
        hoisted.settingCallbacks.market_pooledHistory.forEach((fn) => fn(true));
        await vi.advanceTimersByTimeAsync(2500);
        expect(hoisted.refresh).toHaveBeenCalledTimes(2);
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

    it('an auto-hide for want of fresh evidence is not a dismissal: the same beaten listing reopens it', () => {
        hoisted.listings = [listing({ id: 1 })];
        hoisted.observations[`${CHEESE}:0:sell`] = fresh(90);
        fire();
        expect(root()).not.toBeNull();
        // The evidence expires and the panel hides itself
        delete hoisted.observations[`${CHEESE}:0:sell`];
        fire();
        expect(root()).toBeNull();
        hoisted.observations[`${CHEESE}:0:sell`] = fresh(90);
        fire();
        expect(root()).not.toBeNull();
    });

    it('a relisted item with a stale sighting, or an earlier request mark, is asked for again', async () => {
        hoisted.pooled = true;
        hoisted.listings = [listing({ id: 1 })];
        fire();
        await vi.advanceTimersByTimeAsync(2500);
        expect(hoisted.refresh).toHaveBeenCalledTimes(1);
        // The listing leaves, then the item is listed again
        hoisted.listings = [];
        fire();
        hoisted.listings = [listing({ id: 2 })];
        fire();
        await vi.advanceTimersByTimeAsync(2500);
        expect(hoisted.refresh).toHaveBeenCalledTimes(2);
        // A sighting older than the freshness window counts as missing
        hoisted.listings = [];
        fire();
        hoisted.mooket.set(`${CHEESE}:0`, { timestamp: NOW - MAX - 1000 });
        hoisted.listings = [listing({ id: 3 })];
        fire();
        await vi.advanceTimersByTimeAsync(2500);
        expect(hoisted.refresh).toHaveBeenCalledTimes(3);
        // A fresh one does not
        hoisted.listings = [];
        fire();
        hoisted.mooket.set(`${CHEESE}:0`, { timestamp: Date.now() - 1000 });
        hoisted.listings = [listing({ id: 4 })];
        fire();
        await vi.advanceTimersByTimeAsync(2500);
        expect(hoisted.refresh).toHaveBeenCalledTimes(3);
    });

    describe('hiding items', () => {
        const STORE_KEY = 'overbidPanel_hidden_c1';
        const SWORD = '/items/sword';
        const closeX = () => root().querySelector('.toolasha-minimize-btn').nextElementSibling.click();
        const hideBtn = (n = 0) => root().querySelectorAll('[data-overbid-hide]')[n];
        const toggleLine = () => root().querySelector('[data-overbid-toggle-hidden]');
        const tableRows = () => root().querySelectorAll('tbody tr');

        function beat() {
            hoisted.listings = [
                listing({ id: 1, itemHrid: SWORD, enhancementLevel: 3, price: 100 }),
                listing({ id: 2, itemHrid: SWORD, enhancementLevel: 3, price: 120 }),
                listing({ id: 3, itemHrid: SWORD, enhancementLevel: 5, price: 100 }),
                listing({ id: 4, itemHrid: SWORD, enhancementLevel: 3, isSell: false, price: 10 }),
                listing({ id: 5, itemHrid: CHEESE, price: 100 }),
            ];
            hoisted.observations[`${SWORD}:3:sell`] = fresh(90);
            hoisted.observations[`${SWORD}:5:sell`] = fresh(90);
            hoisted.observations[`${SWORD}:3:buy`] = fresh(20);
            hoisted.observations[`${CHEESE}:0:sell`] = fresh(90);
            fire();
        }

        async function withTab() {
            const container = document.createElement('div');
            const native = document.createElement('button');
            native.setAttribute('role', 'tab');
            container.appendChild(native);
            document.body.appendChild(container);
            hoisted.tabs = container;
            overbidPanel.disable();
            await overbidPanel.initialize();
            return container.querySelector.bind(container, '[data-mwi-overbid-tab="true"]');
        }

        it('hides every listing of that item, level and side, and nothing else, and persists the key', () => {
            beat();
            expect(tableRows()).toHaveLength(5);
            const control = hideBtn(0);
            expect(control.title).toBe('Hide this item from the table');
            control.click();
            // Both sell +3 sword listings go; sell +5, buy +3 and the cheese stay
            expect([...tableRows()].map((r) => r.dataset.listingId)).toEqual(['3', '4', '5']);
            expect(root().textContent).toContain('Overbid table (3, 2 hidden)');
            expect(hoisted.storageSet).toHaveBeenLastCalledWith(STORE_KEY, [`${SWORD}:3:sell`], 'settings', true);
            expect(toggleLine().textContent).toBe('Show hidden (2)');
        });

        it('Show hidden reveals dimmed rows with an unhide control, and unhide restores them', () => {
            beat();
            hideBtn(0).click();
            toggleLine().click();
            expect(toggleLine().textContent).toBe('Hide hidden');
            expect(tableRows()).toHaveLength(5);
            const dimmed = root().querySelectorAll('tr[data-overbid-hidden="true"]');
            expect(dimmed).toHaveLength(2);
            expect(dimmed[0].querySelector('[data-overbid-hide]')).toBeNull();
            dimmed[0].querySelector('[data-overbid-unhide]').click();
            expect(tableRows()).toHaveLength(5);
            expect(root().querySelectorAll('tr[data-overbid-hidden="true"]')).toHaveLength(0);
            expect(toggleLine()).toBeNull();
            expect(hoisted.storageSet).toHaveBeenLastCalledWith(STORE_KEY, [], 'settings', true);
            expect(root().querySelectorAll('[data-overbid-hide]')).toHaveLength(5);
        });

        it('hiding and toggling never close the panel or count as a dismissal', () => {
            beat();
            hideBtn(0).click();
            toggleLine().click();
            toggleLine().click();
            expect(root()).not.toBeNull();
            expect(overbidPanel.dismissed.size).toBe(0);
        });

        it('a hidden row is not part of a dismissal and does not pop the panel open', () => {
            beat();
            hideBtn(0).click();
            closeX();
            expect(root()).toBeNull();
            fire();
            expect([...overbidPanel.dismissed].sort()).toEqual([3, 4, 5]);
            // The hidden item is relisted under a new id at a new price: still hidden, still silent
            hoisted.listings = hoisted.listings.map((l) => (l.id === 1 ? { ...l, id: 9, price: 95 } : l));
            fire();
            expect(root()).toBeNull();
            // A hidden-only beaten set never opens it
            hoisted.listings = [listing({ id: 20, itemHrid: SWORD, enhancementLevel: 3, price: 100 })];
            fire();
            expect(root()).toBeNull();
        });

        it('a tab close does not dismiss hidden rows either', async () => {
            const tab = await withTab();
            beat();
            hideBtn(0).click();
            tab().click();
            expect(root()).toBeNull();
            expect(overbidPanel.dismissed.has(1)).toBe(false);
            expect(overbidPanel.dismissed.has(2)).toBe(false);
            expect(overbidPanel.dismissed.has(5)).toBe(true);
        });

        it('with every beaten row hidden an open panel stays open and offers them back', () => {
            hoisted.listings = [listing({ id: 1 }), listing({ id: 2, price: 120 })];
            hoisted.observations[`${CHEESE}:0:sell`] = fresh(90);
            fire();
            hideBtn(0).click();
            expect(root()).not.toBeNull();
            expect(root().textContent).toContain('All overbid items are hidden.');
            expect(root().textContent).not.toContain('Nothing is undercut');
            expect(root().textContent).toContain('Overbid table (0, 2 hidden)');
            fire();
            expect(root()).not.toBeNull();
            toggleLine().click();
            expect(tableRows()).toHaveLength(2);
            expect(root().textContent).not.toContain('All overbid items are hidden.');
            // Closing it and updating again keeps it closed
            closeX();
            expect(root()).toBeNull();
            fire();
            expect(root()).toBeNull();
        });

        it('show-hidden resets once no hidden row is beaten any more', () => {
            beat();
            hideBtn(0).click();
            toggleLine().click();
            expect(overbidPanel.showHidden).toBe(true);
            hoisted.observations[`${SWORD}:3:sell`] = fresh(200);
            fire();
            expect(toggleLine()).toBeNull();
            expect(overbidPanel.showHidden).toBe(false);
        });

        it('a manual open with everything hidden shows the toggle, not the nothing-beaten line', async () => {
            const tab = await withTab();
            hoisted.store[STORE_KEY] = [`${CHEESE}:0:sell`];
            await overbidPanel.loadHidden();
            hoisted.listings = [listing({ id: 1 })];
            hoisted.observations[`${CHEESE}:0:sell`] = fresh(90);
            fire();
            expect(root()).toBeNull();
            tab().click();
            expect(root().textContent).toContain('All overbid items are hidden.');
            expect(toggleLine().textContent).toBe('Show hidden (1)');
        });

        it('restores the saved keys on initialize, so a hidden item does not open the panel', async () => {
            overbidPanel.disable();
            hoisted.store[STORE_KEY] = [`${CHEESE}:0:sell`];
            hoisted.listings = [listing({ id: 1 })];
            hoisted.observations[`${CHEESE}:0:sell`] = fresh(90);
            await overbidPanel.initialize();
            expect(root()).toBeNull();
            expect(overbidPanel.hidden.has(`${CHEESE}:0:sell`)).toBe(true);
        });

        it('prunes a key at login when no active listing of that item, level and side remains', async () => {
            hoisted.store[STORE_KEY] = [`${CHEESE}:0:sell`, `${CHEESE}:0:buy`, `${SWORD}:3:sell`];
            await overbidPanel.loadHidden();
            // Cheese sell is live; cheese buy is only a filled listing; the sword is at another level
            hoisted.listings = [
                listing({ id: 1 }),
                listing({ id: 2, isSell: false, status: '/market_listing_status/filled' }),
                listing({ id: 3, itemHrid: SWORD, enhancementLevel: 4 }),
            ];
            hoisted.handlers.character_initialized.forEach((fn) => fn());
            await vi.advanceTimersByTimeAsync(0);
            expect([...overbidPanel.hidden]).toEqual([`${CHEESE}:0:sell`]);
            expect(hoisted.storageSet).toHaveBeenLastCalledWith(STORE_KEY, [`${CHEESE}:0:sell`], 'settings', true);
        });

        it('does not prune while listings are empty or not loaded, nor on a plain listings update', async () => {
            hoisted.store[STORE_KEY] = [`${CHEESE}:0:sell`];
            await overbidPanel.loadHidden();
            hoisted.listings = [];
            hoisted.handlers.character_initialized.forEach((fn) => fn());
            await vi.advanceTimersByTimeAsync(0);
            hoisted.listings = undefined;
            hoisted.handlers.character_initialized.forEach((fn) => fn());
            await vi.advanceTimersByTimeAsync(0);
            expect(overbidPanel.hidden.has(`${CHEESE}:0:sell`)).toBe(true);
            // A cancel-then-relist gap: another item is listed, the hidden one briefly is not
            hoisted.listings = [listing({ id: 7, itemHrid: SWORD })];
            fire();
            expect(overbidPanel.hidden.has(`${CHEESE}:0:sell`)).toBe(true);
            expect(hoisted.storageSet).not.toHaveBeenCalled();
        });

        it('a load that resolves after a character switch does not apply to the new character', async () => {
            overbidPanel.disable();
            let release;
            hoisted.storageGet = () => new Promise((resolve) => (release = resolve));
            const starting = overbidPanel.initialize();
            await Promise.resolve();
            overbidPanel.disable();
            hoisted.characterId = 'c2';
            release([`${CHEESE}:0:sell`]);
            await starting;
            expect(overbidPanel.hidden.size).toBe(0);
            expect(overbidPanel.hiddenOwner).toBeNull();
        });

        it('keeps each character apart and forgets the set on disable', async () => {
            beat();
            hideBtn(0).click();
            overbidPanel.disable();
            expect(overbidPanel.hidden.size).toBe(0);
            hoisted.characterId = 'c2';
            await overbidPanel.initialize();
            expect(overbidPanel.hidden.size).toBe(0);
        });

        it('caps the remembered set', () => {
            for (let i = 0; i < 205; i++) {
                overbidPanel.setHidden({ itemHrid: `/items/i${i}`, enhancementLevel: 0, isSell: true }, true);
            }
            expect(overbidPanel.hidden.size).toBe(200);
            expect(overbidPanel.hidden.has('/items/i0:0:sell')).toBe(false);
            expect(overbidPanel.hidden.has('/items/i204:0:sell')).toBe(true);
        });
    });

    describe('the Overbid tab', () => {
        function strip() {
            const container = document.createElement('div');
            const native = document.createElement('button');
            native.setAttribute('role', 'tab');
            native.innerHTML = '<span class="TabsComponent_badge__x">My Listings</span>';
            container.appendChild(native);
            document.body.appendChild(container);
            hoisted.tabs = container;
            return container;
        }
        const tab = (container) => container.querySelector('[data-mwi-overbid-tab="true"]');
        const seen = () => document.body.textContent;

        it('is added to the marketplace strip once, as a clone of a native tab', async () => {
            const container = strip();
            await overbidPanel.disable();
            await overbidPanel.initialize();
            await Promise.resolve();
            expect(tab(container)).not.toBeNull();
            expect(tab(container).textContent).toBe('Overbid');
            expect(container.querySelectorAll('[data-mwi-overbid-tab="true"]')).toHaveLength(1);
        });

        it('opens the table with a nothing-beaten line, and is not a dismissal', async () => {
            const container = strip();
            overbidPanel.disable();
            await overbidPanel.initialize();
            expect(root()).toBeNull();
            tab(container).click();
            expect(root()).not.toBeNull();
            expect(root().textContent).toContain('Nothing is undercut or outbid right now');
            // Stays open through updates while nothing is beaten
            fire();
            expect(root()).not.toBeNull();
            // The automatic pop-up still works afterwards
            root().querySelector('.toolasha-minimize-btn').nextElementSibling.click();
            expect(root()).toBeNull();
            hoisted.listings = [listing()];
            hoisted.observations[`${CHEESE}:0:sell`] = fresh(90);
            fire();
            expect(root()).not.toBeNull();
        });

        it('toggles: a second click closes it as a dismissal, a minimized panel is expanded instead', async () => {
            const container = strip();
            overbidPanel.disable();
            await overbidPanel.initialize();
            hoisted.listings = [listing()];
            hoisted.observations[`${CHEESE}:0:sell`] = fresh(90);
            fire();
            expect(root()).not.toBeNull();
            // Minimized: the tab expands it
            root().querySelector('.toolasha-minimize-btn').click();
            expect(root().dataset.minimized).toBe('true');
            tab(container).click();
            expect(root().dataset.minimized).toBe('false');
            // Open and showing: the tab closes it
            tab(container).click();
            expect(root()).toBeNull();
            // That counts as pressing X: the same beaten listing does not pop back up
            fire();
            expect(root()).toBeNull();
            // Clicking again opens it
            tab(container).click();
            expect(root()).not.toBeNull();
        });

        it('notes listings whose price data is old or missing', async () => {
            const container = strip();
            overbidPanel.disable();
            await overbidPanel.initialize();
            hoisted.listings = [listing()];
            tab(container).click();
            expect(root().textContent).toMatch(/old or missing for 1 of your listings/);
            expect(seen()).toContain('Nothing is undercut or outbid right now');
        });

        it('is removed from every strip it was added to on disable', async () => {
            const first = strip();
            overbidPanel.disable();
            await overbidPanel.initialize();
            const second = strip();
            document.body.appendChild(document.createElement('div'));
            await vi.advanceTimersByTimeAsync(100);
            expect(tab(first)).not.toBeNull();
            expect(tab(second)).not.toBeNull();
            overbidPanel.disable();
            expect(tab(first)).toBeNull();
            expect(tab(second)).toBeNull();
        });

        it('is removed on disable', async () => {
            const container = strip();
            overbidPanel.disable();
            await overbidPanel.initialize();
            expect(tab(container)).not.toBeNull();
            overbidPanel.disable();
            expect(tab(container)).toBeNull();
        });
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
