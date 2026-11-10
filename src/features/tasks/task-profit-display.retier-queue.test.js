/**
 * @vitest-environment happy-dom
 *
 * Tier-change redos of several open Solo estimates in one zone run one at a time. A simulation started
 * without `preempt: false` cancels the one running, so started together they would cancel each other and
 * leave "Estimate failed" and no Go estimate on every card but the last.
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
vi.mock('../../utils/character-key.js', async (importOriginal) => ({
    ...(await importOriginal()),
    writeScoped: vi.fn(),
}));
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
import config from '../../core/config.js';
import { runSimulation } from '../combat-sim/combat-sim-runner.js';
import { buildAllPlayerDTOs, buildGameDataPayload } from '../combat-sim/combat-sim-adapter.js';

const ZONE = '/actions/combat/gobo_planet';
const SIM = { deaths: { '/monsters/stabby': 100, '/monsters/smashy': 60 }, encounters: 120 };
const T3 = { tier: 3, known: true, source: 'remembered', pending: false };

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

/** A board of Solo cards, each with an estimate container. */
function mountBoard(descriptions) {
    const list = document.createElement('div');
    list.className = 'TasksPanel_taskList__1a';
    document.body.appendChild(list);
    return descriptions.map((description, i) => {
        const info = document.createElement('div');
        info.className = 'RandomTask_taskInfo__1a';
        const name = document.createElement('div');
        name.className = 'RandomTask_name__1a';
        name.textContent = description;
        info.appendChild(name);
        const progress = document.createElement('div');
        progress.textContent = `Progress: ${i} / 65`;
        info.appendChild(progress);
        const rewards = document.createElement('div');
        rewards.className = 'RandomTask_rewards__1a';
        info.appendChild(rewards);
        const container = document.createElement('div');
        info.appendChild(container);
        list.appendChild(info);
        return { info, container };
    });
}

/**
 * A runner that behaves like the real one: a run started without `preempt: false` cancels every run
 * in flight ("Cancelled"), and each run takes a few milliseconds.
 */
const live = { active: [], maxConcurrent: 0, tiers: [], cancelled: 0 };
function installRunner(delayMs = 4) {
    live.active = [];
    live.maxConcurrent = 0;
    live.tiers = [];
    live.cancelled = 0;
    runSimulation.mockImplementation(
        (params, _onProgress, options = {}) =>
            new Promise((resolve, reject) => {
                if (options.preempt !== false) {
                    for (const run of live.active.splice(0)) {
                        live.cancelled++;
                        run.reject(new Error('Cancelled'));
                    }
                }
                const run = { reject };
                live.active.push(run);
                live.maxConcurrent = Math.max(live.maxConcurrent, live.active.length);
                live.tiers.push(params.difficultyTier);
                setTimeout(() => {
                    const at = live.active.indexOf(run);
                    if (at === -1) return;
                    live.active.splice(at, 1);
                    resolve(SIM);
                }, delayMs);
            })
    );
}

beforeEach(() => {
    dataManager.initClientData = gameData();
    dataManager.currentCharacterId = 'char-a';
    buildGameDataPayload.mockReturnValue(dataManager.initClientData);
    buildAllPlayerDTOs.mockResolvedValue({ players: [{ hrid: 'player1' }] });
    tierMock.resolved = { tier: 0, known: false, source: 'default', pending: false };
    taskProfitDisplay.isInitialized = true;
    taskProfitDisplay._estimateMode = 'solo';
    installRunner();
});

afterEach(() => {
    taskProfitDisplay.isInitialized = false;
    taskProfitDisplay._retierQueue = [];
    taskProfitDisplay._retierRunning = false;
    taskProfitDisplay._retierActive = null;
    taskProfitDisplay._cardEstimates = new WeakMap();
    taskProfitDisplay._staleGoEstimates = new WeakMap();
    taskProfitDisplay._zoneSimCache.clear();
    dataManager.initClientData = null;
    dataManager.currentCharacterId = null;
    document.body.innerHTML = '';
    runSimulation.mockReset();
    vi.restoreAllMocks();
});

/** Draw every card's estimate at T0, one after another as the auto-estimate queue does. */
async function drawAll(cards) {
    for (const { info, container } of cards) {
        await taskProfitDisplay._runCombatSimEstimate(container, taskProfitDisplay.parseTaskData(info), '', 'solo');
    }
}

const tierOf = (card) => taskProfitDisplay._cardEstimates.get(card.info)?.tier;

