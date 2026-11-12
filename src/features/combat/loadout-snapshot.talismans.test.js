/**
 * A loadout's equipment Map carries the loadout's OWN talismans: its belt, and the talismans its
 * talismanIdMap names, resolved against what the character owns. Not the ones slotted right now.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
    BELT_ITEMS,
    MODIFIER_DETAILS,
    TALISMAN_ENHANCEMENT_TABLE,
    talisman,
} from '../../__fixtures__/talisman-bonuses.js';

const game = vi.hoisted(() => ({ owned: [], server: true }));

vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
vi.mock('../../core/storage.js', () => ({ default: { setJSON: () => {}, getJSON: async () => null } }));
vi.mock('../../utils/game-server.js', () => ({ isTestServer: () => game.server }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        characterItems: [],
        getCurrentCharacterId: () => 'char1',
        characterData: {},
        on: () => {},
        off: () => {},
        getInitClientData: () => ({
            itemDetailMap: BELT_ITEMS,
            talismanModifierDetailMap: MODIFIER_DETAILS,
            enhancementLevelTotalBonusMultiplierTable: TALISMAN_ENHANCEMENT_TABLE,
        }),
        getCharacterTalismans: () => game.owned,
    },
}));

const { default: loadoutSnapshot } = await import('./loadout-snapshot.js');
const { talismanBonusesOf } = await import('../../utils/talisman-bonuses.js');

const belt = { itemHrid: '/items/large_talisman_belt', enhancementLevel: 10, itemLocationHrid: '/item_locations/belt' };

beforeEach(() => {
    game.server = true;
    game.owned = [talisman(2624, 1, [['milking_speed', 2]]), talisman(9, 0, [['skilling_speed', 2]])];
});

describe('equipmentMapOf', () => {
    test('uses the loadout belt and talisman map, skipping zeros and ids no longer owned', () => {
        const snapshot = { equipment: [belt], drinks: [], talismanIdMap: { 1: 2624, 2: 0, 3: 777 } };
        const map = loadoutSnapshot.equipmentMapOf(snapshot);
        expect(map.get('/item_locations/belt').itemHrid).toBe('/items/large_talisman_belt');
        expect(talismanBonusesOf(map).noncombat.milkingSpeed).toBeCloseTo(0.05661, 10);
        expect(talismanBonusesOf(map).noncombat.skillingSpeed).toBeUndefined();
    });

    test('a loadout with no talismanIdMap, or no belt, counts none even though the character has some slotted', () => {
        expect(talismanBonusesOf(loadoutSnapshot.equipmentMapOf({ equipment: [belt] })).noncombat).toEqual({});
        const noBelt = {
            equipment: [{ ...belt, itemLocationHrid: '/item_locations/ring' }],
            talismanIdMap: { 1: 2624 },
        };
        expect(talismanBonusesOf(loadoutSnapshot.equipmentMapOf(noBelt)).noncombat).toEqual({});
    });

    test('nothing rides on the Map off the test server', () => {
        game.server = false;
        const map = loadoutSnapshot.equipmentMapOf({ equipment: [belt], talismanIdMap: { 1: 2624 } });
        expect(talismanBonusesOf(map).noncombat).toEqual({});
    });

    test('the Map has the same entries it always had (the belt is just one more worn item)', () => {
        const map = loadoutSnapshot.equipmentMapOf({ equipment: [belt], talismanIdMap: { 1: 2624 } });
        expect([...map.keys()]).toEqual(['/item_locations/belt']);
    });
});
