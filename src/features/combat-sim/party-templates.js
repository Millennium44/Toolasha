/**
 * Ready-made teammate builds the Party tab offers beside the player's saved builds. They ship with the script, are
 * read-only and are never written to the roster record; adding one copies it into the roster as an ordinary teammate.
 * They carry no game mode, so they fit either a market or an Iron Cow party.
 *
 * Guide builds were transcribed from the guides named per entry; the lab-* builds are lab loadouts read from the
 * test server. Every item and ability hrid was checked against live game data on 2026-10-29.
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
    { id: 'melee', label: 'Melee', roles: ['melee_stab', 'melee_slash'] },
]);

/** @type {ReadonlyArray<{id: string, role: string, tier: string, label: string, source: string, playerDto: Object}>} */
export const PARTY_TEMPLATES = deepFreeze([
    // ranger-mid-75: from guide: Ranger Z2H (rentry.co/mwi-ranger-z2h)
    {
        id: 'ranger-mid-75',
        role: 'ranged',
        tier: 'mid',
        label: 'Ranger, Ranged 75 (Umbral set, Redwood Crossbow)',
        source: 'from guide: Ranger Z2H (rentry.co/mwi-ranger-z2h)',
        playerDto: {
            staminaLevel: 90,
            intelligenceLevel: 50,
            attackLevel: 90,
            meleeLevel: 90,
            defenseLevel: 90,
            rangedLevel: 75,
            magicLevel: 90,
            equipment: {
                '/equipment_types/main_hand': { hrid: '/items/redwood_crossbow', enhancementLevel: 0 },
                '/equipment_types/off_hand': { hrid: '/items/treant_shield', enhancementLevel: 0 },
                '/equipment_types/head': { hrid: '/items/umbral_hood', enhancementLevel: 0 },
                '/equipment_types/body': { hrid: '/items/umbral_tunic', enhancementLevel: 0 },
                '/equipment_types/legs': { hrid: '/items/umbral_chaps', enhancementLevel: 0 },
                '/equipment_types/hands': { hrid: '/items/sighted_bracers', enhancementLevel: 5 },
                '/equipment_types/feet': { hrid: '/items/centaur_boots', enhancementLevel: 5 },
                '/equipment_types/neck': { hrid: '/items/necklace_of_speed', enhancementLevel: 0 },
                '/equipment_types/ring': { hrid: '/items/ring_of_regeneration', enhancementLevel: 0 },
                '/equipment_types/earrings': { hrid: '/items/earrings_of_regeneration', enhancementLevel: 3 },
                '/equipment_types/pouch': { hrid: '/items/giant_pouch', enhancementLevel: 0 },
            },
            food: [
                { hrid: '/items/marsberry_cake', triggers: null },
                { hrid: '/items/peach_yogurt', triggers: null },
                { hrid: '/items/plum_gummy', triggers: null },
            ],
            drinks: [
                { hrid: '/items/wisdom_coffee', triggers: null },
                { hrid: '/items/super_ranged_coffee', triggers: null },
                { hrid: '/items/critical_coffee', triggers: null },
            ],
            abilities: [
                { hrid: '/abilities/critical_aura', level: 40, triggers: null },
                {
                    hrid: '/abilities/rain_of_arrows',
                    level: 40,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/current_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 300,
                        },
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/number_of_dead_units',
                            comparatorHrid: '/combat_trigger_comparators/less_than_equal',
                            value: 1,
                        },
                    ],
                },
                {
                    hrid: '/abilities/penetrating_shot',
                    level: 40,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/current_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 300,
                        },
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/number_of_dead_units',
                            comparatorHrid: '/combat_trigger_comparators/less_than_equal',
                            value: 1,
                        },
                    ],
                },
                { hrid: '/abilities/silencing_shot', level: 40, triggers: null },
                null,
            ],
            houseRooms: {},
        },
    },
    // ranger-entry-dungeon1: from guide: Ranger Z2H (rentry.co/mwi-ranger-z2h)
    {
        id: 'ranger-entry-dungeon1',
        role: 'ranged',
        tier: 'mid',
        label: 'Ranger, Entry (CL95-105), Chimerical Den recommended',
        source: 'from guide: Ranger Z2H (rentry.co/mwi-ranger-z2h)',
        playerDto: {
            staminaLevel: 100,
            intelligenceLevel: 105,
            attackLevel: 110,
            meleeLevel: 90,
            defenseLevel: 100,
            rangedLevel: 110,
            magicLevel: 90,
            equipment: {
                '/equipment_types/main_hand': { hrid: '/items/sundering_crossbow', enhancementLevel: 7 },
                '/equipment_types/off_hand': { hrid: '/items/manticore_shield', enhancementLevel: 10 },
                '/equipment_types/head': { hrid: '/items/acrobatic_hood', enhancementLevel: 7 },
                '/equipment_types/body': { hrid: '/items/revenant_tunic', enhancementLevel: 10 },
                '/equipment_types/legs': { hrid: '/items/revenant_chaps', enhancementLevel: 10 },
                '/equipment_types/hands': { hrid: '/items/marksman_bracers', enhancementLevel: 7 },
                '/equipment_types/feet': { hrid: '/items/centaur_boots', enhancementLevel: 10 },
                '/equipment_types/neck': { hrid: '/items/necklace_of_speed', enhancementLevel: 5 },
                '/equipment_types/ring': { hrid: '/items/ring_of_regeneration', enhancementLevel: 5 },
                '/equipment_types/earrings': { hrid: '/items/earrings_of_regeneration', enhancementLevel: 5 },
                '/equipment_types/pouch': { hrid: '/items/giant_pouch', enhancementLevel: 0 },
            },
            food: [
                { hrid: '/items/spaceberry_cake', triggers: null },
                { hrid: '/items/star_fruit_yogurt', triggers: null },
                { hrid: '/items/dragon_fruit_gummy', triggers: null },
            ],
            drinks: [
                { hrid: '/items/swiftness_coffee', triggers: null },
                { hrid: '/items/ultra_ranged_coffee', triggers: null },
                { hrid: '/items/critical_coffee', triggers: null },
            ],
            abilities: [
                { hrid: '/abilities/critical_aura', level: 20, triggers: null },
                {
                    hrid: '/abilities/frenzy',
                    level: 40,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/current_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 300,
                        },
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/number_of_dead_units',
                            comparatorHrid: '/combat_trigger_comparators/less_than_equal',
                            value: 1,
                        },
                    ],
                },
                {
                    hrid: '/abilities/berserk',
                    level: 40,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/current_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 300,
                        },
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/number_of_dead_units',
                            comparatorHrid: '/combat_trigger_comparators/less_than_equal',
                            value: 1,
                        },
                    ],
                },
                {
                    hrid: '/abilities/penetrating_shot',
                    level: 40,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/current_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 300,
                        },
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/number_of_dead_units',
                            comparatorHrid: '/combat_trigger_comparators/less_than_equal',
                            value: 1,
                        },
                    ],
                },
                { hrid: '/abilities/pestilent_shot', level: 40, triggers: null },
            ],
            houseRooms: {},
        },
    },
    // ranger-dungeon3-cursed: from guide: Ranger Z2H (rentry.co/mwi-ranger-z2h)
    {
        id: 'ranger-dungeon3-cursed',
        role: 'ranged',
        tier: 'late',
        label: 'Ranger, CL105-130, Dungeon 3/4 recommended (Cursed Bow)',
        source: 'from guide: Ranger Z2H (rentry.co/mwi-ranger-z2h)',
        playerDto: {
            staminaLevel: 110,
            intelligenceLevel: 110,
            attackLevel: 120,
            meleeLevel: 120,
            defenseLevel: 110,
            rangedLevel: 120,
            magicLevel: 120,
            equipment: {
                '/equipment_types/two_hand': { hrid: '/items/cursed_bow', enhancementLevel: 10 },
                '/equipment_types/head': { hrid: '/items/acrobatic_hood', enhancementLevel: 10 },
                '/equipment_types/body': { hrid: '/items/kraken_tunic', enhancementLevel: 10 },
                '/equipment_types/legs': { hrid: '/items/kraken_chaps', enhancementLevel: 10 },
                '/equipment_types/hands': { hrid: '/items/marksman_bracers', enhancementLevel: 10 },
                '/equipment_types/feet': { hrid: '/items/centaur_boots', enhancementLevel: 14 },
                '/equipment_types/neck': { hrid: '/items/necklace_of_speed', enhancementLevel: 5 },
                '/equipment_types/ring': { hrid: '/items/ring_of_regeneration', enhancementLevel: 5 },
                '/equipment_types/earrings': { hrid: '/items/earrings_of_regeneration', enhancementLevel: 5 },
                '/equipment_types/pouch': { hrid: '/items/guzzling_pouch', enhancementLevel: 5 },
            },
            food: [
                { hrid: '/items/spaceberry_cake', triggers: null },
                { hrid: '/items/star_fruit_yogurt', triggers: null },
                { hrid: '/items/dragon_fruit_gummy', triggers: null },
            ],
            drinks: [
                { hrid: '/items/swiftness_coffee', triggers: null },
                { hrid: '/items/ultra_ranged_coffee', triggers: null },
                { hrid: '/items/critical_coffee', triggers: null },
            ],
            abilities: [
                { hrid: '/abilities/critical_aura', level: 40, triggers: null },
                {
                    hrid: '/abilities/frenzy',
                    level: 60,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/current_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 300,
                        },
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/number_of_dead_units',
                            comparatorHrid: '/combat_trigger_comparators/less_than_equal',
                            value: 1,
                        },
                    ],
                },
                {
                    hrid: '/abilities/berserk',
                    level: 60,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/current_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 300,
                        },
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/number_of_dead_units',
                            comparatorHrid: '/combat_trigger_comparators/less_than_equal',
                            value: 1,
                        },
                    ],
                },
                {
                    hrid: '/abilities/penetrating_shot',
                    level: 60,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/current_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than_equal',
                            value: 300,
                        },
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/number_of_dead_units',
                            comparatorHrid: '/combat_trigger_comparators/less_than_equal',
                            value: 1,
                        },
                    ],
                },
                { hrid: '/abilities/pestilent_shot', level: 60, triggers: null },
            ],
            houseRooms: {},
        },
    },
    // nature-entry: from guide: Nature Mage Beginners Guide (wiki)
    {
        id: 'nature-entry',
        role: 'nature_mage',
        tier: 'mid',
        label: 'Nature mage, entry level (Jackalope Staff +7)',
        source: 'from guide: Nature Mage Beginners Guide (wiki)',
        playerDto: {
            staminaLevel: 90,
            intelligenceLevel: 90,
            attackLevel: 90,
            meleeLevel: 90,
            defenseLevel: 90,
            rangedLevel: 90,
            magicLevel: 85,
            equipment: {
                '/equipment_types/main_hand': { hrid: '/items/jackalope_staff', enhancementLevel: 7 },
                '/equipment_types/off_hand': { hrid: '/items/tome_of_healing', enhancementLevel: 10 },
                '/equipment_types/head': { hrid: '/items/radiant_hat', enhancementLevel: 10 },
                '/equipment_types/body': { hrid: '/items/luna_robe_top', enhancementLevel: 10 },
                '/equipment_types/legs': { hrid: '/items/luna_robe_bottoms', enhancementLevel: 10 },
                '/equipment_types/hands': { hrid: '/items/chrono_gloves', enhancementLevel: 7 },
                '/equipment_types/feet': { hrid: '/items/sorcerer_boots', enhancementLevel: 10 },
                '/equipment_types/pouch': { hrid: '/items/giant_pouch', enhancementLevel: 0 },
                '/equipment_types/ring': { hrid: '/items/ring_of_regeneration', enhancementLevel: 0 },
            },
            food: [
                { hrid: '/items/marsberry_cake', triggers: null },
                { hrid: '/items/peach_yogurt', triggers: null },
                { hrid: '/items/plum_gummy', triggers: null },
            ],
            drinks: [
                { hrid: '/items/wisdom_coffee', triggers: null },
                { hrid: '/items/super_magic_coffee', triggers: null },
                { hrid: '/items/channeling_coffee', triggers: null },
            ],
            abilities: [
                { hrid: '/abilities/mystic_aura', level: 40, triggers: null },
                {
                    hrid: '/abilities/rejuvenate',
                    level: 40,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_allies',
                            conditionHrid: '/combat_trigger_conditions/missing_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than',
                            value: 600,
                        },
                    ],
                },
                {
                    hrid: '/abilities/toxic_pollen',
                    level: 40,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/current_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than',
                            value: 400,
                        },
                    ],
                },
                {
                    hrid: '/abilities/natures_veil',
                    level: 40,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/current_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than',
                            value: 200,
                        },
                    ],
                },
                { hrid: '/abilities/entangle', level: 40, triggers: null },
            ],
            houseRooms: {},
        },
    },
    // nature-real-dungeon: from guide: Nature Mage Beginners Guide (wiki)
    {
        id: 'nature-real-dungeon',
        role: 'nature_mage',
        tier: 'late',
        label: 'Nature mage, "real" gear + dungeon healer kit',
        source: 'from guide: Nature Mage Beginners Guide (wiki)',
        playerDto: {
            staminaLevel: 120,
            intelligenceLevel: 120,
            attackLevel: 120,
            meleeLevel: 120,
            defenseLevel: 120,
            rangedLevel: 120,
            magicLevel: 120,
            equipment: {
                '/equipment_types/main_hand': { hrid: '/items/blooming_trident', enhancementLevel: 10 },
                '/equipment_types/off_hand': { hrid: '/items/bishops_codex', enhancementLevel: 10 },
                '/equipment_types/head': { hrid: '/items/magicians_hat', enhancementLevel: 10 },
                '/equipment_types/body': { hrid: '/items/luna_robe_top', enhancementLevel: 10 },
                '/equipment_types/legs': { hrid: '/items/luna_robe_bottoms', enhancementLevel: 10 },
                '/equipment_types/hands': { hrid: '/items/chrono_gloves', enhancementLevel: 10 },
                '/equipment_types/feet': { hrid: '/items/sorcerer_boots', enhancementLevel: 10 },
                '/equipment_types/pouch': { hrid: '/items/giant_pouch', enhancementLevel: 0 },
            },
            food: [
                { hrid: '/items/spaceberry_cake', triggers: null },
                { hrid: '/items/star_fruit_yogurt', triggers: null },
                { hrid: '/items/dragon_fruit_gummy', triggers: null },
            ],
            drinks: [
                { hrid: '/items/super_stamina_coffee', triggers: null },
                { hrid: '/items/super_magic_coffee', triggers: null },
                { hrid: '/items/super_defense_coffee', triggers: null },
            ],
            abilities: [
                { hrid: '/abilities/revive', level: 70, triggers: null },
                {
                    hrid: '/abilities/rejuvenate',
                    level: 70,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_allies',
                            conditionHrid: '/combat_trigger_conditions/missing_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than',
                            value: 600,
                        },
                    ],
                },
                {
                    hrid: '/abilities/heal',
                    level: 70,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/missing_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than',
                            value: 200,
                        },
                    ],
                },
                {
                    hrid: '/abilities/quick_aid',
                    level: 70,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_allies',
                            conditionHrid: '/combat_trigger_conditions/lowest_hp_percentage',
                            comparatorHrid: '/combat_trigger_comparators/less_than',
                            value: 85,
                        },
                    ],
                },
                {
                    hrid: '/abilities/toxic_pollen',
                    level: 70,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/all_enemies',
                            conditionHrid: '/combat_trigger_conditions/current_hp',
                            comparatorHrid: '/combat_trigger_comparators/greater_than',
                            value: 400,
                        },
                    ],
                },
            ],
            houseRooms: {},
        },
    },
    // fire-early-20: from guide: Ashes to Ashes, Dust to Dust (wiki)
    {
        id: 'fire-early-20',
        role: 'fire_mage',
        tier: 'early',
        label: 'Fire mage, ~Lv20 Smelly Planet bombarding',
        source: 'from guide: Ashes to Ashes, Dust to Dust (wiki)',
        playerDto: {
            staminaLevel: 20,
            intelligenceLevel: 20,
            attackLevel: 60,
            meleeLevel: 60,
            defenseLevel: 20,
            rangedLevel: 60,
            magicLevel: 20,
            equipment: {
                '/equipment_types/main_hand': { hrid: '/items/cedar_fire_staff', enhancementLevel: 0 },
                '/equipment_types/head': { hrid: '/items/linen_hat', enhancementLevel: 0 },
                '/equipment_types/body': { hrid: '/items/linen_robe_top', enhancementLevel: 0 },
                '/equipment_types/legs': { hrid: '/items/linen_robe_bottoms', enhancementLevel: 0 },
                '/equipment_types/hands': { hrid: '/items/linen_gloves', enhancementLevel: 0 },
                '/equipment_types/feet': { hrid: '/items/linen_boots', enhancementLevel: 0 },
            },
            food: [
                { hrid: '/items/strawberry_cake', triggers: null },
                { hrid: '/items/orange_yogurt', triggers: null },
                { hrid: '/items/orange_gummy', triggers: null },
            ],
            drinks: [
                { hrid: '/items/wisdom_coffee', triggers: null },
                { hrid: '/items/magic_coffee', triggers: null },
                null,
            ],
            abilities: [
                null,
                { hrid: '/abilities/flame_blast', level: 20, triggers: null },
                { hrid: '/abilities/fireball', level: 20, triggers: null },
                null,
                null,
            ],
            houseRooms: {},
        },
    },
    // fire-lv85: from guide: Ashes to Ashes, Dust to Dust (wiki)
    {
        id: 'fire-lv85',
        role: 'fire_mage',
        tier: 'mid',
        label: "Fire mage, Lv85+ (Magician's Hat, Frost/Jackalope staff)",
        source: 'from guide: Ashes to Ashes, Dust to Dust (wiki)',
        playerDto: {
            staminaLevel: 90,
            intelligenceLevel: 90,
            attackLevel: 90,
            meleeLevel: 90,
            defenseLevel: 90,
            rangedLevel: 90,
            magicLevel: 85,
            equipment: {
                '/equipment_types/main_hand': { hrid: '/items/jackalope_staff', enhancementLevel: 0 },
                '/equipment_types/off_hand': { hrid: '/items/bishops_codex', enhancementLevel: 7 },
                '/equipment_types/head': { hrid: '/items/magicians_hat', enhancementLevel: 7 },
                '/equipment_types/body': { hrid: '/items/flaming_robe_top', enhancementLevel: 0 },
                '/equipment_types/legs': { hrid: '/items/flaming_robe_bottoms', enhancementLevel: 0 },
                '/equipment_types/hands': { hrid: '/items/chrono_gloves', enhancementLevel: 10 },
                '/equipment_types/feet': { hrid: '/items/sorcerer_boots', enhancementLevel: 10 },
                '/equipment_types/pouch': { hrid: '/items/giant_pouch', enhancementLevel: 0 },
            },
            food: [
                { hrid: '/items/spaceberry_cake', triggers: null },
                { hrid: '/items/star_fruit_yogurt', triggers: null },
                { hrid: '/items/star_fruit_gummy', triggers: null },
            ],
            drinks: [
                { hrid: '/items/wisdom_coffee', triggers: null },
                { hrid: '/items/super_magic_coffee', triggers: null },
                { hrid: '/items/channeling_coffee', triggers: null },
            ],
            abilities: [
                { hrid: '/abilities/insanity', level: 40, triggers: null },
                { hrid: '/abilities/elemental_affinity', level: 40, triggers: null },
                { hrid: '/abilities/firestorm', level: 40, triggers: null },
                { hrid: '/abilities/flame_blast', level: 40, triggers: null },
                { hrid: '/abilities/fireball', level: 40, triggers: null },
            ],
            houseRooms: {},
        },
    },
    // water-start-80: from guide: Supreme Over the Laws (wiki)
    {
        id: 'water-start-80',
        role: 'water_mage',
        tier: 'mid',
        label: 'Water mage, Magic 80 (Arcane Water Staff)',
        source: 'from guide: Supreme Over the Laws (wiki)',
        playerDto: {
            staminaLevel: 90,
            intelligenceLevel: 90,
            attackLevel: 90,
            meleeLevel: 90,
            defenseLevel: 90,
            rangedLevel: 90,
            magicLevel: 80,
            equipment: {
                '/equipment_types/main_hand': { hrid: '/items/arcane_water_staff', enhancementLevel: 0 },
                '/equipment_types/off_hand': { hrid: '/items/tome_of_the_elements', enhancementLevel: 10 },
                '/equipment_types/head': { hrid: '/items/radiant_hat', enhancementLevel: 0 },
                '/equipment_types/body': { hrid: '/items/icy_robe_top', enhancementLevel: 10 },
                '/equipment_types/legs': { hrid: '/items/icy_robe_bottoms', enhancementLevel: 10 },
                '/equipment_types/hands': { hrid: '/items/chrono_gloves', enhancementLevel: 10 },
                '/equipment_types/feet': { hrid: '/items/sorcerer_boots', enhancementLevel: 10 },
            },
            food: [
                { hrid: '/items/marsberry_cake', triggers: null },
                { hrid: '/items/dragon_fruit_yogurt', triggers: null },
                { hrid: '/items/dragon_fruit_gummy', triggers: null },
            ],
            drinks: [
                { hrid: '/items/wisdom_coffee', triggers: null },
                { hrid: '/items/super_magic_coffee', triggers: null },
                { hrid: '/items/channeling_coffee', triggers: null },
            ],
            abilities: [
                { hrid: '/abilities/mystic_aura', level: 40, triggers: null },
                { hrid: '/abilities/elemental_affinity', level: 40, triggers: null },
                { hrid: '/abilities/frost_surge', level: 40, triggers: null },
                { hrid: '/abilities/water_strike', level: 40, triggers: null },
                { hrid: '/abilities/heal', level: 40, triggers: null },
            ],
            houseRooms: {},
        },
    },
    // water-dawn-tier1: from guide: Supreme Over the Laws (wiki)
    {
        id: 'water-dawn-tier1',
        role: 'water_mage',
        tier: 'mid',
        label: 'Water mage, Dawn stage (CL105+), tier 1 upgrade',
        source: 'from guide: Supreme Over the Laws (wiki)',
        playerDto: {
            staminaLevel: 90,
            intelligenceLevel: 90,
            attackLevel: 90,
            meleeLevel: 90,
            defenseLevel: 90,
            rangedLevel: 90,
            magicLevel: 100,
            equipment: {
                '/equipment_types/main_hand': { hrid: '/items/frost_staff', enhancementLevel: 10 },
                '/equipment_types/off_hand': { hrid: '/items/tome_of_the_elements', enhancementLevel: 10 },
                '/equipment_types/head': { hrid: '/items/fluffy_red_hat', enhancementLevel: 5 },
                '/equipment_types/body': { hrid: '/items/icy_robe_top', enhancementLevel: 10 },
                '/equipment_types/legs': { hrid: '/items/icy_robe_bottoms', enhancementLevel: 10 },
                '/equipment_types/hands': { hrid: '/items/chrono_gloves', enhancementLevel: 10 },
                '/equipment_types/feet': { hrid: '/items/sorcerer_boots', enhancementLevel: 10 },
            },
            food: [
                { hrid: '/items/marsberry_cake', triggers: null },
                { hrid: '/items/dragon_fruit_gummy', triggers: null },
                { hrid: '/items/star_fruit_gummy', triggers: null },
            ],
            drinks: [
                { hrid: '/items/wisdom_coffee', triggers: null },
                { hrid: '/items/super_magic_coffee', triggers: null },
                { hrid: '/items/channeling_coffee', triggers: null },
            ],
            abilities: [
                { hrid: '/abilities/mystic_aura', level: 40, triggers: null },
                { hrid: '/abilities/heal', level: 40, triggers: null },
                { hrid: '/abilities/frost_surge', level: 40, triggers: null },
                { hrid: '/abilities/mana_spring', level: 40, triggers: null },
                { hrid: '/abilities/water_strike', level: 40, triggers: null },
            ],
            houseRooms: {},
        },
    },
    // water-supreme-125: from guide: Supreme Over the Laws (wiki)
    {
        id: 'water-supreme-125',
        role: 'water_mage',
        tier: 'late',
        label: 'Water mage, Supreme Over the Laws (CL125+), tier 3 robes',
        source: 'from guide: Supreme Over the Laws (wiki)',
        playerDto: {
            staminaLevel: 120,
            intelligenceLevel: 120,
            attackLevel: 120,
            meleeLevel: 120,
            defenseLevel: 120,
            rangedLevel: 120,
            magicLevel: 120,
            equipment: {
                '/equipment_types/main_hand': { hrid: '/items/frost_staff', enhancementLevel: 10 },
                '/equipment_types/off_hand': { hrid: '/items/bishops_codex', enhancementLevel: 10 },
                '/equipment_types/head': { hrid: '/items/magicians_hat', enhancementLevel: 10 },
                '/equipment_types/body': { hrid: '/items/royal_water_robe_top', enhancementLevel: 10 },
                '/equipment_types/legs': { hrid: '/items/royal_water_robe_bottoms', enhancementLevel: 10 },
                '/equipment_types/hands': { hrid: '/items/chrono_gloves', enhancementLevel: 10 },
                '/equipment_types/feet': { hrid: '/items/sorcerer_boots', enhancementLevel: 10 },
                '/equipment_types/back': { hrid: '/items/enchanted_cloak', enhancementLevel: 5 },
                '/equipment_types/pouch': { hrid: '/items/guzzling_pouch', enhancementLevel: 5 },
            },
            food: [
                { hrid: '/items/marsberry_cake', triggers: null },
                { hrid: '/items/dragon_fruit_gummy', triggers: null },
                { hrid: '/items/star_fruit_gummy', triggers: null },
            ],
            drinks: [
                { hrid: '/items/ultra_magic_coffee', triggers: null },
                { hrid: '/items/channeling_coffee', triggers: null },
                { hrid: '/items/critical_coffee', triggers: null },
            ],
            abilities: [
                { hrid: '/abilities/mystic_aura', level: 70, triggers: null },
                { hrid: '/abilities/heal', level: 70, triggers: null },
                { hrid: '/abilities/frost_surge', level: 70, triggers: null },
                { hrid: '/abilities/mana_spring', level: 70, triggers: null },
                { hrid: '/abilities/water_strike', level: 70, triggers: null },
            ],
            houseRooms: {},
        },
    },
    // tank-bulwark-step10: from guide: Bulwark (Tank) guide (Google doc)
    {
        id: 'tank-bulwark-step10',
        role: 'tank',
        tier: 'mid',
        label: 'Tank (Bulwark), Gobo Tier 1, 90 Int (step 10)',
        source: 'from guide: Bulwark (Tank) guide (Google doc)',
        playerDto: {
            staminaLevel: 90,
            intelligenceLevel: 90,
            attackLevel: 90,
            meleeLevel: 90,
            defenseLevel: 103,
            rangedLevel: 90,
            magicLevel: 90,
            equipment: {
                '/equipment_types/two_hand': { hrid: '/items/spiked_bulwark', enhancementLevel: 5 },
                '/equipment_types/head': { hrid: '/items/fluffy_red_hat', enhancementLevel: 5 },
                '/equipment_types/body': { hrid: '/items/colossus_plate_body', enhancementLevel: 0 },
                '/equipment_types/legs': { hrid: '/items/colossus_plate_legs', enhancementLevel: 0 },
                '/equipment_types/hands': { hrid: '/items/magnetic_gloves', enhancementLevel: 5 },
                '/equipment_types/feet': { hrid: '/items/shoebill_shoes', enhancementLevel: 5 },
                '/equipment_types/neck': { hrid: '/items/necklace_of_wisdom', enhancementLevel: 0 },
                '/equipment_types/ring': { hrid: '/items/ring_of_regeneration', enhancementLevel: 0 },
                '/equipment_types/earrings': { hrid: '/items/earrings_of_regeneration', enhancementLevel: 0 },
            },
            food: [
                { hrid: '/items/spaceberry_cake', triggers: null },
                { hrid: '/items/dragon_fruit_yogurt', triggers: null },
                { hrid: '/items/peach_gummy', triggers: null },
            ],
            drinks: [
                { hrid: '/items/wisdom_coffee', triggers: null },
                { hrid: '/items/super_defense_coffee', triggers: null },
                { hrid: '/items/super_stamina_coffee', triggers: null },
            ],
            abilities: [
                {
                    hrid: '/abilities/invincible',
                    level: 40,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/toughness',
                            comparatorHrid: '/combat_trigger_comparators/is_active',
                            value: 0,
                        },
                    ],
                },
                {
                    hrid: '/abilities/toughness',
                    level: 40,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/targeted_enemy',
                            conditionHrid: '/combat_trigger_conditions/frenzy',
                            comparatorHrid: '/combat_trigger_comparators/is_active',
                            value: 0,
                        },
                    ],
                },
                { hrid: '/abilities/retribution', level: 40, triggers: null },
                { hrid: '/abilities/spike_shell', level: 40, triggers: null },
                { hrid: '/abilities/shield_bash', level: 40, triggers: null },
            ],
            houseRooms: {},
        },
    },
    // tank-bulwark-t95-dungeon: from guide: Bulwark (Tank) guide (Google doc)
    {
        id: 'tank-bulwark-t95-dungeon',
        role: 'tank',
        tier: 'late',
        label: 'Tank (Bulwark), T95 dungeon tank (CL125)',
        source: 'from guide: Bulwark (Tank) guide (Google doc)',
        playerDto: {
            staminaLevel: 125,
            intelligenceLevel: 120,
            attackLevel: 125,
            meleeLevel: 125,
            defenseLevel: 130,
            rangedLevel: 120,
            magicLevel: 120,
            equipment: {
                '/equipment_types/two_hand': { hrid: '/items/griffin_bulwark', enhancementLevel: 7 },
                '/equipment_types/head': { hrid: '/items/corsair_helmet', enhancementLevel: 7 },
                '/equipment_types/body': { hrid: '/items/anchorbound_plate_body', enhancementLevel: 7 },
                '/equipment_types/legs': { hrid: '/items/anchorbound_plate_legs', enhancementLevel: 7 },
                '/equipment_types/hands': { hrid: '/items/dodocamel_gauntlets', enhancementLevel: 7 },
                '/equipment_types/feet': { hrid: '/items/pathbreaker_boots', enhancementLevel: 7 },
                '/equipment_types/back': { hrid: '/items/sinister_cape', enhancementLevel: 0 },
                '/equipment_types/neck': { hrid: '/items/philosophers_necklace', enhancementLevel: 0 },
                '/equipment_types/ring': { hrid: '/items/philosophers_ring', enhancementLevel: 0 },
                '/equipment_types/earrings': { hrid: '/items/philosophers_earrings', enhancementLevel: 0 },
            },
            food: [
                { hrid: '/items/spaceberry_cake', triggers: null },
                { hrid: '/items/dragon_fruit_yogurt', triggers: null },
                { hrid: '/items/peach_gummy', triggers: null },
            ],
            drinks: [
                { hrid: '/items/super_defense_coffee', triggers: null },
                { hrid: '/items/super_stamina_coffee', triggers: null },
                { hrid: '/items/swiftness_coffee', triggers: null },
            ],
            abilities: [
                {
                    hrid: '/abilities/invincible',
                    level: 40,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/self',
                            conditionHrid: '/combat_trigger_conditions/toughness',
                            comparatorHrid: '/combat_trigger_comparators/is_active',
                            value: 0,
                        },
                    ],
                },
                {
                    hrid: '/abilities/toughness',
                    level: 70,
                    triggers: [
                        {
                            dependencyHrid: '/combat_trigger_dependencies/targeted_enemy',
                            conditionHrid: '/combat_trigger_conditions/frenzy',
                            comparatorHrid: '/combat_trigger_comparators/is_active',
                            value: 0,
                        },
                    ],
                },
                { hrid: '/abilities/provoke', level: 70, triggers: null },
                { hrid: '/abilities/elusiveness', level: 70, triggers: null },
                { hrid: '/abilities/quick_aid', level: 70, triggers: null },
            ],
            houseRooms: {},
        },
    },
    // lab-melee-stab: MillenniumTest lab build
    {
        id: 'lab-melee-stab',
        role: 'melee_stab',
        tier: 'endgame',
        label: 'Melee stab, endgame [MillenniumTest lab loadout]',
        source: 'MillenniumTest lab build',
        playerDto: {
            staminaLevel: 200,
            intelligenceLevel: 200,
            attackLevel: 200,
            meleeLevel: 200,
            defenseLevel: 200,
            rangedLevel: 200,
            magicLevel: 200,
            equipment: {
                '/equipment_types/back': { hrid: '/items/sinister_cape_refined', enhancementLevel: 0 },
                '/equipment_types/body': { hrid: '/items/maelstrom_plate_body_refined', enhancementLevel: 0 },
                '/equipment_types/charm': { hrid: '/items/grandmaster_melee_charm', enhancementLevel: 0 },
                '/equipment_types/earrings': { hrid: '/items/philosophers_earrings', enhancementLevel: 15 },
                '/equipment_types/feet': { hrid: '/items/pathbreaker_boots_refined', enhancementLevel: 20 },
                '/equipment_types/hands': { hrid: '/items/dodocamel_gauntlets_refined', enhancementLevel: 0 },
                '/equipment_types/head': { hrid: '/items/corsair_helmet_refined', enhancementLevel: 10 },
                '/equipment_types/legs': { hrid: '/items/maelstrom_plate_legs_refined', enhancementLevel: 0 },
                '/equipment_types/main_hand': { hrid: '/items/furious_spear_refined', enhancementLevel: 15 },
                '/equipment_types/neck': { hrid: '/items/philosophers_necklace', enhancementLevel: 15 },
                '/equipment_types/off_hand': { hrid: '/items/knights_aegis_refined', enhancementLevel: 10 },
                '/equipment_types/pouch': { hrid: '/items/guzzling_pouch', enhancementLevel: 0 },
                '/equipment_types/ring': { hrid: '/items/philosophers_ring', enhancementLevel: 15 },
                '/equipment_types/trinket': { hrid: '/items/expert_task_badge', enhancementLevel: 0 },
            },
            food: [
                { hrid: '/items/spaceberry_cake', triggers: null },
                { hrid: '/items/star_fruit_yogurt', triggers: null },
                { hrid: '/items/star_fruit_gummy', triggers: null },
            ],
            drinks: [
                { hrid: '/items/wisdom_coffee', triggers: null },
                { hrid: '/items/ultra_melee_coffee', triggers: null },
                { hrid: '/items/swiftness_coffee', triggers: null },
            ],
            abilities: [
                { hrid: '/abilities/fierce_aura', level: 200, triggers: null },
                { hrid: '/abilities/frenzy', level: 200, triggers: null },
                { hrid: '/abilities/berserk', level: 200, triggers: null },
                { hrid: '/abilities/puncture', level: 200, triggers: null },
                { hrid: '/abilities/penetrating_strike', level: 200, triggers: null },
            ],
            houseRooms: {},
        },
    },
    // lab-melee-slash: MillenniumTest lab build
    {
        id: 'lab-melee-slash',
        role: 'melee_slash',
        tier: 'endgame',
        label: 'Melee slash, endgame [MillenniumTest lab loadout]',
        source: 'MillenniumTest lab build',
        playerDto: {
            staminaLevel: 200,
            intelligenceLevel: 200,
            attackLevel: 200,
            meleeLevel: 200,
            defenseLevel: 200,
            rangedLevel: 200,
            magicLevel: 200,
            equipment: {
                '/equipment_types/back': { hrid: '/items/sinister_cape_refined', enhancementLevel: 0 },
                '/equipment_types/body': { hrid: '/items/maelstrom_plate_body_refined', enhancementLevel: 0 },
                '/equipment_types/charm': { hrid: '/items/grandmaster_melee_charm', enhancementLevel: 0 },
                '/equipment_types/earrings': { hrid: '/items/philosophers_earrings', enhancementLevel: 0 },
                '/equipment_types/feet': { hrid: '/items/pathbreaker_boots_refined', enhancementLevel: 20 },
                '/equipment_types/hands': { hrid: '/items/dodocamel_gauntlets_refined', enhancementLevel: 0 },
                '/equipment_types/head': { hrid: '/items/corsair_helmet_refined', enhancementLevel: 0 },
                '/equipment_types/legs': { hrid: '/items/maelstrom_plate_legs_refined', enhancementLevel: 0 },
                '/equipment_types/main_hand': { hrid: '/items/regal_sword_refined', enhancementLevel: 0 },
                '/equipment_types/neck': { hrid: '/items/philosophers_necklace', enhancementLevel: 0 },
                '/equipment_types/off_hand': { hrid: '/items/knights_aegis_refined', enhancementLevel: 0 },
                '/equipment_types/pouch': { hrid: '/items/guzzling_pouch', enhancementLevel: 0 },
                '/equipment_types/ring': { hrid: '/items/philosophers_ring', enhancementLevel: 0 },
                '/equipment_types/trinket': { hrid: '/items/expert_task_badge', enhancementLevel: 0 },
            },
            food: [
                { hrid: '/items/spaceberry_cake', triggers: null },
                { hrid: '/items/star_fruit_yogurt', triggers: null },
                { hrid: '/items/star_fruit_gummy', triggers: null },
            ],
            drinks: [
                { hrid: '/items/wisdom_coffee', triggers: null },
                { hrid: '/items/ultra_melee_coffee', triggers: null },
                { hrid: '/items/swiftness_coffee', triggers: null },
            ],
            abilities: [
                { hrid: '/abilities/fierce_aura', level: 200, triggers: null },
                { hrid: '/abilities/frenzy', level: 200, triggers: null },
                { hrid: '/abilities/berserk', level: 200, triggers: null },
                { hrid: '/abilities/maim', level: 200, triggers: null },
                { hrid: '/abilities/crippling_slash', level: 200, triggers: null },
            ],
            houseRooms: {},
        },
    },
    // lab-ranged: MillenniumTest lab build
    {
        id: 'lab-ranged',
        role: 'ranged',
        tier: 'endgame',
        label: 'Ranged, endgame [MillenniumTest lab loadout]',
        source: 'MillenniumTest lab build',
        playerDto: {
            staminaLevel: 200,
            intelligenceLevel: 200,
            attackLevel: 200,
            meleeLevel: 200,
            defenseLevel: 200,
            rangedLevel: 200,
            magicLevel: 200,
            equipment: {
                '/equipment_types/back': { hrid: '/items/chimerical_quiver_refined', enhancementLevel: 0 },
                '/equipment_types/body': { hrid: '/items/kraken_tunic_refined', enhancementLevel: 0 },
                '/equipment_types/charm': { hrid: '/items/grandmaster_ranged_charm', enhancementLevel: 0 },
                '/equipment_types/earrings': { hrid: '/items/philosophers_earrings', enhancementLevel: 0 },
                '/equipment_types/feet': { hrid: '/items/pathfinder_boots_refined', enhancementLevel: 0 },
                '/equipment_types/hands': { hrid: '/items/marksman_bracers_refined', enhancementLevel: 0 },
                '/equipment_types/head': { hrid: '/items/acrobatic_hood_refined', enhancementLevel: 0 },
                '/equipment_types/legs': { hrid: '/items/kraken_chaps_refined', enhancementLevel: 0 },
                '/equipment_types/main_hand': { hrid: '/items/sundering_crossbow_refined', enhancementLevel: 20 },
                '/equipment_types/neck': { hrid: '/items/philosophers_necklace', enhancementLevel: 0 },
                '/equipment_types/off_hand': { hrid: '/items/manticore_shield', enhancementLevel: 20 },
                '/equipment_types/pouch': { hrid: '/items/guzzling_pouch', enhancementLevel: 0 },
                '/equipment_types/ring': { hrid: '/items/philosophers_ring', enhancementLevel: 0 },
                '/equipment_types/trinket': { hrid: '/items/expert_task_badge', enhancementLevel: 0 },
            },
            food: [
                { hrid: '/items/spaceberry_cake', triggers: null },
                { hrid: '/items/star_fruit_yogurt', triggers: null },
                { hrid: '/items/star_fruit_gummy', triggers: null },
            ],
            drinks: [
                { hrid: '/items/wisdom_coffee', triggers: null },
                { hrid: '/items/ultra_ranged_coffee', triggers: null },
                { hrid: '/items/swiftness_coffee', triggers: null },
            ],
            abilities: [
                { hrid: '/abilities/critical_aura', level: 200, triggers: null },
                { hrid: '/abilities/berserk', level: 200, triggers: null },
                { hrid: '/abilities/frenzy', level: 200, triggers: null },
                { hrid: '/abilities/pestilent_shot', level: 200, triggers: null },
                { hrid: '/abilities/steady_shot', level: 200, triggers: null },
            ],
            houseRooms: {},
        },
    },
    // lab-nature: MillenniumTest lab build
    {
        id: 'lab-nature',
        role: 'nature_mage',
        tier: 'endgame',
        label: 'Nature mage, endgame [MillenniumTest lab loadout]',
        source: 'MillenniumTest lab build',
        playerDto: {
            staminaLevel: 200,
            intelligenceLevel: 200,
            attackLevel: 200,
            meleeLevel: 200,
            defenseLevel: 200,
            rangedLevel: 200,
            magicLevel: 200,
            equipment: {
                '/equipment_types/back': { hrid: '/items/enchanted_cloak_refined', enhancementLevel: 0 },
                '/equipment_types/body': { hrid: '/items/royal_nature_robe_top_refined', enhancementLevel: 20 },
                '/equipment_types/charm': { hrid: '/items/grandmaster_magic_charm', enhancementLevel: 0 },
                '/equipment_types/earrings': { hrid: '/items/philosophers_earrings', enhancementLevel: 0 },
                '/equipment_types/feet': { hrid: '/items/pathseeker_boots_refined', enhancementLevel: 0 },
                '/equipment_types/hands': { hrid: '/items/chrono_gloves', enhancementLevel: 20 },
                '/equipment_types/head': { hrid: '/items/magicians_hat_refined', enhancementLevel: 20 },
                '/equipment_types/legs': { hrid: '/items/royal_nature_robe_bottoms_refined', enhancementLevel: 20 },
                '/equipment_types/main_hand': { hrid: '/items/blooming_trident_refined', enhancementLevel: 20 },
                '/equipment_types/neck': { hrid: '/items/philosophers_necklace', enhancementLevel: 0 },
                '/equipment_types/off_hand': { hrid: '/items/bishops_codex_refined', enhancementLevel: 20 },
                '/equipment_types/pouch': { hrid: '/items/guzzling_pouch', enhancementLevel: 0 },
                '/equipment_types/ring': { hrid: '/items/philosophers_ring', enhancementLevel: 0 },
                '/equipment_types/trinket': { hrid: '/items/expert_task_badge', enhancementLevel: 0 },
            },
            food: [
                { hrid: '/items/spaceberry_cake', triggers: null },
                { hrid: '/items/star_fruit_yogurt', triggers: null },
                { hrid: '/items/star_fruit_gummy', triggers: null },
            ],
            drinks: [
                { hrid: '/items/wisdom_coffee', triggers: null },
                { hrid: '/items/ultra_magic_coffee', triggers: null },
                { hrid: '/items/channeling_coffee', triggers: null },
            ],
            abilities: [
                { hrid: '/abilities/mystic_aura', level: 200, triggers: null },
                { hrid: '/abilities/elemental_affinity', level: 200, triggers: null },
                { hrid: '/abilities/toxic_pollen', level: 200, triggers: null },
                { hrid: '/abilities/life_drain', level: 200, triggers: null },
                { hrid: '/abilities/entangle', level: 200, triggers: null },
            ],
            houseRooms: {},
        },
    },
    // lab-fire: MillenniumTest lab build
    {
        id: 'lab-fire',
        role: 'fire_mage',
        tier: 'endgame',
        label: 'Fire mage, endgame ("Fire Trial" loadout) [MillenniumTest lab loadout]',
        source: 'MillenniumTest lab build',
        playerDto: {
            staminaLevel: 200,
            intelligenceLevel: 200,
            attackLevel: 200,
            meleeLevel: 200,
            defenseLevel: 200,
            rangedLevel: 200,
            magicLevel: 200,
            equipment: {
                '/equipment_types/back': { hrid: '/items/enchanted_cloak_refined', enhancementLevel: 10 },
                '/equipment_types/body': { hrid: '/items/royal_fire_robe_top_refined', enhancementLevel: 20 },
                '/equipment_types/charm': { hrid: '/items/grandmaster_magic_charm', enhancementLevel: 0 },
                '/equipment_types/earrings': { hrid: '/items/philosophers_earrings', enhancementLevel: 20 },
                '/equipment_types/feet': { hrid: '/items/pathseeker_boots_refined', enhancementLevel: 20 },
                '/equipment_types/hands': { hrid: '/items/chrono_gloves', enhancementLevel: 20 },
                '/equipment_types/head': { hrid: '/items/magicians_hat_refined', enhancementLevel: 20 },
                '/equipment_types/legs': { hrid: '/items/royal_fire_robe_bottoms_refined', enhancementLevel: 20 },
                '/equipment_types/main_hand': { hrid: '/items/blazing_trident_refined', enhancementLevel: 20 },
                '/equipment_types/neck': { hrid: '/items/philosophers_necklace', enhancementLevel: 20 },
                '/equipment_types/off_hand': { hrid: '/items/bishops_codex_refined', enhancementLevel: 20 },
                '/equipment_types/pouch': { hrid: '/items/guzzling_pouch', enhancementLevel: 0 },
                '/equipment_types/ring': { hrid: '/items/philosophers_ring', enhancementLevel: 0 },
                '/equipment_types/trinket': { hrid: '/items/expert_task_badge', enhancementLevel: 0 },
            },
            food: [
                { hrid: '/items/spaceberry_cake', triggers: null },
                { hrid: '/items/star_fruit_yogurt', triggers: null },
                { hrid: '/items/star_fruit_gummy', triggers: null },
            ],
            drinks: [
                { hrid: '/items/wisdom_coffee', triggers: null },
                { hrid: '/items/ultra_magic_coffee', triggers: null },
                { hrid: '/items/channeling_coffee', triggers: null },
            ],
            abilities: [
                { hrid: '/abilities/insanity', level: 200, triggers: null },
                { hrid: '/abilities/elemental_affinity', level: 200, triggers: null },
                { hrid: '/abilities/smoke_burst', level: 200, triggers: null },
                { hrid: '/abilities/firestorm', level: 200, triggers: null },
                { hrid: '/abilities/fireball', level: 200, triggers: null },
            ],
            houseRooms: {},
        },
    },
    // lab-water: MillenniumTest lab build
    {
        id: 'lab-water',
        role: 'water_mage',
        tier: 'endgame',
        label: 'Water mage, endgame [MillenniumTest lab loadout]',
        source: 'MillenniumTest lab build',
        playerDto: {
            staminaLevel: 200,
            intelligenceLevel: 200,
            attackLevel: 200,
            meleeLevel: 200,
            defenseLevel: 200,
            rangedLevel: 200,
            magicLevel: 200,
            equipment: {
                '/equipment_types/back': { hrid: '/items/enchanted_cloak_refined', enhancementLevel: 0 },
                '/equipment_types/body': { hrid: '/items/royal_water_robe_top_refined', enhancementLevel: 10 },
                '/equipment_types/charm': { hrid: '/items/grandmaster_magic_charm', enhancementLevel: 0 },
                '/equipment_types/earrings': { hrid: '/items/philosophers_earrings', enhancementLevel: 0 },
                '/equipment_types/feet': { hrid: '/items/pathseeker_boots_refined', enhancementLevel: 0 },
                '/equipment_types/hands': { hrid: '/items/chrono_gloves', enhancementLevel: 0 },
                '/equipment_types/head': { hrid: '/items/magicians_hat_refined', enhancementLevel: 10 },
                '/equipment_types/legs': { hrid: '/items/royal_water_robe_bottoms_refined', enhancementLevel: 10 },
                '/equipment_types/main_hand': { hrid: '/items/rippling_trident_refined', enhancementLevel: 20 },
                '/equipment_types/neck': { hrid: '/items/philosophers_necklace', enhancementLevel: 0 },
                '/equipment_types/off_hand': { hrid: '/items/bishops_codex_refined', enhancementLevel: 10 },
                '/equipment_types/pouch': { hrid: '/items/guzzling_pouch', enhancementLevel: 0 },
                '/equipment_types/ring': { hrid: '/items/philosophers_ring', enhancementLevel: 0 },
                '/equipment_types/trinket': { hrid: '/items/expert_task_badge', enhancementLevel: 0 },
            },
            food: [
                { hrid: '/items/spaceberry_cake', triggers: null },
                { hrid: '/items/star_fruit_yogurt', triggers: null },
                { hrid: '/items/star_fruit_gummy', triggers: null },
            ],
            drinks: [
                { hrid: '/items/wisdom_coffee', triggers: null },
                { hrid: '/items/ultra_magic_coffee', triggers: null },
                { hrid: '/items/channeling_coffee', triggers: null },
            ],
            abilities: [
                { hrid: '/abilities/mystic_aura', level: 200, triggers: null },
                { hrid: '/abilities/elemental_affinity', level: 200, triggers: null },
                { hrid: '/abilities/frost_surge', level: 200, triggers: null },
                { hrid: '/abilities/mana_spring', level: 200, triggers: null },
                { hrid: '/abilities/water_strike', level: 200, triggers: null },
            ],
            houseRooms: {},
        },
    },
    // lab-tank: MillenniumTest lab build
    {
        id: 'lab-tank',
        role: 'tank',
        tier: 'endgame',
        label: 'Tank (Wark), endgame [MillenniumTest lab loadout]',
        source: 'MillenniumTest lab build',
        playerDto: {
            staminaLevel: 200,
            intelligenceLevel: 200,
            attackLevel: 200,
            meleeLevel: 200,
            defenseLevel: 200,
            rangedLevel: 200,
            magicLevel: 200,
            equipment: {
                '/equipment_types/back': { hrid: '/items/sinister_cape_refined', enhancementLevel: 0 },
                '/equipment_types/body': { hrid: '/items/anchorbound_plate_body_refined', enhancementLevel: 0 },
                '/equipment_types/charm': { hrid: '/items/grandmaster_defense_charm', enhancementLevel: 0 },
                '/equipment_types/earrings': { hrid: '/items/philosophers_earrings', enhancementLevel: 0 },
                '/equipment_types/feet': { hrid: '/items/pathbreaker_boots_refined', enhancementLevel: 0 },
                '/equipment_types/hands': { hrid: '/items/dodocamel_gauntlets_refined', enhancementLevel: 0 },
                '/equipment_types/head': { hrid: '/items/corsair_helmet_refined', enhancementLevel: 0 },
                '/equipment_types/legs': { hrid: '/items/anchorbound_plate_legs_refined', enhancementLevel: 0 },
                '/equipment_types/neck': { hrid: '/items/philosophers_necklace', enhancementLevel: 0 },
                '/equipment_types/pouch': { hrid: '/items/guzzling_pouch', enhancementLevel: 0 },
                '/equipment_types/ring': { hrid: '/items/philosophers_ring', enhancementLevel: 0 },
                '/equipment_types/trinket': { hrid: '/items/expert_task_badge', enhancementLevel: 0 },
                '/equipment_types/two_hand': { hrid: '/items/griffin_bulwark_refined', enhancementLevel: 20 },
            },
            food: [
                { hrid: '/items/spaceberry_cake', triggers: null },
                { hrid: '/items/star_fruit_yogurt', triggers: null },
                { hrid: '/items/star_fruit_gummy', triggers: null },
            ],
            drinks: [
                { hrid: '/items/wisdom_coffee', triggers: null },
                { hrid: '/items/ultra_defense_coffee', triggers: null },
                { hrid: '/items/lucky_coffee', triggers: null },
            ],
            abilities: [
                { hrid: '/abilities/invincible', level: 200, triggers: null },
                { hrid: '/abilities/retribution', level: 200, triggers: null },
                { hrid: '/abilities/spike_shell', level: 200, triggers: null },
                { hrid: '/abilities/precision', level: 200, triggers: null },
                { hrid: '/abilities/toughness', level: 200, triggers: null },
            ],
            houseRooms: {},
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
