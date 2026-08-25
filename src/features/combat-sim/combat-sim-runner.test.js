/**
 * How a simulation decides to spend the machine.
 *
 * There are two ways to spend four workers on eight candidates: split each
 * candidate four ways and do them one at a time, or give each candidate one
 * worker and run four at once. The same hours get simulated either way, so it
 * reads like a wash — and it is not. Splitting pays the worker startup and the
 * game-data clone once per chunk instead of once per candidate, and it cannot
 * start the next candidate until its own slowest chunk lands. Measured on four
 * workers: 3.3× slower at a hundred hours a candidate, still 1.14× slower at
 * five seconds of work apiece, and never once faster.
 *
 * Splitting is right for a *lone* run, where there is no queue to keep full —
 * one 600-hour simulation is about twice as quick across four workers. So the
 * rule is: fan out a single run, queue a batch.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const settings = vi.hoisted(() => ({ maxThreads: 0, mobile: false }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => (key === 'combatSim_maxThreads' ? settings.maxThreads : false),
    },
}));

vi.mock('../../utils/mobile.js', () => ({
    isMobileMode: () => settings.mobile,
}));

const { plannedWorkerCount, runSimulation, runLabyrinthSimulation } = await import('./combat-sim-runner.js');

/** The bare shape mergeSimResults walks unconditionally */
const EMPTY_SIM_RESULT = { encounters: 0, deaths: {}, experienceGained: {}, consumablesUsed: {} };

/**
 * Stand in for the browser's Worker plumbing and collect what gets posted to it.
 * Every fake worker answers its message with an empty result, which is enough
 * for a run of any chunk count to resolve.
 */
function captureWorkerMessages() {
    const messages = [];
    vi.stubGlobal(
        'Blob',
        class {
            constructor() {}
        }
    );
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:sim', revokeObjectURL: () => {} });
    vi.stubGlobal(
        'Worker',
        class {
            postMessage(message) {
                messages.push(message);
                setTimeout(() =>
                    this.onmessage?.({
                        data: { type: 'result', taskId: message.taskId, simResult: { ...EMPTY_SIM_RESULT } },
                    })
                );
            }
            terminate() {}
        }
    );
    return messages;
}

beforeEach(() => {
    settings.maxThreads = 0;
    settings.mobile = false;
    vi.stubGlobal('navigator', { hardwareConcurrency: 8 });
});

describe('how wide one simulation spreads itself', () => {
    test('a short run stays in one worker', () => {
        // Splitting an hour four ways spends more on starting workers than the
        // simulation itself costs
        expect(plannedWorkerCount(1)).toBe(1);
        expect(plannedWorkerCount(24)).toBe(1);
    });

    test('a long one spreads out', () => {
        expect(plannedWorkerCount(40)).toBe(2);
        expect(plannedWorkerCount(100)).toBe(4);
    });

    test('but never past the worker budget', () => {
        // Four by default, whatever the machine has — the tab running the game
        // needs cores too
        expect(plannedWorkerCount(10_000)).toBe(4);
    });

    test('which the thread setting can narrow', () => {
        settings.maxThreads = 2;

        expect(plannedWorkerCount(10_000)).toBe(2);
    });

    test('and cores cap the setting rather than the other way round', () => {
        settings.maxThreads = 32;
        vi.stubGlobal('navigator', { hardwareConcurrency: 3 });

        expect(plannedWorkerCount(10_000)).toBe(3);
    });

    test('mobile mode narrows the budget to two', () => {
        // A phone reporting 8 cores does not have 8 cores of thermal headroom,
        // and each worker holds its own clone of the game data
        settings.mobile = true;

        expect(plannedWorkerCount(10_000)).toBe(2);
    });
});

describe('whether the run counts as a task fight', () => {
    // taskDamage is a conditional stat — it pays only while the monster is your
    // combat task — so the engine needs telling, and the only way it can be told
    // is through the worker message. A caller that says nothing must get the
    // off-task answer, because most callers are generic zone sims and rankings.
    test('a caller who says nothing gets off task', async () => {
        const messages = captureWorkerMessages();

        await runSimulation({ zoneHrid: '/actions/combat/fly', difficultyTier: 0, hours: 1 });

        expect(messages).toHaveLength(1);
        expect(messages[0].isTaskFight).toBe(false);
    });

    test('and a task-card sim carries the flag through to the worker', async () => {
        const messages = captureWorkerMessages();

        await runSimulation({ zoneHrid: '/actions/combat/fly', difficultyTier: 0, hours: 1, isTaskFight: true });

        expect(messages[0].isTaskFight).toBe(true);
    });

    test('every chunk of a split run agrees about it', async () => {
        // A 100-hour run is four workers; three of them believing they are off
        // task would make the merged result a blend of two different fights
        const messages = captureWorkerMessages();

        await runSimulation({ zoneHrid: '/actions/combat/fly', difficultyTier: 0, hours: 100, isTaskFight: true });

        expect(messages).toHaveLength(4);
        expect(messages.every((m) => m.isTaskFight === true)).toBe(true);
    });

    test('and labyrinth runs default off, since no labyrinth monster is a task', async () => {
        const messages = captureWorkerMessages();

        await runLabyrinthSimulation({ zoneHrid: '/actions/combat/fly', monsterHrid: '/monsters/x', hours: 1 });

        expect(messages[0].isTaskFight).toBe(false);
    });
});

