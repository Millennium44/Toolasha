/**
 * getActionEfficiencyContext: the talisman share of Gourmet and Processing, from the equipment Map it is given
 * (a queued row's own loadout Map, or the live one). A Map with no talismans attached reads exactly as before.
 */

import { describe, test, expect, vi } from 'vitest';
import {
    BELT_ITEMS,
    MODIFIER_DETAILS,
    TALISMAN_ENHANCEMENT_TABLE,
    talisman,
} from '../__fixtures__/talisman-bonuses.js';

vi.mock('../core/data-manager.js', () => ({
    default: {
        getSkills: () => [{ skillHrid: '/skills/cooking', level: 50 }],
        getInitClientData: () => ({ itemDetailMap: BELT_ITEMS }),
        getPersonalBuffFlatBoost: () => 0,
        getAchievementBuffFlatBoost: () => 0,
        getHouseRooms: () => new Map(),
        getHouseRoomLevel: () => 0,
        characterData: {},
    },
}));
vi.mock('./action-context.js', () => ({ resolveActionContext: () => ({ equipment: new Map(), drinks: [] }) }));
vi.mock('./game-server.js', () => ({ isTestServer: () => true }));

const { getActionEfficiencyContext } = await import('./efficiency.js');
const { computeTalismanBonuses, attachTalismanBonuses } = await import('./talisman-bonuses.js');

const belt = { itemHrid: '/items/large_talisman_belt', enhancementLevel: 10 };
const worn = () =>
    new Map([
        [
            '/item_locations/belt',
            { itemHrid: belt.itemHrid, itemLocationHrid: '/item_locations/belt', enhancementLevel: 10 },
        ],
    ]);
const withTalismans = (talismans) =>
    attachTalismanBonuses(
        worn(),
        computeTalismanBonuses({
            talismans,
            belt,
            itemDetailMap: BELT_ITEMS,
            modifierDetailMap: MODIFIER_DETAILS,
            enhancementTable: TALISMAN_ENHANCEMENT_TABLE,
        })
    );

const cooking = {
    type: '/action_types/cooking',
    baseTimeCost: 6e9,
    levelRequirement: { skillHrid: '/skills/cooking', level: 1 },
};
const context = (equipment) =>
    getActionEfficiencyContext(cooking, { isProduction: true, actionContext: { equipment, drinks: [] } });

describe('Gourmet from talismans', () => {
    test('a Gourmet G3 line under a Large belt +10 is 0.02 x 1.258 on a production action', () => {
        const out = context(withTalismans([talisman(1, 1, [['gourmet', 3]])]));
        expect(out.gourmetBonus).toBeCloseTo(0.02 * 1.258, 10);
    });

    test('two Gourmet talismans stack, and a slot the belt does not have adds nothing', () => {
        const out = context(
            withTalismans([
                talisman(1, 1, [['gourmet', 3]]),
                talisman(2, 3, [['gourmet', 3]]),
                talisman(3, 4, [['gourmet', 6]]),
            ])
        );
        expect(out.gourmetBonus).toBeCloseTo(2 * 0.02 * 1.258, 10);
    });

    test('a Map with no talismans attached (a copy, a hypothetical kit) reads zero', () => {
        expect(context(worn()).gourmetBonus).toBe(0);
    });
});
