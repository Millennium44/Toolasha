/**
 * What the worker entry hands the engine.
 *
 * The module installs a global `onmessage` and answers with `postMessage`, so
 * with both stubbed it is an ordinary function. What is worth pinning here is
 * the labyrinth wiring: `fullAbilities` defaults ON inside Labyrinth (`!== false`),
 * and the entry coercing it with `=== true` turned an absent field into the
 * stripped tier-0 monster — the opposite of the documented default, and a
 * monster missing its stun/shred kit reads as an easier clear than it is.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const harness = vi.hoisted(() => ({ labyrinthArgs: [], posted: [] }));

vi.mock('./engine/labyrinth.js', () => ({
    default: class {
        constructor(...args) {
            harness.labyrinthArgs.push(args);
            this.buffs = [];
            this.zoneFight = args[5]?.zoneFight === true;
            this.fullAbilities = args[4] !== false;
        }
    },
}));

vi.mock('./engine/zone.js', () => ({
    default: class {
        constructor(hrid) {
            this.hrid = hrid;
            this.buffs = [];
            this.isDungeon = false;
        }
    },
}));

vi.mock('./engine/player.js', () => ({
    default: { createFromDTO: (dto) => ({ ...dto }) },
}));

vi.mock('./engine/combat-simulator.js', () => ({
    default: class {
        simulate() {
            return { encounters: 0 };
        }
    },
    setPlayerDetailsCapture: () => {},
    getCapturedPlayerDetails: () => null,
}));

vi.mock('./engine/game-data.js', () => ({ setGameData: () => {} }));
vi.mock('./engine/rng.js', () => ({ seedSimRng: () => {} }));
vi.mock('./engine/extra-buffs.js', () => ({ buildPlayerExtraBuffs: () => [] }));
vi.mock('./engine/combat-unit.js', () => ({ setBuffCapture: () => {}, getCapturedMonsterBuffs: () => ({}) }));

/** The message shape the runner posts, with the labyrinth block under test. */
function startMessage(labyrinth) {
    return {
        data: {
            type: 'start_simulation',
            taskId: 1,
            gameData: {},
            playerDTOs: [{ hrid: 'player1', food: [null], drinks: [null] }],
            zoneHrid: '/actions/combat/fly',
            difficultyTier: 0,
            simulationTimeLimit: 1,
            extraBuffs: [],
            labyrinth,
        },
    };
}

beforeEach(async () => {
    harness.labyrinthArgs = [];
    harness.posted = [];
    vi.stubGlobal('postMessage', (message) => harness.posted.push(message));
    vi.stubGlobal('onmessage', null);
    vi.resetModules();
    await import('./combat-sim-worker-entry.js');
});

afterEach(() => {
    vi.unstubAllGlobals();
});

/** The fullAbilities argument the entry passed to Labyrinth. */
function fullAbilitiesArg() {
    return harness.labyrinthArgs[0][4];
}

describe('the labyrinth monster the worker builds', () => {
    test('a caller who says nothing gets the full ability kit', () => {
        globalThis.onmessage(startMessage({ monsterHrid: '/monsters/x', roomLevel: 100 }));

        expect(harness.posted[0].type).toBe('result');
        // Passed through raw, so Labyrinth's own `!== false` default applies
        expect(fullAbilitiesArg()).not.toBe(false);
        expect(fullAbilitiesArg() !== false).toBe(true);
    });

    test('an explicit true is still true', () => {
        globalThis.onmessage(startMessage({ monsterHrid: '/monsters/x', roomLevel: 100, fullAbilities: true }));

        expect(fullAbilitiesArg()).toBe(true);
    });

    test('and only an explicit false opts into the stripped tier-0 monster', () => {
        globalThis.onmessage(startMessage({ monsterHrid: '/monsters/x', roomLevel: 100, fullAbilities: false }));

        expect(fullAbilitiesArg()).toBe(false);
    });
});
