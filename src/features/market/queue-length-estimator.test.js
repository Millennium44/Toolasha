/** @vitest-environment happy-dom */
/**
 * Queue Length Estimator — the queue-depth extrapolation formula, driven
 * through `displayQueueLength`/`displayCombinedQueueLength` against a real
 * (happy-dom) button container. WebSocket wiring and the DOM observer are not
 * exercised here.
 */

import { describe, test, expect, vi } from 'vitest';

const dataManagerMock = vi.hoisted(() => ({
    handlers: {},
    on: (event, handler) => {
        dataManagerMock.handlers[event] = handler;
    },
    off: () => {},
}));
vi.mock('../../core/data-manager.js', () => ({ default: dataManagerMock }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));

const settingChangeCallbacks = vi.hoisted(() => ({}));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: (key, fallback) => fallback,
        onSettingChange: (key, callback) => {
            (settingChangeCallbacks[key] ||= []).push(callback);
            return () => {
                settingChangeCallbacks[key] = (settingChangeCallbacks[key] || []).filter((cb) => cb !== callback);
            };
        },
    },
}));

// market-volume-stats.js's gating is exercised by its own tests; here it is a
// simple switch so the two layouts (and the switch between them) can be
// driven directly.
const volumeStatsMock = vi.hoisted(() => ({ active: false }));
vi.mock('./market-volume-stats.js', () => ({
    isVolumeStatsPanelActive: () => volumeStatsMock.active,
}));

const { default: queueLengthEstimator } = await import('./queue-length-estimator.js');

describe('order-book messages', () => {
    test('a burst of books is stashed at once and the page repainted once, after the last', () => {
        vi.useFakeTimers();
        try {
            const container = document.createElement('div');
            container.className = 'MarketplacePanel_orderBooksContainer__abc';
            document.body.appendChild(container);
            const processed = vi.spyOn(queueLengthEstimator, 'processOrderBook').mockImplementation(() => {});

            queueLengthEstimator.setupWebSocketListeners();
            const handler = dataManagerMock.handlers.market_item_order_books_updated;
            for (let i = 0; i < 20; i++) {
                handler({
                    marketItemOrderBooks: { itemHrid: `/items/item_${i}`, orderBooks: [{ asks: [], bids: [] }] },
                });
            }

            expect(Object.keys(queueLengthEstimator.orderBooksCache)).toHaveLength(20);
            expect(processed).not.toHaveBeenCalled();

            vi.advanceTimersByTime(49);
            expect(processed).not.toHaveBeenCalled();
            vi.advanceTimersByTime(1);
            expect(processed).toHaveBeenCalledTimes(1);
            expect(processed).toHaveBeenCalledWith(container);

            processed.mockRestore();
            queueLengthEstimator.unregisterWebSocket();
            container.remove();
        } finally {
            vi.useRealTimers();
        }
    });

    test('a message without a book is ignored', () => {
        vi.useFakeTimers();
        try {
            const processed = vi.spyOn(queueLengthEstimator, 'processOrderBook').mockImplementation(() => {});
            queueLengthEstimator.setupWebSocketListeners();
            dataManagerMock.handlers.market_item_order_books_updated({});
            vi.advanceTimersByTime(100);
            expect(processed).not.toHaveBeenCalled();
            processed.mockRestore();
            queueLengthEstimator.unregisterWebSocket();
        } finally {
            vi.useRealTimers();
        }
    });
});

/** A button container shaped like the game's order-book action row */
function buttonContainer() {
    const el = document.createElement('div');
    el.innerHTML = '<button>Sell 20</button><button>Buy 20</button>';
    document.body.appendChild(el);
    return el;
}

const askListing = (price, quantity, createdTimestamp) => ({ price, quantity, createdTimestamp });

