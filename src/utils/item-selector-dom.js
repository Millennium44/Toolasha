/**
 * Item Selector DOM
 *
 * Reading what is inside an open `ItemSelector_menu` — shared by every
 * feature that pins or reorders items in one of the game's item pickers
 * (alchemy's Alchemize/Consumed Item selectors, the Enhance Item selector).
 * The component is the same everywhere, so the geometry only needs solving
 * once; picking out *which* open menu belongs to which picker is caller
 * business and stays in each feature.
 *
 * Pure functions over the DOM handed in — no module state — so this is safe
 * to load into more than one production bundle.
 */

/** An open item selector's dropdown menu */
export const MENU_SELECTOR = 'div[class*="ItemSelector_menu"]';
/** One item tile inside a menu (or elsewhere the game draws an item) */
export const TILE_SELECTOR = 'div[class*="Item_itemContainer"]';

/**
 * The item a tile stands for, from the sprite it draws.
 * @param {HTMLElement} tile - An item tile
 * @returns {string} Item hrid, or '' for a tile that is not an item
 */
export function tileItemHrid(tile) {
    const href = tile?.querySelector('use')?.getAttribute('href') || '';
    const name = href.split('#')[1];
    return name ? `/items/${name}` : '';
}

/**
 * The item tiles in a menu, and the element they all sit in.
 *
 * Returns the elements that can actually be **moved**, which are not always the
 * tiles themselves. Two earlier versions assumed the tiles were siblings —
 * first taking the parent of the first tile as the grid, then the parent
 * holding the most — and both came back with exactly one tile, because each
 * tile is wrapped in a container of its own and no two share a parent.
 *
 * So the grid is found as the deepest element containing every tile, and each
 * tile is represented by whichever of its ancestors is a direct child of that
 * grid. Reordering has to move those, not the tiles inside them.
 *
 * @param {HTMLElement} menu - An item selector menu
 * @returns {{grid: HTMLElement|null, tiles: HTMLElement[]}}
 */
export function menuTiles(menu) {
    const all = Array.from(menu?.querySelectorAll(TILE_SELECTOR) || []);
    if (!all.length) return { grid: null, tiles: [] };

    const holdsEveryTile = (node) => all.every((tile) => node.contains(tile));
    let grid = all[0].parentElement;
    while (grid && !holdsEveryTile(grid)) grid = grid.parentElement;
    if (!grid) return { grid: null, tiles: [] };

    const seen = new Set();
    const tiles = [];
    for (const tile of all) {
        let node = tile;
        while (node.parentElement && node.parentElement !== grid) node = node.parentElement;
        // A wrapper holding two tiles would otherwise be listed twice
        if (node.parentElement === grid && !seen.has(node)) {
            seen.add(node);
            tiles.push(node);
        }
    }
    return { grid, tiles };
}

export default { MENU_SELECTOR, TILE_SELECTOR, tileItemHrid, menuTiles };
