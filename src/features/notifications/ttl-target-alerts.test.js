/**
 * Tests for the Time-to-Level target alert.
 *
 * Reaching a target is the passage of time, not an event, so the module asks
 * the Combat Level panel where things stand on each `skills_updated`. The cases
 * that matter are: no target chosen, the implicit "next level" default, a
 * target already passed at startup, and re-arming when a new target is picked.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { getSettingDefinition } from '../../core/settings-schema.js';

const game = vi.hoisted(() => ({
    settings: {},
    selection: { level: null },
    target: null,
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
        on: (event, handler) => {
            game.dmHandlers[event] = handler;
        },
        off: (event, handler) => {
            if (game.dmHandlers[event] === handler) delete game.dmHandlers[event];
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
vi.mock('../../utils/timer-registry.js', () => ({
    createTimerRegistry: () => ({
        registerInterval: () => {},
        clearAll: () => {},
    }),
}));
vi.mock('../ui/combat-level-panel.js', () => ({
    currentSelection: () => ({ ...game.selection }),
    selectedTarget: () => (game.target ? { ...game.target } : null),
}));

const { default: ttlTargetAlerts, MASTER_SETTING } = await import('./ttl-target-alerts.js');

/** Point the mocked panel at a chosen target for one skill */
function choose({ hrid = '/skills/stamina', name = 'Stamina', level, target }) {
    game.selection = { level: target };
    game.target = { hrid, name, level, target };
}

const tick = () => game.dmHandlers.skills_updated({});

async function reinit() {
    ttlTargetAlerts.disable();
    await ttlTargetAlerts.initialize();
}

describe('time-to-level target alerts', () => {
    beforeEach(async () => {
        game.settings = { [MASTER_SETTING]: true };
        game.selection = { level: null };
        game.target = null;
        game.dmHandlers = {};
        game.notified = [];
        ttlTargetAlerts.disable();
    });

    afterEach(() => {
        ttlTargetAlerts.disable();
    });

    test('the master switch off wires nothing at all', async () => {
        game.settings[MASTER_SETTING] = false;
        await ttlTargetAlerts.initialize();

        expect(game.dmHandlers.skills_updated).toBeUndefined();
        expect(game.dmHandlers.character_switching).toBeUndefined();
    });

    test('reaching a chosen target is announced once', async () => {
        choose({ level: 119, target: 120 });
        await reinit();

        choose({ level: 120, target: 120 });
        tick();

        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toBe('Stamina reached level 120 — your Time to Level target.');
        expect(game.notified[0].options.title).toBe('Target reached');
        expect(game.notified[0].key).toBe('ttl-target:/skills/stamina:120');
    });

    test('a target already passed at startup is seeded silently', async () => {
        choose({ level: 120, target: 120 });
        await reinit();

        tick();

        expect(game.notified).toHaveLength(0);
    });

    test('no chosen target — the implicit next level — says nothing', async () => {
        // selection.level null means the panel default, not a set goal
        game.selection = { level: null };
        game.target = { hrid: '/skills/stamina', name: 'Stamina', level: 120, target: 121 };
        await reinit();

        tick();

        expect(game.notified).toHaveLength(0);
    });

    test('below the target stays quiet until it is reached', async () => {
        choose({ level: 118, target: 120 });
        await reinit();

        tick();
        expect(game.notified).toHaveLength(0);

        choose({ level: 120, target: 120 });
        tick();
        expect(game.notified).toHaveLength(1);
    });

    test('once announced, further ticks at the same target are silent', async () => {
        choose({ level: 119, target: 120 });
        await reinit();

        choose({ level: 120, target: 120 });
        tick();
        tick();
        tick();

        expect(game.notified).toHaveLength(1);
    });

    test('choosing a higher target re-arms the alert', async () => {
        choose({ level: 119, target: 120 });
        await reinit();

        choose({ level: 120, target: 120 });
        tick();
        expect(game.notified).toHaveLength(1);

        choose({ level: 120, target: 125 });
        tick();
        expect(game.notified).toHaveLength(1);

        choose({ level: 125, target: 125 });
        tick();
        expect(game.notified).toHaveLength(2);
        expect(game.notified[1].key).toBe('ttl-target:/skills/stamina:125');
    });

    test('a character switch tears the listeners down', async () => {
        choose({ level: 119, target: 120 });
        await reinit();

        game.dmHandlers.character_switching();

        expect(game.dmHandlers.skills_updated).toBeUndefined();
        expect(game.dmHandlers.character_switching).toBeUndefined();
    });
});

describe('settings schema backs the target alert', () => {
    test('the switch exists and is off until asked for', () => {
        const definition = getSettingDefinition(MASTER_SETTING);
        expect(definition).toBeTruthy();
        expect(definition.type).toBe('checkbox');
        expect(definition.default).toBe(false);
    });
});
