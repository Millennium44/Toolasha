/**
 * Item Picker Pins
 *
 * Pure ordering and merge logic shared by every item picker that lets you pin
 * an item to the front — alchemy's Alchemize Item picker (per action) and the
 * Enhance Item picker (a single list). Each caller supplies its own bucket
 * key; the alchemy caller passes an alchemy action, the enhance caller
 * passes one constant, and the logic below does not care which.
 *
 * No module state lives here — every function is a function of its
 * arguments — so it is safe to load into more than one production bundle.
 */

/**
 * Add or remove an item from one bucket's pins.
 *
 * Newly pinned items go to the end rather than the front: the order is the
 * one you built, and having each new pin displace the one you use most would
 * make the list rearrange itself every time you added to it.
 *
 * @param {Object} pins - { [bucket]: itemHrid[] }
 * @param {string} bucket - Which list to toggle within (an alchemy action, or a fixed key for a single-list picker)
 * @param {string} itemHrid - Item
 * @returns {Object} New pins
 */
export function togglePin(pins, bucket, itemHrid) {
    if (!bucket || !itemHrid) return pins || {};

    const current = (pins || {})[bucket] || [];
    const next = current.includes(itemHrid) ? current.filter((hrid) => hrid !== itemHrid) : [...current, itemHrid];

    return { ...pins, [bucket]: next };
}

/**
 * The order tiles should appear in: pinned first, in pin order, then
 * everything else exactly as it was.
 *
 * Tiles the filter has hidden are ordered along with the rest rather than
 * skipped. A hidden tile takes up no room, so putting it at the front changes
 * nothing about what you see — and checking each tile's computed style to find
 * out would cost a layout pass on every keystroke to achieve the same result.
 *
 * @param {HTMLElement[]} tiles - Tiles in their current order
 * @param {string[]} pinned - Pinned item hrids, in pin order
 * @param {Function} hridOf - Reads a tile's item hrid
 * @returns {HTMLElement[]} The tiles, reordered
 */
export function orderTiles(tiles, pinned, hridOf) {
    const list = tiles || [];
    const rank = new Map((pinned || []).map((hrid, index) => [hrid, index]));

    // The "Remove" cell shares the grid and stands for no item. It keeps the
    // first slot rather than being swept along with the unpinned items, so
    // pinning something does not push the way to clear the selection down
    // behind it.
    const fixed = [];
    const front = [];
    const rest = [];
    for (const tile of list) {
        const hrid = hridOf(tile);
        if (!hrid) fixed.push(tile);
        else if (rank.has(hrid)) front.push(tile);
        else rest.push(tile);
    }
    front.sort((a, b) => rank.get(hridOf(a)) - rank.get(hridOf(b)));

    return [...fixed, ...front, ...rest];
}

/**
 * Whether two tile orders are the same, so an unchanged menu can be left alone.
 * Reordering the DOM is itself a mutation, and a watcher that reacted to its own
 * writes would never stop.
 * @param {HTMLElement[]} a - One order
 * @param {HTMLElement[]} b - Another
 * @returns {boolean}
 */
export function sameOrder(a, b) {
    return a.length === b.length && a.every((tile, index) => tile === b[index]);
}

/**
 * Fold stored pins under the ones in memory — only consulted before this
 * character's pins have been read back (see `createCuratedRecord`): per
 * bucket, the stored order with anything pinned since appended, so a pin made
 * before the read landed is kept and nothing stored is dropped.
 * @param {Object} stored - `{ [bucket]: itemHrid[] }` as read back
 * @param {Object} memory - `{ [bucket]: itemHrid[] }` as held
 * @returns {Object} The merged pins
 */
export function mergePins(stored, memory) {
    const theirs = stored && typeof stored === 'object' ? stored : {};
    const ours = memory && typeof memory === 'object' ? memory : {};
    const out = {};
    for (const bucket of new Set([...Object.keys(theirs), ...Object.keys(ours)])) {
        const base = Array.isArray(theirs[bucket]) ? theirs[bucket] : [];
        const extra = (Array.isArray(ours[bucket]) ? ours[bucket] : []).filter((hrid) => !base.includes(hrid));
        out[bucket] = [...base, ...extra];
    }
    return out;
}

export default { togglePin, orderTiles, sameOrder, mergePins };
