/**
 * Party lint.
 *
 * The detectors moved here from the sim UI, exercised on the shapes they have
 * to tell apart — plus the live-battle mapper, whose whole job is honesty:
 * abilities for everyone from the payload, equipment for the current player
 * only, and nothing invented for anybody else.
 */

import { describe, test, expect } from 'vitest';

import {
    isSkillingGearItem,
    isAuraAbility,
    skillingGearWarnings,
    duplicateAuraWarnings,
    partyLintWarnings,
    battleLintInputs,
} from './party-lint.js';

/**
 * Game data: a skilling tool, a skilling top, a combat sword, a real aura,
 * a self-only special and a plain damage ability.
 */
const GAME_DATA = {
    itemDetailMap: {
        '/items/foraging_shears': {
            name: 'Foraging Shears',
            equipmentDetail: {
                type: '/equipment_types/foraging_tool',
                combatStats: { attackInterval: 0 },
                noncombatStats: { foragingSpeed: 0.3 },
            },
        },
        '/items/foragers_top': {
            name: "Forager's Top",
            equipmentDetail: {
                type: '/equipment_types/body',
                combatStats: {},
                noncombatStats: { foragingExperience: 0.1 },
            },
        },
        '/items/vampiric_sword': {
            name: 'Vampiric Sword',
            equipmentDetail: {
                type: '/equipment_types/main_hand',
                combatStats: { attackInterval: 3e9, lifeSteal: 0.05 },
                noncombatStats: { foragingSpeed: 0 },
            },
        },
    },
    abilityDetailMap: {
        '/abilities/fierce_aura': {
            name: 'Fierce Aura',
            isSpecialAbility: true,
            abilityEffects: [
                {
                    targetType: 'allAllies',
                    effectType: '/ability_effect_types/buff',
                    buffs: [{ uniqueHrid: '/buff_uniques/fierce_aura' }],
                },
            ],
        },
        '/abilities/vampirism': {
            name: 'Vampirism',
            isSpecialAbility: true,
            abilityEffects: [
                {
                    targetType: 'self',
                    effectType: '/ability_effect_types/buff',
                    buffs: [{ uniqueHrid: '/buff_uniques/vampirism' }],
                },
            ],
        },
        '/abilities/sweep': {
            name: 'Sweep',
            isSpecialAbility: false,
            abilityEffects: [{ targetType: 'enemy', effectType: '/ability_effect_types/damage', buffs: null }],
        },
    },
};

const INFO = [
    { hrid: 'player1', name: 'Mazo' },
    { hrid: 'player2', name: 'Irokez' },
    { hrid: 'player3', name: 'Tib' },
];

/** A party member DTO with just the fields the lint reads. */
function partyMember(hrid, { equipment = {}, abilities = [] } = {}) {
    return { hrid, equipment, abilities };
}

describe('the predicates read the stats, not the names', () => {
    test('skilling gear is noncombat stats without combat ones', () => {
        expect(isSkillingGearItem(GAME_DATA.itemDetailMap['/items/foraging_shears'])).toBe(true);
        expect(isSkillingGearItem(GAME_DATA.itemDetailMap['/items/vampiric_sword'])).toBe(false);
        expect(isSkillingGearItem(undefined)).toBe(false);
    });

    test('an aura is a special whose buff reaches every ally', () => {
        expect(isAuraAbility(GAME_DATA.abilityDetailMap['/abilities/fierce_aura'])).toBe(true);
        expect(isAuraAbility(GAME_DATA.abilityDetailMap['/abilities/vampirism'])).toBe(false);
        expect(isAuraAbility(GAME_DATA.abilityDetailMap['/abilities/sweep'])).toBe(false);
        expect(isAuraAbility(undefined)).toBe(false);
    });
});

