/**
 * Tests for the skill milestone alert.
 *
 * The milestone comes off the game's own guild broadcast — a
 * `chat_message_received` system message keyed `characterLeveledUp` — so the
 * cases that matter are the ones that must NOT fire: a guildmate's milestone,
 * an ordinary chat line, and chat history replayed on load.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { getSettingDefinition } from '../../core/settings-schema.js';

const game = vi.hoisted(() => ({
    settings: {},
    characterName: 'Benny',
    wsHandlers: {},
    dmHandlers: {},
    notified: [],
    now: 1_000_000,
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback = false) => (key in game.settings ? game.settings[key] : fallback),
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterName: () => game.characterName,
        on: (event, handler) => {
            game.dmHandlers[event] = handler;
        },
        off: (event, handler) => {
            if (game.dmHandlers[event] === handler) delete game.dmHandlers[event];
        },
    },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (event, handler) => {
            game.wsHandlers[event] = handler;
        },
        off: (event, handler) => {
            if (game.wsHandlers[event] === handler) delete game.wsHandlers[event];
        },
    },
}));
vi.mock('./notification-service.js', () => ({
    default: {
        notify: (key, message, options) => {
            game.notified.push({ key, message, options });
            return { fired: true, channels: ['toast'] };
        },
    },
}));

const { default: skillLevelUpAlerts, MASTER_SETTING, LEVEL_UP_MESSAGE_KEY } = await import('./skill-level-up-alerts.js');

/** A `characterLeveledUp` broadcast, timestamped `now` by default */
function levelUp({ name = 'Benny', skillHrid = '/skills/foraging', level = 100, t } = {}) {
    return {
        message: {
            isSystemMessage: true,
            m: LEVEL_UP_MESSAGE_KEY,
            chan: '/chat_channel_types/guild',
            systemMetadata: JSON.stringify({ name, skillHrid, level }),
            t: t ?? new Date(game.now).toISOString(),
        },
    };
}

const send = (payload) => game.wsHandlers.chat_message_received(payload);

describe('skill milestone alerts', () => {
    beforeEach(async () => {
        game.settings = { [MASTER_SETTING]: true };
        game.characterName = 'Benny';
        game.wsHandlers = {};
        game.dmHandlers = {};
        game.notified = [];
        game.now = 1_000_000;
        vi.spyOn(Date, 'now').mockReturnValue(game.now);
        skillLevelUpAlerts.disable();
        await skillLevelUpAlerts.initialize();
    });

    afterEach(() => {
        skillLevelUpAlerts.disable();
        vi.restoreAllMocks();
    });

    test('the master switch off wires nothing at all', async () => {
        skillLevelUpAlerts.disable();
        game.settings[MASTER_SETTING] = false;
        await skillLevelUpAlerts.initialize();

        expect(game.wsHandlers.chat_message_received).toBeUndefined();
        expect(game.dmHandlers.character_switching).toBeUndefined();
    });

    test('your own milestone broadcast is announced with skill and level', () => {
        send(levelUp({ skillHrid: '/skills/foraging', level: 100 }));

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toBe('You reached level 100 Foraging!');
        expect(game.notified[0].options.title).toBe('Level up');
        expect(game.notified[0].key).toBe('skill-levelup:/skills/foraging:100');
    });

    test("a guildmate's milestone is their business, not yours", () => {
        send(levelUp({ name: 'SomeoneElse', level: 100 }));

        expect(game.notified).toHaveLength(0);
    });

    test('an ordinary (non-system) chat line is ignored', () => {
        send({
            message: {
                isSystemMessage: false,
                sName: 'Benny',
                m: 'Benny has reached level 100 Foraging!',
                chan: '/chat_channel_types/guild',
            },
        });

        expect(game.notified).toHaveLength(0);
    });

    test('a different system message is ignored', () => {
        send({
            message: {
                isSystemMessage: true,
                m: 'systemChatMessage.partyBattleStarted',
                systemMetadata: '{}',
                t: new Date(game.now).toISOString(),
            },
        });

        expect(game.notified).toHaveLength(0);
    });

    test('chat history replayed from before startup is not announced', () => {
        // Two hours older than when the feature came up
        send(levelUp({ level: 100, t: new Date(game.now - 2 * 60 * 60 * 1000).toISOString() }));

        expect(game.notified).toHaveLength(0);
    });

    test('a live milestone a little before startup (clock skew) still fires', () => {
        send(levelUp({ level: 100, t: new Date(game.now - 30 * 1000).toISOString() }));

        expect(game.notified).toHaveLength(1);
    });

    test('each milestone gets its own event key', () => {
        send(levelUp({ skillHrid: '/skills/foraging', level: 100 }));
        send(levelUp({ skillHrid: '/skills/foraging', level: 105 }));

        expect(game.notified.map((entry) => entry.key)).toEqual([
            'skill-levelup:/skills/foraging:100',
            'skill-levelup:/skills/foraging:105',
        ]);
    });

    test('malformed metadata is skipped rather than thrown on', () => {
        send({
            message: {
                isSystemMessage: true,
                m: LEVEL_UP_MESSAGE_KEY,
                systemMetadata: '{not json',
                t: new Date(game.now).toISOString(),
            },
        });

        expect(game.notified).toHaveLength(0);
    });

    test('the master switch is re-checked per message, not only at initialize', () => {
        game.settings[MASTER_SETTING] = false;
        send(levelUp({ level: 100 }));

        expect(game.notified).toHaveLength(0);
    });

    test('a character switch tears the listeners down', () => {
        game.dmHandlers.character_switching();

        expect(game.wsHandlers.chat_message_received).toBeUndefined();
        expect(game.dmHandlers.character_switching).toBeUndefined();
    });
});

describe('settings schema backs the milestone alert', () => {
    test('the switch exists and is off until asked for', () => {
        const definition = getSettingDefinition(MASTER_SETTING);
        expect(definition).toBeTruthy();
        expect(definition.type).toBe('checkbox');
        expect(definition.default).toBe(false);
        expect(definition.help).toMatch(/milestone/i);
    });
});
