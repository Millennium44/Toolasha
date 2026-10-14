/** @vitest-environment happy-dom */
/**
 * The held-stack total under a token tooltip's shop table.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({ handler: null, prices: {}, inventory: [], ev: {}, extraTaskShop: {} }));

vi.mock('../../core/config.js', () => ({
    default: { isFeatureEnabled: () => true, getSetting: () => true, COLOR_TOOLTIP_INFO: '#abc' },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (_name, _classes, callback) => {
            state.handler = callback;
            return () => {};
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInventory: () => state.inventory,
        getInitClientData: () => ({
            itemDetailMap: {
                '/items/labyrinth_token': { name: 'Labyrinth Token' },
                '/items/pathseeker_lodestone': { name: 'Pathseeker Lodestone' },
                '/items/labyrinth_essence': { name: 'Labyrinth Essence' },
                '/items/task_token': { name: 'Task Token' },
                '/items/task_crystal': { name: 'Task Crystal' },
                '/items/large_treasure_chest': { name: 'Large Treasure Chest', isOpenable: true },
            },
            taskShopItemDetailMap: {
                chest: { itemHrid: '/items/large_treasure_chest', cost: { itemHrid: '/items/task_token', count: 10 } },
                ...state.extraTaskShop,
            },
            labyrinthShopItemDetailMap: {
                lodestone: {
                    itemHrid: '/items/pathseeker_lodestone',
                    cost: { itemHrid: '/items/labyrinth_token', count: 1000 },
                },
                essence: {
                    itemHrid: '/items/labyrinth_essence',
                    cost: { itemHrid: '/items/labyrinth_token', count: 1 },
                    outputCount: 10,
                },
            },
        }),
    },
}));
vi.mock('../../utils/market-data.js', () => ({ getItemPrices: (hrid) => state.prices[hrid] || null }));
vi.mock('../market/expected-value-calculator.js', () => ({
    default: { calculateExpectedValue: (hrid) => state.ev[hrid] || null },
}));
vi.mock('../../utils/dom.js', () => ({
    default: {
        fixTooltipOverflow: vi.fn(),
        createStyledDiv: (_style, _text, className) => {
            const div = document.createElement('div');
            div.className = className;
            return div;
        },
    },
}));

const { default: feature } = await import('./dungeon-token-tooltips.js');
const { default: tooltipObserver } = await import('../../core/tooltip-observer.js');

/**
 * @param {string} amountText - The game's "Amount:" line
 * @returns {HTMLElement}
 */
function labyrinthTooltip(amountText, name = 'Labyrinth Token') {
    const el = document.createElement('div');
    el.className = 'MuiTooltip-popper';
    el.innerHTML = `<div class="MuiTooltip-tooltip"><div class="ItemTooltipText_itemTooltipText__x">
        <div class="ItemTooltipText_name__2JAHA"><span>${name}</span></div>
        <div>${amountText}</div></div></div>`;
    document.body.appendChild(el);
    return el;
}

beforeEach(async () => {
    document.body.innerHTML = '';
    state.inventory = [];
    state.ev = {};
    state.extraTaskShop = {};
    state.prices = {
        '/items/pathseeker_lodestone': { ask: 6_800_000, bid: 6_000_000 },
        '/items/labyrinth_essence': { ask: 100, bid: 90 },
    };
    await feature.initialize();
});

afterEach(() => {
    feature.cleanup();
    tooltipObserver.disable();
});

