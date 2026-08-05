/**
 * Tests for the enhancement target alert.
 *
 * The server keeps describing a finished enhancing action, so "at target" is a
 * state that is true for a long time after the one moment it is news. Most of
 * what is below is about announcing that moment once and re-arming only when
 * the grind genuinely starts again.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { getSettingDefinition } from '../../core/settings-schema.js';

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
    default: enhancementTargetAlerts,
    MASTER_SETTING,
    ENHANCE_ACTION_HRID,
    parseEnhancedItem,
} = await import('./enhancement-target-alerts.js');

const DAGGER = '/items/enhancers_top';

/** An `action_completed` for one enhancing attempt */
function attempt({ item = DAGGER, level = 0, target = 10, hrid = ENHANCE_ACTION_HRID } = {}) {
    return {
        endCharacterAction: {
            actionHrid: hrid,
            enhancingMaxLevel: target,
            primaryItemHash: `161296::/item_locations/inventory::${item}::${level}`,
        },
    };
}

const send = (payload) => game.wsHandlers.action_completed(payload);

describe('parseEnhancedItem', () => {
    test('reads the item and its level out of the long form', () => {
        expect(parseEnhancedItem('161296::/item_locations/inventory::/items/enhancers_top::5')).toEqual({
            itemHrid: '/items/enhancers_top',
            level: 5,
        });
    });

    test('reads the short form, which has no leading item id', () => {
        expect(parseEnhancedItem('/item_locations/inventory::/items/enhancers_top::0')).toEqual({
            itemHrid: '/items/enhancers_top',
            level: 0,
        });
    });

    test('a bare hrid is level zero of that item', () => {
        expect(parseEnhancedItem('/items/enhancers_top')).toEqual({ itemHrid: '/items/enhancers_top', level: 0 });
    });

    test('a hash naming no item yields no item, rather than level zero of nothing', () => {
        expect(parseEnhancedItem('161296::/item_locations/inventory::3').itemHrid).toBeNull();
        expect(parseEnhancedItem('').itemHrid).toBeNull();
        expect(parseEnhancedItem(undefined).itemHrid).toBeNull();
    });
});

describe('enhancement target alerts', () => {
    beforeEach(async () => {
        game.settings = { [MASTER_SETTING]: true };
        game.initClientData = { itemDetailMap: { [DAGGER]: { name: 'Enhancer’s Top' } } };
        game.wsHandlers = {};
        game.dmHandlers = {};
        game.notified = [];
        game.notifyResult = { fired: true, channels: ['toast'] };
        enhancementTargetAlerts.disable();
        await enhancementTargetAlerts.initialize();
    });

    afterEach(() => {
        enhancementTargetAlerts.disable();
    });

    test('the master switch off wires nothing at all', async () => {
        enhancementTargetAlerts.disable();
        game.settings[MASTER_SETTING] = false;
        await enhancementTargetAlerts.initialize();

        expect(game.wsHandlers.action_completed).toBeUndefined();
        expect(game.dmHandlers.character_switching).toBeUndefined();
    });

    test('reaching the target is announced, by the item’s real name', () => {
        send(attempt({ level: 9, target: 10 }));
        send(attempt({ level: 10, target: 10 }));

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toContain('Enhancer’s Top');
        expect(game.notified[0].message).toContain('(+10)');
        expect(game.notified[0].options.title).toBe('Enhancement target reached');
    });

    test('overshooting the target says so rather than pretending it landed exactly', () => {
        send(attempt({ level: 9, target: 10 }));
        send(attempt({ level: 11, target: 10 }));

        expect(game.notified[0].message).toContain('+11, past your +10');
    });

    test('attempts below the target are silent', () => {
        send(attempt({ level: 0, target: 10 }));
        send(attempt({ level: 4, target: 10 }));
        send(attempt({ level: 9, target: 10 }));

        expect(game.notified).toHaveLength(0);
    });

    test('the messages that keep arriving about a finished action do not repeat it', () => {
        send(attempt({ level: 10, target: 10 }));
        send(attempt({ level: 10, target: 10 }));
        send(attempt({ level: 10, target: 10 }));

        expect(game.notified).toHaveLength(1);
    });

    test('the same item and target announce again once the grind restarts below it', () => {
        send(attempt({ level: 10, target: 10 }));
        expect(game.notified).toHaveLength(1);

        send(attempt({ level: 3, target: 10 }));
        send(attempt({ level: 10, target: 10 }));

        expect(game.notified).toHaveLength(2);
    });

    test('raising the target is a different target, and gets its own message', () => {
        send(attempt({ level: 10, target: 10 }));
        send(attempt({ level: 14, target: 14 }));

        expect(game.notified).toHaveLength(2);
        expect(game.notified[1].message).toContain('(+14)');
    });

    test('a different item at the same target is its own announcement', () => {
        send(attempt({ item: '/items/enhancers_bottoms', level: 10, target: 10 }));
        send(attempt({ item: DAGGER, level: 10, target: 10 }));

        expect(game.notified).toHaveLength(2);
        expect(game.notified[0].key).not.toBe(game.notified[1].key);
    });

    test('no target set is "keep going", which has no ending to announce', () => {
        send(attempt({ level: 12, target: 0 }));
        // The field absent altogether, rather than set to nothing
        send({
            endCharacterAction: {
                actionHrid: ENHANCE_ACTION_HRID,
                primaryItemHash: `161296::/item_locations/inventory::${DAGGER}::12`,
            },
        });

        expect(game.notified).toHaveLength(0);
    });

    test('any action that is not enhancing is none of its business', () => {
        send(attempt({ level: 10, target: 10, hrid: '/actions/cheesesmithing/cheese_hat' }));
        send({ endCharacterAction: null });
        send({});

        expect(game.notified).toHaveLength(0);
    });

    test('an item the game data has no name for falls back to its hrid rather than going blank', () => {
        game.initClientData = { itemDetailMap: {} };
        send(attempt({ level: 10, target: 10 }));

        expect(game.notified[0].message).toContain('enhancers_top');
    });

    test('the event key names the item and the target', () => {
        send(attempt({ level: 10, target: 10 }));

        expect(game.notified[0].key).toBe(`enhancement-target:${DAGGER}:10`);
    });

    test('an alert that reached no channel is retried rather than counted as told', () => {
        game.notifyResult = { fired: false, channels: [], reason: 'no channel available' };
        send(attempt({ level: 10, target: 10 }));
        expect(game.notified).toHaveLength(1);

        game.notifyResult = { fired: true, channels: ['toast'] };
        send(attempt({ level: 10, target: 10 }));
        expect(game.notified).toHaveLength(2);

        send(attempt({ level: 10, target: 10 }));
        expect(game.notified).toHaveLength(2);
    });

    test('the master switch is re-checked per attempt, not only at initialize', () => {
        game.settings[MASTER_SETTING] = false;
        send(attempt({ level: 10, target: 10 }));

        expect(game.notified).toHaveLength(0);
    });

    test('a character switch tears the listeners down', () => {
        game.dmHandlers.character_switching();

        expect(game.wsHandlers.action_completed).toBeUndefined();
        expect(game.dmHandlers.character_switching).toBeUndefined();
    });
});

describe('settings schema backs the enhancement alert', () => {
    test('the switch exists, is off until asked for, and says it does not need the tracker', () => {
        const definition = getSettingDefinition(MASTER_SETTING);
        expect(definition).toBeTruthy();
        expect(definition.type).toBe('checkbox');
        expect(definition.default).toBe(false);
        expect(definition.help).toMatch(/Enhancement Tracker/i);
    });
});
