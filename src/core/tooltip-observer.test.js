/** @vitest-environment happy-dom */
/**
 * Tests for Tooltip Observer
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const observerState = vi.hoisted(() => ({ handler: null, unregisterCalled: false }));

vi.mock('./dom-observer.js', () => ({
    default: {
        onClass: vi.fn((_name, _classes, callback) => {
            observerState.handler = callback;
            return () => {
                observerState.unregisterCalled = true;
            };
        }),
    },
}));

const { default: tooltipObserver } = await import('./tooltip-observer.js');

beforeEach(() => {
    tooltipObserver.disable();
    observerState.handler = null;
    observerState.unregisterCalled = false;
    document.body.innerHTML = '';
});

describe('subscribe / notify', () => {
    test('auto-initializes on first subscriber', () => {
        tooltipObserver.subscribe('A', () => {});
        expect(tooltipObserver.isInitialized).toBe(true);
        expect(observerState.handler).toBeTypeOf('function');
    });

    test('notifies subscribers with "opened" when a tooltip element appears', () => {
        const callback = vi.fn();
        tooltipObserver.subscribe('A', callback);

        const parent = document.createElement('div');
        const tooltip = document.createElement('div');
        parent.appendChild(tooltip);
        document.body.appendChild(parent);

        observerState.handler(tooltip);

        expect(callback).toHaveBeenCalledWith(tooltip, 'opened');
    });

    test('notifies subscribers with "closed" when the tooltip is removed from its parent', async () => {
        const callback = vi.fn();
        tooltipObserver.subscribe('A', callback);

        const parent = document.createElement('div');
        const tooltip = document.createElement('div');
        parent.appendChild(tooltip);
        document.body.appendChild(parent);

        observerState.handler(tooltip);
        callback.mockClear();

        parent.removeChild(tooltip);
        // MutationObserver callbacks fire as a microtask
        await Promise.resolve();
        await Promise.resolve();

        expect(callback).toHaveBeenCalledWith(tooltip, 'closed');
    });

    test('a tooltip torn down with its ancestor is still reported closed, and the observer is let go', async () => {
        const callback = vi.fn();
        tooltipObserver.subscribe('A', callback);

        const ancestor = document.createElement('div');
        const parent = document.createElement('div');
        const tooltip = document.createElement('div');
        parent.appendChild(tooltip);
        ancestor.appendChild(parent);
        document.body.appendChild(ancestor);

        observerState.handler(tooltip);
        callback.mockClear();
        expect(tooltipObserver.removalObserver).not.toBeNull();

        ancestor.remove();
        await Promise.resolve();
        await Promise.resolve();

        expect(callback).toHaveBeenCalledWith(tooltip, 'closed');
        expect(tooltipObserver.open.size).toBe(0);
        expect(tooltipObserver.removalObserver).toBeNull();
    });

    test('two open tooltips share one observer', () => {
        tooltipObserver.subscribe('A', vi.fn());
        const first = document.createElement('div');
        const second = document.createElement('div');
        document.body.append(first, second);
        observerState.handler(first);
        const observer = tooltipObserver.removalObserver;
        observerState.handler(second);
        expect(tooltipObserver.removalObserver).toBe(observer);
        expect(tooltipObserver.open.size).toBe(2);
    });

    test('multiple subscribers are all notified', () => {
        const a = vi.fn();
        const b = vi.fn();
        tooltipObserver.subscribe('A', a);
        tooltipObserver.subscribe('B', b);

        const parent = document.createElement('div');
        const tooltip = document.createElement('div');
        parent.appendChild(tooltip);
        document.body.appendChild(parent);

        observerState.handler(tooltip);

        expect(a).toHaveBeenCalled();
        expect(b).toHaveBeenCalled();
    });

    test('a subscriber that throws does not prevent others from being notified', () => {
        tooltipObserver.subscribe('Throwing', () => {
            throw new Error('boom');
        });
        const ok = vi.fn();
        tooltipObserver.subscribe('OK', ok);

        const parent = document.createElement('div');
        const tooltip = document.createElement('div');
        parent.appendChild(tooltip);
        document.body.appendChild(parent);

        expect(() => observerState.handler(tooltip)).not.toThrow();
        expect(ok).toHaveBeenCalled();
    });

    test('unsubscribe stops future notifications', () => {
        const callback = vi.fn();
        tooltipObserver.subscribe('A', callback);
        tooltipObserver.unsubscribe('A');

        const parent = document.createElement('div');
        const tooltip = document.createElement('div');
        parent.appendChild(tooltip);
        document.body.appendChild(parent);
        observerState.handler(tooltip);

        expect(callback).not.toHaveBeenCalled();
    });

    test('initialize() is idempotent — calling twice does not re-register the observer', () => {
        tooltipObserver.subscribe('A', () => {});
        const handlerAfterFirst = observerState.handler;
        tooltipObserver.initialize();
        expect(observerState.handler).toBe(handlerAfterFirst);
    });
});

describe('disable', () => {
    test('unregisters the underlying observer and clears subscribers', () => {
        tooltipObserver.subscribe('A', () => {});
        tooltipObserver.disable();

        expect(observerState.unregisterCalled).toBe(true);
        expect(tooltipObserver.isInitialized).toBe(false);
        expect(tooltipObserver.subscribers.size).toBe(0);
    });
});
