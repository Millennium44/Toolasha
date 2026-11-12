/**
 * Talisman combat lines in the sim engine.
 *
 * The acceptance check is the live capture of character 30404 (src/__fixtures__/talisman-3a-30404.js): a Large
 * Talisman Belt +10 and three combat talismans, where the server's own combatStats are the truth. The capture does
 * not carry the worn gear's item definitions, so a single stand-in piece carries the server's stats minus the
 * talisman share; what is checked is that the engine adds exactly the talisman share on top, for every stat the
 * server reports. Equality of the gear half against real item definitions is not covered here.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import Player, { TALISMAN_MODELED_STATS } from './player.js';
import { setGameData } from './game-data.js';
import { computeTalismanCombat, TALISMAN_MECHANICS } from './talisman-combat.js';
import { BELT_ITEMS, TALISMAN_ENHANCEMENT_TABLE } from '../../../__fixtures__/talisman-bonuses.js';
import { COMBAT_MODIFIER_DETAILS } from '../../../__fixtures__/talisman-combat-modifiers.js';
import {
    BELT,
    SLOTTED_TALISMANS,
    UNSLOTTED_TALISMANS,
    PRE_TALISMAN_STATS,
    SERVER_COMBAT_STATS,
} from '../../../__fixtures__/talisman-3a-30404.js';

const LARGE = '/items/large_talisman_belt';
const SMALL = '/items/small_talisman_belt';

/** The server's stats minus the talisman share: what the worn gear gives on its own */
function gearStats() {
    const gear = { ...SERVER_COMBAT_STATS, ...PRE_TALISMAN_STATS };
    for (const key of [
        'talismanSlots',
        'talismanPower',
        'smite',
        'damageTaken',
        'threat',
        'criticalDamage',
        'physicalAmplify',
        'combatDropRate',
    ]) {
        delete gear[key];
    }
    return gear;
}

function gameData(overrides = {}) {
    return {
        talismansEnabled: true,
        enhancementLevelTotalBonusMultiplierTable: TALISMAN_ENHANCEMENT_TABLE,
        talismanModifierDetailMap: COMBAT_MODIFIER_DETAILS,
        itemDetailMap: {
            ...BELT_ITEMS,
            '/items/test_body': {
                name: 'Test Body',
                equipmentDetail: { type: '/equipment_types/body', combatStats: gearStats() },
            },
        },
        ...overrides,
    };
}

function dtoFor({ belt = BELT, talismans = SLOTTED_TALISMANS, extraEquipment = {} } = {}) {
    return {
        staminaLevel: 150,
        intelligenceLevel: 150,
        attackLevel: 151,
        meleeLevel: 156,
        defenseLevel: 151,
        rangedLevel: 150,
        magicLevel: 156,
        hrid: 'player1',
        equipment: {
            '/equipment_types/body': { hrid: '/items/test_body', enhancementLevel: 0 },
            ...(belt ? { '/equipment_types/belt': { hrid: belt.hrid, enhancementLevel: belt.enhancementLevel } } : {}),
            ...extraEquipment,
        },
        food: [],
        drinks: [],
        abilities: [],
        houseRooms: {},
        debuffOnLevelGap: 0,
        talismans: talismans?.map((t) => ({ slotIndex: t.slotIndex, modifiers: t.modifiers })),
    };
}

function build(dto, data = gameData()) {
    setGameData(data);
    const player = Player.createFromDTO(dto);
    player.updateCombatDetails();
    return player;
}

beforeEach(() => setGameData(gameData()));

