/**
 * Tests for the Bestiary points target alert.
 *
 * The baseline is a real `monsters_updated` reading (`{monsterHrid, count, tierData}`, count already
 * tier-weighted and fractional). Between readings the alert counts kills off the combat stream:
 * `new_battle` (`monsters` and `players` keyed by slot) and `battle_updated` (`mMap` of `{cHP}`).
 * It must never ask the game for the Bestiary.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { getSettingDefinition } from '../../core/settings-schema.js';

const game = vi.hoisted(() => ({
    settings: {},
    monsters: null,
    characterId: 'char-a',
    actions: [],
    stored: new Map(),
    dm: {},
    wire: {},
    notified: [],
    readGate: null,
    requests: 0,
    fiberTouched: 0,
    activeSocket: 'socket-a',
    writeFails: false,
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
        getCurrentActions: () => game.actions,
        on: (event, handler) => {
            game.dm[event] = handler;
        },
        off: (event, handler) => {
            if (game.dm[event] === handler) delete game.dm[event];
        },
        emit: (event, data) => game.dm[event]?.(data),
        isFromActiveSocket: (context) => context?.socket === game.activeSocket,
    },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (event, handler) => {
            game.wire[event] = handler;
        },
        off: (event, handler) => {
            if (game.wire[event] === handler) delete game.wire[event];
        },
    },
}));
vi.mock('../../utils/character-key.js', () => ({
    readScoped: async (base) => {
        const value = game.stored.get(`${base}_${game.characterId}`) ?? null;
        if (game.readGate) await game.readGate;
        return value;
    },
    writeScoped: async (base, value) => {
        if (game.writeFails) return false;
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
vi.mock('../../utils/bestiary-target.js', async (importOriginal) => {
    const original = await importOriginal();
    return {
        ...original,
        requestBestiary: () => {
            game.requests += 1;
        },
    };
});

globalThis.document = {
    getElementById: () => {
        game.fiberTouched += 1;
        return null;
    },
};

const { default: alerts, MASTER_SETTING, BASELINE_KEY, FIRED_KEY } = await import('./bestiary-points-alerts.js');
const { setBestiaryTarget, TARGET_KEY, TARGET_CHANGED_EVENT } = await import('../../utils/bestiary-target.js');

/** Rows as `monsters_updated` carries them */
const rows = (counts) =>
    Object.entries(counts).map(([name, count]) => ({
        monsterHrid: `/monsters/${name}`,
        count,
        tierData: JSON.stringify({ 0: count }),
    }));

/** The delivery context of a message from the active character's socket */
const ACTIVE = { socket: 'socket-a' };
const STALE = { socket: 'socket-old' };

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A real reading, as the Achievements tab or the sim's fetch causes */
const reading = async (counts) => {
    game.monsters = rows(counts);
    // Before the alert is listening the reading is just what the data manager already holds
    game.dm.monsters_updated?.({ monsters: game.monsters });
    await tick();
};

/** A wave of the given monsters, solo unless more players are named */
const wave = (names, players = 1, context = ACTIVE) => {
    game.wire.new_battle(
        {
            monsters: Object.fromEntries(
                names.map((name, i) => [
                    String(i),
                    { hrid: `/monsters/${name}`, currentHitpoints: 100, combatDetails: { maxHitpoints: 100 } },
                ])
            ),
            players: Object.fromEntries(Array.from({ length: players }, (_, i) => [String(i), { name: `p${i}` }])),
        },
        context
    );
};

/** Kill the monster in a slot, as a compact tick shows it */
const kill = async (slot = 0, context = ACTIVE) => {
    game.wire.battle_updated({ mMap: { [slot]: { cHP: 0 } } }, context);
    await tick();
};

const fighting = (difficultyTier) => {
    game.actions = [{ actionHrid: '/actions/combat/fly', difficultyTier, isDone: false, ordinal: 1 }];
};

