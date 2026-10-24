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
 * always on screen. On a phone the game shows one panel at a time, so the column
 * and its tab strip are simply not in the document while you are looking at the
 * marketplace, the map, or a fight: the switch had nowhere to be.
 *
 * So in mobile mode the switch is an entry in the game's left navigation
 * sidebar instead - the one piece of furniture present on every screen. It is
 * built the way the "Pinned" entry is (an independent row, label hidden when the
 * game collapses the sidebar) and sits under it. It has no geometry of its own to
 * save or move. Desktop is untouched: no mobile mode, no sidebar entry.
 *
 * ## Hiding it
 *
 * Some players do not want an extra sidebar entry. The settings panel offers a
 * "Show the overlay button" control backed by `isLauncherHidden` /
 * `setLauncherHidden` below. The flag is stored device-local
 * (`toolasha_local_` prefix, see `DEVICE_LOCAL_KEY_PREFIXES` in
 * `core/settings-storage.js`) rather than as a synced setting: hiding the entry
 * is a statement about *this* screen, and a phone and a desktop fighting over
 * one synced flag would take it off a desktop that never had the problem.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import storage from '../../core/storage.js';
import overlayPanel, { VISIBILITY_EVENT } from './overlay-panel.js';
import { addStyles, removeStyles } from '../../utils/dom.js';
import { isMobileMode } from '../../utils/mobile.js';

const BUTTON_ID = 'toolasha-overlay-tab';
const NAV_ITEM_ID = 'toolasha-overlay-nav';
const NAV_STYLE_ID = 'toolasha-overlay-nav-layout';
// Same collapsed-sidebar rule as the Pinned entry: the game hides its own labels
// inside NavigationBar_collapsed, ours is an independent row and follows suit.
// The game's own collapse rules sit inside this query: above it the collapsed class keeps its labels
// (a phone turned to landscape), so ours must too
const NAV_CSS = `
@media only screen and (max-width: 48rem) {
    [class*="NavigationBar_collapsed"] #${NAV_ITEM_ID} > .toolasha-overlay-nav-label { display: none; }
    [class*="NavigationBar_collapsed"] #${NAV_ITEM_ID} { justify-content: center; gap: 0 !important; }
}
`;
/**
 * Whether the sidebar entry has been hidden. Device-local - see the "Hiding it"
 * note above for why this must not be a synced setting.
 */
const LAUNCHER_HIDDEN_KEY = 'toolasha_local_overlayLauncherHidden';

/** The tab this one wants to sit in front of */
const SITS_BEFORE = 'Optimizer';

class OverlayTabButton {
    constructor() {
        this.button = null;
        /** The sidebar entry on a phone, which no game screen can take away */
        this.navItem = null;
        /**
         * Best-known answer to "is the launcher hidden", kept in memory so
         * `ensureNavItem` can check it synchronously. Starts `false` (shown)
         * and is corrected once `loadLauncherHidden` reads the stored flag —
         * see `initialize` for why that read cannot gate the first paint.
         */
        this.launcherHidden = false;
        /**
         * Bumped every time something newer than the initial load speaks for
         * `launcherHidden` (a settings-panel toggle, most likely), so that
         * load's own answer is ignored if it resolves afterward. Without this
         * a toggle flipped in the instant right after start-up could be undone
         * a moment later by the read it raced.
         */
        this._launcherHiddenLoadToken = 0;
        this.unregister = null;
        this.unregisterReady = null;
        this.initialized = false;
        // The panel can also be closed by its own ✕, and the switch has to
        // follow that rather than only what was last clicked here
        this.onVisibility = () => this.sync();
    }