describe('whether the labyrinth monster gets its full ability kit', () => {
    // A tier-0 subset monster drops its stun/shred/self-buff kit and the sim
    // over-predicts clears — the calibration replay verified the full kit reads
    // closer to reality. Callers that say nothing must get the full kit: for
    // months the upgrade advisor and live replay silently simmed the stripped
    // monster while the tile badges simmed the real one.
    test('a caller who says nothing gets the full kit', async () => {
        const messages = captureWorkerMessages();

        await runLabyrinthSimulation({ zoneHrid: '/actions/combat/fly', monsterHrid: '/monsters/x', hours: 1 });

        expect(messages).toHaveLength(1);
        expect(messages[0].labyrinth.fullAbilities).toBe(true);
    });

    test('an explicit true is still true', async () => {
        const messages = captureWorkerMessages();

        await runLabyrinthSimulation({
            zoneHrid: '/actions/combat/fly',
            monsterHrid: '/monsters/x',
            hours: 1,
            fullAbilities: true,
        });

        expect(messages[0].labyrinth.fullAbilities).toBe(true);
    });

    test('only an explicit false — a deliberate tier-0 diagnostic — opts out', async () => {
        const messages = captureWorkerMessages();

        await runLabyrinthSimulation({
            zoneHrid: '/actions/combat/fly',
            monsterHrid: '/monsters/x',
            hours: 1,
            fullAbilities: false,
        });

        expect(messages[0].labyrinth.fullAbilities).toBe(false);
    });
});

/**
 * How the requested hours are divided.
 *
 * Callers turn the merged result into rates by dividing by the hours they
 * asked for, so the chunks have to add up to exactly that. Rounding each chunk
 * up to a whole hour gave a half-hour request a full simulated hour and left
 * every rate derived from it overstated by a factor of two.
 */
describe('splitting the requested hours', () => {
    /** Hours each worker was actually told to simulate. */
    const chunkHours = (messages) => messages.map((m) => m.simulationTimeLimit / (3600 * 1e9));

    test('half an hour is half an hour', async () => {
        const messages = captureWorkerMessages();

        await runSimulation({ zoneHrid: '/actions/combat/fly', difficultyTier: 0, hours: 0.5 });

        expect(messages).toHaveLength(1);
        expect(chunkHours(messages)[0]).toBeCloseTo(0.5, 9);
    });

    test('and an hour and a half is an hour and a half', async () => {
        const messages = captureWorkerMessages();

        await runSimulation({ zoneHrid: '/actions/combat/fly', difficultyTier: 0, hours: 1.5 });

        expect(chunkHours(messages).reduce((a, b) => a + b, 0)).toBeCloseTo(1.5, 9);
    });

    test('however many workers it is split across', async () => {
        const messages = captureWorkerMessages();

        await runSimulation({ zoneHrid: '/actions/combat/fly', difficultyTier: 0, hours: 1.5 }, null, {
            workers: 2,
        });

        expect(messages).toHaveLength(2);
        expect(chunkHours(messages).reduce((a, b) => a + b, 0)).toBeCloseTo(1.5, 9);
    });

    test('a whole-hour run still divides evenly', async () => {
        const messages = captureWorkerMessages();

        await runSimulation({ zoneHrid: '/actions/combat/fly', difficultyTier: 0, hours: 100 });

        expect(messages).toHaveLength(4);
        expect(chunkHours(messages)).toEqual([25, 25, 25, 25]);
    });

    test('and no worker is started with nothing to do', async () => {
        // Four workers asked for, half an hour to share: three empty chunks
        // would each pay the worker startup and the game-data clone for nothing
        const messages = captureWorkerMessages();

        await runSimulation({ zoneHrid: '/actions/combat/fly', difficultyTier: 0, hours: 0.5 }, null, {
            workers: 4,
        });

        expect(messages).toHaveLength(1);
        expect(chunkHours(messages)[0]).toBeCloseTo(0.5, 9);
    });
});
