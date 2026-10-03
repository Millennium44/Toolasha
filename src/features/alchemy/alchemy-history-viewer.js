/**
 * Alchemy History window
 * One tab in the alchemy panel tab bar and one modal with a switcher between
 * the transmute, coinify and decompose histories.
 *
 * Each type's body is still drawn by its own viewer
 * (`transmute-history-viewer.js`, `coinify-history-viewer.js`,
 * `decompose-history-viewer.js`): a viewer registers here when its history
 * setting is on and mounts its pane into this window. This module owns only the
 * shared chrome — the tab, the overlay, the title, the close button and the
 * switcher — so a type whose setting is off is simply absent from it.
 */

import storage from '../../core/storage.js';
import { createMutationWatcher } from '../../utils/dom-observer-helpers.js';
import { markToolashaSurface } from '../../utils/surface-marker.js';

/** Switcher order, and the order panes sit in the window. */
export const ALCHEMY_HISTORY_TYPES = ['transmute', 'coinify', 'decompose'];

/**
 * Label of each type: its switcher button, the window title, and the text of
 * the game's own alchemy tab that identifies the alchemy tablist.
 */
const TYPE_LABELS = {
    transmute: 'Transmute',
    coinify: 'Coinify',
    decompose: 'Decompose',
};

/** Account-wide `settings` key holding the type last picked in the switcher. */
export const LAST_TYPE_STORAGE_KEY = 'alchemyHistory_lastType';

const TAB_LABEL = 'Alchemy History';

/**
 * Check whether any mutation added nodes that are, contain, or sit under a tablist.
 * Keeps the body-wide watcher from re-scanning every tablist on unrelated DOM churn.
 * @param {MutationRecord[]} mutations
 * @returns {boolean}
 */
function mutationsTouchTablist(mutations) {
    for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            if (node.closest?.('[role="tablist"]') || node.querySelector?.('[role="tablist"]')) {
                return true;
            }
        }
    }
    return false;
}

class AlchemyHistoryViewer {
    constructor() {
        /** @type {Map<string, Object>} registered type → its viewer */
        this.viewers = new Map();
        this.activeType = null;
        this.modal = null;
        this.alchemyTab = null;
        this.tabWatcher = null;
        // Bumped by every showType() and by teardown; a load that finishes under
        // a newer token was superseded and must not take over the window
        this.showToken = 0;
        /** @type {string|null} the type a switch is still loading */
        this.pendingType = null;
        /** @type {{el: HTMLElement, overflowX: string, flexWrap: string}|null} the tablist's own styles */
        this.tablistStyled = null;
    }

    /**
     * Types whose viewer is registered, in switcher order.
     * @returns {string[]}
     */
    get enabledTypes() {
        return ALCHEMY_HISTORY_TYPES.filter((type) => this.viewers.has(type));
    }

    /**
     * Add a type to the window; the first registration injects the tab.
     * @param {'transmute'|'coinify'|'decompose'} type
     * @param {Object} viewer - The type's viewer: openModal(), closeActiveFilterPopup() and `modal` (its pane)
     */
    register(type, viewer) {
        this.viewers.set(type, viewer);
        this.addAlchemyTab();
        if (this.modal) this.renderSwitcher();
    }

    /**
     * Remove a type from the window. With none left, the tab, its watcher and the
     * window go too — whether or not this type was ever registered, so a viewer
     * driven without registering still leaves nothing behind.
     * @param {'transmute'|'coinify'|'decompose'} type
     * @param {Object} [viewer] - When given, only unregisters if it is the registered viewer
     */
    unregister(type, viewer) {
        if (!viewer || this.viewers.get(type) === viewer) {
            this.viewers.delete(type);
        }
        if (this.viewers.size === 0) {
            this.teardown();
            return;
        }
        if (this.activeType === type) {
            this.activeType = null;
            if (this.isOpen()) {
                this.showType(this.enabledTypes[0]);
                return;
            }
        }
        if (this.modal) this.renderSwitcher();
    }

