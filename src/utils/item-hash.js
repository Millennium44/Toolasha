/**
 * Item hashes
 *
 * The game names the item an action is working on with a `::`-joined tuple
 * rather than a plain hrid — `161296::/item_locations/inventory::/items/enhancers_top::5`
 * — and the shape of that tuple has varied: the leading item id is there on some
 * messages and absent on others, and the trailing enhancement level is absent on
 * anything that cannot be enhanced.
 *
 * So it is read by finding the parts rather than by counting them. The segment
 * beginning `/items/` is the item, and a trailing segment that parses as a
 * number is its enhancement level. Nothing else in the tuple is guessed at,
 * because nothing else in it has held still.
 *
 * Lives here because three features had grown their own copy of this and they
 * had drifted — one returned `{ itemHrid: null, level: 0 }` for a hash it could
 * not read, another threw on `undefined`. A hash that names no item yields a
 * null hrid, which every caller reads as "nothing to say" rather than as level
 * zero of something unknown.
 */

/**
 * The item and its enhancement level, out of an action's item hash.
 *
 * @param {string} itemHash - `primaryItemHash` or `secondaryItemHash` as sent on
 *   an action; a bare `/items/...` hrid is accepted too
 * @returns {{itemHrid: string|null, level: number}} What the hash names, with
 *   `itemHrid` null when it names no item
 */
export function parseItemHash(itemHash) {
    if (typeof itemHash !== 'string' || !itemHash) {
        return { itemHrid: null, level: 0 };
    }

    const parts = itemHash.split('::');
    const itemHrid = parts.find((part) => part.startsWith('/items/')) || null;

    let level = 0;
    // A trailing segment that is an hrid is a location or an item, not a level
    const last = parts[parts.length - 1];
    if (last && !last.startsWith('/')) {
        const parsed = Number.parseInt(last, 10);
        if (Number.isFinite(parsed)) level = parsed;
    }

    return { itemHrid, level };
}
