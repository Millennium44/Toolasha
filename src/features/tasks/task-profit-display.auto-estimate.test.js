/**
 * @vitest-environment happy-dom
 *
 * Initial auto-estimates are background work, including every tier of a Best Score search. Exercise
 * the real card-render/queue path with a runner that cancels active work exactly when preemption is on.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../combat-sim/combat-sim-runner.js', () => ({ runSimulation: vi.fn() }));
vi.mock('../combat-sim/combat-sim-adapter.js', () => ({
    seedSimPriceCache: (cache) => cache,
    buildAllPlayerDTOs: vi.fn(),
    buildGameDataPayload: vi.fn(),
    getCommunityBuffs: vi.fn(() => ({})),
    applyLoadoutSnapshotToDTO: vi.fn(),
    calculateSimRevenue: vi.fn(() => ({ netPerHour: 0, dropEntries: [], consumableEntries: [] })),
}));
vi.mock('./task-profit-calculator.js', async (importOriginal) => ({
    ...(await importOriginal()),
    calculateTaskProfit: vi.fn(async () => null),
}));

import taskProfitDisplay from './task-profit-display.js';
import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import expectedValueCalculator from '../market/expected-value-calculator.js';
import { runSimulation } from '../combat-sim/combat-sim-runner.js';
import { buildAllPlayerDTOs, buildGameDataPayload } from '../combat-sim/combat-sim-adapter.js';

const ZONE = '/actions/combat/gobo_planet';
const MONSTER = '/monsters/stabby';
const SIM = {
    deaths: { [MONSTER]: 100 },
    encounters: 120,
    experienceGained: { player1: { attack: 1000 } },
    simulatedTime: 3600 * 1e9,
};
const enabled = new Set();
let tierMode;

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

function mountCard() {
    const info = document.createElement('div');
    info.className = 'RandomTask_taskInfo__1a';
    info.innerHTML = `
        <div class="RandomTask_name__1a">Defeat - Stabby</div>
        <div class="RandomTask_action__1a"></div>
        <div class="RandomTask_rewards__1a"></div>
        <div>Progress: 0 / 65</div>`;
    document.body.appendChild(info);
    return info;
}

async function enqueue(card) {
    await taskProfitDisplay.addProfitToTask(card);
    return card.querySelector('.mwi-task-profit:not([data-task-key])');
}

beforeEach(() => {
    enabled.clear();
    enabled.add('taskCombatEstimate');
    enabled.add('combatSim_autoEstimate');
    tierMode = 'best';
    vi.spyOn(config, 'getSetting').mockImplementation((key) => enabled.has(key));
    vi.spyOn(config, 'getSettingValue').mockImplementation((key, fallback) =>
        key === 'taskCombatGoTier' ? tierMode : fallback
    );
    vi.spyOn(expectedValueCalculator, 'isInitialized', 'get').mockReturnValue(true);
    vi.spyOn(taskProfitDisplay, '_placeCombatEstimate').mockImplementation(() => {});
    dataManager.currentCharacterId = 'char-a';
    dataManager.initClientData = {
        actionDetailMap: {
            [ZONE]: {
                type: '/action_types/combat',
                name: 'Gobo Planet',
                category: '/categories/gobo',
                maxDifficulty: 3,
                combatZoneInfo: {
                    isDungeon: false,
                    fightInfo: {
                        randomSpawnInfo: {
                            maxSpawnCount: 3,
                            spawns: [{ combatMonsterHrid: MONSTER }],
                        },
                        bossSpawns: [],
                    },
                },
            },
        },
        actionCategoryDetailMap: { '/categories/gobo': { sortIndex: 1 } },
        combatMonsterDetailMap: { [MONSTER]: { name: 'Stabby' } },
    };
    buildGameDataPayload.mockReturnValue(dataManager.initClientData);
    buildAllPlayerDTOs.mockResolvedValue({ players: [{ hrid: 'player1' }], selfHrid: 'player1' });
    runSimulation.mockResolvedValue(SIM);
    taskProfitDisplay.isInitialized = true;
    taskProfitDisplay._estimateMode = 'solo';
    taskProfitDisplay._simQueue = Promise.resolve();
    taskProfitDisplay._zoneSimCache.clear();
});

afterEach(async () => {
    await taskProfitDisplay._simQueue;
    taskProfitDisplay.isInitialized = false;
    taskProfitDisplay._zoneSimCache.clear();
    taskProfitDisplay._cardEstimates = new WeakMap();
    taskProfitDisplay._staleGoEstimates = new WeakMap();
    dataManager.currentCharacterId = null;
    dataManager.initClientData = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    runSimulation.mockReset();
    buildAllPlayerDTOs.mockReset();
});

describe('initial automatic task estimates', () => {
    test.each([
        ['best', 'solo', 4],
        ['best', 'zone', 4],
        ['game', 'solo', 1],
        ['game', 'zone', 1],
    ])('%s tier, %s mode: every queued card leaves the player simulation running', async (pick, mode, calls) => {
        tierMode = pick;
        taskProfitDisplay._estimateMode = mode;
        const player = deferred();
        let playerCancelled = false;
        const userRun = player.promise.catch(() => {
            playerCancelled = true;
        });
        runSimulation.mockImplementation(async (_params, _progress, options = {}) => {
            if (options.preempt !== false) player.reject(new Error('Cancelled'));
            return SIM;
        });
        const cards = [mountCard(), mountCard(), mountCard()];
        for (const card of cards) await enqueue(card);
        await taskProfitDisplay._simQueue;
        player.resolve();
        await userRun;

        expect(playerCancelled).toBe(false);
        expect(runSimulation).toHaveBeenCalledTimes(calls);
        expect(runSimulation.mock.calls.every((call) => call[2]?.preempt === false)).toBe(true);
        for (const card of cards) expect(taskProfitDisplay._cardEstimates.has(card)).toBe(true);
    });

    test('a player cancelling the active card retries it without interrupting the player or losing later cards', async () => {
        const first = deferred();
        runSimulation.mockImplementationOnce(() => first.promise);
        const firstCard = mountCard();
        const secondCard = mountCard();
        const firstContainer = await enqueue(firstCard);
        await enqueue(secondCard);
        await vi.waitFor(() => expect(runSimulation).toHaveBeenCalledTimes(1));
        first.reject(new Error('Cancelled'));
        await taskProfitDisplay._simQueue;

        expect(runSimulation).toHaveBeenCalledTimes(5); // cancelled T0, then four shared tiers
        expect(runSimulation.mock.calls.every((call) => call[2]?.preempt === false)).toBe(true);
        expect(firstContainer.textContent).not.toContain('Estimate failed');
        expect(taskProfitDisplay._cardEstimates.has(firstCard)).toBe(true);
        expect(taskProfitDisplay._cardEstimates.has(secondCard)).toBe(true);
    });

    test('a later cancelled Solo tier retries only that tier and reuses the successful tiers', async () => {
        const interrupted = deferred();
        runSimulation.mockImplementationOnce(async () => SIM).mockImplementationOnce(() => interrupted.promise);
        const cards = [mountCard(), mountCard(), mountCard()];
        for (const card of cards) await enqueue(card);
        await vi.waitFor(() => expect(runSimulation).toHaveBeenCalledTimes(2));
        interrupted.reject(new Error('Cancelled'));
        await taskProfitDisplay._simQueue;

        expect(runSimulation.mock.calls.map(([params]) => params.difficultyTier)).toEqual([0, 1, 1, 2, 3]);
        expect(runSimulation.mock.calls.every((call) => call[2]?.preempt === false)).toBe(true);
        for (const card of cards) expect(taskProfitDisplay._cardEstimates.has(card)).toBe(true);
    });

    test('repeated cancellations are bounded and restore manual Estimate instead of a stuck spinner', async () => {
        runSimulation.mockRejectedValue(new Error('Cancelled'));
        const card = mountCard();
        const container = await enqueue(card);
        await taskProfitDisplay._simQueue;

        expect(runSimulation).toHaveBeenCalledTimes(3);
        expect(container.querySelector('.mwi-combat-est-btn')).not.toBeNull();
        expect(container.textContent).not.toContain('Simulating');
        expect(container.textContent).not.toContain('Estimate failed');
        expect(taskProfitDisplay._cardEstimates.has(card)).toBe(false);
    });

    test.each(['auto off', 'feature off', 'character switch', 'reroll', 'card closed', 'disable/re-enable'])(
        '%s while a card is queued skips the unwanted work',
        async (change) => {
            const preceding = deferred();
            taskProfitDisplay._simQueue = preceding.promise;
            const card = mountCard();
            const container = await enqueue(card);
            if (change === 'auto off') enabled.delete('combatSim_autoEstimate');
            if (change === 'feature off') enabled.delete('taskCombatEstimate');
            if (change === 'character switch') dataManager.currentCharacterId = 'char-b';
            if (change === 'reroll') card.querySelector('.RandomTask_name__1a').textContent = 'Defeat - Smashy';
            if (change === 'card closed') card.remove();
            if (change === 'disable/re-enable') {
                taskProfitDisplay.disable();
                taskProfitDisplay.isInitialized = true;
                card.appendChild(container); // even a reused/reconnected container belongs to the old generation
            }
            preceding.resolve();
            await taskProfitDisplay._simQueue;

            expect(runSimulation).not.toHaveBeenCalled();
            expect(taskProfitDisplay._cardEstimates.has(card)).toBe(false);
            if (change === 'auto off') expect(container.querySelector('.mwi-combat-est-btn')).not.toBeNull();
        }
    );

    test.each(['auto off', 'feature off', 'character switch', 'reroll', 'card closed', 'disable/re-enable'])(
        '%s during the player DTO await never starts a simulation or stores a result',
        async (change) => {
            const roster = deferred();
            buildAllPlayerDTOs.mockImplementationOnce(() => roster.promise);
            const card = mountCard();
            const container = await enqueue(card);
            await vi.waitFor(() => expect(buildAllPlayerDTOs).toHaveBeenCalled());
            if (change === 'auto off') enabled.delete('combatSim_autoEstimate');
            if (change === 'feature off') enabled.delete('taskCombatEstimate');
            if (change === 'character switch') dataManager.currentCharacterId = 'char-b';
            if (change === 'reroll') card.querySelector('.RandomTask_name__1a').textContent = 'Defeat - Smashy';
            if (change === 'card closed') card.remove();
            if (change === 'disable/re-enable') {
                taskProfitDisplay.disable();
                taskProfitDisplay.isInitialized = true;
                card.appendChild(container);
            }
            roster.resolve({ players: [{ hrid: 'player1' }], selfHrid: 'player1' });
            await taskProfitDisplay._simQueue;

            expect(runSimulation).not.toHaveBeenCalled();
            expect(taskProfitDisplay._zoneSimCache.size).toBe(0);
            expect(taskProfitDisplay._cardEstimates.has(card)).toBe(false);
            if (change === 'auto off') expect(container.querySelector('.mwi-combat-est-btn')).not.toBeNull();
        }
    );

    test.each(['best', 'game'])('%s mode stops when auto-estimate is disabled during a simulation', async (pick) => {
        tierMode = pick;
        runSimulation.mockImplementationOnce(async () => {
            enabled.delete('combatSim_autoEstimate');
            return SIM;
        });
        const card = mountCard();
        const container = await enqueue(card);
        await taskProfitDisplay._simQueue;

        expect(runSimulation).toHaveBeenCalledTimes(1);
        expect(taskProfitDisplay._cardEstimates.has(card)).toBe(false);
        expect(container.querySelector('.mwi-combat-est-btn')).not.toBeNull();
    });

    test('a failed estimate shows Retry and does not poison the next card', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        runSimulation.mockRejectedValueOnce(new Error('worker failed'));
        const first = await enqueue(mountCard());
        const secondCard = mountCard();
        await enqueue(secondCard);
        await taskProfitDisplay._simQueue;

        expect(first.textContent).toContain('Estimate failed. Retry');
        expect(taskProfitDisplay._cardEstimates.has(secondCard)).toBe(true);
    });

    test.each([
        ['unknown monster', 'Could not identify monster.'],
        ['no zone', 'No zone found for monster.'],
        ['empty players', 'Estimate failed. Retry'],
    ])('%s leaves the existing error state without retrying or starting a sim', async (input, message) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        if (input === 'unknown monster') vi.spyOn(dataManager, 'getMonsterHridFromName').mockReturnValue(null);
        if (input === 'no zone') dataManager.initClientData.actionDetailMap = {};
        if (input === 'empty players') buildAllPlayerDTOs.mockResolvedValue({ players: [] });
        const card = mountCard();
        const container = await enqueue(card);
        await taskProfitDisplay._simQueue;

        expect(container.textContent).toContain(message);
        expect(runSimulation).not.toHaveBeenCalled();
        expect(taskProfitDisplay._cardEstimates.has(card)).toBe(false);
    });

    test('manual Estimate keeps its explicit preemption behavior', async () => {
        enabled.delete('combatSim_autoEstimate');
        const card = mountCard();
        const container = await enqueue(card);
        container.querySelector('.mwi-combat-est-btn').click();
        await vi.waitFor(() => expect(taskProfitDisplay._cardEstimates.has(card)).toBe(true));

        expect(runSimulation).toHaveBeenCalledTimes(4);
        expect(runSimulation.mock.calls.every((call) => call[2] === undefined)).toBe(true);
    });
});
