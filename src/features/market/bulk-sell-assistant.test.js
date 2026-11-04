/** @vitest-environment happy-dom
 *
 * Which items a bulk-sell run covers, and the rules it decides by.
 *
 * The selling itself is one game action per click and cannot be tested here.
 * What can — and what a mistake in would sell the wrong things — is the queue:
 * which source was chosen, what that source contains, and what is held back.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { _resetGameNumberSeparators } from '../../utils/number-parser.js';

const game = vi.hoisted(() => ({
    items: [],
    details: {},
    watched: [],
    loadouts: [],
    characterId: 'char',
    tabsByCharacter: {},
    loadoutsReady: true,
    readyWaiters: [],
    // `itemHrid:enhancementLevel` keys the Locked-item tests mark; empty by default,
    // which matches a server that has not shipped item marks
    locked: new Set(),
    // Same keys, for items marked Favorite
    favorite: new Set(),
}));
/** The settings store, so a per-character key can be proved to be per character */
const store = vi.hoisted(() => ({ data: {} }));
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
        getCurrentCharacterId: () => game.characterId,
        getInitClientData: () => ({ itemDetailMap: game.details }),
        get characterItems() {
            return game.items;
        },
        isItemLocked: (itemHrid, enhancementLevel = 0) => game.locked.has(`${itemHrid}:${enhancementLevel}`),
        isItemFavorite: (itemHrid, enhancementLevel = 0) => game.favorite.has(`${itemHrid}:${enhancementLevel}`),
    },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {}, register: () => () => {} } }));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback = null) => store.data[key] ?? fallback,
        set: async (key, value) => {
            store.data[key] = value;
        },
        setJSON: async () => {},
    },
}));
vi.mock('../../api/marketplace.js', () => ({ default: { getPrice: () => ({ ask: 100, bid: 90 }) } }));
vi.mock('../inventory/custom-tabs/custom-tabs-data.js', () => ({
    // Keyed by character: an inventory tab config belongs to one character,
    // which is the whole reason the remembered tab id has to as well
    loadConfig: async (charId) => ({ tabs: game.tabsByCharacter[charId] || [] }),
    findTab: () => null,
    collectTabItems: () => new Set(),
    collectItemsAboveTab: () => new Set(),
}));
const shortcuts = vi.hoisted(() => ({ insta: [], listing: [], calls: [] }));
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
        clickInstantActionButton: (label, _timeout, isCancelled) => {
            shortcuts.insta.push(label);
            // Never settles unless a test settles it — the decision is what's under test
            return new Promise((resolve, reject) => shortcuts.calls.push({ label, isCancelled, resolve, reject }));
        },
        clickListingButton: (label, _class, _timeout, isCancelled) => {
            shortcuts.listing.push(label);
            return new Promise((resolve, reject) => shortcuts.calls.push({ label, isCancelled, resolve, reject }));
        },
        // The real finder's primary path, which is the row the game renders and
        // the one the assistant's own prefill writes into
        findQuantityInput: (modal) => modal.querySelector('div[class*="MarketplacePanel_quantityInputs"] input'),
    },
}));
vi.mock('../combat/loadout-snapshot.js', () => ({
    default: {
        // Faithful to the real store: with the feature switched off nothing
        // ever loads it from storage, so it reports no loadouts at all — which
        // from the outside is indistinguishable from a character who has none
        getAllSnapshots: () => (settings['loadoutSnapshot'] ? game.loadouts : []),
        // The real store fills from storage asynchronously; a run that reads it
        // before it has sees no loadouts at all
        whenReady: () => (game.loadoutsReady ? Promise.resolve(true) : new Promise((r) => game.readyWaiters.push(r))),
    },
}));
/** Every order-book navigation the run asked for — each one is a game request */
const navigations = vi.hoisted(() => []);
vi.mock('../../utils/marketplace-tabs.js', () => ({
    navigateToMarketplace: (itemHrid) => navigations.push(itemHrid),
    insertTabInOrder: (container, tab) => container?.appendChild(tab),
}));
vi.mock('../../utils/dom-observer-helpers.js', () => ({
    createMutationWatcher: () => ({ start: () => {}, stop: () => {} }),
}));
// The real shape a watchlist entry has. Getting this wrong is what made the
// source read as empty while the panel showed seventy items, and a fixture that
// invents its own field cannot catch that.
vi.mock('../inventory/watchlist.js', () => ({
    watchlistEntries: () => game.watched.map((hrid) => ({ hrid, name: hrid.split('/').pop() })),
}));

// The vendor confirm goes through the game's React handler; here it still clicks, so the counts hold
const reactClicks = vi.hoisted(() => ({ calls: [] }));
vi.mock('../../utils/react-click.js', () => ({
    clickThroughReact: (element, options) => {
        reactClicks.calls.push({ element, options });
        element.click();
        return 'dom';
    },
}));

// Server notices: the test drives the handler by hand (fixture shaped from the game's handler code)
const notices = vi.hoisted(() => ({ handler: null, unsubs: 0 }));
vi.mock('../../utils/server-notices.js', () => ({
    SALE_REFUSAL_KEYS: [
        'errorNotification.itemIsLocked',
        'errorNotification.orderNotFulfilled',
        'errorNotification.maxListingsPerItem',
        'errorNotification.requestSpamProtection',
    ],
    onServerNotice: (handler) => {
        notices.handler = handler;
        return () => {
            notices.unsubs += 1;
            if (notices.handler === handler) notices.handler = null;
        };
    },
}));

const { default: bulkSell } = await import('./bulk-sell-assistant.js');

const inventory = (itemHrid, count = 5, enhancementLevel = 0) => ({
    itemHrid,
    count,
    enhancementLevel,
    itemLocationHrid: '/item_locations/inventory',
});

