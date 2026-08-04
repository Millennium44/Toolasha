/**
 * The shape handed to Milkonomy.
 *
 * Ten skills, each with a tool and four pieces of gear, and the gear is not
 * what you happen to be wearing — it is the best thing you own for that skill,
 * chosen out of the whole inventory. So the interesting behaviour is the
 * choosing: which items are candidates for which skill, and which of the
 * candidates wins. Everything else is a mapping table, and mapping tables are
 * worth a test precisely because nothing complains when one has a hole in it.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    characterData: null,
    clientData: null,
    inventory: [],
    equipment: new Map(),
    houseLevels: {},
    drinkSlots: {},
    communityBuffs: {},
    personalBuffs: {},
    profileList: [],
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterData() {
            return game.characterData;
        },
        get personalActionTypeBuffsMap() {
            return game.personalBuffs;
        },
        getInitClientData: () => game.clientData,
        getInventory: () => game.inventory,
        getEquipment: () => game.equipment,
        getHouseRoomLevel: (hrid) => game.houseLevels[hrid] ?? 0,
        getActionDrinkSlots: (hrid) => game.drinkSlots[hrid] ?? [],
        getCommunityBuffLevel: (hrid) => game.communityBuffs[hrid] ?? 0,
    },
}));

vi.mock('../../core/storage.js', () => ({
    default: { getJSON: async () => game.profileList },
}));

const { constructMilkonomyExport } = await import('./milkonomy-export.js');

const ME = 'char-me';

const SKILLS = [
    'milking',
    'foraging',
    'woodcutting',
    'cheesesmithing',
    'crafting',
    'tailoring',
    'cooking',
    'brewing',
    'alchemy',
    'enhancing',
];

/** An item detail the way initClientData carries one. */
function equipmentDetail(type, noncombatStats) {
    return { name: type, equipmentDetail: { type, noncombatStats } };
}

beforeEach(() => {
    game.characterData = {
        character: { id: ME, name: 'Milkbeard' },
        characterSkills: SKILLS.map((skill, i) => ({ skillHrid: `/skills/${skill}`, level: 10 + i })),
    };
    game.clientData = { itemDetailMap: {} };
    game.inventory = [];
    game.equipment = new Map();
    game.houseLevels = {};
    game.drinkSlots = {};
    game.communityBuffs = {};
    game.personalBuffs = {};
    game.profileList = [];
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('refusing to export half a character', () => {
    test('with no character data there is nothing to export', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        game.characterData = null;

        expect(await constructMilkonomyExport()).toBeNull();
        expect(error).toHaveBeenCalled();
        error.mockRestore();
    });

    test('with no game data the item lookups would be meaningless', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        game.clientData = null;

        expect(await constructMilkonomyExport()).toBeNull();
        error.mockRestore();
    });

    test('with no inventory there is nothing to pick gear from', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        game.inventory = null;

        expect(await constructMilkonomyExport()).toBeNull();
        error.mockRestore();
    });
});

