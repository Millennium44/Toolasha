/**
 * Ground truth for the Combat Sim talisman lines, captured live on the test server (character 30404, 2026-11-12).
 * The character wore woodcutting gear with a Large Talisman Belt +10 (talismanPower 0.258) and the three combat
 * talismans of its Melee - Stab loadout in slots 1..3. `SERVER_COMBAT_STATS` is `combatDetails.combatStats` as the
 * server sent it; `PRE_TALISMAN_STATS` is the same gear's stats before those talismans were slotted (the capture's
 * note). The item definitions of the worn gear are not part of the capture, so a test stands in a single piece
 * carrying the server's own stats minus the talisman share.
 */

export const BELT = { hrid: '/items/large_talisman_belt', enhancementLevel: 10 };

/** characterData.characterTalismans rows that were slotted (slotIndex 1..3), as the wire sent them */
export const SLOTTED_TALISMANS = [
    {
        id: 2907,
        talismanTypeHrid: '/talisman_types/combat',
        modifiers: [
            { hrid: '/talisman_modifiers/magic_damage', grade: 1 },
            { hrid: '/talisman_modifiers/threat_reduction', grade: 1 },
            { hrid: '/talisman_modifiers/smite', grade: 3 },
            { hrid: '/talisman_modifiers/combat_experience', grade: 3 },
        ],
        slotIndex: 1,
    },
    {
        id: 2804,
        talismanTypeHrid: '/talisman_types/combat',
        modifiers: [{ hrid: '/talisman_modifiers/damage_taken', grade: 2 }],
        slotIndex: 2,
    },
    {
        id: 2624,
        talismanTypeHrid: '/talisman_types/combat',
        modifiers: [
            { hrid: '/talisman_modifiers/armor', grade: 1 },
            { hrid: '/talisman_modifiers/combat_drop_rate', grade: 1 },
            { hrid: '/talisman_modifiers/physical_amplify', grade: 2 },
            { hrid: '/talisman_modifiers/critical_damage', grade: 3 },
        ],
        slotIndex: 3,
    },
];

/** Owned but not slotted */
export const UNSLOTTED_TALISMANS = [
    {
        id: 2801,
        talismanTypeHrid: '/talisman_types/combat',
        modifiers: [{ hrid: '/talisman_modifiers/healing_amplify', grade: 1 }],
        slotIndex: 0,
    },
    {
        id: 2837,
        talismanTypeHrid: '/talisman_types/skilling',
        modifiers: [{ hrid: '/talisman_modifiers/milking_speed', grade: 2 }],
        slotIndex: 0,
    },
];

/** The stats the talismans moved, as they were before slotting (the capture's note) */
export const PRE_TALISMAN_STATS = {
    magicDamage: 1.32,
    armor: 72,
    combatExperience: 0.18,
};

/** combatDetails.combatStats from the server, numeric entries only */
export const SERVER_COMBAT_STATS = {
    autoAttackDamage: -0.5,
    castSpeed: 0.18,
    criticalRate: 0.24000000000000002,
    criticalDamage: 0.037739999999999996,
    stabAccuracy: 0.24000000000000002,
    slashAccuracy: 0.24000000000000002,
    smashAccuracy: 0.24000000000000002,
    rangedAccuracy: 0.24000000000000002,
    magicAccuracy: 2.508,
    stabDamage: 0.24000000000000002,
    slashDamage: 0.24000000000000002,
    smashDamage: 0.24000000000000002,
    rangedDamage: 0.24000000000000002,
    magicDamage: 1.3577400000000002,
    defensiveDamage: 0.24000000000000002,
    taskDamage: 0.9,
    physicalAmplify: 0.018869999999999998,
    waterAmplify: 0.648,
    waterPenetration: 0.216,
    maxHitpoints: 500,
    maxManapoints: 500,
    armor: 74.516,
    waterResistance: 72,
    natureResistance: 72,
    fireResistance: 72,
    damageTaken: -0.009434999999999999,
    threat: -5.032,
    hpRegenPer10: 0.034,
    mpRegenPer10: 0.034,
    drinkConcentration: 0.2,
    combatDropRate: 0.012580000000000001,
    combatRareFind: 0.9600000000000001,
    combatExperience: 0.20516,
    meleeExperience: 0.48000000000000004,
    talismanSlots: 3,
    talismanPower: 0.258,
    ripple: 0.2,
    smite: 0.07548,
};
