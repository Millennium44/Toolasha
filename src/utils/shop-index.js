/**
 * The shop's entries grouped by the item they sell.
 *
 * Every buy-side price at +0 asks the shop what the item costs there (the shop floor in
 * `resolveItemPrice`, the cross-fill in the enhancement input rule, the Tester-shop route), and each
 * of those used to walk the whole `shopItemDetailMap` with a regex test per entry. On the test
 * server, whose Tester tab sells most things, that map is large, and one profile score asks it
 * thousands of times.
 *
 * The grouping is built once per map object (cached in a WeakMap keyed by the map, so alternating between
 * several maps does not rebuild each time) and a new init_client_data simply brings a new map object. Within one item, entries keep the map's own order, so a lookup that returns
 * the first match finds the same entry it always did.
 */

/** @type {WeakMap<Object, Map<string, Array<[string, Object]>>>} shop map → itemHrid → [key, entry] pairs in map order */
let indexes = new WeakMap();

const NONE = Object.freeze([]);

/**
 * The `[key, entry]` pairs of a shop map that sell one item, in map order.
 * @param {Object|null|undefined} shopMap - A `shopItemDetailMap`
 * @param {string} itemHrid - The item
 * @returns {ReadonlyArray<[string, Object]>} Empty when the map is missing or nothing sells it
 */
export function shopEntriesFor(shopMap, itemHrid) {
    if (!shopMap || !itemHrid) return NONE;
    let index = indexes.get(shopMap);
    if (!index) {
        index = new Map();
        for (const [key, entry] of Object.entries(shopMap)) {
            const hrid = entry?.itemHrid;
            if (!hrid) continue;
            let list = index.get(hrid);
            if (!list) {
                list = [];
                index.set(hrid, list);
            }
            list.push([key, entry]);
        }
        indexes.set(shopMap, index);
    }
    return index.get(itemHrid) ?? NONE;
}

/** Drop the cached grouping. Tests only. */
export function _resetShopIndex() {
    indexes = new WeakMap();
}
