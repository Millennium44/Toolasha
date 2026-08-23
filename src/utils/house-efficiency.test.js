/**
 * Tests for House Efficiency Utility
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const character = vi.hoisted(() => ({ houseRooms: new Map(), roomDetailMap: {} }));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getHouseRooms: () => character.houseRooms,
        getInitClientData: () => ({ houseRoomDetailMap: character.roomDetailMap }),
    },
}));

/** The game's own room→skill mapping, as `houseRoomDetailMap` publishes it. */
const ROOM_SKILLS = {
    '/house_rooms/brewery': '/action_types/brewing',
    '/house_rooms/forge': '/action_types/cheesesmithing',
    '/house_rooms/kitchen': '/action_types/cooking',
    '/house_rooms/workshop': '/action_types/crafting',
    '/house_rooms/garden': '/action_types/foraging',
    '/house_rooms/dairy_barn': '/action_types/milking',
    '/house_rooms/sewing_parlor': '/action_types/tailoring',
    '/house_rooms/log_shed': '/action_types/woodcutting',
    '/house_rooms/laboratory': '/action_types/alchemy',
};

/** Populate the mocked game data and character rooms from a `{roomHrid: level}` map. */
function withRooms(levels) {
    character.roomDetailMap = Object.fromEntries(
        Object.entries(ROOM_SKILLS).map(([room, actionType]) => [
            room,
            { usableInActionTypeMap: { [actionType]: true } },
        ])
    );
    character.houseRooms = new Map(
        Object.entries(levels).map(([room, level]) => [room, { houseRoomHrid: room, level }])
    );
}

const { calculateHouseEfficiency, getHouseRoomName, calculateHouseRareFind } = await import('./house-efficiency.js');

describe('calculateHouseEfficiency', () => {
    beforeEach(() => {
        withRooms({});
    });

    test('returns 0 for an action type no room covers', () => {
        withRooms({ '/house_rooms/brewery': 8 });
        expect(calculateHouseEfficiency('/action_types/combat')).toBe(0);
    });

    test('applies 1.5% per level for a matching action type', () => {
        withRooms({ '/house_rooms/brewery': 8 });
        expect(calculateHouseEfficiency('/action_types/brewing')).toBe(12);
    });

    test('returns 0 when the matching room is at level 0', () => {
        withRooms({ '/house_rooms/forge': 0 });
        expect(calculateHouseEfficiency('/action_types/cheesesmithing')).toBe(0);
    });

    test('covers every action type the game data maps a room to', () => {
        for (const [room, actionType] of Object.entries(ROOM_SKILLS)) {
            withRooms({ [room]: 4 });
            expect(calculateHouseEfficiency(actionType)).toBe(6);
        }
    });

    test('follows the game data rather than a table of its own', () => {
        // A room the game says covers two skills counts for both — a hand-written
        // action-type-to-room map could never express that
        withRooms({ '/house_rooms/brewery': 4 });
        character.roomDetailMap['/house_rooms/brewery'].usableInActionTypeMap['/action_types/cooking'] = true;
        expect(calculateHouseEfficiency('/action_types/brewing')).toBe(6);
        expect(calculateHouseEfficiency('/action_types/cooking')).toBe(6);
    });

    test('sums every room that covers the action type', () => {
        withRooms({ '/house_rooms/brewery': 4, '/house_rooms/kitchen': 2 });
        character.roomDetailMap['/house_rooms/kitchen'].usableInActionTypeMap['/action_types/brewing'] = true;
        expect(calculateHouseEfficiency('/action_types/brewing')).toBe(9); // (4 + 2) * 1.5
    });

    test('returns 0 without game data rather than guessing', () => {
        withRooms({ '/house_rooms/brewery': 8 });
        character.roomDetailMap = null;
        expect(calculateHouseEfficiency('/action_types/brewing')).toBe(0);
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
