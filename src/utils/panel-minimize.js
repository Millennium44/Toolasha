/**
 * Panel minimize
 *
 * A minimize control every floating panel can share.
 *
 * "Minimize" here is collapse-in-place: the window stays open and stays where it
 * is, but its body folds away so only the draggable header strip remains. It is
 * the answer to a screen with four panels up — you want the profit tile out of
 * the way for a moment without losing the tile, its position, or its running
 * refresh. The collapsed state is remembered per panel (in the shared geometry
 * record), so a panel left minimized reopens minimized after a refresh.
 *
 * The header, body, and close button differ per panel shell, so the caller hands
 * those in; everything else — the button, the fold, the persistence — is here.
 */

import { saveCollapsed, wasCollapsed, savedSize } from './panel-geometry.js';

/** Shown on the button when the panel is open (click to fold it away). */
const MINIMIZE_GLYPH = '–'; // en dash
/** Shown when the panel is minimized (click to bring the body back). */
const RESTORE_GLYPH = '□'; // white square

/**
 * Give a panel a minimize button that folds it to its header.
 *
 * @param {Object} options
 * @param {HTMLElement} options.panel - The floating window
 * @param {HTMLElement} options.header - The header/drag strip (stays visible)
 * @param {HTMLElement|HTMLElement[]} options.body - The content region(s) to fold
 *   away. Panels with a single body pass the element; panels whose header and
 *   content are siblings (no wrapper) pass every non-header child as an array.
 * @param {string} options.panelKey - Stable key for persisting collapsed state
 * @param {HTMLElement} [options.beforeEl] - Insert the button before this header
 *   child (usually the close button); appended to the header otherwise
 * @param {number} [options.defaultHeight] - Expanded height to spring back to
 *   when there is no remembered size (e.g. reopened already-minimized)
 * @param {string} [options.accent] - Button ink
 * @param {Function} [options.onToggle] - Called with the new collapsed boolean
 * @param {boolean} [options.restore=true] - Restore the persisted collapsed
 *   state on attach. Pass false for a panel that manages its own open lifecycle.
 * @returns {{button: HTMLElement, collapsed: boolean, setCollapsed: Function, destroy: Function}}
 */
export function attachMinimize({
    panel,
    header,
    body,
    panelKey,
    beforeEl = null,
    defaultHeight = null,
    accent = '#e8ecf5',
    onToggle = null,
    restore = true,
}) {
    let collapsed = false;
    // The height to return to. Captured when folding an expanded panel, so a
    // panel resized before minimizing springs back to the size it was resized to.
    let expandedHeight = null;
    // Some panels set a CSS min-height inline; leaving it in place keeps a folded
    // panel that tall with an empty gap below the header. Neutralize it while
    // collapsed and put it back on expand.
    let expandedMinHeight = null;

    // One body or several sibling contents.
    const bodies = (Array.isArray(body) ? body : [body]).filter(Boolean);
    // Captured at collapse time, not attach time: a tabbed panel changes which of
    // its content siblings is visible as you use it, so expanding must restore the
    // visibility it had the moment it was folded — not the tab it opened on.
    let savedDisplays = null;

    const button = document.createElement('button');
    button.className = 'toolasha-minimize-btn';
    button.textContent = MINIMIZE_GLYPH;
    button.title = 'Minimize';
    Object.assign(button.style, {
        background: 'none',
        border: 'none',
        color: accent,
        cursor: 'pointer',
        fontSize: '15px',
        lineHeight: '1',
        padding: '2px 4px',
        marginRight: '2px',
    });

    function grips() {
        return panel.querySelectorAll('.toolasha-resize-grip');
    }

    function apply(next, { persist = true } = {}) {
        collapsed = Boolean(next);
        const gs = grips();
        if (collapsed) {
            if (expandedHeight == null) {
                expandedHeight = panel.style.height || (defaultHeight != null ? `${defaultHeight}px` : '');
            }
            if (expandedMinHeight == null) expandedMinHeight = panel.style.minHeight || '';
            savedDisplays = bodies.map((el) => el.style.display || '');
            bodies.forEach((el) => (el.style.display = 'none'));
            gs.forEach((g) => (g.style.display = 'none'));
            // A resize grip on a header-height strip is a handle to resize
            // nothing; the fixed height and any min-height also have to give way
            // or the folded panel keeps its full height with an empty gap under
            // the header.
            panel.style.height = 'auto';
            panel.style.minHeight = '0';
            button.textContent = RESTORE_GLYPH;
            button.title = 'Restore';
        } else {
            bodies.forEach((el, i) => (el.style.display = savedDisplays ? savedDisplays[i] : ''));
            savedDisplays = null;
            gs.forEach((g) => (g.style.display = ''));
            const back = expandedHeight || (defaultHeight != null ? `${defaultHeight}px` : '');
            if (back) panel.style.height = back;
            if (expandedMinHeight != null) panel.style.minHeight = expandedMinHeight;
            expandedHeight = null;
            expandedMinHeight = null;
            button.textContent = MINIMIZE_GLYPH;
            button.title = 'Minimize';
        }
        panel.dataset.minimized = collapsed ? 'true' : 'false';
        if (persist && panelKey) saveCollapsed(panelKey, collapsed);
        if (onToggle) onToggle(collapsed);
    }

    button.addEventListener('click', (event) => {
        event.stopPropagation();
        apply(!collapsed);
    });

    if (beforeEl && beforeEl.parentNode === header) {
        header.insertBefore(button, beforeEl);
    } else {
        header.appendChild(button);
    }

    if (restore && panelKey) {
        // Fire-and-forget: reading storage has no business holding up the panel's
        // first paint. If it was left minimized, fold it a moment later — which is
        // what a remembered minimized panel looks like anyway. Seed expandedHeight
        // from the stored size so the first un-minimize springs to the right height.
        (async () => {
            try {
                if (!(await wasCollapsed(panelKey))) return;
                if (!panel.isConnected) return;
                const size = await savedSize(panelKey);
                if (size?.height) expandedHeight = `${size.height}px`;
                apply(true, { persist: false });
            } catch (error) {
                console.error('[PanelMinimize] Restoring minimized state failed:', error);
            }
        })();
    }

    return {
        button,
        get collapsed() {
            return collapsed;
        },
        setCollapsed: (value) => apply(Boolean(value)),
        destroy: () => button.remove(),
    };
}
