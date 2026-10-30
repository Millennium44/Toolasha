/**
 * Reading the change a market price notification carries.
 *
 * `marketAPI.notifyListeners()` hands every listener a descriptor of what moved (see there). A
 * listener that keeps derived figures asks this whether any price it could have read moved at all,
 * and skips its work when a burst only re-confirmed prices already held (a book re-opened with the
 * same top of book). Anything it cannot read as such a burst — no argument, a dataManager event's
 * payload, a full change — counts as "moved", so a listener never misses a reprice by asking.
 *
 * Kept out of marketplace.js on purpose: most suites mock that module whole, and a named export
 * there would have to be added to every one of their factories.
 */

/**
 * Whether a notification may have changed any price getPrice() returns.
 * @param {*} change - The listener's argument
 * @returns {boolean} False only for a partial change that moved no price
 */
export function pricesMoved(change) {
    if (!change || typeof change !== 'object') return true;
    if (change.full !== false) return true;
    return !(change.keys instanceof Set) || change.keys.size > 0;
}
