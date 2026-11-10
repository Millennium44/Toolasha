/**
 * Escape a value for HTML text or a quoted HTML attribute without needing a DOM.
 * This is not a URL, CSS, JavaScript, or unquoted-attribute sanitizer. Callers
 * that display nullish values as empty text should pass `value ?? ''`.
 *
 * @param {*} value - Raw value to convert to text
 * @returns {string} Text safe to interpolate into HTML text or quoted attributes
 */
export function escapeHtml(value) {
    const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(value).replace(/[&<>"']/g, (character) => entities[character]);
}
