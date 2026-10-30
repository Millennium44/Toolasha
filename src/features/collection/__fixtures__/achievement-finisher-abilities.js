/**
 * Ability-learning achievements in the game's shapes: ability books (`categoryHrid`
 * `/item_categories/ability_book`, `abilityBookDetail {abilityHrid, levelRequirements, experienceGain}`)
 * and `abilityDetailMap` entries with `isSpecialAbility`. Promote is special and has no book.
 */

const ach = (slug, name) => ({
    hrid: `/achievements/${slug}`,
    name,
    description: '',
    tierHrid: '/achievement_tiers/novice',
    sortIndex: 1,
    steamAchievementId: `ach_${slug}`,
    target: 1,
});

export const ABILITY_ACHIEVEMENTS = {
    '/achievements/learn_ability': ach('learn_ability', 'Student'),
    '/achievements/learn_special_ability': ach('learn_special_ability', 'Gifted'),
};

const book = (slug, name, skill, level) => ({
    hrid: `/items/${slug}`,
    name,
    categoryHrid: '/item_categories/ability_book',
    isTradable: true,
    itemLevel: level,
    abilityBookDetail: {
        abilityHrid: `/abilities/${slug}`,
        levelRequirements: skill ? [{ skillHrid: `/skills/${skill}`, level }] : [],
        experienceGain: 500,
    },
});

export const ABILITY_ITEMS = {
    '/items/poke': book('poke', 'Poke', 'melee', 1),
    '/items/scratch': book('scratch', 'Scratch', 'melee', 5),
    '/items/fireball': book('fireball', 'Fireball', 'magic', 30),
    '/items/mystic_aura': book('mystic_aura', 'Mystic Aura', 'magic', 60),
    '/items/speed_aura': book('speed_aura', 'Speed Aura', 'ranged', 50),
    '/items/revive': book('revive', 'Revive', null, 1),
    // Not a book, though it names an ability-like hrid
    '/items/poke_charm': { name: 'Poke Charm', categoryHrid: '/item_categories/equipment' },
};

export const ABILITY_DETAILS = {
    '/abilities/poke': { name: 'Poke', isSpecialAbility: false },
    '/abilities/scratch': { name: 'Scratch', isSpecialAbility: false },
    '/abilities/fireball': { name: 'Fireball', isSpecialAbility: false },
    '/abilities/mystic_aura': { name: 'Mystic Aura', isSpecialAbility: true },
    '/abilities/speed_aura': { name: 'Speed Aura', isSpecialAbility: true },
    '/abilities/revive': { name: 'Revive', isSpecialAbility: true },
    // Monster-only: no book exists
    '/abilities/promote': { name: 'Promote', isSpecialAbility: true },
};

export const ABILITY_DATA = { itemDetailMap: ABILITY_ITEMS, abilityDetailMap: ABILITY_DETAILS };
