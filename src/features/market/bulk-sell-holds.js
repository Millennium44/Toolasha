/**
 * Bulk Sell holds
 *
 * A claim on inventory that keeps items out of the bulk sell queue.
 *
 * Deliberately ignorant of why anything is held. A flip waiting to be relisted,
 * a crafting reserve, something promised to a guildmate — the assistant only
 * needs the keys, so no reason has to be modelled here, and a caller with a
 * reason of its own need not live in this repository to use it.
 *
 * Kept apart from the assistant itself because that module reaches for the DOM
 * as it loads, which puts it out of reach of a test.
 */

/**
 * The key an inventory stack is held by: bare hrid for an unenhanced item,
 * `hrid+level` once it carries an enhancement. The same convention the custom
 * inventory tabs use, so a hold list and a tab list can be written alike.
 * @param {string} itemHrid - Item
 * @param {number} [enhancementLevel=0] - Enhancement level
 * @returns {string}
 */
export function holdKey(itemHrid, enhancementLevel = 0) {
    const level = Math.max(0, Math.floor(Number(enhancementLevel) || 0));
    return level > 0 ? `${itemHrid}+${level}` : String(itemHrid);
}

/**
 * Gather every key the registered providers want held back.
 *
 * A provider that throws is skipped rather than allowed to take the sell queue
 * with it. Failing to hold something back is bad; being unable to sell at all
 * because someone else's hold list is broken is worse — so the error is
 * reported and those items are offered for sale as they were before the
 * provider existed.
 *
 * @param {Map<string, Function>} providers - name -> () => iterable of keys
 * @param {Function} [onError] - Called with (name, error)
 * @returns {Set<string>} Keys to keep out of the sell queue
 */
export function collectHeldKeys(providers, onError) {
    const held = new Set();
    for (const [name, provide] of providers) {
        try {
            for (const key of provide() || []) {
                if (typeof key === 'string' && key) held.add(key);
            }
        } catch (error) {
            onError?.(name, error);
        }
    }
    return held;
}
