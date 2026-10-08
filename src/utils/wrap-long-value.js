/**
 * The one rule for a value drawn beside a label in a fixed-width panel: a
 * figure holds one line, a sentence wraps inside its box instead of running
 * past the edge and forcing a horizontal scrollbar.
 */

/** Values longer than this wrap instead of holding one line. */
export const NOWRAP_VALUE_CHARS = 24;

/**
 * Let a value element wrap when it is long, keep it on one line when it is not.
 * The element should be a flex child of a row whose label does not shrink.
 *
 * @param {HTMLElement} element - The value element
 * @param {string} text - What it says (already set as its text)
 * @returns {HTMLElement} The same element
 */
export function fitValueToBox(element, text) {
    Object.assign(element.style, { minWidth: '0', textAlign: 'right', overflowWrap: 'anywhere' });
    element.style.whiteSpace = String(text).length > NOWRAP_VALUE_CHARS ? 'normal' : 'nowrap';
    return element;
}
