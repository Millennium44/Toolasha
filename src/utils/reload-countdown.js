/**
 * Pieces shared by the features that reload the page by themselves after a wait: the clock wording, the
 * "was the page being used?" watch, and the countdown notice with Reload now and Cancel.
 *
 * They hold no state of their own. Each feature keeps its own timer, episode and loop guard; this is only
 * the parts that were identical.
 */

import { showToast } from './toast.js';

/** Input that means the player is using the page */
export const INTERACTION_EVENTS = ['pointerdown', 'keydown', 'touchstart', 'wheel'];

/**
 * Format a timestamp as a local clock time for the notice.
 * @param {number} ms - Epoch milliseconds
 * @returns {string} e.g. "14:32"
 */
export function formatClock(ms) {
    try {
        return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
        return new Date(ms).toISOString().slice(11, 16);
    }
}

/**
 * Listen for the player using the page.
 * @param {Function} handler - Called on any pointer, key, touch or wheel input
 */
export function addInteractionListeners(handler) {
    if (typeof window === 'undefined') return;
    for (const type of INTERACTION_EVENTS) {
        window.addEventListener(type, handler, { capture: true, passive: true });
    }
}

/**
 * Stop listening for the player using the page.
 * @param {Function} handler - The handler given to {@link addInteractionListeners}
 */
export function removeInteractionListeners(handler) {
    if (typeof window === 'undefined') return;
    for (const type of INTERACTION_EVENTS) {
        window.removeEventListener(type, handler, { capture: true });
    }
}

/**
 * Show a persistent reload notice.
 *
 * The notice's ✕ ends the episode too (a hidden countdown would be a surprise reload), and with `withCancel`
 * a Cancel button is added inside the notice. The whole toast is the Reload now target.
 *
 * @param {string} message - Notice text
 * @param {Object} options - Options
 * @param {boolean} options.withCancel - Add a Cancel button
 * @param {Function} options.onReloadNow - The toast's action
 * @param {Function} options.onCancel - The Cancel button
 * @param {(handle: Object) => void} options.onDismissClick - The ✕ was pressed; given the handle it belongs to
 * @param {string} options.cancelClass - Class name for the Cancel button
 * @param {string} options.logPrefix - `[Module]` prefix for a failure to show
 * @returns {{element: HTMLElement, dismiss: Function}|null} The toast handle, or null
 */
export function showReloadNotice(
    message,
    { withCancel, onReloadNow, onCancel, onDismissClick, cancelClass, logPrefix }
) {
    let handle = null;
    try {
        handle = showToast(message, {
            kind: 'warn',
            duration: 0,
            action: { label: 'Reload now', onClick: onReloadNow },
        });
    } catch (error) {
        console.error(`${logPrefix} Could not show the notice:`, error);
    }
    if (!handle) return null;

    const element = handle.element;
    element?.querySelector?.('.toolasha-toast-dismiss')?.addEventListener('click', () => onDismissClick(handle));

    if (withCancel && element) {
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = cancelClass;
        cancel.textContent = 'Cancel';
        Object.assign(cancel.style, {
            marginTop: '6px',
            background: 'none',
            border: '1px solid currentColor',
            borderRadius: '4px',
            color: 'inherit',
            cursor: 'pointer',
            fontSize: '12px',
            padding: '2px 8px',
        });
        cancel.addEventListener('click', (event) => {
            // The whole toast is the Reload now target
            event.stopPropagation();
            onCancel();
        });
        (element.firstElementChild || element).appendChild(cancel);
    }
    return handle;
}

/**
 * Re-word a notice's text line in place.
 * @param {{element: HTMLElement}|null} handle - From {@link showReloadNotice}
 * @param {string} text - New wording
 */
export function setNoticeText(handle, text) {
    const node = handle?.element?.firstElementChild?.firstElementChild;
    if (node) node.textContent = text;
}
