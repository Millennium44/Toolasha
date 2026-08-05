/**
 * One toast, for the whole script.
 *
 * Two of these already existed and neither could be reused: the combat
 * simulator's is parented to its own panel, so it vanishes with the panel and
 * cannot say anything about the panel failing to open; the dungeon tracker's is
 * centred, modal-looking and `pointer-events: none`, so it cannot carry a
 * button and blocks nothing while it sits over the middle of the game.
 *
 * What is taken from each: the tracker's fade-and-remove lifetime and its use of
 * a real z-index constant rather than a guessed number, and the simulator's
 * per-kind colouring. What is added is the part both lack — a stack, so a second
 * message does not overwrite the first, a dismiss control, and an optional
 * action, because "N features failed to start" is only useful if you can get
 * from it to which ones.
 *
 * It sits one above `PANEL_Z_CAP` so it is over every floating panel, and still
 * under the game's own MUI modal layer (~1300) so it never covers a dialog the
 * player is trying to answer.
 */

import { PANEL_Z_CAP } from './panel-z-index.js';

/** The stack's container, looked up by id so a stale copy is never orphaned */
export const TOAST_CONTAINER_ID = 'toolasha-toasts';

/** Beyond this the oldest is dropped — a stack taller than this is noise */
const MAX_TOASTS = 4;

/** How long the fade before an expiring toast is removed */
const FADE_MS = 180;

/** Default lifetime; `duration: 0` means it stays until dismissed */
const DEFAULT_DURATION_MS = 6000;

const KINDS = {
    info: { border: 'rgba(74, 158, 255, 0.75)', background: 'rgba(12, 22, 38, 0.97)', text: '#cfe6ff' },
    warn: { border: 'rgba(255, 152, 0, 0.75)', background: 'rgba(30, 22, 10, 0.97)', text: '#ffcc80' },
    error: { border: 'rgba(255, 82, 82, 0.8)', background: 'rgba(36, 14, 14, 0.97)', text: '#ff9e9e' },
};

/** Live toasts, oldest first */
const active = [];

/**
 * The stack container, created on first use.
 * @returns {HTMLElement} The container element
 */
function getContainer() {
    const existing = document.getElementById(TOAST_CONTAINER_ID);
    if (existing) return existing;

    const container = document.createElement('div');
    container.id = TOAST_CONTAINER_ID;
    Object.assign(container.style, {
        position: 'fixed',
        right: '16px',
        bottom: '16px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
        gap: '8px',
        // The container spans a column of empty space most of the time; only
        // the toasts themselves may take clicks
        pointerEvents: 'none',
        maxWidth: 'min(420px, 92vw)',
        zIndex: String(PANEL_Z_CAP + 1),
    });
    document.body.appendChild(container);
    return container;
}

/**
 * Drop a toast from the stack.
 * @param {Object} entry - Internal toast record
 * @param {boolean} animate - Fade it out rather than removing it at once
 */
function remove(entry, animate) {
    const index = active.indexOf(entry);
    if (index === -1) return;
    active.splice(index, 1);

    if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = null;
    }

    if (!animate) {
        entry.element.remove();
        pruneContainer();
        return;
    }

    entry.element.style.transition = `opacity ${FADE_MS}ms ease`;
    entry.element.style.opacity = '0';
    setTimeout(() => {
        entry.element.remove();
        pruneContainer();
    }, FADE_MS);
}

/** Take the container away once nothing is in it, so it cannot swallow clicks */
function pruneContainer() {
    const container = document.getElementById(TOAST_CONTAINER_ID);
    if (container && container.childElementCount === 0) container.remove();
}

/**
 * Show a message that does not stop what the player is doing.
 *
 * @param {string} message - What to say. Plain text; never HTML
 * @param {Object} [options] - Options
 * @param {'info'|'warn'|'error'} [options.kind='info'] - Colouring and urgency
 * @param {number} [options.duration] - Lifetime in ms; `0` stays until dismissed
 * @param {{label: string, onClick: Function}} [options.action] - Optional follow-up.
 *   The whole toast becomes clickable when this is given, because a small button
 *   is a poor target and the message itself is the obvious thing to press
 * @returns {{element: HTMLElement, dismiss: Function}|null} Handle, or null with no DOM
 */
export function showToast(message, { kind = 'info', duration, action } = {}) {
    if (typeof document === 'undefined' || !document.body) return null;

    const palette = KINDS[kind] || KINDS.info;
    const lifetime = duration === undefined ? DEFAULT_DURATION_MS : duration;

    const element = document.createElement('div');
    element.className = `toolasha-toast toolasha-toast-${kind}`;
    element.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    element.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
    Object.assign(element.style, {
        pointerEvents: 'auto',
        display: 'flex',
        alignItems: 'flex-start',
        gap: '10px',
        background: palette.background,
        border: `1px solid ${palette.border}`,
        borderRadius: '8px',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.5)',
        padding: '10px 12px',
        color: palette.text,
        fontFamily: "'Segoe UI', sans-serif",
        fontSize: '13px',
        lineHeight: '1.35',
        maxWidth: '100%',
    });

    const body = document.createElement('div');
    body.style.flex = '1';

    const text = document.createElement('div');
    text.textContent = message;
    body.appendChild(text);

    const entry = { element, timer: null };

    if (action && typeof action.onClick === 'function') {
        const hint = document.createElement('div');
        hint.className = 'toolasha-toast-action';
        hint.textContent = action.label || 'Details';
        Object.assign(hint.style, {
            marginTop: '4px',
            fontWeight: '600',
            textDecoration: 'underline',
            fontSize: '12px',
        });
        body.appendChild(hint);

        element.style.cursor = 'pointer';
        element.addEventListener('click', (event) => {
            // The ✕ is inside the toast and must not also trigger the action
            if (event.target.closest('.toolasha-toast-dismiss')) return;
            try {
                action.onClick();
            } catch (error) {
                console.error('[Toast] Action failed:', error);
            }
            remove(entry, false);
        });
    }

    const dismissBtn = document.createElement('button');
    dismissBtn.className = 'toolasha-toast-dismiss';
    dismissBtn.type = 'button';
    dismissBtn.textContent = '✕';
    dismissBtn.title = 'Dismiss';
    dismissBtn.setAttribute('aria-label', 'Dismiss');
    Object.assign(dismissBtn.style, {
        background: 'none',
        border: 'none',
        color: 'inherit',
        cursor: 'pointer',
        fontSize: '12px',
        lineHeight: '1',
        opacity: '0.7',
        padding: '2px 4px',
    });
    dismissBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        remove(entry, false);
    });

    element.appendChild(body);
    element.appendChild(dismissBtn);

    getContainer().appendChild(element);
    active.push(entry);

    // Oldest first, so a burst of failures still leaves the newest readable
    while (active.length > MAX_TOASTS) {
        remove(active[0], false);
    }

    if (lifetime > 0) {
        entry.timer = setTimeout(() => remove(entry, true), lifetime);
    }

    return { element, dismiss: () => remove(entry, false) };
}

/**
 * Clear the stack — used on teardown, and by tests.
 */
export function dismissAllToasts() {
    while (active.length) {
        remove(active[0], false);
    }
    pruneContainer();
}

/**
 * How many toasts are up. Exported for tests rather than for callers.
 * @returns {number} Live toast count
 */
export function activeToastCount() {
    return active.length;
}
