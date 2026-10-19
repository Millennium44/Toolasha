/**
 * Tab Reorder
 * Allows users to drag-and-drop reorder the character panel tabs
 * (Inventory, Toolasha, Equipment, Houses, Abilities, Loadout).
 *
 * Uses CSS `order` on flex items — does not move DOM nodes, so React
 * re-renders and click→panel mapping are unaffected.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import { captureOwner, stillOurs, noteTeardown } from '../../utils/init-ownership.js';

const STORAGE_KEY_PREFIX = 'tabOrder';
const TOUCH_HOLD_MS = 350;
const TOUCH_SLOP_PX = 10;

/**
 * Get character-scoped storage key.
 * @returns {string}
 */
function getStorageKey() {
    const charId = dataManager.getCurrentCharacterId() || 'default';
    return `${STORAGE_KEY_PREFIX}_${charId}`;
}

/**
 * Find the character panel tab list by looking for the one containing "Inventory".
 * @returns {HTMLElement|null}
 */
function findCharacterTabList() {
    const allTabLists = document.querySelectorAll('[role="tablist"]');
    for (const tl of allTabLists) {
        for (const tab of tl.querySelectorAll('[role="tab"]')) {
            if (tab.textContent.trim() === 'Inventory') return tl;
        }
    }
    return null;
}

class TabReorder {
    constructor() {
        this.isInitialized = false;
        this.savedOrder = null;
        this.unregisterHandlers = [];
        this._dragLabel = null;
        this.touchTeardowns = [];
        this.touchOwner = null;
    }