    /**
     * Remove the tab, the tablist watcher and the window.
     */
    teardown() {
        this.showToken++;
        if (this.tabWatcher) {
            this.tabWatcher();
            this.tabWatcher = null;
        }
        if (this.alchemyTab && this.alchemyTab.parentNode) {
            this.alchemyTab.remove();
        }
        this.alchemyTab = null;
        if (this.tablistStyled) {
            const { el, overflowX, flexWrap } = this.tablistStyled;
            el.style.overflowX = overflowX;
            el.style.flexWrap = flexWrap;
            this.tablistStyled = null;
        }
        if (this.modal) {
            this.modal.remove();
            this.modal = null;
        }
        this.activeType = null;
        this.pendingType = null;
    }

    // ─── Tab Injection ───────────────────────────────────────────────────────

    /**
     * Inject the "Alchemy History" tab into the alchemy tab bar.
     * The alchemy tab bar contains Coinify, Decompose, Transmute, Unrefine, Current Action;
     * it is identified by a native tab named after a registered type, which is also cloned
     * for the tab's structure.
     */
    addAlchemyTab() {
        const ensureTabExists = () => {
            if (this.viewers.size === 0) return;
            const tablist = document.querySelector('[role="tablist"]');
            if (!tablist) return;

            // Already injected?
            if (tablist.querySelector('[data-mwi-alchemy-history-tab="true"]')) return;

            const labels = this.enabledTypes.map((type) => TYPE_LABELS[type]);
            const referenceTab = Array.from(tablist.children).find(
                (btn) => !btn.dataset.mwiAlchemyHistoryTab && labels.some((label) => btn.textContent.includes(label))
            );
            if (!referenceTab) return;

            const tab = referenceTab.cloneNode(true);
            tab.setAttribute('data-mwi-alchemy-history-tab', 'true');
            tab.classList.remove('Mui-selected');
            tab.setAttribute('aria-selected', 'false');
            tab.setAttribute('tabindex', '-1');

            // Set label
            const badge = tab.querySelector('.TabsComponent_badge__1Du26');
            if (badge) {
                // Replace first text node (the label) while keeping badge span
                const badgeSpan = badge.querySelector('.MuiBadge-badge');
                badge.textContent = '';
                badge.appendChild(document.createTextNode(TAB_LABEL));
                if (badgeSpan) badge.appendChild(badgeSpan);
            } else {
                tab.textContent = TAB_LABEL;
            }

            tab.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.openModal();
            });

