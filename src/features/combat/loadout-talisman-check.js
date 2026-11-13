/**
 * Loadout Talisman Check (test server only)
 *
 * Marks the selected loadout in the game's Loadouts panel when its talismans will not do what the player
 * expects (deleted, a slot the belt lacks, a combat/skilling mismatch, a duplicate Special line). See utils/loadout-talisman-check.js.
 * The marker sits at the end of the panel's metadata row with the reasons in its hover title. The loadout is
 * found by the name the panel shows, through class-name substrings, never by translated text.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import webSocketHook from '../../core/websocket.js';
import { webSocketHook as sharedWebSocketHook } from '../../utils/bundle-bridge.js';
import { isTestServer } from '../../utils/game-server.js';
import { checkLoadoutTalismans, commonWarnings } from '../../utils/loadout-talisman-check.js';

const SETTING = 'loadoutTalismanCheck';
export const MARKER_CLASS = 'toolasha-loadout-talisman-warning';
const SELECTED_SELECTOR = '[class*="LoadoutsPanel_selectedLoadout"]';
const METADATA_SELECTOR = '[class*="LoadoutsPanel_metadata"]';

let unregisterObserver = null;
let unregisterReady = null;
let unregisterSetting = null;
let refreshTimer = null;
let wsHook = null;
const dataHandlers = [];

/**
 * The loadout name the panel shows: the first text after the icon in the metadata row.
 * @param {Element} metadata
 * @returns {string|null}
 */
function loadoutName(metadata) {
    let seenSvg = false;
    for (const child of metadata.childNodes) {
        if (child.nodeType === 1 && child.tagName.toLowerCase() === 'svg') {
            seenSvg = true;
        } else if (seenSvg && child.nodeType === 3) {
            const text = child.textContent.trim();
            if (text) return text;
        }
    }
    return null;
}

function removeMarkers() {
    for (const el of document.querySelectorAll(`.${MARKER_CLASS}`)) el.remove();
}

/**
 * Draw (or clear) the marker for the selected loadout. Idempotent.
 */
export function annotate() {
    if (!isTestServer() || !config.getSetting(SETTING)) {
        removeMarkers();
        return;
    }
    const selected = document.querySelector(SELECTED_SELECTOR);
    const metadata = selected?.querySelector(METADATA_SELECTOR);
    if (!metadata) return;

    let warnings = [];
    const name = loadoutName(metadata);
    const map = dataManager.characterData?.characterLoadoutMap;
    if (name && map && typeof map === 'object') {
        const initData = dataManager.getInitClientData?.();
        const itemDetailMap = initData?.itemDetailMap;
        const modifierDetailMap = initData?.talismanModifierDetailMap;
        const owned = dataManager.hasTalismansLoaded?.() ? dataManager.getCharacterTalismans() : null;
        const lists = Object.values(map)
            .filter((loadout) => loadout && loadout.name === name)
            .map((loadout) =>
                checkLoadoutTalismans({ loadout, ownedTalismans: owned, itemDetailMap, modifierDetailMap })
            );
        warnings = commonWarnings(lists);
    }

    const existing = metadata.querySelector(`.${MARKER_CLASS}`);
    if (warnings.length === 0) {
        existing?.remove();
        return;
    }
    const title = warnings.map((w) => w.text).join('\n');
    if (existing && existing.title === title) return;
    existing?.remove();
    const marker = document.createElement('span');
    marker.className = MARKER_CLASS;
    marker.title = title;
    marker.textContent = '⚠';
    marker.style.cssText = 'margin-left:6px; color:#ffb020; cursor:help; font-weight:bold;';
    metadata.appendChild(marker);
}

function scheduleRefresh() {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
        refreshTimer = null;
        annotate();
    }, 250);
}

function cleanup() {
    unregisterObserver?.();
    unregisterReady?.();
    unregisterSetting?.();
    unregisterObserver = unregisterReady = unregisterSetting = null;
    for (const [event, handler] of dataHandlers) dataManager.off(event, handler);
    dataHandlers.length = 0;
    if (wsHook) {
        wsHook.off('loadouts_updated', scheduleRefresh);
        wsHook = null;
    }
    if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
    }
    removeMarkers();
}

function initialize() {
    cleanup();
    if (!isTestServer()) return;

    unregisterObserver = domObserver.onClass('LoadoutTalismanCheck', ['LoadoutsPanel_'], () => annotate(), {
        debounce: true,
        debounceDelay: 200,
    });
    unregisterReady = domObserver.onReady('LoadoutTalismanCheckCatchUp', () => annotate());

    // Data changes that leave the DOM untouched: a talisman deleted or rerolled, a loadout saved, a login
    for (const event of ['talismans_updated', 'character_initialized']) {
        dataManager.on(event, scheduleRefresh);
        dataHandlers.push([event, scheduleRefresh]);
    }
    wsHook = sharedWebSocketHook() || webSocketHook;
    wsHook.on('loadouts_updated', scheduleRefresh);

    unregisterSetting = config.onSettingChange(SETTING, () => annotate());
}

export default {
    name: 'Loadout Talisman Check',
    initialize,
    cleanup,
};
