/**
 * Tests for the labyrinth run finished alert.
 *
 * The failure worth pinning down is not silence — it is a *false* ending. The
 * server re-sends labyrinth messages after a run stops and sends partial ones
 * during it, so most of what is below is about a message that says nothing
 * about the run leaving the alert exactly where it was.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { getSettingDefinition } from '../../core/settings-schema.js';

const game = vi.hoisted(() => ({
    settings: {},
    characterData: null,
    wsHandlers: {},
    dmHandlers: {},
    notified: [],
    notifyResult: { fired: true, channels: ['toast'] },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback = false) => (key in game.settings ? game.settings[key] : fallback),
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterData() {
            return game.characterData;
        },
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
            return game.notifyResult;
        },
    },
}));

const { default: labyrinthRunAlerts, MASTER_SETTING } = await import('./labyrinth-run-alerts.js');

/** An active run, as the server describes one */
function running({ startedAt = '2026-08-05T10:00:00.000Z', floor = 3, ...rest } = {}) {
    return {
        labyrinth: {
            isActive: true,
            startedAt,
            currentFloor: floor,
            roomData: [[{ roomType: '/labyrinth_room_types/combat' }]],
            pathData: '[{"x":0,"y":0}]',
            ...rest,
        },
    };
}

/** The message that arrives once the run is over */
function stopped(extra = {}) {
    return { labyrinth: { isActive: false, ...extra } };
}

const send = (payload) => game.wsHandlers.labyrinth_updated(payload);

describe('labyrinth run finished alerts', () => {
    beforeEach(async () => {
        game.settings = { [MASTER_SETTING]: true };
        game.characterData = null;
        game.wsHandlers = {};
        game.dmHandlers = {};
        game.notified = [];
        game.notifyResult = { fired: true, channels: ['toast'] };
        labyrinthRunAlerts.disable();
        await labyrinthRunAlerts.initialize();
    });

    afterEach(() => {
        labyrinthRunAlerts.disable();
    });

    test('the master switch off wires nothing at all', async () => {
        labyrinthRunAlerts.disable();
        game.settings[MASTER_SETTING] = false;
        await labyrinthRunAlerts.initialize();

        expect(game.wsHandlers.labyrinth_updated).toBeUndefined();
        expect(game.dmHandlers.character_switching).toBeUndefined();
    });

    test('a run that was seen going and has stopped is announced, with the floor it reached', () => {
        send(running({ floor: 4 }));
        send(stopped());

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toContain('labyrinth run has finished');
        expect(game.notified[0].message).toContain('Floor 4');
        expect(game.notified[0].options.title).toBe('Labyrinth run finished');
    });

    test('the deepest floor of the run is what gets reported, not the last one seen', () => {
        send(running({ floor: 2 }));
        send(running({ floor: 5 }));
        // The ending message carries no grid and no floor of its own
        send(stopped());

        expect(game.notified[0].message).toContain('Floor 5');
    });

    test('an idle character is not a finished run — nothing was going', () => {
        send(stopped());
        send(stopped());

        expect(game.notified).toHaveLength(0);
    });

    test('the stale messages that follow a run cannot announce it twice', () => {
        send(running());
        send(stopped());
        expect(game.notified).toHaveLength(1);

        // The server keeps talking about the run it just ended
        send(running());
        send(stopped());
        send(stopped());

        expect(game.notified).toHaveLength(1);
    });

    test('a genuinely new run gets its own announcement', () => {
        send(running({ startedAt: 'run-one' }));
        send(stopped());
        send(running({ startedAt: 'run-two', floor: 7 }));
        send(stopped());

        expect(game.notified).toHaveLength(2);
        expect(game.notified[0].key).not.toBe(game.notified[1].key);
        expect(game.notified[1].message).toContain('Floor 7');
    });

    test('two runs with no startedAt of their own still count as two runs', () => {
        send(running({ startedAt: '' }));
        send(stopped());
        send(running({ startedAt: '' }));
        send(stopped());

        expect(game.notified).toHaveLength(2);
    });

    test('a payload that says nothing about the run is not an ending', () => {
        send(running());
        send({ labyrinth: { currentFloor: 3 } });
        send({});
        send({ labyrinth: null });

        expect(game.notified).toHaveLength(0);
    });

    test('a run seen only by its grid still ends when the flag says so', () => {
        send({ labyrinth: { startedAt: 'gridonly', currentFloor: 2, roomData: [[{}]] } });
        send(stopped());

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toContain('Floor 2');
    });

    test('a run with no floor yet is announced without inventing one', () => {
        send(running({ floor: 0 }));
        send(stopped());

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).not.toContain('Floor');
    });

    test('the run in progress at page load is adopted, so its ending is seen', async () => {
        labyrinthRunAlerts.disable();
        game.characterData = { characterLabyrinth: { isActive: true, startedAt: 'preload', currentFloor: 6 } };
        await labyrinthRunAlerts.initialize();

        send(stopped());

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toContain('Floor 6');
    });

    test('an alert that reached no channel is retried rather than counted as told', () => {
        game.notifyResult = { fired: false, channels: [], reason: 'no channel available' };
        send(running({ startedAt: 'retry-me' }));
        send(stopped());
        expect(game.notified).toHaveLength(1);

        game.notifyResult = { fired: true, channels: ['toast'] };
        send(running({ startedAt: 'retry-me' }));
        send(stopped());
        expect(game.notified).toHaveLength(2);

        // Now it has been told, and stays told
        send(running({ startedAt: 'retry-me' }));
        send(stopped());
        expect(game.notified).toHaveLength(2);
    });

    test('the event key names the run, so no two runs share one', () => {
        send(running({ startedAt: '2026-08-05T10:00:00.000Z' }));
        send(stopped());

        expect(game.notified[0].key).toBe('labyrinth-run-finished:2026-08-05T10:00:00.000Z');
    });

    test('the master switch is re-checked per message, not only at initialize', () => {
        send(running());
        game.settings[MASTER_SETTING] = false;
        send(stopped());

        expect(game.notified).toHaveLength(0);
    });

    test('a character switch tears the listeners down', () => {
        game.dmHandlers.character_switching();

        expect(game.wsHandlers.labyrinth_updated).toBeUndefined();
        expect(game.dmHandlers.character_switching).toBeUndefined();
    });
});

describe('settings schema backs the labyrinth alert', () => {
    test('the switch exists, is off until asked for, and admits it cannot tell you why the run ended', () => {
        const definition = getSettingDefinition(MASTER_SETTING);
        expect(definition).toBeTruthy();
        expect(definition.type).toBe('checkbox');
        expect(definition.default).toBe(false);
        expect(definition.help).toMatch(/does not say which/i);
    });
});
