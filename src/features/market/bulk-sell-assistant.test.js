/** @vitest-environment happy-dom
 *
 * Which items a bulk-sell run covers, and the rules it decides by.
 *
 * The selling itself is one game action per click and cannot be tested here.
 * What can — and what a mistake in would sell the wrong things — is the queue:
 * which source was chosen, what that source contains, and what is held back.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ items: [], details: {}, watched: [] }));
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
vi.mock('./marketplace-shortcuts.js', () => ({ default: {} }));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));
vi.mock('../../utils/dom-observer-helpers.js', () => ({
    createMutationWatcher: () => ({ start: () => {}, stop: () => {} }),
}));
vi.mock('../inventory/watchlist.js', () => ({
    watchlistEntries: () => game.watched,
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
    game.watched = [{ itemHrid: '/items/cheese' }, { itemHrid: '/items/sword' }];
    bulkSell.queue = [];
    bulkSell.state = 'idle';
    bulkSell.statusNote = '';
    bulkSell.chip = null;
    bulkSell.holdProviders = new Map();
    bulkSell.selectedTabId = 'all';
});

const queued = () => bulkSell.queue.map((entry) => entry.itemHrid);

describe('selling what the watchlist is tracking', () => {
    test('only the tracked items are queued', async () => {
        bulkSell.selectedTabId = 'watchlist';
        await bulkSell._start();

        expect(queued()).toContain('/items/cheese');
        expect(queued()).not.toContain('/items/milk');
    });

    test('every enhancement level of a tracked item counts', async () => {
        // The watchlist tracks an item, not an item at a level, so "sell what
        // I am watching" means all of it. A tab is the other way round.
        bulkSell.selectedTabId = 'watchlist';
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
        bulkSell.holdProviders.set('flips', () => ['/items/cheese']);
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
        game.watched.push({ itemHrid: '/items/bound' });
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