describe('the skeleton of the export', () => {
    test('the character, and a config for each of the ten skills', async () => {
        const result = await constructMilkonomyExport();

        expect(result.name).toBe('Milkbeard');
        expect(result.color).toBe('#90ee90');
        expect(Object.keys(result.actionConfigMap)).toEqual(SKILLS);
        expect(result.actionConfigMap.brewing.action).toBe('brewing');
    });

    test('an unnamed character is just a Player', async () => {
        game.characterData = { characterSkills: [] };
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});

        expect((await constructMilkonomyExport()).name).toBe('Player');
        error.mockRestore();
    });

    test('each skill config carries that skill’s level', async () => {
        const result = await constructMilkonomyExport();

        expect(result.actionConfigMap.milking.playerLevel).toBe(10);
        expect(result.actionConfigMap.enhancing.playerLevel).toBe(19);
    });

    test('a skill the character has never trained reads as level one', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        game.characterData.characterSkills = [{ skillHrid: '/skills/milking', level: 55 }];

        const result = await constructMilkonomyExport();

        expect(result.actionConfigMap.milking.playerLevel).toBe(55);
        expect(result.actionConfigMap.brewing.playerLevel).toBe(1);
        expect(error).toHaveBeenCalled();
        error.mockRestore();
    });

    test('house levels come from the room that skill uses', async () => {
        game.houseLevels = { '/house_rooms/brewery': 8, '/house_rooms/dairy_barn': 3 };

        const result = await constructMilkonomyExport();

        expect(result.actionConfigMap.brewing.houseLevel).toBe(8);
        expect(result.actionConfigMap.milking.houseLevel).toBe(3);
        expect(result.actionConfigMap.alchemy.houseLevel).toBe(0);
    });

    test('teas are whatever is in that action’s drink slots', async () => {
        game.drinkSlots = {
            '/action_types/brewing': [{ itemHrid: '/items/brewing_tea' }, null, { itemHrid: '/items/wisdom_tea' }],
        };

        const result = await constructMilkonomyExport();

        expect(result.actionConfigMap.brewing.tea).toEqual(['/items/brewing_tea', '/items/wisdom_tea']);
        expect(result.actionConfigMap.milking.tea).toEqual([]);
    });

    test('the community buffs are reported at their current levels', async () => {
        game.communityBuffs = { '/community_buff_types/experience': 15 };

        const result = await constructMilkonomyExport();

        expect(result.communityBuffMap.experience).toEqual({
            type: 'experience',
            hrid: '/community_buff_types/experience',
            level: 15,
        });
        expect(result.communityBuffMap.enhancing_speed.level).toBe(0);
        expect(Object.keys(result.communityBuffMap)).toEqual([
            'experience',
            'gathering_quantity',
            'production_efficiency',
            'enhancing_speed',
        ]);
    });
});

