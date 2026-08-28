import { describe, test, expect } from 'vitest';
import {
    achievementBuffLabel,
    manualAchievementCombatBuffs,
    MANUAL_ACHIEVEMENT_COMBAT_BUFFS,
} from './achievement-combat-buffs.js';

describe('achievementBuffLabel', () => {
    test('a ratio-boost buff reads as a percentage', () => {
        expect(achievementBuffLabel({ typeHrid: '/buff_types/damage', ratioBoost: 0.02 })).toBe('Damage +2%');
    });

    test('a flat-boost buff reads the same way', () => {
        expect(achievementBuffLabel({ typeHrid: '/buff_types/wisdom', flatBoost: 0.05 })).toBe('Wisdom +5%');
    });

    test('a multi-word buff type is title-cased', () => {
        expect(achievementBuffLabel({ typeHrid: '/buff_types/rare_find', ratioBoost: 0.6 })).toBe('Rare Find +60%');
    });

    test('a sub-percent value keeps one decimal', () => {
        expect(achievementBuffLabel({ typeHrid: '/buff_types/enhancing_success', ratioBoost: 0.002 })).toBe(
            'Enhancing Success +0.2%'
        );
    });

    test('a buff with no magnitude is named alone', () => {
        expect(achievementBuffLabel({ typeHrid: '/buff_types/damage' })).toBe('Damage');
    });

    test('junk does not throw', () => {
        expect(achievementBuffLabel(null)).toBe('Buff');
        expect(achievementBuffLabel({})).toBe('Buff');
    });
});

describe('manualAchievementCombatBuffs', () => {
    test('builds all three catalog buffs in the server permanent-buff shape', () => {
        const buffs = manualAchievementCombatBuffs();
        expect(buffs).toHaveLength(3);
        for (const buff of buffs) {
            expect(buff).toMatchObject({
                ratioBoostLevelBonus: 0,
                flatBoostLevelBonus: 0,
                startTime: '0001-01-01T00:00:00Z',
                duration: 0,
            });
            expect(typeof buff.uniqueHrid).toBe('string');
        }
    });

    test('damage is a ratio boost; wisdom and rare find are flat boosts, each +2%', () => {
        const [damage, wisdom, rareFind] = manualAchievementCombatBuffs();

        expect(damage.typeHrid).toBe('/buff_types/damage');
        expect(damage.ratioBoost).toBeCloseTo(0.02, 10);
        expect(damage.flatBoost).toBe(0);

        expect(wisdom.typeHrid).toBe('/buff_types/wisdom');
        expect(wisdom.flatBoost).toBeCloseTo(0.02, 10);
        expect(wisdom.ratioBoost).toBe(0);

        expect(rareFind.typeHrid).toBe('/buff_types/rare_find');
        expect(rareFind.flatBoost).toBeCloseTo(0.02, 10);
        expect(rareFind.ratioBoost).toBe(0);
    });

    test('each call returns a fresh array — callers can safely mutate their own copy', () => {
        const first = manualAchievementCombatBuffs();
        const second = manualAchievementCombatBuffs();
        expect(first).not.toBe(second);
        expect(first[0]).not.toBe(second[0]);
        expect(first).toEqual(second);
    });

    test('labels every catalog buff as "<Name> +2%"', () => {
        for (const def of MANUAL_ACHIEVEMENT_COMBAT_BUFFS) {
            const buff = { typeHrid: def.typeHrid, [def.valueKey]: def.value };
            expect(achievementBuffLabel(buff)).toBe(def.label);
        }
    });
});