    async initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('tabReorder')) return;

        this.isInitialized = true;

        // Load saved order.
        //
        // A character switch tearing the feature down while this read is in
        // flight used to leave the resumed tail pushing its two registrations
        // into the `unregisterHandlers` array `disable()` had already emptied
        // — a live class observer and a live ready-catch-up with no handle to
        // remove them by. Harmless in practice (the work they redo is
        // idempotent, gated on `tab.dataset.mwiTabReorder`), but the leaked
        // observer survives until the *next* switch's teardown clears the
        // array wholesale, so guard it anyway rather than leave a stray
        // registration sitting around for a character's whole session.
        const ticket = captureOwner(this);
        this.savedOrder = await storage.getJSON(getStorageKey(), 'settings', null);
        if (!stillOurs(ticket)) return;

        // Re-apply whenever React re-renders the tab container
        const unregister = domObserver.onClass('TabReorder', 'TabsComponent_tabsContainer', () => {
            // Small delay to let Toolasha tab injection happen first
            setTimeout(() => this._applyOrder(), 50);
        });
        this.unregisterHandlers.push(unregister);

        // Apply to existing tabs. @run-at document-start: tabs rendered before the shared
        // observer attaches to document.body are invisible to the class watcher, so the
        // catch-up waits for its actual-ready signal (immediate if it is already attached).
        this.unregisterHandlers.push(domObserver.onReady('TabReorderCatchUp', () => this._applyOrder()));
    }

    /**
     * Apply saved order and wire drag-and-drop on all character panel tabs.
     * @private
     */
    _applyOrder() {
        const tabList = findCharacterTabList();
        if (!tabList) return;

        const tabs = [...tabList.querySelectorAll('[role="tab"]')];
        if (tabs.length === 0) return;

        if (this.savedOrder) {
            for (const tab of tabs) {
                const label = tab.textContent.trim();
                const idx = this.savedOrder.indexOf(label);
                tab.style.order = idx >= 0 ? idx : this.savedOrder.length;
            }
        }

        // Wire drag-and-drop on tabs not yet wired
        for (const tab of tabs) {
            if (tab.dataset.mwiTabReorder) continue;
            tab.dataset.mwiTabReorder = '1';
            this._wireDragDrop(tab);
        }
    }

    /**
     * Wire native HTML5 drag-and-drop on a tab button.
     * @param {HTMLElement} tab
     * @private
     */
    _wireDragDrop(tab) {
        tab.setAttribute('draggable', 'true');
        tab.style.cursor = 'grab';

        tab.addEventListener('dragstart', (e) => {
            this._dragLabel = tab.textContent.trim();
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', this._dragLabel);
            tab.style.opacity = '0.4';
        });

        tab.addEventListener('dragend', () => {
            tab.style.opacity = '';
            this._dragLabel = null;
            // Clean all drop indicators
            const tabList = findCharacterTabList();
            if (tabList) {
                for (const t of tabList.querySelectorAll('[role="tab"]')) {
                    t.style.removeProperty('border-left');
                    t.style.removeProperty('border-right');
                }
            }
        });

        tab.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            this._showIndicator(tab, e.clientX);
        });

        tab.addEventListener('dragleave', () => {
            tab.style.removeProperty('border-left');
            tab.style.removeProperty('border-right');
        });

        tab.addEventListener('drop', (e) => {
            e.preventDefault();
            tab.style.removeProperty('border-left');
            tab.style.removeProperty('border-right');
            this._dropOn(tab, e.dataTransfer.getData('text/plain'), e.clientX);
        });

        this._wireTouchDrag(tab);
    }

    /**
     * Show the blue insertion line on the side of `tab` the pointer is nearest.
     * @param {HTMLElement} tab
     * @param {number} clientX
     * @private
     */
    _showIndicator(tab, clientX) {
        const rect = tab.getBoundingClientRect();
        const isLeft = clientX < rect.left + rect.width / 2;

        const tabList = tab.closest('[role="tablist"]');
        if (tabList) {
            for (const t of tabList.querySelectorAll('[role="tab"]')) {
                t.style.removeProperty('border-left');
                t.style.removeProperty('border-right');
            }
        }

        if (isLeft) {
            tab.style.borderLeft = '2px solid #4a9eff';
        } else {
            tab.style.borderRight = '2px solid #4a9eff';
        }
    }

    /**
     * Move `draggedLabel` before or after `tab` and persist the result.
     * @param {HTMLElement} tab - The tab it was dropped on
     * @param {string} draggedLabel
     * @param {number} clientX
     * @private
     */
    _dropOn(tab, draggedLabel, clientX) {
        const targetLabel = tab.textContent.trim();
        if (!draggedLabel || draggedLabel === targetLabel) return;

        // Determine drop position (before or after target)
        const rect = tab.getBoundingClientRect();
        const dropBefore = clientX < rect.left + rect.width / 2;

        // Build current visual order
        const tabList = tab.closest('[role="tablist"]');
        if (!tabList) return;

        const tabs = [...tabList.querySelectorAll('[role="tab"]')];
        const currentOrder = tabs
            .map((t) => ({ label: t.textContent.trim(), order: parseInt(t.style.order) || 0 }))
            .sort((a, b) => a.order - b.order)
            .map((t) => t.label);

        // Remove dragged from current position
        const newOrder = currentOrder.filter((l) => l !== draggedLabel);

        // Insert at new position
        const targetIdx = newOrder.indexOf(targetLabel);
        if (targetIdx < 0) return;

        if (dropBefore) {
            newOrder.splice(targetIdx, 0, draggedLabel);
        } else {
            newOrder.splice(targetIdx + 1, 0, draggedLabel);
        }

        // Save and apply
        this.savedOrder = newOrder;
        this._saveOrder(newOrder);
        this._applyOrder();
    }

    /**
     * Touch path: native drag-and-drop does not start from a finger in every
     * mobile browser (Firefox Android), so a press held for a moment on a tab
     * picks it up and a pointer stream carries it. A quick tap or a swipe is
     * left to the game. Mouse stays on the native path.
     * @param {HTMLElement} tab
     * @private
     */
    _wireTouchDrag(tab) {
        // React replaces tab nodes; release the ones that left the page
        this.touchTeardowns = this.touchTeardowns.filter((t) => {
            if (t.tab.isConnected) return true;
            t.run();
            return false;
        });
        let pointerId = null;
        let timer = null;
        let active = false;
        let startX = 0;
        let startY = 0;
        const listeners = [];

        const tabAt = (x, y) => {
            const hit = document.elementFromPoint?.(x, y)?.closest?.('[role="tab"]');
            return hit && hit.closest('[role="tablist"]') === tab.closest('[role="tablist"]') ? hit : null;
        };
        const clearIndicators = () => {
            const tabList = tab.closest('[role="tablist"]');
            for (const t of tabList?.querySelectorAll('[role="tab"]') || []) {
                t.style.removeProperty('border-left');
                t.style.removeProperty('border-right');
            }
        };
        const end = (commit, event) => {
            clearTimeout(timer);
            timer = null;
            if (pointerId === null) return;
            const wasActive = active;
            const label = this._dragLabel;
            try {
                tab.releasePointerCapture?.(pointerId);
            } catch {
                // Already released
            }
            pointerId = null;
            active = false;
            if (this.touchOwner === tab) this.touchOwner = null;
            tab.style.opacity = '';
            this._dragLabel = null;
            clearIndicators();
            if (wasActive && commit && event) {
                const target = tabAt(event.clientX, event.clientY);
                if (target) this._dropOn(target, label, event.clientX);
                // The click that follows a held press must not switch tabs
                const swallow = (e) => {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                };
                tab.addEventListener('click', swallow, { capture: true, once: true });
                setTimeout(() => tab.removeEventListener('click', swallow, { capture: true }), 400);
            }
        };

        const on = (type, handler, options) => {
            tab.addEventListener(type, handler, options);
            listeners.push([type, handler, options]);
        };

        on('pointerdown', (event) => {
            // One touch gesture for the whole tab list: the dragged label is shared
            if (event.pointerType === 'mouse' || pointerId !== null || this.touchOwner) return;
            this.touchOwner = tab;
            pointerId = event.pointerId;
            startX = event.clientX;
            startY = event.clientY;
            timer = setTimeout(() => {
                timer = null;
                active = true;
                this._dragLabel = tab.textContent.trim();
                tab.style.opacity = '0.4';
                try {
                    tab.setPointerCapture?.(pointerId);
                } catch {
                    // Pointer already gone
                }
            }, TOUCH_HOLD_MS);
        });
        on('pointermove', (event) => {
            if (event.pointerId !== pointerId) return;
            if (!active) {
                // Moving before the hold completes is a swipe, not a pick-up
                if (Math.hypot(event.clientX - startX, event.clientY - startY) > TOUCH_SLOP_PX) end(false);
                return;
            }
            const target = tabAt(event.clientX, event.clientY);
            if (target && target !== tab) this._showIndicator(target, event.clientX);
            else clearIndicators();
        });
        on('pointerup', (event) => {
            if (event.pointerId === pointerId) end(true, event);
        });
        on('pointercancel', (event) => {
            if (event.pointerId === pointerId) end(false);
        });
        // Stops the page scrolling under a held, moving finger; the long press
        // would otherwise also open the browser's context menu
        on(
            'touchmove',
            (event) => {
                if (active) event.preventDefault();
            },
            { passive: false }
        );
        on('contextmenu', (event) => {
            if (pointerId !== null) event.preventDefault();
        });

        this.touchTeardowns.push({
            tab,
            run: () => {
                end(false);
                for (const [type, handler, options] of listeners) tab.removeEventListener(type, handler, options);
            },
        });
    }

    /**
     * Persist the tab order to storage.
     * @param {Array<string>} order - Ordered array of tab labels
     * @private
     */
    async _saveOrder(order) {
        await storage.setJSON(getStorageKey(), order, 'settings', true);
    }

    disable() {
        noteTeardown(this);
        for (const unregister of this.unregisterHandlers) {
            unregister();
        }
        this.unregisterHandlers = [];
        for (const teardown of this.touchTeardowns) teardown.run();
        this.touchTeardowns = [];
        this.touchOwner = null;

        // Remove all CSS order and draggable attributes
        const tabList = findCharacterTabList();
        if (tabList) {
            for (const tab of tabList.querySelectorAll('[role="tab"]')) {
                tab.style.removeProperty('order');
                tab.removeAttribute('draggable');
                tab.style.removeProperty('cursor');
                tab.style.removeProperty('border-left');
                tab.style.removeProperty('border-right');
                delete tab.dataset.mwiTabReorder;
            }
        }

        this.isInitialized = false;
    }
}

const tabReorder = new TabReorder();

export default {
    name: 'Tab Reorder',
    initialize: async () => {
        await tabReorder.initialize();
    },
    cleanup: () => {
        tabReorder.disable();
    },
    disable: () => {
        try {
            tabReorder.disable();
        } catch (error) {
            console.error('[Tab Reorder] Disable failed part-way:', error);
        } finally {
            tabReorder.isInitialized = false;
        }
    },
};
