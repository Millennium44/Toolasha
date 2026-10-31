/**
 * Ready-made teammate builds the Party tab offers beside the player's saved builds. They ship with the script, are
 * read-only and are never written to the roster record; adding one copies it into the roster as an ordinary teammate.
 * They carry no game mode: like every teammate they are taken to be of the searching character's own mode.
 *
 * The builds are standard endgame setups: items, consumables, abilities, triggers, house rooms and guild shrine levels
 * as recorded, with levels standardized so the styles compare fairly (main stat 150, other stats 125, abilities 75,
 * gear +12 weapon, +10 armor and off hand, +7 jewelry, +5 neck/charm/pouch/cape/trinket). Every item and ability hrid
 * was checked against live game data on 2026-10-29.
 */

function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
}

/** Role groups in display order; `roles` are the template roles each group holds. */
export const TEMPLATE_ROLE_GROUPS = deepFreeze([
    { id: 'ranger', label: 'Ranger', roles: ['ranged'] },
    { id: 'nature', label: 'Nature', roles: ['nature_mage'] },
    { id: 'fire', label: 'Fire', roles: ['fire_mage'] },
    { id: 'water', label: 'Water', roles: ['water_mage'] },
    { id: 'tank', label: 'Tank', roles: ['tank'] },
    { id: 'melee', label: 'Melee', roles: ['melee_stab', 'melee_slash', 'melee_smash'] },
]);

