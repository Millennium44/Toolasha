/**
 * @vitest-environment happy-dom
 *
 * Trade History Display — the "Last: Buy … | Sell …" chip only ever redrew from a
 * `market_item_order_books_updated` WebSocket push. queue-length-estimator.js and
 * market-depth-cap.js both pair their order-book cache with a `domObserver.onClass` watcher on
 * their container so a React re-render that swaps the container without a fresh push still gets
 * redrawn from the cached data. This module declared an unused `unregisterObserver` field but
 * never registered one, so a container swap with no new price data left the chip missing until
 * the item's next trade — arbitrarily far off for a quiet book.
 */

import { describe, test, expect, afterEach, vi } from 'vitest';

const settingListeners = vi.hoisted(() => ({}));
const classWatchers = vi.hoisted(() => ({}));

vi.mock('../../core/data-manager.js', () => ({
    default: { on: () => {}, off: () => {} },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: () => 'instant',
        onSettingChange: (key, callback) => {
            (settingListeners[key] ??= []).push(callback);
            return () => {
                settingListeners[key] = (settingListeners[key] || []).filter((cb) => cb !== callback);
            };
        },
        COLOR_PROFIT: '#0f0',
        COLOR_LOSS: '#f00',
    },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (name, classNames, callback) => {
            classWatchers[name] = callback;
            return () => {
                delete classWatchers[name];
            };
        },
    },
}));

vi.mock('./trade-history.js', () => ({
    default: { getHistory: () => ({ buy: 90, sell: 100 }) },
}));

const tradeHistoryDisplay = (await import('./trade-history-display.js')).default;

/** Draw the marketplace nav row the way the game does. */
function drawNavRow() {
    document.body.innerHTML = `
        <div class="MarketplacePanel_marketNavButtonContainer__d">
            <button>Refresh</button>
        </div>
    `;
    return document.querySelector('[class*="MarketplacePanel_marketNavButtonContainer"]');
}

describe('chip survives a container swap with no fresh order-book push', () => {
    afterEach(() => {
        tradeHistoryDisplay.disable();
        document.body.innerHTML = '';
        for (const key of Object.keys(settingListeners)) delete settingListeners[key];
        for (const key of Object.keys(classWatchers)) delete classWatchers[key];
    });

    test('a container watcher is registered and torn down on disable', () => {
        tradeHistoryDisplay.initialize();
        expect(typeof classWatchers['trade-history-display']).toBe('function');

        tradeHistoryDisplay.disable();
        expect(classWatchers['trade-history-display']).toBeUndefined();
    });

    test('redraws the chip from cached history when the container reappears', () => {
        drawNavRow();
        tradeHistoryDisplay.initialize();

        tradeHistoryDisplay.currentOrderBookData = {
            orderBooks: [{ asks: [{ price: 100 }], bids: [{ price: 90 }] }],
        };
        tradeHistoryDisplay.currentItemHrid = '/items/test_item';
        tradeHistoryDisplay.currentHistory = { buy: 90, sell: 100 };
        tradeHistoryDisplay.updateDisplay(null, tradeHistoryDisplay.currentHistory);
        expect(document.querySelector('.mwi-trade-history')).not.toBeNull();

        // React swaps in a brand new container node without a new order-book message — the
        // chip goes with the old node.
        const newContainer = drawNavRow();
        expect(document.querySelector('.mwi-trade-history')).toBeNull();

        classWatchers['trade-history-display'](newContainer);

        expect(document.querySelector('.mwi-trade-history')).not.toBeNull();
        expect(document.querySelector('.mwi-trade-history').textContent).toContain('Buy');
    });

    test('does nothing when nothing has ever been drawn for this session', () => {
        const container = drawNavRow();
        tradeHistoryDisplay.initialize();

        classWatchers['trade-history-display'](container);

        expect(document.querySelector('.mwi-trade-history')).toBeNull();
    });
});
