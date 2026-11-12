/**
 * Character 30404 in combat on the test server, built from the real item definitions of what it wore.
 *
 * `SERVER_CS` is the server's own `combatDetails.combatStats` with the Melee - Stab loadout and its three combat
 * talismans slotted (Large belt +10, talismanPower 0.258). The engine, given the worn items' real base stats and
 * enhancement bonuses, must build every one of those numbers.
 */

import { describe, test, expect } from 'vitest';
import Player from './player.js';
import { setGameData } from './game-data.js';
import { ENHANCEMENT_TABLE } from '../../../__fixtures__/wire/enhancement-scaling.js';
import { COMBAT_MODIFIER_DETAILS } from '../../../__fixtures__/talisman-combat-modifiers.js';
import { SLOTTED_TALISMANS } from '../../../__fixtures__/talisman-3a-30404.js';
import { WORN_GEAR, SERVER_CS } from '../../../__fixtures__/talisman-3a-30404-combat.js';

const LEVELS = {
    staminaLevel: 150,
    intelligenceLevel: 150,
    attackLevel: 151,
    meleeLevel: 156,
    defenseLevel: 151,
    rangedLevel: 150,
    magicLevel: 156,
};

function buildPlayer({ withTalismans = true } = {}) {
    const itemDetailMap = {};
    const equipment = {};
    for (const [hrid, item] of Object.entries(WORN_GEAR)) {
        itemDetailMap[hrid] = {
            name: hrid,
            equipmentDetail: {
                type: item.type,
                combatStats: item.combatStats,
                combatEnhancementBonuses: item.combatEnhancementBonuses,
            },
        };
        equipment[item.type] = { hrid, enhancementLevel: item.lvl };
    }
    setGameData({
        talismansEnabled: true,
        enhancementLevelTotalBonusMultiplierTable: ENHANCEMENT_TABLE,
        talismanModifierDetailMap: COMBAT_MODIFIER_DETAILS,
        itemDetailMap,
    });
    const player = Player.createFromDTO({
        ...LEVELS,
        hrid: 'player1',
        equipment,
        food: [],
        drinks: [],
        abilities: [],
        houseRooms: {},
        debuffOnLevelGap: 0,
        talismans: withTalismans
            ? SLOTTED_TALISMANS.map((t) => ({ slotIndex: t.slotIndex, modifiers: t.modifiers }))
            : [],
    });
    player.updateCombatDetails();
    return player;
}

/**
 * Where the engine's combatStats legitimately differ from the server's list, as a function of the server value.
 * None of these has anything to do with talismans (no talisman line feeds them); they are named so a difference
 * anywhere else cannot hide behind them. Regen is NOT here: the server's regen already includes the 0.01 base.
 */
const ENGINE_DIFFERENCES = {
    // The engine folds the attack-level share (attackLevel / 2000) into combatStats.castSpeed; the server lists
    // the gear's cast speed alone
    castSpeed: (server) => server + LEVELS.attackLevel / 2000,
    // The same level share shortens the engine's attack interval (divided by 1 + attackLevel / 2000); the
    // server's list holds the weapon interval divided by the gear's attack speed only
    attackInterval: (server) => server / (1 + LEVELS.attackLevel / 2000),
    // Every engine unit starts threat at 100 (a monster's base) and adds its gear and talisman sum; the server
    // lists the sum alone (negative for Threat Reduction) and reports 100 + it as totalThreat
    threat: (server) => server + 100,
    // PRE-EXISTING, NOT A TALISMAN: Player adds a base slot to the pouch's slot count (1 + pouch.foodSlots) while
    // the server's list is the pouch's count itself (guzzling pouch: 2 listed, 2 on the server, 3 in the engine).
    // Reported to the maintainer; asserted so a fix or a regression shows up here
    foodSlots: (server) => server + 1,
    drinkSlots: (server) => server + 1,
};

describe('30404 in combat, real gear', () => {
    test('every numeric combat stat the server reports is what the engine builds', () => {
        const { combatStats } = buildPlayer().combatDetails;
        const wrong = [];
        for (const [stat, serverValue] of Object.entries(SERVER_CS)) {
            if (typeof serverValue !== 'number') continue;
            // Smite is a talisman-only mechanic: carried on the player, not a combat stat (see below)
            if (stat === 'smite') continue;
            const expected = (ENGINE_DIFFERENCES[stat] || ((value) => value))(serverValue);
            const got = combatStats[stat];
            const tolerance = 1e-9 * Math.max(1, Math.abs(expected));
            if (typeof got !== 'number' || Math.abs(got - expected) > tolerance) {
                wrong.push(`${stat}: engine ${got}, server ${serverValue}, expected ${expected}`);
            }
        }
        expect(wrong).toEqual([]);
    });

    test('the string stats match too', () => {
        const { combatStats } = buildPlayer().combatDetails;
        expect(combatStats.combatStyleHrid).toBe(SERVER_CS.combatStyleHrids[0]);
        expect(combatStats.damageType).toBe(SERVER_CS.damageType);
        expect(combatStats.primaryTraining).toBe(SERVER_CS.primaryTraining);
        expect(combatStats.focusTraining).toBe(SERVER_CS.focusTraining);
    });

    test('Smite is carried on the player at the server value', () => {
        expect(buildPlayer().talismanMechanics.smite).toBeCloseTo(SERVER_CS.smite, 12);
    });

    test('without the talismans the build is the gear alone', () => {
        const withTalismans = buildPlayer().combatDetails.combatStats;
        const without = buildPlayer({ withTalismans: false }).combatDetails.combatStats;
        expect(withTalismans.armor - without.armor).toBeCloseTo(2.516, 9);
        expect(without.armor).toBeCloseTo(309.716 - 2.516, 9);
        expect(without.damageTaken).toBe(0);
    });
});
