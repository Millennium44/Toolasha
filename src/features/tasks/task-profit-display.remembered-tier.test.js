/**
 * @vitest-environment happy-dom
 *
 * A task card's combat estimate uses the tier the character last RAN the zone at when the zone is no
 * longer in the action queue (`utils/zone-tier-memory.js`), says where the tier came from, and redoes
 * itself when the remembered tiers arrive after it was drawn at T0.
 */

import { describe, test, expect, afterEach, beforeEach, vi } from 'vitest';

const tierMock = vi.hoisted(() => ({
    resolved: { tier: 0, known: false, source: 'default', pending: false },
}));

vi.mock('../../utils/zone-tier-memory.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, resolveZoneTier: vi.fn(() => tierMock.resolved) };
});
vi.mock('../combat-sim/combat-sim-runner.js', () => ({ runSimulation: vi.fn() }));
vi.mock('../combat-sim/combat-sim-adapter.js', () => ({
    seedSimPriceCache: (cache) => cache,
    buildAllPlayerDTOs: vi.fn(),
    buildGameDataPayload: vi.fn(),
    getCommunityBuffs: vi.fn(() => ({})),
    applyLoadoutSnapshotToDTO: vi.fn(),
    calculateSimRevenue: vi.fn(() => ({ netPerHour: 0, dropEntries: [], consumableEntries: [] })),
}));

import taskProfitDisplay from './task-profit-display.js';
import dataManager from '../../core/data-manager.js';
import { runSimulation } from '../combat-sim/combat-sim-runner.js';
import { buildAllPlayerDTOs, buildGameDataPayload } from '../combat-sim/combat-sim-adapter.js';

const ZONE = '/actions/combat/gobo_planet';

function gameData() {
    return {
        actionDetailMap: {
            [ZONE]: {
                type: '/action_types/combat',
                name: 'Gobo Planet',
                category: '/categories/gobo',
                combatZoneInfo: {
                    isDungeon: false,
                    fightInfo: {
                        randomSpawnInfo: {
                            maxSpawnCount: 3,
                            spawns: [
                                { combatMonsterHrid: '/monsters/stabby' },
                                { combatMonsterHrid: '/monsters/smashy' },
                            ],
                        },
                        bossSpawns: [],
                    },
                },
            },
        },
        actionCategoryDetailMap: { '/categories/gobo': { sortIndex: 1 } },
        combatMonsterDetailMap: { '/monsters/stabby': { name: 'Stabby' }, '/monsters/smashy': { name: 'Smashy' } },
    };
}

function mountCard() {
    const list = document.createElement('div');
    list.className = 'TasksPanel_taskList__1a';
    const info = document.createElement('div');
    info.className = 'RandomTask_taskInfo__1a';
    const name = document.createElement('div');
    name.className = 'RandomTask_name__1a';
    name.textContent = 'Defeat - Stabby';
    info.appendChild(name);
    const progress = document.createElement('div');
    progress.textContent = 'Progress: 0 / 65';
    info.appendChild(progress);
    const rewards = document.createElement('div');
    rewards.className = 'RandomTask_rewards__1a';
    info.appendChild(rewards);
    list.appendChild(info);
    const container = document.createElement('div');
    info.appendChild(container);
    document.body.appendChild(list);
    return { container, info };
}

beforeEach(() => {
    dataManager.initClientData = gameData();
    buildGameDataPayload.mockReturnValue(dataManager.initClientData);
    buildAllPlayerDTOs.mockResolvedValue({ players: [{ hrid: 'player1' }] });
    runSimulation.mockResolvedValue({ deaths: { '/monsters/stabby': 100, '/monsters/smashy': 60 }, encounters: 120 });
    tierMock.resolved = { tier: 0, known: false, source: 'default', pending: false };
    taskProfitDisplay.isInitialized = true;
});

afterEach(() => {
    taskProfitDisplay.isInitialized = false;
    dataManager.initClientData = null;
    document.body.innerHTML = '';
    runSimulation.mockReset();
    vi.restoreAllMocks();
});

async function estimate(container, info, mode = 'solo') {
    const taskData = taskProfitDisplay.parseTaskData(info);
    await taskProfitDisplay._runCombatSimEstimate(container, taskData, '', mode);
    return taskProfitDisplay._cardEstimates.get(info);
}