describe('held token total', () => {
    test('totals the stack at the best Gold/Token row', async () => {
        const el = labyrinthTooltip('Amount: 22,657');
        state.handler(el);
        await Promise.resolve();
        const text = el.querySelector('.dungeon-token-shop-injected').textContent;
        // 22,657 × 6,800 = 154,067,600; the essence row (1,000/token) loses
        expect(text).toContain(
            'Your 22,657 tokens ≈ 150.3M as 22 × Pathseeker Lodestone + 657 tokens as Labyrinth Essence'
        );
    });

    test('names the cap and market caveat in a title', async () => {
        const el = labyrinthTooltip('Amount: 22,657');
        state.handler(el);
        await Promise.resolve();
        const line = [...el.querySelectorAll('.dungeon-token-shop-injected div')].find((d) =>
            d.textContent.startsWith('Your')
        );
        expect(line.getAttribute('title')).toMatch(/cap/);
    });

    test('a different best row is the one used', async () => {
        state.prices['/items/labyrinth_essence'] = { ask: 900, bid: 800 };
        const el = labyrinthTooltip('Amount: 100');
        state.handler(el);
        await Promise.resolve();
        // Essence: 900 × 10 / 1 = 9,000/token beats the lodestone's 6,800
        expect(el.querySelector('.dungeon-token-shop-injected').textContent).toContain(
            'Your 100 tokens ≈ 900.0K as 1,000 × Labyrinth Essence'
        );
    });

    test('no Amount line, no total', async () => {
        const el = labyrinthTooltip('');
        state.handler(el);
        await Promise.resolve();
        expect(el.querySelector('.dungeon-token-shop-injected').textContent).not.toContain('Your ');
    });
});

describe('held count from game state', () => {
    test('a non-English tooltip with no "Amount:" text still gets the total', async () => {
        state.inventory = [
            { itemHrid: '/items/labyrinth_token', itemLocationHrid: '/item_locations/inventory', count: 22657 },
        ];
        const el = labyrinthTooltip('数量: 22,657');
        state.handler(el);
        await Promise.resolve();
        expect(el.querySelector('.dungeon-token-shop-injected').textContent).toContain(
            'Your 22,657 tokens ≈ 150.3M as 22 × Pathseeker Lodestone'
        );
    });

    test('the inventory count wins over the tooltip text', async () => {
        state.inventory = [
            { itemHrid: '/items/labyrinth_token', itemLocationHrid: '/item_locations/inventory', count: 100 },
        ];
        const el = labyrinthTooltip('Amount: 22,657');
        state.handler(el);
        await Promise.resolve();
        expect(el.querySelector('.dungeon-token-shop-injected').textContent).toContain('Your 100 tokens');
    });

    test('the title states its basis and makes no net-worth match claim', async () => {
        const el = labyrinthTooltip('Amount: 22,657');
        state.handler(el);
        await Promise.resolve();
        const line = [...el.querySelectorAll('.dungeon-token-shop-injected div')].find((d) =>
            d.textContent.startsWith('Your')
        );
        expect(line.getAttribute('title')).toContain('ask price before tax');
        expect(line.getAttribute('title')).not.toContain('counts tokens at this same');
    });
});

describe('whole purchases', () => {
    test('999 tokens against a 1,000-token row do not buy a near-whole lodestone', async () => {
        const el = labyrinthTooltip('Amount: 999');
        state.handler(el);
        await Promise.resolve();
        // Only the 1-token essence row is affordable: 999 x 1,000 = 999.0K, not ~6.8M
        const text = el.querySelector('.dungeon-token-shop-injected').textContent;
        expect(text).toContain('Your 999 tokens ≈ 999.0K as 9,990 × Labyrinth Essence');
        expect(text).not.toContain('Pathseeker Lodestone (');
    });

    test('a row that hands over several items per token shows the item count', async () => {
        const el = labyrinthTooltip('Amount: 5');
        state.handler(el);
        await Promise.resolve();
        // 5 purchases of 10 essences each: 50 items, not 5
        expect(el.querySelector('.dungeon-token-shop-injected').textContent).toContain('as 50 × Labyrinth Essence');
    });

    test('an exact multiple spends everything on the best row', async () => {
        const el = labyrinthTooltip('Amount: 2,000');
        state.handler(el);
        await Promise.resolve();
        const text = el.querySelector('.dungeon-token-shop-injected').textContent;
        expect(text).toContain('Your 2,000 tokens ≈ 13.6M as 2 × Pathseeker Lodestone');
        expect(text).not.toContain('unspent');
        expect(text).not.toContain(' + ');
    });
});

