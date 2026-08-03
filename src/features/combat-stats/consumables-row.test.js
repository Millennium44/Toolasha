/** @vitest-environment happy-dom
 *
 * The Consumables tile, built rather than reasoned about.
 *
 * The forecasting is tested where it lives. What building this catches is the
 * shape of what it is handed — a party with nobody in it, an item the game data
 * has never heard of — and that the tile says which consumable is the problem,
 * which is the whole reason to look at it.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ outlook: null, items: {} }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: (hrid) => game.items[hrid],
        getCurrentActions: () => [],
        getInitClientData: () => ({}),
    },
}));
vi.mock('../../utils/market-data.js', () => ({ getItemPrices: () => ({}) }));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));
vi.mock('./combat-stats-data-collector.js', () => ({ default: { getLatestData: () => null } }));
vi.mock('./combat-stats-calculator.js', () => ({ calculatePlayerStats: () => ({}) }));
vi.mock('../../utils/consumable-forecast.js', () => ({
    forecastAll: () => [],
    drinkRatePerDay: () => 0,
    costPerDaySides: () => ({ ask: 14_100_000, bid: 13_600_000 }),
    partyOutlook: () => game.outlook,
}));

const { registeredRows } = await import('../../utils/overlay-rows.js');
await import('./combat-stats-rows.js');

const tile = () => registeredRows().find((row) => row.key === 'consumables');

const draw = () => {
    const container = document.createElement('div');
    tile().render(container);
    return container;
};

beforeEach(() => {
    game.items = { '/items/purples_gift': { name: "Purple's Gift" } };
    game.outlook = {
        you: { itemHrid: '/items/purples_gift', held: 3170, secondsLeft: 165_000 },
        party: null,
        partyName: null,
    };
});

describe('the tile', () => {
    test('names the consumable that runs out first', () => {
        // "3.17K remaining" never said *which*, which is the one thing the tile
        // is for — you cannot top up a number
        expect(draw().textContent).toContain("Purple's Gift");
    });

    test('the count is exact, because it is a stock figure and not a sum of money', () => {
        expect(draw().textContent).toContain('3,170');
        expect(draw().textContent).not.toContain('3.17K');
    });

    test('and the day’s cost is on the tile, both sides of the book', () => {
        const text = draw().textContent;
        expect(text).toContain('Total Cost/Day:');
        expect(text).toContain('Ask:');
        expect(text).toContain('Bid:');
    });

    test('an item the game data has never heard of still reads as something', () => {
        // Drop and shop data outrun the item map after an update
        game.items = {};
        expect(draw().textContent).toContain('purples gift');
    });

    test('nothing slotted draws nothing rather than failing', () => {
        game.outlook = { you: null, party: null, partyName: null };
        expect(() => draw()).not.toThrow();
    });
});