describe('displayQueueLength (trade-stats overlay off — original, unlabeled layout)', () => {
    test('when fewer than 20 listings are visible, the count is exact — not estimated', () => {
        const container = buttonContainer();
        const listings = [askListing(100, 5, '2026-01-01T00:00:00Z'), askListing(100, 3, '2026-01-01T00:00:00Z')];

        queueLengthEstimator.displayQueueLength(container, listings, true);

        const el = container.querySelector('.mwi-queue-length-ask');
        expect(el.textContent).toBe('8');
        expect(el.title).toMatch(/Total quantity/);
    });

    test('only listings at the single best (top) price are summed', () => {
        const container = buttonContainer();
        const listings = [
            askListing(100, 5, '2026-01-01T00:00:00Z'),
            askListing(100, 3, '2026-01-01T00:00:00Z'),
            askListing(110, 999, '2026-01-01T00:00:00Z'), // worse price, excluded
        ];

        queueLengthEstimator.displayQueueLength(container, listings, true);
        expect(container.querySelector('.mwi-queue-length-ask').textContent).toBe('8');
    });

    test('20 listings all at the same price are extrapolated using the RWI formula', () => {
        const container = buttonContainer();
        const now = new Date('2026-01-01T10:00:00Z').getTime();
        vi.useFakeTimers();
        vi.setSystemTime(now);

        // 20 listings, each qty 1, first created 100 min ago, last created 10 min ago
        const first = now - 100 * 60 * 1000;
        const last = now - 10 * 60 * 1000;
        const listings = Array.from({ length: 20 }, (_, i) => {
            const t = first + ((last - first) * i) / 19;
            return askListing(100, 1, new Date(t).toISOString());
        });

        queueLengthEstimator.displayQueueLength(container, listings, true);

        const timeSpan = last - first;
        const timeSinceNow = now - last;
        const multiplier = 1 + (19 / 20) * (timeSinceNow / timeSpan);
        const expected = 20 * multiplier; // visibleCount (20) * multiplier

        const el = container.querySelector('.mwi-queue-length-ask');
        expect(el.title).toMatch(/Estimated/);
        // formatKMB rounds for display; check the underlying math via the multiplier bounds
        expect(multiplier).toBeGreaterThan(1);
        expect(expected).toBeGreaterThan(20);
        vi.useRealTimers();
    });

    test('20 listings where the 20th differs in price from the 1st is not treated as saturated', () => {
        const container = buttonContainer();
        const listings = Array.from({ length: 20 }, (_, i) => askListing(100 + i, 1, '2026-01-01T00:00:00Z'));
        // Top price is 100, only 1 unit there
        queueLengthEstimator.displayQueueLength(container, listings, true);
        expect(container.querySelector('.mwi-queue-length-ask').textContent).toBe('1');
        expect(container.querySelector('.mwi-queue-length-ask').title).toMatch(/Total quantity/);
    });

    test('an empty listings array injects nothing', () => {
        const container = buttonContainer();
        queueLengthEstimator.displayQueueLength(container, [], true);
        expect(container.querySelector('.mwi-queue-length-ask')).toBeNull();
    });

    test('ask and bid displays are independent and both can coexist, ask left of center and bid right of it', () => {
        const container = buttonContainer();
        queueLengthEstimator.displayQueueLength(container, [askListing(100, 5, '2026-01-01T00:00:00Z')], true);
        queueLengthEstimator.displayQueueLength(container, [askListing(90, 3, '2026-01-01T00:00:00Z')], false);

        const ask = container.querySelector('.mwi-queue-length-ask');
        const bid = container.querySelector('.mwi-queue-length-bid');
        expect(ask.textContent).toBe('5');
        expect(bid.textContent).toBe('3');
        expect(ask.textContent).not.toMatch(/Ask/); // no label in this layout
        // Ask sits before the Sell button (index 1), bid before the Buy button (last child)
        expect([...container.children].indexOf(ask)).toBe(1);
        expect(bid.nextElementSibling.textContent).toBe('Buy 20');
    });

    test('re-displaying replaces the previous element rather than duplicating it', () => {
        const container = buttonContainer();
        queueLengthEstimator.displayQueueLength(container, [askListing(100, 5, '2026-01-01T00:00:00Z')], true);
        queueLengthEstimator.displayQueueLength(container, [askListing(100, 9, '2026-01-01T00:00:00Z')], true);

        const els = container.querySelectorAll('.mwi-queue-length-ask');
        expect(els).toHaveLength(1);
        expect(els[0].textContent).toBe('9');
    });
});

