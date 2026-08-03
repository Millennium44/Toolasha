/**
 * Overlay tab button
 *
 * A switch for the overlay, in the strip where the other panels live.
 *
 * The overlay is opened from the settings dialog, which is the wrong place for
 * something toggled several times an hour: it is a readout you want up while
 * fighting and out of the way while reading a recipe, and a two-click trip
 * through a dialog is enough friction that people leave it up and work around
 * it instead.
 *
 * So it gets a switch beside Equipment, Abilities and the rest — the strip you
 * are already using to change what that column shows. It is drawn as Room Logs
 * and Bulk Sell are: a clone of a real tab so it inherits whatever the game
 * currently thinks a tab looks like, with a glyph saying it opens a panel and
 * dimming saying whether that panel is up. A button that lights a panel when
 * clicked and then does nothing visible when clicked again reads as broken.
 *
 * It sits before Optimizer, which is also injected — and injected later than
 * this on a slow load, so its position is re-checked rather than set once.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import overlayPanel, { VISIBILITY_EVENT } from './overlay-panel.js';

const BUTTON_ID = 'toolasha-overlay-tab';

/** The tab this one wants to sit in front of */
const SITS_BEFORE = 'Optimizer';

class OverlayTabButton {
    constructor() {
        this.button = null;
        this.unregister = null;
        this.initialized = false;
        // The panel can also be closed by its own ✕, and the switch has to
        // follow that rather than only what was last clicked here
        this.onVisibility = () => this.sync();
    }

    initialize() {
        if (this.initialized) return;
        if (!config.getSetting('overlayPanel')) return;
        this.initialized = true;

        // The strip is rebuilt whenever the column changes what it shows, so
        // this watches rather than injecting once
        this.unregister = domObserver.onClass('OverlayTabButton', 'MuiTabs-flexContainer', () => this.ensureButton());
        document.addEventListener(VISIBILITY_EVENT, this.onVisibility);
        this.ensureButton();
    }

    cleanup() {
        this.unregister?.();
        this.unregister = null;
        document.removeEventListener(VISIBILITY_EVENT, this.onVisibility);
        this.button?.remove();
        this.button = null;
        this.initialized = false;
    }

    disable() {
        this.cleanup();
    }

    /**
     * The character panel's tab strip — the one with Inventory in it.
     *
     * Found by its contents rather than by a class, because every tab strip in
     * the game shares the same classes and only this one holds an Inventory tab.
     *
     * @returns {HTMLElement|null}
     */
    findTabList() {
        for (const list of document.querySelectorAll('[role="tablist"]')) {
            for (const tab of list.querySelectorAll('[role="tab"]')) {
                if (tab.textContent.trim() === 'Inventory') return list;
            }
        }
        return null;
    }

    /** Put the button in the strip, or put it back if the strip was rebuilt */
    ensureButton() {
        const list = this.findTabList();
        if (!list) return;

        if (this.button && list.contains(this.button)) {
            this.keepBeforeOptimizer(list);
            this.sync();
            return;
        }
        this.button?.remove();

        const native = this.findModelTab(list);
        if (!native) return;

        const button = native.cloneNode(true);
        button.id = BUTTON_ID;
        button.title =
            'Overlay — the tiles that sit over the game.\n\nClick to show or hide it.\n' +
            'Its ⚙ chooses which tiles are on and arranges them; its ⇲ docks it below these tabs.';

        const badge = button.querySelector('[class*="TabsComponent_badge"]');
        if (badge) badge.innerHTML = '<div style="text-align: center;"><div>⧉ Overlay</div></div>';
        else button.textContent = '⧉ Overlay';

        // Not a tab: it opens something rather than changing what this column
        // shows, so it must not claim the selection the real tabs share
        button.classList.remove('Mui-selected');
        button.setAttribute('aria-selected', 'false');
        button.setAttribute('tabindex', '-1');
        this.stripInheritedState(button);

        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            overlayPanel.toggle();
            this.sync();
        });

        list.appendChild(button);
        this.button = button;
        this.keepBeforeOptimizer(list);
        this.sync();
    }

    /**
     * The tab to copy the game's current look from.
     *
     * Cloned from a real tab rather than styled to match one, so it stays right
     * through a game build that changes what a tab looks like. Which tab is not
     * arbitrary:
     *
     * - **Not one of ours.** The Toolasha and Optimizer tabs are injected, and
     *   cloning one would copy whatever it did to itself.
     * - **Not a hidden one.** With "show Toolasha tab by default" on, the game's
     *   Inventory tab is set to `display: none` — and it is the first tab in the
     *   strip, so it is exactly the one a naive search picks. The clone carries
     *   that inline style with it, and the result is a button that is added,
     *   positioned, kept in place, and invisible.
     *
     * @param {HTMLElement} list - The tab strip
     * @returns {HTMLElement|null}
     */
    findModelTab(list) {
        return (
            [...list.querySelectorAll('[role="tab"]')].find(
                (tab) =>
                    tab !== this.button &&
                    tab.id !== BUTTON_ID &&
                    !tab.classList.contains('toolasha-inv-tab') &&
                    !tab.classList.contains('toolasha-skilling-opt-tab') &&
                    tab.style.display !== 'none'
            ) || null
        );
    }

    /**
     * Drop what belonged to the tab this was copied from.
     *
     * `cloneNode` brings the inline styles and attributes along, and three of
     * them are actively wrong on a copy: `display`, which may be hiding it;
     * `order`, which the tab-reorder feature writes and which would park this
     * button on top of whichever tab it was cloned from; and `draggable`, which
     * survives without the drag handlers that make it mean anything.
     *
     * @param {HTMLElement} button - The clone
     */
    stripInheritedState(button) {
        button.style.removeProperty('display');
        button.style.removeProperty('order');
        button.style.removeProperty('opacity');
        button.removeAttribute('draggable');
        // Would name the panel the tab it was cloned from switches to
        button.removeAttribute('aria-controls');
        button.style.minWidth = 'auto';
        button.style.cursor = 'pointer';
    }

    /**
     * Stay in front of Optimizer.
     *
     * Optimizer is injected too, and on a slow load it arrives after this one —
     * so where this sits is re-checked rather than decided once.
     *
     * @param {HTMLElement} list - The tab strip
     */
    keepBeforeOptimizer(list) {
        const optimizer = [...list.querySelectorAll('[role="tab"], button')].find(
            (tab) => tab !== this.button && tab.textContent.trim().includes(SITS_BEFORE)
        );
        if (optimizer && optimizer.previousElementSibling !== this.button) list.insertBefore(this.button, optimizer);
    }

    /** Dim it when the overlay is down, so the button says which state it is in */
    sync() {
        if (!this.button) return;
        this.button.style.opacity = overlayPanel.panel ? '1' : '0.6';
    }
}

const overlayTabButton = new OverlayTabButton();

export default overlayTabButton;
