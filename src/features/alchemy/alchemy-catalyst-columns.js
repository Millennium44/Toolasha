/**
 * Shared per-session catalyst columns for the alchemy history viewers.
 *
 * The decompose, transmute and coinify session tables each carry two
 * icon-headed columns — the action's own catalyst and Prime Catalyst — that
 * show how many were consumed in that session, or an em dash when none were.
 * The drawing was identical three times over (icon header with a title/
 * aria-label instead of text, a cell that is either an icon+count or a dash);
 * this is the one copy.
 *
 * A viewer's item icon is drawn through its own `appendItemIcon`, which
 * caches the sprite sheet URL on the instance — that stays the viewer's, and
 * is passed in here rather than imported, so this module has no DOM
 * dependency of its own and is trivial to unit-test.
 */

/**
 * Fill in a catalyst column's `<th>` — an icon standing in for the label,
 * with the label itself living on `title`/`aria-label` since the icon alone
 * carries no accessible text.
 *
 * @param {HTMLElement} th - The header cell
 * @param {HTMLElement} labelSpan - The span the caller already appended to `th`
 * @param {string} label - Item display name, e.g. "Prime Catalyst"
 * @param {string} catalystHrid - The catalyst's item hrid
 * @param {(el: HTMLElement, hrid: string, size: number) => void} appendIcon - The viewer's icon renderer
 */
export function renderCatalystColumnHeader(th, labelSpan, label, catalystHrid, appendIcon) {
    labelSpan.title = label;
    labelSpan.style.cursor = 'default';
    th.title = label;
    th.setAttribute('aria-label', label);
    appendIcon(labelSpan, catalystHrid, 20);
}

/**
 * Render one session's catalyst cell: an icon and count, or an em dash.
 *
 * A dash is the only rendering for "none used" and for "not recorded" alike
 * unless `unrecorded` is set — callers that can tell the two apart (a session
 * that predates catalyst tracking versus one that measured zero) should pass
 * it, so the dash carries a tooltip saying which it is instead of reading as
 * a silent zero.
 *
 * @param {HTMLElement} cell - The `<td>` to fill
 * @param {string} catalystHrid - The catalyst's item hrid
 * @param {number} count - How many were recorded as consumed
 * @param {(el: HTMLElement, hrid: string, size: number) => void} appendIcon - The viewer's icon renderer
 * @param {{unrecorded?: boolean, estimated?: boolean}} [opts] - `unrecorded`: the session predates
 *   catalyst tracking, so the dash means "unknown", not "zero". `estimated`: the count comes from
 *   `predictedCatalystHrid × successes`, not a measured wire count — the count is marked, not blank.
 */
export function renderCatalystCountCell(cell, catalystHrid, count, appendIcon, opts = {}) {
    if (opts.unrecorded || !(count > 0)) {
        const dash = document.createElement('span');
        dash.textContent = '—';
        dash.style.color = '#888';
        if (opts.unrecorded) {
            dash.title = 'This session predates catalyst tracking — use is unknown, not zero.';
        }
        cell.appendChild(dash);
        return;
    }

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display: flex; align-items: center; gap: 4px;';

    appendIcon(wrapper, catalystHrid, 18);

    const countSpan = document.createElement('span');
    countSpan.textContent = count.toLocaleString() + (opts.estimated ? '◇' : '');
    if (opts.estimated) {
        countSpan.title =
            'Estimated from the catalyst in the slot at session start × successes — not a measured count.';
    }
    wrapper.appendChild(countSpan);
    cell.appendChild(wrapper);
}
