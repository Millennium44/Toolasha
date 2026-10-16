/**
 * Minimizable sections for the Combat Sim Upgrade tab.
 *
 * A section is a header element (see {@link collapseHeaderHtml}) followed, inside the same parent, by its
 * body siblings. Collapsing hides every sibling after the header, so the markup of a section needs no
 * wrapper. The collapsed state lives in a plain `{ [key]: true }` map owned by the panel, because the
 * results container is redrawn wholesale on every sort and replan: the map is reapplied after each draw.
 */

const CARET_OPEN = '▼';
const CARET_CLOSED = '▶';

/**
 * Escape text placed in the header markup.
 * @param {string} value - Raw text
 * @returns {string} HTML-safe text
 */
function esc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Header line of a minimizable section.
 * @param {Object} options
 * @param {string} options.key - Section id; the key of the collapsed-state map
 * @param {string} options.title - Title HTML (trusted markup)
 * @param {string} [options.summary] - Plain-text one-liner shown only while collapsed
 * @param {string} [options.style] - Extra inline style for the header
 * @returns {string} HTML
 */
export function collapseHeaderHtml({ key, title, summary = '', style = '' }) {
    return (
        `<div data-collapse-key="${esc(key)}" role="button" tabindex="0" aria-expanded="true" ` +
        `title="Click to minimize or expand" ` +
        `style="cursor:pointer; user-select:none; display:flex; align-items:baseline; gap:6px; ${style}">` +
        `<span data-collapse-caret style="font-size:10px; color:#888; flex:0 0 auto;">${CARET_OPEN}</span>` +
        `<span>${title}</span>` +
        `<span data-collapse-summary style="display:none; color:#aaa; font-weight:400; font-size:11px; ` +
        `min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(summary)}</span>` +
        `</div>`
    );
}

/**
 * Show or hide one section.
 * @param {Element} header - The section's header element
 * @param {boolean} collapsed - True to hide the body
 */
export function setSectionCollapsed(header, collapsed) {
    header.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    const caret = header.querySelector('[data-collapse-caret]');
    if (caret) caret.textContent = collapsed ? CARET_CLOSED : CARET_OPEN;
    const summary = header.querySelector('[data-collapse-summary]');
    if (summary) summary.style.display = collapsed && summary.textContent ? 'inline' : 'none';
    for (let el = header.nextElementSibling; el; el = el.nextElementSibling) {
        if (collapsed) {
            // Remember an inline display of its own (flex rows) so expanding puts it back
            if (el.dataset.collapsePrev === undefined) el.dataset.collapsePrev = el.style.display;
            el.style.display = 'none';
        } else if (el.dataset.collapsePrev !== undefined) {
            el.style.display = el.dataset.collapsePrev;
            delete el.dataset.collapsePrev;
        }
    }
}

/**
 * Apply the collapsed map to every section header under `root` and make each header clickable and
 * keyboard-operable. Safe to call again on the same root: a header is wired once.
 * @param {Element} root - Container holding the section headers
 * @param {Object<string, boolean>} collapsedMap - Section id to collapsed; toggles write into it
 * @param {Function} [onToggle] - Called after a user toggle (persist the map here)
 * @param {Function} [beforeToggle] - Called before a user toggle changes anything (close popovers here)
 */
export function enhanceCollapsibles(root, collapsedMap, onToggle, beforeToggle) {
    if (!root) return;
    root.querySelectorAll('[data-collapse-key]').forEach((header) => {
        const key = header.getAttribute('data-collapse-key');
        setSectionCollapsed(header, Boolean(collapsedMap[key]));
        if (header.dataset.collapseWired) return;
        header.dataset.collapseWired = '1';
        const toggle = () => {
            if (beforeToggle) beforeToggle();
            const next = !collapsedMap[key];
            if (next) collapsedMap[key] = true;
            else delete collapsedMap[key];
            // Every header of this key (a section can sit in two places) follows the map
            root.querySelectorAll('[data-collapse-key]').forEach((h) => {
                if (h.getAttribute('data-collapse-key') === key) setSectionCollapsed(h, next);
            });
            if (onToggle) onToggle();
        };
        header.addEventListener('click', (event) => {
            // The "Run again" button lives in a header and keeps its own job
            if (event.target.closest?.('button, input, select, a')) return;
            toggle();
        });
        header.addEventListener('keydown', (event) => {
            if (event.target !== header) return;
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggle();
            }
        });
    });
}
