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

const game = vi.hoisted(() => ({ outlook: null, items: {}, sides: {} }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: (hrid) => game.items[hrid],
        getCurrentActions: () => [],
        getInitClientData: () => ({}),
        // The consumable target is stored per character, so the module that
        // holds it subscribes to the switch
        getCurrentCharacterId: () => 'char1',
        getCurrentCharacterGameMode: () => 'standard',
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../utils/market-data.js', () => ({ getItemPrices: () => ({}) }));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));
vi.mock('./combat-stats-data-collector.js', () => ({ default: { getLatestData: () => null } }));
vi.mock('./combat-stats-calculator.js', () => ({
    valueOfLoot: () => ({ ask: 0, bid: 0, value: 0 }),
    calculatePlayerStats: () => ({}),
    describeLuckAdjustment: () => '',
}));
vi.mock('../../utils/consumable-forecast.js', () => ({
    forecastAll: () => [],
    firstToRunOut: () => null,
    drinkRatePerDay: () => 0,
    costPerDaySides: () => game.sides,
    partyOutlook: () => game.outlook,
}));

const { registeredRows } = await import('../../utils/overlay-rows.js');
const { warmingUp } = await import('./combat-stats-rows.js');

const tile = () => registeredRows().find((row) => row.key === 'consumables');

const draw = () => {
    const container = document.createElement('div');
    tile().render(container);
    return container;
};

beforeEach(() => {
    game.sides = { ask: 14_100_000, bid: 13_600_000, askUnpriced: 0, bidUnpriced: 0 };
    game.items = { '/items/purples_gift': { name: "Purple's Gift" } };
    game.outlook = {
        you: { itemHrid: '/items/purples_gift', held: 3170, rateKnown: true, secondsLeft: 165_000 },
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

    test('the tile is two lines: the Ask day cost on the first, the limiting item on the second', () => {
        const lines = draw().children;
        expect(lines).toHaveLength(2);
        expect(lines[0].textContent).toContain('You:');
        expect(lines[0].textContent).toContain('Party:');
        expect(lines[0].textContent).toContain('Ask 14.10M/day');
        expect(lines[1].textContent).toContain("Purple's Gift");
        expect(draw().textContent).not.toContain('Total Cost');
    });

    test('the first line wraps so a narrow tile moves the Ask figure down instead of clipping its flag', () => {
        game.sides = { ask: 14_100_000, bid: 13_600_000, askUnpriced: 2, bidUnpriced: 0 };
        const first = draw().children[0];
        expect(first.style.flexWrap).toBe('wrap');
        const ask = [...first.children].find((span) => span.textContent.startsWith('Ask'));
        expect(ask.textContent).toBe('Ask 14.10M/day*');
        expect(ask.style.maxWidth).toBe('100%');
    });

    test('the Bid side and the wording are in the tooltip', () => {
        const title = draw().title;
        expect(title).toContain('Total cost per day');
        expect(title).toContain('Ask: 14.10M');
        expect(title).toContain('Bid: 13.60M');
    });

    test('an unpriced item flags the Ask figure on the tile itself', () => {
        expect(draw().textContent).not.toContain('*');
        game.sides = { ask: 14_100_000, bid: 13_600_000, askUnpriced: 2, bidUnpriced: 0 };
        expect(draw().textContent).toContain('Ask 14.10M/day*');
        expect(draw().title).toContain('Ask: 14.10M (2 unpriced)');
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

describe('warming up', () => {
    test('a dungeon with no chest dropped yet is warming up', () => {
        expect(warmingUp({ isDungeonRun: true, keyBreakdown: [] })).toBe(true);
    });

    test('the first chest ends it', () => {
        expect(warmingUp({ isDungeonRun: true, keyBreakdown: [{ itemHrid: '/items/chimerical_entry_key' }] })).toBe(
            false
        );
    });

    test('a zone is never warming up — its loot flows from the first kill', () => {
        expect(warmingUp({ isDungeonRun: false, keyBreakdown: [] })).toBe(false);
        expect(warmingUp(null)).toBe(false);
    });
});
