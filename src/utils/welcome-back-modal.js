/**
 * Finding the game's "Welcome Back!" modal
 *
 * Two features now live inside somebody else's dialog — the offline value line
 * (`features/ui/welcome-back-value.js`) and the session briefing
 * (`features/briefing/session-briefing.js`) — and both have to answer the same
 * question before they can do anything: is this inserted node part of the
 * offline-progress modal, or is it one of the dozen other dialogs the game
 * opens?
 *
 * One copy of that answer rather than two, because the failure mode of two is
 * not "one stops working". It is one of them decorating a dialog the other
 * declined, which is how a script ends up writing a briefing into the settings
 * window the day the game renames a CSS module.
 *
 * The detection deliberately does not lean on the welcome modal's own class name
 * any harder than it has to. The dialog is found through `Modal_modalContent` —
 * the class the draggable-modals feature already relies on for every dialog in
 * the game — and identified by the offline-progress markers or its own heading.
 * If the game renames the welcome modal, its decorations stop appearing; they do
 * not start appearing somewhere else.
 */

import domObserver from '../core/dom-observer.js';

/**
 * How the welcome modal announces itself.
 *
 * The class is checked before the text because a class survives translation and
 * a heading does not; the heading is the fallback for the day the CSS module is
 * renamed, which is the more likely of the two.
 */
const MODAL_MARKER = /WelcomeBack|OfflineProgress/i;
const MODAL_HEADING = /welcome back/i;

/** The class names worth waking a handler for */
export const WELCOME_BACK_CLASS_HINTS = ['Modal_modalContent', 'WelcomeBack', 'OfflineProgress'];

/**
 * Is this element the welcome modal?
 * @param {HTMLElement} el - Candidate
 * @returns {boolean} True when it is
 */
export function isWelcomeBackModal(el) {
    if (!el?.className && !el?.querySelector) return false;

    const own = typeof el.className === 'string' ? el.className : '';
    if (MODAL_MARKER.test(own)) return true;
    if (el.querySelector?.(`[class*="WelcomeBack"], [class*="OfflineProgress"]`)) return true;

    for (const heading of el.querySelectorAll?.('h1, h2, h3, [class*="title"], [class*="header"]') || []) {
        if (MODAL_HEADING.test(heading.textContent || '')) return true;
    }
    return false;
}

/**
 * The welcome modal this inserted node belongs to, if any.
 * @param {HTMLElement} node - A node the observer saw appear
 * @returns {HTMLElement|null} The modal content element, or null
 */
export function findWelcomeBackModal(node) {
    const content = node?.closest?.('[class*="Modal_modalContent"]') || node;
    if (!content?.querySelectorAll) return null;
    if (!isWelcomeBackModal(content)) return null;
    // The dialog the game actually draws is a full-viewport container holding a
    // backdrop and the box you can see. Appending to the container puts a
    // decoration below the fold — measured live on 2026-09-17, at y=1099 in a
    // 1091px viewport, off screen and full page width. The content element
    // inside the box is where a decoration belongs.
    return content.querySelector('[class*="modalContent"]') || content;
}

/**
 * The welcome modal already on screen, if there is one.
 *
 * A `MutationObserver` reports insertions, so a watcher installed after the
 * game has drawn this dialog never hears about it. Anything that starts up
 * while the player is arriving — which is exactly when this dialog is on
 * screen — has to look once as well as listen.
 *
 * @param {Document|HTMLElement} [root] - Where to look; the document by default
 * @returns {HTMLElement|null} The modal, or null when none is open
 */
export function currentWelcomeBackModal(root = document) {
    const selector = WELCOME_BACK_CLASS_HINTS.map((hint) => `[class*="${hint}"]`).join(', ');
    for (const candidate of root?.querySelectorAll?.(selector) || []) {
        const modal = findWelcomeBackModal(candidate);
        if (modal) return modal;
    }
    return null;
}

/**
 * Call back once per inserted node that turns out to be the welcome modal.
 *
 * Debounced, because the modal's contents arrive in a burst: a handler that ran
 * on the first insertion would read half a night. Callers must still treat the
 * callback as repeatable — the game may insert into the dialog again — and make
 * their own decoration idempotent.
 *
 * @param {string} name - Handler name, for the observer's own debugging
 * @param {Function} callback - `(modal) => void`
 * @returns {Function} Unregister
 */
export function onWelcomeBackModal(name, callback) {
    return domObserver.onClass(
        name,
        WELCOME_BACK_CLASS_HINTS,
        (node) => {
            const modal = findWelcomeBackModal(node);
            if (modal) callback(modal);
        },
        { debounce: true, debounceDelay: 150 }
    );
}
