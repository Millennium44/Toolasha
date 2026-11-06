/**
 * Global test setup.
 *
 * Market rules (4% tax, the finer price bins) are the live rules on both
 * servers, so the suite runs on them with no gate to force. `src/utils/server-gate.js`
 * only holds the test-server helper for staging a future change.
 */
import { afterAll, vi } from 'vitest';

/**
 * happy-dom's MutationObserver stops delivering after a garbage collection.
 *
 * `MutationObserverListener` hands the observed node its report callback inside
 * a `WeakRef` (happy-dom 20.11.1, mutation-observer/MutationObserverListener.js)
 * and keeps no strong reference to the function anywhere else, so the closure is
 * collectable the moment it is created. `Node[observeMutations]` drops any
 * listener whose `callback.deref()` comes back empty — so the first GC after
 * `observe()` silently unhooks the observer, for good, while `observer.observe`
 * still looks armed.
 *
 * That makes every MutationObserver-driven test in the suite order-dependent:
 * whether a GC lands between two mutations depends on how much allocation the
 * tests before it did, which is exactly what `--sequence.shuffle` varies (it
 * showed up as guild-credit-value's 'its own injection does not send it round
 * again' at seed 4004, where the first delivery arrived and the second never
 * did). Real browsers keep the callback alive for as long as the observer is
 * reachable, so this is the environment being wrong, not the code under test.
 *
 * The fix pins the value passed to every `WeakRef` constructed during
 * `observe()` for as long as the observer itself is alive, restoring the browser
 * lifetime. Pins are dropped on `disconnect()`, so nothing is kept beyond it.
 */
if (typeof MutationObserver !== 'undefined' && typeof WeakRef !== 'undefined') {
    const pinsByObserver = new WeakMap();
    const RealWeakRef = WeakRef;
    const nativeObserve = MutationObserver.prototype.observe;
    const nativeDisconnect = MutationObserver.prototype.disconnect;

    MutationObserver.prototype.observe = function observe(target, options) {
        let pins = pinsByObserver.get(this);
        if (!pins) pinsByObserver.set(this, (pins = new Set()));
        // Swapped only for the duration of the synchronous observe() call, so
        // nothing else in the suite sees a non-standard WeakRef
        globalThis.WeakRef = class PinningWeakRef extends RealWeakRef {
            constructor(value) {
                super(value);
                pins.add(value);
            }
        };
        try {
            return nativeObserve.call(this, target, options);
        } finally {
            globalThis.WeakRef = RealWeakRef;
        }
    };

    MutationObserver.prototype.disconnect = function disconnect() {
        pinsByObserver.get(this)?.clear();
        return nativeDisconnect.call(this);
    };
}

/**
 * Timers a test file leaves running are cleared when the file ends.
 *
 * The suite runs on worker threads (vitest.config.js), and a thread outlives the
 * file it ran. A file that never cancels a real timer (a settings-panel retry
 * loop, a rAF-based font fit) used to die with its child process; on a thread
 * the timer fires after the file's DOM environment is gone and Vitest reports
 * "document is not defined" / "requestAnimationFrame is not defined" as an
 * unhandled error against whichever file happens to be running. Under load that
 * failed whole gates runs with every test passing.
 *
 * Tracking wraps the real timer functions only. Fake timers replace them while a
 * test uses them and put the wrapper back after, so nothing else changes.
 */
{
    // On a thread this file runs once per test file against the same globals, so the wrappers are
    // installed once (marked) and only the pending set is per-file state, shared through a global.
    const STATE = Symbol.for('toolasha.test.pendingTimers');
    const state = (globalThis[STATE] ??= { pending: new Set() });
    state.pending = new Set();
    const wrap = (name, track) => {
        const current = globalThis[name];
        if (typeof current !== 'function' || current[STATE]) return;
        const wrapped = track(current);
        wrapped[STATE] = current;
        globalThis[name] = wrapped;
    };
    wrap(
        'setTimeout',
        (real) =>
            function setTimeout(fn, ms, ...args) {
                const pending = state.pending;
                let handle;
                const run = typeof fn === 'function' ? (...a) => (pending.delete(handle), fn(...a)) : fn;
                handle = real(run, ms, ...args);
                pending.add(handle);
                return handle;
            }
    );
    wrap(
        'setInterval',
        (real) =>
            function setInterval(fn, ms, ...args) {
                const handle = real(fn, ms, ...args);
                state.pending.add(handle);
                return handle;
            }
    );
    wrap(
        'clearTimeout',
        (real) =>
            function clearTimeout(handle) {
                state.pending.delete(handle);
                return real(handle);
            }
    );
    wrap(
        'clearInterval',
        (real) =>
            function clearInterval(handle) {
                state.pending.delete(handle);
                return real(handle);
            }
    );

    afterAll(() => {
        const realClearTimeout = globalThis.clearTimeout[STATE] ?? globalThis.clearTimeout;
        const realClearInterval = globalThis.clearInterval[STATE] ?? globalThis.clearInterval;
        for (const handle of state.pending) {
            realClearTimeout(handle);
            realClearInterval(handle);
        }
        state.pending.clear();
    });
}
