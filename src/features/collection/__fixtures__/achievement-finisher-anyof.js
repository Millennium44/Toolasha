/**
 * Rare-drop and "any of" shapes for the achievement finisher (levels, rates and names made up; hrid patterns
 * and field names as the game's): a Butter of Proficiency from two gathering and one production action, a
 * Branch of Insight with a tie and a duplicate drop entry, celestial tools / level 90 skilling outfits /
 * pouches / master charms made in several skills.
 */

const ach = (slug, name, description) => ({
    hrid: `/achievements/${slug}`,
    name,
    steamAchievementId: `ach_${slug}`,
    description,
    tierHrid: '/achievement_tiers/veteran',
    target: 1,
});

const rare = (itemHrid, dropRate) => ({ itemHrid, dropRate, minCount: 1, maxCount: 1 });

const gatherAct = (skill, slug, level, rareDropTable) => ({
    hrid: `/actions/${skill}/${slug}`,
    name: slug,
    type: `/action_types/${skill}`,
    levelRequirement: { skillHrid: `/skills/${skill}`, level },
    dropTable: [{ itemHrid: `/items/${slug}`, dropRate: 1, minCount: 1, maxCount: 1 }],
    rareDropTable,
});

const makeAct = (skill, slug, level, inputItems, out, rareDropTable) => ({
    hrid: `/actions/${skill}/${slug}`,
    name: slug,
    type: `/action_types/${skill}`,
    levelRequirement: { skillHrid: `/skills/${skill}`, level },
    inputItems,
    outputItems: [{ itemHrid: out, count: 1 }],
    rareDropTable,
});

const equipment = (name, type, skill, level) => ({
    name,
    equipmentDetail: { type, levelRequirements: [{ skillHrid: `/skills/${skill}`, level }] },
});

export const ANY_OF_DATA = {
    actionDetailMap: {
        '/actions/milking/holy_cow': gatherAct('milking', 'holy_milk', 80, [
            rare('/items/butter_of_proficiency', 0.00003),
        ]),
        '/actions/milking/unicow': gatherAct('milking', 'rainbow_milk', 65, [
            rare('/items/butter_of_proficiency', 0.00001),
        ]),
        '/actions/cheesesmithing/holy_cheese': makeAct(
            'cheesesmithing',
            'holy_cheese',
            80,
            [{ itemHrid: '/items/holy_milk', count: 2 }],
            '/items/holy_cheese',
            [rare('/items/butter_of_proficiency', 0.00003)]
        ),
        '/actions/woodcutting/tree_a': gatherAct('woodcutting', 'log_a', 50, [
            rare('/items/branch_of_insight', 0.0001),
            rare('/items/branch_of_insight', 0.0001),
        ]),
        '/actions/woodcutting/tree_b': gatherAct('woodcutting', 'log_b', 70, [
            rare('/items/branch_of_insight', 0.0002),
        ]),
        '/actions/crafting/branch_craft': makeAct(
            'crafting',
            'branch_craft',
            70,
            [{ itemHrid: '/items/log_b', count: 5 }],
            '/items/crate',
            [rare('/items/branch_of_insight', 0.0002)]
        ),
        '/actions/crafting/celestial_hammer': makeAct(
            'crafting',
            'celestial_hammer',
            90,
            [{ itemHrid: '/items/mooncrystal', count: 4 }],
            '/items/celestial_hammer'
        ),
        '/actions/cheesesmithing/celestial_pot': makeAct(
            'cheesesmithing',
            'celestial_pot',
            88,
            [{ itemHrid: '/items/mooncrystal', count: 2 }],
            '/items/celestial_pot'
        ),
        '/actions/tailoring/gatherers_top': makeAct(
            'tailoring',
            'gatherers_top',
            90,
            [{ itemHrid: '/items/silk', count: 6 }],
            '/items/gatherers_top'
        ),
        // A level 90 combat top and a level 60 skilling top: neither is a Celestial achievement piece
        '/actions/tailoring/sky_top': makeAct(
            'tailoring',
            'sky_top',
            90,
            [{ itemHrid: '/items/silk', count: 1 }],
            '/items/sky_top'
        ),
        '/actions/tailoring/plain_top': makeAct(
            'tailoring',
            'plain_top',
            60,
            [{ itemHrid: '/items/silk', count: 1 }],
            '/items/plain_top'
        ),
        '/actions/tailoring/gluttonous_pouch': makeAct(
            'tailoring',
            'gluttonous_pouch',
            60,
            [{ itemHrid: '/items/silk', count: 3 }],
            '/items/gluttonous_pouch'
        ),
        '/actions/tailoring/guzzling_pouch': makeAct(
            'tailoring',
            'guzzling_pouch',
            55,
            [{ itemHrid: '/items/silk', count: 3 }],
            '/items/guzzling_pouch'
        ),
        '/actions/crafting/master_foraging_charm': makeAct(
            'crafting',
            'master_foraging_charm',
            70,
            [{ itemHrid: '/items/charm_stone', count: 5 }],
            '/items/master_foraging_charm'
        ),
        '/actions/crafting/master_milking_charm': makeAct(
            'crafting',
            'master_milking_charm',
            75,
            [{ itemHrid: '/items/charm_stone', count: 5 }],
            '/items/master_milking_charm'
        ),
    },
    itemDetailMap: {
        '/items/butter_of_proficiency': { name: 'Butter of Proficiency' },
        '/items/branch_of_insight': { name: 'Branch of Insight' },
        '/items/celestial_hammer': equipment('Celestial Hammer', '/equipment_types/crafting_tool', 'crafting', 90),
        '/items/celestial_pot': equipment('Celestial Pot', '/equipment_types/cooking_tool', 'cooking', 88),
        '/items/gatherers_top': equipment("Gatherer's Top", '/equipment_types/body', 'foraging', 90),
        '/items/sky_top': equipment('Sky Top', '/equipment_types/body', 'defense', 90),
        '/items/plain_top': equipment('Plain Top', '/equipment_types/body', 'foraging', 60),
        '/items/crate': { name: 'Crate' },
        '/items/gluttonous_pouch': { name: 'Gluttonous Pouch' },
        '/items/guzzling_pouch': { name: 'Guzzling Pouch' },
        '/items/master_foraging_charm': { name: 'Master Foraging Charm' },
        '/items/master_milking_charm': { name: 'Master Milking Charm' },
    },
};

export const ANY_OF_ACHIEVEMENTS = {
    '/achievements/collect_butter_of_proficiency': ach(
        'collect_butter_of_proficiency',
        'Buttered Up',
        'Collect a Butter of Proficiency from Milking or Cheesesmithing'
    ),
    '/achievements/collect_branch_of_insight': ach(
        'collect_branch_of_insight',
        'Branching Out',
        'Collect a Branch of Insight from Woodcutting or Crafting'
    ),
    '/achievements/make_celestial': ach(
        'make_celestial',
        'Celestial Artisan',
        'Make any Celestial Tool or Level 90 Skilling Outfit Top or Bottoms'
    ),
    '/achievements/tailor_pouch': ach('tailor_pouch', 'Snack Pack Pro', 'Tailor a Gluttonous or Guzzling Pouch'),
    '/achievements/craft_master_charm': ach('craft_master_charm', 'Master Charmer', 'Craft any Master charm'),
};
