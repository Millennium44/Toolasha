/** @vitest-environment happy-dom */
/**
 * Tests for Centralized DOM Observer
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import domObserver from './dom-observer.js';

beforeEach(() => {
    document.body.innerHTML = '';
});

afterEach(() => {
    domObserver.stop();
    domObserver.handlers = [];
});

describe('register / onClass matching', () => {
    test('onClass fires the callback when the exact node matches the class', () => {
        const callback = vi.fn();
        const unregister = domObserver.onClass('Test', 'foo', callback);

        const el = document.createElement('div');
        el.className = 'foo bar';
        // Directly exercise the registered handler (bypasses MutationObserver timing)
        const registeredHandler = domObserver.handlers.find((h) => h.name === 'Test');
        registeredHandler.callback(el);

        expect(callback).toHaveBeenCalledWith(el);
        unregister();
    });

    test('onClass also matches descendants of an inserted subtree', () => {
        const callback = vi.fn();
        domObserver.onClass('Test', 'target', callback);

        const container = document.createElement('div');
        const child = document.createElement('span');
        child.className = 'target';
        container.appendChild(child);

        const registeredHandler = domObserver.handlers.find((h) => h.name === 'Test');
        registeredHandler.callback(container);

        expect(callback).toHaveBeenCalledWith(child);
    });

    test('supports matching against multiple class names', () => {
        const callback = vi.fn();
        domObserver.onClass('Test', ['a', 'b'], callback);
        const el = document.createElement('div');
        el.className = 'b-something';

        const registeredHandler = domObserver.handlers.find((h) => h.name === 'Test');
        registeredHandler.callback(el);

        expect(callback).toHaveBeenCalledWith(el);
    });

    test('does not fire for an element with no matching class', () => {
        const callback = vi.fn();
        domObserver.onClass('Test', 'target', callback);
        const el = document.createElement('div');
        el.className = 'unrelated';

        const registeredHandler = domObserver.handlers.find((h) => h.name === 'Test');
        registeredHandler.callback(el);

        expect(callback).not.toHaveBeenCalled();
    });

    test('handles SVG elements whose className is not a plain string', () => {
        const callback = vi.fn();
        domObserver.onClass('Test', 'target', callback);
        const svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        // svg className is an SVGAnimatedString, not a plain string

        const registeredHandler = domObserver.handlers.find((h) => h.name === 'Test');
        expect(() => registeredHandler.callback(svgEl)).not.toThrow();
        expect(callback).not.toHaveBeenCalled();
    });

    test('unregister removes the handler', () => {
        const callback = vi.fn();
        const unregister = domObserver.onClass('Test', 'foo', callback);
        expect(domObserver.handlers.some((h) => h.name === 'Test')).toBe(true);

        unregister();
        expect(domObserver.handlers.some((h) => h.name === 'Test')).toBe(false);
    });

    test('a handler that throws does not stop the observer or other handlers', () => {
        domObserver.start();
        domObserver.register('Throwing', () => {
            throw new Error('boom');
        });
        const secondCallback = vi.fn();
        domObserver.register('Second', secondCallback);

        const el = document.createElement('div');
        document.body.appendChild(el);

        // Give MutationObserver a tick to process (happy-dom runs microtask-based)
        return Promise.resolve().then(() => {
            expect(secondCallback).toHaveBeenCalled();
        });
    });
});

describe('debouncedCallback', () => {
    test('collapses multiple rapid calls into a single callback with the last element', () => {
        vi.useFakeTimers();
        const callback = vi.fn();
        domObserver.register('Debounced', callback, { debounce: true, debounceDelay: 50 });

        const handler = domObserver.handlers.find((h) => h.name === 'Debounced');
        const el1 = document.createElement('div');
        const el2 = document.createElement('div');

        domObserver.debouncedCallback(handler, el1, {});
        domObserver.debouncedCallback(handler, el2, {});

        expect(callback).not.toHaveBeenCalled();
        vi.advanceTimersByTime(50);

        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(el2, {});
        vi.useRealTimers();
    });

    test('uses the default delay when none is specified', () => {
        vi.useFakeTimers();
        const callback = vi.fn();
        domObserver.register('Debounced2', callback, { debounce: true });
        const handler = domObserver.handlers.find((h) => h.name === 'Debounced2');
        const el = document.createElement('div');

        domObserver.debouncedCallback(handler, el, {});
        vi.advanceTimersByTime(49);
        expect(callback).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(callback).toHaveBeenCalledTimes(1);
        vi.useRealTimers();
    });
});

describe('start / stop', () => {
    test('start() sets isObserving to true and stop() resets it', () => {
        domObserver.start();
        expect(domObserver.isObserving).toBe(true);
        domObserver.stop();
        expect(domObserver.isObserving).toBe(false);
        expect(domObserver.observer).toBeNull();
    });

    test('start() is idempotent', () => {
        domObserver.start();
        const observerRef = domObserver.observer;
        domObserver.start();
        expect(domObserver.observer).toBe(observerRef);
    });

    test('stop() clears pending debounce timers', () => {
        vi.useFakeTimers();
        domObserver.start();
        const callback = vi.fn();
        domObserver.register('DebouncedStop', callback, { debounce: true, debounceDelay: 50 });
        const handler = domObserver.handlers.find((h) => h.name === 'DebouncedStop');
        domObserver.debouncedCallback(handler, document.createElement('div'), {});

        domObserver.stop();
        vi.advanceTimersByTime(100);
        expect(callback).not.toHaveBeenCalled();
        vi.useRealTimers();
    });
});

describe('getStats', () => {
    test('reports handler count and observing state', () => {
        domObserver.register('A', () => {});
        domObserver.register('B', () => {}, { debounce: true });
        const stats = domObserver.getStats();

        expect(stats.handlerCount).toBe(2);
        expect(stats.handlers.map((h) => h.name)).toEqual(['A', 'B']);
        expect(stats.handlers[1].debounced).toBe(true);
    });
});
