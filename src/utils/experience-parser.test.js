/**
 * Tests for Experience Parser Utility (Wisdom + Charm Experience)
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
    gameData: { itemDetailMap: {} },
    houseRooms: new Map(),
    communityBuffLevels: {},
    achievementFlatBoost: 0,
    mooPassBuffs: [],
    personalFlatBoost: 0,
    characterData: {},
    equipment: new Map(),
    drinks: [],
}));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => state.gameData,
        getHouseRooms: () => state.houseRooms,
        getCommunityBuffLevel: (hrid) => state.communityBuffLevels[hrid] || 0,
        getAchievementBuffFlatBoost: () => state.achievementFlatBoost,
        getMooPassBuffs: () => state.mooPassBuffs,
        getPersonalBuffFlatBoost: () => state.personalFlatBoost,
        get characterData() {
            return state.characterData;
        },
    },
}));

vi.mock('./action-context.js', () => ({
    resolveActionContext: () => ({ equipment: state.equipment, drinks: state.drinks }),
}));

const {
    parseEquipmentWisdom,
    parseCharmExperience,
    parseHouseRoomWisdom,
    parseCommunityBuffWisdom,
    parseMooPassWisdom,
    parseConsumableWisdom,
    calculateExperienceMultiplier,
} = await import('./experience-parser.js');

beforeEach(() => {
    state.gameData = { itemDetailMap: {} };
    state.houseRooms = new Map();
    state.communityBuffLevels = {};
    state.achievementFlatBoost = 0;
    state.mooPassBuffs = [];
    state.personalFlatBoost = 0;
    state.characterData = {};
    state.equipment = new Map();
    state.drinks = [];
});

describe('parseEquipmentWisdom', () => {
    test('sums skillingExperience scaled by enhancement, returned as percentage', () => {
        const map = {
            '/items/wisdom_hat': {
                name: 'Wisdom Hat',
                equipmentDetail: { type: '/equipment_types/head', noncombatStats: { skillingExperience: 0.02 } },
            },
        };
        const equipment = new Map([['/item_locations/head', { itemHrid: '/items/wisdom_hat', enhancementLevel: 10 }]]);
        // 1x slot, +10 => multiplier 1.29: 0.02 * 1.29 * 100 = 2.58
        const result = parseEquipmentWisdom(equipment, map);
        expect(result.total).toBeCloseTo(2.58, 6);
        expect(result.breakdown[0].name).toBe('Wisdom Hat');
    });

    test('ignores items with no skillingExperience stat', () => {
        const map = { '/items/plain': { equipmentDetail: { noncombatStats: {} } } };
        const equipment = new Map([['/item_locations/head', { itemHrid: '/items/plain' }]]);
        expect(parseEquipmentWisdom(equipment, map).total).toBe(0);
    });
});

describe('parseCharmExperience', () => {
    test('reads the skill-specific experience field from equipped items', () => {
        const map = {
            '/items/foraging_charm': {
                name: 'Foraging Charm',
                equipmentDetail: { type: '/equipment_types/charm', noncombatStats: { foragingExperience: 0.05 } },
            },
        };
        const equipment = new Map([['/item_locations/charm', { itemHrid: '/items/foraging_charm' }]]);
        const result = parseCharmExperience(equipment, '/skills/foraging', map);
        expect(result.total).toBeCloseTo(5, 6);
    });

    test('does not pick up a different skill field', () => {
        const map = {
            '/items/foraging_charm': {
                equipmentDetail: { noncombatStats: { foragingExperience: 0.05 } },
            },
        };
        const equipment = new Map([['/item_locations/charm', { itemHrid: '/items/foraging_charm' }]]);
        expect(parseCharmExperience(equipment, '/skills/milking', map).total).toBe(0);
    });
});

describe('parseHouseRoomWisdom', () => {
    test('sums house room levels and applies 0.05% per level', () => {
        state.houseRooms = new Map([
            ['/house_rooms/library', { level: 4 }],
            ['/house_rooms/observatory', { level: 4 }],
        ]);
        expect(parseHouseRoomWisdom()).toBeCloseTo(0.4, 6);
    });

    test('returns 0 with no house rooms', () => {
        expect(parseHouseRoomWisdom()).toBe(0);
    });
});

describe('parseCommunityBuffWisdom', () => {
    test('returns 0 when the buff is inactive', () => {
        expect(parseCommunityBuffWisdom()).toBe(0);
    });

    test('applies 20% base + 0.5% per level above 1', () => {
        state.communityBuffLevels['/community_buff_types/experience'] = 20;
        expect(parseCommunityBuffWisdom()).toBeCloseTo(29.5, 6);
    });
});

describe('parseMooPassWisdom', () => {
    test('returns 0 without an active wisdom buff', () => {
        state.mooPassBuffs = [];
        expect(parseMooPassWisdom()).toBe(0);

        state.mooPassBuffs = [{ typeHrid: '/buff_types/other' }];
        expect(parseMooPassWisdom()).toBe(0);
    });

    test('converts the flat wisdom boost to a percentage', () => {
        state.mooPassBuffs = [{ typeHrid: '/buff_types/wisdom', flatBoost: 0.05 }];
        expect(parseMooPassWisdom()).toBeCloseTo(5, 6);
    });
});

describe('parseConsumableWisdom', () => {
    const map = {
        '/items/wisdom_tea': {
            consumableDetail: { buffs: [{ typeHrid: '/buff_types/wisdom', flatBoost: 0.12 }] },
        },
    };

    test('returns 0 with no drink slots', () => {
        expect(parseConsumableWisdom([], map, 0)).toBe(0);
        expect(parseConsumableWisdom(null, map, 0)).toBe(0);
    });

    test('scales wisdom tea by drink concentration percentage', () => {
        const result = parseConsumableWisdom([{ itemHrid: '/items/wisdom_tea' }], map, 12.16);
        // 0.12*100=12; 12 * (1 + 12.16/100) = 13.459...
        expect(result).toBeCloseTo(13.4592, 3);
    });

    test('skips empty slots and items without wisdom buffs', () => {
        const result = parseConsumableWisdom([null, { itemHrid: '/items/unknown' }], map, 12);
        expect(result).toBe(0);
    });
});

describe('calculateExperienceMultiplier', () => {
    test('combines all wisdom sources additively into totalMultiplier', () => {
        state.gameData = {
            itemDetailMap: {
                '/items/wisdom_ring': {
                    name: 'Wisdom Ring',
                    equipmentDetail: { type: '/equipment_types/ring', noncombatStats: { skillingExperience: 0.01 } },
                },
            },
        };
        state.equipment = new Map([['/item_locations/ring', { itemHrid: '/items/wisdom_ring' }]]);
        state.houseRooms = new Map([['/house_rooms/library', { level: 2 }]]);
        state.communityBuffLevels['/community_buff_types/experience'] = 1; // 20% flat

        const result = calculateExperienceMultiplier('/skills/foraging', '/action_types/foraging');

        // equipmentWisdom: 0.01*1*100=1; houseWisdom: 2*0.05=0.1; communityWisdom: 20
        expect(result.breakdown.equipmentWisdom).toBeCloseTo(1, 6);
        expect(result.breakdown.houseWisdom).toBeCloseTo(0.1, 6);
        expect(result.breakdown.communityWisdom).toBeCloseTo(20, 6);
        expect(result.totalWisdom).toBeCloseTo(21.1, 6);
        expect(result.totalMultiplier).toBeCloseTo(1.211, 6);
    });

    test('adds charm experience on top of wisdom, separately reported', () => {
        state.gameData = {
            itemDetailMap: {
                '/items/foraging_charm': {
                    name: 'Foraging Charm',
                    equipmentDetail: { type: '/equipment_types/charm', noncombatStats: { foragingExperience: 0.1 } },
                },
            },
        };
        state.equipment = new Map([['/item_locations/charm', { itemHrid: '/items/foraging_charm' }]]);

        const result = calculateExperienceMultiplier('/skills/foraging', '/action_types/foraging');
        expect(result.charmExperience).toBeCloseTo(10, 6);
        expect(result.totalMultiplier).toBeCloseTo(1.1, 6);
    });

    test('includes guild wisdom buffs (flat + ratio combined)', () => {
        state.characterData = {
            guildActionTypeBuffsMap: {
                '/action_types/foraging': [{ typeHrid: '/buff_types/wisdom', flatBoost: 0.05, ratioBoost: 0.02 }],
            },
        };
        const result = calculateExperienceMultiplier('/skills/foraging', '/action_types/foraging');
        expect(result.breakdown.guildWisdom).toBeCloseTo(7, 6); // (0.05+0.02)*100
    });
});