describe('displayCombinedQueueLength (trade-stats overlay on — combined, labeled layout)', () => {
    test('both sides present renders "Ask <n> · Bid <n>" as one group in the ask slot', () => {
        const container = buttonContainer();
        queueLengthEstimator.displayCombinedQueueLength(
            container,
            [askListing(100, 5, '2026-01-01T00:00:00Z')],
            [askListing(90, 3, '2026-01-01T00:00:00Z')]
        );

        const group = container.querySelector('.mwi-queue-length-combined');
        expect(group).not.toBeNull();
        expect([...container.children].indexOf(group)).toBe(1);
        expect(group.textContent).toContain('Ask');
        expect(group.textContent).toContain('5');
        expect(group.textContent).toContain('Bid');
        expect(group.textContent).toContain('3');

        const ask = group.querySelector('.mwi-queue-length-ask');
        const bid = group.querySelector('.mwi-queue-length-bid');
        expect(ask.title).toMatch(/Total quantity/);
        expect(bid.title).toMatch(/Total quantity/);

        // Nothing left for the Buy side of the row — the overlay owns that corner.
        expect(container.lastElementChild.textContent).toBe('Buy 20');
    });

    test('only the ask side has listings: only "Ask" is shown, no dangling separator', () => {
        const container = buttonContainer();
        queueLengthEstimator.displayCombinedQueueLength(container, [askListing(100, 5, '2026-01-01T00:00:00Z')], []);

        const group = container.querySelector('.mwi-queue-length-combined');
        expect(group.textContent).toContain('Ask');
        expect(group.textContent).not.toContain('Bid');
        expect(group.textContent).not.toContain('·');
    });

    test('only the bid side has listings: only "Bid" is shown', () => {
        const container = buttonContainer();
        queueLengthEstimator.displayCombinedQueueLength(container, [], [askListing(90, 3, '2026-01-01T00:00:00Z')]);

        const group = container.querySelector('.mwi-queue-length-combined');
        expect(group.textContent).toContain('Bid');
        expect(group.textContent).not.toContain('Ask');
    });

    test('neither side has listings: nothing is injected', () => {
        const container = buttonContainer();
        queueLengthEstimator.displayCombinedQueueLength(container, [], []);
        expect(container.querySelector('.mwi-queue-length-combined')).toBeNull();
    });

    test('an estimated side keeps the estimated color and tooltip, independent of the other side', () => {
        const container = buttonContainer();
        const now = new Date('2026-01-01T10:00:00Z').getTime();
        vi.useFakeTimers();
        vi.setSystemTime(now);
        const first = now - 100 * 60 * 1000;
        const last = now - 10 * 60 * 1000;
        const saturatedAsks = Array.from({ length: 20 }, (_, i) => {
            const t = first + ((last - first) * i) / 19;
            return askListing(100, 1, new Date(t).toISOString());
        });

        queueLengthEstimator.displayCombinedQueueLength(container, saturatedAsks, [
            askListing(90, 3, '2026-01-01T00:00:00Z'),
        ]);

        const group = container.querySelector('.mwi-queue-length-combined');
        const ask = group.querySelector('.mwi-queue-length-ask');
        const bid = group.querySelector('.mwi-queue-length-bid');
        expect(ask.title).toMatch(/Estimated/);
        expect(bid.title).toMatch(/Total quantity/);
        vi.useRealTimers();
    });

    test('re-rendering through renderQueueLengths replaces the previous group rather than duplicating it', () => {
        volumeStatsMock.active = true;
        try {
            const container = buttonContainer();
            queueLengthEstimator.renderQueueLengths(container, [askListing(100, 5, '2026-01-01T00:00:00Z')], []);
            queueLengthEstimator.renderQueueLengths(container, [askListing(100, 9, '2026-01-01T00:00:00Z')], []);

            const groups = container.querySelectorAll('.mwi-queue-length-combined');
            expect(groups).toHaveLength(1);
            expect(groups[0].textContent).toContain('9');
        } finally {
            volumeStatsMock.active = false;
        }
    });
});

describe('renderQueueLengths switches layout on isVolumeStatsPanelActive()', () => {
    test('overlay off renders the separate, unlabeled layout', () => {
        volumeStatsMock.active = false;
        const container = buttonContainer();
        queueLengthEstimator.renderQueueLengths(
            container,
            [askListing(100, 5, '2026-01-01T00:00:00Z')],
            [askListing(90, 3, '2026-01-01T00:00:00Z')]
        );

        expect(container.querySelector('.mwi-queue-length-combined')).toBeNull();
        expect(container.querySelector('.mwi-queue-length-ask').textContent).toBe('5');
        expect(container.querySelector('.mwi-queue-length-bid').textContent).toBe('3');
    });

    test('overlay on renders the combined, labeled layout', () => {
        volumeStatsMock.active = true;
        try {
            const container = buttonContainer();
            queueLengthEstimator.renderQueueLengths(
                container,
                [askListing(100, 5, '2026-01-01T00:00:00Z')],
                [askListing(90, 3, '2026-01-01T00:00:00Z')]
            );

            const group = container.querySelector('.mwi-queue-length-combined');
            expect(group).not.toBeNull();
            expect(group.textContent).toContain('Ask');
            expect(group.textContent).toContain('Bid');
        } finally {
            volumeStatsMock.active = false;
        }
    });

    test('re-rendering after the setting flips tears down the old layout instead of stacking it', () => {
        const container = buttonContainer();
        volumeStatsMock.active = false;
        queueLengthEstimator.renderQueueLengths(
            container,
            [askListing(100, 5, '2026-01-01T00:00:00Z')],
            [askListing(90, 3, '2026-01-01T00:00:00Z')]
        );
        expect(container.querySelectorAll('.mwi-queue-length')).toHaveLength(2);

        volumeStatsMock.active = true;
        try {
            queueLengthEstimator.renderQueueLengths(
                container,
                [askListing(100, 5, '2026-01-01T00:00:00Z')],
                [askListing(90, 3, '2026-01-01T00:00:00Z')]
            );
            expect(container.querySelectorAll('.mwi-queue-length')).toHaveLength(1);
            expect(container.querySelector('.mwi-queue-length-combined')).not.toBeNull();
        } finally {
            volumeStatsMock.active = false;
        }
    });
});