/** @type {ReadonlyArray<{id: string, role: string, label: string, playerDto: Object}>} */
export const PARTY_TEMPLATES = deepFreeze([
    // melee-smash
    {
        id: 'melee-smash',
        role: 'melee_smash',
        label: 'Melee smash (flail)',
        guildCombatBuffLevels: { force: 5, tempo: 5, spirit: 1, rarity: 0, scholar: 3 },
        playerDto: {
            staminaLevel: 125,
            intelligenceLevel: 125,
            attackLevel: 125,
            meleeLevel: 150,
            defenseLevel: 125,
            rangedLevel: 125,
            magicLevel: 125,
            equipment: {
                '/equipment_types/back': { hrid: '/items/sinister_cape', enhancementLevel: 5 },
                '/equipment_types/body': { hrid: '/items/maelstrom_plate_body_refined', enhancementLevel: 10 },
                '/equipment_types/charm': { hrid: '/items/master_melee_charm', enhancementLevel: 5 },
                '/equipment_types/earrings': { hrid: '/items/earrings_of_critical_strike', enhancementLevel: 7 },
                '/equipment_types/feet': { hrid: '/items/pathbreaker_boots_refined', enhancementLevel: 10 },
                '/equipment_types/hands': { hrid: '/items/magnetic_gloves', enhancementLevel: 10 },
                '/equipment_types/head': { hrid: '/items/corsair_helmet_refined', enhancementLevel: 10 },
                '/equipment_types/legs': { hrid: '/items/maelstrom_plate_legs_refined', enhancementLevel: 10 },
                '/equipment_types/main_hand': { hrid: '/items/chaotic_flail_refined', enhancementLevel: 12 },
                '/equipment_types/neck': { hrid: '/items/necklace_of_speed', enhancementLevel: 5 },
                '/equipment_types/off_hand': { hrid: '/items/knights_aegis_refined', enhancementLevel: 10 },
                '/equipment_types/pouch': { hrid: '/items/guzzling_pouch', enhancementLevel: 5 },
                '/equipment_types/ring': { hrid: '/items/ring_of_critical_strike', enhancementLevel: 7 },
                '/equipment_types/trinket': { hrid: '/items/expert_task_badge', enhancementLevel: 5 },
            },
            food: [
                {
                    hrid: '/items/peach_gummy',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/missing_mp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 200,
                        },
                    ],
                },
                {
                    hrid: '/items/peach_yogurt',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/missing_mp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 250,
                        },
                    ],
                },
                {
                    hrid: '/items/spaceberry_cake',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/missing_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 350,
                        },
                    ],
                },
            ],
            drinks: [
                { hrid: '/items/lucky_coffee', triggers: null },
                { hrid: '/items/swiftness_coffee', triggers: null },
                { hrid: '/items/ultra_melee_coffee', triggers: null },
            ],
            abilities: [
                { hrid: '/abilities/fierce_aura', level: 75, triggers: null },
                { hrid: '/abilities/frenzy', level: 75, triggers: null },
                { hrid: '/abilities/berserk', level: 75, triggers: null },
                {
                    hrid: '/abilities/fracturing_impact',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/number_of_dead_units',
                            comparatorHrid: '/combat_trigger_comparators/less_than_equal',
                            value: 2,
                        },
                    ],
                },
                {
                    hrid: '/abilities/sweep',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/number_of_dead_units',
                            comparatorHrid: '/combat_trigger_comparators/less_than_equal',
                            value: 2,
                        },
                    ],
                },
            ],
            houseRooms: {
                '/house_rooms/archery_range': 2,
                '/house_rooms/armory': 4,
                '/house_rooms/dining_room': 4,
                '/house_rooms/dojo': 5,
                '/house_rooms/gym': 6,
                '/house_rooms/library': 4,
                '/house_rooms/mystical_study': 2,
            },
        },
    },
    // melee-spear
    {
        id: 'melee-spear',
        role: 'melee_stab',
        label: 'Melee stab (spear)',
        guildCombatBuffLevels: { force: 5, tempo: 5, spirit: 3, rarity: 0, scholar: 4 },
        playerDto: {
            staminaLevel: 125,
            intelligenceLevel: 125,
            attackLevel: 125,
            meleeLevel: 150,
            defenseLevel: 125,
            rangedLevel: 125,
            magicLevel: 125,
            equipment: {
                '/equipment_types/back': { hrid: '/items/sinister_cape_refined', enhancementLevel: 5 },
                '/equipment_types/body': { hrid: '/items/maelstrom_plate_body_refined', enhancementLevel: 10 },
                '/equipment_types/charm': { hrid: '/items/grandmaster_melee_charm', enhancementLevel: 5 },
                '/equipment_types/earrings': { hrid: '/items/philosophers_earrings', enhancementLevel: 7 },
                '/equipment_types/feet': { hrid: '/items/pathbreaker_boots_refined', enhancementLevel: 10 },
                '/equipment_types/hands': { hrid: '/items/dodocamel_gauntlets_refined', enhancementLevel: 10 },
                '/equipment_types/head': { hrid: '/items/corsair_helmet_refined', enhancementLevel: 10 },
                '/equipment_types/legs': { hrid: '/items/maelstrom_plate_legs_refined', enhancementLevel: 10 },
                '/equipment_types/main_hand': { hrid: '/items/furious_spear_refined', enhancementLevel: 12 },
                '/equipment_types/neck': { hrid: '/items/philosophers_necklace', enhancementLevel: 5 },
                '/equipment_types/off_hand': { hrid: '/items/vampire_fang_dirk', enhancementLevel: 10 },
                '/equipment_types/pouch': { hrid: '/items/guzzling_pouch', enhancementLevel: 5 },
                '/equipment_types/ring': { hrid: '/items/philosophers_ring', enhancementLevel: 7 },
                '/equipment_types/trinket': { hrid: '/items/expert_task_badge', enhancementLevel: 5 },
            },
            food: [
                {
                    hrid: '/items/spaceberry_cake',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/missing_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 500,
                        },
                    ],
                },
                {
                    hrid: '/items/spaceberry_donut',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/missing_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 280,
                        },
                    ],
                },
                {
                    hrid: '/items/star_fruit_yogurt',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/missing_mp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 350,
                        },
                    ],
                },
            ],
            drinks: [
                {
                    hrid: '/items/critical_coffee',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/critical_coffee',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
                {
                    hrid: '/items/swiftness_coffee',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/targeted_enemy',
                            conditionHrid: '/combat_trigger_conditions/current_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 1,
                        },
                    ],
                },
                {
                    hrid: '/items/ultra_melee_coffee',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/targeted_enemy',
                            conditionHrid: '/combat_trigger_conditions/current_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 1,
                        },
                    ],
                },
            ],
            abilities: [
                {
                    hrid: '/abilities/fierce_aura',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/fierce_aura',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
                {
                    hrid: '/abilities/frenzy',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/frenzy',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
                {
                    hrid: '/abilities/berserk',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/berserk',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
                {
                    hrid: '/abilities/puncture',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/targeted_enemy',
                            conditionHrid: '/combat_trigger_conditions/current_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 3000,
                        },
                    ],
                },
                {
                    hrid: '/abilities/penetrating_strike',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/current_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 3000,
                        },
                    ],
                },
            ],
            houseRooms: {
                '/house_rooms/archery_range': 4,
                '/house_rooms/armory': 5,
                '/house_rooms/dining_room': 6,
                '/house_rooms/dojo': 6,
                '/house_rooms/gym': 6,
                '/house_rooms/library': 8,
                '/house_rooms/mystical_study': 4,
            },
        },
    },
    // melee-slash
    {
        id: 'melee-slash',
        role: 'melee_slash',
        label: 'Melee slash (sword)',
        guildCombatBuffLevels: { force: 4, tempo: 4, spirit: 3, rarity: 0, scholar: 3 },
        playerDto: {
            staminaLevel: 125,
            intelligenceLevel: 125,
            attackLevel: 125,
            meleeLevel: 150,
            defenseLevel: 125,
            rangedLevel: 125,
            magicLevel: 125,
            equipment: {
                '/equipment_types/back': { hrid: '/items/sinister_cape', enhancementLevel: 5 },
                '/equipment_types/body': { hrid: '/items/maelstrom_plate_body_refined', enhancementLevel: 10 },
                '/equipment_types/charm': { hrid: '/items/expert_melee_charm', enhancementLevel: 5 },
                '/equipment_types/earrings': { hrid: '/items/earrings_of_critical_strike', enhancementLevel: 7 },
                '/equipment_types/feet': { hrid: '/items/pathbreaker_boots_refined', enhancementLevel: 10 },
                '/equipment_types/hands': { hrid: '/items/dodocamel_gauntlets_refined', enhancementLevel: 10 },
                '/equipment_types/head': { hrid: '/items/corsair_helmet_refined', enhancementLevel: 10 },
                '/equipment_types/legs': { hrid: '/items/maelstrom_plate_legs_refined', enhancementLevel: 10 },
                '/equipment_types/main_hand': { hrid: '/items/regal_sword_refined', enhancementLevel: 12 },
                '/equipment_types/neck': { hrid: '/items/philosophers_necklace', enhancementLevel: 5 },
                '/equipment_types/off_hand': { hrid: '/items/knights_aegis_refined', enhancementLevel: 10 },
                '/equipment_types/pouch': { hrid: '/items/guzzling_pouch', enhancementLevel: 5 },
                '/equipment_types/ring': { hrid: '/items/ring_of_critical_strike', enhancementLevel: 7 },
                '/equipment_types/trinket': { hrid: '/items/expert_task_badge', enhancementLevel: 5 },
            },
            food: [
                {
                    hrid: '/items/dragon_fruit_yogurt',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/missing_mp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 870,
                        },
                    ],
                },
                {
                    hrid: '/items/plum_gummy',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/missing_mp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 160,
                        },
                    ],
                },
                {
                    hrid: '/items/spaceberry_cake',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/missing_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 850,
                        },
                    ],
                },
            ],
            drinks: [
                {
                    hrid: '/items/critical_coffee',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/critical_coffee',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
                {
                    hrid: '/items/swiftness_coffee',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/swiftness_coffee',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
                {
                    hrid: '/items/ultra_melee_coffee',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/melee_coffee',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
            ],
            abilities: [
                {
                    hrid: '/abilities/fierce_aura',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/fierce_aura',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/number_of_active_units',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 1,
                        },
                    ],
                },
                {
                    hrid: '/abilities/frenzy',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/frenzy',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/number_of_active_units',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 1,
                        },
                    ],
                },
                {
                    hrid: '/abilities/berserk',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/berserk',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/number_of_active_units',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 1,
                        },
                    ],
                },
                {
                    hrid: '/abilities/crippling_slash',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/number_of_dead_units',
                            comparatorHrid: '/combat_trigger_comparators/less_than_equal',
                            value: 1,
                        },
                    ],
                },
                {
                    hrid: '/abilities/maim',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/targeted_enemy',
                            conditionHrid: '/combat_trigger_conditions/current_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 1,
                        },
                    ],
                },
            ],
            houseRooms: {
                '/house_rooms/archery_range': 3,
                '/house_rooms/armory': 4,
                '/house_rooms/dining_room': 4,
                '/house_rooms/dojo': 5,
                '/house_rooms/gym': 5,
                '/house_rooms/library': 5,
                '/house_rooms/mystical_study': 3,
            },
        },
    },
    // ranged-cursed-bow
    {
        id: 'ranged-cursed-bow',
        role: 'ranged',
        label: 'Ranged (cursed bow)',
        guildCombatBuffLevels: { force: 5, tempo: 5, spirit: 3, rarity: 0, scholar: 3 },
        playerDto: {
            staminaLevel: 125,
            intelligenceLevel: 125,
            attackLevel: 125,
            meleeLevel: 125,
            defenseLevel: 125,
            rangedLevel: 150,
            magicLevel: 125,
            equipment: {
                '/equipment_types/back': { hrid: '/items/chimerical_quiver_refined', enhancementLevel: 5 },
                '/equipment_types/body': { hrid: '/items/kraken_tunic_refined', enhancementLevel: 10 },
                '/equipment_types/charm': { hrid: '/items/grandmaster_ranged_charm', enhancementLevel: 5 },
                '/equipment_types/earrings': { hrid: '/items/philosophers_earrings', enhancementLevel: 7 },
                '/equipment_types/feet': { hrid: '/items/pathfinder_boots_refined', enhancementLevel: 10 },
                '/equipment_types/hands': { hrid: '/items/marksman_bracers_refined', enhancementLevel: 10 },
                '/equipment_types/head': { hrid: '/items/acrobatic_hood_refined', enhancementLevel: 10 },
                '/equipment_types/legs': { hrid: '/items/kraken_chaps_refined', enhancementLevel: 10 },
                '/equipment_types/neck': { hrid: '/items/philosophers_necklace', enhancementLevel: 5 },
                '/equipment_types/pouch': { hrid: '/items/guzzling_pouch', enhancementLevel: 5 },
                '/equipment_types/ring': { hrid: '/items/philosophers_ring', enhancementLevel: 7 },
                '/equipment_types/trinket': { hrid: '/items/expert_task_badge', enhancementLevel: 5 },
                '/equipment_types/two_hand': { hrid: '/items/cursed_bow_refined', enhancementLevel: 12 },
            },
            food: [
                {
                    hrid: '/items/spaceberry_cake',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/missing_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 400,
                        },
                    ],
                },
                {
                    hrid: '/items/spaceberry_donut',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/missing_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 350,
                        },
                    ],
                },
                {
                    hrid: '/items/star_fruit_yogurt',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/missing_mp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 550,
                        },
                    ],
                },
            ],
            drinks: [
                {
                    hrid: '/items/critical_coffee',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/critical_coffee',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
                {
                    hrid: '/items/swiftness_coffee',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/swiftness_coffee',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
                {
                    hrid: '/items/ultra_ranged_coffee',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/ranged_coffee',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
            ],
            abilities: [
                {
                    hrid: '/abilities/critical_aura',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/critical_aura',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
                {
                    hrid: '/abilities/frenzy',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/frenzy',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
                {
                    hrid: '/abilities/berserk',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/berserk',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
                {
                    hrid: '/abilities/rain_of_arrows',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/number_of_active_units',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 2,
                        },
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/current_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 1500,
                        },
                    ],
                },
                {
                    hrid: '/abilities/penetrating_shot',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/targeted_enemy',
                            conditionHrid: '/combat_trigger_conditions/current_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 1,
                        },
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/current_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 1500,
                        },
                    ],
                },
            ],
            houseRooms: {
                '/house_rooms/archery_range': 8,
                '/house_rooms/armory': 4,
                '/house_rooms/dining_room': 5,
                '/house_rooms/dojo': 8,
                '/house_rooms/gym': 4,
                '/house_rooms/library': 6,
                '/house_rooms/mystical_study': 4,
            },
        },
    },
    // ranged-sundering-crossbow
    {
        id: 'ranged-sundering-crossbow',
        role: 'ranged',
        label: 'Ranged (sundering crossbow)',
        guildCombatBuffLevels: { force: 5, tempo: 5, spirit: 2, rarity: 1, scholar: 3 },
        playerDto: {
            staminaLevel: 125,
            intelligenceLevel: 125,
            attackLevel: 125,
            meleeLevel: 125,
            defenseLevel: 125,
            rangedLevel: 150,
            magicLevel: 125,
            equipment: {
                '/equipment_types/back': { hrid: '/items/chimerical_quiver', enhancementLevel: 5 },
                '/equipment_types/body': { hrid: '/items/kraken_tunic_refined', enhancementLevel: 10 },
                '/equipment_types/charm': { hrid: '/items/grandmaster_ranged_charm', enhancementLevel: 5 },
                '/equipment_types/earrings': { hrid: '/items/philosophers_earrings', enhancementLevel: 7 },
                '/equipment_types/feet': { hrid: '/items/pathfinder_boots_refined', enhancementLevel: 10 },
                '/equipment_types/hands': { hrid: '/items/marksman_bracers_refined', enhancementLevel: 10 },
                '/equipment_types/head': { hrid: '/items/acrobatic_hood_refined', enhancementLevel: 10 },
                '/equipment_types/legs': { hrid: '/items/kraken_chaps_refined', enhancementLevel: 10 },
                '/equipment_types/main_hand': { hrid: '/items/sundering_crossbow_refined', enhancementLevel: 12 },
                '/equipment_types/neck': { hrid: '/items/philosophers_necklace', enhancementLevel: 5 },
                '/equipment_types/off_hand': { hrid: '/items/manticore_shield', enhancementLevel: 10 },
                '/equipment_types/pouch': { hrid: '/items/guzzling_pouch', enhancementLevel: 5 },
                '/equipment_types/ring': { hrid: '/items/philosophers_ring', enhancementLevel: 7 },
                '/equipment_types/trinket': { hrid: '/items/basic_task_badge', enhancementLevel: 5 },
            },
            food: [
                {
                    hrid: '/items/spaceberry_cake',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/missing_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 350,
                        },
                    ],
                },
                {
                    hrid: '/items/spaceberry_donut',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/missing_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 280,
                        },
                    ],
                },
                {
                    hrid: '/items/star_fruit_yogurt',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/missing_mp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 350,
                        },
                    ],
                },
            ],
            drinks: [
                {
                    hrid: '/items/critical_coffee',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/critical_coffee',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
                {
                    hrid: '/items/swiftness_coffee',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/swiftness_coffee',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
                {
                    hrid: '/items/ultra_ranged_coffee',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/ranged_coffee',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
            ],
            abilities: [
                {
                    hrid: '/abilities/critical_aura',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/critical_aura',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
                {
                    hrid: '/abilities/frenzy',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/frenzy',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/current_mp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 250,
                        },
                    ],
                },
                {
                    hrid: '/abilities/berserk',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/berserk',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/current_mp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 600,
                        },
                    ],
                },
                {
                    hrid: '/abilities/rain_of_arrows',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/number_of_active_units',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 2,
                        },
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/current_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 1500,
                        },
                    ],
                },
                {
                    hrid: '/abilities/penetrating_shot',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/current_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 3210,
                        },
                    ],
                },
            ],
            houseRooms: {
                '/house_rooms/archery_range': 5,
                '/house_rooms/armory': 3,
                '/house_rooms/dining_room': 5,
                '/house_rooms/dojo': 6,
                '/house_rooms/gym': 4,
                '/house_rooms/library': 5,
                '/house_rooms/mystical_study': 3,
            },
        },
    },
    // magic-nature
    {
        id: 'magic-nature',
        role: 'nature_mage',
        label: 'Nature mage',
        guildCombatBuffLevels: { force: 5, tempo: 5, spirit: 3, rarity: 0, scholar: 4 },
        playerDto: {
            staminaLevel: 125,
            intelligenceLevel: 125,
            attackLevel: 125,
            meleeLevel: 125,
            defenseLevel: 125,
            rangedLevel: 125,
            magicLevel: 150,
            equipment: {
                '/equipment_types/back': { hrid: '/items/enchanted_cloak_refined', enhancementLevel: 5 },
                '/equipment_types/body': { hrid: '/items/royal_nature_robe_top_refined', enhancementLevel: 10 },
                '/equipment_types/charm': { hrid: '/items/advanced_defense_charm', enhancementLevel: 5 },
                '/equipment_types/earrings': { hrid: '/items/philosophers_earrings', enhancementLevel: 7 },
                '/equipment_types/feet': { hrid: '/items/pathseeker_boots_refined', enhancementLevel: 10 },
                '/equipment_types/hands': { hrid: '/items/chrono_gloves', enhancementLevel: 10 },
                '/equipment_types/head': { hrid: '/items/magicians_hat_refined', enhancementLevel: 10 },
                '/equipment_types/legs': { hrid: '/items/royal_nature_robe_bottoms_refined', enhancementLevel: 10 },
                '/equipment_types/main_hand': { hrid: '/items/blooming_trident_refined', enhancementLevel: 12 },
                '/equipment_types/neck': { hrid: '/items/philosophers_necklace', enhancementLevel: 5 },
                '/equipment_types/off_hand': { hrid: '/items/bishops_codex_refined', enhancementLevel: 10 },
                '/equipment_types/pouch': { hrid: '/items/guzzling_pouch', enhancementLevel: 5 },
                '/equipment_types/ring': { hrid: '/items/philosophers_ring', enhancementLevel: 7 },
                '/equipment_types/trinket': { hrid: '/items/expert_task_badge', enhancementLevel: 5 },
            },
            food: [
                {
                    hrid: '/items/dragon_fruit_gummy',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/missing_mp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 400,
                        },
                    ],
                },
                {
                    hrid: '/items/dragon_fruit_yogurt',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/missing_mp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 1200,
                        },
                    ],
                },
                {
                    hrid: '/items/spaceberry_cake',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/missing_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 400,
                        },
                    ],
                },
            ],
            drinks: [
                {
                    hrid: '/items/channeling_coffee',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/channeling_coffee',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
                {
                    hrid: '/items/ultra_magic_coffee',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/magic_coffee',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
                {
                    hrid: '/items/wisdom_coffee',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/wisdom_coffee',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
            ],
            abilities: [
                {
                    hrid: '/abilities/mystic_aura',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/mystic_aura',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
                {
                    hrid: '/abilities/elemental_affinity',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/elemental_affinity',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
                {
                    hrid: '/abilities/toxic_pollen',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/current_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 970,
                        },
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/current_mp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 80,
                        },
                    ],
                },
                {
                    hrid: '/abilities/natures_veil',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/current_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 1540,
                        },
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/current_mp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 80,
                        },
                    ],
                },
                {
                    hrid: '/abilities/entangle',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/targeted_enemy',
                            conditionHrid: '/combat_trigger_conditions/current_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 1,
                        },
                    ],
                },
            ],
            houseRooms: {
                '/house_rooms/archery_range': 3,
                '/house_rooms/armory': 5,
                '/house_rooms/dining_room': 5,
                '/house_rooms/dojo': 7,
                '/house_rooms/gym': 3,
                '/house_rooms/library': 6,
                '/house_rooms/mystical_study': 7,
            },
        },
    },
    // magic-fire
    {
        id: 'magic-fire',
        role: 'fire_mage',
        label: 'Fire mage',
        guildCombatBuffLevels: { force: 5, tempo: 5, spirit: 2, rarity: 0, scholar: 3 },
        playerDto: {
            staminaLevel: 125,
            intelligenceLevel: 125,
            attackLevel: 125,
            meleeLevel: 125,
            defenseLevel: 125,
            rangedLevel: 125,
            magicLevel: 150,
            equipment: {
                '/equipment_types/back': { hrid: '/items/enchanted_cloak', enhancementLevel: 5 },
                '/equipment_types/body': { hrid: '/items/royal_fire_robe_top_refined', enhancementLevel: 10 },
                '/equipment_types/charm': { hrid: '/items/grandmaster_magic_charm', enhancementLevel: 5 },
                '/equipment_types/earrings': { hrid: '/items/philosophers_earrings', enhancementLevel: 7 },
                '/equipment_types/feet': { hrid: '/items/pathseeker_boots_refined', enhancementLevel: 10 },
                '/equipment_types/hands': { hrid: '/items/chrono_gloves', enhancementLevel: 10 },
                '/equipment_types/head': { hrid: '/items/magicians_hat_refined', enhancementLevel: 10 },
                '/equipment_types/legs': { hrid: '/items/royal_fire_robe_bottoms_refined', enhancementLevel: 10 },
                '/equipment_types/main_hand': { hrid: '/items/blazing_trident_refined', enhancementLevel: 12 },
                '/equipment_types/neck': { hrid: '/items/philosophers_necklace', enhancementLevel: 5 },
                '/equipment_types/off_hand': { hrid: '/items/bishops_codex_refined', enhancementLevel: 10 },
                '/equipment_types/pouch': { hrid: '/items/guzzling_pouch', enhancementLevel: 5 },
                '/equipment_types/ring': { hrid: '/items/philosophers_ring', enhancementLevel: 7 },
                '/equipment_types/trinket': { hrid: '/items/expert_task_badge', enhancementLevel: 5 },
            },
            food: [
                {
                    hrid: '/items/spaceberry_donut',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/missing_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 300,
                        },
                    ],
                },
                {
                    hrid: '/items/star_fruit_gummy',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/missing_mp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 320,
                        },
                    ],
                },
                {
                    hrid: '/items/star_fruit_yogurt',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/missing_mp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 450,
                        },
                    ],
                },
            ],
            drinks: [
                {
                    hrid: '/items/critical_coffee',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/critical_coffee',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
                {
                    hrid: '/items/ultra_attack_coffee',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/attack_coffee',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
                {
                    hrid: '/items/ultra_magic_coffee',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/magic_coffee',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
            ],
            abilities: [
                {
                    hrid: '/abilities/mystic_aura',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/mystic_aura',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
                {
                    hrid: '/abilities/elemental_affinity',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/elemental_affinity',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
                {
                    hrid: '/abilities/smoke_burst',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/targeted_enemy',
                            conditionHrid: '/combat_trigger_conditions/current_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 2300,
                        },
                    ],
                },
                {
                    hrid: '/abilities/firestorm',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/number_of_active_units',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 1,
                        },
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/current_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 8500,
                        },
                    ],
                },
                {
                    hrid: '/abilities/fireball',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/targeted_enemy',
                            conditionHrid: '/combat_trigger_conditions/current_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 1,
                        },
                    ],
                },
            ],
            houseRooms: {
                '/house_rooms/archery_range': 2,
                '/house_rooms/armory': 5,
                '/house_rooms/dining_room': 5,
                '/house_rooms/dojo': 5,
                '/house_rooms/gym': 2,
                '/house_rooms/library': 5,
                '/house_rooms/mystical_study': 8,
            },
        },
    },
    // magic-water
    {
        id: 'magic-water',
        role: 'water_mage',
        label: 'Water mage',
        guildCombatBuffLevels: { force: 5, tempo: 5, spirit: 5, rarity: 1, scholar: 4 },
        playerDto: {
            staminaLevel: 125,
            intelligenceLevel: 125,
            attackLevel: 125,
            meleeLevel: 125,
            defenseLevel: 125,
            rangedLevel: 125,
            magicLevel: 150,
            equipment: {
                '/equipment_types/back': { hrid: '/items/enchanted_cloak_refined', enhancementLevel: 5 },
                '/equipment_types/body': { hrid: '/items/royal_water_robe_top_refined', enhancementLevel: 10 },
                '/equipment_types/charm': { hrid: '/items/grandmaster_magic_charm', enhancementLevel: 5 },
                '/equipment_types/earrings': { hrid: '/items/philosophers_earrings', enhancementLevel: 7 },
                '/equipment_types/feet': { hrid: '/items/pathseeker_boots_refined', enhancementLevel: 10 },
                '/equipment_types/hands': { hrid: '/items/chrono_gloves', enhancementLevel: 10 },
                '/equipment_types/head': { hrid: '/items/magicians_hat_refined', enhancementLevel: 10 },
                '/equipment_types/legs': { hrid: '/items/royal_water_robe_bottoms_refined', enhancementLevel: 10 },
                '/equipment_types/main_hand': { hrid: '/items/rippling_trident_refined', enhancementLevel: 12 },
                '/equipment_types/neck': { hrid: '/items/philosophers_necklace', enhancementLevel: 5 },
                '/equipment_types/off_hand': { hrid: '/items/bishops_codex_refined', enhancementLevel: 10 },
                '/equipment_types/pouch': { hrid: '/items/guzzling_pouch', enhancementLevel: 5 },
                '/equipment_types/ring': { hrid: '/items/philosophers_ring', enhancementLevel: 7 },
                '/equipment_types/trinket': { hrid: '/items/expert_task_badge', enhancementLevel: 5 },
            },
            food: [
                {
                    hrid: '/items/plum_gummy',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/missing_mp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 320,
                        },
                    ],
                },
                {
                    hrid: '/items/plum_yogurt',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/missing_mp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 400,
                        },
                    ],
                },
                {
                    hrid: '/items/spaceberry_cake',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/missing_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 555,
                        },
                    ],
                },
            ],
            drinks: [
                {
                    hrid: '/items/lucky_coffee',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/lucky_coffee',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
                {
                    hrid: '/items/ultra_attack_coffee',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/attack_coffee',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
                {
                    hrid: '/items/ultra_magic_coffee',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/magic_coffee',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
            ],
            abilities: [
                {
                    hrid: '/abilities/mystic_aura',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/mystic_aura',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
                {
                    hrid: '/abilities/elemental_affinity',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/elemental_affinity',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
                {
                    hrid: '/abilities/frost_surge',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/number_of_active_units',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 1,
                        },
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/current_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 1200,
                        },
                    ],
                },
                {
                    hrid: '/abilities/mana_spring',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/number_of_active_units',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 1,
                        },
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/current_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 1200,
                        },
                    ],
                },
                { hrid: '/abilities/water_strike', level: 75, triggers: null },
            ],
            houseRooms: {
                '/house_rooms/archery_range': 5,
                '/house_rooms/armory': 5,
                '/house_rooms/dining_room': 6,
                '/house_rooms/dojo': 6,
                '/house_rooms/gym': 3,
                '/house_rooms/library': 8,
                '/house_rooms/mystical_study': 8,
            },
        },
    },
    // tank-bulwark
    {
        id: 'tank-bulwark',
        role: 'tank',
        label: 'Tank (bulwark)',
        guildCombatBuffLevels: { force: 5, tempo: 4, spirit: 1, rarity: 0, scholar: 3 },
        playerDto: {
            staminaLevel: 125,
            intelligenceLevel: 125,
            attackLevel: 125,
            meleeLevel: 125,
            defenseLevel: 150,
            rangedLevel: 125,
            magicLevel: 125,
            equipment: {
                '/equipment_types/back': { hrid: '/items/sinister_cape_refined', enhancementLevel: 5 },
                '/equipment_types/body': { hrid: '/items/anchorbound_plate_body_refined', enhancementLevel: 10 },
                '/equipment_types/charm': { hrid: '/items/master_defense_charm', enhancementLevel: 5 },
                '/equipment_types/earrings': { hrid: '/items/philosophers_earrings', enhancementLevel: 7 },
                '/equipment_types/feet': { hrid: '/items/pathbreaker_boots_refined', enhancementLevel: 10 },
                '/equipment_types/hands': { hrid: '/items/magnetic_gloves', enhancementLevel: 10 },
                '/equipment_types/head': { hrid: '/items/corsair_helmet_refined', enhancementLevel: 10 },
                '/equipment_types/legs': { hrid: '/items/anchorbound_plate_legs_refined', enhancementLevel: 10 },
                '/equipment_types/neck': { hrid: '/items/philosophers_necklace', enhancementLevel: 5 },
                '/equipment_types/pouch': { hrid: '/items/guzzling_pouch', enhancementLevel: 5 },
                '/equipment_types/ring': { hrid: '/items/philosophers_ring', enhancementLevel: 7 },
                '/equipment_types/trinket': { hrid: '/items/expert_task_badge', enhancementLevel: 5 },
                '/equipment_types/two_hand': { hrid: '/items/griffin_bulwark_refined', enhancementLevel: 12 },
            },
            food: [
                {
                    hrid: '/items/dragon_fruit_yogurt',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/missing_mp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 300,
                        },
                    ],
                },
                {
                    hrid: '/items/plum_gummy',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/missing_mp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 160,
                        },
                    ],
                },
                {
                    hrid: '/items/spaceberry_cake',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/missing_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 350,
                        },
                    ],
                },
            ],
            drinks: [
                {
                    hrid: '/items/lucky_coffee',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/lucky_coffee',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
                {
                    hrid: '/items/ultra_defense_coffee',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/defense_coffee',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
                {
                    hrid: '/items/ultra_stamina_coffee',
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/stamina_coffee',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
            ],
            abilities: [
                {
                    hrid: '/abilities/invincible',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/invincible',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
                {
                    hrid: '/abilities/retribution',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/retribution',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
                {
                    hrid: '/abilities/spike_shell',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/spike_shell',
                            comparatorHrid: '/combat_trigger_comparators/is_inactive',
                            value: 0,
                        },
                    ],
                },
                {
                    hrid: '/abilities/fracturing_impact',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/current_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 1400,
                        },
                    ],
                },
                {
                    hrid: '/abilities/shield_bash',
                    level: 75,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/targeted_enemy',
                            conditionHrid: '/combat_trigger_conditions/current_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 1,
                        },
                    ],
                },
            ],
            houseRooms: {
                '/house_rooms/archery_range': 3,
                '/house_rooms/armory': 7,
                '/house_rooms/dining_room': 7,
                '/house_rooms/dojo': 8,
                '/house_rooms/gym': 5,
                '/house_rooms/library': 6,
                '/house_rooms/mystical_study': 3,
            },
        },
    },
]);

/**
 * The templates of one role group.
 * @param {{roles: ReadonlyArray<string>}} group
 * @returns {Array<Object>}
 */
export function templatesForGroup(group) {
    return PARTY_TEMPLATES.filter((t) => group.roles.includes(t.role));
}

/** The longest teammate name the roster keeps (see `cleanTeammateName`) */
const TEAMMATE_NAME_MAX = 40;

/**
 * The name a template gets as a teammate: its label without a trailing "[source]" tag, cut at a word boundary when
 * it is longer than the roster keeps.
 * @param {{label: string}} template
 * @returns {string}
 */
export function templateTeammateName(template) {
    const label = template.label.replace(/\s*\[[^\]]*\]\s*$/, '').trim();
    if (label.length <= TEAMMATE_NAME_MAX) return label;
    const cut = label.slice(0, TEAMMATE_NAME_MAX);
    const space = cut.lastIndexOf(' ');
    return (space > 20 ? cut.slice(0, space) : cut).replace(/[\s,;:(]+$/, '');
}
