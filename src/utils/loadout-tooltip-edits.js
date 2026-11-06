/**
 * The edits Toolasha makes to the game's own text in a Loadouts-panel tooltip, and how to undo them.
 * Kept apart from the rewrite so the tooltip observer can restore a popper without loading price code.
 */

/** Edits made to one popper */
export const edits = new WeakMap();

/**
 * Put back everything this module changed in a popper (only where the game has not rewritten it since).
 * @param {Element} popper
 */
export function restoreLoadoutTooltip(popper) {
    const list = edits.get(popper);
    if (!list) return;
    edits.delete(popper);
    for (const edit of list) {
        if (edit.node.data === edit.shown) edit.node.data = edit.orig;
        if (edit.host) {
            if (edit.hadTitle) edit.host.setAttribute('title', edit.title);
            else edit.host.removeAttribute('title');
        }
        if (edit.hide) edit.hide.style.display = edit.hideWas;
    }
}

/**
 * Edit one text node, remembering how to undo it.
 * @param {Element} popper
 * @param {Text} node
 * @param {string} text - The new text
 * @param {string} title - Hover note
 */
export function setText(popper, node, text, title) {
    const host = node.parentElement;
    const list = edits.get(popper) || [];
    list.push({
        node,
        orig: node.data,
        shown: text,
        host,
        hadTitle: host.hasAttribute('title'),
        title: host.getAttribute('title'),
    });
    edits.set(popper, list);
    node.data = text;
    host.setAttribute('title', title);
}
