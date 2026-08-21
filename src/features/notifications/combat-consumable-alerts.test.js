/**
 * Tests for the combat consumable alert: the reading is the Consumables
 * panel's own "stops in …" figure for this character, and the crossing is the
 * shared threshold predicate — under fires once, above re-arms.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { getSettingDefinition } from '../../core/settings-schema.js';

const game = vi.hoisted(() => ({
    settings: {},
    values: {},
    latest: null,
    wsHandlers: {},
    dmHandlers: {},
    notified: [],
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback = false) => (key in game.settings ? game.settings[key] : fallback),
        getSettingValue: (key, fallback) => (key in game.values ? game.values[key] : fallback),
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: () => null,
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
            return { fired: true };
        },
    },
}));
vi.mock('../combat-stats/combat-stats-data-collector.js', () => ({
    default: { getLatestData: () => game.latest },
}));
vi.mock('../combat-stats/combat-stats-calculator.js', () => ({
    // The breakdown is whatever the player entry carries, for the test's convenience
    calculatePlayerStats: (player) => ({ consumableBreakdown: player.breakdown || [] }),
}));

const {
    default: alerts,
    MASTER_SETTING,
    HOURS_SETTING,
    soonestCombatConsumable,
} = await import('./combat-consumable-alerts.js');

/** A consumable entry as the calculator hands it: so many held, eaten at a rate per second */
const eating = (itemHrid, itemName, held, perSecond) => ({
    itemHrid,
    itemName,
    inventoryAmount: held,
    consumptionRate: perSecond,
});

beforeEach(() => {
    game.settings = { [MASTER_SETTING]: true };
    game.values = { [HOURS_SETTING]: 0.5 };
    game.latest = null;
    game.wsHandlers = {};
    game.dmHandlers = {};
    game.notified = [];
});

afterEach(() => {
    alerts.disable();
});

describe('the reading', () => {
    test('is the soonest of this character’s own consumables to run out', () => {
        game.latest = {
            durationSeconds: 100,
            players: [
                { isCurrentPlayer: false, breakdown: [eating('/items/x', 'Theirs', 1, 1)] },
                {
                    isCurrentPlayer: true,
                    breakdown: [
                        eating('/items/cake', 'Spaceberry Cake', 1000, 0.001), // ~11.5 days
                        eating('/items/yogurt', 'Dragon Fruit Yogurt', 60, 0.1), // 600 s
                    ],
                },
            ],
        };
        const soonest = soonestCombatConsumable();
        expect(soonest.name).toBe('Dragon Fruit Yogurt');
        expect(soonest.secondsLeft).toBeCloseTo(600, 3);
    });

    test('no current player, or nothing being used, is no reading', () => {
        game.latest = { players: [{ isCurrentPlayer: false, breakdown: [] }] };
        expect(soonestCombatConsumable()).toBeNull();
        game.latest = { players: [{ isCurrentPlayer: true, breakdown: [eating('/items/cake', 'Cake', 10, 0)] }] };
        expect(soonestCombatConsumable()).toBeNull();
    });
});

describe('the crossing', () => {
    const withSeconds = (seconds) => {
        game.latest = {
            players: [
                { isCurrentPlayer: true, breakdown: [eating('/items/yogurt', 'Dragon Fruit Yogurt', seconds, 1)] },
            ],
        };
    };

    test('fires once when the soonest falls under the configured hours, and re-arms above', async () => {
        await alerts.initialize();
        withSeconds(3600);
        game.wsHandlers.battle_updated({});
        expect(game.notified).toEqual([]);

        withSeconds(25 * 60);
        game.wsHandlers.battle_updated({});
        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toContain('Dragon Fruit Yogurt');
        expect(game.notified[0].message).toContain('25m');

        // Still under: quiet
        withSeconds(20 * 60);
        game.wsHandlers.battle_updated({});
        expect(game.notified).toHaveLength(1);

        // Restocked above, then under again: fires again
        withSeconds(2 * 3600);
        game.wsHandlers.battle_updated({});
        withSeconds(10 * 60);
        game.wsHandlers.battle_updated({});
        expect(game.notified).toHaveLength(2);
    });

    test('the threshold is the setting, in hours', async () => {
        game.values = { [HOURS_SETTING]: 2 };
        await alerts.initialize();
        withSeconds(90 * 60);
        game.wsHandlers.battle_updated({});
        expect(game.notified).toHaveLength(1);
    });

    test('a blank or nonsense threshold falls back to the default', async () => {
        game.values = { [HOURS_SETTING]: 'x' };
        await alerts.initialize();
        withSeconds(3.1 * 3600);
        game.wsHandlers.battle_updated({});
        expect(game.notified).toEqual([]);
        withSeconds(2.9 * 3600);
        game.wsHandlers.battle_updated({});
        expect(game.notified).toHaveLength(1);
    });

    test('off, nothing listens', async () => {
        game.settings = { [MASTER_SETTING]: false };
        await alerts.initialize();
        expect(game.wsHandlers.battle_updated).toBeUndefined();
    });
});

describe('the settings', () => {
    test('exist and default off, three hours', () => {
        expect(getSettingDefinition(MASTER_SETTING)?.default).toBe(false);
        expect(getSettingDefinition(HOURS_SETTING)?.default).toBe(3);
    });
});
