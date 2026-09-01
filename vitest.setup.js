/**
 * Global test setup.
 *
 * The 8/13/2026 marketplace patch (5% tax, shrine in gear score) is gated on the
 * server hostname via `isMarketplacePatchLive()` in src/utils/server-gate.js.
 * The suite exercises the post-patch behaviour — that is the forward state and
 * the numbers the tax tests are written against — so force the gate on for every
 * test file here, rather than stubbing the global `location` (which other code
 * reads for `href`/`origin` and would break).
 *
 * Tests that need the pre-patch rule re-mock the module themselves with a
 * toggle (see score-calculator.test.js); server-gate's own test un-mocks it to
 * exercise the real hostname logic.
 */
import { vi } from 'vitest';

vi.mock('./src/utils/server-gate.js', () => ({ isMarketplacePatchLive: () => true }));

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
