/**
 * Hand the browser a frame from inside a long async loop.
 *
 * Loops that only ever await already-resolved promises never leave the
 * microtask queue, so however many `await`s they contain they are still one
 * long task and the game's progress bars hitch through them. A macrotask
 * boundary is the difference. Callers use the clock pattern:
 *
 *     let sliceStart = performance.now();
 *     for (const item of items) {
 *         work(item);
 *         if (performance.now() - sliceStart > 12) {
 *             await yieldToBrowser();
 *             sliceStart = performance.now();
 *         }
 *     }
 *
 * @returns {Promise<void>} Settles on the next macrotask (or scheduler slot)
 */
export function yieldToBrowser() {
    if (typeof scheduler !== 'undefined' && typeof scheduler.yield === 'function') return scheduler.yield();
    return new Promise((resolve) => setTimeout(resolve, 0));
}
