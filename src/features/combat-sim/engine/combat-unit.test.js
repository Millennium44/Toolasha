/**
 * Tests for CombatUnit buff-source stacking
 * Game rule: the strongest source of a buff applies; when it expires the
 * next strongest still-active source takes over.
 */

import { describe, test, expect } from 'vitest';
import CombatUnit from './combat-unit.js';

function makeUnit() {
    const unit = new CombatUnit();
    // Buff bookkeeping is what's under test; stat recalculation needs game data
    unit.updateCombatDetails = () => {};
    return unit;
}

function auraBuff(ratioBoost, duration) {
    return {
        uniqueHrid: '/buff_uniques/speed_aura',
        typeHrid: '/buff_types/attack_speed',
        ratioBoost,
        ratioBoostLevelBonus: 0,
        flatBoost: 0,
        flatBoostLevelBonus: 0,
        duration,
    };
}

const NS = 1e9;

describe('CombatUnit.addBuff strongest-source selection', () => {
    test('stronger source applies regardless of cast order', () => {
        const unit = makeUnit();

        unit.addBuff(auraBuff(0.2, 60 * NS), 0);
        unit.addBuff(auraBuff(0.1, 60 * NS), 1 * NS);
        expect(unit.combatBuffs['/buff_uniques/speed_aura'].ratioBoost).toBe(0.2);

        const unit2 = makeUnit();
        unit2.addBuff(auraBuff(0.1, 60 * NS), 0);
        unit2.addBuff(auraBuff(0.2, 60 * NS), 1 * NS);
        expect(unit2.combatBuffs['/buff_uniques/speed_aura'].ratioBoost).toBe(0.2);
    });

    test('does not mutate the shared buff definition', () => {
        const unit = makeUnit();
        const definition = auraBuff(0.2, 60 * NS);

        unit.addBuff(definition, 5 * NS);

        expect(definition.startTime).toBeUndefined();
    });

    test('same-strength reapplication refreshes instead of stacking sources', () => {
        const unit = makeUnit();

        unit.addBuff(auraBuff(0.2, 60 * NS), 0);
        unit.addBuff(auraBuff(0.2, 60 * NS), 30 * NS);

        expect(unit.buffSources.get('/buff_uniques/speed_aura')).toHaveLength(1);
        // Refreshed: expires at 90s, not 60s
        unit.removeExpiredBuffs(70 * NS);
        expect(unit.combatBuffs['/buff_uniques/speed_aura']).toBeDefined();
    });

    test('debuffs compare by magnitude (more negative wins)', () => {
        const unit = makeUnit();
        const curse = (flatBoost) => ({
            uniqueHrid: '/buff_uniques/curse',
            typeHrid: '/buff_types/damage',
            ratioBoost: 0,
            ratioBoostLevelBonus: 0,
            flatBoost,
            flatBoostLevelBonus: 0,
            duration: 60 * NS,
        });

        unit.addBuff(curse(-50), 0);
        unit.addBuff(curse(-20), 1 * NS);

        expect(unit.combatBuffs['/buff_uniques/curse'].flatBoost).toBe(-50);
    });
});

describe('CombatUnit.removeExpiredBuffs fallback', () => {
    test('falls back to the next strongest source when the strongest expires', () => {
        const unit = makeUnit();

        // Strong aura for 30s, weak aura for 120s
        unit.addBuff(auraBuff(0.3, 30 * NS), 0);
        unit.addBuff(auraBuff(0.1, 120 * NS), 0);
        expect(unit.combatBuffs['/buff_uniques/speed_aura'].ratioBoost).toBe(0.3);

        unit.removeExpiredBuffs(31 * NS);
        expect(unit.combatBuffs['/buff_uniques/speed_aura'].ratioBoost).toBe(0.1);
        expect(unit.buffSources.get('/buff_uniques/speed_aura')).toHaveLength(1);
    });

    test('removes the buff entirely when all sources expire', () => {
        const unit = makeUnit();

        unit.addBuff(auraBuff(0.3, 30 * NS), 0);
        unit.addBuff(auraBuff(0.1, 60 * NS), 0);

        unit.removeExpiredBuffs(61 * NS);
        expect(unit.combatBuffs['/buff_uniques/speed_aura']).toBeUndefined();
        expect(unit.buffSources.has('/buff_uniques/speed_aura')).toBe(false);
    });

    test('directly-written buffs without source lists still expire', () => {
        const unit = makeUnit();
        unit.combatBuffs['/buff_uniques/fury_damage'] = {
            uniqueHrid: '/buff_uniques/fury_damage',
            typeHrid: '/buff_types/fury_damage',
            ratioBoost: 0.5,
            flatBoost: 0,
            startTime: 0,
            duration: 10 * NS,
        };

        unit.removeExpiredBuffs(11 * NS);
        expect(unit.combatBuffs['/buff_uniques/fury_damage']).toBeUndefined();
    });

    test('clearBuffs resets buff sources', () => {
        const unit = makeUnit();
        unit.addBuff(auraBuff(0.3, 30 * NS), 0);

        unit.clearBuffs();
        expect(unit.buffSources.size).toBe(0);
        expect(unit.combatBuffs['/buff_uniques/speed_aura']).toBeUndefined();
    });
});

