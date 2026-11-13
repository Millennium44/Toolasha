/** @vitest-environment happy-dom
 *
 * The overlay's Consumables tile while a skill is running.
 *
 * Combat and idle keep the tile as it was (the sibling test file holds that); here the tile shows
 * the slotted teas in two lines, and each way it can end says so rather than drawing a zero.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const FORAGING = '/action_types/foraging';
const MINUTE_NS = 60_000_000_000;
const INV = '/item_locations/inventory';

const game = vi.hoisted(() => ({
    items: {},
    inventory: [],
    clientData: null,
    characterData: null,
    actions: [],
    actionDetails: {},
    slots: {},
    prices: {},
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: (hrid) => game.items[hrid],
        getActionDetails: (hrid) => game.actionDetails[hrid] || null,
        getActionDrinkSlots: (type) => game.slots[type] || [],
        getInventory: () => game.inventory,
        getCurrentActions: () => game.actions,
        getInitClientData: () => game.clientData,
        get characterData() {
            return game.characterData;
        },
        getCurrentCharacterId: () => 'char1',
        getCurrentCharacterGameMode: () => 'standard',
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrices: (hrid) => game.prices[hrid] ?? null,
    getItemPrice: (hrid) => game.prices[hrid]?.ask ?? null,
    getItemPriceInfo: (hrid) => ({ price: game.prices[hrid]?.ask ?? null, estimated: false }),
}));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));
vi.mock('../../utils/action-context.js', () => ({
    resolveActionContext: () => ({ equipment: new Map(), drinks: [] }),
}));
vi.mock('../../utils/tea-parser.js', () => ({ getDrinkConcentration: () => 0 }));
vi.mock('./combat-stats-data-collector.js', () => ({ default: { getLatestData: () => null } }));
vi.mock('./combat-stats-calculator.js', () => ({
    valueOfLoot: () => ({ ask: 0, bid: 0, value: 0 }),
    calculatePlayerStats: () => ({}),
    describeLuckAdjustment: () => '',
}));
vi.mock('../../utils/consumable-target.js', () => ({
    currentTarget: () => ({ seconds: 86400 }),
    loadTarget: () => {},
}));

const { registeredRows } = await import('../../utils/overlay-rows.js');
await import('./combat-stats-rows.js');

const tile = () => registeredRows().find((row) => row.key === 'consumables');
const draw = () => {
    const container = document.createElement('div');
    tile().render(container);
    return container;
};

const tea = (name, minutes) => ({ name, consumableDetail: { buffs: [{ duration: minutes * MINUTE_NS }] } });
const slot = (itemHrid, extra = {}) => ({
    actionTypeHrid: FORAGING,
    characterID: 1,
    consumableSlotTypeHrid: '/consumable_slot_types/drink',
    duration: 0,
    isActive: true,
    itemHrid,
    slotIndex: 0,
    ...extra,
});
const stack = (itemHrid, count) => ({ itemHrid, count, itemLocationHrid: INV, enhancementLevel: 0 });
const run = (actionHrid, type) => {
    game.actions = [{ actionHrid, isDone: false, ordinal: 1 }];
    game.actionDetails[actionHrid] = { type };
};
const runForaging = () => run('/actions/foraging/farmland', FORAGING);

beforeEach(() => {
    game.items = {
        '/items/gathering_tea': tea('Gathering Tea', 5),
        '/items/efficiency_tea': tea('Efficiency Tea', 5),
        '/items/mystery_tea': { name: 'Mystery Tea' },
    };
    game.inventory = [];
    game.clientData = { itemDetailMap: game.items };
    game.characterData = { noncombatStats: { drinkConcentration: 0.129 } };
    game.actions = [];
    game.actionDetails = {};
    game.slots = {};
    game.prices = {};
});

describe('the skilling tile', () => {
    test('two lines: your time and the ask per day, then the tea that stops you', () => {
        runForaging();
        game.slots[FORAGING] = [slot('/items/gathering_tea', { duration: 60 * 1e9 }), null, null];
        game.inventory = [stack('/items/gathering_tea', 100)];
        game.prices['/items/gathering_tea'] = { ask: 1000, bid: 900 };

        const container = draw();
        expect(container.children).toHaveLength(2);
        const first = container.children[0].textContent;
        // 100 teas at 265.7 s each plus the running minute: 7h 23m (26,630 s)
        expect(first).toContain('You:');
        expect(first).toContain('7h 23m');
        expect(first).toContain('Ask 325.15K/day');
        expect(container.children[1].textContent).toContain('100');
        expect(container.children[1].textContent).toContain('Gathering Tea');
        expect(container.textContent).not.toContain('Party');
        expect(container.title).toContain('Foraging teas');
        expect(container.title).toContain('Both assume it runs continuously');
    });

    test('an unpriced tea is flagged on the line, not folded into the figure as free', () => {
        runForaging();
        game.slots[FORAGING] = [slot('/items/gathering_tea'), slot('/items/efficiency_tea', { slotIndex: 1 })];
        game.inventory = [stack('/items/gathering_tea', 50), stack('/items/efficiency_tea', 50)];
        game.prices['/items/gathering_tea'] = { ask: 1000, bid: 900 };

        expect(draw().children[0].textContent).toContain('1 unpriced');
    });

    test('the line wraps and the unpriced note can break, so a narrow tile never cuts the flag off', () => {
        runForaging();
        game.slots[FORAGING] = [slot('/items/gathering_tea'), slot('/items/efficiency_tea', { slotIndex: 1 })];
        game.inventory = [stack('/items/gathering_tea', 50), stack('/items/efficiency_tea', 50)];
        game.prices['/items/gathering_tea'] = { ask: 1000, bid: 900 };

        const first = draw().children[0];
        expect(first.style.flexWrap).toBe('wrap');
        const ask = [...first.children].find((span) => span.textContent.includes('unpriced'));
        expect(ask.style.whiteSpace).toBe('normal');
        expect(ask.style.maxWidth).toBe('100%');
    });

    test('nothing priced at all shows a dash, never zero', () => {
        runForaging();
        game.slots[FORAGING] = [slot('/items/gathering_tea')];
        game.inventory = [stack('/items/gathering_tea', 50)];

        const first = draw().children[0].textContent;
        expect(first).toContain('Ask —/day');
        expect(first).toContain('1 unpriced');
    });

    test('a tea with no rate says rate unknown', () => {
        runForaging();
        game.slots[FORAGING] = [slot('/items/mystery_tea')];
        game.inventory = [stack('/items/mystery_tea', 5)];

        const container = draw();
        expect(container.children[0].textContent).toContain('rate unknown');
        expect(container.children[1].textContent).toContain('Mystery Tea · rate unknown');
    });

    test('a tea held at zero is the limiting tea at zero, not hidden', () => {
        runForaging();
        game.slots[FORAGING] = [slot('/items/gathering_tea', { isActive: false })];
        game.prices['/items/gathering_tea'] = { ask: 1000, bid: 900 };

        const container = draw();
        expect(container.children[0].textContent).toContain('0s');
        expect(container.children[1].textContent).toContain('0');
        expect(container.children[1].textContent).toContain('Gathering Tea');
    });

    test('nothing slotted is the blank tile', () => {
        runForaging();
        game.slots[FORAGING] = [null, null];

        const container = draw();
        expect(container.textContent).toBe('');
        expect(tile().empty).toContain('teas');
        expect(tile().version()).toBe('skilling-blank');
    });

    test('no character data yet is blank, not a zeroed tile', () => {
        runForaging();
        game.characterData = null;
        game.slots[FORAGING] = [slot('/items/gathering_tea')];

        expect(draw().textContent).toBe('');
    });

    test('a queued skill behind a running fight leaves the tile to combat', () => {
        game.actions = [
            { actionHrid: '/actions/foraging/farmland', isDone: false, ordinal: 5 },
            { actionHrid: '/actions/combat/fly', isDone: false, ordinal: 1 },
        ];
        game.actionDetails['/actions/foraging/farmland'] = { type: FORAGING };
        game.actionDetails['/actions/combat/fly'] = { type: '/action_types/combat' };
        game.slots[FORAGING] = [slot('/items/gathering_tea')];

        expect(tile().version()).toBe('blank');
    });

    test('nothing running leaves the tile to combat', () => {
        game.slots[FORAGING] = [slot('/items/gathering_tea')];
        expect(tile().version()).toBe('blank');
    });
});

describe('the version', () => {
    const base = () => {
        runForaging();
        game.slots[FORAGING] = [slot('/items/gathering_tea', { duration: 60 * 1e9 })];
        game.inventory = [stack('/items/gathering_tea', 100)];
        game.prices['/items/gathering_tea'] = { ask: 1000, bid: 900 };
        return tile().version();
    };

    test('moves when the activity changes', () => {
        const before = base();
        game.slots['/action_types/woodcutting'] = [slot('/items/gathering_tea')];
        run('/actions/woodcutting/tree', '/action_types/woodcutting');
        expect(tile().version()).not.toBe(before);
    });

    test('moves when the tea set changes', () => {
        const before = base();
        game.slots[FORAGING] = [slot('/items/efficiency_tea')];
        game.inventory = [stack('/items/efficiency_tea', 100)];
        expect(tile().version()).not.toBe(before);
    });

    test('moves when the rounded time changes, and holds when nothing does', () => {
        const before = base();
        expect(tile().version()).toBe(before);
        game.inventory = [stack('/items/gathering_tea', 200)];
        expect(tile().version()).not.toBe(before);
    });

    test('moves when a price arrives', () => {
        const before = base();
        game.prices['/items/gathering_tea'] = { ask: 2000, bid: 900 };
        expect(tile().version()).not.toBe(before);
    });
});
