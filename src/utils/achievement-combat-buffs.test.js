import { describe, test, expect } from 'vitest';
import {
    achievementBuffLabel,
    manualAchievementCombatBuffs,
    MANUAL_ACHIEVEMENT_COMBAT_BUFFS,
    achievementTierCounts,
    deriveAchievementCombatBuffs,
} from './achievement-combat-buffs.js';

const NOVICE_ACH_1 = { hrid: '/achievements/novice_1', tierHrid: '/achievement_tiers/novice' };
const NOVICE_ACH_2 = { hrid: '/achievements/novice_2', tierHrid: '/achievement_tiers/novice' };
const VETERAN_ACH_1 = { hrid: '/achievements/veteran_1', tierHrid: '/achievement_tiers/veteran' };
const ELITE_ACH_1 = { hrid: '/achievements/elite_1', tierHrid: '/achievement_tiers/elite' };
const ELITE_ACH_2 = { hrid: '/achievements/elite_2', tierHrid: '/achievement_tiers/elite' };
const BEGINNER_ACH_1 = { hrid: '/achievements/beginner_1', tierHrid: '/achievement_tiers/beginner' };

const DETAIL_MAP = Object.fromEntries(
    [NOVICE_ACH_1, NOVICE_ACH_2, VETERAN_ACH_1, ELITE_ACH_1, ELITE_ACH_2, BEGINNER_ACH_1].map((a) => [a.hrid, a])
);

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

describe('achievementTierCounts', () => {
    test('counts completed vs. total per tier from a shared profile', () => {
        const characterAchievements = [
            { achievementHrid: NOVICE_ACH_1.hrid, isCompleted: true },
            { achievementHrid: NOVICE_ACH_2.hrid, isCompleted: false },
            { achievementHrid: VETERAN_ACH_1.hrid, isCompleted: true },
        ];

        const counts = achievementTierCounts(characterAchievements, DETAIL_MAP);

        expect(counts['/achievement_tiers/novice']).toEqual({ completedCount: 1, totalCount: 2 });
        expect(counts['/achievement_tiers/veteran']).toEqual({ completedCount: 1, totalCount: 1 });
        // Elite has two achievements in the catalog but none listed as completed
        expect(counts['/achievement_tiers/elite']).toEqual({ completedCount: 0, totalCount: 2 });
    });

    test('an achievement not marked completed is not counted', () => {
        const counts = achievementTierCounts([{ achievementHrid: NOVICE_ACH_1.hrid, isCompleted: false }], DETAIL_MAP);
        expect(counts['/achievement_tiers/novice'].completedCount).toBe(0);
    });

    test('missing or empty inputs are safe and empty, not a throw', () => {
        expect(achievementTierCounts(null, null)).toEqual({});
        expect(achievementTierCounts(undefined, undefined)).toEqual({});
        expect(achievementTierCounts([], {})).toEqual({});
        expect(achievementTierCounts(null, DETAIL_MAP)).toMatchObject({
            '/achievement_tiers/novice': { completedCount: 0, totalCount: 2 },
        });
        // A detail map is required to know each tier's total — without it,
        // nothing can be said about completion.
        expect(achievementTierCounts([{ achievementHrid: NOVICE_ACH_1.hrid, isCompleted: true }], null)).toEqual({});
    });
});

describe('deriveAchievementCombatBuffs', () => {
    test('a fully completed tier is active', () => {
        const characterAchievements = [
            { achievementHrid: NOVICE_ACH_1.hrid, isCompleted: true },
            { achievementHrid: NOVICE_ACH_2.hrid, isCompleted: true },
        ];

        const { buffs, activeTypeHrids } = deriveAchievementCombatBuffs(characterAchievements, DETAIL_MAP);

        expect(buffs.map((b) => b.typeHrid)).toEqual([
            '/buff_types/damage',
            '/buff_types/wisdom',
            '/buff_types/rare_find',
        ]);
        expect(activeTypeHrids).toEqual(['/buff_types/wisdom']);
    });

    test('a tier one achievement short of complete is inactive', () => {
        const characterAchievements = [
            { achievementHrid: NOVICE_ACH_1.hrid, isCompleted: true },
            { achievementHrid: NOVICE_ACH_2.hrid, isCompleted: false },
        ];

        const { activeTypeHrids } = deriveAchievementCombatBuffs(characterAchievements, DETAIL_MAP);

        expect(activeTypeHrids).not.toContain('/buff_types/wisdom');
    });

    test('all three combat tiers complete activates all three buffs', () => {
        const characterAchievements = [
            { achievementHrid: NOVICE_ACH_1.hrid, isCompleted: true },
            { achievementHrid: NOVICE_ACH_2.hrid, isCompleted: true },
            { achievementHrid: VETERAN_ACH_1.hrid, isCompleted: true },
            { achievementHrid: ELITE_ACH_1.hrid, isCompleted: true },
            { achievementHrid: ELITE_ACH_2.hrid, isCompleted: true },
        ];

        const { activeTypeHrids } = deriveAchievementCombatBuffs(characterAchievements, DETAIL_MAP);

        expect(new Set(activeTypeHrids)).toEqual(
            new Set(['/buff_types/damage', '/buff_types/wisdom', '/buff_types/rare_find'])
        );
    });

    test('non-combat tiers (e.g. Beginner) never appear in the combat buff list, complete or not', () => {
        const characterAchievements = [{ achievementHrid: BEGINNER_ACH_1.hrid, isCompleted: true }];
        const { buffs, activeTypeHrids } = deriveAchievementCombatBuffs(characterAchievements, DETAIL_MAP);

        expect(buffs.map((b) => b.typeHrid)).not.toContain('/buff_types/gathering');
        expect(activeTypeHrids).not.toContain('/buff_types/gathering');
        expect(activeTypeHrids).toEqual([]);
    });

    test('empty or missing inputs return all three buffs with none active', () => {
        const { buffs, activeTypeHrids } = deriveAchievementCombatBuffs(null, null);
        expect(buffs).toHaveLength(3);
        expect(activeTypeHrids).toEqual([]);

        const empty = deriveAchievementCombatBuffs([], {});
        expect(empty.buffs).toHaveLength(3);
        expect(empty.activeTypeHrids).toEqual([]);
    });
});
