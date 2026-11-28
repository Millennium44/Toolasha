import { describe, test, expect } from 'vitest';
import {
    buildGuildLeftUpdated,
    buildGuildCreatedUpdated,
    buildGuildLeftCharacters,
    buildGuildCreatedCharacters,
    FIXTURE_NEW_GUILD_ID,
    FIXTURE_OWN_CHARACTER_ID,
} from './guild.js';

describe('guild membership change fixtures keep the captured shapes', () => {
    test('a leave sends guild null, empty building levels and three empty member maps', () => {
        const updated = buildGuildLeftUpdated();
        expect(Object.keys(updated)).toEqual([
            'type',
            'guild',
            'guildWeeklyTrialSet',
            'guildBuildingLevelMap',
            'guildTrialScheduleHourOffset',
        ]);
        expect(updated.guild).toBeNull();
        expect(updated.guildBuildingLevelMap).toEqual({});
        expect(buildGuildLeftCharacters()).toEqual({
            type: 'guild_characters_updated',
            guildCharacterMap: {},
            guildSharableCharacterMap: {},
            guildTrialSignupLevelMap: {},
        });
    });

    test('a create sends the whole guild object and a founder row keyed by character id', () => {
        const updated = buildGuildCreatedUpdated();
        expect(updated.guild.id).toBe(FIXTURE_NEW_GUILD_ID);
        expect(typeof updated.guild.currentTrialsData).toBe('string');
        const chars = buildGuildCreatedCharacters();
        const row = chars.guildCharacterMap[FIXTURE_OWN_CHARACTER_ID];
        expect(row.guildID).toBe(FIXTURE_NEW_GUILD_ID);
        expect(row.characterID).toBe(FIXTURE_OWN_CHARACTER_ID);
        expect(row.role).toBe('leader');
        expect(typeof chars.guildSharableCharacterMap[FIXTURE_OWN_CHARACTER_ID].name).toBe('string');
    });
});
