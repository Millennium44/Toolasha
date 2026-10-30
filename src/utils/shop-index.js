/**
 * The shop's entries grouped by the item they sell.
 *
 * Every buy-side price at +0 asks the shop what the item costs there (the shop floor in
 * `resolveItemPrice`, the cross-fill in the enhancement input rule, the Tester-shop route), and each
 * of those used to walk the whole `shopItemDetailMap` with a regex test per entry. On the test
 * server, whose Tester tab sells most things, that map is large, and one profile score asks it
 * thousands of times.
 *
 * The grouping is built once per map object and rebuilt when a different one is handed out (a new
 * init_client_data). Within one item, entries keep the map's own order, so a lookup that returns
 * the first match finds the same entry it always did.
 */

let indexedMap = null;
/** @type {Map<string, Array<[string, Object]>>|null} itemHrid → [key, entry] pairs in map order */
let index = null;

const NONE = Object.freeze([]);

/**
 * The `[key, entry]` pairs of a shop map that sell one item, in map order.
 * @param {Object|null|undefined} shopMap - A `shopItemDetailMap`
 * @param {string} itemHrid - The item
 * @returns {ReadonlyArray<[string, Object]>} Empty when the map is missing or nothing sells it
 */
export function shopEntriesFor(shopMap, itemHrid) {
    if (!shopMap || !itemHrid) return NONE;
    if (shopMap !== indexedMap) {
        const built = new Map();
        for (const [key, entry] of Object.entries(shopMap)) {
            const hrid = entry?.itemHrid;
            if (!hrid) continue;
            let list = built.get(hrid);
            if (!list) {
                list = [];
                built.set(hrid, list);
            }
            list.push([key, entry]);
        }
        index = built;
        indexedMap = shopMap;
    }
    return index.get(itemHrid) ?? NONE;
}

/** Drop the cached grouping. Tests only. */
export function _resetShopIndex() {
    indexedMap = null;
    index = null;
}
