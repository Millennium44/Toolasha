/**
 * Loadout Scraper Utilities
 *
 * What the inventory can say about a loadout without touching the DOM.
 *
 * This file once carried DOM scrapers for the LoadoutsPanel element; they had
 * no callers left (loadouts are read from the WebSocket cache now) and their
 * selector-miss behavior returned valid-shaped emptiness — a trap for anyone
 * rewiring them. Deleted rather than kept plausible. Used by
 * skilling-optimizer-ui.js.
 */

import dataManager from '../core/data-manager.js';

/**
 * Build a map of itemHrid → highest enhancementLevel across all character items.
 * Covers both currently equipped items and inventory items.
 * @returns {Map<string, number>}
 */
export function buildEnhancementLevelMap() {
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

// Maps equipmentDetail.type → itemLocationHrid
export const EQUIPMENT_TYPE_TO_LOCATION = {
    '/equipment_types/back': '/item_locations/back',
    '/equipment_types/head': '/item_locations/head',
    '/equipment_types/trinket': '/item_locations/trinket',
    '/equipment_types/main_hand': '/item_locations/main_hand',
    '/equipment_types/two_hand': '/item_locations/main_hand',
    '/equipment_types/body': '/item_locations/body',
    '/equipment_types/off_hand': '/item_locations/off_hand',
    '/equipment_types/hands': '/item_locations/hands',
    '/equipment_types/legs': '/item_locations/legs',
    '/equipment_types/pouch': '/item_locations/pouch',
    '/equipment_types/feet': '/item_locations/feet',
    '/equipment_types/neck': '/item_locations/neck',
    '/equipment_types/earrings': '/item_locations/earrings',
    '/equipment_types/ring': '/item_locations/ring',
    '/equipment_types/charm': '/item_locations/charm',
};

/**
 * Determine itemLocationHrid for an equipment item using initClientData
 * Maps equipmentDetail.type to the corresponding item_locations HRID.
 * @param {string} itemHrid
 * @returns {string|null}
 */
export function getItemLocationHrid(itemHrid) {
    const clientData = dataManager.getInitClientData();
    if (!clientData) return null;
    const detail = clientData.itemDetailMap?.[itemHrid];
    if (!detail) return null;
    const equipType = detail.equipmentDetail?.type;
    if (!equipType) return null;
    return EQUIPMENT_TYPE_TO_LOCATION[equipType] || null;
}
