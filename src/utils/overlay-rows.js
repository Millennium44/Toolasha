/**
 * Overlay Rows
 *
 * The registry of rows the overlay panel draws.
 *
 * Deliberately here in `utils` rather than beside the panel in `features/ui`,
 * because of how this project ships. The production build is six separate
 * bundles loaded in order — core, utils, market, actions, combat, ui — and a
 * module that is not declared shared is **copied into every bundle that imports
 * it**, each copy with its own state. A registry living in the UI bundle would
 * therefore give the combat features one row list, the market features another,
 * and the panel a third, so the panel would render nothing. Worse, ui loads
 * last, so a combat feature registering at module scope would be reaching for a
 * bundle that does not exist yet.
 *
 * Utils loads before every feature bundle and is declared shared in
 * `rollup.config.js`, so there is exactly one list and it exists before anyone
 * registers into it.
 *
 * None of this shows up in the dev standalone build, which is a single bundle
 * where every arrangement works.
 */

/**
 * Rows, in registration order.
 *
 * Module-level so a feature can register while the shell is still asleep — the
 * alternative is every feature having to know whether the panel has started yet.
 * @type {Array<{key: string, name: string, render: Function, defaultVisible: boolean}>}
 */
const rows = [];

/**
 * Add a row to the overlay.
 *
 * Safe to call before the panel exists, and safe to call twice — a repeated key
 * replaces the earlier definition rather than drawing the row twice, so a feature
 * that re-initialises does not double up.
 *
 * @param {Object} row - Row definition
 * @param {string} row.key - Stable identifier, used as the storage key
 * @param {string} row.name - Label in the row picker
 * @param {Function} row.render - `(container: HTMLElement) => void`, called per refresh
 * @param {boolean} [row.defaultVisible] - Whether it starts on
 * @param {Function} [row.onOpen] - Called when the row is double-clicked. A row is
 *   a summary; this is where the panel behind it opens. Rows without one are
 *   simply not interactive.
 */
export function registerRow({ key, name, render, defaultVisible = true, onOpen = null }) {
    if (!key || typeof render !== 'function') {
        console.error('[OverlayPanel] A row needs a key and a render function:', key);
        return;
    }

    const definition = { key, name: name || key, render, defaultVisible, onOpen };
    const existing = rows.findIndex((row) => row.key === key);
    if (existing >= 0) rows[existing] = definition;
    else rows.push(definition);
}

/**
 * The registered rows, in the order they should be offered.
 * Exported for tests and for anything that wants to know what is available.
 * @returns {Array<Object>} Row definitions
 */
export function registeredRows() {
    return [...rows];
}

/**
 * Put saved settings and the rows that actually exist together.
 *
 * Kept pure so the awkward cases are testable: a row saved in the order but since
 * removed from the code, and a row added by an update that no saved order has
 * heard of. The first must not leave a hole and the second must not be lost at
 * the bottom of a list nobody knows to look at.
 *
 * @param {Array<Object>} available - Registered rows
 * @param {Object} saved - `{ visible: {key: bool}, order: string[] }`
 * @returns {Array<Object>} Rows to draw, in order, each with `visible`
 */
export function resolveRows(available, saved) {
    const order = saved?.order || [];
    const visible = saved?.visible || {};

    const known = new Map(available.map((row) => [row.key, row]));
    const ordered = [];

    for (const key of order) {
        const row = known.get(key);
        // A key left over from a row that no longer exists
        if (!row) continue;
        ordered.push(row);
        known.delete(key);
    }
    // Anything the saved order has not heard of is new, and goes at the end
    ordered.push(...known.values());

    return ordered.map((row) => ({
        ...row,
        visible: visible[row.key] ?? row.defaultVisible,
    }));
}

/**
 * Move a key one place through an order.
 *
 * Works on the full order rather than only the visible rows, so hiding a row and
 * showing it again does not quietly move it.
 *
 * @param {string[]} order - Current order
 * @param {string} key - What to move
 * @param {number} delta - -1 for up, 1 for down
 * @returns {string[]} A new order
 */
export function moveRow(order, key, delta) {
    const index = order.indexOf(key);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= order.length) return order;

    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    return next;
}
