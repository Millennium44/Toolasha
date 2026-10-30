/**
 * Place-to-go achievements in the game's shapes: `achievementDetailMap` entries with their steam ids and
 * `target`, dungeon zones (`combatZoneInfo.isDungeon`, `maxDifficulty`, the `{skillHrid: '', level: 0}`
 * no-requirement form), and `shopItemDetailMap` entries (`itemHrid`, `costs`).
 */

const ach = (slug, name, target, description = '') => ({
    hrid: `/achievements/${slug}`,
    name,
    description,
    tierHrid: '/achievement_tiers/veteran',
    sortIndex: 1,
    steamAchievementId: `ach_${slug}`,
    target,
});

export const PLACE_ACHIEVEMENTS = {
    '/achievements/build_room_level_3': ach('build_room_level_3', 'Homeowner II', 1, 'Build any room to level 3'),
    '/achievements/labyrinth_floor_4': ach('labyrinth_floor_4', 'Labyrinth Explorer II', 1, 'Reach floor 4'),
    '/achievements/clear_t1_dungeon_10_times': ach(
        'clear_t1_dungeon_10_times',
        'Dungeon Elitist',
        10,
        'Clear any T1 dungeon 10 times'
    ),
    '/achievements/buy_trainee_charm': ach('buy_trainee_charm', 'Charmed', 1, 'Buy a trainee charm'),
    '/achievements/coinify_coins_1m': ach('coinify_coins_1m', 'Midas Touch', 1000000, 'Coinify 1M coins'),
};

const dungeon = (slug, sortIndex, extra = {}) => ({
    hrid: `/actions/combat/${slug}`,
    name: slug,
    type: '/action_types/combat',
    levelRequirement: { skillHrid: '', level: 0 },
    maxDifficulty: 2,
    sortIndex,
    combatZoneInfo: { isDungeon: true },
    ...extra,
});

export const PLACE_ACTIONS = {
    // A dungeon only offered at T0 cannot hold a T1 clear
    '/actions/combat/practice_den': dungeon('practice_den', 0, { maxDifficulty: 0 }),
    '/actions/combat/sinister_circus': dungeon('sinister_circus', 2, {
        levelRequirement: { skillHrid: '/skills/combat', level: 90 },
    }),
    '/actions/combat/chimerical_den': dungeon('chimerical_den', 1, {
        levelRequirement: { skillHrid: '/skills/combat', level: 80 },
    }),
    // An ordinary zone, never a dungeon
    '/actions/combat/rat': {
        hrid: '/actions/combat/rat',
        type: '/action_types/combat',
        maxDifficulty: 5,
        sortIndex: 0,
        combatZoneInfo: { isDungeon: false },
    },
};

const shopItem = (slug, costs) => ({
    hrid: `/shop_items/test/${slug}`,
    itemHrid: `/items/${slug}`,
    costs,
});

export const PLACE_SHOP = {
    '/shop_items/test/trainee_alchemy_charm': shopItem('trainee_alchemy_charm', [
        { itemHrid: '/items/coin', count: 250000 },
    ]),
    '/shop_items/test/trainee_milking_charm': shopItem('trainee_milking_charm', [
        { itemHrid: '/items/coin', count: 200000 },
    ]),
    // Paid in something else: not a coin price
    '/shop_items/test/trainee_cooking_charm': shopItem('trainee_cooking_charm', [
        { itemHrid: '/items/task_token', count: 5 },
    ]),
    '/shop_items/test/master_alchemy_charm': shopItem('master_alchemy_charm', [
        { itemHrid: '/items/coin', count: 1000 },
    ]),
};

export const PLACE_ITEMS = {
    '/items/trainee_alchemy_charm': { name: 'Trainee Alchemy Charm' },
    '/items/trainee_milking_charm': { name: 'Trainee Milking Charm' },
    '/items/trainee_cooking_charm': { name: 'Trainee Cooking Charm' },
    '/items/master_alchemy_charm': { name: 'Master Alchemy Charm' },
};

export const PLACE_DATA = {
    actionDetailMap: PLACE_ACTIONS,
    itemDetailMap: PLACE_ITEMS,
    shopItemDetailMap: PLACE_SHOP,
};