describe('bestiary points alerts', () => {
    beforeEach(async () => {
        game.settings = { [MASTER_SETTING]: true };
        alerts.stoppedOn = null;
        game.monsters = null;
        game.characterId = 'char-a';
        game.stored = new Map([[`${TARGET_KEY}_char-a`, 3]]);
        game.dm = {};
        game.wire = {};
        game.notified = [];
        game.readGate = null;
        game.requests = 0;
        game.fiberTouched = 0;
        game.writeFails = false;
        fighting(0);
        alerts.disable();
    });

    afterEach(() => {
        alerts.disable();
    });

    test('kills advance the estimate by tier and party credits', async () => {
        await reading({ fly: 9 });
        await alerts.initialize();

        wave(['fly'], 2);
        await kill(); // tier 0 across two players: half a credit
        expect(alerts.estimatedCounts()).toEqual({ '/monsters/fly': 9.5 });

        fighting(2);
        wave(['fly'], 1);
        await kill(); // tier 2 solo: three credits
        expect(alerts.estimatedCounts()['/monsters/fly']).toBe(12.5);
    });

    test('a crossing on an estimate fires once, says it is about', async () => {
        await reading({ fly: 9 }); // 1 point, target 3
        await alerts.initialize();
        expect(game.notified).toHaveLength(0);

        wave(['fly', 'fly']);
        await kill(0); // fly reaches 10: 3 points
        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toBe('Bestiary: about 3 points — target 3 reached (estimated from kills).');

        await kill(1);
        expect(game.notified).toHaveLength(1);
    });

    test('combat messages from a stale socket add no credit', async () => {
        await reading({ fly: 9 });
        await alerts.initialize();

        wave(['fly'], 1, STALE); // the old socket's wave is not remembered
        await kill(0, STALE);
        expect(alerts.estimatedCounts()).toEqual({ '/monsters/fly': 9 });

        wave(['fly']);
        await kill(0, STALE); // a tick from the stale socket does not credit the active wave
        expect(alerts.estimatedCounts()).toEqual({ '/monsters/fly': 9 });
        expect(game.notified).toHaveLength(0);

        await kill();
        expect(alerts.estimatedCounts()).toEqual({ '/monsters/fly': 10 });
    });

    test('a slot is one kill however many ticks show it at zero', async () => {
        await reading({ fly: 5 });
        await alerts.initialize();
        wave(['fly']);
        await kill();
        await kill();
        expect(alerts.estimatedCounts()['/monsters/fly']).toBe(6);
    });

    test('a real reading replaces the estimate and fires if the estimate missed the crossing', async () => {
        await reading({ fly: 5 });
        await alerts.initialize();
        wave(['fly']);
        await kill(); // estimate 6
        expect(alerts.estimatedCounts()['/monsters/fly']).toBe(6);

        await reading({ fly: 12 }); // the game says 3 points
        expect(alerts.estimatedCounts()).toEqual({ '/monsters/fly': 12 });
        expect(game.notified).toHaveLength(1);
        expect(game.notified[0].message).toBe('Bestiary: 3 points — target 3 reached.');
    });

    test('a real reading does not repeat an estimated crossing', async () => {
        await reading({ fly: 9 });
        await alerts.initialize();
        wave(['fly']);
        await kill();
        await reading({ fly: 10 });
        expect(game.notified).toHaveLength(1);
    });

    test('with no baseline nothing is estimated and nothing fires', async () => {
        await alerts.initialize();
        wave(['fly']);
        await kill();
        expect(alerts.estimatedCounts()).toBeNull();
        expect(game.notified).toHaveLength(0);
    });

    test('a stored baseline survives a reload', async () => {
        await reading({ fly: 9 });
        await alerts.initialize();
        expect(game.stored.get(`${BASELINE_KEY}_char-a`)).toEqual({ '/monsters/fly': 9 });

        // Reload: nothing held in the data manager, the stored baseline is all there is
        alerts.disable();
        game.monsters = null;
        await alerts.initialize();
        expect(alerts.estimatedCounts()).toEqual({ '/monsters/fly': 9 });
        wave(['fly']);
        await kill();
        expect(game.notified).toHaveLength(1);
    });

    test('an estimated crossing does not repeat after a reload that restores the older baseline', async () => {
        await reading({ fly: 9 });
        await alerts.initialize();
        wave(['fly']);
        await kill(); // estimated crossing, announced
        expect(game.notified).toHaveLength(1);
        expect(game.stored.get(`${FIRED_KEY}_char-a`)).toBe(3);

        // Reload: only the real baseline (9) is stored; no monsters_updated arrives first
        alerts.disable();
        game.monsters = null;
        await alerts.initialize();
        wave(['fly']);
        await kill();
        expect(game.notified).toHaveLength(1);

        // A raised target still re-arms
        game.stored.set(`${TARGET_KEY}_char-a`, 6);
        await reading({ fly: 10 });
        expect(game.notified).toHaveLength(1);
        await reading({ fly: 100 }); // 6 points
        expect(game.notified).toHaveLength(2);
    });

    test('a target already reached at load is not announced', async () => {
        await reading({ fly: 100 });
        await alerts.initialize();
        await reading({ fly: 100 });
        expect(game.notified).toHaveLength(0);
    });

    test('raising the target re-arms it; lowering it below the total is silent', async () => {
        await reading({ fly: 9 });
        await alerts.initialize();
        wave(['fly']);
        await kill();
        expect(game.notified).toHaveLength(1);

        game.stored.set(`${TARGET_KEY}_char-a`, 6);
        await reading({ fly: 10 });
        expect(game.notified).toHaveLength(1);
        await reading({ fly: 100 }); // 6 points
        expect(game.notified).toHaveLength(2);

        game.stored.set(`${TARGET_KEY}_char-a`, 2);
        await reading({ fly: 100 });
        expect(game.notified).toHaveLength(2);
    });

    test('a character switch while the target is being read fires nothing', async () => {
        await reading({ fly: 9 });
        await alerts.initialize();

        let release;
        game.readGate = new Promise((resolve) => {
            release = resolve;
        });
        wave(['fly']);
        game.wire.battle_updated({ mMap: { 0: { cHP: 0 } } }, ACTIVE); // would cross for character A
        game.characterId = 'char-b';
        game.monsters = null;
        release();
        game.readGate = null;
        await tick();
        await tick();

        expect(game.notified).toHaveLength(0);
    });

    test('a character switch clears the estimate, and a stored baseline is per character', async () => {
        await reading({ fly: 9 });
        await alerts.initialize();
        game.dm.character_switching();
        expect(alerts.estimatedCounts()).toBeNull();
        expect(game.wire.battle_updated).toBeUndefined();

        game.characterId = 'char-b';
        game.monsters = null;
        game.stored.set(`${TARGET_KEY}_char-b`, 3);
        await alerts.initialize();
        expect(alerts.estimatedCounts()).toBeNull();
    });

    test('guild trial monsters and fights with no combat action are not estimated', async () => {
        await reading({ fly: 9, trial_rat: 9 });
        await alerts.initialize();

        wave(['trial_rat']);
        await kill();
        expect(alerts.estimatedCounts()).toEqual({ '/monsters/fly': 9, '/monsters/trial_rat': 9 });

        game.actions = [{ actionHrid: '/actions/labyrinth', isDone: false }];
        wave(['fly']);
        await kill();
        expect(alerts.estimatedCounts()['/monsters/fly']).toBe(9);
    });

    test('the alert never asks the game for the Bestiary', async () => {
        await reading({ fly: 9 });
        await alerts.initialize();
        wave(['fly']);
        await kill();
        await reading({ fly: 12 });
        alerts.disable();
        await alerts.initialize();

        expect(game.requests).toBe(0);
        expect(game.fiberTouched).toBe(0);
    });

    test('falls back to the settings default, and says nothing without a target', async () => {
        game.stored.delete(`${TARGET_KEY}_char-a`);
        game.settings.notifications_bestiaryPointsTargetDefault = 3;
        await reading({ fly: 9 });
        await alerts.initialize();
        wave(['fly']);
        await kill();
        expect(game.notified).toHaveLength(1);

        alerts.disable();
        game.notified = [];
        game.settings.notifications_bestiaryPointsTargetDefault = 0;
        await alerts.initialize();
        await reading({ fly: 1000 });
        expect(game.notified).toHaveLength(0);
    });

    test('a live stop removes the handlers, and re-enabling treats a reached target as old news', async () => {
        await reading({ fly: 9 });
        await alerts.initialize();
        alerts.disable(); // what the registry's live stop calls when the setting is cleared
        expect(game.wire.new_battle).toBeUndefined();
        expect(game.wire.battle_updated).toBeUndefined();
        expect(game.dm.monsters_updated).toBeUndefined();
        expect(alerts.estimatedCounts()).toBeNull();

        // Kills while it is off, then it is switched back on holding a reading past the target
        await reading({ fly: 100 });
        game.settings[MASTER_SETTING] = true;
        await alerts.initialize();
        expect(game.notified).toHaveLength(0);
    });

    test('switching it off and on waits for a fresh reading instead of estimating from the old one', async () => {
        await reading({ fly: 9 }); // 1 point, target 3
        await alerts.initialize();

        game.settings[MASTER_SETTING] = false;
        alerts.disable(); // the live stop
        expect(game.stored.get(`${BASELINE_KEY}_char-a`)).toBeNull();

        // The tenth fly dies while it is off; switched back on, the held reading still says 9
        game.settings[MASTER_SETTING] = true;
        await alerts.initialize();
        expect(alerts.estimatedCounts()).toBeNull();
        wave(['fly']);
        await kill();
        expect(game.notified).toHaveLength(0);

        // The next real reading is the baseline again, and the crossing it shows is old news
        await reading({ fly: 11 });
        expect(alerts.estimatedCounts()).toEqual({ '/monsters/fly': 11 });
        expect(game.notified).toHaveLength(0);
    });

    test('a reading that arrived while it was off is a baseline when it is switched back on', async () => {
        await reading({ fly: 9 });
        await alerts.initialize();
        game.settings[MASTER_SETTING] = false;
        alerts.disable();

        await reading({ fly: 9 }); // a newer reading, taken while it was off
        game.settings[MASTER_SETTING] = true;
        await alerts.initialize();
        expect(alerts.estimatedCounts()).toEqual({ '/monsters/fly': 9 });
    });

    test('does nothing while the setting is off', async () => {
        game.settings[MASTER_SETTING] = false;
        await alerts.initialize();
        expect(game.dm.monsters_updated).toBeUndefined();
        expect(game.wire.new_battle).toBeUndefined();
    });

    test('the planner path stores the target for the current character only and enables the alert', async () => {
        game.settings[MASTER_SETTING] = false;
        game.stored.clear();

        expect(await setBestiaryTarget(1200)).toBe(true);

        expect(game.stored.get(`${TARGET_KEY}_char-a`)).toBe(1200);
        expect(game.stored.has(`${TARGET_KEY}_char-b`)).toBe(false);
        expect(game.settings[MASTER_SETTING]).toBe(true);
        expect(await setBestiaryTarget(0)).toBe(false);
    });

    test('a failed target write leaves the alert setting alone and sends no change event', async () => {
        game.settings[MASTER_SETTING] = false;
        game.writeFails = true;
        const changed = vi.fn();
        game.dm[TARGET_CHANGED_EVENT] = changed;

        expect(await setBestiaryTarget(1200)).toBe(false);

        expect(game.settings[MASTER_SETTING]).toBe(false);
        expect(changed).not.toHaveBeenCalled();
    });

    test('a target set from the planner re-checks a running alert', async () => {
        await reading({ fly: 100 }); // 6 points
        await alerts.initialize();
        await setBestiaryTarget(9);
        await tick();
        expect(game.notified).toHaveLength(0);
        await reading({ fly: 1000 }); // 10 points
        expect(game.notified).toHaveLength(1);
    });

    test('is a registered setting, off by default', () => {
        expect(getSettingDefinition(MASTER_SETTING).default).toBe(false);
        expect(getSettingDefinition('notifications_bestiaryPointsTargetDefault').default).toBe(0);
    });
});
