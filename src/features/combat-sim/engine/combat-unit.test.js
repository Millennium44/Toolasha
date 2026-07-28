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
