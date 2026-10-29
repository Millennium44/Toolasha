/**
 * Game data in the shapes `init_client_data` uses, cut down to what the
 * achievement finisher resolves against. Hrids follow the game's naming
 * (`/actions/<skill>/<slug>`, `/items/<slug>`, `/monsters/<slug>`,
 * `/action_types/<skill>`, `/equipment_types/<slot>`); numbers are made up.
 */

export const ACTIONS = {
    '/actions/cooking/peach_yogurt': {
        hrid: '/actions/cooking/peach_yogurt',
        name: 'Peach Yogurt',
        type: '/action_types/cooking',
        levelRequirement: { skillHrid: '/skills/cooking', level: 40 },
        inputItems: [
            { itemHrid: '/items/milk', count: 3 },
            { itemHrid: '/items/peach', count: 3 },
        ],
        outputItems: [{ itemHrid: '/items/peach_yogurt', count: 1 }],
    },
    // Same output slug in another skill: must not be picked for a cooking verb
    '/actions/brewing/peach_yogurt': {
        hrid: '/actions/brewing/peach_yogurt',
        name: 'Peach Yogurt',
        type: '/action_types/brewing',
        levelRequirement: { skillHrid: '/skills/brewing', level: 1 },
        inputItems: [],
        outputItems: [{ itemHrid: '/items/peach_yogurt', count: 1 }],
    },
    '/actions/cooking/spaceberry_cake': {
        hrid: '/actions/cooking/spaceberry_cake',
        name: 'Spaceberry Cake',
        type: '/action_types/cooking',
        levelRequirement: { skillHrid: '/skills/cooking', level: 70 },
        inputItems: [
            { itemHrid: '/items/spaceberry', count: 4 },
            { itemHrid: '/items/mystery_sugar', count: 2 },
        ],
        outputItems: [{ itemHrid: '/items/spaceberry_cake', count: 1 }],
    },
    '/actions/tailoring/umbral_tunic': {
        hrid: '/actions/tailoring/umbral_tunic',
        name: 'Umbral Tunic',
        type: '/action_types/tailoring',
        levelRequirement: { skillHrid: '/skills/tailoring', level: 90 },
        inputItems: [{ itemHrid: '/items/umbral_leather', count: 8 }],
        upgradeItemHrid: '/items/sighted_tunic',
        outputItems: [{ itemHrid: '/items/umbral_tunic', count: 1 }],
    },
    '/actions/woodcutting/arcane_tree': {
        hrid: '/actions/woodcutting/arcane_tree',
        name: 'Arcane Tree',
        type: '/action_types/woodcutting',
        levelRequirement: { skillHrid: '/skills/woodcutting', level: 60 },
        dropTable: [{ itemHrid: '/items/arcane_log', dropRate: 1, minCount: 1, maxCount: 1 }],
    },
    '/actions/alchemy/decompose': {
        hrid: '/actions/alchemy/decompose',
        type: '/action_types/alchemy',
        levelRequirement: { skillHrid: '/skills/alchemy', level: 1 },
    },
    '/actions/alchemy/transmute': {
        hrid: '/actions/alchemy/transmute',
        type: '/action_types/alchemy',
        levelRequirement: { skillHrid: '/skills/alchemy', level: 1 },
    },
    '/actions/combat/low_zone': {
        hrid: '/actions/combat/low_zone',
        name: 'Low Zone',
        type: '/action_types/combat',
        sortIndex: 1,
        maxDifficulty: 2,
        combatZoneInfo: {
            isDungeon: false,
            fightInfo: { randomSpawnInfo: { spawns: [{ combatMonsterHrid: '/monsters/jerry' }] }, bossSpawns: [] },
        },
    },
    '/actions/combat/jungle_planet': {
        hrid: '/actions/combat/jungle_planet',
        name: 'Jungle Planet',
        type: '/action_types/combat',
        sortIndex: 4,
        maxDifficulty: 5,
        combatZoneInfo: {
            isDungeon: false,
            fightInfo: {
                randomSpawnInfo: { spawns: [{ combatMonsterHrid: '/monsters/jerry' }] },
                bossSpawns: [{ combatMonsterHrid: '/monsters/red_panda' }],
            },
        },
    },
    '/actions/combat/gobo_planet': {
        hrid: '/actions/combat/gobo_planet',
        name: 'Gobo Planet',
        type: '/action_types/combat',
        sortIndex: 5,
        maxDifficulty: 5,
        combatZoneInfo: {
            isDungeon: false,
            fightInfo: {
                randomSpawnInfo: { spawns: [{ combatMonsterHrid: '/monsters/gobo_stabby' }] },
                bossSpawns: [{ combatMonsterHrid: '/monsters/gobo_chieftain' }],
            },
        },
    },
    // A dungeon with Jerry in it and the lowest sort index: never the zone a solo kill opens
    '/actions/combat/jerry_dungeon': {
        hrid: '/actions/combat/jerry_dungeon',
        name: 'Jerry Dungeon',
        type: '/action_types/combat',
        sortIndex: 0,
        maxDifficulty: 5,
        combatZoneInfo: {
            isDungeon: true,
            fightInfo: { randomSpawnInfo: { spawns: [{ combatMonsterHrid: '/monsters/jerry' }] }, bossSpawns: [] },
        },
    },
};