describe('CombatUnit.updateCombatDetails max HP/MP buffs', () => {
    // The guild shrine's max-HP/MP bonus arrives as these buff types; the engine
    // used to ignore them, computing HP/MP on the equipment ratio alone.
    const maxHpBuff = (ratioBoost, flatBoost = 0) => ({
        uniqueHrid: '/buff_uniques/max_hitpoints_guild_buff',
        typeHrid: '/buff_types/max_hitpoints',
        ratioBoost,
        ratioBoostLevelBonus: 0,
        flatBoost,
        flatBoostLevelBonus: 0,
        duration: 60 * NS,
    });
    const maxMpBuff = (ratioBoost) => ({
        uniqueHrid: '/buff_uniques/max_manapoints_guild_buff',
        typeHrid: '/buff_types/max_manapoints',
        ratioBoost,
        ratioBoostLevelBonus: 0,
        flatBoost: 0,
        flatBoostLevelBonus: 0,
        duration: 60 * NS,
    });

    test('folds a +2% guild max-hitpoints buff into max HP', () => {
        const unit = new CombatUnit();
        unit.staminaLevel = 165;
        unit.combatDetails.combatStats.maxHitpoints = 500;
        unit.addBuff(maxHpBuff(0.02), 0);
        unit.updateCombatDetails();
        // (10*(10+165) + 500) * (1 + 0.02) = 2250 * 1.02 = 2295
        expect(unit.combatDetails.maxHitpoints).toBe(2295);
    });

    test('without the buff, max HP runs on the base alone (the old value)', () => {
        const unit = new CombatUnit();
        unit.staminaLevel = 165;
        unit.combatDetails.combatStats.maxHitpoints = 500;
        unit.updateCombatDetails();
        expect(unit.combatDetails.maxHitpoints).toBe(2250);
    });

    test('a +2% guild max-manapoints buff folds into max MP', () => {
        const unit = new CombatUnit();
        unit.intelligenceLevel = 100;
        unit.combatDetails.combatStats.maxManapoints = 0;
        unit.addBuff(maxMpBuff(0.02), 0);
        unit.updateCombatDetails();
        // (10*(10+100) + 0) * 1.02 = 1100 * 1.02 = 1122
        expect(unit.combatDetails.maxManapoints).toBe(1122);
    });

    test('a flat max-hitpoints buff adds inside the ratio, matching the game', () => {
        const unit = new CombatUnit();
        unit.staminaLevel = 165;
        unit.combatDetails.combatStats.maxHitpoints = 500;
        unit.addBuff(maxHpBuff(0.02, 100), 0);
        unit.updateCombatDetails();
        // (10*(10+165) + 500 + 100) * 1.02 = 2350 * 1.02 = 2397
        expect(unit.combatDetails.maxHitpoints).toBe(2397);
    });

    test('repeated updateCombatDetails does not re-accumulate the buff', () => {
        const unit = new CombatUnit();
        unit.staminaLevel = 165;
        unit.combatDetails.combatStats.maxHitpoints = 500;
        unit.addBuff(maxHpBuff(0.02), 0);
        unit.updateCombatDetails();
        unit.updateCombatDetails();
        unit.updateCombatDetails();
        expect(unit.combatDetails.maxHitpoints).toBe(2295);
    });
});