describe('character 30404 against the server', () => {
    test('every combat stat the server reports is what the engine builds', () => {
        const { combatDetails } = build(dtoFor());
        const wrong = [];
        // The engine folds four things into its combatStats that the server keeps outside the list (all
        // unrelated to talismans): cast speed gains attackLevel / 2000, threat sits on a base of 100, and the
        // regen stats on a base of 0.01
        const engineOffset = { castSpeed: 151 / 2000, threat: 100, hpRegenPer10: 0.01, mpRegenPer10: 0.01 };
        for (const [stat, serverValue] of Object.entries(SERVER_COMBAT_STATS)) {
            if (stat === 'smite') continue; // carried, not modeled
            const expected = serverValue + (engineOffset[stat] || 0);
            const got = combatDetails.combatStats[stat];
            if (typeof got !== 'number' || Math.abs(got - expected) > 1e-9)
                wrong.push(`${stat}: ${got} vs ${expected}`);
        }
        expect(wrong).toEqual([]);
    });

    test('the talisman delta alone is the measured one (grade value x 1.258)', () => {
        const withTalismans = build(dtoFor()).combatDetails.combatStats;
        const without = build(dtoFor({ talismans: [] })).combatDetails.combatStats;
        const delta = (stat) => withTalismans[stat] - without[stat];
        expect(delta('criticalDamage')).toBeCloseTo(0.03774, 9);
        expect(delta('magicDamage')).toBeCloseTo(0.03774, 9);
        expect(delta('physicalAmplify')).toBeCloseTo(0.01887, 9);
        expect(delta('armor')).toBeCloseTo(2.516, 9);
        expect(delta('damageTaken')).toBeCloseTo(-0.009435, 9);
        expect(delta('threat')).toBeCloseTo(-5.032, 9);
        expect(delta('combatDropRate')).toBeCloseTo(0.01258, 9);
        expect(delta('combatExperience')).toBeCloseTo(0.02516, 9);
    });

    test('Smite is carried on the player and changes nothing in the fight stats', () => {
        const player = build(dtoFor());
        expect(player.talismanMechanics.smite).toBeCloseTo(0.07548, 9);
        expect(player.combatDetails.combatStats.smite).toBeUndefined();
    });

    test('the belt contributes its own slots and power', () => {
        const stats = build(dtoFor()).combatDetails.combatStats;
        expect(stats.talismanSlots).toBe(3);
        expect(stats.talismanPower).toBeCloseTo(0.258, 9);
    });
});

describe('the ways it can end', () => {
    const baseline = () => build(dtoFor({ talismans: [] })).combatDetails.combatStats;

    test('no belt: nothing applies and nothing is invented', () => {
        const player = build(dtoFor({ belt: null }));
        expect(player.combatDetails.combatStats.armor).toBe(baseline().armor);
        expect(player.talismanMechanics).toEqual({});
        expect(player.talismanDamageTaken).toBe(0);
    });

    test('a belt with no talismans is the plain build', () => {
        expect(build(dtoFor({ talismans: [] })).combatDetails.combatStats.armor).toBe(72);
        expect(build(dtoFor({ talismans: null })).combatDetails.combatStats.armor).toBe(72);
    });

    test('off the test server (flag absent or false) nothing applies', () => {
        for (const talismansEnabled of [false, undefined]) {
            const player = build(dtoFor(), gameData({ talismansEnabled }));
            expect(player.combatDetails.combatStats.armor).toBe(72);
            expect(player.combatDetails.combatStats.damageTaken).toBe(0);
            expect(player.talismanMechanics).toEqual({});
        }
    });

    test('unslotted talismans (slot 0) and a slot beyond the belt are ignored', () => {
        const small = { hrid: SMALL, enhancementLevel: 0 };
        const talismans = [
            { slotIndex: 0, modifiers: [{ hrid: '/talisman_modifiers/armor', grade: 6 }] },
            { slotIndex: 1, modifiers: [{ hrid: '/talisman_modifiers/armor', grade: 1 }] },
            { slotIndex: 2, modifiers: [{ hrid: '/talisman_modifiers/armor', grade: 6 }] },
        ];
        // Small belt: one slot, power 0.1, so only slot 1 counts: 2 * 1.1
        const stats = build(dtoFor({ belt: small, talismans })).combatDetails.combatStats;
        expect(stats.armor).toBeCloseTo(72 + 2.2, 9);
    });

    test('a loadout whose slots are all empty (no talismans) is the plain build', () => {
        expect(build(dtoFor({ talismans: [] })).combatDetails.combatStats.armor).toBe(72);
    });

    test('the same modifier on two talismans stacks, at grade 6', () => {
        const talismans = [
            { slotIndex: 1, modifiers: [{ hrid: '/talisman_modifiers/armor', grade: 6 }] },
            { slotIndex: 2, modifiers: [{ hrid: '/talisman_modifiers/armor', grade: 6 }] },
        ];
        // Large +10: power 0.258; grade 6 armor is 8
        const stats = build(dtoFor({ talismans })).combatDetails.combatStats;
        expect(stats.armor).toBeCloseTo(72 + 2 * 8 * 1.258, 9);
    });

    test('two records in one slot count once', () => {
        const talismans = [
            { slotIndex: 1, modifiers: [{ hrid: '/talisman_modifiers/armor', grade: 6 }] },
            { slotIndex: 1, modifiers: [{ hrid: '/talisman_modifiers/armor', grade: 6 }] },
        ];
        expect(build(dtoFor({ talismans })).combatDetails.combatStats.armor).toBeCloseTo(72 + 8 * 1.258, 9);
    });

    test('swapping the belt on the built player rescales the talismans', () => {
        const player = build(dtoFor());
        const large = player.combatDetails.combatStats.armor;
        player.equipment['/equipment_types/belt'] = new player.equipment['/equipment_types/belt'].constructor(SMALL, 0);
        player.updateCombatDetails();
        // Small belt: only slot 1 (no armor line on it); power differs too
        expect(player.combatDetails.combatStats.armor).toBeLessThan(large);
    });

    test('a line the game tables do not describe is skipped', () => {
        const talismans = [{ slotIndex: 1, modifiers: [{ hrid: '/talisman_modifiers/nonsense', grade: 1 }] }];
        expect(build(dtoFor({ talismans })).combatDetails.combatStats.armor).toBe(72);
    });

    test('Damage Taken survives a crowd-control clear (the curse share goes, the talisman share stays)', () => {
        const player = build(dtoFor());
        player.clearCCs();
        expect(player.combatDetails.combatStats.damageTaken).toBeCloseTo(-0.009435, 9);
    });
});

