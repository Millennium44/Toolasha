/**
 * Tests for the Philosopher's Stone alert.
 *
 * `endCharacterItems` rows carry a stack's new ABSOLUTE total, not the
 * amount gained — most of what is below is about turning that into "did a
 * fresh stone actually land", once per stone rather than once per session.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { getSettingDefinition } from '../../core/settings-schema.js';
import { PHILO_HRID } from '../alchemy/philosophers-stone-hrid.js';

const game = vi.hoisted(() => ({
    settings: {},
    initClientData: null,
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
        getInitClientData: () => game.initClientData,
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

const {
    default: philoStoneAlerts,
    MASTER_SETTING,
    TRANSMUTE_ACTION_HRID,
} = await import('./philo-stone-alerts.js');

/** An `action_completed` for one (or a batched several) transmute attempts */
function completed({ hrid = TRANSMUTE_ACTION_HRID, philoCount, otherItems = [] } = {}) {
    const endCharacterItems = [...otherItems];
    if (philoCount !== undefined) {
        endCharacterItems.push({ itemHrid: PHILO_HRID, count: philoCount });
    }
    return {
        endCharacterAction: { actionHrid: hrid },
        endCharacterItems,
    };
}

const send = (payload) => game.wsHandlers.action_completed(payload);

describe('philosophers stone alerts', () => {
    beforeEach(async () => {
        game.settings = { [MASTER_SETTING]: true };
        game.initClientData = { itemDetailMap: { [PHILO_HRID]: { name: 'Philosopher’s Stone' } } };
        game.wsHandlers = {};
        game.dmHandlers = {};
        game.notified = [];
        game.notifyResult = { fired: true, channels: ['toast'] };
        philoStoneAlerts.disable();
        await philoStoneAlerts.initialize();
    });

    afterEach(() => {
        philoStoneAlerts.disable();
    });

    test('the master switch off wires nothing at all', async () => {
        philoStoneAlerts.disable();
        game.settings[MASTER_SETTING] = false;
        await philoStoneAlerts.initialize();

        expect(game.wsHandlers.action_completed).toBeUndefined();
        expect(game.dmHandlers.character_switching).toBeUndefined();
    });

    test('the first sighting only establishes a baseline and says nothing', () => {
        send(completed({ philoCount: 3 }));

        expect(game.notified).toHaveLength(0);
    });

    test('a further attempt that raises the stack announces the stone, by its real name', () => {
        send(completed({ philoCount: 3 }));
        send(completed({ philoCount: 4 }));

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toBe('Transmuting produced a Philosopher’s Stone!');
        expect(game.notified[0].options.title).toBe("Philosopher's Stone!");
    });

    test('a transmute with no stone row is silent', () => {
        send(completed({ philoCount: 3 }));
        send(completed({ otherItems: [{ itemHrid: '/items/coin', count: 1000 }] }));

        expect(game.notified).toHaveLength(0);
    });

    test('an unchanged stack (row absent again) does not repeat the last announcement', () => {
        send(completed({ philoCount: 3 }));
        send(completed({ philoCount: 4 }));
        send(completed({ otherItems: [{ itemHrid: '/items/coin', count: 1000 }] }));

        expect(game.notified).toHaveLength(1);
    });

    test('two separate stones in one session are two separate announcements', () => {
        send(completed({ philoCount: 3 }));
        send(completed({ philoCount: 4 }));
        send(completed({ philoCount: 5 }));

        expect(game.notified).toHaveLength(2);
        expect(game.notified[0].key).not.toBe(game.notified[1].key);
    });

    test('several stones landing in one batched message report the count', () => {
        send(completed({ philoCount: 3 }));
        send(completed({ philoCount: 6 }));

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toBe('Transmuting produced 3 Philosopher’s Stones!');
    });

    test('a stack that only went down (e.g. sold) is not an announcement', () => {
        send(completed({ philoCount: 3 }));
        send(completed({ philoCount: 1 }));

        expect(game.notified).toHaveLength(0);
    });

    test('coinify and decompose are none of its business, even with a stone row', () => {
        send(completed({ hrid: '/actions/alchemy/coinify', philoCount: 3 }));
        send(completed({ hrid: '/actions/alchemy/decompose', philoCount: 4 }));

        expect(game.notified).toHaveLength(0);
    });

    test('an alert that reached no channel is retried rather than counted as told', () => {
        send(completed({ philoCount: 3 }));
        game.notifyResult = { fired: false, channels: [], reason: 'no channel available' };
        send(completed({ philoCount: 4 }));
        expect(game.notified).toHaveLength(1);

        game.notifyResult = { fired: true, channels: ['toast'] };
        send(completed({ philoCount: 5 }));
        expect(game.notified).toHaveLength(2);
        // The retried notice reports the whole gain since the last delivered one
        expect(game.notified[1].message).toBe('Transmuting produced 2 Philosopher’s Stones!');
    });

    test('the master switch is re-checked per message, not only at initialize', () => {
        send(completed({ philoCount: 3 }));
        game.settings[MASTER_SETTING] = false;
        send(completed({ philoCount: 4 }));

        expect(game.notified).toHaveLength(0);
    });

    test('an item the game data has no name for falls back to a plain label rather than going blank', () => {
        game.initClientData = { itemDetailMap: {} };
        send(completed({ philoCount: 3 }));
        send(completed({ philoCount: 4 }));

        expect(game.notified[0].message).toBe("Transmuting produced a Philosopher's Stone!");
    });

    test('a character switch tears the listeners down', () => {
        game.dmHandlers.character_switching();

        expect(game.wsHandlers.action_completed).toBeUndefined();
        expect(game.dmHandlers.character_switching).toBeUndefined();
    });
});

describe('settings schema backs the philosophers stone alert', () => {
    test('the switch exists, is off until asked for, and says it does not need the tracker', () => {
        const definition = getSettingDefinition(MASTER_SETTING);
        expect(definition).toBeTruthy();
        expect(definition.type).toBe('checkbox');
        expect(definition.default).toBe(false);
        expect(definition.help).toMatch(/Transmute History Tracker/i);
    });
});
