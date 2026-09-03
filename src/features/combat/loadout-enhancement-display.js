/**
 * Loadout Enhancement Display
 * Shows highest-owned enhancement level on equipment icons in the loadout panel
 *
 * Scrapes characterItems for the highest enhancementLevel per itemHrid,
 * then injects a "+N" overlay (upper-right) on each loadout equipment icon.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';

const OVERLAY_CLASS = 'script_loadoutEnhLevel';

/**
 * Build a map of itemHrid → highest enhancementLevel across all character items.
 * @returns {Map<string, number>}
 */
function buildEnhancementLevelMap() {
    const inventory = dataManager.getInventory();
    const map = new Map();
    if (!inventory) return map;

    for (const item of inventory) {
        if (!item.itemHrid || item.count === 0) continue;
        const existing = map.get(item.itemHrid) ?? 0;
        const level = item.enhancementLevel ?? 0;
        if (level > existing) {
            map.set(item.itemHrid, level);
        }
    }
    return map;
}

/**
 * Inject enhancement level overlays on all equipment icons in the loadout panel.
 */
function annotateLoadout() {
    if (!config.getSetting('loadoutEnhancementDisplay')) return;

    const selectedLoadout = document.querySelector('[class*="LoadoutsPanel_selectedLoadout"]');
    if (!selectedLoadout) return;

    const equipDiv = selectedLoadout.querySelector('[class*="LoadoutsPanel_equipment"]');
    if (!equipDiv) return;

    // Guard: inventory not ready — don't disturb existing overlays
    if (!dataManager.getInventory()) return;

    // Guard: use elements exist but none have item hrefs yet — React is mid-render
    const allUses = equipDiv.querySelectorAll('use');
    const validUses = Array.from(allUses).filter((use) => {
        const href = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
        return href.includes('items_sprite');
    });
    if (allUses.length > 0 && validUses.length === 0) return;

    // DOM and data are ready — clear stale overlays and re-inject
    for (const el of equipDiv.querySelectorAll(`.${OVERLAY_CLASS}`)) {
        el.remove();
    }

    const enhancementMap = buildEnhancementLevelMap();

    for (const use of validUses) {
        const href = use.getAttribute('href') || use.getAttribute('xlink:href') || '';
        const fragment = href.split('#')[1];
        if (!fragment) continue;
        const itemHrid = `/items/${fragment}`;

        const enhLevel = enhancementMap.get(itemHrid) ?? 0;
        if (enhLevel === 0) continue;

        // DOM: use → svg → Item_iconContainer → Item_item__
        const svg = use.closest('svg');
        if (!svg) continue;
        const itemDiv = svg.parentElement?.parentElement;
        if (!itemDiv) continue;

        // Skip if already annotated
        if (itemDiv.querySelector(`.${OVERLAY_CLASS}`)) continue;

        itemDiv.style.position = 'relative';
        const overlay = document.createElement('div');
        overlay.className = OVERLAY_CLASS;
        overlay.textContent = `+${enhLevel}`;
        overlay.style.cssText = `
            z-index: 1;
            position: absolute;
            top: 2px;
            right: 2px;
            text-align: right;
            color: ${config.COLOR_ACCENT};
            font-size: 10px;
            font-weight: bold;
            text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 3px #000;
            pointer-events: none;
        `;
        itemDiv.appendChild(overlay);
    }
}

/**
 * Remove all loadout enhancement overlays from the page.
 */
function removeOverlays() {
    for (const el of document.querySelectorAll(`.${OVERLAY_CLASS}`)) {
        el.remove();
    }
}

/**
 * The DOM this feature annotates, as classes the shared observer can filter on.
 *
 * `annotateLoadout` reads nothing outside
 * `LoadoutsPanel_selectedLoadout … LoadoutsPanel_equipment`, so the
 * `LoadoutsPanel_` prefix covers the panel opening, a different loadout being
 * selected and the equipment block being rebuilt. `Item_item` is there for the
 * narrower case of one slot's icon being remounted inside an otherwise
 * untouched equipment block — the callback bails after a single
 * `querySelector` when no loadout is open, so the extra firings are cheap and
 * the alternative is a badge that silently stops updating.
 *
 * Registered without a filter this ran for every element inserted anywhere.
 */