describe('every combat modifier the game describes', () => {
    test('each one is either modeled or one of the five talisman-only mechanics', () => {
        const keys = Object.values(COMBAT_MODIFIER_DETAILS).flatMap((d) => d.keys);
        const names = keys.map((k) => k.charAt(0).toLowerCase() + k.slice(1));
        const mechanics = names.filter((n) => TALISMAN_MECHANICS.includes(n));
        const modeled = names.filter((n) => TALISMAN_MODELED_STATS.has(n));
        expect(new Set(mechanics)).toEqual(new Set(TALISMAN_MECHANICS));
        expect(names.filter((n) => !TALISMAN_MECHANICS.includes(n) && !TALISMAN_MODELED_STATS.has(n))).toEqual([]);
        expect(modeled.length + mechanics.length).toBe(names.length);
    });

    test('at grade 6 on a Large belt +0 each line lands at gradeValue x 1.2', () => {
        const data = gameData();
        const beltEquip = { hrid: LARGE, enhancementLevel: 0 };
        for (const detail of Object.values(COMBAT_MODIFIER_DETAILS)) {
            const result = computeTalismanCombat({
                talismans: [{ slotIndex: 1, modifiers: [{ hrid: detail.hrid, grade: 6 }] }],
                belt: beltEquip,
                gameData: data,
                modeledStats: TALISMAN_MODELED_STATS,
            });
            expect(result.unmodeled).toEqual({});
            for (const key of detail.keys) {
                const name = key.charAt(0).toLowerCase() + key.slice(1);
                const got = result.stats[name] ?? result.mechanics[name];
                expect(got).toBeCloseTo(detail.gradeValues[5] * 1.2, 9);
            }
        }
    });

    test('Threat and Threat Reduction both feed threat and add', () => {
        const result = computeTalismanCombat({
            talismans: [
                {
                    slotIndex: 1,
                    modifiers: [
                        { hrid: '/talisman_modifiers/threat', grade: 1 },
                        { hrid: '/talisman_modifiers/threat_reduction', grade: 1 },
                    ],
                },
            ],
            belt: { hrid: LARGE, enhancementLevel: 0 },
            gameData: gameData(),
            modeledStats: TALISMAN_MODELED_STATS,
        });
        expect(result.stats.threat).toBeCloseTo(0, 9);
    });
});

describe('unslotted records in the owned list', () => {
    test('the fixture rows really are unslotted', () => {
        expect(UNSLOTTED_TALISMANS.every((t) => t.slotIndex === 0)).toBe(true);
    });
});
