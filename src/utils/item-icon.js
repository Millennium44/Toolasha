/**
 * Resolving which item a rendered game tile shows, from its icon.
 *
 * The game labels item icons two ways: a translatable one (the SVG's
 * `aria-label`, and `Item_name` text — rendered in whatever language the player
 * selected) and a stable one (the icon's `<use>` sprite reference, an internal
 * asset ID like `#radiant_fiber` that never changes with locale). Matching
 * display names against `itemDetailMap` names, which are always English,
 * silently fails for every non-English player — so identity lookups should read
 * the sprite and keep any name lookup only as a fallback.
 */

/**
 * An item's HRID from its icon's `<use>` sprite reference — locale independent,
 * unlike the translatable aria-label / Item_name text.
 *
 * When an item detail map is given, the resolved HRID is validated against it,
 * so an unexpected sprite id returns null and the caller can fall back to a
 * name-based lookup rather than acting on a guess.
 *
 * @param {Element|null|undefined} container - Any element containing the item's icon SVG
 * @param {Object} [itemDetailMap] - `gameData.itemDetailMap` to validate against
 * @returns {string|null} Item HRID (e.g. `/items/radiant_fiber`) or null
 */
export function itemHridFromIcon(container, itemDetailMap) {
    const href = container?.querySelector?.('svg use')?.getAttribute?.('href');
    const match = href?.match(/#(.+)$/);
    if (!match) return null;
    const itemHrid = `/items/${match[1]}`;
    if (itemDetailMap && !itemDetailMap[itemHrid]) return null;
    return itemHrid;
}
