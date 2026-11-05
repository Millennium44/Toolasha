/**
 * The panel's own state, as the overlay tile reads it.
 *
 * A plain object the panel keeps current, rather than the tile importing the
 * panel module directly — the tile registers itself from a side-effect import
 * inside `ironcow-panel.js`, so a direct import back would be a circular
 * dependency between the two. This module imports neither, so both can import
 * it without one.
 *
 * The panel is the only writer. Everything else only reads.
 */
const runtime = {
    /** This character's manual stage ticks, from `ironcow-store.js` */
    overrides: {},
    /** The last costed loop, or null before one has been costed this session */
    loop: null,
    /** What the queue helper is set to (`{max, maxCap, basis, hours}`), for the strip's next-set reserve */
    batchSpec: null,
    /** Whether Bells you can buy now also keeps cash back for the next set */
    keepBatchCash: false,
    /** The character the spec and the switch belong to; the strip ignores them for any other */
    owner: null,
    /** Opens or closes the panel; replaced once the panel exists */
    toggle: () => {},
};

export default runtime;
