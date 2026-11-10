/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../combat-sim/combat-sim-runner.js', () => ({ runSimulation: vi.fn() }));
vi.mock('../combat-sim/combat-sim-adapter.js', () => ({
    seedSimPriceCache: (cache) => cache,
    buildAllPlayerDTOs: vi.fn(),
    buildGameDataPayload: vi.fn(),
    getCommunityBuffs: vi.fn(),
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
import { buildAllPlayerDTOs, buildGameDataPayload, getCommunityBuffs } from '../combat-sim/combat-sim-adapter.js';

const ZONE = '/actions/combat/gobo_planet';
const STABBY = '/monsters/stabby';
const SMASHY = '/monsters/smashy';
const BOSS = '/monsters/robo';
const SIM = { deaths: { [STABBY]: 100, [SMASHY]: 60, [BOSS]: 10 }, encounters: 120 };
let players;
let buffs;
let tier;
let tierMode;

function player(hrid = 'player1') {
    return {
        hrid,
        attackLevel: 70,
        equipment: { '/equipment_types/main_hand': { hrid: '/items/iron_sword', enhancementLevel: 3 } },
        food: [null, null, null],
        drinks: [null, null, null],
        abilities: [null, null, null, null, null],
        houseRooms: {},
        taskMonsterHrids: [STABBY],
        taskMonsterRemaining: { [STABBY]: 65 },
    };
}

function mountCard(name = 'Stabby', progress = 0, quantity = 65) {
    const card = document.createElement('div');
    card.className = 'RandomTask_taskInfo__1a';
    card.innerHTML = `
        <div class="RandomTask_name__1a">Defeat - ${name}</div>
        <div class="RandomTask_action__1a"></div>
        <div class="RandomTask_rewards__1a"></div>
        <div>Progress: ${progress} / ${quantity}</div>`;
    document.querySelector('[class*="TasksPanel_taskList"]').appendChild(card);
    return card;
}

async function estimate(card, { mode = taskProfitDisplay._estimateMode, loadout = '' } = {}) {
    let container = card.querySelector('.mwi-task-profit');
    if (!container) {
        container = document.createElement('div');
        container.className = 'mwi-task-profit';
        card.appendChild(container);
    }
    await taskProfitDisplay._runCombatSimEstimate(container, taskProfitDisplay.parseTaskData(card), loadout, mode);
    return container;
}

beforeEach(() => {
    vi.spyOn(config, 'getSetting').mockImplementation((key) =>
        ['taskCombatEstimate', 'combatSim_autoEstimate'].includes(key)
    );
    vi.spyOn(config, 'getSettingValue').mockImplementation((key, fallback) =>
        key === 'taskCombatGoTier' ? tierMode : fallback
    );
    vi.spyOn(expectedValueCalculator, 'isInitialized', 'get').mockReturnValue(true);
    vi.spyOn(taskProfitDisplay, '_placeCombatEstimate').mockImplementation(() => {});
    tier = 0;
    tierMode = 'game';
    vi.spyOn(taskProfitDisplay, '_resolveEstimateTier').mockImplementation(() => ({
        tier,
        known: true,
        source: 'default',
        pending: false,
    }));
    dataManager.currentCharacterId = 'char-a';
    dataManager.initClientData = {
        actionDetailMap: {
            [ZONE]: {
                type: '/action_types/combat',
                combatZoneInfo: {
                    fightInfo: {
                        randomSpawnInfo: {
                            maxSpawnCount: 3,
                            spawns: [STABBY, SMASHY].map((combatMonsterHrid) => ({ combatMonsterHrid })),
                        },
                        bossSpawns: [{ combatMonsterHrid: BOSS }],
                    },
                },
            },
        },
        combatMonsterDetailMap: {
            [STABBY]: { name: 'Stabby' },
            [SMASHY]: { name: 'Smashy' },
            [BOSS]: { name: 'Robo' },
        },
    };
    buildGameDataPayload.mockImplementation(() => ({ ...dataManager.initClientData }));
    players = [player()];
    buffs = { mooPass: false, comExp: 0, comDrop: 0 };
    buildAllPlayerDTOs.mockImplementation(async () => ({ players: structuredClone(players), selfHrid: 'player1' }));
    getCommunityBuffs.mockImplementation(() => ({ ...buffs }));
    runSimulation.mockResolvedValue(SIM);
    taskProfitDisplay.isInitialized = true;
    taskProfitDisplay._estimateMode = 'zone';
    taskProfitDisplay._simQueue = Promise.resolve();
    taskProfitDisplay._zoneSimCache.clear();
    document.body.innerHTML = '<div class="TasksPanel_taskList__1a"></div>';
});

afterEach(async () => {
    await taskProfitDisplay._simQueue;
    taskProfitDisplay.isInitialized = false;
    taskProfitDisplay._zoneSimCache.clear();
    taskProfitDisplay._retierQueue = [];
    taskProfitDisplay._retierRunning = false;
    taskProfitDisplay._retierActive = null;
    taskProfitDisplay._retierActiveRequest = null;
    taskProfitDisplay._retierActiveForce = false;
    taskProfitDisplay._cardEstimates = new WeakMap();
    taskProfitDisplay._staleGoEstimates = new WeakMap();
    dataManager.currentCharacterId = null;
    dataManager.initClientData = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.clearAllMocks();
    runSimulation.mockReset();
});

/** Controllable await with no timer or real worker. */
function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

function state(card) {
    const container = card.querySelector('.mwi-task-profit');
    return {
        html: container.innerHTML,
        cached: container._mwiCombatEstimate,
        go: taskProfitDisplay._resolveGoEstimate(card),
    };
}

// Deliberately invoke the method twice: the visible Estimate button is removed synchronously.
// These prove request ownership, not that a player can create this overlap with the current UI.
describe.each(['solo', 'zone'])('manual %s request ownership', (mode) => {
    test.each(['older first', 'newer first'])(
        'a superseded roster read cannot start a simulation (%s)',
        async (order) => {
            const roster = deferred();
            const newerSim = deferred();
            buildAllPlayerDTOs.mockImplementationOnce(() => roster.promise);
            runSimulation.mockImplementationOnce(() => newerSim.promise);
            const card = mountCard();
            const older = estimate(card, { mode, loadout: 'Older' });
            const newer = estimate(card, { mode, loadout: 'Newer' });
            await vi.waitFor(() => expect(runSimulation).toHaveBeenCalledTimes(1));
            if (order === 'newer first') {
                newerSim.resolve(SIM);
                await newer;
            }
            const expected = state(card);
            roster.resolve({ players: structuredClone(players), selfHrid: 'player1' });
            await older;
            expect(runSimulation).toHaveBeenCalledTimes(1);
            expect(state(card)).toEqual(expected);
            newerSim.resolve(SIM);
            await newer;
            expect(state(card).cached.loadoutName).toBe('Newer');
        }
    );

    describe.each(['older first', 'newer first'])('%s', (order) => {
        test.each(['success', 'failure', 'cancelled'])(
            'a superseded simulation %s cannot change the newer UI or Go',
            async (outcome) => {
                vi.spyOn(console, 'error').mockImplementation(() => {});
                const olderSim = deferred();
                const newerSim = deferred();
                runSimulation
                    .mockImplementationOnce(() => olderSim.promise)
                    .mockImplementationOnce(() => newerSim.promise);
                const card = mountCard();
                const older = estimate(card, { mode, loadout: 'Older' });
                await vi.waitFor(() => expect(runSimulation).toHaveBeenCalledTimes(1));
                const newer = estimate(card, { mode: mode === 'solo' ? 'zone' : 'solo', loadout: 'Newer' });
                await vi.waitFor(() => expect(runSimulation).toHaveBeenCalledTimes(2));
                if (order === 'newer first') {
                    newerSim.resolve(SIM);
                    await newer;
                }
                const expected = state(card);
                if (outcome === 'success') olderSim.resolve({ ...SIM, encounters: 999 });
                else olderSim.reject(new Error(outcome === 'cancelled' ? 'Cancelled' : 'Old worker failed'));
                await older;
                expect(state(card)).toEqual(expected);
                expect(console.error).not.toHaveBeenCalled();
                newerSim.resolve(SIM);
                await newer;
                expect(state(card).cached.loadoutName).toBe('Newer');
                expect(state(card).cached.simResult).toBe(SIM);
            }
        );
    });

    test('a newer failure stays failed after the older success, without restoring Go', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const olderSim = deferred();
        runSimulation
            .mockImplementationOnce(() => olderSim.promise)
            .mockRejectedValueOnce(new Error('New worker failed'));
        const card = mountCard();
        const older = estimate(card, { mode, loadout: 'Older' });
        await vi.waitFor(() => expect(runSimulation).toHaveBeenCalledTimes(1));
        await estimate(card, { mode, loadout: 'Newer' });
        const failed = state(card);
        expect(failed.html).toContain('Estimate failed.');
        expect(failed.go).toBeNull();
        olderSim.resolve(SIM);
        await older;
        expect(state(card)).toEqual(failed);
    });

    test.each(['success', 'failure'])('opening config invalidates an in-flight %s', async (outcome) => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const pending = deferred();
        runSimulation.mockImplementationOnce(() => pending.promise);
        const card = mountCard();
        const older = estimate(card, { mode });
        await vi.waitFor(() => expect(runSimulation).toHaveBeenCalledTimes(1));
        const container = card.querySelector('.mwi-task-profit');
        taskProfitDisplay._renderCombatEstimateConfig(container, taskProfitDisplay.parseTaskData(card));
        const expected = state(card);
        if (outcome === 'success') pending.resolve(SIM);
        else pending.reject(new Error('Old worker failed'));
        await older;
        expect(state(card)).toEqual(expected);
        expect(container.querySelector('.mwi-combat-est-btn')).not.toBeNull();
    });
});

describe('queued requests and tier searches keep their original owner', () => {
    test.each(['solo', 'zone'])('a superseded Best Score %s search stops before the next tier', async (mode) => {
        tierMode = 'best';
        dataManager.initClientData.actionDetailMap[ZONE].maxDifficulty = 2;
        const oldSim = deferred();
        runSimulation.mockImplementationOnce(() => oldSim.promise);
        const card = mountCard();
        const older = estimate(card, { mode, loadout: 'Older' });
        await vi.waitFor(() => expect(runSimulation).toHaveBeenCalledTimes(1));
        await estimate(card, { mode, loadout: 'Newer' });
        expect(runSimulation.mock.calls.map(([params]) => params.difficultyTier)).toEqual([0, 0, 1, 2]);
        const expected = state(card);
        oldSim.resolve(SIM);
        await older;
        expect(runSimulation).toHaveBeenCalledTimes(4);
        expect(state(card)).toEqual(expected);
    });

    test('a superseded roster failure never draws a failure over the newer result', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const oldRoster = deferred();
        buildAllPlayerDTOs.mockImplementationOnce(() => oldRoster.promise);
        const card = mountCard();
        const older = estimate(card, { loadout: 'Older' });
        await estimate(card, { loadout: 'Newer' });
        const expected = state(card);
        oldRoster.reject(new Error('Old roster unavailable'));
        await older;
        expect(state(card)).toEqual(expected);
        expect(console.error).not.toHaveBeenCalled();
    });

    test.each(['config', 'new estimate'])('a queued initial estimate cannot reclaim %s', async (choice) => {
        const preceding = deferred();
        const card = mountCard();
        const container = document.createElement('div');
        container.className = 'mwi-task-profit';
        card.appendChild(container);
        const task = taskProfitDisplay.parseTaskData(card);
        const queued = taskProfitDisplay._runQueuedAutoEstimate(preceding.promise, container, task);
        taskProfitDisplay._renderCombatEstimateConfig(container, task);
        if (choice === 'new estimate') await estimate(card, { mode: 'solo', loadout: 'Newer' });
        const expected = state(card);
        const calls = runSimulation.mock.calls.length;
        preceding.resolve();
        await queued;
        expect(state(card)).toEqual(expected);
        expect(runSimulation).toHaveBeenCalledTimes(calls);
    });

    test('an old auto cancellation cannot reset a newer result to config after auto-estimate is turned off', async () => {
        const card = mountCard();
        await taskProfitDisplay.addProfitToTask(card);
        await taskProfitDisplay._simQueue;
        const container = card.querySelector('.mwi-task-profit:not([data-task-key])');
        taskProfitDisplay._zoneSimCache.clear();
        const oldSim = deferred();
        runSimulation.mockImplementationOnce(() => oldSim.promise);
        runSimulation.mockClear();
        const older = taskProfitDisplay._runQueuedAutoEstimate(
            Promise.resolve(),
            container,
            taskProfitDisplay.parseTaskData(card)
        );
        await vi.waitFor(() => expect(runSimulation).toHaveBeenCalledTimes(1));
        await taskProfitDisplay._runCombatSimEstimate(
            container,
            taskProfitDisplay.parseTaskData(card),
            'Newer',
            'solo'
        );
        config.getSetting.mockImplementation((key) => key === 'taskCombatEstimate');
        const expected = {
            html: container.innerHTML,
            cached: container._mwiCombatEstimate,
            go: taskProfitDisplay._resolveGoEstimate(card),
        };
        oldSim.reject(new Error('Cancelled'));
        await older;
        expect({
            html: container.innerHTML,
            cached: container._mwiCombatEstimate,
            go: taskProfitDisplay._resolveGoEstimate(card),
        }).toEqual(expected);
    });

    test('a superseded active tier redo cannot enqueue its forced repeat over a newer request', async () => {
        const card = mountCard();
        const container = await estimate(card);
        const oldSim = deferred();
        runSimulation.mockImplementationOnce(() => oldSim.promise);
        runSimulation.mockClear();
        tier = 3;
        taskProfitDisplay._retierOpenCombatEstimates();
        await vi.waitFor(() => expect(runSimulation).toHaveBeenCalledTimes(1));
        taskProfitDisplay._enqueueRetier(container, true);
        expect(taskProfitDisplay._retierActiveForce).toBe(true);
        await estimate(card, { mode: 'solo', loadout: 'Newer' });
        const expected = state(card);
        oldSim.resolve(SIM);
        await vi.waitFor(() => expect(taskProfitDisplay._retierRunning).toBe(false));
        expect(state(card)).toEqual(expected);
        expect(runSimulation).toHaveBeenCalledTimes(2);
    });

    test('an invalid late request does not revoke a valid pending request', async () => {
        const sim = deferred();
        runSimulation.mockImplementationOnce(() => sim.promise);
        const card = mountCard();
        const current = estimate(card, { loadout: 'Valid' });
        await vi.waitFor(() => expect(runSimulation).toHaveBeenCalledTimes(1));
        const container = card.querySelector('.mwi-task-profit');
        await taskProfitDisplay._runCombatSimEstimate(
            container,
            { ...taskProfitDisplay.parseTaskData(card), description: 'Defeat - Smashy' },
            'Invalid',
            'solo'
        );
        sim.resolve(SIM);
        await current;
        expect(state(card).cached.loadoutName).toBe('Valid');
        expect(runSimulation).toHaveBeenCalledTimes(1);
    });
});

