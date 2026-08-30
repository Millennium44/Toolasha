/**
 * Async Pool
 *
 * Run an async worker over a list with a bounded number of them in flight.
 *
 * Extracted from `market-undercut-alerts.js`, where the bound exists for a
 * reason worth restating: the work behind it is usually a request to somebody
 * else's server, and a watchlist of forty items refreshed with no limit is
 * forty simultaneous requests from every tab that has the feature on. The
 * limit is politeness, not throughput.
 */

/**
 * Run an async worker over items with a bounded number in flight at once.
 *
 * The worker is expected to handle its own failures: a throw here rejects the
 * whole pool and abandons whatever is still queued, which for a refresh sweep
 * means one bad item costing every item behind it.
 *
 * @param {Array<any>} items - Work items
 * @param {number} limit - Maximum concurrent workers
 * @param {(item: any) => Promise<void>} worker - Per-item work
 * @returns {Promise<void>}
 */
export async function runPool(items, limit, worker) {
    const queue = [...(items || [])];
    const runners = Array.from({ length: Math.min(limit, queue.length) }, async () => {
        while (queue.length) {
            await worker(queue.shift());
        }
    });
    await Promise.all(runners);
}