const weapon = (name, type, level = 20) => ({
    name,
    itemLevel: level,
    equipmentDetail: { type, levelRequirements: [{ skillHrid: '/skills/ranged', level }] },
});

export const ITEMS = {
    '/items/peach_yogurt': { name: 'Peach Yogurt', itemLevel: 40 },
    '/items/milk': { name: 'Milk' },
    '/items/peach': { name: 'Peach' },
    '/items/spaceberry_cake': { name: 'Spaceberry Cake' },
    '/items/spaceberry': { name: 'Spaceberry' },
    '/items/mystery_sugar': { name: 'Mystery Sugar' },
    '/items/umbral_tunic': { name: 'Umbral Tunic' },
    '/items/umbral_leather': { name: 'Umbral Leather' },
    '/items/sighted_tunic': { name: 'Sighted Tunic' },
    '/items/arcane_log': { name: 'Arcane Log' },
    '/items/coin': { name: 'Coin' },
    '/items/bamboo_gloves': {
        name: 'Bamboo Gloves',
        itemLevel: 10,
        sellPrice: 40,
        alchemyDetail: { bulkMultiplier: 1, decomposeItems: [{ itemHrid: '/items/bamboo_branch', count: 2 }] },
        equipmentDetail: { type: '/equipment_types/hands', levelRequirements: [] },
    },
    '/items/star_fragment': {
        name: 'Star Fragment',
        itemLevel: 50,
        sellPrice: 500,
        alchemyDetail: {
            bulkMultiplier: 10,
            transmuteDropTable: [{ itemHrid: '/items/blue_key_fragment', dropRate: 1 }],
        },
    },
    '/items/ginkgo_bow': weapon('Ginkgo Bow', '/equipment_types/two_hand'),
    '/items/ginkgo_crossbow': weapon('Ginkgo Crossbow', '/equipment_types/two_hand'),
    '/items/ginkgo_nature_staff': weapon('Ginkgo Nature Staff', '/equipment_types/two_hand', 25),
    // Not a weapon, and the cheapest: must never be offered
    '/items/ginkgo_shield': weapon('Ginkgo Shield', '/equipment_types/off_hand'),
};

export const MONSTERS = {
    '/monsters/jerry': { name: 'Jerry', combatDetails: { combatLevel: 60 } },
    '/monsters/red_panda': { name: 'Red Panda', combatDetails: { combatLevel: 55 } },
    '/monsters/gobo_chieftain': { name: 'Gobo Chieftain', combatDetails: { combatLevel: 45 } },
    '/monsters/gobo_stabby': { name: 'Gobo Stabby', combatDetails: { combatLevel: 30 } },
};

const ach = (slug, name, steamAchievementId, description, tierHrid = '/achievement_tiers/veteran') => ({
    hrid: `/achievements/${slug}`,
    name,
    steamAchievementId,
    description,
    tierHrid,
    target: 1,
});