describe('the estimate tier', () => {
    test('a remembered T3 is simulated, carried to Go, and named on the card', async () => {
        tierMock.resolved = { tier: 3, known: true, source: 'remembered', pending: false };
        const { container, info } = mountCard();

        const record = await estimate(container, info);

        expect(runSimulation).toHaveBeenCalledWith(expect.objectContaining({ difficultyTier: 3 }));
        expect(record.tier).toBe(3);
        expect(container.innerHTML).toContain('T3 (the tier you last ran here)');
    });

    test('nothing queued, nothing remembered: T0 and the card says so', async () => {
        const { container, info } = mountCard();
        const record = await estimate(container, info);
        expect(record.tier).toBe(0);
        expect(container.innerHTML).toContain('no recorded tier for this zone');
    });

    test('a T0 drawn while the remembered tiers loaded is simulated again at the remembered tier', async () => {
        tierMock.resolved = { tier: 0, known: false, source: 'default', pending: true };
        const { container, info } = mountCard();
        await estimate(container, info);
        expect(container.innerHTML).toContain('yet');
        runSimulation.mockClear();

        tierMock.resolved = { tier: 3, known: true, source: 'remembered', pending: false };
        taskProfitDisplay._retierOpenCombatEstimates();
        await vi.waitFor(() => expect(runSimulation).toHaveBeenCalledTimes(1));
        expect(runSimulation).toHaveBeenCalledWith(expect.objectContaining({ difficultyTier: 3 }));
        await vi.waitFor(() => expect(taskProfitDisplay._cardEstimates.get(info)?.tier).toBe(3));
        expect(container.innerHTML).toContain('T3 (the tier you last ran here)');
    });

    test('the record arriving with nothing for this zone redraws the note without simulating again', async () => {
        tierMock.resolved = { tier: 0, known: false, source: 'default', pending: true };
        const { container, info } = mountCard();
        await estimate(container, info);
        runSimulation.mockClear();

        tierMock.resolved = { tier: 0, known: false, source: 'default', pending: false };
        taskProfitDisplay._retierOpenCombatEstimates();

        expect(runSimulation).not.toHaveBeenCalled();
        expect(container.innerHTML).toContain('no recorded tier for this zone');
        expect(container.innerHTML).not.toContain('yet');
    });

    test('a zone-mode result at a remembered tier is cached under that tier, not the T0 result', async () => {
        const { container, info } = mountCard();
        await estimate(container, info, 'zone');
        const zoneRuns = runSimulation.mock.calls.length;

        tierMock.resolved = { tier: 3, known: true, source: 'remembered', pending: false };
        await estimate(container, info, 'zone');

        expect(runSimulation.mock.calls.length).toBe(zoneRuns + 1);
        expect(runSimulation).toHaveBeenLastCalledWith(expect.objectContaining({ difficultyTier: 3 }));
    });
});

describe('a tier that moves while the estimate is simulating', () => {
    test('is simulated again at the new tier (login with Tasks open: the record lands mid-run)', async () => {
        tierMock.resolved = { tier: 0, known: false, source: 'default', pending: true };
        runSimulation.mockImplementationOnce(async () => {
            tierMock.resolved = { tier: 3, known: true, source: 'remembered', pending: false };
            return { deaths: { '/monsters/stabby': 100, '/monsters/smashy': 60 }, encounters: 120 };
        });
        const { container, info } = mountCard();

        const record = await estimate(container, info);

        expect(runSimulation).toHaveBeenCalledTimes(2);
        expect(runSimulation).toHaveBeenLastCalledWith(expect.objectContaining({ difficultyTier: 3 }));
        expect(record.tier).toBe(3);
        expect(container.innerHTML).toContain('T3 (the tier you last ran here)');
    });

    test('the same tier arriving with a better note only updates the note, with no second simulation', async () => {
        tierMock.resolved = { tier: 0, known: false, source: 'default', pending: true };
        runSimulation.mockImplementationOnce(async () => {
            tierMock.resolved = { tier: 0, known: false, source: 'default', pending: false };
            return { deaths: { '/monsters/stabby': 100, '/monsters/smashy': 60 }, encounters: 120 };
        });
        const { container, info } = mountCard();
        await estimate(container, info);

        expect(runSimulation).toHaveBeenCalledTimes(1);
        expect(container.innerHTML).not.toContain('yet');
    });

    test('a tier that keeps moving cannot loop: the re-runs are bounded', async () => {
        let tier = 0;
        runSimulation.mockImplementation(async () => {
            tier += 1;
            tierMock.resolved = { tier, known: true, source: 'remembered', pending: false };
            return { deaths: { '/monsters/stabby': 100, '/monsters/smashy': 60 }, encounters: 120 };
        });
        const { container, info } = mountCard();
        await estimate(container, info);

        expect(runSimulation.mock.calls.length).toBeLessThanOrEqual(3);
        expect(taskProfitDisplay._cardEstimates.get(info)).toBeTruthy();
    });
});