describe('picking the best gear for a skill', () => {
    beforeEach(() => {
        game.clientData = {
            itemDetailMap: {
                '/items/brewing_pot': equipmentDetail('/equipment_types/brewing_tool', { brewingSpeed: 0.1 }),
                '/items/better_pot': equipmentDetail('/equipment_types/brewing_tool', { brewingEfficiency: 0.2 }),
                '/items/cooking_pot': equipmentDetail('/equipment_types/cooking_tool', { cookingSpeed: 0.1 }),
                '/items/plain_gloves': equipmentDetail('/equipment_types/brewing_tool', { attackSpeed: 0.1 }),
                '/items/brewers_bottoms': equipmentDetail('/equipment_types/legs', { brewingEfficiency: 0.05 }),
                '/items/milk': { name: 'Milk' },
            },
        };
    });

    test('the highest enhancement among the items that help wins', async () => {
        game.inventory = [
            { itemHrid: '/items/brewing_pot', enhancementLevel: 5 },
            { itemHrid: '/items/better_pot', enhancementLevel: 10 },
            { itemHrid: '/items/brewing_pot', enhancementLevel: 3 },
        ];

        const result = await constructMilkonomyExport();

        expect(result.actionConfigMap.brewing.tool).toEqual({
            type: 'brewing_tool',
            hrid: '/items/better_pot',
            enhanceLevel: 10,
        });
    });

    test('an unenhanced item reports no enhancement rather than a zero', async () => {
        game.inventory = [{ itemHrid: '/items/brewing_pot', enhancementLevel: 0 }];

        const result = await constructMilkonomyExport();

        expect(result.actionConfigMap.brewing.tool).toEqual({
            type: 'brewing_tool',
            hrid: '/items/brewing_pot',
            enhanceLevel: null,
        });
    });

    test('a tool for another skill is not a candidate', async () => {
        game.inventory = [{ itemHrid: '/items/cooking_pot', enhancementLevel: 12 }];

        const result = await constructMilkonomyExport();

        expect(result.actionConfigMap.brewing.tool).toEqual({ type: 'brewing_tool' });
        expect(result.actionConfigMap.cooking.tool.hrid).toBe('/items/cooking_pot');
    });

    test('an item in the right slot with no stats for that skill is not a candidate either', async () => {
        game.inventory = [{ itemHrid: '/items/plain_gloves', enhancementLevel: 20 }];

        expect((await constructMilkonomyExport()).actionConfigMap.brewing.tool).toEqual({ type: 'brewing_tool' });
    });

    test('a stat named for the skill in any form counts', async () => {
        game.inventory = [{ itemHrid: '/items/brewers_bottoms', enhancementLevel: 4 }];

        expect((await constructMilkonomyExport()).actionConfigMap.brewing.legs).toEqual({
            type: 'legs',
            hrid: '/items/brewers_bottoms',
            enhanceLevel: 4,
        });
        expect((await constructMilkonomyExport()).actionConfigMap.cooking.legs).toEqual({ type: 'legs' });
    });

    test('items that are not equipment, and items the game does not know, are skipped', async () => {
        game.inventory = [
            { itemHrid: '/items/milk', count: 5000 },
            { itemHrid: '/items/mystery' },
            { count: 3 },
            { itemHrid: '/items/brewing_pot', enhancementLevel: 1 },
        ];

        expect((await constructMilkonomyExport()).actionConfigMap.brewing.tool.hrid).toBe('/items/brewing_pot');
    });

    test('an empty slot is reported as the slot with nothing in it', async () => {
        const config = (await constructMilkonomyExport()).actionConfigMap.alchemy;

        expect(config.tool).toEqual({ type: 'alchemy_tool' });
        expect(config.legs).toEqual({ type: 'legs' });
        expect(config.charm).toEqual({ type: 'charm' });
    });

    test('the back slot keeps its raw hrid, having no entry in the slot-name table', async () => {
        // PINS CURRENT BEHAVIOUR: every other slot is renamed to Milkonomy's
        // short form ('legs', 'charm'), but '/equipment_types/back' is missing
        // from the mapping, so it goes out as the hrid it came in as.
        expect((await constructMilkonomyExport()).actionConfigMap.brewing.back).toEqual({
            type: '/equipment_types/back',
        });
    });
});

describe('the equipment that is not skill-specific', () => {
    test('what you are wearing goes across, when it does anything for skilling', async () => {
        game.clientData = {
            itemDetailMap: {
                '/items/gathering_pouch': equipmentDetail('/equipment_types/pouch', { gatheringQuantity: 0.1 }),
                '/items/cheese_buckler': equipmentDetail('/equipment_types/off_hand', {}),
                '/items/wisdom_earrings': equipmentDetail('/equipment_types/earrings', { wisdom: 0.05 }),
            },
        };
        game.equipment = new Map([
            ['/item_locations/pouch', { itemHrid: '/items/gathering_pouch', enhancementLevel: 6 }],
            ['/item_locations/off_hand', { itemHrid: '/items/cheese_buckler', enhancementLevel: 9 }],
            ['/item_locations/earrings', { itemHrid: '/items/wisdom_earrings', enhancementLevel: 0 }],
        ]);

        const special = (await constructMilkonomyExport()).specialEquimentMap;

        expect(special.pouch).toEqual({ type: 'pouch', hrid: '/items/gathering_pouch', enhanceLevel: 6 });
        expect(special.earrings).toEqual({ type: 'earrings', hrid: '/items/wisdom_earrings', enhanceLevel: null });
        expect(special.off_hand).toEqual({ type: 'off_hand' }); // combat-only, so nothing to send
    });

    test('every special slot is present even when the slot is empty', async () => {
        const special = (await constructMilkonomyExport()).specialEquimentMap;

        expect(Object.keys(special)).toEqual([
            'off_hand',
            'head',
            'hands',
            'feet',
            'neck',
            'earrings',
            'ring',
            'pouch',
        ]);
        expect(special.head).toEqual({ type: 'head' });
    });

    test('an equipped item the game data cannot explain is left out', async () => {
        game.equipment = new Map([['/item_locations/head', { itemHrid: '/items/mystery_hat' }]]);

        expect((await constructMilkonomyExport()).specialEquimentMap.head).toEqual({ type: 'head' });
    });
});

