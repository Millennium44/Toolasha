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
    '/actions/milking/cow': {
        hrid: '/actions/milking/cow',
        name: 'Cow',
        type: '/action_types/milking',
        levelRequirement: { skillHrid: '/skills/milking', level: 1 },
        dropTable: [{ itemHrid: '/items/milk', dropRate: 1, minCount: 1, maxCount: 1 }],
    },
    // Live shapes (test server, 2026-10-28): no requirement is `{skillHrid: '', level: 0}`; the
    // monster named "Jerry" is /monsters/rat, in /actions/combat/rat and smelly_planet (max T5) and
    // the chimerical_den dungeon (max T2). Sort indexes here are made up.
    '/actions/combat/smelly_planet': zone('smelly_planet', 'Smelly Planet', 1, 5, ['/monsters/rat']),
    '/actions/combat/rat': zone('rat', 'Rat', 2, 5, ['/monsters/rat']),
    '/actions/combat/low_zone': zone('low_zone', 'Low Zone', 3, 2, ['/monsters/butterjerry']),
    '/actions/combat/jungle_planet': zone('jungle_planet', 'Jungle Planet', 4, 5, ['/monsters/butterjerry']),
    '/actions/combat/gobo_planet': zone('gobo_planet', 'Gobo Planet', 5, 5, ['/monsters/gobo_stabby'], {
        bosses: ['/monsters/gobo_chieftain'],
    }),
    '/actions/combat/bear_with_it': zone('bear_with_it', 'Bear With It', 6, 5, [], {
        bosses: ['/monsters/red_panda'],
    }),
    // A dungeon with Jerry in it and the lowest sort index: never the zone a solo kill opens
    '/actions/combat/chimerical_den': zone('chimerical_den', 'Chimerical Den', 0, 2, ['/monsters/rat'], {
        isDungeon: true,
    }),
    // A zone with a real requirement, to test that path
    '/actions/combat/gated_den': zone('gated_den', 'Gated Den', 9, 0, [], {
        isDungeon: true,
        levelRequirement: { skillHrid: '/skills/combat', level: 90 },
    }),
};

function zone(slug, name, sortIndex, maxDifficulty, spawns, { bosses = [], isDungeon = false, levelRequirement } = {}) {
    return {
        hrid: `/actions/combat/${slug}`,
        name,
        type: '/action_types/combat',
        sortIndex,
        maxDifficulty,
        levelRequirement: levelRequirement || { skillHrid: '', level: 0 },
        combatZoneInfo: {
            isDungeon,
            fightInfo: {
                randomSpawnInfo: { spawns: spawns.map((combatMonsterHrid) => ({ combatMonsterHrid })) },
                bossSpawns: bosses.map((combatMonsterHrid) => ({ combatMonsterHrid })),
            },
        },
    };
}

const weapon = (name, type, level = 20) => ({
    name,
    itemLevel: level,
    equipmentDetail: { type, levelRequirements: [{ skillHrid: '/skills/ranged', level }] },
});

export const ITEMS = {
    '/items/peach_yogurt': { name: 'Peach Yogurt', itemLevel: 40 },
    '/items/milk': { name: 'Milk', isTradable: true },
    '/items/peach': { name: 'Peach', isTradable: true },
    '/items/spaceberry_cake': { name: 'Spaceberry Cake' },
    '/items/spaceberry': { name: 'Spaceberry', isTradable: true },
    '/items/mystery_sugar': { name: 'Mystery Sugar', isTradable: true },
    '/items/umbral_tunic': { name: 'Umbral Tunic' },
    '/items/umbral_leather': { name: 'Umbral Leather', isTradable: true },
    '/items/sighted_tunic': { name: 'Sighted Tunic' },
    '/items/arcane_log': { name: 'Arcane Log', isTradable: true },
    '/items/coin': { name: 'Coin' },
    '/items/bamboo_gloves': {
        name: 'Bamboo Gloves',
        isTradable: true,
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
    // Live: the monster named "Jerry" has the hrid /monsters/rat; Butterjerry is a different monster
    '/monsters/rat': { name: 'Jerry', combatDetails: { combatLevel: 60 } },
    '/monsters/butterjerry': { name: 'Butterjerry', combatDetails: { combatLevel: 70 } },
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

/** Further live verbs: gather and clear resolve; refine and the category ids do not */
export const MORE_ACHIEVEMENTS = {
    '/achievements/gather_milk': ach('gather_milk', 'Milkmaid', 'ach_gather_milk', 'Gather Milk'),
    '/achievements/defeat_jerry': ach('defeat_jerry', 'Rat Catcher', 'ach_defeat_jerry', 'Defeat Jerry by yourself'),
    '/achievements/clear_chimerical_den': ach(
        'clear_chimerical_den',
        'Den Delver',
        'ach_clear_chimerical_den',
        'Clear Chimerical Den'
    ),
    '/achievements/clear_gated_den': ach('clear_gated_den', 'Gated', 'ach_clear_gated_den', 'Clear Gated Den'),
    '/achievements/clear_t1_dungeon_10_times': ach(
        'clear_t1_dungeon_10_times',
        'Regular',
        'ach_clear_t1_dungeon_10_times',
        'Clear any T1 dungeon 10 times'
    ),
    '/achievements/refine_something': ach('refine_something', 'Refiner', 'ach_refine_something', 'Refine an item'),
    '/achievements/cheesesmith_azure_tool': ach(
        'cheesesmith_azure_tool',
        'Azure Smith',
        'ach_cheesesmith_azure_tool',
        'Make any Azure tool with Cheesesmithing'
    ),
    '/achievements/craft_celestial_tool_or_outfit': ach(
        'craft_celestial_tool_or_outfit',
        'Celestial',
        'ach_craft_celestial_tool_or_outfit',
        'Make any Celestial tool or outfit with Crafting'
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
