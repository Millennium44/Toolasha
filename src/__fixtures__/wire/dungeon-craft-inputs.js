/**
 * One dungeon, its chests, its token shop and two gear recipes, as the game sends them, for tests of
 * which recipe inputs the Craft & Enhance window counts as dungeon inputs.
 *
 * Source: `initClientData` read off the TEST server page (https://test.milkywayidle.com), 2026-11-13.
 * Every value below was read off the page; entries are trimmed to the fields the index reads, and the
 * action map holds only the Chimerical Den plus the non-combat actions that make something in its chests.
 *
 * Shapes worth knowing:
 *  - The dungeon's `rewardDropTable` holds only chests. The gear materials (griffin_leather,
 *    manticore_sting, ...) come out of `openableLootDropMap['/items/chimerical_chest']`.
 *  - The refinement chest's `dropRate` is negative at tier 0 and grows by `dropRatePerDifficultyTier`.
 *  - A chest can hold another chest (large_treasure_chest), and gear that a crafting action also
 *    makes (griffin_tunic, chimerical_chest_key), which is not a dungeon input.
 *  - Shop lines are `costs: [{ itemHrid, count }]` in `/shop_categories/dungeon`; the token count
 *    is a plain count of tokens per item.
 *  - Recipes carry an `upgradeItemHrid` (the base item) beside `inputItems`.
 *
 * To refresh after a game patch, on the test server run
 *   const g = Toolasha.Core.dataManager.getInitClientData();
 *   g.actionDetailMap['/actions/combat/chimerical_den'].combatZoneInfo.dungeonInfo.rewardDropTable;
 *   ['chimerical_chest','chimerical_refinement_chest','large_treasure_chest']
 *     .map(k => g.openableLootDropMap['/items/' + k]);
 *   Object.values(g.shopItemDetailMap).filter(l => JSON.stringify(l.costs).includes('chimerical_token'));
 * and paste the entries in.
 */

const drop = (itemHrid, dropRate, minCount, maxCount) => ({ itemHrid, dropRate, minCount, maxCount });
const shopLine = (name, count, sortIndex) => ({
    hrid: `/shop_items/${name}`,
    category: '/shop_categories/dungeon',
    itemHrid: `/items/${name}`,
    costs: [{ itemHrid: '/items/chimerical_token', count }],
    sortIndex,
});
const madeBy = (type, name) => ({
    hrid: `/actions/${type}/${name}`,
    type: `/action_types/${type}`,
    name,
    outputItems: [{ itemHrid: `/items/${name}`, count: 1 }],
});

/** The Griffin Tunic recipe, read off the page */
export const GRIFFIN_TUNIC_ACTION = {
    hrid: '/actions/tailoring/griffin_tunic',
    type: '/action_types/tailoring',
    name: 'Griffin Tunic',
    levelRequirement: { skillHrid: '/skills/tailoring', level: 90 },
    baseTimeCost: 60000000000,
    inputItems: [
        { itemHrid: '/items/griffin_leather', count: 10 },
        { itemHrid: '/items/holy_cheese', count: 400 },
    ],
    upgradeItemHrid: '/items/umbral_tunic',
    outputItems: [{ itemHrid: '/items/griffin_tunic', count: 1 }],
};

/** The Manticore Shield recipe, read off the page */
export const MANTICORE_SHIELD_ACTION = {
    hrid: '/actions/crafting/manticore_shield',
    type: '/action_types/crafting',
    name: 'Manticore Shield',
    levelRequirement: { skillHrid: '/skills/crafting', level: 83 },
    baseTimeCost: 60000000000,
    inputItems: [{ itemHrid: '/items/manticore_sting', count: 10 }],
    upgradeItemHrid: '/items/arcane_shield',
    outputItems: [{ itemHrid: '/items/manticore_shield', count: 1 }],
};