describe('setupVolumeStatsListener', () => {
    test('flipping either gating setting repaints the queue-length display', () => {
        const container = document.createElement('div');
        container.className = 'MarketplacePanel_orderBooksContainer__abc';
        document.body.appendChild(container);
        try {
            const repaint = vi.spyOn(queueLengthEstimator, 'repaint').mockImplementation(() => {});
            queueLengthEstimator.setupVolumeStatsListener();

            for (const callback of settingChangeCallbacks.market_pooledHistory || []) callback(true);
            expect(repaint).toHaveBeenCalled();

            repaint.mockClear();
            for (const callback of settingChangeCallbacks.market_volumeStats || []) callback(true);
            expect(repaint).toHaveBeenCalled();

            repaint.mockRestore();
        } finally {
            container.remove();
        }
    });
});

describe('the figure under the button belongs to the item on screen', () => {
    /**
     * @param {string} iconName - Sprite id the marketplace panel is showing
     * @returns {{buttons: HTMLElement, cleanup: Function}} The shared button row
     */
    const showItem = (iconName) => {
        const el = document.querySelector('[class*="MarketplacePanel_currentItem"]');
        el.innerHTML = `<svg><use href="#${iconName}"></use></svg>`;
    };
    const panel = (iconName) => {
        document.body.textContent = '';
        const currentItem = document.createElement('div');
        currentItem.className = 'MarketplacePanel_currentItem__x';
        document.body.appendChild(currentItem);
        showItem(iconName);
        const buttons = document.createElement('div');
        buttons.className = 'MarketplacePanel_newListingButtonsContainer__y';
        buttons.appendChild(document.createElement('button'));
        buttons.appendChild(document.createElement('button'));
        const books = document.createElement('div');
        books.className = 'MarketplacePanel_orderBooksContainer__z';
        document.body.append(books, buttons);
        return {
            buttons,
            cleanup: () => {
                document.body.textContent = '';
            },
        };
    };

    test('an item with nothing resting on one side does not inherit the last item the other way', () => {
        const { buttons, cleanup } = panel('cheese');
        try {
            queueLengthEstimator.orderBooksCache = {
                '/items/cheese': {
                    data: {
                        orderBooks: [
                            {
                                asks: [{ price: 10, quantity: 500, createdTimestamp: 1 }],
                                bids: [{ price: 9, quantity: 400, createdTimestamp: 1 }],
                            },
                        ],
                    },
                },
                '/items/milk': { data: { orderBooks: [{ asks: [], bids: [] }] } },
            };
            queueLengthEstimator.processOrderBook();
            expect(buttons.querySelector('.mwi-queue-length-ask').textContent).toBe('500');
            expect(buttons.querySelector('.mwi-queue-length-bid').textContent).toBe('400');

            // The panel now shows a different item, whose book is empty on both
            // sides. The button row is the same element.
            showItem('milk');
            queueLengthEstimator.repaint();

            expect(buttons.querySelector('.mwi-queue-length-ask')).toBeNull();
            expect(buttons.querySelector('.mwi-queue-length-bid')).toBeNull();
        } finally {
            queueLengthEstimator.orderBooksCache = {};
            cleanup();
        }
    });

    test('an item whose book has not arrived yet clears the last one rather than keeping it', () => {
        const { buttons, cleanup } = panel('cheese');
        try {
            queueLengthEstimator.orderBooksCache = {
                '/items/cheese': {
                    data: { orderBooks: [{ asks: [{ price: 10, quantity: 7, createdTimestamp: 1 }], bids: [] }] },
                },
            };
            queueLengthEstimator.processOrderBook();
            expect(buttons.querySelector('.mwi-queue-length-ask').textContent).toBe('7');

            showItem('milk');
            queueLengthEstimator.repaint();

            expect(buttons.querySelector('.mwi-queue-length-ask')).toBeNull();
        } finally {
            queueLengthEstimator.orderBooksCache = {};
            cleanup();
        }
    });
});
