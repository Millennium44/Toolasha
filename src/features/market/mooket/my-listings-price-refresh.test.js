/** @vitest-environment happy-dom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const api = vi.hoisted(() => ({
    updatePrice: vi.fn(),
    dataAge: 60 * 60 * 1000,
    rows: [],
    cooldownMs: 0,
    enabled: true,
    characterId: 'char-a',
    sourceKey: 'mooket2',
    liveSourced: false,
    fetchHistory: vi.fn(),
}));

vi.mock('../../../core/config.js', () => ({ default: { getSetting: () => api.enabled, onSettingChange: () => {} } }));
vi.mock('../../../core/data-manager.js', () => ({
    default: {
        getMarketListings: () => [],
        get currentCharacterId() {
            return api.characterId;
        },
    },
}));
vi.mock('../../../core/dom-observer.js', () => ({
    default: { register: () => () => {}, onClass: () => () => {}, onReady: () => () => {} },
}));
vi.mock('../../../api/marketplace.js', () => ({
    default: {
        updatePrice: (...args) => api.updatePrice(...args),
        getPrice: () => ({ ask: 999, bid: 888 }),
        getDataAge: () => api.dataAge,
        get liveSourced() {
            return api.liveSourced;
        },
    },
}));
vi.mock('./market-history-api.js', () => ({
    default: {
        fetchHistory: (...args) => api.fetchHistory(...args),
        currentSource: () => ({ key: api.sourceKey }),
        cooldownRemainingMs: () => api.cooldownMs,
    },
}));

import myListingsPriceRefresh, { shouldApplySighting, distinctListedItems } from './my-listings-price-refresh.js';

beforeEach(() => {
    api.enabled = true;
    api.characterId = 'char-a';
    api.sourceKey = 'mooket2';
    api.liveSourced = false;
    api.dataAge = 60 * 60 * 1000;
    api.rows = [];
    api.cooldownMs = 0;
    api.updatePrice.mockClear();
    api.fetchHistory.mockReset().mockImplementation(async () => api.rows);
    myListingsPriceRefresh.initialize();
});

afterEach(() => {
    myListingsPriceRefresh.cleanup();
    document.body.innerHTML = '';
});

describe('shouldApplySighting', () => {
    it('applies a sighting that is strictly newer than the snapshot', () => {
        expect(shouldApplySighting(2000, 1000)).toBe(true);
    });

    it('leaves an equal or older sighting alone — not a refresh', () => {
        expect(shouldApplySighting(1000, 1000)).toBe(false);
        expect(shouldApplySighting(500, 1000)).toBe(false);
    });

    it('applies any sighting when there is no snapshot to protect', () => {
        expect(shouldApplySighting(1234, null)).toBe(true);
    });

    it('rejects an unusable sighting time', () => {
        expect(shouldApplySighting(0, null)).toBe(false);
        expect(shouldApplySighting(-5, null)).toBe(false);
        expect(shouldApplySighting(NaN, 1000)).toBe(false);
    });
});

describe('distinctListedItems', () => {
    // A minimal stand-in for a table row: a use[href] icon and an optional badge
    const makeRow = (iconId, level) => ({
        querySelectorAll: (sel) => (sel === 'use' ? [{ href: { baseVal: `sprite.svg#${iconId}` } }] : []),
        querySelector: (sel) => (sel.includes('enhancementLevel') && level ? { textContent: `+${level}` } : null),
    });

    it('reads the item hrid and enhancement level off a row', () => {
        expect(distinctListedItems([makeRow('cheese', 0)])).toEqual([
            { itemHrid: '/items/cheese', enhancementLevel: 0 },
        ]);
        expect(distinctListedItems([makeRow('sword', 7)])).toEqual([{ itemHrid: '/items/sword', enhancementLevel: 7 }]);
    });

    it('dedupes by item and enhancement level, keeping levels distinct', () => {
        const rows = [makeRow('cheese', 0), makeRow('cheese', 0), makeRow('cheese', 5)];
        expect(distinctListedItems(rows)).toEqual([
            { itemHrid: '/items/cheese', enhancementLevel: 0 },
            { itemHrid: '/items/cheese', enhancementLevel: 5 },
        ]);
    });

    it('skips a coin icon (the price column) and rows with no item icon', () => {
        const coinRow = makeRow('coin', 0);
        const emptyRow = { querySelectorAll: () => [], querySelector: () => null };
        expect(distinctListedItems([coinRow, emptyRow])).toEqual([]);
    });
});

describe('a Mooket sighting is patched in at the time it was seen', () => {
    beforeEach(() => {
        api.updatePrice.mockClear();
    });

    it('passes the sighting’s own time through rather than letting it read as now', async () => {
        // Stamped `Date.now()`, a sighting nearly an hour old printed as "as of
        // just now" and outranked genuinely fresher figures downstream
        const seenAt = Date.now() - 45 * 60 * 1000;
        api.rows = [{ time: Math.floor(seenAt / 1000), a: 120, b: 100 }];
        // The game's own snapshot is older still, so the sighting does apply
        api.dataAge = 55 * 60 * 1000;

        myListingsPriceRefresh.gatherListedItems = () => [{ itemHrid: '/items/cheese', enhancementLevel: 0 }];
        await myListingsPriceRefresh.runRefresh();

        expect(api.updatePrice).toHaveBeenCalledTimes(1);
        const [, , ask, bid, observedAt] = api.updatePrice.mock.calls[0];
        expect(ask).toBe(120);
        expect(bid).toBe(100);
        expect(observedAt).toBe(Math.floor(seenAt / 1000) * 1000);
    });
});

describe('the status line says when the pool was backed off', () => {
    // "Updated 0 of 40 from Mooket." during a cool-down reads as "checked them
    // all, nothing was fresher" — the honest story is "gave up partway
    // through, ask again shortly." The two must not read the same.
    beforeEach(() => {
        api.updatePrice.mockClear();
        api.rows = [];
        api.cooldownMs = 0;
        myListingsPriceRefresh.status = { textContent: '' };
        myListingsPriceRefresh.gatherListedItems = () => [{ itemHrid: '/items/cheese', enhancementLevel: 0 }];
    });

    it('says nothing extra when the pool is not backed off', async () => {
        await myListingsPriceRefresh.runRefresh();
        expect(myListingsPriceRefresh.status.textContent).toBe('Updated 0 of 1 from Mooket.');
    });

    it('names the back-off, with roughly how long is left, when it is active', async () => {
        api.cooldownMs = 4 * 60 * 1000 + 10_000; // ~4m
        await myListingsPriceRefresh.runRefresh();

        expect(myListingsPriceRefresh.status.textContent).toBe(
            'Updated 0 of 1 from Mooket. The shared price-history server is busy; retrying in ~4m.'
        );
    });
});

describe('refresh ownership', () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ itemHrid: `/items/item_${i}`, enhancementLevel: i }));
    const freshRows = () => [{ time: Math.floor(Date.now() / 1000) - 60, a: 120, b: 100 }];
    const deferred = () => {
        let resolve;
        const promise = new Promise((done) => {
            resolve = done;
        });
        return { promise, resolve };
    };

    it('stops queued requests and ignores in-flight prices after cleanup', async () => {
        const pending = deferred();
        api.fetchHistory.mockReturnValue(pending.promise);
        myListingsPriceRefresh.gatherListedItems = () => items;
        const refresh = myListingsPriceRefresh.runRefresh();
        expect(api.fetchHistory).toHaveBeenCalledTimes(4);

        myListingsPriceRefresh.cleanup();
        pending.resolve(freshRows());
        await refresh;

        expect(api.fetchHistory).toHaveBeenCalledTimes(4);
        expect(api.updatePrice).not.toHaveBeenCalled();
        expect(myListingsPriceRefresh.busy).toBe(false);
    });

    it('does not let an old run release or relabel the replacement run after re-enable', async () => {
        const old = deferred();
        const next = deferred();
        api.fetchHistory.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
        myListingsPriceRefresh.gatherListedItems = () => [items[0]];
        const oldRun = myListingsPriceRefresh.runRefresh();
        myListingsPriceRefresh.cleanup();
        myListingsPriceRefresh.initialize();
        myListingsPriceRefresh.status = { textContent: '' };
        myListingsPriceRefresh.gatherListedItems = () => [items[1]];
        const newRun = myListingsPriceRefresh.runRefresh();

        old.resolve(freshRows());
        await oldRun;
        expect(api.updatePrice).not.toHaveBeenCalled();
        expect(myListingsPriceRefresh.busy).toBe(true);
        expect(myListingsPriceRefresh.status.textContent).toBe('');

        next.resolve(freshRows());
        await newRun;
        expect(api.updatePrice).toHaveBeenCalledExactlyOnceWith('/items/item_1', 1, 120, 100, expect.any(Number));
        expect(myListingsPriceRefresh.busy).toBe(false);
        expect(myListingsPriceRefresh.status.textContent).toBe('Updated 1 of 1 from Mooket.');
    });

    it.each([
        [
            'setting',
            () => {
                api.enabled = false;
            },
        ],
        [
            'character',
            () => {
                api.characterId = 'char-b';
            },
        ],
        [
            'history source',
            () => {
                api.sourceKey = 'mooket1';
            },
        ],
        [
            'market economy',
            () => {
                api.liveSourced = true;
            },
        ],
    ])('cancels before patching or dequeuing after a changed %s', async (_label, changeContext) => {
        const pending = deferred();
        api.fetchHistory.mockReturnValue(pending.promise);
        myListingsPriceRefresh.status = { textContent: '' };
        myListingsPriceRefresh.gatherListedItems = () => items;
        const refresh = myListingsPriceRefresh.runRefresh();
        changeContext();
        pending.resolve(freshRows());
        await refresh;

        expect(api.fetchHistory).toHaveBeenCalledTimes(4);
        expect(api.updatePrice).not.toHaveBeenCalled();
        expect(myListingsPriceRefresh.busy).toBe(false);
        expect(myListingsPriceRefresh.status.textContent).toBe('Refresh canceled. Try again.');
    });

    it('does not start requests from a detached button after cleanup', async () => {
        myListingsPriceRefresh.gatherListedItems = () => items;
        myListingsPriceRefresh.cleanup();
        await myListingsPriceRefresh.runRefresh();
        expect(api.fetchHistory).not.toHaveBeenCalled();
    });

    it('keeps the replacement header button disabled while the refresh runs', async () => {
        document.body.innerHTML = '<div class="MarketplacePanel_listingCount"></div>';
        myListingsPriceRefresh.ensureControls();
        const pending = deferred();
        api.fetchHistory.mockReturnValue(pending.promise);
        myListingsPriceRefresh.gatherListedItems = () => [items[0]];
        const refresh = myListingsPriceRefresh.runRefresh();
        document.body.innerHTML = '<div class="MarketplacePanel_listingCount"></div>';
        myListingsPriceRefresh.ensureControls();
        expect(myListingsPriceRefresh.button.disabled).toBe(true);
        expect(myListingsPriceRefresh.button.textContent).toBe('Refreshing…');
        pending.resolve(freshRows());
        await refresh;
        expect(myListingsPriceRefresh.button.disabled).toBe(false);
    });
});
