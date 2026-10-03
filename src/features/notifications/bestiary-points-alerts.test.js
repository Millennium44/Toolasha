/**
 * Tests for the Bestiary points target alert.
 *
 * The total comes from `monsters_updated` rows as the game sends them
 * (`{monsterHrid, count, tierData}`, count already tier-weighted and fractional), and the target
 * is a per-character record. The cases that matter: a crossing fires once, a target already
 * reached at load is silent, raising the target re-arms, and a character switch in the middle of
 * an update must not compare one character's target with another's points.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { getSettingDefinition } from '../../core/settings-schema.js';

const game = vi.hoisted(() => ({
    settings: {},
    monsters: null,
    characterId: 'char-a',
    stored: new Map(),
    handlers: {},
    notified: [],
    readGate: null,
    requests: 0,
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback = false) => (key in game.settings ? game.settings[key] : fallback),
        getSettingValue: (key, fallback) => (key in game.settings ? game.settings[key] : fallback),
        setSetting: (key, value) => {
            game.settings[key] = value;
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => game.characterId,
        getCharacterMonsters: () => game.monsters,
        on: (event, handler) => {
            game.handlers[event] = handler;
        },
        off: (event, handler) => {
            if (game.handlers[event] === handler) delete game.handlers[event];
        },
        emit: (event, data) => game.handlers[event]?.(data),
    },
}));
vi.mock('../../utils/character-key.js', () => ({
    readScoped: async (base) => {
        const value = game.stored.get(`${base}_${game.characterId}`) ?? null;
        if (game.readGate) await game.readGate;
        return value;
    },
    writeScoped: async (base, value) => {
        game.stored.set(`${base}_${game.characterId}`, value);
        return true;
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
    createTimerRegistry: () => ({ registerInterval: () => {}, clearAll: () => {} }),
}));

const { default: alerts, MASTER_SETTING } = await import('./bestiary-points-alerts.js');
const { setBestiaryTarget, TARGET_KEY } = await import('../../utils/bestiary-target.js');

/** Rows as `monsters_updated` carries them; counts 10, 10 and 1 are worth 3 + 3 + 1 points */
const rows = (counts) =>
    counts.map((count, i) => ({
        monsterHrid: `/monsters/m${i}`,
        count,
        tierData: JSON.stringify({ 0: count }),
    }));

const send = async (counts) => {
    game.monsters = rows(counts);
    game.handlers.monsters_updated({ monsters: game.monsters });
    await vi.waitFor(() => expect(game.readGate).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('bestiary points alerts', () => {
    beforeEach(() => {
        game.settings = { [MASTER_SETTING]: true };
        game.monsters = null;
        game.characterId = 'char-a';
        game.stored = new Map([[`${TARGET_KEY}_char-a`, 8]]);
        game.handlers = {};
        game.notified = [];
        game.readGate = null;
        alerts.disable();
    });

    afterEach(() => {
        alerts.disable();
    });

    test('fires once when the total crosses the target', async () => {
        await alerts.initialize();
        await send([10, 1]); // 4 points
        expect(game.notified).toHaveLength(0);

        await send([10, 10]); // 6
        await send([100, 10]); // 6 + 3 = 9
        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toBe('Bestiary: 9 points — target 8 reached.');
        expect(game.notified[0].key).toBe('bestiary-points:8');

        await send([100, 100]); // 12, still past the same target
        expect(game.notified).toHaveLength(1);
    });

    test('a target already reached at load is not announced', async () => {
        game.monsters = rows([100, 100]);
        await alerts.initialize();
        await vi.waitFor(() => expect(alerts.seenTarget).toBe(8));
        await send([100, 100]);
        expect(game.notified).toHaveLength(0);
    });

    test('raising the target re-arms it', async () => {
        await alerts.initialize();
        await send([10, 1]);
        await send([100, 10]);
        expect(game.notified).toHaveLength(1);

        game.stored.set(`${TARGET_KEY}_char-a`, 15);
        await send([100, 10]); // 9 points, below the new target: armed, silent
        expect(game.notified).toHaveLength(1);
        await send([1000, 100]); // 10 + 6 = 16
        expect(game.notified).toHaveLength(2);
        expect(game.notified[1].key).toBe('bestiary-points:15');
    });

    test('lowering the target below the total is not a crossing', async () => {
        await alerts.initialize();
        await send([10, 1]);
        game.stored.set(`${TARGET_KEY}_char-a`, 2);
        await send([10, 1]);
        expect(game.notified).toHaveLength(0);
    });

    test('a character switch while the target is being read fires nothing', async () => {
        await alerts.initialize();
        await send([10, 1]);

        let release;
        game.readGate = new Promise((resolve) => {
            release = resolve;
        });
        game.monsters = rows([100, 100]);
        game.handlers.monsters_updated({ monsters: game.monsters });
        // Switch mid-read: character B arrives with no counts yet
        game.characterId = 'char-b';
        game.monsters = null;
        release();
        game.readGate = null;
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(game.notified).toHaveLength(0);
    });

    test('falls back to the settings default when a character has no target of its own', async () => {
        game.stored.clear();
        game.settings.notifications_bestiaryPointsTargetDefault = 8;
        await alerts.initialize();
        await send([10, 1]);
        await send([100, 10]);
        expect(game.notified).toHaveLength(1);
    });

    test('says nothing without a target', async () => {
        game.stored.clear();
        await alerts.initialize();
        await send([1000, 1000]);
        expect(game.notified).toHaveLength(0);
    });

    test('does nothing while the setting is off', async () => {
        game.settings[MASTER_SETTING] = false;
        await alerts.initialize();
        expect(game.handlers.monsters_updated).toBeUndefined();
    });

    test('the planner path stores the target for the current character only and enables the alert', async () => {
        game.settings[MASTER_SETTING] = false;
        game.stored.clear();

        expect(await setBestiaryTarget(1200)).toBe(true);

        expect(game.stored.get(`${TARGET_KEY}_char-a`)).toBe(1200);
        expect(game.stored.has(`${TARGET_KEY}_char-b`)).toBe(false);
        expect(game.settings[MASTER_SETTING]).toBe(true);
    });

    test('a target set from the planner re-checks a running alert without a new Bestiary message', async () => {
        await alerts.initialize();
        await send([10, 1]);
        game.monsters = rows([100, 100]); // 12 points, held already
        await setBestiaryTarget(20);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(game.notified).toHaveLength(0);
        await send([1000, 1000]); // 20
        expect(game.notified).toHaveLength(1);
    });

    test('rejects a target that is not a positive number', async () => {
        expect(await setBestiaryTarget(0)).toBe(false);
        expect(await setBestiaryTarget('abc')).toBe(false);
    });

    test('is a registered setting, off by default', () => {
        expect(getSettingDefinition(MASTER_SETTING).default).toBe(false);
        expect(getSettingDefinition('notifications_bestiaryPointsTargetDefault').default).toBe(0);
    });
});
