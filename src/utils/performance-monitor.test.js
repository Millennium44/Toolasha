/**
 * Tests for Performance Monitor
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import performanceMonitor, { installIntervalTracing, timerCallSite } from './performance-monitor.js';

describe('PerformanceMonitor', () => {
    beforeEach(() => {
        performanceMonitor.reset();
        performanceMonitor.enabled = true;
        performanceMonitor._tabVisible = true;
    });

    test('record() is a no-op when disabled', () => {
        performanceMonitor.enabled = false;
        performanceMonitor.record('foo', 10);
        expect(performanceMonitor.getStats('foo')).toBeNull();
    });

    test('record() is a no-op when the tab is not visible', () => {
        performanceMonitor._tabVisible = false;
        performanceMonitor.record('foo', 10);
        expect(performanceMonitor.getStats('foo')).toBeNull();
    });

    test('getStats aggregates calls, totalMs, avgMs within the rolling window', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        performanceMonitor.record('feature', 10);
        performanceMonitor.record('feature', 20);

        const stats = performanceMonitor.getStats('feature');
        expect(stats.calls).toBe(2);
        expect(stats.totalMs).toBe(30);
        expect(stats.avgMs).toBe(15);
        vi.useRealTimers();
    });

    test('getStats excludes measurements older than the rolling window', () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        performanceMonitor.record('feature', 10);

        vi.setSystemTime(performanceMonitor.windowMs + 1);
        performanceMonitor.record('feature', 20);

        const stats = performanceMonitor.getStats('feature');
        expect(stats.calls).toBe(1);
        expect(stats.totalMs).toBe(20);
        vi.useRealTimers();
    });

    test('getStats returns null for an unknown metric', () => {
        expect(performanceMonitor.getStats('nonexistent')).toBeNull();
    });

    test('cpuPercent is capped at 100', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        performanceMonitor.record('busy', performanceMonitor.windowMs * 5);
        expect(performanceMonitor.getStats('busy').cpuPercent).toBe(100);
        vi.useRealTimers();
    });

    test('getAllStats cleans up and returns stats for every active metric', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        performanceMonitor.record('a', 5);
        performanceMonitor.record('b', 15);

        const all = performanceMonitor.getAllStats();
        expect(all.get('a').totalMs).toBe(5);
        expect(all.get('b').totalMs).toBe(15);
        vi.useRealTimers();
    });

    test('snapshot() stores a one-time measurement independent of the rolling window', () => {
        performanceMonitor.snapshot('init:feature', 42, 100);
        const snap = performanceMonitor.getSnapshots().get('init:feature');
        expect(snap.duration).toBe(42);
        expect(snap.startedAt).toBe(100);
    });

    test('mark() records name and time, and getMarks() sorts chronologically', () => {
        performanceMonitor.mark('second');
        performanceMonitor.marks[0].at = 200;
        performanceMonitor.mark('first');
        performanceMonitor.marks[1].at = 50;

        const marks = performanceMonitor.getMarks();
        expect(marks.map((m) => m.name)).toEqual(['first', 'second']);
    });

    test('startSpan()/getSpans() records a duration and sorts longest first', () => {
        const end1 = performanceMonitor.startSpan('parent', 'partA');
        end1();
        const end2 = performanceMonitor.startSpan('parent', 'partB');
        end2();

        // Force distinguishable durations for a deterministic sort
        performanceMonitor.spans.get('parent')[0].duration = 5;
        performanceMonitor.spans.get('parent')[1].duration = 50;

        const spans = performanceMonitor.getSpans('parent');
        expect(spans[0].part).toBe('partB');
        expect(spans[0].duration).toBe(50);
    });

    test('span() times an async function and always records even on throw', async () => {
        await performanceMonitor.span('parent', 'ok', async () => 'result');
        expect(performanceMonitor.getSpans('parent')).toHaveLength(1);

        await expect(
            performanceMonitor.span('parent', 'fails', async () => {
                throw new Error('boom');
            })
        ).rejects.toThrow('boom');
        expect(performanceMonitor.getSpans('parent')).toHaveLength(2);
    });

    test('wrap() times a synchronous function and re-throws on error while still recording', () => {
        performanceMonitor.enabled = true;
        const wrapped = performanceMonitor.wrap('sync', () => {
            throw new Error('fail');
        });
        expect(() => wrapped()).toThrow('fail');
        expect(performanceMonitor.getStats('sync').calls).toBe(1);
    });

    test('wrap() passes through untimed when disabled', () => {
        performanceMonitor.enabled = false;
        const fn = vi.fn(() => 'value');
        const wrapped = performanceMonitor.wrap('sync', fn);
        expect(wrapped()).toBe('value');
        expect(performanceMonitor.getStats('sync')).toBeNull();
    });

    test('reset() clears measurements, snapshots, and spans', () => {
        performanceMonitor.record('a', 5);
        performanceMonitor.snapshot('b', 5);
        const end = performanceMonitor.startSpan('c', 'x');
        end();

        performanceMonitor.reset();

        expect(performanceMonitor.getStats('a')).toBeNull();
        expect(performanceMonitor.getSnapshots().size).toBe(0);
        expect(performanceMonitor.getSpans('c')).toEqual([]);
    });
});

describe('measurement history bounds', () => {
    beforeEach(() => {
        performanceMonitor.reset();
        performanceMonitor.enabled = true;
        performanceMonitor._tabVisible = true;
    });

    test('a metric never read between stat pulls stays bounded per name', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        // An enabled session with the panel closed: hours of ticks, no reads
        for (let i = 0; i < 2500; i++) {
            vi.setSystemTime(1000 + i);
            performanceMonitor.record('interval:busy@1', 2);
        }
        expect(performanceMonitor.measurements.get('interval:busy@1').length).toBeLessThanOrEqual(1000);
        vi.useRealTimers();
    });

    test('bounding prefers dropping entries the rolling window no longer covers', () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        for (let i = 0; i < 1200; i++) {
            performanceMonitor.record('interval:old@1', 2);
        }
        // Move past the window, then one more record triggers the prune
        vi.setSystemTime(performanceMonitor.windowMs + 1);
        performanceMonitor.record('interval:old@1', 7);

        const entries = performanceMonitor.measurements.get('interval:old@1');
        expect(entries.length).toBe(1);
        expect(entries[0].duration).toBe(7);
        vi.useRealTimers();
    });

    test('the freshest entries survive the cap, so stats stay correct', () => {
        vi.useFakeTimers();
        vi.setSystemTime(1000);
        for (let i = 0; i < 1500; i++) {
            performanceMonitor.record('interval:hot@1', 1);
        }
        performanceMonitor.record('interval:hot@1', 99);
        const entries = performanceMonitor.measurements.get('interval:hot@1');
        expect(entries[entries.length - 1].duration).toBe(99);
        vi.useRealTimers();
    });
});

describe('stall attribution', () => {
    beforeEach(() => {
        performanceMonitor.reset();
        performanceMonitor.enabled = true;
        performanceMonitor._tabVisible = true;
    });

    test('work recorded inside the stall window is named as a suspect, biggest first', () => {
        performanceMonitor.record('event:items_updated', 12);
        performanceMonitor.record('networth:recalculate', 171);
        performanceMonitor.record('dom:Tiny', 1); // under the 5ms floor

        const now = performance.now();
        const suspects = performanceMonitor._suspectsFor({ startTime: now - 200, duration: 200 });

        expect(suspects.map((s) => s.name)).toEqual(['networth:recalculate', 'event:items_updated']);
    });

    test('work recorded long before the stall is not blamed for it', () => {
        performanceMonitor.record('networth:recalculate', 171);
        const suspects = performanceMonitor._suspectsFor({ startTime: performance.now() + 5000, duration: 100 });
        expect(suspects).toEqual([]);
    });

    test('getStalls() is empty and safe before the watch ever starts', () => {
        expect(performanceMonitor.getStalls()).toEqual([]);
    });
});

describe('interval tracing', () => {
    test('a traced interval reports its ticks into the rolling stats under a call-site name', async () => {
        installIntervalTracing();
        performanceMonitor.reset();
        performanceMonitor.enabled = true;
        performanceMonitor._tabVisible = true;

        const id = setInterval(() => {
            const t0 = performance.now();
            while (performance.now() - t0 < 3) {
                // burn >1ms so the tick clears the recording floor
            }
        }, 5);
        await new Promise((resolve) => setTimeout(resolve, 40));
        clearInterval(id);

        const traced = [...performanceMonitor.measurements.keys()].filter((name) => name.startsWith('interval:'));
        expect(traced.length).toBeGreaterThan(0);
    });

    test('installing twice does not double-wrap', () => {
        installIntervalTracing();
        const once = globalThis.setInterval;
        installIntervalTracing();
        expect(globalThis.setInterval).toBe(once);
    });

    test('clearInterval/clearTimeout still work with ids returned by the traced timers', async () => {
        installIntervalTracing();
        performanceMonitor.enabled = true;

        const tick = vi.fn();
        const intervalId = setInterval(tick, 5);
        clearInterval(intervalId);
        const timeoutId = setTimeout(tick, 5);
        clearTimeout(timeoutId);

        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(tick).not.toHaveBeenCalled();
    });

    test('a traced handler scheduling another timeout inside its tick does not re-wrap the globals', async () => {
        installIntervalTracing();
        const tracedTimeout = globalThis.setTimeout;
        const tracedInterval = globalThis.setInterval;

        let innerRan = false;
        await new Promise((resolve) => {
            setTimeout(() => {
                setTimeout(() => {
                    innerRan = true;
                    resolve();
                }, 0);
            }, 0);
        });

        expect(innerRan).toBe(true);
        expect(globalThis.setTimeout).toBe(tracedTimeout);
        expect(globalThis.setInterval).toBe(tracedInterval);
    });
});

describe('interval tracing wrapper semantics (against a fake target)', () => {
    /** A fake timer host that records registrations and lets tests fire ticks by hand. */
    function makeTarget() {
        const registered = { interval: [], timeout: [] };
        return {
            registered,
            setInterval: vi.fn(function (handler, delay, ...args) {
                registered.interval.push({ handler, delay, args, thisArg: this });
                return 111;
            }),
            setTimeout: vi.fn(function (handler, delay, ...args) {
                registered.timeout.push({ handler, delay, args, thisArg: this });
                return 222;
            }),
        };
    }

    beforeEach(() => {
        performanceMonitor.reset();
        performanceMonitor.enabled = true;
        performanceMonitor._tabVisible = true;
    });

    test('string handlers pass through untouched to the original timers', () => {
        const target = makeTarget();
        const original = { setInterval: target.setInterval, setTimeout: target.setTimeout };
        installIntervalTracing(target);

        target.setInterval('code()', 50);
        target.setTimeout('code()', 50);

        expect(original.setInterval).toHaveBeenCalledWith('code()', 50);
        expect(original.setTimeout).toHaveBeenCalledWith('code()', 50);
        expect(target.registered.interval[0].handler).toBe('code()');
        expect(target.registered.timeout[0].handler).toBe('code()');
    });

    test('extra arguments are forwarded to the registration and to the handler on tick', () => {
        const target = makeTarget();
        installIntervalTracing(target);

        const handler = vi.fn();
        const id = target.setInterval(handler, 10, 'a', 42);
        expect(id).toBe(111);
        expect(target.registered.interval[0].delay).toBe(10);
        expect(target.registered.interval[0].args).toEqual(['a', 42]);

        // The host fires the tick with the extra args, like real timers do
        target.registered.interval[0].handler('a', 42);
        expect(handler).toHaveBeenCalledWith('a', 42);
    });

    test('`this` is preserved both when registering and when the tick fires', () => {
        const target = makeTarget();
        installIntervalTracing(target);

        const handler = vi.fn();
        const someThis = { site: 'window-like' };
        target.setTimeout.call(someThis, handler, 5);
        expect(target.registered.timeout[0].thisArg).toBe(someThis);

        const tickThis = { tick: true };
        target.registered.timeout[0].handler.call(tickThis);
        expect(handler.mock.contexts[0]).toBe(tickThis);
    });

    test('repeated install does not double-wrap either timer on the target', () => {
        const target = makeTarget();
        installIntervalTracing(target);
        const tracedInterval = target.setInterval;
        const tracedTimeout = target.setTimeout;
        installIntervalTracing(target);
        expect(target.setInterval).toBe(tracedInterval);
        expect(target.setTimeout).toBe(tracedTimeout);
    });

    test('wrapper functions carry their names in source, so keep_fnames preserves them in prod stacks', () => {
        // timerCallSite skips wrapper frames by NAME. In the dev build an
        // anonymous `const traced = function (…)` gets its name inferred from
        // the variable, but terser mangles variables and keep_fnames only
        // protects functions that are named in source — an anonymous wrapper
        // ships with a mangled stack name, the skip misses, and every timer
        // collapses into one call site. Assert the names are in the source.
        const target = makeTarget();
        installIntervalTracing(target);
        expect(target.setInterval.toString()).toMatch(/^function traced\(/);
        expect(target.setTimeout.toString()).toMatch(/^function tracedTimeout\(/);
    });

    test('a restored setTimeout is re-netted on reinstall even though setInterval is still traced', () => {
        const target = makeTarget();
        const bareTimeout = target.setTimeout;
        installIntervalTracing(target);
        expect(target.setTimeout).not.toBe(bareTimeout);

        // Page code saved setTimeout before install and put it back afterwards
        target.setTimeout = bareTimeout;
        installIntervalTracing(target);

        expect(target.setTimeout).not.toBe(bareTimeout);
        expect(target.setTimeout.__toolashaTraced).toBe(true);
        expect(target.setInterval.__toolashaTraced).toBe(true);
    });
});

