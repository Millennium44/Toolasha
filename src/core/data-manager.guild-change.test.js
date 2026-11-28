/**
 * Leaving, creating or joining a guild after login (#1122). The login snapshot of the guild must follow the
 * game's own replacement messages, or every guild reader keeps judging the player by the guild they left.
 * Messages are delivered the way the hook does: typed handler first, then the shape-matched wildcard.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
    buildGuildCreatedCharacters,
    buildGuildCreatedUpdated,
    buildGuildLeftCharacters,
    buildGuildLeftUpdated,
    FIXTURE_NEW_GUILD_ID,
    FIXTURE_OWN_CHARACTER_ID,
} from '../__fixtures__/wire/guild.js';

let webSocketHandlers = new Map();

vi.mock('./websocket.js', () => {
    webSocketHandlers = new Map();

    return {
        default: {
            on: vi.fn((event, handler) => {
                webSocketHandlers.set(event, handler);
            }),
            off: vi.fn((event, handler) => {
                if (webSocketHandlers.get(event) === handler) {
                    webSocketHandlers.delete(event);
                }
            }),
            onSocketEvent: vi.fn(),
            offSocketEvent: vi.fn(),
            saveCombatSimSnapshot: vi.fn(() => true),
        },
    };
});

vi.mock('./storage.js', () => ({
    default: {
        getJSON: vi.fn(async (_key, _store, fallback) => fallback),
        setJSON: vi.fn(async () => true),
        get: vi.fn(async (_key, _store, fallback = null) => fallback),
        set: vi.fn(async () => true),
        flushAll: vi.fn(async () => {}),
    },
}));

const SHRINE = '/guild_shrines/force';
const socketA = { url: 'wss://api.milkywayidle.com/ws', id: 'A' };
const socketB = { url: 'wss://api.milkywayidle.com/ws', id: 'B' };

const initPayload = (overrides = {}) => ({
    character: { id: 'char-1', name: 'Tester' },
    characterSkills: [],
    characterItems: [],
    characterActions: [],
    characterQuests: [],
    ...overrides,
});

/**
 * Deliver one message as the websocket hook would.
 * @param {Object} message - Wire message
 * @param {Object} [context] - Delivery context
 */
function deliver(message, context) {
    webSocketHandlers.get(message.type)?.(message, context);
    webSocketHandlers.get('*')?.(message, context);
}

/**
 * Log in with an old guild already on the login payload.
 * @param {Object} [socket] - Socket the init arrives on
 * @returns {Promise<Object>} The data manager
 */
async function loginInOldGuild(socket = socketA) {
    const { default: dataManager } = await import('./data-manager.js');
    dataManager.currentCharacterId = null;
    dataManager.currentCharacterName = null;
    dataManager.characterData = null;
    dataManager.activeSocket = null;
    dataManager.lastCharacterSwitchTime = 0;
    await webSocketHandlers.get('init_character_data')(
        initPayload({
            guild: { id: 1493, name: 'OldGuild' },
            guildBuildingLevelMap: { [SHRINE]: 9 },
            guildCharacterMap: {
                [FIXTURE_OWN_CHARACTER_ID]: { guildID: 1493, characterID: FIXTURE_OWN_CHARACTER_ID },
                900201: { guildID: 1493, characterID: 900201 },
            },
            guildSharableCharacterMap: { [FIXTURE_OWN_CHARACTER_ID]: { name: 'Me' }, 900201: { name: 'Mate' } },
            guildTrialSignupLevelMap: { 900201: { combatLevel: 100 } },
        }),
        { socket }
    );
    return dataManager;
}

beforeEach(async () => {
    await import('./data-manager.js');
});

