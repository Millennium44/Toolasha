// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
/**
 * Which of a house room's buffs belong in a combat simulation.
 *
 * Action buffs are scoped per action type, and the type strings are shared:
 * a Library's wisdom and a combat room's wisdom are both /buff_types/wisdom.
 * The engine only ever fights, so an unfiltered room quietly added skilling
 * bonuses to combat XP and rare-find — the sim flattered every character with
 * developed non-combat housing.
 */

import { describe, test, expect, afterEach } from 'vitest';
import { setGameData } from './game-data.js';
import HouseRoom from './house-room.js';

const COMBAT = '/action_types/combat';

/** A minimal buff detail of the shape houseRoomDetailMap carries */
function buffDetail(typeHrid, usableIn) {
    return {
        uniqueHrid: `/buff_uniques/test_${typeHrid.split('/').pop()}`,
        typeHrid,
        ratioBoost: 0,
        ratioBoostLevelBonus: 0.005,
        flatBoost: 0,
        flatBoostLevelBonus: 0,
        duration: 0,
        usableInActionTypeMap: usableIn,
    };
}

function installRooms(rooms) {
    setGameData({ houseRoomDetailMap: rooms });
}

afterEach(() => {
    setGameData(null);
});

describe('house room buffs entering combat', () => {
    test('a combat-scoped action buff is kept', () => {
        installRooms({
            '/house_rooms/armory': {
                actionBuffs: [buffDetail('/buff_types/attack_speed', { [COMBAT]: true })],
            },
        });

        const room = new HouseRoom('/house_rooms/armory', 3);

        expect(room.buffs).toHaveLength(1);
        expect(room.buffs[0].typeHrid).toBe('/buff_types/attack_speed');
    });

    test('a skilling-scoped action buff applies too — the live game does this', () => {
        // The same wisdom type string a combat room would use — scope is the
        // only thing separating "combat XP bonus" from "milking XP bonus"
        installRooms({
            '/house_rooms/library': {
                actionBuffs: [buffDetail('/buff_types/wisdom', { '/action_types/milking': true })],
            },
        });

        const room = new HouseRoom('/house_rooms/library', 8);

        expect(room.buffs).toHaveLength(1);
    });

    test('global buffs pass regardless, because they are unscoped by design', () => {
        installRooms({
            '/house_rooms/garden': {
                globalBuffs: [buffDetail('/buff_types/experience', undefined)],
            },
        });

        const room = new HouseRoom('/house_rooms/garden', 2);

        expect(room.buffs).toHaveLength(1);
    });

    test('a mixed room keeps only its combat-facing share', () => {
        installRooms({
            '/house_rooms/mixed': {
                actionBuffs: [
                    buffDetail('/buff_types/wisdom', { '/action_types/milking': true }),
                    buffDetail('/buff_types/rare_find', { [COMBAT]: true }),
                ],
                globalBuffs: [buffDetail('/buff_types/experience', undefined)],
            },
        });

        const room = new HouseRoom('/house_rooms/mixed', 5);

        expect(room.buffs.map((buff) => buff.typeHrid)).toEqual([
            '/buff_types/wisdom',
            '/buff_types/rare_find',
            '/buff_types/experience',
        ]);
    });
});