describe('timerCallSite parsing (synthetic stacks)', () => {
    test('Chrome: first frame past the trace internals names the caller and line', () => {
        const stack = [
            'Error',
            '    at timerCallSite (https://host/toolasha.user.js:100:15)',
            '    at Object.traced (https://host/toolasha.user.js:120:20)',
            '    at _startRefreshing (https://host/toolasha.user.js:53201:9)',
            '    at initialize (https://host/toolasha.user.js:53300:5)',
        ].join('\n');
        expect(timerCallSite(stack)).toBe('_startRefreshing@53201');
    });

    test('Chrome: an async-prefixed caller frame keeps its name', () => {
        const stack = [
            'Error',
            '    at timerCallSite (https://host/t.js:100:15)',
            '    at traced (https://host/t.js:120:20)',
            '    at async loadPrices (https://host/t.js:4210:11)',
        ].join('\n');
        expect(timerCallSite(stack)).toBe('loadPrices@4210');
    });

    test('Chrome: a constructor frame ("new Foo") keeps its name', () => {
        const stack = [
            'Error',
            '    at timerCallSite (https://host/t.js:100:15)',
            '    at tracedTimeout (https://host/t.js:150:20)',
            '    at new MarketFilter (https://host/t.js:900:7)',
        ].join('\n');
        expect(timerCallSite(stack)).toBe('MarketFilter@900');
    });

    test('Chrome: an anonymous frame (arrow in minified prod) yields anon plus line', () => {
        const stack = [
            'Error',
            '    at timerCallSite (https://host/t.js:100:15)',
            '    at traced (https://host/t.js:120:20)',
            '    at https://host/t.js:7777:3',
        ].join('\n');
        expect(timerCallSite(stack)).toBe('anon@7777');
    });

    test('Chrome: "Object.<anonymous>" normalizes to anon instead of leaking "<anonymous>"', () => {
        const stack = [
            'Error',
            '    at timerCallSite (https://host/t.js:100:15)',
            '    at traced (https://host/t.js:120:20)',
            '    at Object.<anonymous> (https://host/t.js:88:1)',
        ].join('\n');
        expect(timerCallSite(stack)).toBe('anon@88');
    });

    test('Chrome: an eval frame is parsed without crashing and keeps a line number', () => {
        const stack = [
            'Error',
            '    at timerCallSite (https://host/t.js:100:15)',
            '    at traced (https://host/t.js:120:20)',
            '    at eval (eval at run (https://host/t.js:10:5), <anonymous>:3:7)',
        ].join('\n');
        expect(timerCallSite(stack)).toBe('eval@3');
    });

    test('Firefox: named frames skip the internals with @-syntax', () => {
        const stack = [
            'timerCallSite@https://host/t.js:100:15',
            'traced@https://host/t.js:120:20',
            '_startRefreshing@https://host/t.js:53201:9',
        ].join('\n');
        expect(timerCallSite(stack)).toBe('_startRefreshing@53201');
    });

    test('Firefox: a bare "@" frame with no name yields anon plus line', () => {
        const stack = [
            'timerCallSite@https://host/t.js:100:15',
            'traced@https://host/t.js:120:20',
            '@https://host/t.js:640:5',
        ].join('\n');
        expect(timerCallSite(stack)).toBe('anon@640');
    });

    test('Firefox: an async* caller marker does not swallow the name', () => {
        const stack = [
            'timerCallSite@https://host/t.js:100:15',
            'traced@https://host/t.js:120:20',
            'async*refreshLoop@https://host/t.js:311:9',
        ].join('\n');
        expect(timerCallSite(stack)).toBe('refreshLoop@311');
    });

    test('Firefox: eval frames ("line 10 > eval") still parse to a name and line', () => {
        const stack = [
            'timerCallSite@https://host/t.js:100:15',
            'tracedTimeout@https://host/t.js:150:20',
            'runMacro@https://host/t.js line 10 > eval:2:3',
        ].join('\n');
        expect(timerCallSite(stack)).toBe('runMacro@2');
    });

    test('an unparseable stack falls back to "unknown"', () => {
        expect(timerCallSite('')).toBe('unknown');
        expect(timerCallSite('Error\n    at <anonymous>')).toBe('unknown');
        expect(timerCallSite('total garbage')).toBe('unknown');
    });

    test('without an injected stack it reads its own call stack', () => {
        const site = timerCallSite();
        expect(typeof site).toBe('string');
        expect(site.length).toBeGreaterThan(0);
    });
});