    initialize() {
        if (this.initialized) return;
        // Its own switch first — the module used to read only the overlay's,
        // so `overlayTabButton` was decorative — and then the dependency: the
        // button is a switch for the overlay, and there is nothing to switch
        // when the overlay itself is off.
        if (!config.getSetting('overlayTabButton')) return;
        if (!config.getSetting('overlayPanel')) return;
        this.initialized = true;

        // Fire-and-forget: whether the entry was left hidden is read from a
        // device-local key, and the read is unavoidably async. `launcherHidden`
        // starts `false`, so on a hidden entry this creates it and then, the moment
        // the read comes back, takes it back down via `ensureNavItem`.
        const loadToken = ++this._launcherHiddenLoadToken;
        this.loadLauncherHidden().then((hidden) => {
            if (!this.initialized || this._launcherHiddenLoadToken !== loadToken) return;
            this.launcherHidden = hidden;
            this.ensureNavItem();
        });

        // The strip is rebuilt whenever the column changes what it shows, so
        // this watches rather than injecting once
        this.unregister = domObserver.onClass(
            'OverlayTabButton',
            ['MuiTabs-flexContainer', 'NavigationBar_nav'],
            () => {
                this.ensureButton();
                // Cheap, and puts the sidebar entry back when the game re-renders its nav
                this.ensureNavItem();
            }
        );
        document.addEventListener(VISIBILITY_EVENT, this.onVisibility);
        // @run-at document-start: a tab strip rendered before the shared observer attaches to
        // document.body is invisible to the class watcher, so the catch-up waits for the
        // observer's actual-ready signal (immediate if it is already attached).
        this.unregisterReady = domObserver.onReady('OverlayTabButtonCatchUp', () => {
            this.ensureButton();
            this.ensureNavItem();
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
        this.removeNavItem();
        // Reset to the default rather than left stale: the next `initialize()`
        // re-reads the real answer from storage (device-local, so it survives a
        // character switch just fine) — there is no reason for the gap before
        // that read lands to carry forward whatever this character's session
        // happened to leave behind instead of the ordinary default
        this.launcherHidden = false;
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

    /** Take the sidebar entry and its styles away */
    removeNavItem() {
        this.navItem?.remove();
        this.navItem = null;
        removeStyles(NAV_STYLE_ID);
    }

    /**
     * The sidebar entry, on a phone, and nothing at all otherwise.
     *
     * Lives in the game's left navigation, which is on every screen. Idempotent,
     * so the observer that puts the tab switch back can call it too.
     */
    ensureNavItem() {
        if (!isMobileMode() || this.launcherHidden) {
            this.removeNavItem();
            return;
        }
        if (this.navItem?.isConnected) {
            this.sync();
            return;
        }
        const navLinks = document.querySelector('[class*="NavigationBar_navigationLinks"]');
        if (!navLinks) return;
        this.navItem?.remove();

        addStyles(NAV_CSS, NAV_STYLE_ID);

        const item = document.createElement('div');
        item.id = NAV_ITEM_ID;
        item.setAttribute('role', 'button');
        item.title = 'Show or hide the Toolasha overlay.';
        item.setAttribute('aria-label', 'Toolasha overlay');
        item.style.cssText = `
            padding: 4px 8px;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 0.85em;
            color: ${config.COLOR_ACCENT};
            border-left: 3px solid transparent;
            transition: background 0.15s, border-color 0.15s;
            user-select: none;
            margin-bottom: 2px;
        `;
        item.innerHTML =
            '<span aria-hidden="true" style="font-size: 1.1em;">⧉</span>' +
            '<span class="toolasha-overlay-nav-label">Overlay</span>';
        item.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            overlayPanel.toggle();
            this.sync();
        });

        // Under the Pinned entry when that one is already there
        const pinned = navLinks.querySelector('.mwi-pinned-nav');
        if (pinned?.parentElement === navLinks) pinned.after(item);
        else navLinks.insertBefore(item, navLinks.firstChild);
        this.navItem = item;
        this.sync();
    }

    /**
     * Read the stored hidden flag.
     *
     * Device-local, per {@link LAUNCHER_HIDDEN_KEY} — never a synced setting.
     * @returns {Promise<boolean>}
     */
    async loadLauncherHidden() {
        try {
            return Boolean(await storage.get(LAUNCHER_HIDDEN_KEY, 'settings', false));
        } catch (error) {
            console.error('[OverlayTabButton] Reading whether the launcher was hidden failed:', error);
            return false;
        }
    }

    /**
     * Whether the launcher is currently hidden, best known.
     *
     * Answers from the in-memory cache this module already keeps rather than a
     * fresh storage read, so a settings-panel control checking this to draw its
     * toggle stays cheap and synchronous. See `launcherHidden`'s own comment for
     * why the true answer can lag a page load by one storage round trip.
     *
     * @returns {boolean}
     */
    isLauncherHidden() {
        return this.launcherHidden;
    }

    /**
     * Set whether the launcher is hidden, and make it so immediately.
     *
     * This is the whole of what a settings-panel "Show the overlay button"
     * control needs: it flips the flag this method writes, and calling it with
     * `false` both persists that and creates the launcher again on the spot —
     * no page reload, because `ensureLauncher` runs synchronously before the
     * write is even awaited.
     *
     * @param {boolean} hidden
     * @returns {Promise<void>}
     */
    async setLauncherHidden(hidden) {
        // Supersedes the initial load kicked off by `initialize`: without this,
        // a toggle flipped in the instant right after start-up could be undone
        // a moment later by the read it raced against.
        this._launcherHiddenLoadToken += 1;
        this.launcherHidden = Boolean(hidden);
        // Applied before the write settles — the player must see the launcher
        // go (or come back) at once, not three seconds later when the debounced
        // save happens to land.
        this.ensureNavItem();
        try {
            await storage.set(LAUNCHER_HIDDEN_KEY, this.launcherHidden, 'settings');
        } catch (error) {
            console.error('[OverlayTabButton] Saving whether the launcher is hidden failed:', error);
        }
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

    /** Show the overlay's state on each switch: dimmed tab, highlighted sidebar entry */
    sync() {
        const shown = Boolean(overlayPanel.panel);
        if (this.button) this.button.style.opacity = shown ? '1' : '0.6';
        if (this.navItem) {
            this.navItem.style.borderLeftColor = shown ? config.COLOR_ACCENT : 'transparent';
            this.navItem.style.background = shown ? 'rgba(255, 255, 255, 0.08)' : '';
            this.navItem.setAttribute('aria-pressed', shown ? 'true' : 'false');
        }
    }
}

const overlayTabButton = new OverlayTabButton();

export default overlayTabButton;
