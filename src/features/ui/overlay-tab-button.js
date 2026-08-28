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
 *
 * ## Why there is a second one on a phone
 *
 * That strip is the character column's, and on a desktop the character column is
 * always on screen — whatever else you are doing, the tabs are there and so is
 * this switch. On a phone the game shows one panel at a time, so the column and
 * its tab strip are simply not in the document while you are looking at the
 * marketplace, the map, or a fight. The switch is injected into a strip that does
 * not exist, which is why the overlay could only be opened from the inventory
 * screen: not a bug in the button, but the button having nowhere to be.
 *
 * So in mobile mode there is also a launcher — a small round button fixed to the
 * window rather than to any of the game's own furniture, which is the only thing
 * that survives the game swapping its whole screen out. It can be dragged, and
 * where it is dragged to is remembered, because a fixed spot that happens to sit
 * on top of a control on one phone is a launcher that has to be worked around
 * forever. Desktop is untouched: no mobile mode, no launcher.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import overlayPanel, { VISIBILITY_EVENT } from './overlay-panel.js';
import { restoreGeometry, saveGeometry } from '../../utils/panel-geometry.js';
import { isMobileMode } from '../../utils/mobile.js';

const BUTTON_ID = 'toolasha-overlay-tab';
const LAUNCHER_ID = 'toolasha-overlay-launcher';
/** Where the launcher was dragged to, shared by every character */
const LAUNCHER_KEY = 'overlayLauncher';
const LAUNCHER_SIZE = 40;
/** Past this a press was a drag rather than a tap, and must not also toggle */
const DRAG_SLOP = 6;

/** The tab this one wants to sit in front of */
const SITS_BEFORE = 'Optimizer';

class OverlayTabButton {
    constructor() {
        this.button = null;
        /** The round button on a phone, which no game screen can take away */
        this.launcher = null;
        this.detachLauncher = null;
        this.unregister = null;
        this.unregisterReady = null;
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
        this.unregister = domObserver.onClass('OverlayTabButton', 'MuiTabs-flexContainer', () => {
            this.ensureButton();
            // Cheap, and the one thing that puts the launcher back if the game
            // ever replaces the body it is attached to
            this.ensureLauncher();
        });
        document.addEventListener(VISIBILITY_EVENT, this.onVisibility);
        // @run-at document-start: a tab strip rendered before the shared observer attaches to
        // document.body is invisible to the class watcher, so the catch-up waits for the
        // observer's actual-ready signal (immediate if it is already attached).
        this.unregisterReady = domObserver.onReady('OverlayTabButtonCatchUp', () => {
            this.ensureButton();
            this.ensureLauncher();
        });
    }

    cleanup() {
        this.unregister?.();
        this.unregister = null;
        this.unregisterReady?.();
        this.unregisterReady = null;
        document.removeEventListener(VISIBILITY_EVENT, this.onVisibility);
        this.button?.remove();
        this.button = null;
        this.detachLauncher?.();
        this.detachLauncher = null;
        this.launcher?.remove();
        this.launcher = null;
        this.initialized = false;
    }

