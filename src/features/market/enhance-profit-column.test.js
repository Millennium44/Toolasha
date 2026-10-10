/* @vitest-environment happy-dom */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const world = vi.hoisted(() => ({
    settings: { market_enhanceProfitPerHour: true, ironCow_enabled: false },
    settingCallbacks: {},
    itemDetails: { '/items/iron_sword': { enhancementCosts: [{ itemHrid: '/items/iron_bar', count: 1 }] } },
    path: null,
    ironCowCharacter: false,
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => world.settings[key],
        onSettingChange: (key, callback) => {
            world.settingCallbacks[key] = callback;
            return () => {};
        },
        COLOR_PROFIT: '#047857',
        COLOR_LOSS: '#f87171',
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        on: vi.fn(),
        off: vi.fn(),
        getItemDetails: (hrid) => world.itemDetails[hrid] || null,
        getCurrentCharacterId: () => 'char-1',
    },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: vi.fn(() => () => {}) } }));
vi.mock('../../api/marketplace.js', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({
    calculateEnhancementPath: vi.fn(() => world.path),
}));
vi.mock('../../utils/enhancement-config.js', () => ({
    getEnhancingParams: () => ({ enhancingLevel: 100, houseLevel: 4, toolBonus: 10, speedBonus: 20, teas: {} }),
}));
vi.mock('../../utils/ironcow-valuation.js', () => ({ isIronCowCharacter: () => world.ironCowCharacter }));

const {
    default: column,
    computeProfitPerHour,
    buildLevelQuote,
    ENHANCE_PROFIT_SETTING,
} = await import('./enhance-profit-column.js');
const { calculateEnhancementPath } = await import('../enhancement/tooltip-enhancement.js');
const { default: dataManager } = await import('../../core/data-manager.js');
const { MARKET_TAX } = await import('../../utils/profit-constants.js');

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A finished 3-hour, 10M path with 120 attempts and 15 protections */
function pathFixture() {
    return {
        pricesPartial: false,
        optimalStrategy: {
            totalCost: 10_000_000,
            totalTime: 3 * 3600,
            expectedAttempts: 120,
            protectionCount: 15,
        },
    };
}

/**
 * The marketplace order book as the game draws it: the current item (sprite + level badge) and
 * a container holding the sell table first, then the buy table.
 */
function buildMarket({
    item = 'iron_sword',
    level = 5,
    askRows = 3,
    buyRows = askRows,
    separatorAt = -1,
    ageHeader = false,
} = {}) {
    const current = document.createElement('div');
    current.className = 'MarketplacePanel_currentItem__x1';
    const svg = document.createElementNS(SVG_NS, 'svg');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `/static/media/items_sprite.svg#${item}`);
    svg.appendChild(use);
    current.appendChild(svg);
    if (level > 0) {
        const badge = document.createElement('div');
        badge.className = 'Item_enhancementLevel__y2';
        badge.textContent = `+${level}`;
        current.appendChild(badge);
    }
    document.body.appendChild(current);

    const container = document.createElement('div');
    container.className = 'MarketplacePanel_orderBooksContainer__z3';
    for (let t = 0; t < 2; t++) {
        const tableContainer = document.createElement('div');
        tableContainer.className = 'MarketplacePanel_orderBookTableContainer__q4';
        const table = document.createElement('table');
        table.innerHTML = '<thead><tr><th>Quantity</th><th>Price</th><th></th></tr></thead><tbody></tbody>';
        if (ageHeader) {
            const age = document.createElement('th');
            age.className = 'mwi-estimated-age-header';
            age.textContent = '~Age';
            table.querySelector('thead tr').appendChild(age);
        }
        const tbody = table.querySelector('tbody');
        const rowCount = t === 0 ? askRows : buyRows;
        for (let r = 0; r < rowCount; r++) {
            if (r === separatorAt) {
                const sep = document.createElement('tr');
                sep.className = 'MarketplacePanel_outsideRangeSeparator__s';
                sep.innerHTML = '<td colspan="3">Outside range</td>';
                tbody.appendChild(sep);
            }
            const row = document.createElement('tr');
            row.innerHTML = `<td>1</td><td><span class="MarketplacePanel_price__p">${r}</span></td><td><button>Buy</button></td>`;
            tbody.appendChild(row);
        }
        tableContainer.appendChild(table);
        container.appendChild(tableContainer);
    }
    document.body.appendChild(container);
    const [sellTable, buyTable] = container.querySelectorAll('table');
    return { container, sellTable, buyTable };
}

function feedBook(itemHrid, level, askPrices) {
    const orderBooks = [];
    orderBooks[level] = { asks: askPrices.map((price, i) => ({ price, quantity: 1, listingId: i })), bids: [] };
    const handler = dataManager.on.mock.calls.find(([event]) => event === 'market_item_order_books_updated')[1];
    handler({ marketItemOrderBooks: { itemHrid, orderBooks } });
}

