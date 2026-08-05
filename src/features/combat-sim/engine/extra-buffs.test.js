/**
 * Which buffs each simulated player walks in wearing.
 *
 * Guild buffs were already read off the player's own DTO, for a reason worth
 * keeping in mind here: reading them off the shared list handed player 1's
 * guild to the whole party. Achievement buffs have exactly the same shape and
 * the same per-player ownership, and were being dropped entirely.
 */

import { describe, test, expect } from 'vitest';
import { buildPlayerExtraBuffs } from './extra-buffs.js';

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
});
