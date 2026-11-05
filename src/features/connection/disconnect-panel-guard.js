/**
 * Disconnect Panel Guard
 *
 * While the game shows its full-page "Disconnected" message, Toolasha's floating panels, the
 * overlay and the chips drew over it. This hides them with one body class and one stylesheet, and
 * changes nothing else: no panel's hide() runs, so no open state or geometry is written, and the
 * panels are back exactly as they were when the connection returns.
 *
 * Two signals, either of which is enough:
 * - The game socket is gone. `webSocketHook.activeGameSocket` is cleared when the active socket
 *   closes and is set again as soon as a new one is constructed, so a second socket closing while
 *   the main one is fine, and a character switch (the arriving socket attaches before the
 *   departing one closes), never read as a disconnect. A close Toolasha made itself is ignored. A
 *   short grace period absorbs the gap when the old socket does close first; a new socket opening
 *   cancels it. A takeover (close 1005) never reconnects, so the wait costs a moment at most.
 * - The tab title starts with "Disconnected" (the game's own wording, "Disconnected - Milky Way
 *   Idle"). Immediate, and covers a page that loaded straight into the disconnected state.
 *
 * The game's Disconnected markup itself is not recorded anywhere in this repo, so no class name is
 * relied on. Toasts are not hidden: the takeover notice is one, and it is the way back.
 */

import webSocketHook from '../../core/websocket.js';
import { SURFACE_ATTRIBUTE } from '../../utils/surface-marker.js';

export const BODY_CLASS = 'toolasha-game-disconnected';
const STYLE_ID = 'toolasha-disconnect-panel-guard';

/** How long a socket may stay gone before the panels are hidden */
export const GRACE_MS = 3000;

/**
 * `visibility`, not `display`: layout is kept, so no panel is re-measured or re-clamped into a new
 * position while it is out of sight. Descendants are named too: a child that sets its own
 * `visibility: visible` (a widget's selected label, some Bulk Sell controls) overrides an inherited
 * `hidden`, even an `!important` one, and would draw on its own over the game's message.
 */
const CSS = `
body.${BODY_CLASS} [${SURFACE_ATTRIBUTE}],
body.${BODY_CLASS} [${SURFACE_ATTRIBUTE}] *,
body.${BODY_CLASS} .toolasha-scroll-planner-bar,
body.${BODY_CLASS} .toolasha-scroll-planner-bar *,
body.${BODY_CLASS} .toolasha-scroll-planner-modal,
body.${BODY_CLASS} .toolasha-scroll-planner-modal * {
    visibility: hidden !important;
    pointer-events: none !important;
}
`;

/**
 * Whether a tab title is the game's Disconnected title.
 * @param {string} title - document.title
 * @returns {boolean}
 */
export function isDisconnectedTitle(title) {
    return /^\s*Disconnected\b/i.test(title || '');
}

class DisconnectPanelGuard {
    constructor() {
        this.initialized = false;
        this.graceTimer = null;
        this.socketGone = false;
        this.titleObserver = null;
        this.onOpen = null;
        this.onClose = null;
    }

    initialize() {
        if (this.initialized) return;
        this.initialized = true;
        if (document.head) {
            this._addStyle();
        } else {
            // Started at document-start, before the page has a head or body
            document.addEventListener('DOMContentLoaded', () => this._ready(), { once: true });
        }
        this._listen();
    }

    _ready() {
        if (!this.initialized) return;
        this._addStyle();
        this._watchTitle();
        this._apply();
    }

    /** Own style tag: utils/dom.js pulls in the data layer, and this has to start before it */
    _addStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    _listen() {
        this.onOpen = () => this._socketOpened();
        this.onClose = (event, socket) => this._socketClosed(socket);
        webSocketHook.onSocketEvent('open', this.onOpen);
        webSocketHook.onSocketEvent('close', this.onClose);

        this._watchTitle();
        this._apply();
    }

    _watchTitle() {
        if (this.titleObserver || typeof MutationObserver !== 'function' || !document.head) return;
        this.titleObserver = new MutationObserver(() => this._apply());
        this.titleObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
    }

    disable() {
        if (!this.initialized) return;
        this.initialized = false;
        clearTimeout(this.graceTimer);
        this.graceTimer = null;
        this.socketGone = false;
        webSocketHook.offSocketEvent('open', this.onOpen);
        webSocketHook.offSocketEvent('close', this.onClose);
        this.titleObserver?.disconnect();
        this.titleObserver = null;
        document.body?.classList.remove(BODY_CLASS);
    }

    cleanup() {
        this.disable();
    }

    _socketOpened() {
        clearTimeout(this.graceTimer);
        this.graceTimer = null;
        this.socketGone = false;
        this._apply();
    }

    _socketClosed(socket) {
        // The hook has already cleared activeGameSocket if this was the active one; anything left
        // there is a live socket, so this close (a stale or second socket) says nothing.
        if (webSocketHook.activeGameSocket) return;
        if (webSocketHook.wasClosedByToolasha?.(socket)) return;
        clearTimeout(this.graceTimer);
        this.graceTimer = setTimeout(() => {
            this.graceTimer = null;
            if (webSocketHook.activeGameSocket) return;
            this.socketGone = true;
            this._apply();
        }, GRACE_MS);
    }

    _apply() {
        if (!this.initialized || !document.body) return;
        const hidden = this.socketGone || isDisconnectedTitle(document.title);
        document.body.classList.toggle(BODY_CLASS, hidden);
    }
}

const disconnectPanelGuard = new DisconnectPanelGuard();

export default disconnectPanelGuard;