beforeEach(() => {
    world.settings.market_enhanceProfitPerHour = true;
    world.settings.ironCow_enabled = false;
    world.ironCowCharacter = false;
    world.path = pathFixture();
    dataManager.on.mockClear();
    calculateEnhancementPath.mockClear();
    vi.useFakeTimers();
    column.initialize();
});

afterEach(() => {
    column.disable();
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('computeProfitPerHour', () => {
    test('revenue after tax minus cost, over hours', () => {
        const result = computeProfitPerHour({ askPrice: 25_000_000, cost: 10_000_000, hours: 3 });
        const revenue = 25_000_000 * (1 - MARKET_TAX);
        expect(result.revenue).toBeCloseTo(revenue);
        expect(result.profit).toBeCloseTo(revenue - 10_000_000);
        expect(result.profitPerHour).toBeCloseTo((revenue - 10_000_000) / 3);
    });

    test('a loss is negative', () => {
        const result = computeProfitPerHour({ askPrice: 5_000_000, cost: 10_000_000, hours: 2, afterTax: (p) => p });
        expect(result.profitPerHour).toBe(-2_500_000);
    });

    test('no rate without a price, a cost or time', () => {
        expect(computeProfitPerHour({ askPrice: 0, cost: 1, hours: 1 })).toBeNull();
        expect(computeProfitPerHour({ askPrice: 1, cost: Infinity, hours: 1 })).toBeNull();
        expect(computeProfitPerHour({ askPrice: 1, cost: 1, hours: 0 })).toBeNull();
    });
});

describe('buildLevelQuote', () => {
    test('reads cost, hours, attempts and protections off the optimal strategy', () => {
        const quote = buildLevelQuote('/items/iron_sword', 5, {}, () => pathFixture());
        expect(quote).toEqual({ ok: true, cost: 10_000_000, hours: 3, attempts: 120, protections: 15, mirrors: 0 });
    });

    test('an unpriced input is not a quote', () => {
        const quote = buildLevelQuote('/items/iron_sword', 5, {}, () => ({ ...pathFixture(), pricesPartial: true }));
        expect(quote.ok).toBe(false);
        expect(quote.reason).toMatch(/no market price/);
    });

    test('no path is not a quote', () => {
        expect(buildLevelQuote('/items/iron_sword', 5, {}, () => null).ok).toBe(false);
    });
});

describe('the order-book column', () => {
    test('adds Profit/h after the price column of the sell table only, one value per ask', () => {
        const { container, sellTable, buyTable } = buildMarket({ askRows: 3 });
        feedBook('/items/iron_sword', 5, [25_000_000, 26_000_000, 27_000_000]);
        column.processContainer(container);

        const headers = [...sellTable.querySelectorAll('thead th')].map((th) => th.textContent);
        expect(headers).toEqual(['Quantity', 'Price', 'Profit/h', '']);
        const cells = [...sellTable.querySelectorAll('.mwi-enh-profit-cell')];
        expect(cells).toHaveLength(3);
        const expected = (25_000_000 * (1 - MARKET_TAX) - 10_000_000) / 3;
        expect(cells[0].textContent).toBe(`${(expected / 1e6).toFixed(2)}M`);
        expect(cells[0].style.color).toBeTruthy();
        expect(cells[0].title).toMatch(/Revenue after tax/);
        expect(cells[0].title).toMatch(/Expected protections: 15/);
        expect(cells[0].title).toMatch(/Expected time: 3h 00m 00s/);
        expect(buyTable.querySelector('.mwi-enh-profit-header, .mwi-enh-profit-cell')).toBeNull();
    });

    test('drawing twice does not duplicate the column', () => {
        const { container, sellTable } = buildMarket();
        feedBook('/items/iron_sword', 5, [25_000_000, 26_000_000, 27_000_000]);
        column.processContainer(container);
        column.processContainer(container);
        column.repaint();
        expect(sellTable.querySelectorAll('.mwi-enh-profit-header')).toHaveLength(1);
        expect(sellTable.querySelectorAll('.mwi-enh-profit-cell')).toHaveLength(3);
    });

    test('the separator row does not steal the next ask', () => {
        const { container, sellTable } = buildMarket({ askRows: 2, separatorAt: 1 });
        feedBook('/items/iron_sword', 5, [25_000_000, 40_000_000]);
        column.processContainer(container);
        const cells = [...sellTable.querySelectorAll('.mwi-enh-profit-cell')];
        expect(cells).toHaveLength(3);
        expect(cells[1].textContent).toBe('');
        const expected = (40_000_000 * (1 - MARKET_TAX) - 10_000_000) / 3;
        expect(cells[2].textContent).toBe(`${(expected / 1e6).toFixed(2)}M`);
    });

    test('a +0 listing gets no column', () => {
        const { container, sellTable } = buildMarket({ level: 0 });
        feedBook('/items/iron_sword', 0, [1_000_000, 1_100_000, 1_200_000]);
        column.processContainer(container);
        expect(sellTable.querySelector('.mwi-enh-profit-header')).toBeNull();
        expect(calculateEnhancementPath).not.toHaveBeenCalled();
    });

    test('a non-enhanceable item gets no column', () => {
        const { container, sellTable } = buildMarket({ item: 'cheese', level: 2 });
        feedBook('/items/cheese', 2, [10, 11, 12]);
        column.processContainer(container);
        expect(sellTable.querySelector('.mwi-enh-profit-header')).toBeNull();
    });

    test('unpriced inputs show a dash with the reason', () => {
        world.path = { ...pathFixture(), pricesPartial: true };
        const { container, sellTable } = buildMarket();
        feedBook('/items/iron_sword', 5, [25_000_000, 26_000_000, 27_000_000]);
        column.processContainer(container);
        const cells = [...sellTable.querySelectorAll('.mwi-enh-profit-cell')];
        expect(cells.map((c) => c.textContent)).toEqual(['—', '—', '—']);
        expect(cells[0].title).toMatch(/no market price/);
    });

    test('the path is computed once per (item, level) however many rows there are', () => {
        const { container } = buildMarket({ askRows: 20 });
        feedBook(
            '/items/iron_sword',
            5,
            Array.from({ length: 20 }, (_, i) => 20_000_000 + i * 100_000)
        );
        column.processContainer(container);
        column.processContainer(container);
        column.repaint();
        expect(calculateEnhancementPath).toHaveBeenCalledTimes(1);
    });

    test('setting off: no column', () => {
        world.settings.market_enhanceProfitPerHour = false;
        const { container, sellTable } = buildMarket();
        feedBook('/items/iron_sword', 5, [25_000_000, 26_000_000, 27_000_000]);
        column.processContainer(container);
        expect(sellTable.querySelector('.mwi-enh-profit-header, .mwi-enh-profit-cell')).toBeNull();
    });

    test('turning the setting off removes an existing column at once', () => {
        const { container, sellTable } = buildMarket();
        feedBook('/items/iron_sword', 5, [25_000_000, 26_000_000, 27_000_000]);
        column.processContainer(container);
        expect(sellTable.querySelector('.mwi-enh-profit-header')).not.toBeNull();

        world.settings.market_enhanceProfitPerHour = false;
        world.settingCallbacks[ENHANCE_PROFIT_SETTING](false);
        expect(sellTable.querySelector('.mwi-enh-profit-header, .mwi-enh-profit-cell')).toBeNull();
        expect(column.isInitialized).toBe(false);
    });

    test('an Iron Cow character gets no column', () => {
        world.ironCowCharacter = true;
        const { container, sellTable } = buildMarket();
        feedBook('/items/iron_sword', 5, [25_000_000, 26_000_000, 27_000_000]);
        column.processContainer(container);
        expect(sellTable.querySelector('.mwi-enh-profit-header')).toBeNull();
    });

    test('a fast enhance reads its time in seconds, not 0.00 h', () => {
        world.path = {
            pricesPartial: false,
            optimalStrategy: { totalCost: 50_000, totalTime: 42, expectedAttempts: 3, protectionCount: 0 },
        };
        const { container, sellTable } = buildMarket({ level: 1, askRows: 1 });
        feedBook('/items/iron_sword', 1, [100_000]);
        column.processContainer(container);
        const cell = sellTable.querySelector('.mwi-enh-profit-cell');
        expect(cell.title).toMatch(/Expected time: 42s/);
        expect(cell.title).not.toMatch(/0\.00 h/);
    });

    test('an empty sell table still puts the header after the price, not after ~Age', () => {
        const { container, sellTable } = buildMarket({ askRows: 0, buyRows: 2, ageHeader: true });
        feedBook('/items/iron_sword', 5, []);
        column.processContainer(container);
        const headers = [...sellTable.querySelectorAll('thead th')].map((th) => th.textContent);
        expect(headers).toEqual(['Quantity', 'Price', 'Profit/h', '', '~Age']);
    });

    test('with both tables empty the header still lands before the columns other features appended', () => {
        const { container, sellTable } = buildMarket({ askRows: 0, buyRows: 0, ageHeader: true });
        column.lastPriceIndex = -1;
        feedBook('/items/iron_sword', 5, []);
        column.processContainer(container);
        const headers = [...sellTable.querySelectorAll('thead th')].map((th) => th.textContent);
        expect(headers.indexOf('Profit/h')).toBeLessThan(headers.indexOf('~Age'));
        expect(headers.at(-1)).toBe('~Age');
    });
});
