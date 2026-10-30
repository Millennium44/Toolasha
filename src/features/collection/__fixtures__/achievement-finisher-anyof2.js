/**
 * More "any of" sets for the achievement finisher (azure tools, jewelry, dungeon equipment, refining), with
 * the steam ids the game uses, and the Shoebill case: an achievement naming a longer-named monster.
 */

const ach = (slug, name, description) => ({
    hrid: `/achievements/${slug}`,
    name,
    steamAchievementId: `ach_${slug}`,
    description,
    tierHrid: '/achievement_tiers/veteran',
    target: 1,
});

const makeAct = (skill, slug, level, inputItems, out, extra = {}) => ({
    hrid: `/actions/${skill}/${slug}`,
    name: slug,
    type: `/action_types/${skill}`,
    levelRequirement: { skillHrid: `/skills/${skill}`, level },
    inputItems,
    outputItems: [{ itemHrid: out, count: 1 }],
    ...extra,
});

const equipment = (name, type, skill, level) => ({
    name,
    equipmentDetail: { type, levelRequirements: [{ skillHrid: `/skills/${skill}`, level }] },
});

const zoneAct = (slug, extra) => ({
    hrid: `/actions/combat/${slug}`,
    name: slug,
    type: '/action_types/combat',
    levelRequirement: { skillHrid: '', level: 0 },
    maxDifficulty: 2,
    ...extra,
});

export const MORE_ANY_OF_ACHIEVEMENTS = {
    azure: ach('cheesesmith_azure_tool', 'Azure Smith', 'Cheesesmith any azure tool'),
    jewelry: ach('craft_jewelry', 'Jeweler', 'Craft any jewelry'),
    dungeon: ach('craft_dungeon_equipment', 'Assembler', 'Make any dungeon equipment from its components'),
    refine: ach('refine_dungeon_equipment', 'Refiner', 'Refine any dungeon or labyrinth equipment'),
};

export const MORE_ANY_OF_DATA = {
    actionDetailMap: {
        '/actions/cheesesmithing/azure_hatchet': makeAct(
            'cheesesmithing',
            'azure_hatchet',
            60,
            [{ itemHrid: '/items/azure_cheese', count: 4 }],
            '/items/azure_hatchet'
        ),
        '/actions/cheesesmithing/azure_pickaxe': makeAct(
            'cheesesmithing',
            'azure_pickaxe',
            62,
            [{ itemHrid: '/items/azure_cheese', count: 4 }],
            '/items/azure_pickaxe'
        ),
        // Not cheesesmithing, and not a tool: neither counts
        '/actions/crafting/azure_spatula': makeAct('crafting', 'azure_spatula', 10, [], '/items/azure_spatula'),
        '/actions/cheesesmithing/azure_plate': makeAct('cheesesmithing', 'azure_plate', 10, [], '/items/azure_plate'),
        '/actions/crafting/ruby_ring': makeAct(
            'crafting',
            'ruby_ring',
            30,
            [{ itemHrid: '/items/ruby', count: 2 }],
            '/items/ruby_ring'
        ),
        '/actions/crafting/pearl_necklace': makeAct(
            'crafting',
            'pearl_necklace',
            50,
            [{ itemHrid: '/items/pearl', count: 2 }],
            '/items/pearl_necklace'
        ),
        '/actions/combat/chimerical_den': zoneAct('chimerical_den', {
            combatZoneInfo: {
                isDungeon: true,
                fightInfo: { randomSpawnInfo: { spawns: [] }, bossSpawns: [] },
                dungeonInfo: { rewardDropTable: [{ itemHrid: '/items/chimerical_part', dropRate: 1 }] },
            },
        }),
        '/actions/crafting/chimerical_quiver': makeAct(
            'crafting',
            'chimerical_quiver',
            60,
            [{ itemHrid: '/items/chimerical_part', count: 3 }],
            '/items/chimerical_quiver'
        ),
        '/actions/crafting/plain_sword': makeAct(
            'crafting',
            'plain_sword',
            1,
            [{ itemHrid: '/items/iron', count: 3 }],
            '/items/plain_sword'
        ),
        '/actions/crafting/chimerical_quiver_refined': makeAct(
            'crafting',
            'chimerical_quiver_refined',
            80,
            [],
            '/items/chimerical_quiver_refined',
            { upgradeItemHrid: '/items/chimerical_quiver' }
        ),
    },
    itemDetailMap: {
        '/items/azure_hatchet': equipment('Azure Hatchet', '/equipment_types/woodcutting_tool', 'woodcutting', 60),
        '/items/azure_pickaxe': equipment('Azure Pickaxe', '/equipment_types/milking_tool', 'milking', 62),
        '/items/azure_spatula': equipment('Azure Spatula', '/equipment_types/cooking_tool', 'cooking', 10),
        '/items/azure_plate': equipment('Azure Plate', '/equipment_types/legs', 'defense', 10),
        '/items/ruby_ring': equipment('Ruby Ring', '/equipment_types/ring', 'crafting', 30),
        '/items/pearl_necklace': equipment('Pearl Necklace', '/equipment_types/neck', 'crafting', 50),
        '/items/chimerical_quiver': equipment('Chimerical Quiver', '/equipment_types/back', 'ranged', 60),
        '/items/chimerical_quiver_refined': equipment('Chimerical Quiver', '/equipment_types/back', 'ranged', 60),
        '/items/plain_sword': equipment('Plain Sword', '/equipment_types/main_hand', 'melee', 1),
    },
};

/** ach_defeat_shoebill names the animal; the monster is /monsters/giant_shoebill, a boss of its zone */
export const SHOEBILL = {
    achievement: ach('defeat_shoebill', 'Shoebill Slayer', 'Defeat Shoebill by yourself'),
    data: {
        actionDetailMap: {
            '/actions/combat/swamp_planet': zoneAct('swamp_planet', {
                sortIndex: 5,
                combatZoneInfo: {
                    isDungeon: false,
                    fightInfo: {
                        randomSpawnInfo: { spawns: [{ combatMonsterHrid: '/monsters/fly' }] },
                        bossSpawns: [{ combatMonsterHrid: '/monsters/giant_shoebill' }],
                    },
                },
            }),
        },
        itemDetailMap: {},
        combatMonsterDetailMap: {
            '/monsters/fly': { name: 'Fly', combatDetails: { combatLevel: 5 } },
            '/monsters/giant_shoebill': { name: 'Giant Shoebill', combatDetails: { combatLevel: 40 } },
        },
    },
};