            tablist.appendChild(tab);
            // The game's own tablist: what it had is kept so teardown can put it back
            if (this.tablistStyled?.el !== tablist) {
                this.tablistStyled = {
                    el: tablist,
                    overflowX: tablist.style.overflowX,
                    flexWrap: tablist.style.flexWrap,
                };
            }
            tablist.style.overflowX = 'auto';
            tablist.style.flexWrap = 'nowrap';
            this.alchemyTab = tab;
        };

        // Watch for DOM changes that recreate the tablist
        if (!this.tabWatcher) {
            this.tabWatcher = createMutationWatcher(
                document.body,
                (mutations) => {
                    if (!mutationsTouchTablist(mutations)) return;
                    // If our tab was removed from DOM, clear reference
                    if (this.alchemyTab && !document.body.contains(this.alchemyTab)) {
                        this.alchemyTab = null;
                    }
                    ensureTabExists();
                },
                { childList: true, subtree: true }
            );
        }

        ensureTabExists();
    }

    // ─── Window ──────────────────────────────────────────────────────────────

    /**
     * Whether the window is on screen.
     * @returns {boolean}
     */
    isOpen() {
        return Boolean(this.modal && this.modal.style.display !== 'none');
    }

    /**
     * Read the type last picked in the switcher.
     * @returns {Promise<string|null>}
     */
    async loadLastType() {
        try {
            return await storage.get(LAST_TYPE_STORAGE_KEY, 'settings', null);
        } catch (error) {
            console.error('[AlchemyHistoryViewer] Failed to read the last history type:', error);
            return null;
        }
    }

    /**
     * Remember the type picked in the switcher.
     * @param {string} type
     * @returns {Promise<void>}
     */
    async saveLastType(type) {
        try {
            await storage.set(LAST_TYPE_STORAGE_KEY, type, 'settings');
        } catch (error) {
            console.error('[AlchemyHistoryViewer] Failed to save the last history type:', error);
        }
    }

    /**
     * Open the window on the type showing last this page load, else the type last
     * picked in the switcher, else the first registered type.
     * @returns {Promise<void>}
     */
    async openModal() {
        let type = this.viewers.has(this.activeType) ? this.activeType : null;
        if (!type) {
            const remembered = await this.loadLastType();
            const enabled = this.enabledTypes;
            type = enabled.includes(remembered) ? remembered : enabled[0];
        }
        if (!type) return;

        const shown = await this.showType(type);
        if (!shown || !this.modal) return;
        this.modal.style.display = 'flex';
    }

    /**
     * Load and draw one type, then make it the visible pane. The window's chrome
     * changes only once the type has drawn, so a slow load leaves the previous
     * type on screen rather than a blank window.
     * @param {string} type
     * @returns {Promise<boolean>} Whether this type now owns the window
     */
    async showType(type) {
        const viewer = this.viewers.get(type);
        if (!viewer) return false;
        const token = ++this.showToken;
        // The type a switch is loading, so a click back to the shown type is not taken as a no-op
        this.pendingType = type;

        await viewer.openModal();

        // Superseded by a later switch, or torn down while loading
        if (token !== this.showToken || this.viewers.get(type) !== viewer || !viewer.modal) return false;
        this.pendingType = null;

        const previous = this.activeType;
        if (previous && previous !== type) {
            this.viewers.get(previous)?.closeActiveFilterPopup();
        }
        this.activeType = type;
        this.ensureModal();
        this.renderTitle();
        this.renderSwitcher();
        this.syncPaneVisibility();
        return true;
    }

    /**
     * Hide the window. Filter popups live on the page body, so each is closed here.
     */
    closeModal() {
        if (this.modal) {
            this.modal.style.display = 'none';
        }
        for (const viewer of this.viewers.values()) {
            viewer.closeActiveFilterPopup();
        }
    }

    /**
     * Put one type's pane into the window, creating the window if needed. The pane
     * starts hidden unless its type is the one showing.
     * @param {string} type
     * @param {HTMLElement} pane
     */
    mountPane(type, pane) {
        this.ensureModal();
        pane.dataset.mwiAlchemyHistoryType = type;
        pane.style.display = type === this.activeType ? '' : 'none';

        const host = this.modal.querySelector('.mwi-alchemy-history-panes');
        const order = ALCHEMY_HISTORY_TYPES.indexOf(type);
        const next = Array.from(host.children).find(
            (child) => ALCHEMY_HISTORY_TYPES.indexOf(child.dataset.mwiAlchemyHistoryType) > order
        );
        host.insertBefore(pane, next || null);
    }

    /**
     * Show the active type's pane and hide the rest.
     */
    syncPaneVisibility() {
        if (!this.modal) return;
        const host = this.modal.querySelector('.mwi-alchemy-history-panes');
        for (const pane of host.children) {
            pane.style.display = pane.dataset.mwiAlchemyHistoryType === this.activeType ? '' : 'none';
        }
    }

    /**
     * Create the window's DOM: overlay, content box, header and switcher, plus the
     * host the type panes mount into. Starts hidden.
     */
    ensureModal() {
        if (this.modal) return;

        this.modal = document.createElement('div');
        this.modal.className = 'mwi-alchemy-history-modal';
        this.modal.style.cssText = `
            position: fixed;
            top: 0; left: 0;
            width: 100%; height: 100%;
            background: rgba(0,0,0,0.8);
            display: none;
            justify-content: center;
            align-items: center;
            z-index: 10000;
        `;

        const content = document.createElement('div');
        content.className = 'mwi-alchemy-history-content';
        // Width bounds leave room for the 20px padding and an 8px gutter a side. A bare
        // min-width: 500px beat max-width: 95vw on a phone, and the overlay's
        // align-items: center hung the dialog off both edges (left edge -75px at 390px
        // wide), where nothing can scroll to the clipped part. Desktop still gets 500px.
        content.style.cssText = `
            background: #2a2a2a;
            border-radius: 8px;
            padding: 20px;
            width: fit-content;
            min-width: min(500px, calc(100% - 56px));
            max-width: min(95vw, calc(100% - 56px));
            max-height: 90%;
            overflow: auto;
            box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        `;

        // Header
        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
        `;

        const title = document.createElement('h2');
        title.className = 'mwi-alchemy-history-title';
        title.style.cssText = 'margin: 0; color: #fff;';

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        closeBtn.style.cssText = `
            background: none; border: none; color: #fff;
            font-size: 24px; cursor: pointer; padding: 0;
            width: 30px; height: 30px;
        `;
        closeBtn.addEventListener('click', () => this.closeModal());

        header.appendChild(title);
        header.appendChild(closeBtn);

        // Type switcher — hidden while only one type is registered
        const switcher = document.createElement('div');
        switcher.className = 'mwi-alchemy-history-switcher';
        switcher.style.cssText = 'display: flex; gap: 6px; margin-bottom: 14px;';

        const panes = document.createElement('div');
        panes.className = 'mwi-alchemy-history-panes';

        content.appendChild(header);
        content.appendChild(switcher);
        content.appendChild(panes);
        this.modal.appendChild(content);
        markToolashaSurface(this.modal, 'modal');
        document.body.appendChild(this.modal);

        // Close on backdrop click
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) this.closeModal();
        });
    }

    /**
     * Title the window after the type showing.
     */
    renderTitle() {
        const title = this.modal?.querySelector('.mwi-alchemy-history-title');
        if (!title) return;
        title.textContent = `${TYPE_LABELS[this.activeType] || 'Alchemy'} History`;
    }

    /**
     * Draw one button per registered type; hidden while only one is registered.
     */
    renderSwitcher() {
        const switcher = this.modal?.querySelector('.mwi-alchemy-history-switcher');
        if (!switcher) return;
        while (switcher.firstChild) switcher.removeChild(switcher.firstChild);

        const enabled = this.enabledTypes;
        if (enabled.length <= 1) {
            switcher.style.display = 'none';
            return;
        }
        switcher.style.display = 'flex';

        for (const type of enabled) {
            const btn = document.createElement('button');
            btn.textContent = TYPE_LABELS[type];
            btn.dataset.mwiAlchemyHistorySwitch = type;
            const active = type === this.activeType;
            btn.setAttribute('aria-pressed', active ? 'true' : 'false');
            btn.style.cssText = active
                ? 'padding: 6px 14px; background: #4a90e2; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;'
                : 'padding: 6px 14px; background: #3a3a3a; color: #ccc; border: none; border-radius: 4px; cursor: pointer;';
            btn.addEventListener('click', async () => {
                // Clicking the shown type is a no-op, unless another type is still loading: then it is
                // the way back, and must supersede that load
                if (type === this.activeType && !this.pendingType) return;
                // Remembered only once the switch has taken: a superseded or failed one is not the pick
                if (await this.showType(type)) this.saveLastType(type);
            });
            switcher.appendChild(btn);
        }
    }
}

const alchemyHistoryViewer = new AlchemyHistoryViewer();

export { alchemyHistoryViewer, AlchemyHistoryViewer };

export default alchemyHistoryViewer;