describe('guild membership changes after login', () => {
    test('a leave empties the guild, the maps and the building levels', async () => {
        const dataManager = await loginInOldGuild();
        expect(dataManager.getGuildBuildingLevel(SHRINE)).toBe(9);

        deliver(buildGuildLeftUpdated(), { socket: socketA });
        deliver(buildGuildLeftCharacters(), { socket: socketA });

        const data = dataManager.characterData;
        expect(data.guild).toBeNull();
        expect(data.guildCharacterMap).toEqual({});
        expect(data.guildSharableCharacterMap).toEqual({});
        expect(data.guildTrialSignupLevelMap).toEqual({});
        expect(dataManager.getGuildBuildingLevel(SHRINE)).toBe(0);
    });

    test('a create after a leave holds the new guild id, roster and (empty) building levels', async () => {
        const dataManager = await loginInOldGuild();

        deliver(buildGuildLeftUpdated(), { socket: socketA });
        deliver(buildGuildLeftCharacters(), { socket: socketA });
        deliver(buildGuildCreatedUpdated(), { socket: socketA });
        deliver(buildGuildCreatedCharacters(), { socket: socketA });

        const data = dataManager.characterData;
        expect(data.guild.id).toBe(FIXTURE_NEW_GUILD_ID);
        expect(data.guildWeeklyTrialSet.skillHrids).toHaveLength(4);
        expect(data.guildTrialScheduleHourOffset).toBe(4);
        expect(Object.keys(data.guildCharacterMap)).toEqual([String(FIXTURE_OWN_CHARACTER_ID)]);
        expect(data.guildCharacterMap[FIXTURE_OWN_CHARACTER_ID].guildID).toBe(FIXTURE_NEW_GUILD_ID);
        expect(Object.keys(data.guildSharableCharacterMap)).toEqual([String(FIXTURE_OWN_CHARACTER_ID)]);
        expect(dataManager.getGuildBuildingLevel(SHRINE)).toBe(0);
    });

    test('joining a guild with buildings replaces the building levels and getGuildBuildingLevel follows', async () => {
        const dataManager = await loginInOldGuild();

        deliver(buildGuildCreatedUpdated({ guildBuildingLevelMap: { [SHRINE]: 3, '/guild_shrines/other': 1 } }), {
            socket: socketA,
        });

        expect(dataManager.getGuildBuildingLevel(SHRINE)).toBe(3);
        expect(dataManager.getGuildBuildingLevel('/guild_shrines/other')).toBe(1);
        expect(dataManager.characterData.guild.id).toBe(FIXTURE_NEW_GUILD_ID);
    });

    test('a roster message with no sign-up map clears the held sign-up levels, as the game does', async () => {
        const dataManager = await loginInOldGuild();
        const message = buildGuildCreatedCharacters();
        delete message.guildTrialSignupLevelMap;

        deliver(message, { socket: socketA });

        expect(dataManager.characterData.guildTrialSignupLevelMap).toEqual({});
    });

    test('a late guild message from the old socket is not applied to the character that replaced it', async () => {
        const dataManager = await loginInOldGuild(socketA);
        dataManager.lastCharacterSwitchTime = 0;
        await webSocketHandlers.get('init_character_data')(
            initPayload({
                character: { id: 'char-2', name: 'Two' },
                guild: { id: 2002, name: 'TwoGuild' },
                guildBuildingLevelMap: { [SHRINE]: 4 },
                guildCharacterMap: { 5: { guildID: 2002 } },
            }),
            { socket: socketB }
        );

        const stale = { socket: socketA };
        deliver(buildGuildLeftUpdated(), stale);
        deliver(buildGuildLeftCharacters(), stale);
        deliver(buildGuildCreatedUpdated(), stale);

        const data = dataManager.characterData;
        expect(data.guild.id).toBe(2002);
        expect(Object.keys(data.guildCharacterMap)).toEqual(['5']);
        expect(dataManager.getGuildBuildingLevel(SHRINE)).toBe(4);
    });

    test('a guild message before any character is loaded is ignored without throwing', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        dataManager.characterData = null;
        dataManager.activeSocket = null;

        expect(() => deliver(buildGuildCreatedUpdated())).not.toThrow();
        expect(() => deliver(buildGuildCreatedCharacters())).not.toThrow();
        expect(dataManager.characterData).toBeNull();
    });
});
