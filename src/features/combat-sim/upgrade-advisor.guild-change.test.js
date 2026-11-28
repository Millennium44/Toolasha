/**
 * #1122: `inLocalGuild` reads `dataManager.characterData` at call time, so once the data manager follows a guild
 * change a party member from the new guild is recognized and one from the old guild is not. The real data
 * manager is driven through its own message handlers.
 */

import { describe, test, expect, vi } from 'vitest';
import {
    buildGuildCreatedCharacters,
    buildGuildCreatedUpdated,
    buildGuildLeftCharacters,
    buildGuildLeftUpdated,
    FIXTURE_NEW_GUILD_ID,
    FIXTURE_OWN_CHARACTER_ID,
} from '../../__fixtures__/wire/guild.js';

const hooks = vi.hoisted(() => ({ handlers: new Map() }));

vi.mock('../../core/websocket.js', () => ({
    default: {
        on: vi.fn((event, handler) => hooks.handlers.set(event, handler)),
        off: vi.fn(),
        onSocketEvent: vi.fn(),
        offSocketEvent: vi.fn(),
        saveCombatSimSnapshot: vi.fn(() => true),
    },
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: vi.fn(async (_key, _store, fallback) => fallback),
        setJSON: vi.fn(async () => true),
        get: vi.fn(async (_key, _store, fallback = null) => fallback),
        set: vi.fn(async () => true),
        flushAll: vi.fn(async () => {}),
    },
}));

const { default: dataManager } = await import('../../core/data-manager.js');
const { inLocalGuild } = await import('./upgrade-advisor.js');

/**
 * Deliver one message as the websocket hook would.
 * @param {Object} message - Wire message
 */
function deliver(message) {
    hooks.handlers.get(message.type)?.(message, {});
    hooks.handlers.get('*')?.(message, {});
}

describe('inLocalGuild across a guild change', () => {
    test('a member of the new guild counts after a leave and a create, one of the old guild does not', async () => {
        await hooks.handlers.get('init_character_data')({
            character: { id: FIXTURE_OWN_CHARACTER_ID, name: 'Me' },
            characterSkills: [],
            characterItems: [],
            characterActions: [],
            characterQuests: [],
            guild: { id: 1493, name: 'OldGuild' },
            guildCharacterMap: { 900201: { characterID: 900201, guildID: 1493 } },
        });
        const oldMate = { characterID: 900201 };
        const newMate = { characterID: 900777 };
        expect(inLocalGuild(oldMate, false)).toBe(true);

        deliver(buildGuildLeftUpdated());
        deliver(buildGuildLeftCharacters());
        expect(inLocalGuild(oldMate, false)).toBe(false);

        deliver(buildGuildCreatedUpdated());
        const roster = buildGuildCreatedCharacters();
        roster.guildCharacterMap[900777] = { characterID: 900777, guildID: FIXTURE_NEW_GUILD_ID };
        deliver(roster);

        expect(inLocalGuild(newMate, false)).toBe(true);
        expect(inLocalGuild({ characterID: 900777, guildId: FIXTURE_NEW_GUILD_ID }, false)).toBe(true);
        expect(inLocalGuild(oldMate, false)).toBe(false);
        expect(inLocalGuild({ characterID: 900201, guildId: 1493 }, false)).toBe(false);
        expect(dataManager.characterData.guild.id).toBe(FIXTURE_NEW_GUILD_ID);
    });
});