describe('linting a party', () => {
    test('a member wearing skilling gear in a combat slot is named, tools are not', () => {
        // The shears live in a tool slot, which has no combat equivalent and is
        // always occupied — never a mistake. The top displaces real armour.
        const party = [
            partyMember('player1', {
                equipment: {
                    '/equipment_types/foraging_tool': { hrid: '/items/foraging_shears', enhancementLevel: 5 },
                    '/equipment_types/body': { hrid: '/items/foragers_top', enhancementLevel: 3 },
                    '/equipment_types/main_hand': { hrid: '/items/vampiric_sword', enhancementLevel: 8 },
                },
            }),
            partyMember('player2'),
        ];

        expect(skillingGearWarnings(party, INFO, GAME_DATA.itemDetailMap)).toEqual([
            "Mazo has skilling gear equipped: Forager's Top",
        ]);
    });

    test('the same aura on two members is one warning naming both', () => {
        const party = [
            partyMember('player1', { abilities: [{ hrid: '/abilities/fierce_aura', level: 40 }, null] }),
            partyMember('player2', { abilities: [{ hrid: '/abilities/fierce_aura', level: 55 }, null] }),
        ];

        expect(duplicateAuraWarnings(party, INFO, GAME_DATA.abilityDetailMap)).toEqual([
            'Fierce Aura is equipped by Mazo and Irokez — auras do not stack',
        ]);
    });

    test('a self-only special on two members is left alone', () => {
        const party = [
            partyMember('player1', { abilities: [{ hrid: '/abilities/vampirism', level: 40 }] }),
            partyMember('player2', { abilities: [{ hrid: '/abilities/vampirism', level: 55 }] }),
        ];

        expect(duplicateAuraWarnings(party, INFO, GAME_DATA.abilityDetailMap)).toEqual([]);
    });

    test('a solo run produces no warnings at all, whatever is equipped', () => {
        const solo = [
            partyMember('player1', {
                equipment: { '/equipment_types/body': { hrid: '/items/foragers_top' } },
                abilities: [{ hrid: '/abilities/fierce_aura', level: 40 }],
            }),
        ];

        expect(partyLintWarnings(solo, INFO, GAME_DATA)).toEqual([]);
    });

    test('a party collects both kinds of warning through one call', () => {
        const party = [
            partyMember('player1', {
                equipment: { '/equipment_types/body': { hrid: '/items/foragers_top' } },
                abilities: [{ hrid: '/abilities/fierce_aura', level: 40 }],
            }),
            partyMember('player2', { abilities: [{ hrid: '/abilities/fierce_aura', level: 55 }] }),
            partyMember('player3', { abilities: [{ hrid: '/abilities/fierce_aura', level: 12 }] }),
        ];

        expect(partyLintWarnings(party, INFO, GAME_DATA)).toEqual([
            "Mazo has skilling gear equipped: Forager's Top",
            'Fierce Aura is equipped by Mazo, Irokez and Tib — auras do not stack',
        ]);
    });
});

describe('mapping a live battle to lint inputs', () => {
    /** A `new_battle` player: named, with the whole equipped kit. */
    const battlePlayer = (id, name, abilities) => ({
        character: { id, name },
        combatDetails: { combatAbilities: abilities },
    });

    const battle = {
        players: [
            battlePlayer(11, 'Mazo', [
                { abilityHrid: '/abilities/fierce_aura', level: 40 },
                { abilityHrid: '/abilities/sweep', level: 60 },
            ]),
            battlePlayer(22, 'Irokez', [{ abilityHrid: '/abilities/fierce_aura', level: 55 }]),
        ],
    };

    test('names come from the payload and hrids number the slots', () => {
        const { playerInfo } = battleLintInputs(battle);

        expect(playerInfo).toEqual([
            { hrid: 'player1', name: 'Mazo' },
            { hrid: 'player2', name: 'Irokez' },
        ]);
    });

    test('abilities are filled for everyone from the equipped kit', () => {
        const { playerDTOs } = battleLintInputs(battle);

        expect(playerDTOs[0].abilities).toEqual([
            { hrid: '/abilities/fierce_aura', level: 40 },
            { hrid: '/abilities/sweep', level: 60 },
        ]);
        expect(playerDTOs[1].abilities).toEqual([{ hrid: '/abilities/fierce_aura', level: 55 }]);
    });

    test('equipment is filled only for the current player, keyed by slot type', () => {
        // The payload carries nobody's wearables, so everyone else's equipment
        // stays empty rather than being guessed from a stale profile
        const { playerDTOs } = battleLintInputs(battle, {
            currentCharacterId: 11,
            ownEquipment: [
                { itemHrid: '/items/foragers_top', enhancementLevel: 3 },
                { itemHrid: '/items/unknown_trinket', enhancementLevel: 1 },
            ],
            itemDetailMap: GAME_DATA.itemDetailMap,
        });

        expect(playerDTOs[0].equipment).toEqual({
            '/equipment_types/body': { hrid: '/items/foragers_top', enhancementLevel: 3 },
        });
        expect(playerDTOs[1].equipment).toEqual({});
    });

    test('without an identity nobody gets equipment', () => {
        const { playerDTOs } = battleLintInputs(battle, {
            ownEquipment: [{ itemHrid: '/items/foragers_top' }],
            itemDetailMap: GAME_DATA.itemDetailMap,
        });

        expect(playerDTOs.every((dto) => Object.keys(dto.equipment).length === 0)).toBe(true);
    });

    test('a battle that names nobody maps to nothing', () => {
        expect(battleLintInputs(null)).toEqual({ playerDTOs: [], playerInfo: [] });
        expect(battleLintInputs({ players: [] })).toEqual({ playerDTOs: [], playerInfo: [] });
    });

    test('the mapped party runs through the lint end to end', () => {
        const { playerDTOs, playerInfo } = battleLintInputs(battle, {
            currentCharacterId: 11,
            ownEquipment: [{ itemHrid: '/items/foragers_top', enhancementLevel: 3 }],
            itemDetailMap: GAME_DATA.itemDetailMap,
        });

        expect(partyLintWarnings(playerDTOs, playerInfo, GAME_DATA)).toEqual([
            "Mazo has skilling gear equipped: Forager's Top",
            'Fierce Aura is equipped by Mazo and Irokez — auras do not stack',
        ]);
    });
});
