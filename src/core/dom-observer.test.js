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

    test('retains one record per handler however many events arrive between fires', () => {
        // Sustained churn faster than the debounce delay means the timer never fires.
        // Appending to a list there retains every intermediate node and MutationRecord;
        // only the newest is ever used, so retention must not grow with event count.
        vi.useFakeTimers();
        const callback = vi.fn();
        domObserver.register('Churn', callback, { debounce: true, debounceDelay: 50 });
        const handler = domObserver.handlers.find((h) => h.name === 'Churn');

        let last = null;
        for (let i = 0; i < 10_000; i++) {
            last = document.createElement('div');
            domObserver.debouncedCallback(handler, last, { i });
        }

        expect(domObserver.debouncedLatest.size).toBe(1);
        expect(domObserver.debouncedLatest.get(handler)).toEqual({ node: last, mutation: { i: 9999 } });

        vi.advanceTimersByTime(50);
        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(last, { i: 9999 });
        // Nothing is held once the callback has run
        expect(domObserver.debouncedLatest.size).toBe(0);
        vi.useRealTimers();
    });

    test('maxWait fires the callback under churn that never lets the timer settle', () => {
        // Without maxWait, a mutation every 40ms against a 50ms delay resets the
        // trailing timer forever and the callback starves — the In Progress tab's
        // ticking bar. maxWait bounds that: once the oldest un-fired mutation
        // crosses 200ms, the next one fires instead of deferring again.
        vi.useFakeTimers();
        const callback = vi.fn();
        domObserver.register('Starve', callback, { debounce: true, debounceDelay: 50, debounceMaxWait: 200 });
        const handler = domObserver.handlers.find((h) => h.name === 'Starve');

        for (let elapsed = 0; elapsed <= 240; elapsed += 40) {
            domObserver.debouncedCallback(handler, document.createElement('div'), { elapsed });
            vi.advanceTimersByTime(40);
        }

        expect(callback).toHaveBeenCalledTimes(1);
        vi.useRealTimers();
    });

    test('without maxWait the same churn starves the callback entirely', () => {
        vi.useFakeTimers();
        const callback = vi.fn();
        domObserver.register('StarveNoMax', callback, { debounce: true, debounceDelay: 50 });
        const handler = domObserver.handlers.find((h) => h.name === 'StarveNoMax');

        for (let elapsed = 0; elapsed <= 240; elapsed += 40) {
            domObserver.debouncedCallback(handler, document.createElement('div'), { elapsed });
            vi.advanceTimersByTime(40);
        }

        expect(callback).not.toHaveBeenCalled();
        vi.useRealTimers();
    });

    test('unregistering drops the pending record instead of stranding it', () => {
        vi.useFakeTimers();
        const callback = vi.fn();
        const unregister = domObserver.register('Dropped', callback, { debounce: true, debounceDelay: 50 });
        const handler = domObserver.handlers.find((h) => h.name === 'Dropped');
        domObserver.debouncedCallback(handler, document.createElement('div'), {});

        unregister();

        expect(domObserver.debouncedLatest.has(handler)).toBe(false);
        vi.advanceTimersByTime(100);
        expect(callback).not.toHaveBeenCalled();
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

describe('dispatch', () => {
    test('an inserted container reaches every class handler whose class it holds, through one query', () => {
        const seenA = [];
        const seenB = [];
        const generic = vi.fn();
        domObserver.onClass('A', 'Foo_item', (el) => seenA.push(el));
        domObserver.onClass('B', ['Bar_row', 'Baz_x'], (el) => seenB.push(el));
        domObserver.register('G', generic);

        const container = document.createElement('div');
        container.innerHTML =
            '<div class="Foo_item__1"></div><span class="Bar_row__2"><i class="Foo_item__3"></i></span><b class="Other"></b>';
        const qsa = vi.spyOn(container, 'querySelectorAll');

        domObserver.dispatch(container, {});

        expect(qsa).toHaveBeenCalledTimes(1);
        expect(qsa.mock.calls[0][0]).toBe('[class*="Foo_item"],[class*="Bar_row"],[class*="Baz_x"]');
        expect(seenA.map((e) => e.className)).toEqual(['Foo_item__1', 'Foo_item__3']);
        expect(seenB.map((e) => e.className)).toEqual(['Bar_row__2']);
        expect(generic).toHaveBeenCalledWith(container, {});
    });

    test('handlers fire in registration order whether they match the container or something inside it', () => {
        const order = [];
        // Registered first, matches a descendant; registered second, matches
        // the container itself. Deciding container-matches before descendant
        // matches ran B before A, which is not the order they registered in.
        domObserver.onClass('A', 'Inner_x', () => order.push('A'));
        domObserver.onClass('B', 'Outer_y', () => order.push('B'));
        domObserver.register('G', () => order.push('G'));
        domObserver.onClass('C', 'Inner_x', () => order.push('C'));

        const container = document.createElement('div');
        container.className = 'Outer_y__1';
        container.innerHTML = '<div class="Inner_x__1"></div>';
        const qsa = vi.spyOn(container, 'querySelectorAll');

        domObserver.dispatch(container, {});

        expect(order).toEqual(['A', 'B', 'G', 'C']);
        // Still one combined query for the whole dispatch
        expect(qsa).toHaveBeenCalledTimes(1);
    });

    test('the combined query is skipped entirely when every class handler matched the node itself', () => {
        domObserver.onClass('A', 'Outer_y', () => {});
        const node = document.createElement('div');
        node.className = 'Outer_y__1';
        node.innerHTML = '<div class="Other"></div>';
        const qsa = vi.spyOn(node, 'querySelectorAll');

        domObserver.dispatch(node, {});

        expect(qsa).not.toHaveBeenCalled();
    });

    test('a node that matches itself is not also searched for that handler, and the selector follows registrations', () => {
        const seen = [];
        const unregister = domObserver.onClass('A', 'Foo_item', (el) => seen.push(el));
        const node = document.createElement('div');
        node.className = 'Foo_item__outer';
        node.innerHTML = '<div class="Foo_item__inner"></div>';

        domObserver.dispatch(node, {});
        expect(seen.map((e) => e.className)).toEqual(['Foo_item__outer']);

        unregister();
        seen.length = 0;
        domObserver.dispatch(node, {});
        expect(seen).toEqual([]);
        expect(domObserver._selector()).toBeNull();
    });

    test('a debounced class handler is handed the container and matches for itself when it fires', () => {
        vi.useFakeTimers();
        const seen = [];
        domObserver.onClass('D', 'Foo_item', (el) => seen.push(el.className), { debounce: true, debounceDelay: 20 });
        const container = document.createElement('div');
        container.innerHTML = '<div class="Foo_item__1"></div><div class="Foo_item__2"></div>';

        domObserver.dispatch(container, {});
        expect(seen).toEqual([]);
        vi.advanceTimersByTime(20);
        expect(seen).toEqual(['Foo_item__1', 'Foo_item__2']);
        vi.useRealTimers();
    });
});

describe('per-className handler cache', () => {
    test('matches hashed CSS-module class tokens, and mid-token substrings too', () => {
        const skill = [];
        const mid = [];
        // The common shape: the watched string is a prefix of the hashed token
        domObserver.onClass('Skill', 'SkillAction_skillAction', (el) => skill.push(el.className));
        // The shape a token-prefix index would silently drop
        domObserver.onClass('Mid', 'skillAction__', (el) => mid.push(el.className));

        const container = document.createElement('div');
        container.innerHTML =
            '<div class="SkillAction_skillAction__1esCp"></div>' +
            '<div class="Other_thing__9zZ"></div>' +
            '<div class="SkillAction_skillAction__2abCd extra"></div>';

        domObserver.dispatch(container, {});

        expect(skill).toEqual(['SkillAction_skillAction__1esCp', 'SkillAction_skillAction__2abCd extra']);
        expect(mid).toEqual(['SkillAction_skillAction__1esCp', 'SkillAction_skillAction__2abCd extra']);
    });

    test('the cache is rebuilt when a handler registers or unregisters', () => {
        const first = [];
        domObserver.onClass('First', 'Panel_row', (el) => first.push(el.className));

        const container = document.createElement('div');
        container.innerHTML = '<div class="Panel_row__aB"></div>';
        domObserver.dispatch(container, {});
        expect(first).toHaveLength(1);

        // A handler registered after the cache was populated must still be seen
        const second = [];
        const unregisterSecond = domObserver.onClass('Second', 'Panel_row', (el) => second.push(el.className));
        domObserver.dispatch(container, {});
        expect(first).toHaveLength(2);
        expect(second).toEqual(['Panel_row__aB']);

        unregisterSecond();
        domObserver.dispatch(container, {});
        expect(second).toHaveLength(1);
        expect(first).toHaveLength(3);
    });

    test('handlers still fire in registration order across container and descendant matches', () => {
        const order = [];
        domObserver.onClass('Outer', 'Outer_y', () => order.push('outer'));
        domObserver.onClass('Inner', 'Inner_x', () => order.push('inner'));

        const node = document.createElement('div');
        node.className = 'Outer_y__hash';
        node.innerHTML = '<span class="Inner_x__hash"></span>';

        domObserver.dispatch(node, {});
        expect(order).toEqual(['outer', 'inner']);
    });
});