describe('scrolls and achievements', () => {
    test('an active scroll buff is exported as the scroll that grants it', async () => {
        game.personalBuffs = {
            '/action_types/milking': [{ typeHrid: '/buff_types/gathering' }, { typeHrid: '/buff_types/efficiency' }],
        };

        expect((await constructMilkonomyExport()).seals).toEqual([
            '/items/seal_of_gathering',
            '/items/seal_of_efficiency',
        ]);
    });

    test('the same buff on two action types is one scroll', async () => {
        game.personalBuffs = {
            '/action_types/milking': [{ typeHrid: '/buff_types/efficiency' }],
            '/action_types/brewing': [{ typeHrid: '/buff_types/efficiency' }],
        };

        expect((await constructMilkonomyExport()).seals).toEqual(['/items/seal_of_efficiency']);
    });

    test('buffs that are not scrolls are not scrolls', async () => {
        game.personalBuffs = {
            '/action_types/milking': [{ typeHrid: '/buff_types/experience' }, {}],
            '/action_types/brewing': 'not an array',
        };

        expect((await constructMilkonomyExport()).seals).toEqual([]);
    });

    test('a tier counts only when every achievement in it is done', async () => {
        game.clientData.achievementDetailMap = {
            '/achievements/a': { tierHrid: '/achievement_tiers/beginner' },
            '/achievements/b': { tierHrid: '/achievement_tiers/beginner' },
            '/achievements/c': { tierHrid: '/achievement_tiers/novice' },
        };
        game.characterData.characterAchievements = [
            { achievementHrid: '/achievements/a', isCompleted: true },
            { achievementHrid: '/achievements/b', isCompleted: false },
            { achievementHrid: '/achievements/c', isCompleted: true },
        ];

        const buffs = (await constructMilkonomyExport()).achievementBuffMap;

        expect(buffs.beginner).toEqual({ type: 'beginner', enabled: false });
        expect(buffs.novice).toEqual({ type: 'novice', enabled: true });
        expect(buffs.adept.enabled).toBe(false); // no achievements in the tier at all
    });

    test('every tier is listed, disabled, when there is nothing to go on', async () => {
        expect((await constructMilkonomyExport()).achievementBuffMap).toEqual({
            beginner: { type: 'beginner', enabled: false },
            novice: { type: 'novice', enabled: false },
            adept: { type: 'adept', enabled: false },
            veteran: { type: 'veteran', enabled: false },
            champion: { type: 'champion', enabled: false },
        });
    });

    test('an achievement the game data does not list is ignored rather than counted', async () => {
        game.clientData.achievementDetailMap = {
            '/achievements/a': { tierHrid: '/achievement_tiers/beginner' },
        };
        game.characterData.characterAchievements = [
            { achievementHrid: '/achievements/a', isCompleted: true },
            { achievementHrid: '/achievements/gone', isCompleted: true },
        ];

        expect((await constructMilkonomyExport()).achievementBuffMap.beginner.enabled).toBe(true);
    });
});

