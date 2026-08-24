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

/** The game's own roomskill mapping, as `houseRoomDetailMap` publishes it. */
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

/**
 * A room detail shaped the way the game ships one: the action-type scope appears
 * both on the room and on the buff, and the buff names which buff type it is and
 * how it scales per level.
 * @param {string} actionType - The action type the room covers
 * @param {string} [buffType] - Buff type hrid the room's action buff grants
 * @param {number} [perLevel] - flatBoost/flatBoostLevelBonus, as a ratio
 * @returns {object} A houseRoomDetailMap entry
 */
function roomDetail(actionType, buffType = '/buff_types/efficiency', perLevel = 0.015) {
    return {
        usableInActionTypeMap: { [actionType]: true },
        actionBuffs: [
            {
                typeHrid: buffType,
                usableInActionTypeMap: { [actionType]: true },
                flatBoost: perLevel,
                flatBoostLevelBonus: perLevel,
                ratioBoost: 0,
                ratioBoostLevelBonus: 0,
            },
        ],
    };
}

/**
 * Populate the mocked game data and character rooms from a `{roomHrid: level}` map.
 * @param {Object} levels - Room hrid to level
 * @returns {void}
 */
function withRooms(levels) {
    character.roomDetailMap = Object.fromEntries(
        Object.entries(ROOM_SKILLS).map(([room, actionType]) => [room, roomDetail(actionType)])
    );
    character.houseRooms = new Map(
        Object.entries(levels).map(([room, level]) => [room, { houseRoomHrid: room, level }])
    );
}

/**
 * Add the buff that motivated this fix: the Observatory covers enhancing, but the
 * buff it grants there is action speed, not efficiency.
 * @param {number} level - Observatory level
 * @returns {void}
 */
function withObservatory(level) {
    character.roomDetailMap['/house_rooms/observatory'] = roomDetail(
        '/action_types/enhancing',
        '/buff_types/action_speed',
        0.015
    );
    character.houseRooms.set('/house_rooms/observatory', {
        houseRoomHrid: '/house_rooms/observatory',
        level,
    });
}

const { calculateHouseEfficiency, calculateHouseActionSpeed, getHouseRoomName, calculateHouseRareFind } =
    await import('./house-efficiency.js');

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
        expect(calculateHouseEfficiency('/action_types/brewing')).toBeCloseTo(12, 6);
    });

    test('returns 0 when the matching room is at level 0', () => {
        withRooms({ '/house_rooms/forge': 0 });
        expect(calculateHouseEfficiency('/action_types/cheesesmithing')).toBe(0);
    });

    test('covers every action type the game data maps a room to', () => {
        for (const [room, actionType] of Object.entries(ROOM_SKILLS)) {
            withRooms({ [room]: 4 });
            expect(calculateHouseEfficiency(actionType)).toBeCloseTo(6, 6);
        }
    });

    test('follows the game data rather than a table of its own', () => {
        // A room the game says covers two skills counts for both  a hand-written
        // action-type-to-room map could never express that
        withRooms({ '/house_rooms/brewery': 4 });
        const brewery = character.roomDetailMap['/house_rooms/brewery'];
        brewery.usableInActionTypeMap['/action_types/cooking'] = true;
        brewery.actionBuffs[0].usableInActionTypeMap['/action_types/cooking'] = true;
        expect(calculateHouseEfficiency('/action_types/brewing')).toBeCloseTo(6, 6);
        expect(calculateHouseEfficiency('/action_types/cooking')).toBeCloseTo(6, 6);
    });

    test('sums every room that covers the action type', () => {
        withRooms({ '/house_rooms/brewery': 4, '/house_rooms/kitchen': 2 });
        const kitchen = character.roomDetailMap['/house_rooms/kitchen'];
        kitchen.usableInActionTypeMap['/action_types/brewing'] = true;
        kitchen.actionBuffs[0].usableInActionTypeMap['/action_types/brewing'] = true;
        expect(calculateHouseEfficiency('/action_types/brewing')).toBeCloseTo(9, 6); // (4 + 2) * 1.5
    });

    test('reads the per-level scaling from the buff rather than assuming 1.5%', () => {
        withRooms({ '/house_rooms/brewery': 5 });
        character.roomDetailMap['/house_rooms/brewery'] = roomDetail(
            '/action_types/brewing',
            '/buff_types/efficiency',
            0.02
        );
        expect(calculateHouseEfficiency('/action_types/brewing')).toBeCloseTo(10, 6); // 5 * 2%
    });

    test('returns 0 without game data rather than guessing', () => {
        withRooms({ '/house_rooms/brewery': 8 });
        character.roomDetailMap = null;
        expect(calculateHouseEfficiency('/action_types/brewing')).toBe(0);
    });

    test('a room whose buff is not an efficiency buff contributes no efficiency', () => {
        // The Observatory really does help enhancing  through action speed. Crediting
        // it as efficiency invented a +1.5%/level repeat chance that does not exist.
        withRooms({});
        withObservatory(8);
        expect(calculateHouseEfficiency('/action_types/enhancing')).toBe(0);
    });

    test('a combat room listed for combat is not credited as efficiency', () => {
        withRooms({});
        character.roomDetailMap['/house_rooms/dining_room'] = roomDetail(
            '/action_types/combat',
            '/buff_types/food_slots',
            1
        );
        character.houseRooms.set('/house_rooms/dining_room', {
            houseRoomHrid: '/house_rooms/dining_room',
            level: 8,
        });
        expect(calculateHouseEfficiency('/action_types/combat')).toBe(0);
    });

    test('a room with no actionBuffs at all contributes nothing', () => {
        withRooms({ '/house_rooms/brewery': 8 });
        delete character.roomDetailMap['/house_rooms/brewery'].actionBuffs;
        expect(calculateHouseEfficiency('/action_types/brewing')).toBe(0);
    });
});

describe('calculateHouseActionSpeed', () => {
    beforeEach(() => {
        withRooms({});
    });

    test('the Observatory speeds up enhancing, as a ratio', () => {
        withObservatory(8);
        expect(calculateHouseActionSpeed('/action_types/enhancing')).toBeCloseTo(0.12, 6);
    });

    test('an efficiency room contributes no speed', () => {
        withRooms({ '/house_rooms/brewery': 8 });
        expect(calculateHouseActionSpeed('/action_types/brewing')).toBe(0);
    });

    test('a speed room contributes nothing to an action type it does not cover', () => {
        withObservatory(8);
        expect(calculateHouseActionSpeed('/action_types/brewing')).toBe(0);
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
