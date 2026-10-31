/**
 * Enhancer achievements in the game's shapes: steam ids `ach_enhance_to_N` and
 * `ach_enhance_level_L_to_N`; equipment with `itemLevel` (the recommended level), `isTradable`,
 * `equipmentDetail`, `enhancementCosts` and `protectionItemHrids`. Listing prices are keyed per
 * enhancement level, with gaps where nobody lists that level.
 */

const ach = (slug, name) => ({
    hrid: `/achievements/${slug}`,
    name,
    description: '',
    tierHrid: '/achievement_tiers/adept',
    sortIndex: 1,
    steamAchievementId: `ach_${slug}`,
    target: 1,
});

export const ENHANCE_ACHIEVEMENTS = {
    '/achievements/enhance_to_3': ach('enhance_to_3', 'Enhancer I'),
    '/achievements/enhance_to_10': ach('enhance_to_10', 'Enhancer III'),
    '/achievements/enhance_level_80_to_10': ach('enhance_level_80_to_10', 'Enhancer IV'),
};

const gear = (name, itemLevel, extra = {}) => ({
    name,
    itemLevel,
    isTradable: true,
    equipmentDetail: {
        type: '/equipment_types/hands',
        levelRequirements: [{ skillHrid: '/skills/defense', level: itemLevel }],
    },
    enhancementCosts: [
        { itemHrid: '/items/coin', count: 10 },
        { itemHrid: '/items/enhancing_essence', count: 2 },
    ],
    protectionItemHrids: ['/items/cheese'],
    ...extra,
});

export const ENHANCE_ITEMS = {
    '/items/cheese_gloves': gear('Cheese Gloves', 1),
    '/items/magnetic_gloves': gear('Magnetic Gloves', 85),
    '/items/chrono_gloves': gear('Chrono Gloves', 90),
    // Just under the recommended-level threshold of Enhancer IV
    '/items/marsh_gloves': gear('Marsh Gloves', 79),
    // Not tradable: nobody can sell it
    '/items/bound_cape': gear('Bound Cape', 95, { isTradable: undefined }),
    // Equipment that cannot be enhanced
    '/items/plain_ring': gear('Plain Ring', 95, { enhancementCosts: [] }),
    // Enhanceable but not equipment
    '/items/strange_rock': {
        name: 'Strange Rock',
        itemLevel: 95,
        isTradable: true,
        enhancementCosts: [{ itemHrid: '/items/coin', count: 1 }],
    },
    '/items/cheese': { name: 'Cheese', isTradable: true },
    '/items/mirror_of_protection': { name: 'Mirror of Protection', isTradable: true },
    '/items/enhancing_essence': { name: 'Enhancing Essence', isTradable: true },
};

export const ENHANCE_DATA = { itemDetailMap: ENHANCE_ITEMS };

/** A bench of Enhancing 100 with nothing else (getAutoDetectedParams' shape) */
export const BENCH = {
    enhancingLevel: 100,
    toolBonus: 0,
    speedBonus: 0,
    teas: { blessed: false },
    guzzlingBonus: 1,
    blessedTeaBonus: 0.01,
};

/** A craft action in the game shape: levelRequirement, inputItems, outputItems, upgradeItemHrid */
const craft = (type, level, inputs, output, extra = {}) => ({
    type: `/action_types/${type}`,
    levelRequirement: { skillHrid: `/skills/${type}`, level },
    inputItems: inputs.map(([itemHrid, count]) => ({ itemHrid, count })),
    outputItems: [{ itemHrid: output, count: 1 }],
    ...extra,
});

/** Ways to craft the gloves above (and one non-qualifying output), for a character that cannot buy */
export const ENHANCE_CRAFT_DATA = {
    itemDetailMap: ENHANCE_ITEMS,
    skillDetailMap: { '/skills/crafting': { name: 'Crafting' }, '/skills/cheesesmithing': { name: 'Cheesesmithing' } },
    actionDetailMap: {
        '/actions/crafting/cheese_gloves': craft('crafting', 1, [['/items/cheese', 4]], '/items/cheese_gloves'),
        '/actions/cheesesmithing/magnetic_gloves': craft(
            'cheesesmithing',
            85,
            [
                ['/items/cheese', 10],
                ['/items/enhancing_essence', 5],
            ],
            '/items/magnetic_gloves'
        ),
        '/actions/cheesesmithing/chrono_gloves': craft(
            'cheesesmithing',
            90,
            [['/items/cheese', 20]],
            '/items/chrono_gloves',
            { upgradeItemHrid: '/items/magnetic_gloves' }
        ),
        '/actions/crafting/marsh_gloves': craft('crafting', 79, [['/items/cheese', 1]], '/items/marsh_gloves'),
        '/actions/crafting/plain_ring': craft('crafting', 1, [], '/items/plain_ring'),
    },
};
