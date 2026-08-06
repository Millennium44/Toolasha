/**
 * Work that should not hold up the rest of the start.
 *
 * Features are initialised one after another and each is awaited, so anything a
 * feature does inside `initialize()` is time every feature behind it spends
 * waiting. That is right for wiring up listeners, which is fast, and wrong for
 * reading a year of history out of IndexedDB or repricing an entire inventory —
 * work whose result nobody is looking at yet, and which cost the page thirteen
 * seconds between two features alone.
 *
 * The rule this expresses: **register synchronously, compute later**. A feature
 * hands its heavy part to `runInBackground`, gets a promise back, and awaits that
 * promise anywhere its own correctness depends on the work being done. Everything
 * else gets to start.
 */

import performanceMonitor from './performance-monitor.js';

/**
 * Wait for a quiet moment, or the next tick if the browser will not say.
 *
 * @returns {Promise<void>}
 */
function whenIdle() {
    return new Promise((resolve) => {
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(() => resolve(), { timeout: 2000 });
        } else {
            setTimeout(resolve, 0);
        }
    });
}

/**
 * Run something after the page has drawn, and time it.
 *
 * Timed under `bg:` so a startup trace can tell work that delayed the page from
 * work that merely happened afterwards — the difference between a slow start and
 * a busy one, which a flat list of durations cannot show.
 *
 * Failures are logged and swallowed: this is work nobody is waiting on, and a
 * rejected promise nobody awaits is an unhandled rejection in the console for
 * every user who has that feature on.
 *
 * @param {string} name - What it is, e.g. `networth`
 * @param {Function} work - The heavy part
 * @returns {Promise<*>} Resolves when the work is done, never rejects
 */
export async function runInBackground(name, work) {
    await whenIdle();
    const startedAt = performanceMonitor.sinceBoot();
    try {
        return await work();
    } catch (error) {
        console.error(`[Toolasha] Background work "${name}" failed:`, error);
        return null;
    } finally {
        performanceMonitor.snapshot(`bg:${name}`, performanceMonitor.sinceBoot() - startedAt, startedAt);
    }
}

/**
 * Hand the main thread back to the event loop.
 *
 * A long synchronous loop — pricing an entire enhanced inventory, say — freezes
 * the page for as long as it runs. Awaiting this between slices turns one long
 * blocking macrotask into several short ones, so the browser gets to paint,
 * handle input, and let other awaited work (feature init behind it) proceed.
 *
 * A macrotask (`setTimeout`) rather than a microtask on purpose: a microtask
 * runs before the browser paints or handles input, which is the freeze this is
 * meant to break, not defer.
 *
 * @returns {Promise<void>}
 */
export function yieldToEventLoop() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}
