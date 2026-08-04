/**
 * Listing markers
 *
 * A registry letting other scripts put their own toggle against each row of
 * Market History and of the live My Listings table.
 *
 * Deliberately ignorant of what a mark means. A listing might be one half of a
 * trade somebody is tracking, a purchase to record against a guild ledger,
 * something to come back to — the viewer needs a glyph, a state and a handler,
 * and nothing else. That is what lets a marker whose meaning lives in a private
 * script appear in a public one without the meaning coming with it.
 *
 * Pure registry: no DOM, so the decisions here are testable and the rendering
 * stays where the rest of the table is built.
 */

/**
 * A marker's presentation for one listing.
 * @typedef {Object} MarkerState
 * @property {string} glyph - What to show
 * @property {boolean} active - Whether this listing carries the mark
 * @property {string} title - Hover text explaining what toggling would do
 */

/**
 * Validate a marker before it reaches the table, so a malformed one is refused
 * at registration rather than throwing once per row.
 * @param {Object} marker - { stateFor, onToggle }
 * @returns {string|null} What is wrong, or null when it is usable
 */
export function markerProblem(marker) {
    if (!marker || typeof marker !== 'object') return 'marker must be an object';
    if (typeof marker.stateFor !== 'function') return 'marker needs a stateFor(listing) function';
    if (typeof marker.onToggle !== 'function') return 'marker needs an onToggle(listing) function';
    return null;
}

/**
 * Ask a marker how a listing should look.
 *
 * A marker that throws is treated as having nothing to say about that row: one
 * script's broken marker must not empty the market history table, which is the
 * user's own trading record and far more valuable than any annotation on it.
 *
 * @param {Object} marker - Registered marker
 * @param {Object} listing - The listing row
 * @param {Function} [onError] - Called with (name, error)
 * @param {Object} [context] - Where the row is being drawn, e.g.
 *   { surface: 'history' } or { surface: 'myListings' }. A finished trade and a
 *   working order are different things to mark, and a marker that cannot tell
 *   them apart has to treat them the same
 * @returns {MarkerState|null} null when the marker declines this row
 */
export function markerStateFor(marker, listing, onError, context) {
    try {
        const state = marker.stateFor(listing, context);
        if (!state) return null;
        return {
            glyph: String(state.glyph ?? '★'),
            active: !!state.active,
            title: String(state.title ?? ''),
            color: state.color ? String(state.color) : null,
        };
    } catch (error) {
        onError?.(marker.name, error);
        return null;
    }
}

/**
 * The markers registered against Market History rows.
 */
class ListingMarkers {
    constructor() {
        this.markers = new Map();
        this.listeners = new Set();
    }

    /**
     * Add a column of toggles to Market History.
     *
     *     const remove = Toolasha.Market.listingMarkers.register('my-script', {
     *         stateFor: (listing) => ({
     *             glyph: '★',
     *             active: isTracked(listing),
     *             title: 'Track this listing',
     *         }),
     *         onToggle: (listing) => toggleTracked(listing),
     *     });
     *
     * Both functions are also handed a context object naming the surface the
     * row is on — `history` for Market History, `myListings` for the live
     * listings table — so a marker can offer different things in each.
     *
     * @param {string} name - Identifies the caller, and reports its errors
     * @param {Object} marker - { stateFor(listing, context), onToggle(listing, context) }
     * @returns {Function} Removes the marker
     */
    register(name, marker) {
        const problem = markerProblem(marker);
        if (problem) throw new TypeError(`listingMarkers.register("${name}"): ${problem}`);

        const id = String(name || 'anonymous');
        this.markers.set(id, { ...marker, name: id });
        this.notify();
        return () => {
            this.markers.delete(id);
            this.notify();
        };
    }

    /**
     * @param {string} name - The name it was registered under
     * @returns {boolean} Whether anything was removed
     */
    unregister(name) {
        const removed = this.markers.delete(String(name));
        if (removed) this.notify();
        return removed;
    }

    /** @returns {Array<Object>} Registered markers, in registration order */
    all() {
        return [...this.markers.values()];
    }

    /**
     * Be told when markers change, so an open table can redraw. A marker
     * registered after the table was built would otherwise not appear until it
     * was next opened.
     * @param {Function} listener - Called with no arguments
     * @returns {Function} Stops listening
     */
    onChange(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** @private */
    notify() {
        for (const listener of this.listeners) {
            try {
                listener();
            } catch (error) {
                console.error('[ListingMarkers] Change listener failed:', error);
            }
        }
    }
}

const listingMarkers = new ListingMarkers();
export default listingMarkers;