describe('price basis wording follows the winning row', () => {
    const titleOf = (el) =>
        [...el.querySelectorAll('.dungeon-token-shop-injected div')]
            .find((d) => d.textContent.startsWith('Your'))
            .getAttribute('title');

    beforeEach(() => {
        state.prices['/items/large_treasure_chest'] = { ask: 1000, bid: 900 };
    });

    test('an expected-value row says so, not "ask price"', async () => {
        state.ev['/items/large_treasure_chest'] = { expectedValue: 50_000, isPartial: false };
        const el = labyrinthTooltip('Amount: 25', 'Task Token');
        state.handler(el);
        await Promise.resolve();
        expect(titleOf(el)).toContain('expected value of its contents');
        expect(titleOf(el)).not.toContain('ask price');
        expect(titleOf(el)).not.toContain('lower bound');
    });

    test('a partial expected value is flagged as a lower bound', async () => {
        state.ev['/items/large_treasure_chest'] = { expectedValue: 50_000, isPartial: true };
        const el = labyrinthTooltip('Amount: 25', 'Task Token');
        state.handler(el);
        await Promise.resolve();
        expect(titleOf(el)).toContain('lower bound');
    });

    test('a market row keeps the ask-before-tax wording', async () => {
        state.ev = {};
        const el = labyrinthTooltip('Amount: 25', 'Task Token');
        state.handler(el);
        await Promise.resolve();
        expect(titleOf(el)).toContain('ask price before tax');
    });

    describe('basis follows the rows actually bought', () => {
        const crystal = (cost) => ({
            crystal: { itemHrid: '/items/task_crystal', cost: { itemHrid: '/items/task_token', count: cost } },
        });

        beforeEach(() => {
            state.prices['/items/task_crystal'] = { ask: 300, bid: 250 };
            state.ev['/items/large_treasure_chest'] = { expectedValue: 50_000, isPartial: true };
        });

        test('an unaffordable expected-value leader does not label a market-only purchase', async () => {
            // Chest (EV) costs 30 and leads the table; 20 tokens can only buy crystals
            state.extraTaskShop = {
                chest: { itemHrid: '/items/large_treasure_chest', cost: { itemHrid: '/items/task_token', count: 30 } },
                ...crystal(10),
            };
            const el = labyrinthTooltip('Amount: 20', 'Task Token');
            state.handler(el);
            await Promise.resolve();
            expect(titleOf(el)).toContain('ask price before tax');
            expect(titleOf(el)).not.toContain('expected value');
            expect(titleOf(el)).not.toContain('lower bound');
        });

        test('a purchase mixing both says so and flags a partial expected value', async () => {
            // 25 tokens: 2 chests (EV) for 20, then 1 crystal (ask) for 3
            state.extraTaskShop = crystal(3);
            const el = labyrinthTooltip('Amount: 25', 'Task Token');
            state.handler(el);
            await Promise.resolve();
            expect(titleOf(el)).toContain(
                'ask price before tax, and the expected value of contents for openable items'
            );
            expect(titleOf(el)).toContain('lower bound');
        });
    });

    describe('task shop rows that hand over several items', () => {
        test('a bulk row is valued per purchase for ranking, the total and the item count', async () => {
            state.prices['/items/task_crystal'] = { ask: 300, bid: 250 };
            state.prices['/items/large_treasure_chest'] = { ask: 1, bid: 1 };
            state.ev['/items/large_treasure_chest'] = { expectedValue: 5000, isPartial: false };
            state.extraTaskShop = {
                // 5000 / 100 = 50 per token; the crystal is 300 / 10 = 30 per token per unit, but 150 for 5 units
                chest: { itemHrid: '/items/large_treasure_chest', cost: { itemHrid: '/items/task_token', count: 100 } },
                crystal: {
                    itemHrid: '/items/task_crystal',
                    cost: { itemHrid: '/items/task_token', count: 10 },
                    outputCount: 5,
                },
            };
            const el = labyrinthTooltip('Amount: 20', 'Task Token');
            state.handler(el);
            await Promise.resolve();

            const text = el.querySelector('.dungeon-token-shop-injected').textContent;
            // The bulk row leads the table: its Value is the 1,500 a purchase is worth, shown once
            const rows = [...el.querySelectorAll('.dungeon-token-shop-injected tr')].slice(1);
            expect(rows[0].textContent).toContain('Task Crystal ×5');
            expect(rows[0].textContent).toContain('1.5K');
            // 2 purchases = 10 crystals = 3,000
            expect(text).toContain('Your 20 tokens ≈ 3.0K as 10 × Task Crystal');
        });
    });
});