export const LOADOUT_WATCH_CLASSES = ['LoadoutsPanel_', 'Item_item'];

let unregisterHandler = null;
let unregisterReady = null;
let itemsUpdatedHandler = null;
let characterInitializedHandler = null;
let refreshTimer = null;
/** The unregister function `onSettingChange` handed back, undone in `cleanup()`. */
let unregisterSettingChange = null;

/**
 * Debounced re-annotate, for events that can arrive in a burst (a stack of
 * inventory deltas on one websocket frame, or a character switch that touches
 * several stores at once).
 */
function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
        refreshTimer = null;
        annotateLoadout();
    }, 250);
}

function initialize() {
    if (!config.getSetting('loadoutEnhancementDisplay')) return;

    unregisterHandler = domObserver.onClass(
        'LoadoutEnhancementDisplay',
        LOADOUT_WATCH_CLASSES,
        () => {
            annotateLoadout();
        },
        { debounce: true, debounceDelay: 200 }
    );

    // The badge is "highest enhancement level owned", read fresh from
    // characterItems each time it draws — but nothing re-triggers that draw
    // when the underlying inventory changes without also touching the DOM
    // (enhancing an item further, a trade landing, gear arriving from a
    // dungeon) or when the active character changes (1 main + 3 ironcow
    // sharing a browser). The generic domObserver above only fires on
    // childList mutations, which a same-loadout inventory change does not
    // necessarily produce, so the badge was left showing the previous
    // character's — or the previous inventory's — highest level.
    //
    // `character_initialized` rather than `character_switched` for the switch
    // half, because a listener registered here can only ever be delivered one
    // of those two. Both are deferred a tick (data-manager.js `emit`), and
    // delivery skips any listener that has since unregistered — while an
    // ordinary switch runs this module's `cleanup()`, which unregisters it, in
    // the `character_switching` teardown that happens first. So a
    // `character_switched` subscription made here can never fire: on an
    // ordinary switch it is gone before delivery (and the re-init's own
    // `annotateLoadout()` covers that case anyway), and on a *rapid* switch —
    // two inits inside RAPID_SWITCH_WINDOW_MS, which skips both the teardown
    // and `character_switched` — it is never emitted at all. The rapid switch
    // is exactly the case with no re-init to fall back on, and
    // `character_initialized` is emitted unconditionally on both paths, after
    // `characterItems` has been replaced.
    itemsUpdatedHandler = () => scheduleRefresh();
    characterInitializedHandler = () => scheduleRefresh();
    dataManager.on('items_updated', itemsUpdatedHandler);
    dataManager.on('character_initialized', characterInitializedHandler);

    // Run for any already-open loadout. @run-at document-start: the shared observer may not be
    // attached yet, so the catch-up waits for its actual-ready signal (immediate if attached).
    unregisterReady = domObserver.onReady('LoadoutEnhancementDisplayCatchUp', () => {
        annotateLoadout();
    });

    unregisterSettingChange = config.onSettingChange('loadoutEnhancementDisplay', (enabled) => {
        if (enabled) {
            annotateLoadout();
        } else {
            removeOverlays();
        }
    });
}

function cleanup() {
    if (unregisterSettingChange) {
        unregisterSettingChange();
        unregisterSettingChange = null;
    }
    if (unregisterHandler) {
        unregisterHandler();
        unregisterHandler = null;
    }
    if (unregisterReady) {
        unregisterReady();
        unregisterReady = null;
    }
    if (itemsUpdatedHandler) {
        dataManager.off('items_updated', itemsUpdatedHandler);
        itemsUpdatedHandler = null;
    }
    if (characterInitializedHandler) {
        dataManager.off('character_initialized', characterInitializedHandler);
        characterInitializedHandler = null;
    }
    if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
    }
    removeOverlays();
}

export default {
    name: 'Loadout Enhancement Display',
    initialize,
    cleanup,
};