beforeEach(() => {
    // The Loadout Snapshot feature is what fills the store the hold list reads;
    // on is the case every test but the "switched off" one is about
    settings['loadoutSnapshot'] = true;
    settings['market_bulkSellHoldFavorites'] = true;
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
    game.favorite = new Set();
    game.loadoutsReady = true;
    game.readyWaiters = [];
    game.characterId = 'char';
    game.tabsByCharacter = {};
    game.locked.clear();
    store.data = {};
    bulkSell._tabPrefLoaded = false;
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
        // The held stack carries the default 5, and heldCount reports the
        // quantity held, not the number of stacks
        expect(bulkSell.heldCount).toBe(5);
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

describe('Locked items are never queued', () => {
    test('a locked item at its locked level is skipped, and counted', async () => {
        game.locked.add('/items/milk:0');
        bulkSell.selectedTabId = 'all';
        await bulkSell._start();

        expect(queued()).not.toContain('/items/milk');
        expect(queued()).toContain('/items/cheese');
        expect(bulkSell.lockedSkipped).toBe(5); // inventory() defaults to count 5
    });

    test('an all-levels lock (min 0, max 1000) skips every level of the item', async () => {
        game.items.push(inventory('/items/milk', 3, 7));
        game.locked.add('/items/milk:0');
        game.locked.add('/items/milk:7');
        bulkSell.selectedTabId = 'all';
        await bulkSell._start();

        expect(queued()).not.toContain('/items/milk');
    });

    test('a single-level lock leaves the other levels sellable', async () => {
        game.items.push(inventory('/items/milk', 3, 7));
        game.locked.add('/items/milk:0'); // only the +0 stack is locked
        bulkSell.selectedTabId = 'all';
        await bulkSell._start();

        // The +0 stack is held out, but the +7 stack of the same item still queues
        const milkEntries = bulkSell.queue.filter((entry) => entry.itemHrid === '/items/milk');
        expect(milkEntries).toHaveLength(1);
        expect(milkEntries[0].enhancementLevel).toBe(7);
    });

    test('no marks at all is unchanged from today — nothing is skipped as locked', async () => {
        bulkSell.selectedTabId = 'all';
        await bulkSell._start();

        expect(queued()).toEqual(expect.arrayContaining(['/items/cheese', '/items/milk', '/items/sword']));
        expect(bulkSell.lockedSkipped).toBe(0);
    });

    test('a locked stack outside the selected source is not counted as skipped', async () => {
        // /items/milk is locked, but the watchlist (game.watched) never names it — the
        // watchlist run was never going to queue it regardless of the lock, so it must
        // not show up as "N locked items skipped" for a run that never looked at it
        game.locked.add('/items/milk:0');
        bulkSell.selectedTabId = 'watchlist';
        await bulkSell._start();

        expect(queued()).not.toContain('/items/milk');
        expect(bulkSell.lockedSkipped).toBe(0);
    });
});

/**
 * A lock landing after the queue was already built.
 *
 * `_start`'s filter is a one-time snapshot of inventory; a player who locks an
 * item mid-run needs it checked again — once right before a step would open a
 * sell form (`_prepareCurrent`), and again right before Confirm would press
 * the game's own button (`_onConfirmClick`), since the two moments can be
 * seconds apart with a modal sitting open in between.
 */
describe('each step sells the stack as it stands now', () => {
    beforeEach(() => {
        bulkSell._stop('');
    });
    afterEach(() => {
        bulkSell._stop('');
        game.items = [];
    });

    test('a stack that grew since the queue was built is sold whole', () => {
        bulkSell.queue = [{ itemHrid: '/items/cheese', enhancementLevel: 0, count: 18, name: 'Cheese' }];
        bulkSell.index = 0;
        game.items = [{ itemHrid: '/items/cheese', itemLocationHrid: '/item_locations/inventory', count: 25 }];

        bulkSell._prepareCurrent();

        expect(bulkSell.current.count).toBe(25);
        expect(bulkSell.state).toBe('preparing');
    });

    test('a stack that is gone is skipped, not offered for sale', () => {
        bulkSell.queue = [
            { itemHrid: '/items/cheese', enhancementLevel: 0, count: 18, name: 'Cheese' },
            { itemHrid: '/items/milk', enhancementLevel: 0, count: 4, name: 'Milk' },
        ];
        bulkSell.index = 0;
        game.items = [{ itemHrid: '/items/milk', itemLocationHrid: '/item_locations/inventory', count: 4 }];

        bulkSell._prepareCurrent();

        // Skipped before any navigation or sell form: the step moves on and nothing waits on a book
        expect(bulkSell.index).toBe(1);
        expect(bulkSell.statusNote).toBe('no longer in inventory');
        expect(bulkSell.bookTimeout).toBeNull();
    });
});

describe('a lock landing mid-run is caught again, not just at the queue build', () => {
    // A run the previous suite started and left open is not this suite's
    beforeEach(() => {
        bulkSell._stop('');
    });
    afterEach(() => {
        bulkSell._stop('');
    });

    test('_prepareCurrent skips a step whose item was locked after the queue was built', () => {
        bulkSell.queue = [
            { itemHrid: '/items/cheese', enhancementLevel: 0, count: 18, name: 'Cheese' },
            { itemHrid: '/items/milk', enhancementLevel: 0, count: 4, name: 'Milk' },
        ];
        bulkSell.index = 0;
        bulkSell.lockedSkipped = 0;
        game.locked.add('/items/cheese:0');

        bulkSell._prepareCurrent();

        // Counted the same way the queue-build filter counts one it finds locked
        // up front, and the step is skipped without ever opening a sell form
        expect(bulkSell.lockedSkipped).toBe(18);
        expect(bulkSell.bookTimeout).toBeNull();
        expect(bulkSell.index).toBe(1);
    });

    test('a step whose item is still unlocked is prepared as usual', () => {
        bulkSell.queue = [{ itemHrid: '/items/cheese', enhancementLevel: 0, count: 18, name: 'Cheese' }];
        bulkSell.index = 0;
        bulkSell.lockedSkipped = 0;

        bulkSell._prepareCurrent();

        expect(bulkSell.lockedSkipped).toBe(0);
        // The order-book wait was armed — this step went on to the market path
        expect(bulkSell.bookTimeout).not.toBeNull();
        expect(bulkSell.index).toBe(0);
    });

    test('_onConfirmClick skips without pressing the game button when a lock lands in the gap before Confirm', () => {
        bulkSell.queue = [{ itemHrid: '/items/cheese', enhancementLevel: 0, count: 18, name: 'Cheese' }];
        bulkSell.index = 0;
        bulkSell.current = bulkSell.queue[0];
        bulkSell.lockedSkipped = 0;
        bulkSell.decision = { insta: true, price: 100, avgPrice: 100, reason: 'queue ok' };
        bulkSell.state = 'awaiting_confirm';
        bulkSell._confirmedStep = null;

        game.locked.add('/items/cheese:0');
        bulkSell._onConfirmClick();

        expect(bulkSell.lockedSkipped).toBe(18);
        // The step advanced through the skip path, not through a press the
        // server would have rejected
        expect(bulkSell.index).toBe(1);
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

describe('consumables saved into a loadout, and Favorite items', () => {
    beforeEach(() => {
        settings['market_bulkSellHoldFavorites'] = true;
        game.details['/items/bread'] = { isTradable: true };
        game.details['/items/coffee'] = { isTradable: true };
        game.details['/items/trinket'] = { isTradable: true };
        game.items = [
            inventory('/items/bread'),
            inventory('/items/coffee'),
            inventory('/items/trinket', 1, 3),
            inventory('/items/milk'),
        ];
        bulkSell.selectedTabId = 'all';
    });

    test('a loadout food is held', async () => {
        game.loadouts = [{ name: 'Mage', food: [{ itemHrid: '/items/bread' }, { itemHrid: '' }], drinks: [] }];
        await bulkSell._start();
        expect(queued()).not.toContain('/items/bread');
        expect(bulkSell._skipNote()).toContain('Mage');
    });

    test('a loadout drink is held', async () => {
        game.loadouts = [{ name: 'Mage', food: [], drinks: [{ itemHrid: '/items/coffee' }] }];
        await bulkSell._start();
        expect(queued()).not.toContain('/items/coffee');
    });

    test('a Favorite item is held and said so', async () => {
        game.favorite = new Set(['/items/milk:0']);
        await bulkSell._start();
        expect(queued()).not.toContain('/items/milk');
        expect(bulkSell.favoriteSkipped).toBe(5);
        expect(bulkSell._skipNote()).toContain('Favorite');
    });

    test('with the setting off a Favorite item sells and nothing is counted as Favorite', async () => {
        settings['market_bulkSellHoldFavorites'] = false;
        game.favorite = new Set(['/items/milk:0']);
        await bulkSell._start();
        expect(queued()).toContain('/items/milk');
        expect(bulkSell.favoriteSkipped).toBe(0);
        expect(bulkSell._skipNote()).not.toContain('Favorite');
    });

    test('with the setting off a loadout food is still held', async () => {
        settings['market_bulkSellHoldFavorites'] = false;
        game.loadouts = [{ name: 'Mage', food: [{ itemHrid: '/items/bread' }], drinks: [] }];
        await bulkSell._start();
        expect(queued()).not.toContain('/items/bread');
    });

    test('an unrelated item still sells', async () => {
        game.loadouts = [{ name: 'Mage', food: [{ itemHrid: '/items/bread' }], drinks: [] }];
        game.favorite = new Set(['/items/milk:0']);
        await bulkSell._start();
        expect(queued()).toContain('/items/coffee');
    });

    test('three loadouts sharing a consumable hold it once, naming each', async () => {
        game.loadouts = ['A', 'B', 'C'].map((name) => ({ name, food: [{ itemHrid: '/items/bread' }], drinks: [] }));
        await bulkSell._start();
        expect(queued()).not.toContain('/items/bread');
        expect(bulkSell.heldCount).toBe(5);
        expect(bulkSell._skipNote()).toContain('A, B, C');
    });

    test('a Favorite at a nonzero level holds that level only', async () => {
        game.favorite = new Set(['/items/trinket:3']);
        await bulkSell._start();
        expect(queued()).not.toContain('/items/trinket');
        game.items = [inventory('/items/trinket', 1, 0)];
        await bulkSell._start();
        expect(queued()).toContain('/items/trinket');
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

        expect(bulkSell.heldCount).toBe(5);
        expect(bulkSell._skipNote()).toContain('loadout');
    });

    test('is waited for rather than read while the store is still empty', async () => {
        // The snapshot store fills from storage after the feature initializes.
        // Start pressed in that window used to read an empty {} as "no
        // loadouts" and queue the sword the loadout is wearing — reporting
        // "0 held back" while it did it.
        game.loadoutsReady = false;
        game.loadouts = [];
        const run = bulkSell._start();

        // The store finishes loading while Start is still resolving
        game.loadouts = [{ equipment: [{ itemHrid: '/items/sword', enhancementLevel: 3 }] }];
        for (const resolve of game.readyWaiters) resolve(true);
        game.readyWaiters = [];
        await run;

        expect(queued()).not.toContain('/items/sword');
        expect(bulkSell.heldCount).toBe(1);
    });

    /*
     * With Loadout Snapshot switched off nothing ever fills the snapshot store,
     * so the hold list comes back empty — indistinguishable, from the strip,
     * from a character who has no loadouts. Saying nothing (or "0 held back")
     * asserts a comparison that never ran. Same class as a claim fixed
     * elsewhere this round.
     */
    test('is not checked at all when Loadout Snapshot is off, and the strip says so', async () => {
        settings['loadoutSnapshot'] = false;
        game.loadouts = [{ equipment: [{ itemHrid: '/items/cheese', enhancementLevel: 0 }] }];
        await bulkSell._start();

        expect(bulkSell._skipNote({ bare: true })).toContain('loadouts not checked');
        // And the reason the count is what it is, is not claimed to be a loadout
        expect(bulkSell._skipNote({ bare: true })).not.toContain('in a loadout');
    });

    test('is checked, and reported as zero, when it is on and there are no loadouts', async () => {
        game.loadouts = [];
        await bulkSell._start();

        expect(bulkSell.heldCount).toBe(0);
        expect(bulkSell._skipNote({ bare: true })).not.toContain('not checked');
    });

    test('a loadout with nothing in it is not a problem', async () => {
        game.loadouts = [{ equipment: [] }, {}];
        await bulkSell._start();

        expect(queued().length).toBeGreaterThan(0);
    });

    test('reports item quantity held back, not the number of stacks', async () => {
        // `characterItems` entries are inventory stacks. A player holding one
        // stack of 900 and one of 100 should see 1,000 held back, not 2 — the
        // "N held back" note is a quantity a player weighs against their
        // inventory, and a stack count reads as ten times too small.
        game.items = [
            {
                itemHrid: '/items/cheese',
                count: 900,
                enhancementLevel: 0,
                itemLocationHrid: '/item_locations/inventory',
            },
            { itemHrid: '/items/milk', count: 100, enhancementLevel: 0, itemLocationHrid: '/item_locations/inventory' },
        ];
        bulkSell.holdProviders.set('reselling', () => ['/items/cheese', '/items/milk']);
        game.loadouts = [];
        await bulkSell._start();

        expect(bulkSell.heldCount).toBe(1000);
    });
});

describe('the progress strip counts stacks, not items', () => {
    // `queue.length` is one entry per inventory stack (one per item, or per
    // item+enhancement-level under a tab), so the unit of work the strip is
    // reporting progress through really is stacks — unlike heldCount and
    // enhancedSkipped just above, which are genuinely item quantities. The
    // wording has to say which is which rather than calling both "items".
    test('the finished message says stacks', () => {
        bulkSell.queue = [
            { itemHrid: '/items/cheese', enhancementLevel: 0, count: 900, name: 'Cheese', stackValue: 1 },
            { itemHrid: '/items/milk', enhancementLevel: 0, count: 100, name: 'Milk', stackValue: 1 },
        ];
        bulkSell.index = 2; // past the end of the queue
        bulkSell.heldCount = 0;
        bulkSell.enhancedSkipped = 0;
        bulkSell.lockedSkipped = 0;
        bulkSell.loadoutsChecked = true;
        bulkSell._prepareCurrent();

        expect(bulkSell.statusNote).toBe('Done — 2 stacks processed');
    });

    test('the finished message keeps the locked-skip summary the first step cleared', () => {
        // Start sets the summary as the status, but every step clears transient status,
        // so without saying it again at the end a run with locked stacks just looks short
        bulkSell.queue = [{ itemHrid: '/items/milk', enhancementLevel: 0, count: 100, name: 'Milk', stackValue: 1 }];
        bulkSell.index = 1;
        bulkSell.heldCount = 0;
        bulkSell.enhancedSkipped = 0;
        bulkSell.lockedSkipped = 12;
        bulkSell.loadoutsChecked = true;
        bulkSell._prepareCurrent();

        expect(bulkSell.statusNote).toBe('Done — 1 stacks processed');
        expect(bulkSell.statusDetail).toBe('12 locked items skipped');
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

    describe('Stop revokes the delayed opener and fill', () => {
        beforeEach(() => {
            shortcuts.calls.length = 0;
        });

        test('an opener that times out after Stop neither skips nor closes an unrelated modal', async () => {
            bulkSell.queue = [{ itemHrid: '/items/cheese', enhancementLevel: 0, count: 5, name: 'Cheese' }];
            bulkSell.index = 0;
            bulkSell._decideAndOpen(book(100, 99));
            const call = shortcuts.calls[0];
            expect(call.isCancelled()).toBe(false);

            const unrelated = document.createElement('div');
            unrelated.innerHTML =
                '<div class="Modal_modalContainer__x"><button class="Modal_closeButton__x"></button></div>';
            document.body.appendChild(unrelated);
            const closed = vi.fn();
            unrelated.querySelector('button').addEventListener('click', closed);

            bulkSell._stop('Stopped');
            expect(call.isCancelled()).toBe(true);
            call.reject(new Error('Timeout'));
            await Promise.resolve();
            await Promise.resolve();

            expect(closed).not.toHaveBeenCalled();
            expect(bulkSell.state).toBe('idle');
            expect(bulkSell.statusNote).toBe('Stopped');
            unrelated.remove();
        });

        test('an opener that resolves after Stop does not move the run on', async () => {
            bulkSell._decideAndOpen(book(100, 99));
            const call = shortcuts.calls[0];
            bulkSell._stop('Stopped');
            call.resolve();
            await Promise.resolve();
            await Promise.resolve();
            expect(bulkSell.state).toBe('idle');
        });
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

    describe('a bid above the tradable band maximum', () => {
        const rich = (bid) => ({
            asks: [{ price: 200, orderQuantity: 10, filledQuantity: 0, createdTimestamp: new Date().toISOString() }],
            bids: [{ price: bid, orderQuantity: 10, filledQuantity: 0 }],
        });

        test('is still sold into, with a warning before anything is pressed', () => {
            band.value = { min: 45, max: 55 };
            settings['market_bulkSellMaxSpreadPct'] = 99;
            bulkSell._decideAndOpen(rich(80));
            expect(bulkSell.decision.insta).toBe(true);
            expect(bulkSell.decision.price).toBe(80);
            expect(bulkSell.decision.warning).toMatch(/above the tradable range/);
        });

        test('an in-band bid carries no warning', () => {
            band.value = { min: 45, max: 55 };
            settings['market_bulkSellMaxSpreadPct'] = 99;
            bulkSell._decideAndOpen(rich(50));
            expect(bulkSell.decision.insta).toBe(true);
            expect(bulkSell.decision.warning).toBeUndefined();
        });

        test('a listing decision carries no warning', () => {
            band.value = { min: 45, max: 55 };
            bulkSell._decideAndOpen(rich(80));
            expect(bulkSell.decision.insta).toBe(false);
            expect(bulkSell.decision.warning).toBeUndefined();
        });

        test('an above-band top bid is warned about even when the walk ends inside the band', () => {
            // 3 at 80 (above the band's 55) fill first, then the walk reaches 50 for the rest of the 12
            band.value = { min: 45, max: 55 };
            settings['market_bulkSellMaxSpreadPct'] = 99;
            bulkSell.current = { itemHrid: '/items/cheese', enhancementLevel: 2, count: 12 };
            bulkSell._decideAndOpen({
                asks: [
                    { price: 200, orderQuantity: 10, filledQuantity: 0, createdTimestamp: new Date().toISOString() },
                ],
                bids: [
                    { price: 80, orderQuantity: 5, filledQuantity: 2 },
                    { price: 52, orderQuantity: 4, filledQuantity: 0 },
                    { price: 50, orderQuantity: 10, filledQuantity: 0 },
                ],
            });
            expect(bulkSell.decision.insta).toBe(true);
            expect(bulkSell.decision.price).toBe(50);
            expect(bulkSell.decision.warning).toMatch(/above the tradable range/);
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

        test('bids all below the tradable minimum are not insta-sold into: it lists at the banded ask', () => {
            // The live case: range 74–93, every bid 73 and under sits under "Outside current tradable
            // range" with an hourglass Sell button the assistant can never press
            band.value = { min: 74, max: 93 };
            // Supply outweighs demand, so without the range check the supply rule would insta-sell
            settings['market_bulkSellSupplyRatio'] = 1;
            bulkSell._decideAndOpen({
                asks: [
                    {
                        price: 81,
                        orderQuantity: 5_000_000,
                        filledQuantity: 0,
                        createdTimestamp: new Date().toISOString(),
                    },
                ],
                bids: [
                    { price: 73, orderQuantity: 600_000, filledQuantity: 0 },
                    { price: 72, orderQuantity: 1_593_000, filledQuantity: 0 },
                ],
            });
            expect(bulkSell.decision.insta).toBe(false);
            expect(bulkSell.decision.price).toBe(81);
            expect(shortcuts.insta).toHaveLength(0);
            expect(shortcuts.listing).toHaveLength(1);
        });

        test('only the in-range bids are walked for an insta sell', () => {
            band.value = { min: 74, max: 93 };
            settings['market_bulkSellMaxSpreadPct'] = 100;
            bulkSell.current = { itemHrid: '/items/cheese', enhancementLevel: 0, count: 20 };
            bulkSell._decideAndOpen({
                asks: [{ price: 81, orderQuantity: 10, filledQuantity: 0, createdTimestamp: new Date().toISOString() }],
                bids: [
                    { price: 75, orderQuantity: 10, filledQuantity: 0 },
                    { price: 73, orderQuantity: 100, filledQuantity: 0 },
                ],
            });
            expect(bulkSell.decision.insta).toBe(true);
            // Walks to 75 and stops: the 73 bid can't be reached
            expect(bulkSell.decision.price).toBe(75);
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

describe('the remembered inventory tab across a character switch', () => {
    /**
     * The chip's tab picker, reduced to what `_populateTabSelect` needs of it:
     * a select it can read a value off and write options into.
     */
    const CHIP = 'mwi-bulk-sell-chip';
    const withChip = () => {
        const chip = document.createElement('div');
        for (const [tag, part] of [
            ['select', 'tab'],
            ['span', 'status'],
            ['button', 'main'],
            ['button', 'stop'],
        ]) {
            const el = document.createElement(tag);
            el.className = `${CHIP}-${part}`;
            chip.appendChild(el);
        }
        bulkSell.chip = chip;
        return chip.querySelector(`.${CHIP}-tab`);
    };

    test('cleanup drops the tab so the next character does not inherit it', async () => {
        // The main picked one of its own tabs and it was remembered
        store.data['char_bulkSell_lastTab'] = 'tab-7';
        game.tabsByCharacter = { char: [{ id: 'tab-7', name: 'Cheese' }] };
        withChip();
        await bulkSell._populateTabSelect();
        expect(bulkSell.selectedTabId).toBe('tab-7');
        expect(bulkSell._tabPrefLoaded).toBe(true);

        // A switch tears the feature down and builds it again for the alt.
        // Tab ids come out of a per-character inventory tab config, so the
        // main's id means nothing here — the alt must start on 'all' and the
        // picker must actually read again rather than short-circuit.
        bulkSell.cleanup();
        expect(bulkSell.selectedTabId).toBe('all');
        expect(bulkSell._tabPrefLoaded).toBe(false);

        game.characterId = 'alt';
        withChip();
        await bulkSell._populateTabSelect();
        expect(bulkSell.selectedTabId).toBe('all');
    });

    test('and each character still gets its own remembered tab back', async () => {
        store.data['char_bulkSell_lastTab'] = 'tab-7';
        store.data['alt_bulkSell_lastTab'] = 'tab-2';
        game.tabsByCharacter = {
            char: [{ id: 'tab-7', name: 'Cheese' }],
            alt: [{ id: 'tab-2', name: 'Ore' }],
        };

        game.characterId = 'alt';
        withChip();
        await bulkSell._populateTabSelect();
        expect(bulkSell.selectedTabId).toBe('tab-2');

        bulkSell.cleanup();
        game.characterId = 'char';
        withChip();
        await bulkSell._populateTabSelect();
        expect(bulkSell.selectedTabId).toBe('tab-7');
    });
});

/**
 * The strip's own confirm button.
 *
 * It presses the game's button rather than selling by itself, so there stays
 * exactly one path from "sold" to "next item" — the modal closing. What is
 * worth testing is therefore not the sale but the envelope around it: that both
 * routes land in the same place, that one press cannot become two, and that
 * every mismatch between the modal and the queued step refuses out loud.
 */
describe('confirming from the strip', () => {
    const CHIP = 'mwi-bulk-sell-chip';
    /** Clicks the fixture's game confirm button received */
    let gameClicks;

    /**
     * A sell modal shaped like the game's: header, item icon, quantity row and
     * the game's own confirming button.
     */
    const openModal = ({
        item = 'cheese',
        qty = 18,
        header = 'Sell Now',
        enhancement = null,
        // Drop the game's own quantity row and leave two bare inputs — price
        // first, as the DOM orders them — which is the shape the finder cannot
        // positively identify
        unreadableQty = false,
        // A price row as the game draws it: the input is there already, or only the display div that wakes it
        price = null,
        pricePrewoken = true,
    } = {}) => {
        const modal = document.createElement('div');
        modal.className = 'Modal_modalContainer__abc';
        const head = document.createElement('div');
        head.className = 'MarketplacePanel_header__x';
        head.textContent = header;
        const icon = document.createElement('div');
        icon.innerHTML = `<svg><use href="/static/media/items.svg#${item}"></use></svg>`;
        const qtyRow = document.createElement('div');
        qtyRow.className = 'MarketplacePanel_quantityInputs__y';
        const input = document.createElement('input');
        input.value = String(qty);
        qtyRow.appendChild(input);
        // The enhancement row as the game builds it: the label is a *sibling* of
        // the field's wrapper, not an ancestor of the input. A fixture that put
        // the label in the input's own div would let `closest('div')` read it,
        // which the real modal never does.
        let enhRow = null;
        if (enhancement !== null) {
            enhRow = document.createElement('div');
            enhRow.className = 'MarketplacePanel_enhancementLevelInputs__z';
            const label = document.createElement('div');
            label.textContent = 'Enhancement Level';
            const wrap = document.createElement('div');
            const enhInput = document.createElement('input');
            enhInput.value = String(enhancement);
            wrap.appendChild(enhInput);
            enhRow.append(label, wrap);
        }
        const confirm = document.createElement('button');
        // As the real game builds it: the label its string table calls
        // `postSellOrder`, and NO `Button_sell` class. The fixture used to grant
        // that class and label the button "Sell", so the class path always
        // matched here and the tests passed while the live modal refused every
        // press. A fixture kinder than the game tests nothing.
        confirm.className = 'Button_button__1Fe9z';
        confirm.textContent = 'Post Sell Order';
        confirm.addEventListener('click', () => gameClicks++);
        if (unreadableQty) {
            qtyRow.className = '';
            const priceWrap = document.createElement('div');
            const priceInput = document.createElement('input');
            priceInput.value = '45,000,000';
            priceWrap.appendChild(priceInput);
            modal.append(head, icon, ...(enhRow ? [enhRow] : []), priceWrap, qtyRow, confirm);
            document.body.appendChild(modal);
            return modal;
        }
        const priceRow = document.createElement('div');
        priceRow.className = 'MarketplacePanel_priceInputs__p';
        if (price !== null) {
            const makeInput = () => {
                const priceInput = document.createElement('input');
                priceInput.value = String(price);
                priceRow.textContent = '';
                priceRow.appendChild(priceInput);
            };
            if (pricePrewoken) makeInput();
            else {
                const display = document.createElement('div');
                display.className = 'MarketplacePanel_priceDisplay__d';
                display.addEventListener('click', makeInput);
                priceRow.appendChild(display);
            }
        }
        modal.append(head, icon, ...(enhRow ? [enhRow] : []), ...(price !== null ? [priceRow] : []), qtyRow, confirm);
        document.body.appendChild(modal);
        return modal;
    };

    /** A run parked on step 0 of two, with the panel up and the modal watched */
    const runAtStep0 = () => {
        bulkSell.queue = [
            { itemHrid: '/items/cheese', enhancementLevel: 0, count: 18, name: 'Cheese' },
            { itemHrid: '/items/milk', enhancementLevel: 0, count: 4, name: 'Milk' },
        ];
        bulkSell.index = 0;
        bulkSell.current = bulkSell.queue[0];
        bulkSell.decision = { insta: true, price: 796000, avgPrice: 796000, reason: 'queue ok' };
        bulkSell.state = 'awaiting_confirm';
        bulkSell._buildPanel();
        bulkSell._watchClose();
        bulkSell._render();
    };

    // Confirm now lives in the primary slot, alongside Next and Bulk Sell —
    // the maintainer's ask was that Confirm and Next share one button so a
    // run is a repeated click in one place. `.${CHIP}-main` dispatches to
    // Confirm only while `awaiting_confirm`, which is the state every test
    // below drives it in.
    const confirmBtn = () => bulkSell.chip.querySelector(`.${CHIP}-main`);
    const skipBtn = () => bulkSell.chip.querySelector(`.${CHIP}-skip`);
    /** The headline and the detail under it, whether or not the detail is folded out */
    const statusText = () =>
        `${bulkSell.chip.querySelector(`.${CHIP}-status`).textContent}\n` +
        bulkSell.chip.querySelector(`.${CHIP}-detail`).textContent;
    /** Only the walk's own state, which both confirm routes must leave identical */
    const walkState = () => ({ state: bulkSell.state, index: bulkSell.index, current: bulkSell.current?.itemHrid });

    /** Let the poller see the modal, then see it gone — what a real confirm does */
    const closeModalAndSettle = (modal) => {
        vi.advanceTimersByTime(200);
        modal.remove();
        vi.advanceTimersByTime(200);
    };

    beforeEach(() => {
        gameClicks = 0;
        // The bag matches the queue, as it does until something moves the stack
        game.items = [inventory('/items/cheese', 18), inventory('/items/milk', 4), inventory('/items/sword', 1, 3)];
        document.body.textContent = '';
        settings['market_bulkSellAssistant'] = true;
        bulkSell.chip = null;
        vi.useFakeTimers();
    });

    afterEach(() => {
        bulkSell._stop('');
        bulkSell._removePanel();
        vi.useRealTimers();
    });

    test('the strip button presses the game button and the walk advances', () => {
        const modal = openModal();
        runAtStep0();

        confirmBtn().click();
        expect(gameClicks).toBe(1);

        closeModalAndSettle(modal);
        expect(bulkSell.state).toBe('awaiting_next');
    });

    test('an above-band warning is marked on the headline and leads the detail, ahead of the reason', () => {
        const modal = openModal();
        runAtStep0();
        bulkSell.decision = {
            insta: true,
            price: 796000,
            avgPrice: 796000,
            reason: 'supply 1K > demand 500; fills best-first to 796K so the depth covers the stack',
            warning: 'bid above the tradable range: the game may refuse it',
        };
        bulkSell._render();
        const headline = bulkSell.chip.querySelector(`.${CHIP}-status`).textContent;
        const detailBox = bulkSell.chip.querySelector(`.${CHIP}-detail`);
        // The row says something needs a look; the words are under it, open without a click
        expect(headline.startsWith('⚠ ')).toBe(true);
        expect(headline).not.toContain('above the tradable range');
        expect(detailBox.style.display).toBe('');
        expect(detailBox.textContent.indexOf('Bid above the tradable range')).toBe(0);
        expect(detailBox.textContent.indexOf('Bid above the tradable range')).toBeLessThan(
            detailBox.textContent.indexOf('Supply')
        );
        closeModalAndSettle(modal);
    });

    test("a market modal confirm keeps the plain click, not the game's handler", () => {
        reactClicks.calls = [];
        const modal = openModal();
        runAtStep0();

        confirmBtn().click();
        expect(gameClicks).toBe(1);
        expect(reactClicks.calls).toHaveLength(0);
        closeModalAndSettle(modal);
    });

    test("the game's own button still confirms, and lands in the same place", () => {
        const first = openModal();
        runAtStep0();
        confirmBtn().click();
        closeModalAndSettle(first);
        const viaStrip = walkState();

        bulkSell._stop('');
        bulkSell._removePanel();
        const second = openModal();
        runAtStep0();
        // The player's own click on the game's button: the game closes the modal
        second.querySelector('button').click();
        closeModalAndSettle(second);

        expect(walkState()).toEqual(viaStrip);
        expect(bulkSell.state).toBe('awaiting_next');
    });

    test('confirming twice for one step sells once', () => {
        openModal();
        runAtStep0();

        confirmBtn().click();
        confirmBtn().click();
        confirmBtn().click();

        expect(gameClicks).toBe(1);
        expect(confirmBtn().disabled).toBe(true);
    });

    test('it refuses with the modal shut, and says so', () => {
        runAtStep0();

        confirmBtn().click();

        expect(gameClicks).toBe(0);
        expect(statusText()).toMatch(/not open/i);
    });

    test('it refuses when the modal is showing a different item, and says so', () => {
        openModal({ item: 'milk' });
        runAtStep0();

        confirmBtn().click();

        expect(gameClicks).toBe(0);
        expect(statusText()).toMatch(/milk/i);
        expect(statusText()).toMatch(/not Cheese/i);
    });

    test('it refuses when the quantity does not match the queued stack', () => {
        openModal({ qty: 3 });
        runAtStep0();

        confirmBtn().click();

        expect(gameClicks).toBe(0);
        expect(statusText()).toMatch(/3/);
        expect(statusText()).toMatch(/18/);
    });

    /*
     * The finder used to end in `return allInputs[0]`, and in a Sell Now modal
     * whose price control has been woken into a real input that first input is
     * the PRICE. So a modal the finder could not read handed this guard a price
     * to compare against the queued count — fail-closed only by the accident of
     * a price rarely equalling a count, on the one feature that presses the
     * game's own sell button. The finder answers null now, which is what makes
     * this refusal reachable.
     */
    test('it refuses, and says why, when the quantity field cannot be identified', () => {
        openModal({ unreadableQty: true });
        runAtStep0();

        confirmBtn().click();

        expect(gameClicks).toBe(0);
        expect(statusText()).toMatch(/quantity cannot be read/);
        // Not a comparison against the price, dressed up as a quantity mismatch
        expect(statusText()).not.toMatch(/45,?000,?000/);
    });

    describe('the stack is re-read at the press', () => {
        const setCheese = (count) => {
            game.items = [inventory('/items/cheese', count), inventory('/items/milk', 4)];
        };

        test('unchanged: sells the queued count', () => {
            openModal({ qty: 18 });
            runAtStep0();
            confirmBtn().click();
            expect(gameClicks).toBe(1);
            expect(bulkSell.current.count).toBe(18);
        });

        test('grew: rewrites the modal and sells the whole live stack', () => {
            const modal = openModal({ qty: 18 });
            runAtStep0();
            setCheese(25);
            confirmBtn().click();
            expect(modal.querySelector('input').value).toBe('25');
            expect(bulkSell.current.count).toBe(25);
            expect(gameClicks).toBe(1);
        });

        test("grew with another item's modal open: that modal is untouched and the press refuses", () => {
            const modal = openModal({ item: 'milk', qty: 4 });
            runAtStep0();
            setCheese(25);
            confirmBtn().click();
            expect(modal.querySelector('input').value).toBe('4');
            expect(gameClicks).toBe(0);
            expect(bulkSell.confirmNote).toContain('not Cheese');
            expect(bulkSell.current.count).toBe(18);
        });

        test('grew with a same-item Buy modal open: that modal is untouched and the press refuses', () => {
            const modal = openModal({ qty: 18, header: 'Buy Now' });
            runAtStep0();
            setCheese(25);
            confirmBtn().click();
            expect(modal.querySelector('input').value).toBe('18');
            expect(gameClicks).toBe(0);
            expect(bulkSell.confirmNote).toContain('not a sell form');
            expect(bulkSell.current.count).toBe(18);
        });

        test('grew with another enhancement level open: that modal is untouched and the press refuses', () => {
            const modal = openModal({ qty: 18, enhancement: 3 });
            runAtStep0();
            setCheese(25);
            confirmBtn().click();
            expect(modal.querySelector('div[class*="MarketplacePanel_quantityInputs"] input').value).toBe('18');
            expect(gameClicks).toBe(0);
            expect(bulkSell.confirmNote).toContain('+3');
        });

        test('shrank: sells what is there', () => {
            const modal = openModal({ qty: 18 });
            runAtStep0();
            setCheese(7);
            confirmBtn().click();
            expect(modal.querySelector('input').value).toBe('7');
            expect(gameClicks).toBe(1);
        });

        test('gone: the step is skipped and nothing is pressed', () => {
            openModal({ qty: 18 });
            runAtStep0();
            game.items = [inventory('/items/milk', 4)];
            confirmBtn().click();
            expect(gameClicks).toBe(0);
            expect(bulkSell.statusNote).toBe('no longer in inventory');
        });

        describe('gone with a modal open', () => {
            const addClose = (modal) => {
                let closes = 0;
                const close = document.createElement('button');
                close.className = 'Modal_closeButton__c';
                close.addEventListener('click', () => closes++);
                modal.appendChild(close);
                return () => closes;
            };

            test("another item's modal is left open and the step is still skipped", () => {
                const modal = openModal({ item: 'milk', qty: 4 });
                const closes = addClose(modal);
                runAtStep0();
                game.items = [inventory('/items/milk', 4)];
                confirmBtn().click();
                expect(closes()).toBe(0);
                expect(bulkSell.statusNote).toBe('no longer in inventory');
                expect(gameClicks).toBe(0);
            });

            test('the matching sell modal is closed and the step is skipped', () => {
                const modal = openModal({ qty: 18 });
                const closes = addClose(modal);
                runAtStep0();
                game.items = [inventory('/items/milk', 4)];
                confirmBtn().click();
                expect(closes()).toBe(1);
                expect(bulkSell.statusNote).toBe('no longer in inventory');
                expect(gameClicks).toBe(0);
            });
        });

        test('grew but the modal will not take it: refuses and names the leftover', () => {
            const modal = openModal({ qty: 18 });
            runAtStep0();
            setCheese(25);
            // A game that clamps the field back to what it allows
            const input = modal.querySelector('input');
            input.addEventListener('input', () => {
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '20');
            });
            confirmBtn().click();
            expect(gameClicks).toBe(0);
            expect(statusText()).toMatch(/only takes 20; 5 would be left over/);
        });
    });

    describe('the decision follows the stack at the press', () => {
        const bid = (price, orderQuantity) => ({ price, orderQuantity, filledQuantity: 0 });
        // Insta because the stack is worth less than the minimum listing value; asks high enough that a
        // stack of ten is not
        const bookOf = () => ({
            asks: [{ price: 120, orderQuantity: 50, filledQuantity: 0, createdTimestamp: new Date().toISOString() }],
            bids: [bid(100, 5), bid(50, 10)],
        });
        const priceOf = (modal) => modal.querySelector('div[class*="MarketplacePanel_priceInputs"] input').value;

        /** A run parked on a 5-stack of cheese whose decision was made on bookOf() */
        const runDecided = (modalOptions = {}) => {
            settings['market_bulkSellSupplyRatio'] = 0;
            settings['market_bulkSellQueueDays'] = 0;
            settings['market_bulkSellMaxSpreadPct'] = 0;
            settings['market_bulkSellMinPatientPremium'] = 0;
            settings['market_bulkSellMinListingValue'] = 1_000_000;
            game.items = [inventory('/items/cheese', 5), inventory('/items/milk', 4)];
            const modal = openModal({ qty: 5, price: 100, ...modalOptions });
            runAtStep0();
            bulkSell.current.count = 5;
            bulkSell._decideAndOpen(bookOf());
            bulkSell.state = 'awaiting_confirm';
            return modal;
        };

        afterEach(() => {
            for (const key of [
                'market_bulkSellSupplyRatio',
                'market_bulkSellQueueDays',
                'market_bulkSellMaxSpreadPct',
                'market_bulkSellMinPatientPremium',
                'market_bulkSellMinListingValue',
            ]) {
                delete settings[key];
            }
        });

        test('the 5-stack fills at the top bid', () => {
            runDecided();
            expect(bulkSell.decision.insta).toBe(true);
            expect(bulkSell.decision.price).toBe(100);
        });

        test('growth that needs a lower bid level writes the lower minimum price', () => {
            const modal = runDecided();
            game.items = [inventory('/items/cheese', 10), inventory('/items/milk', 4)];
            confirmBtn().click();
            expect(priceOf(modal)).toBe('50');
            expect(modal.querySelector('div[class*="MarketplacePanel_quantityInputs"] input').value).toBe('10');
            expect(bulkSell.decision.price).toBe(50);
            // 5 at 100 and 5 at 50
            expect(bulkSell.decision.avgPrice).toBe(75);
            expect(bulkSell.decision.reason).toContain('fills best-first to 50');
            expect(gameClicks).toBe(1);
        });

        test('a price field still asleep is woken and written', () => {
            const modal = runDecided({ pricePrewoken: false });
            game.items = [inventory('/items/cheese', 10), inventory('/items/milk', 4)];
            confirmBtn().click();
            expect(priceOf(modal)).toBe('50');
            expect(gameClicks).toBe(1);
        });

        test('a price field that cannot be reached refuses rather than submit the old minimum', () => {
            const modal = runDecided({ price: null });
            game.items = [inventory('/items/cheese', 10), inventory('/items/milk', 4)];
            confirmBtn().click();
            expect(gameClicks).toBe(0);
            expect(bulkSell.confirmNote).toContain('minimum price of 50');
            expect(modal.querySelector('div[class*="MarketplacePanel_quantityInputs"] input').value).toBe('5');
            expect(bulkSell.current.count).toBe(5);
        });

        test('growth that flips insta to listing is refused with a note', () => {
            // 5 x 120 = 600 < 700 insta; 10 x 120 = 1200 lists
            settings['market_bulkSellMinListingValue'] = 700;
            const modal = runDecided();
            settings['market_bulkSellMinListingValue'] = 700;
            bulkSell._decideAndOpen(bookOf());
            bulkSell.state = 'awaiting_confirm';
            expect(bulkSell.decision.insta).toBe(true);
            game.items = [inventory('/items/cheese', 10), inventory('/items/milk', 4)];
            confirmBtn().click();
            expect(gameClicks).toBe(0);
            expect(bulkSell.confirmNote).toContain('be listed instead');
            expect(priceOf(modal)).toBe('100');
            expect(bulkSell.current.count).toBe(5);
            expect(bulkSell.decision.insta).toBe(true);
        });

        test('a re-walk at the press that newly sells into an above-band bid shows the warning before pressing', () => {
            // Decided with no band known; by the press the band (max 90) puts the 100 top bid above it
            band.value = { min: 40, max: 90 };
            const modal = runDecided();
            band.value = null;
            bulkSell._decideAndOpen(bookOf());
            bulkSell.state = 'awaiting_confirm';
            band.value = { min: 40, max: 90 };
            expect(bulkSell.decision.warning).toBeUndefined();
            game.items = [inventory('/items/cheese', 3), inventory('/items/milk', 4)];
            confirmBtn().click();
            expect(gameClicks).toBe(0);
            expect(bulkSell.confirmNote).toContain('above the tradable range');
            expect(statusText()).toContain('above the tradable range');
            // Seen now: the next press sells the three
            confirmBtn().click();
            expect(gameClicks).toBe(1);
            expect(modal.querySelector('div[class*="MarketplacePanel_quantityInputs"] input').value).toBe('3');
            band.value = null;
        });

        test('a refused warning press still leaves the modal holding the new count and price', () => {
            // Grows 5 to 10: the walk now needs the 50 level. Band max 90 puts the 100 top bid above it
            const modal = runDecided();
            band.value = { min: 40, max: 90 };
            game.items = [inventory('/items/cheese', 10), inventory('/items/milk', 4)];
            confirmBtn().click();
            expect(gameClicks).toBe(0);
            expect(bulkSell.confirmNote).toContain('above the tradable range');
            // The game's own button, pressed now, sells what the strip describes
            expect(priceOf(modal)).toBe('50');
            expect(modal.querySelector('div[class*="MarketplacePanel_quantityInputs"] input').value).toBe('10');
            expect(bulkSell.current.count).toBe(10);
            expect(bulkSell.decision.price).toBe(50);
            // Said once on the line, not twice
            expect(statusText().split('above the tradable range')).toHaveLength(2);
            confirmBtn().click();
            expect(gameClicks).toBe(1);
            band.value = null;
        });

        test('an unchanged count leaves the decision and the price alone', () => {
            const modal = runDecided();
            const before = bulkSell.decision;
            confirmBtn().click();
            expect(bulkSell.decision).toBe(before);
            expect(priceOf(modal)).toBe('100');
            expect(gameClicks).toBe(1);
        });
    });

    describe('what is left after a sale made in the modal', () => {
        const setCheese = (count) => {
            game.items =
                count > 0
                    ? [inventory('/items/cheese', count), inventory('/items/milk', 4)]
                    : [inventory('/items/milk', 4)];
        };

        test('a grown stack confirmed in the game modal leaves the remainder as the current step', () => {
            const modal = openModal({ qty: 18 });
            runAtStep0();
            setCheese(25);
            vi.advanceTimersByTime(200);
            // The player presses the game's own Confirm: 18 sold, 7 stay in the bag
            modal.querySelector('button').click();
            setCheese(7);
            modal.remove();
            vi.advanceTimersByTime(200);

            expect(bulkSell.state).toBe('awaiting_next');
            expect(bulkSell.index).toBe(0);
            expect(bulkSell.current.itemHrid).toBe('/items/cheese');
            expect(bulkSell.current.count).toBe(7);
            expect(statusText()).toContain('7 left after the sale');
            expect(statusText()).toContain('Press Sell again for the rest');

            // Its own press re-opens the same step, not the next item
            confirmBtn().click();
            expect(bulkSell.index).toBe(0);
            expect(bulkSell.state).toBe('preparing');
            expect(bulkSell.current.itemHrid).toBe('/items/cheese');
        });

        test('a sale that clears the stack advances as before', () => {
            const modal = openModal({ qty: 18 });
            runAtStep0();
            vi.advanceTimersByTime(200);
            modal.querySelector('button').click();
            setCheese(0);
            modal.remove();
            vi.advanceTimersByTime(200);

            expect(bulkSell.state).toBe('awaiting_next');
            expect(bulkSell._sellAgain).toBe(0);
            expect(statusText()).toContain('Press Next for the next item');
            confirmBtn().click();
            expect(bulkSell.index).toBe(1);
        });

        test('a cancel with the stack unchanged is unchanged', () => {
            const modal = openModal({ qty: 18 });
            runAtStep0();
            setCheese(25);
            vi.advanceTimersByTime(200);
            modal.remove();
            vi.advanceTimersByTime(200);
            expect(bulkSell.state).toBe('awaiting_next');
            vi.advanceTimersByTime(3000);
            expect(bulkSell._sellAgain).toBe(0);
            expect(statusText()).toContain('Press Next for the next item');
            confirmBtn().click();
            expect(bulkSell.index).toBe(1);
        });

        test('a sale the inventory reports a moment after the modal closed still leaves the remainder', () => {
            const modal = openModal({ qty: 18 });
            runAtStep0();
            setCheese(25);
            vi.advanceTimersByTime(200);
            modal.remove();
            vi.advanceTimersByTime(200);
            expect(bulkSell._sellAgain).toBe(0);
            setCheese(7);
            vi.advanceTimersByTime(400);
            expect(bulkSell._sellAgain).toBe(7);
            expect(bulkSell.current.count).toBe(7);
            expect(statusText()).toContain('7 left after the sale');
        });

        test('Next is disabled while the late-sale watch runs, and arms again when it ends', () => {
            const modal = openModal({ qty: 18 });
            runAtStep0();
            setCheese(25);
            vi.advanceTimersByTime(200);
            modal.remove();
            vi.advanceTimersByTime(200);
            // Stack unchanged so far: the bag is still being watched for a late sale
            expect(bulkSell._afterCloseWatch).not.toBeNull();
            expect(confirmBtn().disabled).toBe(true);
            confirmBtn().click();
            bulkSell._onMainClick();
            expect(bulkSell.index).toBe(0);
            expect(bulkSell.state).toBe('awaiting_next');

            // The watch ends with nothing sold: Next arms and moves on
            vi.advanceTimersByTime(2000);
            expect(bulkSell._afterCloseWatch).toBeNull();
            expect(confirmBtn().disabled).toBe(false);
            confirmBtn().click();
            expect(bulkSell.index).toBe(1);
        });

        test('Skip leaves the remainder and moves on', () => {
            const modal = openModal({ qty: 18 });
            runAtStep0();
            setCheese(25);
            vi.advanceTimersByTime(200);
            setCheese(7);
            modal.remove();
            vi.advanceTimersByTime(200);
            skipBtn().click();
            expect(bulkSell.index).toBe(1);
            expect(bulkSell._sellAgain).toBe(0);
        });
    });

    test('Skip and Stop are untouched by the new button', () => {
        const modal = openModal();
        runAtStep0();

        skipBtn().click();
        expect(bulkSell.state).toBe('preparing');
        expect(bulkSell.index).toBe(1);
        expect(gameClicks).toBe(0);

        bulkSell.chip.querySelector(`.${CHIP}-stop`).click();
        expect(bulkSell.state).toBe('idle');
        expect(bulkSell.queue).toEqual([]);
        expect(skipBtn().style.visibility).toBe('hidden');
        modal.remove();
    });

    test('a refusal is shown in full without a click, and not repeated on the headline row', () => {
        // The reason used to trail the progress, the verb, the count, the name, the price and the decision
        // reason — past where the strip truncates. So a Confirm that had refused for a stated reason
        // presented as a button that did nothing, which is exactly how it was reported. It now leads the
        // detail row, which a refusal holds open whether or not the row is folded away.
        runAtStep0();
        document.querySelector('[class*="Modal_modalContainer"]')?.remove();

        confirmBtn().dispatchEvent(new Event('click'));

        const status = bulkSell.chip.querySelector(`.${CHIP}-status`);
        const detailBox = bulkSell.chip.querySelector(`.${CHIP}-detail`);
        expect(bulkSell.statusExpanded).toBe(false);
        expect(detailBox.style.display).toBe('');
        expect(detailBox.textContent.startsWith('Can’t confirm: the sell modal is not open.')).toBe(true);
        expect(status.textContent.startsWith('⚠ ')).toBe(true);
        expect(status.textContent).not.toContain('not open');
        // and the whole of it is still readable on hover, however narrow the strip
        expect(status.title).toContain('Cheese');
        expect(status.title).toContain('the sell modal is not open');
        // the hint to confirm would contradict the refusal, so it is not said
        expect(detailBox.textContent).not.toContain('Confirm in the modal');
    });

    /**
     * The level check, which used to read nothing at all.
     *
     * `input.closest('div')` is the input's own wrapper, and the game puts the
     * "Enhancement Level" label in a sibling — so the read matched no modal
     * ever and answered 0 for all of them. That is a guard that passes every
     * +0 step whatever the modal is showing, and refuses every enhanced step
     * whatever the modal is showing.
     */
    describe('and the enhancement level it checks', () => {
        /** A run parked on an enhanced step */
        const runAtEnhancedStep = () => {
            bulkSell.queue = [{ itemHrid: '/items/sword', enhancementLevel: 3, count: 1, name: 'Sword' }];
            bulkSell.index = 0;
            bulkSell.current = bulkSell.queue[0];
            bulkSell.decision = { insta: true, price: 10, avgPrice: 10, reason: 'queue ok' };
            bulkSell.state = 'awaiting_confirm';
            bulkSell._buildPanel();
            bulkSell._render();
        };

        test('a +0 step will not confirm a modal that is selling an enhanced copy', () => {
            // The sharp end: same item, same count, different level. The old
            // read answered 0 for this modal too, so the guard passed and the
            // press sold a +5 sword at the price a +0 was judged by.
            openModal({ item: 'cheese', qty: 18, enhancement: 5 });
            runAtStep0();

            confirmBtn().click();

            expect(gameClicks).toBe(0);
            expect(statusText()).toMatch(/\+5, not \+0/);
        });

        test('an enhanced step confirms against the modal that names its level', () => {
            openModal({ item: 'sword', qty: 1, enhancement: 3 });
            runAtEnhancedStep();

            confirmBtn().click();

            expect(gameClicks).toBe(1);
        });

        test('and refuses a modal that will not say its level at all', () => {
            openModal({ item: 'sword', qty: 1 });
            runAtEnhancedStep();

            confirmBtn().click();

            expect(gameClicks).toBe(0);
            expect(statusText()).toMatch(/does not say what enhancement level/);
        });

        test('an unenhanceable item has no such field, and that still means +0', () => {
            openModal();
            runAtStep0();

            confirmBtn().click();

            expect(gameClicks).toBe(1);
        });
    });

    /**
     * The two ways a press can arrive at a step that is no longer the one on
     * screen. Both have to refuse: the vendor path has no modal to check
     * anything against, and a skipped step's `current` is a sale that is over.
     */
    describe('a step the strip is no longer looking at', () => {
        test('a vendor step does not press a sell modal, only its own item menu', () => {
            openModal();
            runAtStep0();
            bulkSell.decision = { insta: false, vendor: true, price: 10, reason: 'vendor' };
            bulkSell._render();

            confirmBtn().click();

            expect(gameClicks).toBe(0);
            expect(bulkSell._confirmTarget().why).toMatch(/item menu is not open/);
        });

        test('after Skip the same modal is no longer this step’s sale', () => {
            const modal = openModal();
            runAtStep0();

            skipBtn().click();
            confirmBtn().click();

            expect(gameClicks).toBe(0);
            expect(bulkSell._confirmTarget().why).toMatch(/no sale waiting/);
            modal.remove();
        });
    });

    /**
     * Opening an item's order book is a game request, and the click that asked
     * for it has spent its one action. A skip the game causes afterwards must
     * not open the next book on its own.
     */
    describe('a skip after the order book was opened', () => {
        const unmarketable = () => {
            bulkSell.queue = ['cheese', 'milk', 'egg'].map((slug) => ({
                itemHrid: `/items/${slug}`,
                enhancementLevel: 0,
                count: 3,
                name: slug,
            }));
            // Parked just before the first item, so Next opens it
            bulkSell.index = -1;
            bulkSell.state = 'awaiting_next';
            bulkSell._buildPanel();
            navigations.length = 0;
        };

        test('one Next click opens one book, however many items find no market data', () => {
            unmarketable();

            confirmBtn().click();
            vi.advanceTimersByTime(20_000);

            expect(navigations).toEqual(['/items/cheese']);
            expect(bulkSell.state).toBe('awaiting_next');
            expect(statusText()).toMatch(/Skipped cheese \(no market data\)/);

            confirmBtn().click();
            vi.advanceTimersByTime(20_000);
            expect(navigations).toEqual(['/items/cheese', '/items/milk']);
        });

        test('a double-click on Next still opens one book: the ignored second press keeps the flag', () => {
            unmarketable();

            confirmBtn().click();
            confirmBtn().click();
            vi.advanceTimersByTime(20_000);

            expect(navigations).toEqual(['/items/cheese']);
            expect(bulkSell.state).toBe('awaiting_next');
            expect(statusText()).toMatch(/Skipped cheese \(no market data\)/);
        });

        test('the Skip button is a click of its own, so it opens the next book', () => {
            unmarketable();
            confirmBtn().click();
            navigations.length = 0;

            skipBtn().click();
            vi.advanceTimersByTime(700);

            expect(navigations).toEqual(['/items/milk']);
        });
    });

    /**
     * The vendor sale is the game's "Sell For N Coins" button in the item action
     * menu. Confirm presses it under the same envelope as the market modal: the
     * menu must be for the queued item, show the queued quantity, and quote the
     * queued coin total.
     */
    describe('a vendor step', () => {
        // 18 cheese at 22,222 each: 399,996, which the game labels "400K"
        const PRICE = 22222;

        /** Clicks that only armed the two-step button (no game request) */
        let armClicks;
        beforeEach(() => {
            armClicks = 0;
            bulkSell._vendorUnarmedShape = undefined;
        });

        /**
         * The game's two-step vendor button: the first click relabels it (and
         * turns it red) without a request; only a click on the armed label sells.
         * `armedLabel` is what it relabels to; `neverArms` leaves it unchanged.
         */
        const openMenu = ({
            item = 'cheese',
            qty = 18,
            label = 'Sell For 400K Coins',
            armedLabel = 'Confirm Sell For 400K Coins',
            neverArms = false,
            enhanced = false,
            icon = true,
            title = null,
            armed = null,
        } = {}) => {
            const menu = document.createElement('div');
            menu.className = 'Item_actionMenu__q';
            menu.innerHTML = icon
                ? `<div><svg><use href="/static/media/items.svg#${item}"></use></svg>Cheese</div>`
                : '<div>Cheese</div>';
            if (title !== null) menu.insertAdjacentHTML('afterbegin', `<div class="Item_name__x">${title}</div>`);
            // The live header always carries the level span, empty for a +0 item (checked on the test server)
            menu.insertAdjacentHTML(
                'beforeend',
                `<span class="Item_enhancementLevel__19g-e">${enhanced ? '+3' : ''}</span>`
            );
            const input = document.createElement('input');
            input.value = String(qty);
            const all = document.createElement('button');
            all.textContent = 'All';
            const sell = document.createElement('button');
            sell.className = 'Button_button__1Fe9z Button_sell__x';
            sell.textContent = label;
            // Whether the game considers the button armed is its own state, not something read off the words
            let armedNow = armed ?? /^confirm/i.test(label ?? '');
            sell.addEventListener('click', () => {
                if (armedNow) {
                    gameClicks++;
                } else {
                    armClicks++;
                    if (!neverArms) {
                        sell.textContent = armedLabel;
                        armedNow = true;
                    }
                }
            });
            menu.append(input, all);
            if (label !== null) menu.append(sell);
            document.body.appendChild(menu);
            return menu;
        };

        const vendorRun = () => {
            runAtStep0();
            bulkSell.decision = { insta: false, vendor: true, price: PRICE, reason: 'vendor' };
            bulkSell._render();
            bulkSell._trackVendorArming();
            bulkSell._watchClose('[class*="Item_actionMenu"]');
        };

        /** Press Confirm and let the bounded arming wait run out or finish */
        const pressAndSettle = async () => {
            confirmBtn().click();
            await vi.advanceTimersByTimeAsync(1200);
        };

        test('the armed button stands a moment before it is pressed, since the game ignores an instant confirm', async () => {
            openMenu();
            vendorRun();

            confirmBtn().click();
            await vi.advanceTimersByTimeAsync(150);
            expect(armClicks).toBe(1);
            expect(gameClicks).toBe(0);

            await vi.advanceTimersByTimeAsync(600);
            expect(gameClicks).toBe(1);
        });

        test('an unarmed button is armed by one click, then sold by one more', async () => {
            openMenu();
            vendorRun();
            expect(confirmBtn().disabled).toBe(false);

            await pressAndSettle();
            expect(armClicks).toBe(1);
            expect(gameClicks).toBe(1);
        });

        const favoriteCurrent = () =>
            game.favorite.add(`${bulkSell.current.itemHrid}:${bulkSell.current.enhancementLevel || 0}`);

        test('an item marked Favorite while the unarmed button settles is not sold', async () => {
            openMenu();
            vendorRun();

            confirmBtn().click();
            await vi.advanceTimersByTimeAsync(150);
            expect(armClicks).toBe(1);
            favoriteCurrent();
            await vi.advanceTimersByTimeAsync(1200);
            expect(gameClicks).toBe(0);
            expect(bulkSell.favoriteSkipped).toBeGreaterThan(0);
        });

        test('with the setting off, a Favorite marked during the vendor settle still sells', async () => {
            settings['market_bulkSellHoldFavorites'] = false;
            bulkSell.favoriteSkipped = 0;
            openMenu();
            vendorRun();

            confirmBtn().click();
            await vi.advanceTimersByTimeAsync(150);
            favoriteCurrent();
            await vi.advanceTimersByTimeAsync(1200);
            expect(gameClicks).toBe(1);
            expect(bulkSell.favoriteSkipped).toBe(0);
        });

        test('an item marked Favorite while an already-armed button settles is not sold', async () => {
            openMenu({ label: 'Confirm Sell For 400K Coins' });
            vendorRun();

            confirmBtn().click();
            await vi.advanceTimersByTimeAsync(100);
            favoriteCurrent();
            await vi.advanceTimersByTimeAsync(1200);
            expect(gameClicks).toBe(0);
            expect(bulkSell.favoriteSkipped).toBeGreaterThan(0);
        });

        test("the sale is pressed through the game's handler, since it ignores an untrusted click", async () => {
            reactClicks.calls = [];
            openMenu({ label: 'Confirm Sell For 400K Coins' });
            vendorRun();

            await pressAndSettle();
            expect(reactClicks.calls).toHaveLength(1);
            expect(reactClicks.calls[0].element.textContent).toBe('Confirm Sell For 400K Coins');
            expect(reactClicks.calls[0].options).toEqual({ reactFirst: true });
        });

        test('a disabled vendor button is never pressed, even through the game handler', async () => {
            reactClicks.calls = [];
            const menu = openMenu({ label: 'Confirm Sell For 400K Coins' });
            menu.querySelector('.Button_sell__x').disabled = true;
            vendorRun();

            await pressAndSettle();
            expect(reactClicks.calls).toHaveLength(0);
            expect(gameClicks).toBe(0);
            expect(bulkSell.confirmNote).toContain('disabled');
        });

        test('a button the player armed a moment ago also stands before it is pressed', async () => {
            openMenu({ label: 'Confirm Sell For 400K Coins' });
            vendorRun();

            confirmBtn().click();
            await vi.advanceTimersByTimeAsync(150);
            expect(gameClicks).toBe(0);

            await vi.advanceTimersByTimeAsync(600);
            expect(gameClicks).toBe(1);
            expect(armClicks).toBe(0);
        });

        test('an already-armed button is pressed once, with no arming click', async () => {
            openMenu({ label: 'Confirm Sell For 400K Coins' });
            vendorRun();

            await pressAndSettle();
            expect(armClicks).toBe(0);
            expect(gameClicks).toBe(1);
        });

        test('a second press is a no-op, including one during the arming wait', async () => {
            openMenu();
            vendorRun();

            confirmBtn().click();
            bulkSell._onConfirmClick();
            await vi.advanceTimersByTimeAsync(1200);
            expect(gameClicks).toBe(1);

            bulkSell._onConfirmClick();
            await vi.advanceTimersByTimeAsync(1200);
            expect(gameClicks).toBe(1);
            expect(armClicks).toBe(1);
            expect(confirmBtn().disabled).toBe(true);
        });

        test('the player pressing the armed game button during the wait is the only sale', async () => {
            // The menu stays open with the armed label until the server answers. Clicked after the
            // settle interval, before our own press would fire
            const menu = openMenu();
            vendorRun();

            confirmBtn().click();
            await vi.advanceTimersByTimeAsync(420);
            menu.querySelector('.Button_sell__x').click();
            await vi.advanceTimersByTimeAsync(1200);

            expect(armClicks).toBe(1);
            expect(gameClicks).toBe(1);
            expect(bulkSell._confirmSent()).toBe(true);
            bulkSell._releaseSaleGuard();
        });

        test('a server refusal after our press frees the step instead of leaving it waiting for the game', async () => {
            openMenu();
            vendorRun();
            await pressAndSettle();
            expect(gameClicks).toBe(1);
            expect(bulkSell._confirmSent()).toBe(true);

            notices.handler({ level: 'error', key: 'errorNotification.itemIsLocked', variables: {}, at: Date.now() });

            expect(bulkSell._confirmSent()).toBe(false);
            expect(bulkSell.confirmNote).toContain('itemIsLocked');
            expect(confirmBtn().disabled).toBe(false);
            expect(notices.handler).toBeNull();
        });

        test('the refusal listener is gone once the window ends, so a later error is not read as the answer', async () => {
            openMenu();
            vendorRun();
            await pressAndSettle();
            expect(notices.handler).not.toBeNull();

            await vi.advanceTimersByTimeAsync(10500);

            expect(notices.handler).toBeNull();
            bulkSell._releaseSaleGuard();
        });

        test('the listener is disposed when the step moves on', async () => {
            openMenu();
            vendorRun();
            await pressAndSettle();
            expect(notices.handler).not.toBeNull();

            bulkSell._clearTransient();

            expect(notices.handler).toBeNull();
        });

        test('an unrelated key, an info notice or a late refusal leaves the pressed step alone', async () => {
            openMenu();
            vendorRun();
            await pressAndSettle();

            notices.handler({ level: 'error', key: 'errorNotification.chatSpamProtection', variables: {}, at: 0 });
            notices.handler({ level: 'info', key: 'errorNotification.itemIsLocked', variables: {}, at: 0 });
            expect(bulkSell._confirmSent()).toBe(true);

            await vi.advanceTimersByTimeAsync(11000);
            expect(notices.handler).toBeNull();
            expect(bulkSell._confirmSent()).toBe(true);
            bulkSell._releaseSaleGuard();
        });

        test('a player click right after our arming stays retryable, since the game may ignore it', async () => {
            const menu = openMenu();
            vendorRun();
            const sell = menu.querySelector('.Button_sell__x');

            confirmBtn().click();
            sell.click();
            await vi.advanceTimersByTimeAsync(1200);

            // Our press stood down, but the step is not marked sent and nothing swallows a retry
            expect(gameClicks).toBe(1);
            expect(bulkSell._confirmSent()).toBe(false);
            expect(confirmBtn().disabled).toBe(false);
            sell.click();
            expect(gameClicks).toBe(2);
        });

        test('an inventory tile whose icon carries only xlink:href is still found for the vendor sale', () => {
            runAtStep0();
            bulkSell.state = 'preparing';
            const inventory = document.createElement('div');
            inventory.className = 'Inventory_items__x';
            // A +2 milk ahead of it, then a +3 cheese, then the +0 cheese with the legacy attribute only
            inventory.innerHTML =
                '<div class="Item_itemContainer__x"><div class="Item_item__x"><svg><use xlink:href="#milk"></use></svg></div></div>' +
                '<div class="Item_itemContainer__x"><div class="Item_item__x"><svg><use xlink:href="#cheese"></use></svg>' +
                '<div class="Item_enhancementLevel__x">+3</div></div></div>' +
                '<div class="Item_itemContainer__x"><div class="Item_item__x plain"><svg><use xlink:href="#cheese"></use></svg></div></div>';
            document.body.appendChild(inventory);
            const clicked = [];
            inventory.addEventListener('click', (event) => clicked.push(event.target.className));
            expect(bulkSell._openVendorSell(PRICE, 1)).toBe(true);
            expect(clicked).toEqual(['Item_item__x plain']);
            inventory.remove();
        });

        test('an arming while the run waits for the menu to open still counts as recent', async () => {
            runAtStep0();
            bulkSell.state = 'preparing';
            const inventory = document.createElement('div');
            inventory.className = 'Inventory_items__x';
            inventory.innerHTML =
                '<div class="Item_itemContainer__x"><div class="Item_item__x"><svg><use href="#cheese"></use></svg></div></div>';
            document.body.appendChild(inventory);
            expect(bulkSell._openVendorSell(PRICE, 1)).toBe(true);

            // The menu opens and the player arms it before the run's own menu wait has looked
            const menu = openMenu();
            const sell = menu.querySelector('.Button_sell__x');
            sell.click();
            await vi.advanceTimersByTimeAsync(360);
            expect(bulkSell.state).toBe('awaiting_confirm');

            confirmBtn().click();
            sell.click();
            await vi.advanceTimersByTimeAsync(1200);

            expect(gameClicks).toBe(1);
            expect(bulkSell._confirmSent()).toBe(false);
            inventory.remove();
        });

        test('clearing the step mid-wait ends the wait at once and leaves nothing listening', async () => {
            const menu = openMenu({ label: 'Confirm Sell For 400K Coins' });
            vendorRun();
            const sell = menu.querySelector('.Button_sell__x');

            confirmBtn().click();
            await vi.advanceTimersByTimeAsync(100);
            bulkSell._clearTransient();
            expect(bulkSell._vendorArming).toBe(false);

            // The stale wait's listener is gone: a click is neither taken as the sale nor guarded
            sell.click();
            sell.click();
            expect(gameClicks).toBe(2);
            expect(bulkSell._confirmSent()).toBe(false);

            // and the sleeping press, when it wakes, presses nothing
            await vi.advanceTimersByTimeAsync(1200);
            expect(gameClicks).toBe(2);
        });

        test('a player click on a button they armed a moment ago stays retryable', async () => {
            // The game may ignore a confirm landing that soon after the arming
            const menu = openMenu();
            vendorRun();
            const sell = menu.querySelector('.Button_sell__x');

            sell.click(); // the player arms it
            confirmBtn().click();
            sell.click();
            await vi.advanceTimersByTimeAsync(1200);

            expect(gameClicks).toBe(1);
            expect(bulkSell._confirmSent()).toBe(false);
            sell.click();
            expect(gameClicks).toBe(2);
        });

        test('a player click on a button armed long ago is the sale, and guards against a second', async () => {
            const menu = openMenu();
            vendorRun();
            const sell = menu.querySelector('.Button_sell__x');

            sell.click(); // the player arms it
            await vi.advanceTimersByTimeAsync(2000);
            confirmBtn().click();
            sell.click();
            sell.click();
            await vi.advanceTimersByTimeAsync(1200);

            expect(armClicks).toBe(1);
            expect(gameClicks).toBe(1);
            expect(bulkSell._confirmSent()).toBe(true);
            bulkSell._releaseSaleGuard();
        });

        test('a second player click after the armed-button click during the wait sends no second sale', async () => {
            const menu = openMenu();
            vendorRun();
            const sell = menu.querySelector('.Button_sell__x');

            confirmBtn().click();
            await vi.advanceTimersByTimeAsync(420);
            sell.click();
            sell.click();
            await vi.advanceTimersByTimeAsync(1200);

            expect(gameClicks).toBe(1);
            bulkSell._releaseSaleGuard();
        });

        test('a player click on the still-armed button after our press sends no second sale', async () => {
            const menu = openMenu();
            vendorRun();
            await pressAndSettle();
            expect(gameClicks).toBe(1);

            menu.querySelector('.Button_sell__x').click();
            expect(gameClicks).toBe(1);
        });

        test('an already-armed press guards the button against a following player click', async () => {
            const menu = openMenu({ label: 'Confirm Sell For 400K Coins' });
            vendorRun();
            await pressAndSettle();
            expect(gameClicks).toBe(1);

            menu.querySelector('.Button_sell__x').click();
            expect(gameClicks).toBe(1);
        });

        test('a slow server leaves the guard up while the menu stays open', async () => {
            const menu = openMenu();
            vendorRun();
            await pressAndSettle();
            await vi.advanceTimersByTimeAsync(5000);

            menu.querySelector('.Button_sell__x').click();
            expect(gameClicks).toBe(1);
        });

        test('once the menu closes, clicks on a sell button are no longer swallowed', async () => {
            const menu = openMenu();
            vendorRun();
            await pressAndSettle();
            closeModalAndSettle(menu);

            const next = openMenu({ label: 'Confirm Sell For 400K Coins' });
            next.querySelector('.Button_sell__x').click();
            expect(gameClicks).toBe(2);
        });

        test('the walk still advances only when the game closes the menu', async () => {
            const menu = openMenu();
            vendorRun();
            await pressAndSettle();
            expect(bulkSell.state).toBe('awaiting_confirm');

            closeModalAndSettle(menu);
            expect(bulkSell.state).toBe('awaiting_next');
        });

        test('without an icon the header name must equal the queued name', async () => {
            openMenu({ icon: false, title: '18 Verdant Cheese' });
            vendorRun();
            await pressAndSettle();
            expect(gameClicks).toBe(0);
            expect(bulkSell.confirmNote).toMatch(/does not say what it is selling/);
        });

        test('without an icon an exact header is accepted', async () => {
            openMenu({ icon: false, title: '18 Cheese' });
            vendorRun();
            await pressAndSettle();
            expect(gameClicks).toBe(1);
        });

        test('without an icon or a header the sale is refused', async () => {
            openMenu({ icon: false });
            vendorRun();
            await pressAndSettle();
            expect(gameClicks).toBe(0);
            expect(bulkSell.confirmNote).toMatch(/does not say what it is selling/);
        });

        test('an exact, unabbreviated total is accepted', async () => {
            openMenu({ label: 'Sell For 399,996 Coins', armedLabel: 'Confirm Sell For 399,996 Coins' });
            vendorRun();
            await pressAndSettle();
            expect(gameClicks).toBe(1);
        });

        describe('the Sell For total is abbreviated by the game, not rounded to match ours', () => {
            /** Queue `count` at `price`, open a menu showing `label`, and ask whether the button may be pressed */
            const verdict = (count, price, label) => {
                openMenu({ qty: count, label, armedLabel: label });
                vendorRun();
                bulkSell.current.count = count;
                bulkSell.decision = { insta: false, vendor: true, price, reason: 'vendor' };
                return bulkSell._vendorConfirmTarget();
            };

            test('26987 x 32 = 863,584 is accepted against the game’s truncated "863K"', () => {
                expect(verdict(26987, 32, 'Sell For 863K Coins').why).toBeUndefined();
            });

            test.each([
                ['K, truncated', 1000, 863.584, 'Sell For 863K Coins', true],
                ['K, rounded up', 1000, 863.996, 'Sell For 864K Coins', true],
                ['K, above the display range', 1000, 863.584, 'Sell For 865K Coins', false],
                ['K, below the display range', 1000, 863.584, 'Sell For 861K Coins', false],
                ['M, truncated', 1000, 4567.891, 'Sell For 4.56M Coins', true],
                ['M, a different total', 1000, 4567.891, 'Sell For 4.7M Coins', false],
                ['B, truncated', 1000, 2345678.901, 'Sell For 2.34B Coins', true],
                ['B, a different total', 1000, 2345678.901, 'Sell For 2.4B Coins', false],
                ['a small exact total', 30, 32, 'Sell For 960 Coins', true],
                ['a small total off by one', 30, 32, 'Sell For 961 Coins', false],
            ])('%s', (_name, count, price, label, accepted) => {
                // 1000 x 863.584 etc.: the price may be fractional here only to build the exact total
                const result = verdict(count, price, label);
                expect(result.why === undefined).toBe(accepted);
            });

            describe('in a comma-decimal language (de-DE)', () => {
                beforeEach(() => {
                    localStorage.setItem('i18nextLng', 'de-DE');
                    _resetGameNumberSeparators();
                });
                afterEach(() => {
                    localStorage.removeItem('i18nextLng');
                    _resetGameNumberSeparators();
                });

                test.each([
                    ['M, truncated, comma decimal', 1000, 4567.891, 'Sell For 4,56M Coins', true],
                    ['M, a different total', 1000, 4567.891, 'Sell For 4,7M Coins', false],
                    ['an exact total grouped with periods', 18, 22222, 'Sell For 399.996 Coins', true],
                    ['an exact total off by one', 18, 22222, 'Sell For 399.995 Coins', false],
                    ['K, truncated', 1000, 863.584, 'Sell For 863K Coins', true],
                ])('%s', (_name, count, price, label, accepted) => {
                    const result = verdict(count, price, label);
                    expect(result.why === undefined).toBe(accepted);
                });
            });

            describe('in a space-grouping language (fr-FR)', () => {
                beforeEach(() => {
                    localStorage.setItem('i18nextLng', 'fr-FR');
                    _resetGameNumberSeparators();
                });
                afterEach(() => {
                    localStorage.removeItem('i18nextLng');
                    _resetGameNumberSeparators();
                });

                test.each([
                    ['an exact total grouped with a space', 18, 22222, 'Vendre pour 399 996 pièces', true],
                    ['grouped with a narrow no-break space', 18, 22222, 'Vendre pour 399 996 pièces', true],
                    ['an exact total off by one', 18, 22222, 'Vendre pour 399 995 pièces', false],
                ])('%s', (_name, count, price, label, accepted) => {
                    const result = verdict(count, price, label);
                    expect(result.why === undefined).toBe(accepted);
                });
            });
        });

        test('a relabel that shows a different amount is refused and sells nothing', async () => {
            openMenu({ armedLabel: 'Confirm Sell For 410K Coins' });
            vendorRun();

            await pressAndSettle();
            expect(armClicks).toBe(1);
            expect(gameClicks).toBe(0);
            expect(bulkSell.confirmNote).toMatch(/Sell For says 410K/);
            expect(bulkSell._confirmSent()).toBe(false);
        });

        test('a button that never arms is refused after the bounded wait, without retrying', async () => {
            openMenu({ neverArms: true });
            vendorRun();

            await pressAndSettle();
            expect(armClicks).toBe(1);
            expect(gameClicks).toBe(0);
            expect(bulkSell.confirmNote).toMatch(/did not arm in time/);
            expect(bulkSell._confirmSent()).toBe(false);
        });

        describe('with the game in another language', () => {
            const CN = { label: '出售 400K 金币', armedLabel: '确认出售 400K 金币' };

            test('an unarmed button is found by its figure, armed by one click, then sold by one more', async () => {
                openMenu(CN);
                vendorRun();
                expect(bulkSell._confirmTarget().why).toBeUndefined();

                await pressAndSettle();
                expect(armClicks).toBe(1);
                expect(gameClicks).toBe(1);
                expect(reactClicks.calls.at(-1).element.textContent).toBe('确认出售 400K 金币');
            });

            test('the total is still checked against the queued one', async () => {
                openMenu({ label: '出售 410K 金币', armedLabel: '确认出售 410K 金币' });
                vendorRun();

                await pressAndSettle();
                expect(gameClicks).toBe(0);
                expect(armClicks).toBe(0);
                expect(bulkSell.confirmNote).toMatch(/says 410K/);
            });

            test('a button that never relabels is not taken for armed', async () => {
                openMenu({ ...CN, neverArms: true });
                vendorRun();

                await pressAndSettle();
                expect(gameClicks).toBe(0);
                expect(bulkSell.confirmNote).toMatch(/did not arm in time/);
            });

            test('a button already armed when first looked at is taken for armed, from what a fresh menu showed', async () => {
                runAtStep0();
                bulkSell.state = 'preparing';
                const inventory = document.createElement('div');
                inventory.className = 'Inventory_items__x';
                inventory.innerHTML =
                    '<div class="Item_itemContainer__x"><div class="Item_item__x"><svg><use href="#cheese"></use></svg></div></div>';
                document.body.appendChild(inventory);
                expect(bulkSell._openVendorSell(PRICE, 1)).toBe(true);
                // The run's own click opened the menu: unarmed, so this is what an unarmed button reads like
                const fresh = openMenu(CN);
                await vi.advanceTimersByTimeAsync(360);
                expect(bulkSell.state).toBe('awaiting_confirm');
                fresh.remove();

                // The game redraws the menu with the button already in its confirm state
                openMenu({ label: CN.armedLabel, armed: true });
                armClicks = 0;
                reactClicks.calls = [];
                expect(bulkSell._confirmTarget().armed).toBe(true);

                confirmBtn().click();
                await vi.advanceTimersByTimeAsync(1200);
                expect(armClicks).toBe(0);
                expect(gameClicks).toBe(1);
                expect(reactClicks.calls).toHaveLength(1);
                inventory.remove();
            });

            test('a menu with no button carrying a figure still stops at "not found"', () => {
                openMenu({ label: '出售' });
                vendorRun();
                expect(bulkSell._confirmTarget().why).toMatch(/Sell For button was not found/);
            });
        });

        test('a stack that grew since it was queued is sold whole when the menu matches inventory now', () => {
            // Queued at 18; two more cheese arrived, and the menu's "All" reads the live 20
            game.items = [{ itemHrid: '/items/cheese', itemLocationHrid: '/item_locations/inventory', count: 20 }];
            // 20 × 22,222 = 444,440, which the game labels "444K"
            openMenu({ qty: 20, label: 'Sell For 444K Coins', armedLabel: 'Confirm Sell For 444K Coins' });
            vendorRun();
            const target = bulkSell._confirmTarget();
            expect(target.why).toBeUndefined();
            expect(target.button).toBeTruthy();
            expect(bulkSell.current.count).toBe(20);
            game.items = [];
        });

        test('a menu count that matches neither the queue nor inventory still refuses', () => {
            game.items = [{ itemHrid: '/items/cheese', itemLocationHrid: '/item_locations/inventory', count: 20 }];
            openMenu({ qty: 19, label: 'Sell For 422K Coins' });
            vendorRun();
            expect(bulkSell._confirmTarget().why).toMatch(/says 19, not the queued 18/);
            game.items = [];
        });

        test.each([
            ['no menu open', null, /item menu is not open/],
            ['the wrong item', { item: 'milk' }, /milk|not Cheese/],
            ['the wrong quantity', { qty: 17 }, /says 17, not the queued 18/],
            ['a mismatched coin amount', { label: 'Sell For 410K Coins' }, /Sell For says 410K/],
            ['an exact total that is off by one', { label: 'Sell For 399,995 Coins' }, /Sell For says/],
            ['an enhanced item', { enhanced: true }, /enhanced/],
            ['no Sell For button', { label: null }, /Sell For button was not found/],
        ])('refuses on %s and presses nothing', async (_name, menuOptions, why) => {
            if (menuOptions) openMenu(menuOptions);
            vendorRun();

            await pressAndSettle();

            expect(gameClicks).toBe(0);
            expect(armClicks).toBe(0);
            expect(bulkSell._confirmTarget().why).toMatch(why);
            expect(statusText()).toMatch(/can’t confirm/i);
            expect(bulkSell._confirmSent()).toBe(false);
        });
    });

    /**
     * The prefill writes into the modal the run opened — not into one the
     * player opened for something else while the run waited.
     */
    describe('prefilling the modal', () => {
        test('a modal about another item is left exactly as the player left it', () => {
            bulkSell.queue = [{ itemHrid: '/items/cheese', enhancementLevel: 0, count: 18, name: 'Cheese' }];
            bulkSell.index = 0;
            bulkSell.current = bulkSell.queue[0];
            bulkSell.state = 'awaiting_confirm';

            const theirs = openModal({ item: 'milk', qty: 2 });
            bulkSell._onModal(theirs);
            vi.advanceTimersByTime(500);

            expect(theirs.querySelector('input').value).toBe('2');
        });

        test('Stop inside the fill delay leaves the field the player edits alone', () => {
            bulkSell.queue = [{ itemHrid: '/items/cheese', enhancementLevel: 0, count: 18, name: 'Cheese' }];
            bulkSell.index = 0;
            bulkSell.current = bulkSell.queue[0];
            bulkSell.state = 'preparing';

            const ours = openModal({ item: 'cheese', qty: 0 });
            bulkSell._onModal(ours);
            bulkSell._stop('Stopped');
            ours.querySelector('input').value = '3';
            vi.advanceTimersByTime(500);

            expect(ours.querySelector('input').value).toBe('3');
        });

        test('the run’s own modal is still filled with the queued count', () => {
            bulkSell.queue = [{ itemHrid: '/items/cheese', enhancementLevel: 0, count: 18, name: 'Cheese' }];
            bulkSell.index = 0;
            bulkSell.current = bulkSell.queue[0];
            bulkSell.state = 'preparing';

            const ours = openModal({ item: 'cheese', qty: 0 });
            bulkSell._onModal(ours);
            vi.advanceTimersByTime(500);

            expect(ours.querySelector('input').value).toBe('18');
        });
    });

    test('with the feature off there is no panel and no confirm button', async () => {
        settings['market_bulkSellAssistant'] = false;
        bulkSell.isInitialized = false;

        await bulkSell.initialize();

        expect(bulkSell.isInitialized).toBe(false);
        expect(document.querySelector(`.${CHIP}-main`)).toBeNull();
        expect(document.querySelector(`.${CHIP}-skip`)).toBeNull();
    });
});

/**
 * The strip's geometry.
 *
 * The complaint was that Confirm and the main button are in different places
 * from one press to the next: the widget is anchored by one edge and its width
 * follows its content, so the main button's label changing from `▶ Bulk Sell`
 * to `⏭ Skip` to `▶ Next`, and Stop and Confirm coming and going, drag
 * everything beside them sideways.
 *
 * happy-dom does no layout, so none of these can measure a pixel. What they can
 * hold is the mechanism that decides the pixels: every control keeps its slot
 * in the row in every state (hidden with `visibility`, never `display`), the
 * row's contents never change, and the main button carries all three of its
 * labels at once so its width is the widest of them whichever one is showing.
 */
describe('the strip does not move its controls', () => {
    const CHIP = 'mwi-bulk-sell-chip';

    /**
     * Put the panel into one of the states the walk actually reaches.
     * @param {string} state - The walk state to draw
     * @param {Object} [options] - The note, vendor flag and refusal to draw it with
     */
    const enter = (state, { note = '', vendor = false, confirmNote = '' } = {}) => {
        bulkSell.queue = [
            { itemHrid: '/items/cheese', enhancementLevel: 0, count: 18, name: 'Cheese' },
            { itemHrid: '/items/milk', enhancementLevel: 0, count: 4, name: 'Milk' },
        ];
        bulkSell.index = 0;
        bulkSell.current = bulkSell.queue[0];
        bulkSell.decision = { insta: true, vendor, price: 796000, avgPrice: 796000, reason: 'spread 0.6%' };
        if (state === 'idle' || state === 'done') {
            bulkSell.queue = [];
            bulkSell.current = null;
        }
        bulkSell.state = state;
        bulkSell.statusNote = note;
        bulkSell.confirmNote = confirmNote;
        bulkSell._render();
    };

    /**
     * What the row is made of and how much room each part takes.
     *
     * `display` is the part that changes the layout; `visibility` is the part
     * that does not. So a signature listing the row's children and their
     * `display` is exactly "would the things beside this have moved".
     */
    const layout = () =>
        [...bulkSell.chip.querySelector(`.${CHIP}-status`).parentElement.children].map(
            (element) => `${element.className}:${element.style.display}`
        );

    /** The label spans stacked in the main button */
    const labels = () => [...bulkSell.chip.querySelector(`.${CHIP}-main`).children];

    /** Every state the strip has, and what has to be true of the row in all of them */
    const states = [
        ['idle', 'idle', {}],
        ['checking', 'preparing', {}],
        ['awaiting confirm', 'awaiting_confirm', {}],
        ['awaiting confirm, refused', 'awaiting_confirm', { confirmNote: 'the sell modal is not open' }],
        ['awaiting confirm, vendor', 'awaiting_confirm', { vendor: true }],
        ['dealt with', 'awaiting_next', {}],
        // Retry and the toggle come and go in these without moving anything beside them
        ['skipped, retry offered', 'awaiting_next', { note: 'no market data' }],
        ['done', 'done', { note: 'Sold 12 items' }],
        ['stopped', 'idle', { note: 'Stopped' }],
    ];

    beforeEach(() => {
        document.body.textContent = '';
        settings['market_bulkSellAssistant'] = true;
        bulkSell.chip = null;
        bulkSell.statusExpanded = false;
        bulkSell._hasTabs = true;
        bulkSell._buildPanel();
    });

    afterEach(() => {
        bulkSell.confirmNote = '';
        bulkSell.statusNote = '';
        bulkSell.state = 'idle';
        bulkSell._removePanel();
    });

    test('every state lays the row out identically', () => {
        enter('idle');
        const baseline = layout();

        for (const [name, state, options] of states) {
            enter(state, options);
            expect(layout(), `${name} lays the row out differently`).toEqual(baseline);
        }
    });

    test('Skip and Stop keep their slot when they are not offered', () => {
        // Skip has moved to its own button beside the primary slot, which now
        // carries Confirm/Next/Bulk Sell — it never disappears from the row.
        enter('awaiting_confirm');
        const skip = bulkSell.chip.querySelector(`.${CHIP}-skip`);
        const stop = bulkSell.chip.querySelector(`.${CHIP}-stop`);
        expect(skip.style.visibility).toBe('visible');
        expect(stop.style.visibility).toBe('visible');

        enter('idle');

        // Out of sight, still in the layout — the whole point
        expect(skip.style.visibility).toBe('hidden');
        expect(stop.style.visibility).toBe('hidden');
        expect(skip.style.display).toBe('');
        expect(stop.style.display).toBe('');
    });

    test('the main button carries every label at once, showing one', () => {
        for (const [name, state, options] of states) {
            enter(state, options);
            const shown = labels().filter((span) => span.style.visibility === 'visible');
            expect(
                labels().map((span) => span.dataset.label),
                `${name} lost a reserved label`
            ).toEqual(['▶ Bulk Sell', '✔ Confirm', '▶ Next']);
            expect(shown.length, `${name} shows ${shown.length} labels`).toBe(1);
        }
    });

    test('the label showing is still the next thing a press would do', () => {
        // Confirm and Next now share the primary slot — this is the whole
        // point of the change: the maintainer wants one button to click
        // repeatedly to walk the queue.
        const shown = () => labels().find((span) => span.style.visibility === 'visible')?.dataset.label ?? null;

        enter('idle');
        expect(shown()).toBe('▶ Bulk Sell');
        enter('preparing');
        expect(shown()).toBe('✔ Confirm');
        enter('awaiting_confirm');
        expect(shown()).toBe('✔ Confirm');
        enter('awaiting_next');
        expect(shown()).toBe('▶ Next');
    });

    test('Confirm and Next occupy the same slot — the primary button never changes identity', () => {
        // Assert on element identity, not on pixel geometry: happy-dom does no
        // layout, so the property under test is that the *same element* reads
        // Confirm in one state and Next in the next, not that two elements
        // happen to sit at the same coordinates.
        enter('awaiting_confirm');
        const primaryDuringConfirm = bulkSell.chip.querySelector(`.${CHIP}-main`);
        const rowChildren = () => [...bulkSell.chip.querySelector(`.${CHIP}-status`).parentElement.children];
        const indexDuringConfirm = rowChildren().indexOf(primaryDuringConfirm);

        enter('awaiting_next');
        const primaryDuringNext = bulkSell.chip.querySelector(`.${CHIP}-main`);
        const indexDuringNext = rowChildren().indexOf(primaryDuringNext);

        expect(primaryDuringNext).toBe(primaryDuringConfirm);
        expect(indexDuringNext).toBe(indexDuringConfirm);
    });

    test('the status line is a fixed slot rather than one that follows its text', () => {
        const status = bulkSell.chip.querySelector(`.${CHIP}-status`);
        expect(status.style.width).toBe('340px');
        // Grows to exactly 340px, and gives width up only when the strip hits its
        // screen-width cap on a phone
        expect(status.style.flex).toBe('1 1 0px');
        expect(status.style.maxWidth).toBe('340px');

        enter('idle');
        const short = status.style.width;
        enter('awaiting_confirm');

        expect(status.style.width).toBe(short);
        // and it is never taken out of the row, however little it has to say
        expect(status.style.display).toBe('');
    });
});

/**
 * Reading the whole status line without hovering.
 *
 * The line saying what is about to be sold and for how much is the longest one
 * the strip draws and the one it truncates. One line stays the default — the
 * strip sits over the game — and the ▾ folds the rest out underneath, where it
 * grows downwards and moves nothing in the row.
 */
describe('the folded-out status line', () => {
    const CHIP = 'mwi-bulk-sell-chip';
    const detail = () => bulkSell.chip.querySelector(`.${CHIP}-detail`);
    const more = () => bulkSell.chip.querySelector(`.${CHIP}-more`);
    const status = () => bulkSell.chip.querySelector(`.${CHIP}-status`);

    /** The step from the report: a status line far longer than the strip is wide */
    const atLongStep = () => {
        bulkSell.queue = [{ itemHrid: '/items/cheese', enhancementLevel: 0, count: 1096, name: 'Crimson Cheese' }];
        bulkSell.index = 0;
        bulkSell.current = bulkSell.queue[0];
        bulkSell.decision = { insta: true, price: 3400, avgPrice: 3400, reason: 'spread 0.6% under 2%' };
        bulkSell.state = 'awaiting_confirm';
        bulkSell._render();
    };

    beforeEach(() => {
        document.body.textContent = '';
        settings['market_bulkSellAssistant'] = true;
        bulkSell.chip = null;
        bulkSell.statusExpanded = false;
    });

    afterEach(() => {
        bulkSell.state = 'idle';
        bulkSell._removePanel();
    });

    test('collapsed is the default, and the whole line is still there to fold out', () => {
        bulkSell._buildPanel();
        atLongStep();

        expect(detail().style.display).toBe('none');
        expect(more().textContent).toBe('▾');
        expect(more().title).toBeTruthy();
        expect(more().getAttribute('aria-expanded')).toBe('false');
    });

    test('folding it out shows the detail, untruncated and wrapping, and never says the headline again', () => {
        bulkSell._buildPanel();
        atLongStep();

        more().click();

        expect(detail().style.display).toBe('');
        expect(status().textContent).toBe('1/1 · Insta-sell 1,096× Crimson Cheese @ ~3.4K');
        expect(detail().textContent).toBe('Spread 0.6% under 2%. Confirm in the modal, or press Confirm here.');
        expect(detail().textContent).not.toContain('Crimson Cheese');
        expect(status().title).toBe(`${status().textContent}\n${detail().textContent}`);
        // Downwards, never sideways: capped at the status line's own width
        expect(detail().style.maxWidth).toBe('340px');
        expect(detail().style.whiteSpace).toBe('normal');
        expect(more().textContent).toBe('▴');
        expect(more().getAttribute('aria-expanded')).toBe('true');
    });

    test('folding it out moves nothing in the row', () => {
        bulkSell._buildPanel();
        atLongStep();
        const row = status().parentElement;
        const before = [...row.children].map((element) => `${element.className}:${element.style.display}`);

        more().click();

        expect([...row.children].map((element) => `${element.className}:${element.style.display}`)).toEqual(before);
        // and it is a sibling of the row, not something inside it
        expect(detail().parentElement).toBe(bulkSell.chip);
        expect(row.contains(detail())).toBe(false);
    });

    test('the choice survives a rebuild of the panel', async () => {
        bulkSell._buildPanel();
        atLongStep();
        more().click();
        expect(store.data['bulkSellStatusExpanded']).toBe(true);

        bulkSell._removePanel();
        // What a fresh session does: the preference is read back before the
        // panel is built, the way the remembered position is
        bulkSell.statusExpanded = Boolean(store.data['bulkSellStatusExpanded']);
        bulkSell._buildPanel();
        atLongStep();

        expect(detail().style.display).toBe('');
        expect(more().textContent).toBe('▴');
    });
});

/**
 * The status bar's two rows, and the Retry button.
 *
 * The bar used to say the same sentence twice: a truncated copy in the row and the whole of it again
 * when folded out. Now the row is a short headline (progress and action) and the fold-out adds only
 * what the headline lacks. Retry starts the current step over (close what is open, open the item again,
 * fill the amount, bring the modal back) and never sells: the confirm stays the player's press.
 *
 * Driven through the real step functions with the fixture's order book, for a stack of golem essence.
 */
describe('the status bar and its Retry button', () => {
    const CHIP = 'mwi-bulk-sell-chip';
    const GOLEM = '/items/golem_essence';
    /** Insta-sell by the spread rule alone: 185 / 183 is a 1.08% spread, under the 2% limit */
    const BOOK = {
        asks: [{ price: 185, orderQuantity: 100, filledQuantity: 0, createdTimestamp: new Date().toISOString() }],
        bids: [{ price: 183, orderQuantity: 90000, filledQuantity: 0 }],
    };
    let gameClicks;
    let closeClicks;

    const part = (name) => bulkSell.chip.querySelector(`.${CHIP}-${name}`);
    const headline = () => part('status').textContent;
    const detail = () => part('detail').textContent;
    const detailShown = () => part('detail').style.display !== 'none';
    const retryBtn = () => part('retry');
    const retryOffered = () => retryBtn().style.visibility === 'visible';
    const retryEnabled = () => retryOffered() && !retryBtn().disabled;

    /** A sell modal as the game draws it, with a close button and a confirm that counts its presses */
    const openModal = ({ qty = 27699, header = 'Sell Now' } = {}) => {
        const modal = document.createElement('div');
        modal.className = 'Modal_modalContainer__abc';
        modal.innerHTML =
            `<div class="MarketplacePanel_header__x">${header}</div>` +
            '<div><svg><use href="/static/media/items.svg#golem_essence"></use></svg></div>' +
            `<div class="MarketplacePanel_quantityInputs__y"><input value="${qty}"></div>` +
            '<button class="Button_button__1Fe9z">Post Sell Order</button>' +
            '<button class="Modal_closeButton__z">x</button>';
        modal.querySelector('.Button_button__1Fe9z').addEventListener('click', () => gameClicks++);
        modal.querySelector('.Modal_closeButton__z').addEventListener('click', () => {
            closeClicks++;
            modal.remove();
        });
        document.body.appendChild(modal);
        return modal;
    };

    const setStack = (count) => {
        game.items = count > 0 ? [inventory(GOLEM, count), inventory('/items/milk', 4)] : [inventory('/items/milk', 4)];
    };

    /** The run parked on step 0 of two */
    const startRun = () => {
        bulkSell.queue = [
            { itemHrid: GOLEM, enhancementLevel: 0, count: 27699, name: 'Golem Essence' },
            { itemHrid: '/items/milk', enhancementLevel: 0, count: 4, name: 'Milk' },
        ];
        bulkSell.index = 0;
        bulkSell._buildPanel();
    };

    /** Prepare step 0 the way a press of Start or Next does, through to the sell modal being offered */
    const reachConfirm = async () => {
        bulkSell._prepareCurrent();
        bulkSell._onOrderBook({ marketItemOrderBooks: { itemHrid: GOLEM, orderBooks: [BOOK] } });
        shortcuts.calls.at(-1).resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(bulkSell.state).toBe('awaiting_confirm');
    };

    beforeEach(() => {
        vi.useFakeTimers();
        document.body.textContent = '';
        gameClicks = 0;
        closeClicks = 0;
        navigations.length = 0;
        shortcuts.calls.length = 0;
        shortcuts.insta.length = 0;
        shortcuts.listing.length = 0;
        settings['market_bulkSellAssistant'] = true;
        settings['market_bulkSellSupplyRatio'] = 0;
        settings['market_bulkSellQueueDays'] = 0;
        settings['market_bulkSellMinListingValue'] = 0;
        settings['market_bulkSellMaxSpreadPct'] = 2;
        settings['market_bulkSellMinPatientPremium'] = 0;
        game.details[GOLEM] = { isTradable: true };
        setStack(27699);
        bulkSell._stop('');
        bulkSell.chip = null;
        bulkSell.statusExpanded = false;
        bulkSell.isInitialized = true;
        startRun();
    });

    afterEach(() => {
        bulkSell._stop('');
        bulkSell._removePanel();
        bulkSell.statusExpanded = false;
        vi.useRealTimers();
        document.body.textContent = '';
        window.innerWidth = 1024;
        delete window.matchMedia;
    });

    describe('every status says its headline once, and the detail only what the headline lacks', () => {
        /** The invariants every status shares, whatever it says */
        const wellFormed = (name) => {
            const h = headline();
            const d = detail();
            expect(h, `${name}: empty headline`).not.toBe('');
            // No second row, and no toggle, when there is nothing to add
            if (!d) {
                expect(detailShown(), `${name}: an empty second row is showing`).toBe(false);
                expect(part('more').style.visibility, `${name}: a toggle with nothing to toggle`).toBe('hidden');
            }
            // The detail never restates the headline, and the headline never carries the detail's sentences
            expect(d.includes(h), `${name}: detail repeats the headline`).toBe(false);
            for (const sentenceText of d.split(/(?<=[.!?…])\s+/).filter(Boolean)) {
                expect(h.includes(sentenceText), `${name}: headline repeats "${sentenceText}"`).toBe(false);
            }
            // The hover carries both, the one place they meet
            expect(part('status').title).toBe(d ? `${h}\n${d}` : h);
        };

        test('idle: a headline alone', () => {
            bulkSell._render();
            expect(headline()).toBe('Sell every tradable item, one confirm each');
            expect(detail()).toBe('');
            wellFormed('idle');
        });

        test('stopped: a headline alone', () => {
            bulkSell._stop('Stopped');
            expect(headline()).toBe('Stopped');
            expect(detail()).toBe('');
            wellFormed('stopped');
        });

        test('empty: says what is empty, and what was left out underneath', async () => {
            game.items = [inventory(GOLEM, 5)];
            game.locked.add(`${GOLEM}:0`);
            bulkSell._stop('');
            await bulkSell._start();
            expect(bulkSell.state).toBe('idle');
            expect(headline()).toBe('No tradable items in inventory');
            expect(detail()).toBe('5 locked items skipped.');
            wellFormed('empty');
        });

        test('a source problem: the headline alone, with no leftover detail from the run before', async () => {
            game.items = [inventory(GOLEM, 5)];
            game.locked.add(`${GOLEM}:0`);
            await bulkSell._start();
            expect(detail()).not.toBe('');

            game.watched = [];
            bulkSell.selectedTabId = 'watchlist';
            await bulkSell._start();
            expect(headline()).toBe('Nothing on the watchlist');
            expect(detail()).toBe('');
            wellFormed('error');
        });

        test('checking: progress and the item, nothing more', () => {
            bulkSell._prepareCurrent();
            expect(headline()).toBe('1/2 · Checking Golem Essence…');
            expect(detail()).toBe('');
            wellFormed('checking');
        });

        test('waiting to confirm an insta-sell: the action in the row, the why and the how underneath', async () => {
            await reachConfirm();
            expect(headline()).toBe('1/2 · Insta-sell 27,699× Golem Essence @ ~183');
            expect(detail()).toBe('Spread 1.1% ≤ 2%. Confirm in the modal, or press Confirm here.');
            // Folded away by default: the row alone, and a toggle to read the rest
            expect(detailShown()).toBe(false);
            expect(part('more').style.visibility).toBe('visible');
            wellFormed('insta');

            part('more').click();
            expect(detailShown()).toBe(true);
        });

        test('waiting to confirm a listing', async () => {
            settings['market_bulkSellMaxSpreadPct'] = 0;
            bulkSell._prepareCurrent();
            bulkSell._onOrderBook({ marketItemOrderBooks: { itemHrid: GOLEM, orderBooks: [BOOK] } });
            shortcuts.calls.at(-1).resolve();
            await vi.advanceTimersByTimeAsync(0);
            expect(headline()).toBe('1/2 · List 27,699× Golem Essence @ 185');
            expect(detail()).toBe('Queue ok. Confirm in the modal, or press Confirm here.');
            wellFormed('listing');
        });

        test('waiting to confirm a vendor sale', () => {
            bulkSell._prepareCurrent();
            bulkSell.decision = { insta: false, vendor: true, price: 96, reason: 'vendor 96 ≥ market net 95' };
            bulkSell.state = 'awaiting_confirm';
            bulkSell._render();
            expect(headline()).toBe('1/2 · Vendor-sell 27,699× Golem Essence @ 96');
            expect(detail()).toBe('Vendor 96 ≥ market net 95. Click Sell For in the item menu, or press Confirm here.');
            wellFormed('vendor');
        });

        test('confirm sent: the hint says so, and Retry waits', async () => {
            openModal();
            await reachConfirm();
            part('main').click();
            expect(gameClicks).toBe(1);
            expect(detail()).toBe('Spread 1.1% ≤ 2%. Confirm sent — waiting for the game.');
            wellFormed('sent');
        });

        test('refused by the check: the refusal leads the detail, held open, with no hint to confirm', async () => {
            await reachConfirm();
            part('main').click();
            expect(headline().startsWith('⚠ 1/2 · Insta-sell')).toBe(true);
            expect(detail()).toBe('Can’t confirm: the sell modal is not open. Spread 1.1% ≤ 2%.');
            // Held open though the row is folded away: the player has to see it
            expect(bulkSell.statusExpanded).toBe(false);
            expect(detailShown()).toBe(true);
            expect(part('more').style.visibility).toBe('hidden');
            wellFormed('refused');
        });

        test('refused by the game: named, and the step is free to confirm again', async () => {
            openModal();
            await reachConfirm();
            part('main').click();
            notices.handler({ level: 'error', key: 'errorNotification.itemIsLocked', variables: {}, at: Date.now() });
            expect(detail()).toBe('Can’t confirm: the game refused the sale (itemIsLocked). Spread 1.1% ≤ 2%.');
            expect(detailShown()).toBe(true);
            wellFormed('refused by the game');
        });

        test('skipped: the item and the reason in the row, what to do underneath', async () => {
            bulkSell._prepareCurrent();
            vi.advanceTimersByTime(3100);
            expect(bulkSell.state).toBe('awaiting_next');
            expect(headline()).toBe('1/2 · Skipped Golem Essence (no market data)');
            expect(detail()).toBe('Press Next for the next item. Or ↻ to open this one again.');
            wellFormed('skipped');
        });

        test('skipped by the player carries no reason and moves straight on', async () => {
            openModal();
            await reachConfirm();
            part('skip').click();
            // Skip is a click of its own, so the walk moves straight on
            expect(bulkSell.state).toBe('preparing');
            expect(headline()).toBe('2/2 · Moving on…');
            expect(detail()).toBe('Skipped Golem Essence.');
            wellFormed('skipped by the player');
        });

        test('moving on after a skip that opened nothing: says what was skipped, then the next item', () => {
            bulkSell._prepareCurrent();
            bulkSell._navigatedSinceClick = false;
            bulkSell._skip('skipped');
            expect(bulkSell.state).toBe('preparing');
            expect(headline()).toBe('2/2 · Moving on…');
            expect(detail()).toBe('Skipped Golem Essence.');
            wellFormed('moving on');
        });

        test('dealt with: a short headline; the stack is gone, so nothing to retry', async () => {
            const modal = openModal();
            await reachConfirm();
            vi.advanceTimersByTime(200);
            setStack(0);
            modal.remove();
            vi.advanceTimersByTime(200);
            expect(bulkSell.state).toBe('awaiting_next');
            expect(headline()).toBe('1/2 · Golem Essence dealt with');
            expect(detail()).toBe('Press Next for the next item.');
            expect(retryOffered()).toBe(false);
            wellFormed('dealt with');
        });

        test('some left after a sale: the count in the row, the choice underneath', async () => {
            const modal = openModal();
            await reachConfirm();
            setStack(30000);
            vi.advanceTimersByTime(200);
            setStack(7);
            modal.remove();
            vi.advanceTimersByTime(200);
            expect(headline()).toBe('1/2 · Golem Essence: 7 left after the sale');
            expect(detail()).toBe('Press Sell again for the rest, or Skip to leave it.');
            wellFormed('some left');
        });

        test('waiting on the bag after the window closed', async () => {
            const modal = openModal();
            await reachConfirm();
            setStack(30000);
            vi.advanceTimersByTime(200);
            modal.remove();
            vi.advanceTimersByTime(200);
            expect(bulkSell._afterCloseWatch).not.toBeNull();
            expect(headline()).toBe('1/2 · Golem Essence: checking the bag…');
            expect(detail()).toBe('Waiting for the game to report any sale before moving on.');
            wellFormed('checking the bag');
        });

        test('done: the count in the row, what was left out underneath', () => {
            bulkSell.index = 2;
            bulkSell.lockedSkipped = 12;
            bulkSell._prepareCurrent();
            expect(bulkSell.state).toBe('done');
            expect(headline()).toBe('Done — 2 stacks processed');
            expect(detail()).toBe('12 locked items skipped.');
            wellFormed('done');
            bulkSell.lockedSkipped = 0;
        });
    });

    describe('Retry sits with Skip', () => {
        test('an icon button with a title and an accessible name, in the game look, just before Skip', () => {
            const retry = retryBtn();
            expect(retry.textContent).toBe('↻');
            expect(retry.title).toBeTruthy();
            expect(retry.getAttribute('aria-label')).toBe('Retry this item');
            expect(retry.type).toBe('button');
            // The icon variant of the shared game look, as the ✕ wears it
            expect(retry._restBg).toBe('transparent');
            expect(retry.nextElementSibling).toBe(part('skip'));
            expect(retry.parentElement).toBe(part('skip').parentElement);
        });

        test('it keeps its slot: hidden is never display:none', () => {
            expect(retryBtn().style.visibility).toBe('hidden');
            expect(retryBtn().style.display).toBe('');
        });

        test('offered while a step is open, hidden when idle, stopped, empty or done', async () => {
            expect(retryOffered()).toBe(false);
            bulkSell._prepareCurrent();
            expect(retryOffered()).toBe(true);
            bulkSell._stop('Stopped');
            expect(retryOffered()).toBe(false);
            bulkSell.index = 2;
            bulkSell.queue = [{ itemHrid: GOLEM, enhancementLevel: 0, count: 1, name: 'Golem Essence' }];
            bulkSell._prepareCurrent();
            expect(bulkSell.state).toBe('done');
            expect(retryOffered()).toBe(false);
        });

        test('not offered for a step the game refused on its merits', () => {
            game.locked.add(`${GOLEM}:0`);
            // As a press of Next or Retry leaves it: the click's one action is spent
            bulkSell._navigatedSinceClick = true;
            bulkSell._prepareCurrent();
            expect(bulkSell.statusNote).toBe('locked');
            vi.advanceTimersByTime(1000);
            expect(bulkSell.state).toBe('awaiting_next');
            expect(retryOffered()).toBe(false);
            game.locked.clear();
        });

        test('offered after a window closed without selling: the stack is still all there', async () => {
            const modal = openModal();
            await reachConfirm();
            vi.advanceTimersByTime(200);
            modal.remove();
            vi.advanceTimersByTime(2500);
            expect(bulkSell.state).toBe('awaiting_next');
            expect(headline()).toBe('1/2 · Golem Essence dealt with');
            expect(retryEnabled()).toBe(true);
        });
    });

    describe('what a press of Retry does', () => {
        test('with the modal open: closes it, waits, opens the item again, and sells nothing', async () => {
            const modal = openModal();
            await reachConfirm();
            expect(navigations).toEqual([GOLEM]);

            retryBtn().click();

            expect(closeClicks).toBe(1);
            expect(modal.isConnected).toBe(false);
            expect(gameClicks).toBe(0);
            expect(bulkSell.state).toBe('preparing');
            expect(bulkSell.index).toBe(0);
            expect(headline()).toBe('1/2 · Retrying Golem Essence…');
            // Not yet: the close has to land first
            expect(navigations).toEqual([GOLEM]);

            vi.advanceTimersByTime(600);
            expect(navigations).toEqual([GOLEM, GOLEM]);
            expect(bulkSell.state).toBe('preparing');
            expect(headline()).toBe('1/2 · Checking Golem Essence…');
            expect(gameClicks).toBe(0);
        });

        test('brings the modal back: decides again, and the amount is filled in again', async () => {
            openModal({ qty: 1 });
            await reachConfirm();
            retryBtn().click();
            vi.advanceTimersByTime(600);

            bulkSell._onOrderBook({ marketItemOrderBooks: { itemHrid: GOLEM, orderBooks: [BOOK] } });
            shortcuts.calls.at(-1).resolve();
            await vi.advanceTimersByTimeAsync(0);
            expect(bulkSell.state).toBe('awaiting_confirm');
            expect(bulkSell._confirmedStep).toBeNull();

            const again = openModal({ qty: 0 });
            bulkSell._onModal(again);
            vi.advanceTimersByTime(500);
            expect(again.querySelector('input').value).toBe('27699');
            expect(gameClicks).toBe(0);

            // And the sale is still the player's one press
            part('main').click();
            expect(gameClicks).toBe(1);
        });

        test('while the book never came: the old wait is dead and a new one starts', () => {
            bulkSell._prepareCurrent();
            vi.advanceTimersByTime(2000);
            retryBtn().click();
            vi.advanceTimersByTime(600);
            expect(navigations).toEqual([GOLEM, GOLEM]);
            // 3.1 s after the first attempt began: its 3 s timeout would have skipped the step by now
            vi.advanceTimersByTime(500);
            expect(bulkSell.state).toBe('preparing');
            expect(bulkSell.statusNote).toBe('');
            // The restarted attempt has its own full wait
            vi.advanceTimersByTime(3000);
            expect(bulkSell.state).toBe('awaiting_next');
            expect(bulkSell.statusNote).toBe('no market data');
        });

        test('an opener still waiting from the first attempt does nothing when it times out', async () => {
            bulkSell._prepareCurrent();
            bulkSell._onOrderBook({ marketItemOrderBooks: { itemHrid: GOLEM, orderBooks: [BOOK] } });
            const first = shortcuts.calls.at(-1);
            retryBtn().click();
            expect(first.isCancelled()).toBe(true);
            first.reject(new Error('Timeout'));
            await vi.advanceTimersByTimeAsync(0);
            expect(bulkSell.state).toBe('preparing');
            expect(bulkSell.statusNote).toBe('');
        });

        test('the step failing again waits for Next, and Retry is offered again', () => {
            bulkSell._prepareCurrent();
            vi.advanceTimersByTime(3100);
            expect(retryEnabled()).toBe(true);
            retryBtn().click();
            vi.advanceTimersByTime(600 + 3100);
            expect(bulkSell.state).toBe('awaiting_next');
            expect(bulkSell.index).toBe(0);
            // One book per press, however it ended
            expect(navigations).toEqual([GOLEM, GOLEM]);
            vi.advanceTimersByTime(20000);
            expect(navigations).toEqual([GOLEM, GOLEM]);
            expect(retryEnabled()).toBe(true);
        });

        test('a double press is one restart', () => {
            bulkSell._prepareCurrent();
            vi.advanceTimersByTime(1000);
            retryBtn().click();
            retryBtn().click();
            expect(retryBtn().disabled).toBe(true);
            vi.advanceTimersByTime(600);
            expect(navigations).toEqual([GOLEM, GOLEM]);
        });

        test('the item gone from the bag: the step is skipped, nothing is opened', async () => {
            openModal();
            await reachConfirm();
            setStack(0);
            retryBtn().click();
            vi.advanceTimersByTime(600);
            expect(navigations).toEqual([GOLEM]);
            expect(bulkSell.state).toBe('awaiting_next');
            expect(bulkSell.statusNote).toBe('no longer in inventory');
            expect(bulkSell.index).toBe(0);
            expect(retryOffered()).toBe(false);
            expect(gameClicks).toBe(0);
        });

        test('the stack changed: the restarted step sells it as it stands now', async () => {
            openModal();
            await reachConfirm();
            setStack(30000);
            retryBtn().click();
            vi.advanceTimersByTime(600);
            expect(bulkSell.current.count).toBe(30000);
            expect(navigations).toEqual([GOLEM, GOLEM]);
        });

        test('after the game refused the sale: it comes back, and nothing is sold by the restart', async () => {
            openModal();
            await reachConfirm();
            part('main').click();
            expect(gameClicks).toBe(1);
            // Sent and unanswered: a retry now could offer the stack twice
            expect(retryOffered()).toBe(true);
            expect(retryBtn().disabled).toBe(true);

            notices.handler({ level: 'error', key: 'errorNotification.itemIsLocked', variables: {}, at: Date.now() });
            expect(bulkSell._confirmSent()).toBe(false);
            expect(retryEnabled()).toBe(true);

            retryBtn().click();
            vi.advanceTimersByTime(600);
            expect(navigations).toEqual([GOLEM, GOLEM]);
            expect(gameClicks).toBe(1);
            expect(bulkSell._confirmedStep).toBeNull();
            expect(bulkSell.confirmNote).toBe('');
        });

        test('while the confirm is on its way: nothing happens at all', async () => {
            const modal = openModal();
            await reachConfirm();
            part('main').click();
            const step = bulkSell._confirmedStep;
            expect(retryBtn().disabled).toBe(true);

            retryBtn().click();
            bulkSell._onRetryClick();
            vi.advanceTimersByTime(5000);

            expect(closeClicks).toBe(0);
            expect(modal.isConnected).toBe(true);
            expect(navigations).toEqual([GOLEM]);
            expect(bulkSell._confirmedStep).toBe(step);
            expect(bulkSell.state).toBe('awaiting_confirm');
            expect(gameClicks).toBe(1);
        });

        describe('a sale confirmed in the game’s own modal', () => {
            /** The game's confirm button in an open modal */
            const nativeConfirm = (modal) => modal.querySelector('.Button_button__1Fe9z');

            test('dims Retry and the strip’s Confirm, says so, and a press of Retry does nothing', async () => {
                const modal = openModal();
                await reachConfirm();
                expect(retryEnabled()).toBe(true);

                const click = new MouseEvent('click', { bubbles: true, cancelable: true });
                nativeConfirm(modal).dispatchEvent(click);
                // A passive watch: the game's own handler ran and nothing was prevented
                expect(gameClicks).toBe(1);
                expect(click.defaultPrevented).toBe(false);

                expect(bulkSell._confirmSent()).toBe(true);
                expect(retryOffered()).toBe(true);
                expect(retryBtn().disabled).toBe(true);
                expect(part('main').disabled).toBe(true);
                expect(detail()).toContain('Confirm sent — waiting for the game.');

                retryBtn().click();
                bulkSell._onRetryClick();
                vi.advanceTimersByTime(5000);
                expect(closeClicks).toBe(0);
                expect(modal.isConnected).toBe(true);
                expect(navigations).toEqual([GOLEM]);
                expect(bulkSell.state).toBe('awaiting_confirm');
                // No second sale path: pressing the strip's Confirm now presses nothing
                part('main').click();
                bulkSell._onConfirmClick();
                expect(gameClicks).toBe(1);
            });

            test('a refusal after it frees Retry again, and a second native confirm dims it again', async () => {
                const modal = openModal();
                await reachConfirm();
                nativeConfirm(modal).click();
                expect(retryBtn().disabled).toBe(true);

                notices.handler({
                    level: 'error',
                    key: 'errorNotification.itemIsLocked',
                    variables: {},
                    at: Date.now(),
                });
                expect(bulkSell._confirmSent()).toBe(false);
                expect(retryEnabled()).toBe(true);
                expect(part('main').disabled).toBe(false);
                expect(detail()).not.toContain('Confirm sent');

                // The modal is still open for the player's next try
                nativeConfirm(modal).click();
                expect(gameClicks).toBe(2);
                expect(bulkSell._confirmSent()).toBe(true);
                expect(retryBtn().disabled).toBe(true);
            });

            test('the modal closing with no sale lands: Retry comes back once the late-sale watch is over', async () => {
                const modal = openModal();
                await reachConfirm();
                nativeConfirm(modal).click();
                expect(retryBtn().disabled).toBe(true);

                // Seen open by the watch, then closed, and the inventory never reports a sale
                vi.advanceTimersByTime(250);
                modal.remove();
                vi.advanceTimersByTime(250);
                expect(bulkSell.state).toBe('awaiting_next');
                vi.advanceTimersByTime(2000);
                expect(bulkSell._afterCloseWatch).toBeNull();
                expect(retryEnabled()).toBe(true);

                retryBtn().click();
                vi.advanceTimersByTime(600);
                expect(navigations).toEqual([GOLEM, GOLEM]);
                expect(bulkSell._confirmedStep).toBeNull();
            });

            test('a click on any other button of the modal does not count', async () => {
                const modal = openModal();
                const max = document.createElement('button');
                max.className = 'Button_button__other';
                max.textContent = 'Max';
                modal.appendChild(max);
                await reachConfirm();

                max.click();
                modal.querySelector('input').click();
                modal.querySelector('.MarketplacePanel_header__x').click();
                expect(bulkSell._confirmSent()).toBe(false);
                expect(retryEnabled()).toBe(true);
                expect(gameClicks).toBe(0);
            });

            test('a confirm in a modal for another item, or one the game would not take, does not count', async () => {
                const other = openModal();
                other.querySelector('use').setAttribute('href', '/static/media/items.svg#milk');
                await reachConfirm();
                nativeConfirm(other).click();
                expect(bulkSell._confirmSent()).toBe(false);
                other.remove();

                const empty = openModal({ qty: 0 });
                nativeConfirm(empty).click();
                expect(bulkSell._confirmSent()).toBe(false);
                expect(retryEnabled()).toBe(true);
            });

            test('the listener goes when the modal does, and when the run is stopped', async () => {
                const added = vi.spyOn(document, 'addEventListener');
                const removed = vi.spyOn(document, 'removeEventListener');
                const listeners = () =>
                    new Set(added.mock.calls.filter(([type]) => type === 'click').map(([, fn]) => fn));
                const removedClicks = () =>
                    new Set(removed.mock.calls.filter(([type]) => type === 'click').map(([, fn]) => fn));
                try {
                    const modal = openModal();
                    await reachConfirm();
                    const attached = [...listeners()];
                    expect(attached.length).toBeGreaterThan(0);
                    expect([...removedClicks()].some((fn) => attached.includes(fn))).toBe(false);

                    vi.advanceTimersByTime(250);
                    modal.remove();
                    vi.advanceTimersByTime(250);
                    expect(attached.every((fn) => removedClicks().has(fn))).toBe(true);

                    // And a stop: a fresh step, stopped while its modal is up
                    removed.mockClear();
                    added.mockClear();
                    bulkSell.state = 'preparing';
                    openModal();
                    bulkSell._watchClose();
                    bulkSell.state = 'awaiting_confirm';
                    const second = [...listeners()];
                    expect(second.length).toBeGreaterThan(0);
                    bulkSell._stop('');
                    expect(second.every((fn) => removedClicks().has(fn))).toBe(true);
                } finally {
                    added.mockRestore();
                    removed.mockRestore();
                }
            });
        });

        test('while a vendor arming wait runs: nothing happens, and it frees up when the wait ends', async () => {
            await reachConfirm();
            // The wait redraws the strip itself, so the button is already dimmed when it starts
            const wait = bulkSell._beginVendorWait(bulkSell._stepKey());
            expect(retryBtn().disabled).toBe(true);
            bulkSell._onRetryClick();
            vi.advanceTimersByTime(5000);
            expect(navigations).toEqual([GOLEM]);
            expect(bulkSell.state).toBe('awaiting_confirm');

            bulkSell._endVendorWait(wait);
            expect(retryEnabled()).toBe(true);
        });

        test('a vendor menu is dismissed the way Skip dismisses it', async () => {
            const menu = document.createElement('div');
            menu.className = 'Item_actionMenu__q';
            document.body.appendChild(menu);
            const escapes = vi.fn();
            document.addEventListener('keydown', escapes);
            bulkSell._prepareCurrent();
            retryBtn().click();
            document.removeEventListener('keydown', escapes);
            expect(escapes).toHaveBeenCalledTimes(1);
            expect(escapes.mock.calls[0][0].key).toBe('Escape');
            expect(gameClicks).toBe(0);
        });

        test('from a skipped step: starts it over without moving the queue', () => {
            bulkSell._prepareCurrent();
            vi.advanceTimersByTime(3100);
            expect(bulkSell.statusNote).toBe('no market data');
            retryBtn().click();
            expect(bulkSell.state).toBe('preparing');
            expect(bulkSell.index).toBe(0);
            vi.advanceTimersByTime(600);
            expect(navigations).toEqual([GOLEM, GOLEM]);
            expect(bulkSell.index).toBe(0);
        });

        test('pressed when there is nothing to retry, it does nothing', () => {
            bulkSell._onRetryClick();
            vi.advanceTimersByTime(5000);
            expect(navigations).toEqual([]);
            expect(bulkSell.state).toBe('idle');
        });
    });

    describe('and the ways the run can end under it', () => {
        test('Stop right after Retry: the restart never happens', async () => {
            const modal = openModal();
            await reachConfirm();
            retryBtn().click();
            part('stop').click();
            vi.advanceTimersByTime(20000);

            expect(modal.isConnected).toBe(false);
            expect(navigations).toEqual([GOLEM]);
            expect(bulkSell.state).toBe('idle');
            expect(bulkSell.queue).toEqual([]);
            expect(bulkSell.retryTimeout).toBeNull();
            expect(retryOffered()).toBe(false);
        });

        test('Skip right after Retry: the restart never happens, the walk moves on', async () => {
            openModal();
            await reachConfirm();
            retryBtn().click();
            part('skip').click();
            vi.advanceTimersByTime(700);
            expect(navigations).toEqual([GOLEM, '/items/milk']);
            expect(bulkSell.index).toBe(1);
        });

        test('a character switch right after Retry: the teardown cancels the restart', async () => {
            openModal();
            await reachConfirm();
            retryBtn().click();
            bulkSell.cleanup();
            vi.advanceTimersByTime(20000);
            expect(navigations).toEqual([GOLEM]);
            expect(bulkSell.state).toBe('idle');
            expect(bulkSell.retryTimeout).toBeNull();
            expect(bulkSell.chip).toBeNull();
        });

        test('the setting switched off right after Retry: nothing restarts and the bar is gone', async () => {
            openModal();
            await reachConfirm();
            retryBtn().click();
            settings['market_bulkSellAssistant'] = false;
            bulkSell.disable();
            vi.advanceTimersByTime(20000);
            expect(navigations).toEqual([GOLEM]);
            expect(document.querySelector(`.${CHIP}-retry`)).toBeNull();
            expect(bulkSell.retryTimeout).toBeNull();
        });

        test('the step moved on during the wait: the restart is for a step that is over', async () => {
            openModal();
            await reachConfirm();
            retryBtn().click();
            // Something else moved the walk (the same queue entry swapped under it)
            bulkSell.queue[0] = { ...bulkSell.queue[0], count: 5 };
            bulkSell.current = bulkSell.queue[0];
            vi.advanceTimersByTime(20000);
            expect(navigations).toEqual([GOLEM]);
        });

        test('an order book arriving during the wait belongs to the discarded attempt', async () => {
            openModal();
            await reachConfirm();
            const before = shortcuts.calls.length;
            retryBtn().click();
            bulkSell._onOrderBook({ marketItemOrderBooks: { itemHrid: GOLEM, orderBooks: [BOOK] } });
            expect(shortcuts.calls.length).toBe(before);
        });
    });

    describe('on a phone', () => {
        test('every control is at least 32 px on a touch screen, the icons wide enough as well', () => {
            window.matchMedia = (query) => ({ matches: query.includes('coarse') });
            bulkSell._removePanel();
            bulkSell._buildPanel();
            for (const name of ['main', 'skip', 'retry', 'stop', 'more', 'gear', 'close']) {
                expect(part(name).style.minHeight, name).toBe('32px');
            }
            for (const name of ['retry', 'more', 'gear', 'close']) {
                expect(part(name).style.minWidth, name).toBe('32px');
            }
        });

        test('with a mouse the sizes are left as they were', () => {
            expect(part('retry').style.minHeight).toBe('');
            expect(part('main').style.minHeight).toBe('');
        });

        test('at 412 px the headline takes a row of its own and wraps, losing nothing', () => {
            window.innerWidth = 412;
            bulkSell._removePanel();
            bulkSell._buildPanel();
            const status = part('status');
            expect(status.style.flexBasis).toBe('100%');
            expect(status.style.whiteSpace).toBe('normal');
            expect(status.style.textOverflow).toBe('');
            expect(status.style.width).toBe('');
        });

        test('on a wide screen it keeps its fixed width, and follows a resize either way', () => {
            const status = part('status');
            expect(status.style.width).toBe('340px');
            expect(status.style.whiteSpace).toBe('nowrap');

            window.innerWidth = 400;
            window.dispatchEvent(new Event('resize'));
            expect(status.style.flexBasis).toBe('100%');

            window.innerWidth = 1280;
            window.dispatchEvent(new Event('resize'));
            expect(status.style.width).toBe('340px');
            expect(status.style.whiteSpace).toBe('nowrap');
        });

        test('removing the panel takes the resize listener with it', () => {
            const status = part('status');
            bulkSell._removePanel();
            window.innerWidth = 400;
            window.dispatchEvent(new Event('resize'));
            expect(status.style.flexBasis).not.toBe('100%');
        });
    });
});
