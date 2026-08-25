/** @vitest-environment happy-dom
 *
 * Which items a bulk-sell run covers, and the rules it decides by.
 *
 * The selling itself is one game action per click and cannot be tested here.
 * What can — and what a mistake in would sell the wrong things — is the queue:
 * which source was chosen, what that source contains, and what is held back.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ items: [], details: {}, watched: [], loadouts: [] }));
const settings = vi.hoisted(() => ({}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => settings[key],
        setSetting: (key, value) => {
            settings[key] = value;
        },
        getSettingValue: (key, fallback) => settings[key] ?? fallback,
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'char',
        getInitClientData: () => ({ itemDetailMap: game.details }),
        get characterItems() {
            return game.items;
        },
    },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {}, register: () => () => {} } }));
vi.mock('../../core/storage.js', () => ({
    default: { get: async () => null, set: async () => {}, setJSON: async () => {} },
}));
vi.mock('../../api/marketplace.js', () => ({ default: { getPrice: () => ({ ask: 100, bid: 90 }) } }));
vi.mock('../inventory/custom-tabs/custom-tabs-data.js', () => ({
    loadConfig: async () => ({ tabs: [] }),
    findTab: () => null,
    collectTabItems: () => new Set(),
    collectItemsAboveTab: () => new Set(),
}));
const shortcuts = vi.hoisted(() => ({ insta: [], listing: [] }));
// A settable tradable band for the decision tests; null = no band, pass-through
const band = vi.hoisted(() => ({ value: null }));
vi.mock('../../utils/market-values.js', () => ({
    clampToBand: (price) => {
        if (typeof price !== 'number' || band.value === null) return price ?? null;
        return Math.min(Math.max(price, band.value.min), band.value.max);
    },
}));
vi.mock('./marketplace-shortcuts.js', () => ({
    default: {
        clickInstantActionButton: (label) => {
            shortcuts.insta.push(label);
            return new Promise(() => {}); // never settles — the decision is what's under test
        },
        clickListingButton: (label) => {
            shortcuts.listing.push(label);
            return new Promise(() => {});
        },
    },
}));
vi.mock('../combat/loadout-snapshot.js', () => ({
    default: { getAllSnapshots: () => game.loadouts },
}));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));
vi.mock('../../utils/dom-observer-helpers.js', () => ({
    createMutationWatcher: () => ({ start: () => {}, stop: () => {} }),
}));
// The real shape a watchlist entry has. Getting this wrong is what made the
// source read as empty while the panel showed seventy items, and a fixture that
// invents its own field cannot catch that.
vi.mock('../inventory/watchlist.js', () => ({
    watchlistEntries: () => game.watched.map((hrid) => ({ hrid, name: hrid.split('/').pop() })),
}));

const { default: bulkSell } = await import('./bulk-sell-assistant.js');

const inventory = (itemHrid, count = 5, enhancementLevel = 0) => ({
    itemHrid,
    count,
    enhancementLevel,
    itemLocationHrid: '/item_locations/inventory',
});

beforeEach(() => {
    game.details = {
        '/items/cheese': { isTradable: true },
        '/items/milk': { isTradable: true },
        '/items/sword': { isTradable: true },
        '/items/bound': { isTradable: false },
    };
    game.items = [inventory('/items/cheese'), inventory('/items/milk'), inventory('/items/sword', 1, 3)];
    game.watched = ['/items/cheese', '/items/sword'];
    bulkSell.queue = [];
    bulkSell.state = 'idle';
    bulkSell.statusNote = '';
    bulkSell.chip = null;
    bulkSell.holdProviders = new Map();
    bulkSell.selectedTabId = 'all';
    game.loadouts = [];
});

const queued = () => bulkSell.queue.map((entry) => entry.itemHrid);

describe('selling what the watchlist is tracking', () => {
    test('only the tracked items are queued', async () => {
        bulkSell.selectedTabId = 'watchlist';
        await bulkSell._start();

        expect(queued()).toContain('/items/cheese');
        expect(queued()).not.toContain('/items/milk');
    });

    test('but enhanced gear is left alone', async () => {
        // The list tracks "Gobo Defender"; matching every level of that swept a
        // +10 into the queue at six million coins. A tab names the level it
        // means, so it is trusted to mean it.
        bulkSell.selectedTabId = 'watchlist';
        await bulkSell._start();

        expect(queued()).not.toContain('/items/sword');
        expect(bulkSell.enhancedSkipped).toBe(1);
    });

    test('and a tab still sells the level it named', async () => {
        bulkSell.selectedTabId = 'all';
        await bulkSell._start();

        expect(queued()).toContain('/items/sword');
    });

    test('an empty watchlist says so rather than building an empty run', async () => {
        game.watched = [];
        bulkSell.selectedTabId = 'watchlist';
        await bulkSell._start();

        expect(bulkSell.statusNote).toBe('Nothing on the watchlist');
        expect(bulkSell.state).toBe('idle');
    });

    test('a held item is still held, whatever the source says', async () => {
        // The holds are other scripts' claims on the inventory, and a source
        // choosing an item does not overrule one
        bulkSell.holdProviders.set('reselling', () => ['/items/cheese']);
        bulkSell.selectedTabId = 'watchlist';
        await bulkSell._start();

        expect(queued()).not.toContain('/items/cheese');
        expect(bulkSell.heldCount).toBe(1);
    });

    test('and All items still means all of them', async () => {
        bulkSell.selectedTabId = 'all';
        await bulkSell._start();

        expect(queued()).toContain('/items/milk');
    });

    test('untradable items are never in scope', async () => {
        game.items.push(inventory('/items/bound'));
        game.watched.push('/items/bound');
        bulkSell.selectedTabId = 'watchlist';
        await bulkSell._start();

        expect(queued()).not.toContain('/items/bound');
    });
});

describe('the watchlist is only offered when it has something in it', () => {
    const optionValues = async () => {
        bulkSell._buildPanel();
        await bulkSell._populateTabSelect();
        return [...(bulkSell.chip?.querySelectorAll('option') || [])].map((option) => option.value);
    };

    test('offered when tracking something', async () => {
        expect(await optionValues()).toContain('watchlist');
    });

    test('and not when the list is empty, since it would build an empty run', async () => {
        game.watched = [];
        expect(await optionValues()).not.toContain('watchlist');
    });
});

describe('gear saved into a loadout', () => {
    test('is never sold, whatever the source', async () => {
        // A loadout is a claim: you are still using it, just not right now, and
        // you find out it is gone the next time you switch to that loadout
        game.loadouts = [{ equipment: [{ itemHrid: '/items/cheese', enhancementLevel: 0 }] }];
        await bulkSell._start();

        expect(queued()).not.toContain('/items/cheese');
    });

    test('at the level the loadout names, not every level of it', async () => {
        // A +10 in a loadout does not protect the +0 you keep for melting
        game.loadouts = [{ equipment: [{ itemHrid: '/items/sword', enhancementLevel: 5 }] }];
        await bulkSell._start();

        expect(queued()).toContain('/items/sword');
    });

    test('and is counted rather than silently dropped', async () => {
        game.loadouts = [{ equipment: [{ itemHrid: '/items/cheese', enhancementLevel: 0 }] }];
        await bulkSell._start();

        expect(bulkSell.heldCount).toBe(1);
        expect(bulkSell._skipNote()).toContain('loadout');
    });

    test('a loadout with nothing in it is not a problem', async () => {
        game.loadouts = [{ equipment: [] }, {}];
        await bulkSell._start();

        expect(queued().length).toBeGreaterThan(0);
    });
});

describe('the insta-vs-listing decision', () => {
    // A balanced, fresh, high-value book: none of the other three rules fire,
    // so what happens is the spread rule's doing alone
    const book = (askPrice, bidPrice) => ({
        asks: [{ price: askPrice, orderQuantity: 10, filledQuantity: 0, createdTimestamp: new Date().toISOString() }],
        bids: [{ price: bidPrice, orderQuantity: 10, filledQuantity: 0 }],
    });

    beforeEach(() => {
        shortcuts.insta.length = 0;
        shortcuts.listing.length = 0;
        settings['market_bulkSellSupplyRatio'] = 0;
        settings['market_bulkSellQueueDays'] = 0;
        settings['market_bulkSellMinListingValue'] = 0;
        settings['market_bulkSellMaxSpreadPct'] = 0;
        settings['market_bulkSellMinPatientPremium'] = 0;
        band.value = null;
        bulkSell.state = 'preparing';
        bulkSell.current = { itemHrid: '/items/cheese', enhancementLevel: 0, count: 5 };
    });

    test('with the spread rule off, a tight spread still lists', () => {
        bulkSell._decideAndOpen(book(100, 99));
        expect(bulkSell.decision.insta).toBe(false);
        expect(shortcuts.listing).toHaveLength(1);
    });

    test('a spread inside the threshold insta-sells at the bid, and says why', () => {
        settings['market_bulkSellMaxSpreadPct'] = 2;
        bulkSell._decideAndOpen(book(100, 99));
        expect(bulkSell.decision.insta).toBe(true);
        expect(bulkSell.decision.price).toBe(99);
        expect(bulkSell.decision.reason).toContain('spread 1.0%');
        expect(shortcuts.insta).toHaveLength(1);
    });

    test('a spread past the threshold lists as before', () => {
        settings['market_bulkSellMaxSpreadPct'] = 2;
        bulkSell._decideAndOpen(book(100, 90));
        expect(bulkSell.decision.insta).toBe(false);
        expect(shortcuts.listing).toHaveLength(1);
    });

    test('the boundary counts as within — "under X%" includes X itself', () => {
        settings['market_bulkSellMaxSpreadPct'] = 2;
        bulkSell._decideAndOpen(book(100, 98));
        expect(bulkSell.decision.insta).toBe(true);
    });

    test('no bids means nothing to insta into, whatever the spread rule says', () => {
        settings['market_bulkSellMaxSpreadPct'] = 50;
        bulkSell._decideAndOpen({
            asks: [{ price: 100, orderQuantity: 10, filledQuantity: 0, createdTimestamp: new Date().toISOString() }],
            bids: [],
        });
        expect(bulkSell.decision.insta).toBe(false);
        expect(shortcuts.listing).toHaveLength(1);
    });

    describe('the patient-premium rule — the same idea in coins', () => {
        test('a stack whose listing earns under the threshold insta-sells, with the premium named', () => {
            // (100 − 90) × 5 × 0.95 = 47.5 after tax
            settings['market_bulkSellMinPatientPremium'] = 100;
            bulkSell._decideAndOpen(book(100, 90));
            expect(bulkSell.decision.insta).toBe(true);
            expect(bulkSell.decision.price).toBe(90);
            expect(bulkSell.decision.reason).toContain('premium');
        });

        test('at or over the threshold it lists — the comparison is strict', () => {
            settings['market_bulkSellMinPatientPremium'] = 47.5;
            bulkSell._decideAndOpen(book(100, 90));
            expect(bulkSell.decision.insta).toBe(false);
        });

        test('a cheap-item mountain still earns its listing', () => {
            // ask 3 / bid 2 is a 33% spread, but on 100k items the wait pays
            // 95,000 after tax — coins see what a percentage cannot
            settings['market_bulkSellMinPatientPremium'] = 10_000;
            bulkSell.current = { itemHrid: '/items/cheese', enhancementLevel: 0, count: 100_000 };
            bulkSell._decideAndOpen(book(3, 2));
            expect(bulkSell.decision.insta).toBe(false);
        });

        test('an expensive single with a hairline spread is not worth a slot', () => {
            // (1,000,000 − 999,000) × 1 × 0.95 = 950
            settings['market_bulkSellMinPatientPremium'] = 5_000;
            bulkSell.current = { itemHrid: '/items/cheese', enhancementLevel: 0, count: 1 };
            bulkSell._decideAndOpen(book(1_000_000, 999_000));
            expect(bulkSell.decision.insta).toBe(true);
        });

        test('0 turns the rule off', () => {
            bulkSell._decideAndOpen(book(100, 99));
            expect(bulkSell.decision.insta).toBe(false);
        });
    });

    describe('the tradable band prices the patient side', () => {
        test('a stale above-band ask is judged at the band edge, and listed at it', () => {
            // Official value 50 → band max 55: the 100 ask could never fill,
            // so the spread that matters is 55 vs 49
            band.value = { min: 45, max: 55 };
            settings['market_bulkSellMaxSpreadPct'] = 15;
            bulkSell._decideAndOpen(book(100, 49));
            // (55 − 49) / 55 ≈ 10.9% ≤ 15% → insta; unclamped it would be 51%
            expect(bulkSell.decision.insta).toBe(true);
            expect(bulkSell.decision.reason).toContain('spread 10.9%');
        });

        test('the listing price a non-insta decision opens with is the banded ask', () => {
            band.value = { min: 45, max: 55 };
            bulkSell._decideAndOpen(book(100, 49));
            expect(bulkSell.decision.insta).toBe(false);
            expect(bulkSell.decision.price).toBe(55);
        });

        test('the insta price stays the real resting bid, wherever it sits', () => {
            // A bid above the band still pays what it says — insta fills
            // against the actual order, not against a theory of it
            band.value = { min: 45, max: 55 };
            settings['market_bulkSellMaxSpreadPct'] = 100;
            bulkSell._decideAndOpen(book(54, 60));
            expect(bulkSell.decision.insta).toBe(true);
            expect(bulkSell.decision.price).toBe(60);
        });
    });
});

describe('the cowbell bag is taxed at 18%, not 5%', () => {
    // Every sibling calculation in the codebase branches on this item; two here
    // did not, so both the vendor-vs-market and the patient-premium decisions
    // valued a bag as if it kept 95% of the sale instead of 82%.
    const COWBELL = '/items/bag_of_10_cowbells';

    beforeEach(() => {
        for (const key of Object.keys(settings)) delete settings[key];
        shortcuts.insta.length = 0;
        shortcuts.listing.length = 0;
        settings['market_bulkSellSupplyRatio'] = 0;
        settings['market_bulkSellQueueDays'] = 0;
        settings['market_bulkSellMinListingValue'] = 0;
        settings['market_bulkSellMaxSpreadPct'] = 0;
        settings['market_bulkSellMinPatientPremium'] = 0;
        band.value = null;
        bulkSell.state = 'preparing';
    });

    describe('the vendor comparison', () => {
        beforeEach(() => {
            settings['market_bulkSellVendorCheck'] = true;
            game.details = {
                '/items/cheese': { name: 'Cheese', sellPrice: 85 },
                [COWBELL]: { name: 'Bag Of 10 Cowbells', sellPrice: 85 },
            };
        });

        test('an ordinary item nets 95% of the ask, so an 85 vendor loses', () => {
            bulkSell.current = { itemHrid: '/items/cheese', enhancementLevel: 0, count: 1 };
            const open = vi.spyOn(bulkSell, '_openVendorSell').mockReturnValue(true);

            expect(bulkSell._tryVendorSell()).toBe(false);
            expect(open).not.toHaveBeenCalled();
            open.mockRestore();
        });

        test('a bag of cowbells nets 82%, so the same 85 vendor wins', () => {
            bulkSell.current = { itemHrid: COWBELL, enhancementLevel: 0, count: 1 };
            const open = vi.spyOn(bulkSell, '_openVendorSell').mockReturnValue(true);

            expect(bulkSell._tryVendorSell()).toBe(true);
            expect(open).toHaveBeenCalledWith(85, 82);
            open.mockRestore();
        });
    });

    describe('the patient premium', () => {
        const book = (askPrice, bidPrice) => ({
            asks: [
                { price: askPrice, orderQuantity: 10, filledQuantity: 0, createdTimestamp: new Date().toISOString() },
            ],
            bids: [{ price: bidPrice, orderQuantity: 10, filledQuantity: 0 }],
        });

        test('waiting on a bag earns 18% less, and can fall under the threshold', () => {
            // (100 − 90) × 5 = 50 gross. Cheese keeps 47.5, a bag keeps 41.
            settings['market_bulkSellMinPatientPremium'] = 45;

            bulkSell.current = { itemHrid: '/items/cheese', enhancementLevel: 0, count: 5 };
            bulkSell._decideAndOpen(book(100, 90));
            expect(bulkSell.decision.insta).toBe(false);

            bulkSell.current = { itemHrid: COWBELL, enhancementLevel: 0, count: 5 };
            bulkSell._decideAndOpen(book(100, 90));
            expect(bulkSell.decision.insta).toBe(true);
        });
    });
});

describe('watching for the modal to close', () => {
    test('a second watch does not leave the first poller running', () => {
        vi.useFakeTimers();
        try {
            const cleared = vi.spyOn(globalThis, 'clearInterval');
            bulkSell.modalPoll = null;
            bulkSell.state = 'awaiting_confirm';

            bulkSell._watchClose();
            const first = bulkSell.modalPoll;
            bulkSell._watchClose();

            expect(cleared).toHaveBeenCalledWith(first);
            expect(bulkSell.modalPoll).not.toBe(first);

            clearInterval(bulkSell.modalPoll);
            bulkSell.modalPoll = null;
            cleared.mockRestore();
        } finally {
            vi.useRealTimers();
        }
    });
});
