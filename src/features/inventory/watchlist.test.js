/**
 * @vitest-environment happy-dom
 *
 * The Watchlist panel, built rather than reasoned about.
 *
 * The set algebra and the drop-table walking are tested where they live. What
 * only building the panel catches is the joins: that ticking a checkbox reaches
 * the list, that a row draws for an item the character does not hold, and that
 * every section draws at all.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ data: {}, inventory: [], prices: {} }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.data,
        getInventory: () => game.inventory,
        getItemDetails: (hrid) => game.data.itemDetailMap?.[hrid],
    },
}));

vi.mock('../../core/storage.js', () => ({
    default: { getJSON: async () => null, setJSON: async () => {} },
}));

vi.mock('../../utils/panel-geometry.js', () => ({ restoreGeometry: () => {}, saveGeometry: () => {} }));
vi.mock('../../utils/market-data.js', () => ({ getItemPrices: (hrid) => game.prices[hrid] || null }));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));
vi.mock('./inventory-badge-manager.js', () => ({
    default: { registerProvider: () => {}, unregisterProvider: () => {}, invalidateCache: () => {} },
}));

const { watchlistPanel, watchlistRows, watchItem, isWatched, watchlistEntries, clearWatchlist } =
    await import('./watchlist.js');

const itemDetailMap = {
    '/items/coin': { name: 'Coin' },
    '/items/cheese': { name: 'Cheese', sellPrice: 10 },
    '/items/rare_hat': { name: 'Rare Hat', sellPrice: 5000 },
    '/items/trainee_charm': { name: 'Trainee Charm', sellPrice: 250000 },
    '/items/purples_gift': { name: "Purple's Gift", sellPrice: 100 },
};

beforeEach(() => {
    game.data = {
        itemDetailMap,
        actionDetailMap: {
            '/actions/combat/rat_hole': {
                name: 'Rat Hole',
                combatZoneInfo: {
                    fightInfo: { randomSpawnInfo: { spawns: [{ combatMonsterHrid: '/monsters/rat' }] } },
                },
            },
        },
        combatMonsterDetailMap: {
            '/monsters/rat': {
                dropTable: [{ itemHrid: '/items/cheese' }, { itemHrid: '/items/coin' }],
                rareDropTable: [{ itemHrid: '/items/rare_hat' }],
            },
        },
        openableLootDropMap: { '/items/purples_gift': [{ itemHrid: '/items/rare_hat' }] },
    };
    game.inventory = [{ itemHrid: '/items/cheese', count: 40 }];
    game.prices = {
        '/items/cheese': { ask: 100, bid: 90 },
        '/items/rare_hat': { ask: 20000, bid: 400 },
        '/items/trainee_charm': { ask: 0, bid: 0 },
    };
});

afterEach(() => {
    watchlistPanel.hide();
    clearWatchlist();
    watchlistPanel.collapsed = { zones: true, chests: true };
});

const text = () => watchlistPanel.panel.textContent;
const FAILED = 'could not be drawn';
const checkboxes = () => [...watchlistPanel.panel.querySelectorAll('input[type="checkbox"]')];

describe('the panel renders', () => {
    test('every section draws, and none of them fails', () => {
        watchItem('/items/cheese');
        watchlistPanel.show();

        expect(text()).toContain('Zones');
        expect(text()).toContain('Chests');
        expect(text()).toContain('Cheese');
        expect(text()).not.toContain(FAILED);
    });

    test('an empty list says how to fill it rather than showing nothing', () => {
        watchlistPanel.show();
        expect(text()).toContain('tick a zone');
        expect(text()).not.toContain(FAILED);
    });

    test('it draws before the game has sent anything', () => {
        game.data = {};
        watchlistPanel.show();
        expect(text()).not.toContain(FAILED);
    });

    test('opening it twice does not build a second one', () => {
        watchlistPanel.show();
        watchlistPanel.show();
        expect(document.querySelectorAll('#toolasha-watchlist-panel')).toHaveLength(1);
    });
});

describe('ticking a zone', () => {
    test('adds everything it drops, coins excluded', () => {
        watchlistPanel.show();
        watchlistPanel.collapsed.zones = false;
        watchlistPanel._render();

        const box = checkboxes()[0];
        box.checked = true;
        box.dispatchEvent(new Event('change'));

        const tracked = watchlistEntries().map((entry) => entry.hrid);
        expect(tracked).toContain('/items/cheese');
        expect(tracked).toContain('/items/rare_hat');
        expect(tracked).not.toContain('/items/coin');
    });

    test('un-ticking it takes them off again', () => {
        watchlistPanel.show();
        watchlistPanel.collapsed.zones = false;
        watchlistPanel._render();

        const tick = () => {
            const box = checkboxes()[0];
            box.checked = !box.checked;
            box.dispatchEvent(new Event('change'));
        };
        tick();
        expect(watchlistEntries().length).toBeGreaterThan(0);

        tick();
        expect(watchlistEntries()).toEqual([]);
    });

    test('an item added by hand survives un-ticking the zone that also has it', () => {
        // It was never the zone's to take
        watchItem('/items/cheese');
        watchlistPanel.show();
        watchlistPanel.collapsed.zones = false;
        watchlistPanel._render();

        const box = checkboxes()[0];
        box.checked = true;
        box.dispatchEvent(new Event('change'));
        box.checked = false;
        box.dispatchEvent(new Event('change'));

        expect(watchlistEntries().map((entry) => entry.hrid)).toEqual(['/items/cheese']);
    });
});

describe('the rows', () => {
    test('an item you hold none of is still a row, since that is the point', () => {
        watchItem('/items/rare_hat');
        watchlistPanel.show();

        expect(text()).toContain('Rare Hat');
        const row = watchlistRows().find((entry) => entry.hrid === '/items/rare_hat');
        expect(row.quantity).toBe(0);
    });

    test('the held count sums every stack rather than reporting one', () => {
        // The same item at two enhancement levels is two inventory entries
        game.inventory = [
            { itemHrid: '/items/cheese', count: 40 },
            { itemHrid: '/items/cheese', count: 2 },
        ];
        watchItem('/items/cheese');
        expect(watchlistRows()[0].quantity).toBe(42);
    });

    test('a bid below the vendor price is flagged, and the vendor price is used', () => {
        // Rare Hat bids 400 against a 5,000 vendor price
        watchItem('/items/rare_hat');
        game.inventory = [{ itemHrid: '/items/rare_hat', count: 2 }];

        const row = watchlistRows()[0];
        expect(row.flag).toBe('below-vendor');
        expect(row.totalBid).toBe(10000);

        watchlistPanel.show();
        expect(text()).toContain('⚠');
    });

    test('an item with no market at all reports what the vendor pays', () => {
        watchItem('/items/trainee_charm');
        game.inventory = [{ itemHrid: '/items/trainee_charm', count: 1 }];

        const row = watchlistRows()[0];
        expect(row.flag).toBe('no-market');
        expect(row.totalBid).toBe(250000);
    });

    test('removing a row takes it off the list', () => {
        watchItem('/items/cheese');
        watchlistPanel.show();

        watchlistPanel.panel.querySelector('[data-remove-item="/items/cheese"]').click();

        expect(isWatched('/items/cheese')).toBe(false);
    });
});

describe('clearing', () => {
    test('empties the list and unticks the sets together', () => {
        // Leaving the boxes ticked would have every checkbox claiming to have
        // put rows on a list with no rows on it
        watchlistPanel.show();
        watchlistPanel.collapsed.zones = false;
        watchlistPanel._render();

        const box = checkboxes()[0];
        box.checked = true;
        box.dispatchEvent(new Event('change'));
        expect(watchlistEntries().length).toBeGreaterThan(0);

        watchlistPanel.panel.querySelector('[data-clear-all]').click();

        expect(watchlistEntries()).toEqual([]);
        expect(checkboxes()[0].checked).toBe(false);
    });
});

describe('the header', () => {
    test('counts what is held against what is tracked', () => {
        watchItem('/items/cheese');
        watchItem('/items/rare_hat');
        watchlistPanel.show();

        // Cheese is held, the hat is not
        expect(watchlistPanel.headerCount.textContent).toBe('1 / 2');
    });
});