    disable() {
        try {
            this.cleanup();
        } catch (error) {
            console.error('[Overlay Tab Button] Disable failed part-way:', error);
        } finally {
            this.initialized = false;
        }
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
     * The launcher, on a phone, and nothing at all otherwise.
     *
     * Attached to the body rather than to anything of the game's, because the
     * whole point of it is to outlive the screen you are on. Idempotent, so the
     * observer that puts the tab switch back can call it too.
     */
    ensureLauncher() {
        if (!isMobileMode()) {
            this.detachLauncher?.();
            this.detachLauncher = null;
            this.launcher?.remove();
            this.launcher = null;
            return;
        }
        if (this.launcher && document.body?.contains(this.launcher)) {
            this.sync();
            return;
        }
        if (!document.body) return;

        this.detachLauncher?.();
        this.launcher?.remove();

        const button = document.createElement('button');
        button.id = LAUNCHER_ID;
        button.type = 'button';
        button.textContent = '⧉';
        button.title = 'Show or hide the Toolasha overlay. Drag to move this button.';
        button.setAttribute('aria-label', 'Toolasha overlay');
        Object.assign(button.style, {
            position: 'fixed',
            // Above the game's own interface rather than under it, unlike the
            // overlay itself: a readout the game may cover is a fair trade, a
            // switch the game may cover is a switch that cannot be pressed
            zIndex: String(config.Z_FLOATING_PANEL),
            right: '8px',
            bottom: '96px',
            width: `${LAUNCHER_SIZE}px`,
            height: `${LAUNCHER_SIZE}px`,
            borderRadius: '50%',
            border: '1px solid rgba(120, 160, 255, 0.45)',
            background: 'rgba(8, 10, 20, 0.85)',
            color: '#e8ecf5',
            fontSize: '18px',
            lineHeight: '1',
            padding: '0',
            cursor: 'pointer',
            boxShadow: '0 2px 10px rgba(0, 0, 0, 0.5)',
            // A finger dragging this must not scroll the game behind it
            touchAction: 'none',
        });

        document.body.appendChild(button);
        this.launcher = button;
        this.detachLauncher = this.makeLauncherDraggable(button);
        this.sync();

        // Where it was left, if it was ever moved. Asynchronous, so it opens at
        // the default corner and settles a frame later rather than waiting on a
        // database before there is any way to open the overlay at all
        restoreGeometry(button, LAUNCHER_KEY, { width: LAUNCHER_SIZE, height: LAUNCHER_SIZE }).catch((error) => {
            console.error('[OverlayTabButton] Restoring the launcher position failed:', error);
        });
    }

    /**
     * Let the launcher be moved, and remember where to.
     *
     * A fixed corner is a guess about a screen this code has never seen, and on
     * the phone where the guess is wrong the launcher covers a control for good.
     * Dragging is the cheap way out of having to be right.
     *
     * The slop is what keeps it a button: a tap on a touchscreen always moves a
     * pixel or two, so a press that never travels past {@link DRAG_SLOP} is
     * still a tap and still toggles the overlay.
     *
     * @param {HTMLElement} button - The launcher
     * @returns {Function} Detach
     */
    makeLauncherDraggable(button) {
        let pointer = null;
        let startX = 0;
        let startY = 0;
        let originX = 0;
        let originY = 0;
        let moved = false;

        const onMove = (event) => {
            if (pointer === null || event.pointerId !== pointer) return;

            const dx = event.clientX - startX;
            const dy = event.clientY - startY;
            if (!moved && Math.abs(dx) < DRAG_SLOP && Math.abs(dy) < DRAG_SLOP) return;
            moved = true;

            const most = {
                x: Math.max(0, window.innerWidth - LAUNCHER_SIZE),
                y: Math.max(0, window.innerHeight - LAUNCHER_SIZE),
            };
            button.style.left = `${Math.min(Math.max(0, originX + dx), most.x)}px`;
            button.style.top = `${Math.min(Math.max(0, originY + dy), most.y)}px`;
            button.style.right = 'auto';
            button.style.bottom = 'auto';
        };

        const onUp = () => {
            if (pointer === null) return;
            pointer = null;
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            document.removeEventListener('pointercancel', onUp);
            if (!moved) return;

            saveGeometry(LAUNCHER_KEY, {
                left: Number.parseFloat(button.style.left),
                top: Number.parseFloat(button.style.top),
            });
        };

        const onDown = (event) => {
            if (event.button !== 0) return;
            pointer = event.pointerId;
            moved = false;
            startX = event.clientX;
            startY = event.clientY;
            const box = button.getBoundingClientRect();
            originX = box.left;
            originY = box.top;
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
            document.addEventListener('pointercancel', onUp);
        };

        const onClick = (event) => {
            event.preventDefault();
            event.stopPropagation();
            // The click that ends a drag is not a press of the button
            if (moved) {
                moved = false;
                return;
            }
            overlayPanel.toggle();
            this.sync();
        };

        button.addEventListener('pointerdown', onDown);
        button.addEventListener('click', onClick);

        return () => {
            button.removeEventListener('pointerdown', onDown);
            button.removeEventListener('click', onClick);
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            document.removeEventListener('pointercancel', onUp);
        };
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

    /** Dim them when the overlay is down, so each says which state it is in */
    sync() {
        const open = overlayPanel.panel ? '1' : '0.6';
        if (this.button) this.button.style.opacity = open;
        if (this.launcher) this.launcher.style.opacity = open;
    }
}

const overlayTabButton = new OverlayTabButton();

export default overlayTabButton;
