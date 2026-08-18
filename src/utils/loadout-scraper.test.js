/** @vitest-environment happy-dom */
/**
 * Tests for Loadout Scraper Utilities
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ inventory: [], clientData: null }));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getInventory: () => state.inventory,
        getInitClientData: () => state.clientData,
    },
}));

const { buildEnhancementLevelMap, getItemLocationHrid } = await import('./loadout-scraper.js');

describe('buildEnhancementLevelMap', () => {
    test('returns an empty map with no inventory', () => {
        state.inventory = null;
        expect(buildEnhancementLevelMap().size).toBe(0);
    });

    test('tracks the highest enhancement level per item HRID', () => {
        state.inventory = [
            { itemHrid: '/items/sword', enhancementLevel: 3, count: 1 },
            { itemHrid: '/items/sword', enhancementLevel: 7, count: 1 },
            { itemHrid: '/items/shield', enhancementLevel: 2, count: 1 },
        ];
        const map = buildEnhancementLevelMap();
        expect(map.get('/items/sword')).toBe(7);
        expect(map.get('/items/shield')).toBe(2);
    });

    test('skips items with zero count', () => {
        state.inventory = [{ itemHrid: '/items/sword', enhancementLevel: 5, count: 0 }];
        expect(buildEnhancementLevelMap().has('/items/sword')).toBe(false);
    });
});

describe('getItemLocationHrid', () => {
    beforeEach(() => {
        state.clientData = {
            itemDetailMap: {
                '/items/sword': { equipmentDetail: { type: '/equipment_types/main_hand' } },
                '/items/no_equip_detail': {},
            },
        };
    });

    test('maps equipment type to item location', () => {
        expect(getItemLocationHrid('/items/sword')).toBe('/item_locations/main_hand');
    });

    test('returns null without client data', () => {
        state.clientData = null;
        expect(getItemLocationHrid('/items/sword')).toBeNull();
    });

    test('returns null for an item with no equipment detail', () => {
        expect(getItemLocationHrid('/items/no_equip_detail')).toBeNull();
    });

    test('returns null for an unknown item', () => {
        expect(getItemLocationHrid('/items/unknown')).toBeNull();
    });
});
