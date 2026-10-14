/** @vitest-environment happy-dom */
/**
 * The held-stack total under a token tooltip's shop table.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({ handler: null, prices: {}, inventory: [] }));

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
vi.mock('../market/expected-value-calculator.js', () => ({ default: { calculateExpectedValue: () => null } }));
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
function labyrinthTooltip(amountText) {
    const el = document.createElement('div');
    el.className = 'MuiTooltip-popper';
    el.innerHTML = `<div class="MuiTooltip-tooltip"><div class="ItemTooltipText_itemTooltipText__x">
        <div class="ItemTooltipText_name__2JAHA"><span>Labyrinth Token</span></div>
        <div>${amountText}</div></div></div>`;
    document.body.appendChild(el);
    return el;
}

beforeEach(async () => {
    document.body.innerHTML = '';
    state.inventory = [];
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
        expect(text).toContain('Your 22,657 tokens ≈ 154.1M as Pathseeker Lodestone (6.8K/token)');
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
            'Your 100 tokens ≈ 900.0K as Labyrinth Essence (9.0K/token)'
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
            'Your 22,657 tokens ≈ 154.1M as Pathseeker Lodestone'
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
