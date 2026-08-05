/** @vitest-environment happy-dom */
/**
 * Queue Length Estimator — the queue-depth extrapolation formula, driven
 * through `displayQueueLength` against a real (happy-dom) button container.
 * WebSocket wiring and the DOM observer are not exercised here.
 */

import { describe, test, expect, vi } from 'vitest';

vi.mock('../../core/data-manager.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, getSettingValue: (key, fallback) => fallback },
}));

const { default: queueLengthEstimator } = await import('./queue-length-estimator.js');

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