describe('exporting somebody else', () => {
    const stranger = {
        characterID: 'stranger',
        characterName: 'Cheesewright',
        profile: {
            characterSkills: [
                { skillHrid: '/skills/brewing', level: 77 },
                { skillHrid: '/skills/milking', level: 42 },
            ],
            wearableItemMap: {
                '/item_locations/brewing_tool': { itemHrid: '/items/brewing_pot', enhancementLevel: 7 },
                '/item_locations/legs': { itemHrid: '/items/brewers_bottoms', enhancementLevel: 2 },
                '/item_locations/body': { itemHrid: '/items/plate_body', enhancementLevel: 3 },
            },
            // Keyed by room hrid, the way the game sends it — the profile path
            // looks the room up by key rather than scanning the values
            characterHouseRoomMap: { '/house_rooms/brewery': { houseRoomHrid: '/house_rooms/brewery', level: 6 } },
            characterAchievements: [{ achievementHrid: '/achievements/a', isCompleted: true }],
        },
    };

    beforeEach(() => {
        // A shared profile carries only the skills the player has trained, so
        // the eight it lacks each log a miss on the way past
        vi.spyOn(console, 'error').mockImplementation(() => {});
        game.clientData = {
            itemDetailMap: {
                '/items/brewing_pot': equipmentDetail('/equipment_types/brewing_tool', { brewingSpeed: 0.1 }),
                '/items/brewers_bottoms': equipmentDetail('/equipment_types/legs', { brewingEfficiency: 0.05 }),
                '/items/plate_body': equipmentDetail('/equipment_types/body', { armor: 10 }),
            },
            achievementDetailMap: { '/achievements/a': { tierHrid: '/achievement_tiers/beginner' } },
        };
        game.profileList = [stranger];
    });

    test('their levels, gear and house come from the profile', async () => {
        const result = await constructMilkonomyExport('stranger');

        expect(result.name).toBe('Cheesewright');
        expect(result.actionConfigMap.brewing.playerLevel).toBe(77);
        expect(result.actionConfigMap.brewing.tool).toEqual({
            type: 'brewing_tool',
            hrid: '/items/brewing_pot',
            enhanceLevel: 7,
        });
        expect(result.actionConfigMap.brewing.legs).toEqual({
            type: 'legs',
            hrid: '/items/brewers_bottoms',
            enhanceLevel: 2,
        });
        expect(result.actionConfigMap.brewing.houseLevel).toBe(6);
        expect(result.achievementBuffMap.beginner.enabled).toBe(true);
    });

    test('gear that does nothing for the skill is not attributed to them', async () => {
        const result = await constructMilkonomyExport('stranger');

        expect(result.actionConfigMap.brewing.body).toEqual({ type: 'body' });
        expect(result.actionConfigMap.milking.legs).toEqual({ type: 'legs' });
    });

    test('a profile carries no scrolls and no teas, and ours are not lent to it', async () => {
        game.personalBuffs = { '/action_types/milking': [{ typeHrid: '/buff_types/efficiency' }] };
        game.drinkSlots = { '/action_types/brewing': [{ itemHrid: '/items/brewing_tea' }] };

        const result = await constructMilkonomyExport('stranger');

        expect(result.seals).toEqual([]);
        expect(result.actionConfigMap.brewing.tea).toEqual([]);
    });

    test('community buffs are the server’s, so they are ours as well', async () => {
        game.communityBuffs = { '/community_buff_types/experience': 12 };

        expect((await constructMilkonomyExport('stranger')).communityBuffMap.experience.level).toBe(12);
    });

    test('a profile that was never opened cannot be exported', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        game.profileList = [];

        expect(await constructMilkonomyExport('stranger')).toBeNull();
        expect(error).toHaveBeenCalled();
        error.mockRestore();
    });

    test('asking for your own id exports you, not a cached profile of you', async () => {
        game.profileList = [{ characterID: ME, characterName: 'Stale Copy', profile: {} }];

        expect((await constructMilkonomyExport(ME)).name).toBe('Milkbeard');
    });

    test('a failure anywhere in the shaping is caught and reported as nothing', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        game.characterData = {
            character: { id: ME, name: 'Milkbeard' },
            get characterSkills() {
                throw new Error('boom');
            },
        };

        expect(await constructMilkonomyExport()).toBeNull();
        expect(error).toHaveBeenCalledWith('[Milkonomy Export] Export construction failed:', expect.any(Error));
        error.mockRestore();
    });
});
