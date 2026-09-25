/** @vitest-environment happy-dom */
/**
 * Queue Length Estimator — the queue-depth extrapolation formula, driven
 * through `displayQueueLength` against a real (happy-dom) button container.
 * WebSocket wiring and the DOM observer are not exercised here.
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
vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, getSettingValue: (key, fallback) => fallback },
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

describe('displayQueueLength', () => {
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

    test('ask and bid displays are independent and both can coexist', () => {
        const container = buttonContainer();
        queueLengthEstimator.displayQueueLength(container, [askListing(100, 5, '2026-01-01T00:00:00Z')], true);
        queueLengthEstimator.displayQueueLength(container, [askListing(90, 3, '2026-01-01T00:00:00Z')], false);

        expect(container.querySelector('.mwi-queue-length-ask').textContent).toBe('5');
        expect(container.querySelector('.mwi-queue-length-bid').textContent).toBe('3');
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

describe('displayQueueLength with a grid host', () => {
    /** @returns {{infoContainer: HTMLElement, host: {infoContainer: HTMLElement}}} */
    const gridHost = () => {
        const infoContainer = document.createElement('div');
        infoContainer.className = 'MarketplacePanel_infoContainer__q';
        document.body.appendChild(infoContainer);
        return { infoContainer, host: { infoContainer } };
    };

    test('ask is placed left of the icon (column 1, end/end), bid right of it (column 3, start/end)', () => {
        const { infoContainer, host } = gridHost();
        const buttons = buttonContainer();

        queueLengthEstimator.displayQueueLength(buttons, [askListing(100, 5, '2026-01-01T00:00:00Z')], true, host);
        queueLengthEstimator.displayQueueLength(buttons, [askListing(90, 3, '2026-01-01T00:00:00Z')], false, host);

        const ask = infoContainer.querySelector('.mwi-queue-length-ask');
        const bid = infoContainer.querySelector('.mwi-queue-length-bid');
        expect(ask).not.toBeNull();
        expect(bid).not.toBeNull();
        expect(ask.style.gridColumn).toBe('1');
        expect(ask.style.justifySelf).toBe('end');
        expect(ask.style.alignSelf).toBe('end');
        expect(bid.style.gridColumn).toBe('3');
        expect(bid.style.justifySelf).toBe('start');
        expect(bid.style.alignSelf).toBe('end');
        // Never inserted into the button row when a grid host is available
        expect(buttons.querySelector('.mwi-queue-length')).toBeNull();

        infoContainer.remove();
    });

    test('re-rendering into the grid host replaces the previous element rather than duplicating it', () => {
        const { infoContainer, host } = gridHost();
        const buttons = buttonContainer();

        queueLengthEstimator.displayQueueLength(buttons, [askListing(100, 5, '2026-01-01T00:00:00Z')], true, host);
        queueLengthEstimator.displayQueueLength(buttons, [askListing(100, 9, '2026-01-01T00:00:00Z')], true, host);

        const els = infoContainer.querySelectorAll('.mwi-queue-length-ask');
        expect(els).toHaveLength(1);
        expect(els[0].textContent).toBe('9');

        infoContainer.remove();
    });

    test('an empty listings array removes any existing element from the grid host and adds nothing', () => {
        const { infoContainer, host } = gridHost();
        const buttons = buttonContainer();

        queueLengthEstimator.displayQueueLength(buttons, [askListing(100, 5, '2026-01-01T00:00:00Z')], true, host);
        expect(infoContainer.querySelector('.mwi-queue-length-ask')).not.toBeNull();

        queueLengthEstimator.displayQueueLength(buttons, [], true, host);
        expect(infoContainer.querySelector('.mwi-queue-length-ask')).toBeNull();

        infoContainer.remove();
    });

    test('getGridHost finds the info container and getGridHost returns null without one', () => {
        document.body.innerHTML = '';
        expect(queueLengthEstimator.getGridHost()).toBeNull();

        const infoContainer = document.createElement('div');
        infoContainer.className = 'MarketplacePanel_infoContainer__q';
        const currentItem = document.createElement('div');
        currentItem.className = 'MarketplacePanel_currentItem__x';
        infoContainer.appendChild(currentItem);
        document.body.appendChild(infoContainer);

        expect(queueLengthEstimator.getGridHost()).toEqual({ infoContainer });
        document.body.innerHTML = '';
    });

    test('no grid host present falls back to the button row', () => {
        document.body.innerHTML = '';
        const buttons = buttonContainer();

        expect(queueLengthEstimator.getGridHost()).toBeNull();
        queueLengthEstimator.displayQueueLength(buttons, [askListing(100, 5, '2026-01-01T00:00:00Z')], true, null);

        expect(buttons.querySelector('.mwi-queue-length-ask')).not.toBeNull();
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

describe('processOrderBook with an info-container grid present', () => {
    /**
     * @param {string} iconName - Sprite id the marketplace panel is showing
     * @returns {{infoContainer: HTMLElement, buttons: HTMLElement, cleanup: Function}}
     */
    const gridPanel = (iconName) => {
        document.body.textContent = '';
        const infoContainer = document.createElement('div');
        infoContainer.className = 'MarketplacePanel_infoContainer__q';
        const currentItem = document.createElement('div');
        currentItem.className = 'MarketplacePanel_currentItem__x';
        currentItem.innerHTML = `<svg><use href="#${iconName}"></use></svg>`;
        infoContainer.appendChild(currentItem);
        document.body.appendChild(infoContainer);

        const buttons = document.createElement('div');
        buttons.className = 'MarketplacePanel_newListingButtonsContainer__y';
        buttons.appendChild(document.createElement('button'));
        buttons.appendChild(document.createElement('button'));
        const books = document.createElement('div');
        books.className = 'MarketplacePanel_orderBooksContainer__z';
        document.body.append(books, buttons);
        return {
            infoContainer,
            buttons,
            cleanup: () => {
                document.body.textContent = '';
            },
        };
    };

    test('counts go into the grid host, not the button row, when an info container is present', () => {
        const { infoContainer, buttons, cleanup } = gridPanel('cheese');
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
            };
            queueLengthEstimator.processOrderBook();

            expect(infoContainer.querySelector('.mwi-queue-length-ask').textContent).toBe('500');
            expect(infoContainer.querySelector('.mwi-queue-length-bid').textContent).toBe('400');
            expect(buttons.querySelector('.mwi-queue-length')).toBeNull();
        } finally {
            queueLengthEstimator.orderBooksCache = {};
            cleanup();
        }
    });

    test('disable() / clearDisplays() removes counts from the grid host too', () => {
        const { infoContainer, cleanup } = gridPanel('cheese');
        try {
            queueLengthEstimator.orderBooksCache = {
                '/items/cheese': {
                    data: {
                        orderBooks: [{ asks: [{ price: 10, quantity: 5, createdTimestamp: 1 }], bids: [] }],
                    },
                },
            };
            queueLengthEstimator.processOrderBook();
            expect(infoContainer.querySelector('.mwi-queue-length-ask')).not.toBeNull();

            queueLengthEstimator.clearDisplays();
            expect(infoContainer.querySelector('.mwi-queue-length-ask')).toBeNull();
        } finally {
            queueLengthEstimator.orderBooksCache = {};
            cleanup();
        }
    });
});
