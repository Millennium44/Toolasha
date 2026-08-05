/**
 * Tests for the combat death alert.
 *
 * `deathCount` is a running total that is republished on every battle, so the
 * cases that matter are the ones where the number is present and nothing has
 * actually happened: an unchanged count, a new session that resets it, and
 * somebody else's deaths in the same payload.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { getSettingDefinition } from '../../core/settings-schema.js';

const game = vi.hoisted(() => ({
    settings: {},
    characterId: 'me',
    wsHandlers: {},
    dmHandlers: {},
    notified: [],
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback = false) => (key in game.settings ? game.settings[key] : fallback),
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => game.characterId,
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

const { default: combatDeathAlerts, MASTER_SETTING } = await import('./combat-death-alerts.js');

/** A `new_battle` payload with the given death counts */
function battle(...counts) {
    return {
        players: counts.map(([id, deathCount]) => ({ character: { id, name: id }, deathCount })),
    };
}

const send = (payload) => game.wsHandlers.new_battle(payload);

describe('combat death alerts', () => {
    beforeEach(async () => {
        game.settings = { [MASTER_SETTING]: true };
        game.characterId = 'me';
        game.wsHandlers = {};
        game.dmHandlers = {};
        game.notified = [];
        combatDeathAlerts.disable();
        await combatDeathAlerts.initialize();
    });

    afterEach(() => {
        combatDeathAlerts.disable();
    });

    test('the master switch off wires nothing at all', async () => {
        combatDeathAlerts.disable();
        game.settings[MASTER_SETTING] = false;
        await combatDeathAlerts.initialize();

        expect(game.wsHandlers.new_battle).toBeUndefined();
        expect(game.dmHandlers.character_switching).toBeUndefined();
    });

    test('a rise in the death count is announced, with the running total', () => {
        send(battle(['me', 0]));
        send(battle(['me', 1]));

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toContain('You died in combat');
        expect(game.notified[0].message).toContain('1 death');
        expect(game.notified[0].options.title).toBe('You died');
    });

    test('several deaths at once are reported as the total, pluralised', () => {
        send(battle(['me', 1]));
        send(battle(['me', 4]));

        expect(game.notified[0].message).toContain('4 deaths');
    });

    test('the first battle seen is a baseline, not a death', () => {
        send(battle(['me', 9]));

        expect(game.notified).toHaveLength(0);
    });

    test('an unchanged count on every battle says nothing', () => {
        send(battle(['me', 2]));
        send(battle(['me', 2]));
        send(battle(['me', 2]));

        expect(game.notified).toHaveLength(0);
    });

    test('a new session takes the count back down without announcing a thing', () => {
        send(battle(['me', 3]));
        send(battle(['me', 0]));

        expect(game.notified).toHaveLength(0);
    });

    test('after a reset, the next death is measured from the new baseline', () => {
        send(battle(['me', 3]));
        send(battle(['me', 0]));
        send(battle(['me', 1]));

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toContain('1 death');
    });

    test('a party member dying is their business', () => {
        send(battle(['me', 0], ['friend', 0]));
        send(battle(['me', 0], ['friend', 3]));

        expect(game.notified).toHaveLength(0);
    });

    test('your own death is still found when the party is listed around you', () => {
        send(battle(['friend', 0], ['me', 0], ['other', 0]));
        send(battle(['friend', 0], ['me', 1], ['other', 2]));

        expect(game.notified).toHaveLength(1);
    });

    test('a payload with no entry for you is skipped rather than guessed at', () => {
        send(battle(['me', 0]));
        send(battle(['friend', 5]));
        send(battle(['me', 0]));

        expect(game.notified).toHaveLength(0);
    });

    test('a payload with no players at all is ignored', () => {
        send(battle(['me', 0]));
        send({});
        send({ players: [] });
        send(battle(['me', 1]));

        expect(game.notified).toHaveLength(1);
    });

    test('one event key for the feature, so the service caps a bad zone at one message', () => {
        send(battle(['me', 0]));
        send(battle(['me', 1]));
        send(battle(['me', 2]));

        expect(game.notified.map((entry) => entry.key)).toEqual(['combat-death', 'combat-death']);
    });

    test('the master switch is re-checked per battle, not only at initialize', () => {
        send(battle(['me', 0]));
        game.settings[MASTER_SETTING] = false;
        send(battle(['me', 1]));

        expect(game.notified).toHaveLength(0);
    });

    test('a character switch tears the listeners down and forgets the count', () => {
        send(battle(['me', 4]));
        game.dmHandlers.character_switching();

        expect(game.wsHandlers.new_battle).toBeUndefined();
        expect(game.dmHandlers.character_switching).toBeUndefined();
    });
});

describe('settings schema backs the death alert', () => {
    test('the switch exists and is off until asked for', () => {
        const definition = getSettingDefinition(MASTER_SETTING);
        expect(definition).toBeTruthy();
        expect(definition.type).toBe('checkbox');
        expect(definition.default).toBe(false);
        expect(definition.help).toMatch(/not the party/i);
    });
});
