/**
 * Tests for the Philosopher's Stone alert.
 *
 * `endCharacterItems` rows carry a stack's new ABSOLUTE total, not the
 * amount gained — most of what is below is about turning that into "did a
 * fresh stone actually land", once per stone rather than once per session,
 * seeded from the character's real inventory rather than the first message
 * this module happens to see.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { getSettingDefinition } from '../../core/settings-schema.js';
import { PHILO_HRID } from '../alchemy/philosophers-stone-hrid.js';

const INVENTORY_LOCATION = '/item_locations/inventory';

const game = vi.hoisted(() => ({
    settings: {},
    initClientData: null,
    inventory: null,
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
        getInventory: () => game.inventory,
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

const { default: philoStoneAlerts, MASTER_SETTING, TRANSMUTE_ACTION_HRID } = await import('./philo-stone-alerts.js');

/** An inventory row for the stone, the shape `dataManager.getInventory()` hands back */
function philoStack(count) {
    return { itemHrid: PHILO_HRID, itemLocationHrid: INVENTORY_LOCATION, count };
}

/** An `action_completed` for one (or a batched several) transmute attempts */
function completed({ hrid = TRANSMUTE_ACTION_HRID, philoCount, otherItems = [] } = {}) {
    const endCharacterItems = [...otherItems];
    if (philoCount !== undefined) {
        endCharacterItems.push({ itemHrid: PHILO_HRID, itemLocationHrid: INVENTORY_LOCATION, count: philoCount });
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
        // Fresh login, no stones yet — the common case, and the one the
        // baseline rewrite exists for: a stone on the very first attempt
        // must still be announced.
        game.inventory = [];
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
        expect(game.dmHandlers.character_initialized).toBeUndefined();
    });

    test('a stone on the very first action_completed still announces, seeded from inventory at zero', () => {
        send(completed({ philoCount: 1 }));

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toBe('Transmuting produced a Philosopher’s Stone!');
        expect(game.notified[0].options.title).toBe("Philosopher's Stone!");
    });

    test('the maintainer’s case: two attempts, one success, still notifies', () => {
        send(completed({ otherItems: [{ itemHrid: '/items/coin', count: 500 }] })); // failed attempt, no stone row
        send(completed({ philoCount: 1 })); // succeeded

        expect(game.notified).toHaveLength(1);
    });

    test('seeding from a non-empty existing stack does not announce an unchanged row', async () => {
        philoStoneAlerts.disable();
        game.inventory = [philoStack(5)];
        await philoStoneAlerts.initialize();

        send(completed({ philoCount: 5 }));

        expect(game.notified).toHaveLength(0);
    });

    test('a gain on top of a pre-existing stack announces just the gain', async () => {
        philoStoneAlerts.disable();
        game.inventory = [philoStack(5)];
        await philoStoneAlerts.initialize();

        send(completed({ philoCount: 7 }));

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toBe('Transmuting produced 2 Philosopher’s Stones!');
    });

    test('a character with no stone row in inventory seeds a baseline of zero, not "unknown"', async () => {
        philoStoneAlerts.disable();
        game.inventory = [{ itemHrid: '/items/coin', itemLocationHrid: INVENTORY_LOCATION, count: 1000 }];
        await philoStoneAlerts.initialize();

        send(completed({ philoCount: 1 }));

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toBe('Transmuting produced a Philosopher’s Stone!');
    });

    test('starting before character data has arrived seeds nothing, and character_initialized catches it up', async () => {
        philoStoneAlerts.disable();
        game.inventory = null; // not loaded yet when this feature starts
        await philoStoneAlerts.initialize();

        // A stone message arriving in this gap goes through the no-baseline
        // fallback rather than being lost
        send(completed({ philoCount: 1 }));
        expect(game.notified).toHaveLength(1);

        // Character data now arrives and re-seeds from the real inventory
        game.inventory = [philoStack(1)];
        game.dmHandlers.character_initialized({});

        // The seeded baseline matches what the fallback already announced,
        // so an unchanged row does not repeat it
        send(completed({ philoCount: 1 }));
        expect(game.notified).toHaveLength(1);

        // A further, properly-seeded gain still announces normally
        send(completed({ philoCount: 2 }));
        expect(game.notified).toHaveLength(2);
    });

    test('the no-inventory fallback announces rather than staying silent, and does not repeat itself', async () => {
        philoStoneAlerts.disable();
        game.inventory = null; // stays unavailable all session
        await philoStoneAlerts.initialize();

        send(completed({ philoCount: 1 }));
        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toBe('Transmuting produced a Philosopher’s Stone!');

        // The fallback's own row becomes the baseline, so the next unchanged
        // message is not read as a second stone
        send(completed({ philoCount: 1 }));
        expect(game.notified).toHaveLength(1);

        send(completed({ philoCount: 3 }));
        expect(game.notified).toHaveLength(2);
        expect(game.notified[1].message).toBe('Transmuting produced 2 Philosopher’s Stones!');
    });

    test('overshooting is not a concept here, but a transmute with no stone row is silent', () => {
        send(completed({ otherItems: [{ itemHrid: '/items/coin', count: 1000 }] }));

        expect(game.notified).toHaveLength(0);
    });

    test('a row for the stone in some other item location is not read as an inventory gain', () => {
        send({
            endCharacterAction: { actionHrid: TRANSMUTE_ACTION_HRID },
            endCharacterItems: [{ itemHrid: PHILO_HRID, itemLocationHrid: '/item_locations/marketplace', count: 5 }],
        });

        expect(game.notified).toHaveLength(0);
    });

    test('the messages that keep arriving about a finished action do not repeat it', () => {
        send(completed({ philoCount: 1 }));
        send(completed({ philoCount: 1 }));
        send(completed({ philoCount: 1 }));

        expect(game.notified).toHaveLength(1);
    });

    test('two separate stones in one session are two separate announcements', () => {
        send(completed({ philoCount: 1 }));
        send(completed({ philoCount: 2 }));

        expect(game.notified).toHaveLength(2);
        expect(game.notified[0].key).not.toBe(game.notified[1].key);
    });

    test('several stones landing in one batched message report the count', () => {
        send(completed({ philoCount: 3 }));

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toBe('Transmuting produced 3 Philosopher’s Stones!');
    });

    test('a batch carrying two snapshots of the stack reads the last, not the first', async () => {
        philoStoneAlerts.disable();
        game.inventory = [philoStack(6)];
        await philoStoneAlerts.initialize();

        // One message, one batch of attempts, two stones: the game sends a row
        // per step of the stack rather than one row for the batch
        send({
            endCharacterAction: { actionHrid: TRANSMUTE_ACTION_HRID },
            endCharacterItems: [
                { itemHrid: PHILO_HRID, itemLocationHrid: INVENTORY_LOCATION, count: 7 },
                { itemHrid: PHILO_HRID, itemLocationHrid: INVENTORY_LOCATION, count: 8 },
            ],
        });

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toBe('Transmuting produced 2 Philosopher’s Stones!');

        // And the baseline is the stack's real total, so the next genuine
        // stone is a gain of one rather than of two
        send(completed({ philoCount: 9 }));
        expect(game.notified).toHaveLength(2);
        expect(game.notified[1].message).toBe('Transmuting produced a Philosopher’s Stone!');
    });

    test('a stack that only went down (e.g. sold) is not an announcement', async () => {
        philoStoneAlerts.disable();
        game.inventory = [philoStack(3)];
        await philoStoneAlerts.initialize();

        send(completed({ philoCount: 1 }));

        expect(game.notified).toHaveLength(0);
    });

    test('coinify and decompose are none of its business, even with a stone row', () => {
        send(completed({ hrid: '/actions/alchemy/coinify', philoCount: 1 }));
        send(completed({ hrid: '/actions/alchemy/decompose', philoCount: 2 }));

        expect(game.notified).toHaveLength(0);
    });

    test('an alert that reached no channel is retried rather than counted as told', () => {
        game.notifyResult = { fired: false, channels: [], reason: 'no channel available' };
        send(completed({ philoCount: 1 }));
        expect(game.notified).toHaveLength(1);

        game.notifyResult = { fired: true, channels: ['toast'] };
        send(completed({ philoCount: 2 }));
        expect(game.notified).toHaveLength(2);
        // The retried notice reports the whole gain since the last delivered one
        expect(game.notified[1].message).toBe('Transmuting produced 2 Philosopher’s Stones!');
    });

    test('the master switch is re-checked per message, not only at initialize', () => {
        send(completed({ philoCount: 1 }));
        game.settings[MASTER_SETTING] = false;
        send(completed({ philoCount: 2 }));

        expect(game.notified).toHaveLength(1);
    });

    test('an item the game data has no name for falls back to a plain label rather than going blank', () => {
        game.initClientData = { itemDetailMap: {} };
        send(completed({ philoCount: 1 }));

        expect(game.notified[0].message).toBe("Transmuting produced a Philosopher's Stone!");
    });

    test('a character switch tears the listeners down', () => {
        game.dmHandlers.character_switching();

        expect(game.wsHandlers.action_completed).toBeUndefined();
        expect(game.dmHandlers.character_switching).toBeUndefined();
        expect(game.dmHandlers.character_initialized).toBeUndefined();
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
