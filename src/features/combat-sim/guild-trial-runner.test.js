import { beforeEach, describe, expect, test, vi } from 'vitest';
const harness = vi.hoisted(() => ({ workers: 4, run: vi.fn() }));
vi.mock('./combat-sim-runner.js', () => ({
    getMaxWorkers: () => harness.workers,
    runWorkerChunk: (...args) => harness.run(...args),
}));
import { runGuildTrialSimulation } from './guild-trial-runner.js';
import { simulateGuildCombat } from './engine/guild-combat-simulator.js';
import { simulateGuildSkilling } from './engine/guild-skilling-simulator.js';
import { setGameData } from './engine/game-data.js';
import { TRIAL_GAME_DATA } from './engine/guild-trial-game-data.fixture.js';
import { summarizeTrialRuns, validateTrialScenario } from './guild-trial-model.js';

const skilling = {
    kind: 'skilling',
    trialHrid: '/guild_skilling/crafting',
    runs: 7,
    seed: 0xfffffff0,
    seconds: 30,
    baseWork: 100,
    members: [{ name: 'Skiller', actionSeconds: 0.7, workPower: 45, successRate: 0.6, doubleChance: 0.3 }],
};
const combat = {
    kind: 'combat',
    trialHrid: '/guild_combat/badger',
    runs: 7,
    seed: 0xfffffff0,
    seconds: 60,
    members: [
        {
            name: 'Fighter',
            dto: {
                staminaLevel: 100,
                intelligenceLevel: 100,
                attackLevel: 100,
                defenseLevel: 100,
                meleeLevel: 100,
                rangedLevel: 100,
                magicLevel: 100,
                equipment: {},
                houseRooms: {},
                food: [],
                drinks: [],
                abilities: [],
            },
        },
    ],
};
const message = (scenario = skilling) => ({
    type: 'start_guild_trial_simulation',
    taskId: 'trial',
    scenario,
    gameData: TRIAL_GAME_DATA,
});
const engine = (scenario) => (scenario.kind === 'combat' ? simulateGuildCombat : simulateGuildSkilling);
beforeEach(() => {
    harness.workers = 4;
    harness.run.mockReset();
    setGameData(TRIAL_GAME_DATA);
});

describe('parallel guild trials', () => {
    test.each([
        ['combat', combat],
        ['skilling', skilling],
    ])('preserves every seeded %s outcome with uneven chunks and seed wraparound', async (_kind, scenario) => {
        const expected = engine(scenario)(scenario);
        harness.run.mockImplementation(async (chunk, notify) =>
            engine(chunk.scenario)(chunk.scenario, notify, chunk.returnAttempts)
        );
        for (const workers of [1, 2, 4]) {
            harness.workers = workers;
            harness.run.mockClear();
            const input = message(scenario);
            const before = structuredClone(input);
            expect(await runGuildTrialSimulation(input)).toEqual(expected);
            expect(input).toEqual(before);
            expect(harness.run).toHaveBeenCalledTimes(workers);
            for (const [chunk] of harness.run.mock.calls) expect(chunk.gameData).toBe(TRIAL_GAME_DATA);
        }
    });
    test('starts all chunks together, weights progress by attempts, and combines in original order', async () => {
        const jobs = [];
        harness.run.mockImplementation(
            (chunk, notify, options) => new Promise((resolve) => jobs.push({ chunk, notify, options, resolve }))
        );
        const progress = vi.fn();
        const running = runGuildTrialSimulation(message(), progress);
        expect(jobs).toHaveLength(4);
        expect(jobs.map((job) => job.chunk.scenario.runs)).toEqual([1, 2, 2, 2]);
        expect(new Set(jobs.map((job) => job.chunk.taskId)).size).toBe(4);
        jobs[3].notify(50);
        jobs[0].notify(100);
        jobs[3].notify(25); // A stale tick cannot move total progress backward.
        expect(progress.mock.calls.map(([value]) => value)).toEqual([14, 28]);
        const all = [];
        for (const [index, job] of jobs.entries()) {
            all.push(
                Array.from({ length: job.chunk.scenario.runs }, () => ({
                    highestTier: index + 1,
                    seconds: 10 + index,
                    reason: index ? 'timeout' : 'defeat',
                    tiers: [{ tier: 1, cleared: index > 0, seconds: 10 + index, progressFraction: 0.4 }],
                    warnings: [`chunk ${index}`],
                }))
            );
        }
        for (const index of [3, 2, 1, 0]) jobs[index].resolve(all[index]);
        expect(await running).toEqual(summarizeTrialRuns(validateTrialScenario(skilling), all.flat()));
        expect(progress.mock.calls.at(-1)).toEqual([100]);
    });
    test('caps workers at four and never creates more chunks than runs', async () => {
        harness.workers = 32;
        harness.run.mockImplementation(async (chunk) => simulateGuildSkilling(chunk.scenario, undefined, true));
        await runGuildTrialSimulation(message({ ...skilling, runs: 2 }));
        expect(harness.run).toHaveBeenCalledTimes(2);
    });
    test('validates the whole event budget before splitting', async () => {
        const expensive = {
            ...skilling,
            runs: 200,
            seconds: 3600,
            members: Array.from({ length: 100 }, (_, index) => ({
                ...skilling.members[0],
                name: `Member ${index}`,
                actionSeconds: 0.1,
            })),
        };
        await expect(runGuildTrialSimulation(message(expensive))).rejects.toThrow('Reduce the runs');
        expect(harness.run).not.toHaveBeenCalled();
    });
    test('aborts every sibling on worker failure and suppresses subsequent progress', async () => {
        const jobs = [];
        harness.run.mockImplementation(
            (_chunk, notify, { signal }) =>
                new Promise((resolve, reject) => {
                    jobs.push({ notify, signal, reject });
                    signal.addEventListener('abort', () => reject(new Error('canceled')), { once: true });
                })
        );
        const progress = vi.fn();
        const running = runGuildTrialSimulation(message(), progress);
        jobs[2].reject(new Error('boss data failed'));
        await expect(running).rejects.toThrow('boss data failed');
        expect(jobs.every((job) => job.signal.aborted)).toBe(true);
        jobs[1].notify(50);
        expect(progress).not.toHaveBeenCalled();
    });
    test('forwards caller cancellation and removes its listener when finished', async () => {
        const caller = new AbortController();
        const remove = vi.spyOn(caller.signal, 'removeEventListener');
        const signals = [];
        harness.run.mockImplementation(
            (_chunk, _notify, { signal }) =>
                new Promise((_resolve, reject) => {
                    signals.push(signal);
                    signal.addEventListener('abort', () => reject(new Error('Simulation canceled.')), { once: true });
                })
        );
        const running = runGuildTrialSimulation(message(), undefined, { signal: caller.signal });
        caller.abort();
        await expect(running).rejects.toThrow('canceled');
        expect(signals.every((signal) => signal.aborted)).toBe(true);
        expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    });
    test('rejects incomplete worker results instead of reporting misleading odds', async () => {
        harness.run.mockResolvedValue([]);
        await expect(runGuildTrialSimulation(message())).rejects.toThrow('incomplete set of attempts');
    });
    test('does not start any work for an already canceled request', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(runGuildTrialSimulation(message(), undefined, { signal: controller.signal })).rejects.toThrow(
            'canceled'
        );
        expect(harness.run).not.toHaveBeenCalled();
    });
});
