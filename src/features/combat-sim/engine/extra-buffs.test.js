/**
 * Which buffs each simulated player walks in wearing.
 *
 * Guild buffs were already read off the player's own DTO, for a reason worth
 * keeping in mind here: reading them off the shared list handed player 1's
 * guild to the whole party. Achievement buffs have exactly the same shape and
 * the same per-player ownership, and were being dropped entirely.
 */

import { describe, test, expect } from 'vitest';
import { buildPlayerExtraBuffs, buildScrollBuffs } from './extra-buffs.js';
import { SCROLL_BUFF_VALUES } from '../../../utils/scroll-buff-values.js';

const shared = [{ uniqueHrid: '/buff_uniques/experience_moo_pass_buff' }];
const guild = [{ uniqueHrid: '/buff_uniques/guild_combat' }];
const achievement = [{ uniqueHrid: '/buff_uniques/achievement_combat' }];

describe('buildPlayerExtraBuffs', () => {
    test('shared, guild and achievement buffs all reach the player', () => {
        const result = buildPlayerExtraBuffs(shared, {
            guildCombatBuffs: guild,
            achievementCombatBuffs: achievement,
        });

        expect(result).toEqual([...shared, ...guild, ...achievement]);
    });

    test('a party member keeps their own achievement buffs, not their teammate’s', () => {
        const otherAchievement = [{ uniqueHrid: '/buff_uniques/achievement_other' }];

        const first = buildPlayerExtraBuffs(shared, { achievementCombatBuffs: achievement });
        const second = buildPlayerExtraBuffs(shared, { achievementCombatBuffs: otherAchievement });

        expect(first).toEqual([...shared, ...achievement]);
        expect(second).toEqual([...shared, ...otherAchievement]);
    });

    test('a DTO with no achievement buffs is the old behaviour exactly', () => {
        expect(buildPlayerExtraBuffs(shared, { guildCombatBuffs: guild })).toEqual([...shared, ...guild]);
    });

    test('empty arrays change nothing', () => {
        expect(buildPlayerExtraBuffs(shared, { guildCombatBuffs: [], achievementCombatBuffs: [] })).toEqual(shared);
    });

    test('junk in place of a buff list is ignored rather than spread', () => {
        expect(buildPlayerExtraBuffs(shared, { achievementCombatBuffs: {} })).toEqual(shared);
        expect(buildPlayerExtraBuffs(shared, null)).toEqual(shared);
        expect(buildPlayerExtraBuffs(undefined, { achievementCombatBuffs: achievement })).toEqual(achievement);
    });

    test('the shared list is not mutated', () => {
        buildPlayerExtraBuffs(shared, { achievementCombatBuffs: achievement });

        expect(shared).toHaveLength(1);
    });

    test('chosen scrolls reach the player as buffs, after guild and achievement', () => {
        const result = buildPlayerExtraBuffs(shared, {
            guildCombatBuffs: guild,
            achievementCombatBuffs: achievement,
            scrollBuffs: ['/buff_types/wisdom'],
        });

        expect(result.slice(0, 3)).toEqual([...shared, ...guild, ...achievement]);
        expect(result).toHaveLength(4);
        expect(result[3]).toMatchObject({
            typeHrid: '/buff_types/wisdom',
            flatBoost: SCROLL_BUFF_VALUES['/buff_types/wisdom'],
        });
    });
});

describe('buildScrollBuffs', () => {
    test('a combat scroll becomes a flat-boost buff at its documented value', () => {
        const [buff] = buildScrollBuffs(['/buff_types/rare_find']);

        expect(buff).toMatchObject({
            uniqueHrid: '/buff_uniques/toolasha_scroll_rare_find',
            typeHrid: '/buff_types/rare_find',
            ratioBoost: 0,
            flatBoost: SCROLL_BUFF_VALUES['/buff_types/rare_find'],
        });
    });

    test('both combat scrolls resolve; order follows the input', () => {
        const buffs = buildScrollBuffs(['/buff_types/wisdom', '/buff_types/rare_find']);
        expect(buffs.map((b) => b.typeHrid)).toEqual(['/buff_types/wisdom', '/buff_types/rare_find']);
    });

    test('a skilling-only scroll is dropped rather than added as a combat no-op', () => {
        expect(buildScrollBuffs(['/buff_types/gourmet', '/buff_types/efficiency'])).toEqual([]);
    });

    test('non-arrays and empty input yield nothing', () => {
        expect(buildScrollBuffs(undefined)).toEqual([]);
        expect(buildScrollBuffs(null)).toEqual([]);
        expect(buildScrollBuffs({})).toEqual([]);
        expect(buildScrollBuffs([])).toEqual([]);
    });
});