/** The nine one-off achievements the maintainer listed, plus one this cannot resolve */
export const ACHIEVEMENTS = {
    '/achievements/cook_peach_yogurt': ach(
        'cook_peach_yogurt',
        'Dairy Chef',
        'ach_cook_peach_yogurt',
        'Make a Peach Yogurt with Cooking'
    ),
    '/achievements/decompose_bamboo_gloves': ach(
        'decompose_bamboo_gloves',
        'Recycler',
        'ach_decompose_bamboo_gloves',
        'Decompose a Bamboo Gloves'
    ),
    '/achievements/defeat_gobo_chieftain': ach(
        'defeat_gobo_chieftain',
        'Chief Slayer',
        'ach_defeat_gobo_chieftain',
        'Defeat Gobo Chieftain by yourself'
    ),
    '/achievements/equip_ginkgo_weapon': ach(
        'equip_ginkgo_weapon',
        'Ginkgo Wielder',
        'ach_equip_ginkgo_weapon',
        'Equip any Ginkgo weapon (staff, bow, or crossbow)'
    ),
    '/achievements/cook_spaceberry_cake': ach(
        'cook_spaceberry_cake',
        'Space Baker',
        'ach_cook_spaceberry_cake',
        'Make a Spaceberry Cake with Cooking'
    ),
    '/achievements/defeat_jerry_t5': ach(
        'defeat_jerry_t5',
        'Jerry Hunter',
        'ach_defeat_jerry_t5',
        'Defeat T5 Jerry by yourself'
    ),
    '/achievements/defeat_red_panda': ach(
        'defeat_red_panda',
        'Panda Tamer',
        'ach_defeat_red_panda',
        'Defeat Red Panda by yourself'
    ),
    '/achievements/tailor_umbral_tunic': ach(
        'tailor_umbral_tunic',
        'Shadow Tailor',
        'ach_tailor_umbral_tunic',
        'Make an Umbral Tunic with Tailoring'
    ),
    '/achievements/woodcut_arcane_tree': ach(
        'woodcut_arcane_tree',
        'Arcane Lumberjack',
        'ach_woodcut_arcane_tree',
        'Chop an Arcane Tree'
    ),
    '/achievements/enhance_something': ach(
        'enhance_something',
        'Mystery',
        'ach_enhance_something_plus_10',
        'Enhance something to +10'
    ),
};

export const SKILLS = [
    { skillHrid: '/skills/cooking', level: 45 },
    { skillHrid: '/skills/brewing', level: 1 },
    { skillHrid: '/skills/tailoring', level: 50 },
    { skillHrid: '/skills/woodcutting', level: 60 },
    { skillHrid: '/skills/alchemy', level: 20 },
    { skillHrid: '/skills/ranged', level: 30 },
    { skillHrid: '/skills/stamina', level: 50 },
    { skillHrid: '/skills/intelligence', level: 50 },
    { skillHrid: '/skills/attack', level: 50 },
    { skillHrid: '/skills/defense', level: 50 },
    { skillHrid: '/skills/melee', level: 50 },
    { skillHrid: '/skills/magic', level: 1 },
];

const inv = (itemHrid, count, extra = {}) => ({
    itemHrid,
    count,
    itemLocationHrid: '/item_locations/inventory',
    enhancementLevel: 0,
    ...extra,
});

/**
 * Milk in three +0 stacks (enough), one Peach of three, plus a +1 milk and an equipped
 * gloves pair that must not count as stock.
 */
export const INVENTORY = [
    inv('/items/milk', 1),
    inv('/items/milk', 1, { hash: 'x' }),
    inv('/items/milk', 1, { hash: 'y' }),
    inv('/items/milk', 5, { enhancementLevel: 1 }),
    inv('/items/peach', 1),
    inv('/items/bamboo_gloves', 1, { hash: '7::/item_locations/inventory::/items/bamboo_gloves::0' }),
    inv('/items/bamboo_gloves', 1, { itemLocationHrid: '/item_locations/hands' }),
    inv('/items/coin', 10_000),
    inv('/items/spaceberry', 4),
];

/** Buy prices; anything absent is unpriced */
export const PRICES = {
    '/items/milk': 20,
    '/items/peach': 100,
    '/items/spaceberry': 50,
    '/items/umbral_leather': 1000,
    '/items/sighted_tunic': 5000,
    '/items/ginkgo_bow': 900,
    '/items/ginkgo_crossbow': 700,
    '/items/ginkgo_nature_staff': 1200,
    '/items/ginkgo_shield': 10,
    '/items/star_fragment': 30,
};

export const DATA = { actionDetailMap: ACTIONS, itemDetailMap: ITEMS, combatMonsterDetailMap: MONSTERS };