describe('tier changes after a newer direct request', () => {
    test.each(['active', 'queued'])(
        'a superseded %s redo cannot swallow the newer result’s next tier change',
        async (position) => {
            if (position === 'queued') await estimate(mountCard('Smashy'), { mode: 'solo' });
            const card = mountCard();
            await estimate(card, { mode: 'solo' });
            const oldSim = deferred();
            runSimulation.mockImplementationOnce(() => oldSim.promise);
            runSimulation.mockClear();
            tier = 3;
            taskProfitDisplay._retierOpenCombatEstimates();
            await vi.waitFor(() => expect(runSimulation).toHaveBeenCalledTimes(1));
            const container = card.querySelector('.mwi-task-profit');
            if (position === 'active') expect(taskProfitDisplay._retierActive).toBe(container);
            else expect(taskProfitDisplay._retierQueue.some((entry) => entry.container === container)).toBe(true);
            await estimate(card, { mode: 'zone', loadout: 'Newer' });
            expect(state(card).cached.estimateTier).toBe(3);
            tier = 4;
            taskProfitDisplay._retierOpenCombatEstimates();
            oldSim.resolve(SIM);
            await vi.waitFor(() => expect(taskProfitDisplay._retierRunning).toBe(false));
            expect(state(card).cached).toMatchObject({ loadoutName: 'Newer', mode: 'zone', estimateTier: 4 });
            expect(state(card).go).toMatchObject({ mode: 'zone', tier: 4 });
        }
    );
});
