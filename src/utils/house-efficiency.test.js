/**
 * Tests for House Efficiency Utility
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const character = vi.hoisted(() => ({ houseRoomLevels: {}, houseRooms: new Map() }));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getHouseRoomLevel: (hrid) => character.houseRoomLevels[hrid] || 0,
        getHouseRooms: () => character.houseRooms,
    },
}));

const { calculateHouseEfficiency, getHouseRoomName, calculateHouseRareFind } = await import('./house-efficiency.js');

describe('calculateHouseEfficiency', () => {
    beforeEach(() => {
        character.houseRoomLevels = {};
    });

    test('returns 0 for an action type with no matching house room', () => {
        expect(calculateHouseEfficiency('/action_types/combat')).toBe(0);
    });

    test('applies 1.5% per level for a matching action type', () => {
        character.houseRoomLevels['/house_rooms/brewery'] = 8;
        expect(calculateHouseEfficiency('/action_types/brewing')).toBe(12);
    });

    test('returns 0 when the mapped room is at level 0', () => {
        character.houseRoomLevels['/house_rooms/forge'] = 0;
        expect(calculateHouseEfficiency('/action_types/cheesesmithing')).toBe(0);
    });

    test('maps every documented action type to its house room', () => {
        const cases = [
            ['/action_types/cooking', '/house_rooms/kitchen'],
            ['/action_types/crafting', '/house_rooms/workshop'],
            ['/action_types/foraging', '/house_rooms/garden'],
            ['/action_types/milking', '/house_rooms/dairy_barn'],
            ['/action_types/tailoring', '/house_rooms/sewing_parlor'],
            ['/action_types/woodcutting', '/house_rooms/log_shed'],
            ['/action_types/alchemy', '/house_rooms/laboratory'],
        ];
        for (const [actionType, room] of cases) {
            character.houseRoomLevels = { [room]: 4 };
            expect(calculateHouseEfficiency(actionType)).toBe(6);
        }
    });
});

describe('getHouseRoomName', () => {
    test('returns the friendly name for a known room', () => {
        expect(getHouseRoomName('/house_rooms/brewery')).toBe('Brewery');
        expect(getHouseRoomName('/house_rooms/dairy_barn')).toBe('Dairy Barn');
    });

    test('returns Unknown for an unrecognized room', () => {
        expect(getHouseRoomName('/house_rooms/nonexistent')).toBe('Unknown');
    });
});

describe('calculateHouseRareFind', () => {
    beforeEach(() => {
        character.houseRooms = new Map();
    });

    test('returns 0 when there are no house rooms', () => {
        expect(calculateHouseRareFind()).toBe(0);
    });

    test('sums levels across all rooms and applies 0.2% per level', () => {
        character.houseRooms = new Map([
            ['/house_rooms/brewery', { level: 5 }],
            ['/house_rooms/forge', { level: 3 }],
        ]);
        expect(calculateHouseRareFind()).toBeCloseTo(1.6, 6); // 8 * 0.2
    });

    test('treats a missing level as 0', () => {
        character.houseRooms = new Map([['/house_rooms/brewery', {}]]);
        expect(calculateHouseRareFind()).toBe(0);
    });
});
