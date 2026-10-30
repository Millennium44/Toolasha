/**
 * Writing an element's text only when it changes.
 *
 * Assigning `textContent` replaces the element's text node even when the text is the same, and
 * every page MutationObserver watching the subtree is handed the removal and the insertion. Badge
 * passes redraw hundreds of tiles over values that mostly did not move.
 */

/**
 * Set an element's text, skipping the write when it already reads that.
 * @param {Element} el - Element to write
 * @param {string} text - Text it should show
 * @returns {boolean} Whether the text was written
 */
export function setTextIfChanged(el, text) {
    if (el.textContent === text) return false;
    el.textContent = text;
    return true;
}