describe('tier-change redos of several open Solo cards in one zone', () => {
    test('run one at a time, so none is cancelled, none shows a failure, and every Go estimate is back', async () => {
        const cards = mountBoard(['Defeat - Stabby', 'Defeat - Smashy', 'Defeat - Stabby']);
        await drawAll(cards);
        live.maxConcurrent = 0;
        live.tiers = [];

        tierMock.resolved = T3;
        taskProfitDisplay._retierOpenCombatEstimates();
        await vi.waitFor(() => expect(cards.map(tierOf)).toEqual([3, 3, 3]), { timeout: 2000 });

        expect(live.maxConcurrent).toBe(1);
        for (const { container } of cards) expect(container.innerHTML).not.toContain('Estimate failed');
        expect(live.tiers).toEqual([3, 3]); // The two Stabby cards share their T3 run.
    });

    test('a second tier change while the queue runs adds no parallel queue and no duplicate runs', async () => {
        const cards = mountBoard(['Defeat - Stabby', 'Defeat - Smashy', 'Defeat - Stabby']);
        await drawAll(cards);
        live.maxConcurrent = 0;
        live.tiers = [];

        tierMock.resolved = T3;
        taskProfitDisplay._retierOpenCombatEstimates();
        await new Promise((r) => setTimeout(r, 2));
        taskProfitDisplay._retierOpenCombatEstimates(); // the event fires again mid-queue
        await vi.waitFor(() => expect(cards.map(tierOf)).toEqual([3, 3, 3]), { timeout: 2000 });

        expect(live.maxConcurrent).toBe(1);
        expect(live.tiers.length).toBe(2);
    });

    test('a run cancelled by the player own simulation is not a failure and is picked up again', async () => {
        const cards = mountBoard(['Defeat - Stabby', 'Defeat - Smashy']);
        await drawAll(cards);

        tierMock.resolved = T3;
        taskProfitDisplay._retierOpenCombatEstimates();
        await new Promise((r) => setTimeout(r, 1));
        // The player presses Estimate on another card: a normal run, which preempts whatever is running
        const other = mountBoard(['Defeat - Smashy'])[0]; // A different target misses the active Stabby cache.
        const userRun = taskProfitDisplay._runCombatSimEstimate(
            other.container,
            taskProfitDisplay.parseTaskData(other.info),
            '',
            'solo'
        );
        await userRun;
        expect(live.cancelled).toBeGreaterThan(0);

        await vi.waitFor(() => expect(cards.map(tierOf)).toEqual([3, 3]), { timeout: 2000 });
        for (const { container } of cards) expect(container.innerHTML).not.toContain('Estimate failed');
    });

    test('a manual click removes Estimate and Re-run synchronously before the roster await', async () => {
        const [{ container, info }] = mountBoard(['Defeat - Stabby']);
        let finishRoster;
        buildAllPlayerDTOs.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finishRoster = () => resolve({ players: [{ hrid: 'player1' }] });
                })
        );
        taskProfitDisplay._renderCombatEstimateConfig(container, taskProfitDisplay.parseTaskData(info));
        const estimate = vi.spyOn(taskProfitDisplay, '_runCombatSimEstimate');
        container.querySelector('.mwi-combat-est-btn').click();

        expect(container.textContent).toContain('Simulating');
        expect(container.querySelector('button')).toBeNull();
        expect(container.querySelector('select')).toBeNull();
        expect(estimate).toHaveBeenCalledTimes(1);
        expect(runSimulation).not.toHaveBeenCalled();

        finishRoster();
        await estimate.mock.results[0].value;
        expect(runSimulation).toHaveBeenCalledTimes(1);
    });

    test.each(['config', 'new estimate'])(
        'a queued tier redo cannot overwrite the player opening %s on that card',
        async (choice) => {
            const cards = mountBoard(['Defeat - Stabby', 'Defeat - Smashy']);
            await drawAll(cards);
            taskProfitDisplay._estimateMode = 'solo';
            vi.spyOn(config, 'getSetting').mockImplementation((key) => key === 'taskCombatEstimate');
            runSimulation.mockClear();
            let finishFirst;
            buildAllPlayerDTOs.mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        finishFirst = () => resolve({ players: [{ hrid: 'player1' }] });
                    })
            );

            tierMock.resolved = T3;
            taskProfitDisplay._retierOpenCombatEstimates();
            expect(taskProfitDisplay._retierQueue).toHaveLength(1);
            const { container, info } = cards[1];
            // The waiting card still exposes its real result and Re-run controls while the
            // first card reads its roster. No second direct call on this card is needed.
            container.firstElementChild.click();
            [...container.querySelectorAll('button')].find((button) => button.textContent === 'Re-run').click();
            if (choice === 'new estimate') {
                container.querySelector('.mwi-combat-est-mode').click();
                container.querySelector('.mwi-combat-est-btn').click();
                await vi.waitFor(() => expect(taskProfitDisplay._cardEstimates.get(info)?.mode).toBe('zone'));
            }

            finishFirst();
            await vi.waitFor(() => expect(taskProfitDisplay._retierRunning).toBe(false));

            if (choice === 'config') {
                expect(container.querySelector('.mwi-combat-est-btn')).not.toBeNull();
                expect(taskProfitDisplay._resolveGoEstimate(info)).toBeNull();
            } else {
                expect(taskProfitDisplay._resolveGoEstimate(info)?.mode).toBe('zone');
                expect(container._mwiCombatEstimate?.mode).toBe('zone');
            }
            // Only the first card is redone automatically; the second card belongs to the player.
            expect(runSimulation.mock.calls.filter((call) => call[2]?.preempt === false)).toHaveLength(1);
        }
    );

    test('a character switch during the queue stops the rest', async () => {
        const cards = mountBoard(['Defeat - Stabby', 'Defeat - Smashy', 'Defeat - Stabby']);
        await drawAll(cards);
        runSimulation.mockClear();
        installRunner(150);

        tierMock.resolved = T3;
        taskProfitDisplay._retierOpenCombatEstimates();
        await vi.waitFor(() => expect(runSimulation).toHaveBeenCalledTimes(1));
        dataManager.currentCharacterId = 'char-b';
        await new Promise((r) => setTimeout(r, 400));

        expect(runSimulation).toHaveBeenCalledTimes(1);
        expect(taskProfitDisplay._retierQueue).toEqual([]);
    });

    test('a card that closed while it waited is skipped', async () => {
        const cards = mountBoard(['Defeat - Stabby', 'Defeat - Smashy', 'Defeat - Stabby']);
        await drawAll(cards);
        runSimulation.mockClear();

        tierMock.resolved = T3;
        taskProfitDisplay._retierOpenCombatEstimates();
        cards[1].info.remove();
        await vi.waitFor(() => expect(tierOf(cards[2])).toBe(3), { timeout: 2000 });

        expect(runSimulation).toHaveBeenCalledTimes(1); // The remaining cards share their Stabby result.
        expect(tierOf(cards[1])).toBe(0);
    });
});
