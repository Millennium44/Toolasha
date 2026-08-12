import { describe, test, expect } from 'vitest';
import { achievementBuffLabel } from './achievement-combat-buffs.js';

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