/** `initClientData`, trimmed to what the dungeon input index reads */
export const DUNGEON_CRAFT_GAME_DATA = {
    actionDetailMap: {
        '/actions/combat/chimerical_den': {
            hrid: '/actions/combat/chimerical_den',
            type: '/action_types/combat',
            name: 'Chimerical Den',
            combatZoneInfo: {
                isDungeon: true,
                dungeonInfo: {
                    keyItemHrid: '/items/chimerical_entry_key',
                    rewardDropTable: [
                        drop('/items/chimerical_chest', 1, 1, 1),
                        {
                            itemHrid: '/items/chimerical_refinement_chest',
                            dropRate: -0.3,
                            dropRatePerDifficultyTier: 0.6,
                            minCount: 1,
                            maxCount: 1,
                        },
                    ],
                },
            },
        },
        '/actions/cheesesmithing/dodocamel_gauntlets': madeBy('cheesesmithing', 'dodocamel_gauntlets'),
        '/actions/cheesesmithing/griffin_bulwark': madeBy('cheesesmithing', 'griffin_bulwark'),
        '/actions/crafting/chimerical_chest_key': madeBy('crafting', 'chimerical_chest_key'),
        '/actions/crafting/jackalope_staff': madeBy('crafting', 'jackalope_staff'),
        '/actions/crafting/manticore_shield': MANTICORE_SHIELD_ACTION,
        '/actions/tailoring/griffin_chaps': madeBy('tailoring', 'griffin_chaps'),
        '/actions/tailoring/griffin_tunic': GRIFFIN_TUNIC_ACTION,
    },
    openableLootDropMap: {
        '/items/chimerical_chest': [
            drop('/items/chimerical_essence', 1, 400, 800),
            drop('/items/chimerical_essence', 0.05, 2000, 4000),
            drop('/items/chimerical_token', 1, 250, 500),
            drop('/items/chimerical_token', 0.05, 1500, 3000),
            drop('/items/large_treasure_chest', 0.3, 1, 5),
            drop('/items/jade', 0.6, 5, 20),
            drop('/items/sunstone', 0.5, 1, 1),
            drop('/items/shield_bash', 0.5, 1, 2),
            drop('/items/crippling_slash', 0.5, 1, 2),
            drop('/items/pestilent_shot', 0.5, 1, 2),
            drop('/items/griffin_leather', 0.1, 1, 1),
            drop('/items/manticore_sting', 0.06, 1, 1),
            drop('/items/jackalope_antler', 0.05, 1, 1),
            drop('/items/dodocamel_plume', 0.02, 1, 1),
            drop('/items/griffin_talon', 0.02, 1, 1),
            drop('/items/chimerical_chest_key', 0.02, 1, 1),
            drop('/items/chimerical_quiver', 0.03, 1, 1),
            drop('/items/griffin_tunic', 0.003, 1, 1),
            drop('/items/griffin_chaps', 0.003, 1, 1),
            drop('/items/manticore_shield', 0.003, 1, 1),
            drop('/items/jackalope_staff', 0.002, 1, 1),
            drop('/items/dodocamel_gauntlets', 0.0015, 1, 1),
            drop('/items/griffin_bulwark', 0.0005, 1, 1),
        ],
        '/items/chimerical_refinement_chest': [
            drop('/items/chimerical_refinement_shard', 1, 1, 2),
            drop('/items/chimerical_refinement_shard', 0.05, 5, 10),
        ],
        '/items/large_treasure_chest': [
            drop('/items/coin', 1, 30000, 60000),
            drop('/items/coin', 0.1, 150000, 300000),
            drop('/items/cowbell', 0.1, 5, 10),
            drop('/items/cowbell', 0.01, 40, 80),
            drop('/items/pearl', 0.6, 1, 3),
            drop('/items/amber', 0.4, 1, 3),
            drop('/items/garnet', 0.4, 1, 3),
            drop('/items/jade', 0.4, 1, 3),
            drop('/items/amethyst', 0.4, 1, 3),
            drop('/items/moonstone', 0.4, 1, 2),
        ],
    },
    shopItemDetailMap: {
        '/shop_items/chimerical_essence': shopLine('chimerical_essence', 1, 36),
        '/shop_items/griffin_leather': shopLine('griffin_leather', 600, 37),
        '/shop_items/manticore_sting': shopLine('manticore_sting', 1000, 38),
        '/shop_items/jackalope_antler': shopLine('jackalope_antler', 1200, 39),
        '/shop_items/dodocamel_plume': shopLine('dodocamel_plume', 3000, 40),
        '/shop_items/griffin_talon': shopLine('griffin_talon', 3000, 41),
        '/shop_items/chimerical_quiver': shopLine('chimerical_quiver', 35000, 42),
    },
};
