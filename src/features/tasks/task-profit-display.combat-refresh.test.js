/**
 * @vitest-environment happy-dom
 *
 * An open combat estimate follows the task's progress.
 *
 * A card's rows are keyed on `description|quantity`, which a kill does not
 * change, so an estimate drawn when Estimate was clicked used to keep its
 * remaining kills, time, zone summary and Go count for as long as it stayed
 * open. `_refreshOpenCombatEstimates` redraws them from the cached sim result
 * when progress moves — without simulating again.
 */

import { describe, test, expect, afterEach, vi } from 'vitest';
import taskProfitDisplay from './task-profit-display.js';
import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import { runSimulation } from '../combat-sim/combat-sim-runner.js';
import { buildAllPlayerDTOs, buildGameDataPayload } from '../combat-sim/combat-sim-adapter.js';
import { timeReadable } from '../../utils/formatters.js';
import { fightsForKillConfidence } from '../../utils/fight-confidence.js';

vi.mock('../combat-sim/combat-sim-runner.js', () => ({ runSimulation: vi.fn() }));
vi.mock('../combat-sim/combat-sim-adapter.js', () => ({
    seedSimPriceCache: (cache) => cache,

    buildAllPlayerDTOs: vi.fn(),
    buildGameDataPayload: vi.fn(),
    getCommunityBuffs: vi.fn(() => ({})),
    applyLoadoutSnapshotToDTO: vi.fn(),
    calculateSimRevenue: vi.fn(() => ({ netPerHour: 0, dropEntries: [], consumableEntries: [] })),
}));

const ZONE = '/actions/combat/gobo_planet';

function stubGame() {
    dataManager.initClientData = {
        actionDetailMap: {
            [ZONE]: {
                type: '/action_types/combat',
                name: 'Gobo Planet',
                category: '/categories/gobo',
                combatZoneInfo: {
                    isDungeon: false,
                    fightInfo: {
                        randomSpawnInfo: {
                            spawns: [{ combatMonsterHrid: '/monsters/gobo' }, { combatMonsterHrid: '/monsters/ooze' }],
                        },
                        bossSpawns: [],
                    },
                },
            },
        },
        actionCategoryDetailMap: { '/categories/gobo': { sortIndex: 1 } },
        combatMonsterDetailMap: { '/monsters/gobo': { name: 'Gobo' }, '/monsters/ooze': { name: 'Ooze' } },
    };
    dataManager.characterActions = [];
    buildGameDataPayload.mockReturnValue(dataManager.initClientData);
    buildAllPlayerDTOs.mockResolvedValue({ players: [{ hrid: 'player1' }] });
    vi.spyOn(dataManager, 'getMonsterHridFromName').mockImplementation((n) => `/monsters/${n.toLowerCase()}`);
    // The card's progress is whatever its dataset says right now
    vi.spyOn(taskProfitDisplay, 'parseTaskData').mockImplementation((node) => ({
        description: `Defeat - ${node.dataset.name}`,
        quantity: Number(node.dataset.quantity),
        currentProgress: Number(node.dataset.progress),
        coinReward: 0,
        taskTokenReward: 0,
    }));
}

/**
 * Put a board of task cards on the page, each with an estimate container.
 * @param {Array<[string, number, number]>} tasks - [monster name, quantity, progress]
 * @returns {Array<{card: HTMLElement, container: HTMLElement}>}
 */
function buildBoard(tasks) {
    const list = document.createElement('div');
    list.className = 'TasksPanel_taskList__x';
    const cards = tasks.map(([name, quantity, progress]) => {
        const card = document.createElement('div');
        card.className = 'RandomTask_taskInfo__x';
        card.dataset.name = name;
        card.dataset.quantity = String(quantity);
        card.dataset.progress = String(progress);
        const container = document.createElement('div');
        container.className = 'mwi-task-profit';
        card.appendChild(container);
        list.appendChild(card);
        return { card, container };
    });
    document.body.appendChild(list);
    return cards;
}

const taskDataOf = (card) => taskProfitDisplay.parseTaskData(card);

afterEach(() => {
    dataManager.initClientData = null;
    dataManager.characterActions = [];
    document.body.innerHTML = '';
    taskProfitDisplay._cardEstimates = new WeakMap();
    taskProfitDisplay._zoneSimCache?.clear?.();
    taskProfitDisplay.isInitialized = false;
    vi.useRealTimers();
    vi.restoreAllMocks();
    runSimulation.mockReset();
});

describe('an open combat estimate follows the task progress', () => {
    test('remaining kills, time and the Go count move with progress, without a new sim', async () => {
        stubGame();
        taskProfitDisplay.isInitialized = true;
        runSimulation.mockResolvedValue({ deaths: { '/monsters/gobo': 10 }, encounters: 10 });
        const [{ card, container }] = buildBoard([['Gobo', 100, 0]]);

        await taskProfitDisplay._runCombatSimEstimate(container, taskDataOf(card), '', 'solo');
        expect(container.dataset.completionSeconds).toBe('36000');
        expect(taskProfitDisplay._cardEstimates.get(card)).toMatchObject({ killsNeeded: 100, predictedFights: 100 });

        card.dataset.progress = '60';
        taskProfitDisplay._refreshOpenCombatEstimates();

        expect(runSimulation).toHaveBeenCalledTimes(1);
        expect(container.dataset.completionSeconds).toBe('14400');
        expect(container.textContent).toContain(timeReadable(14400));
        expect(container.textContent).toContain('Gobo × 40 kills');
        expect(taskProfitDisplay._cardEstimates.get(card)).toMatchObject({
            zoneHrid: ZONE,
            killsNeeded: 40,
            predictedFights: 40,
            killsPerFight: 1,
        });
    });

    test('nothing is redrawn when the progress has not moved', async () => {
        stubGame();
        taskProfitDisplay.isInitialized = true;
        runSimulation.mockResolvedValue({ deaths: { '/monsters/gobo': 10 }, encounters: 10 });
        const [{ card, container }] = buildBoard([['Gobo', 100, 0]]);

        await taskProfitDisplay._runCombatSimEstimate(container, taskDataOf(card), '', 'solo');
        const mainLine = container.firstElementChild;
        taskProfitDisplay._refreshOpenCombatEstimates();
        expect(container.firstElementChild).toBe(mainLine);
    });

    test('an expanded breakdown stays expanded across the redraw', async () => {
        stubGame();
        taskProfitDisplay.isInitialized = true;
        runSimulation.mockResolvedValue({ deaths: { '/monsters/gobo': 10 }, encounters: 10 });
        const [{ card, container }] = buildBoard([['Gobo', 100, 0]]);

        await taskProfitDisplay._runCombatSimEstimate(container, taskDataOf(card), '', 'solo');
        container.firstElementChild.click();
        card.dataset.progress = '10';
        taskProfitDisplay._refreshOpenCombatEstimates();

        expect(container.querySelector('.mwi-task-profit-breakdown').style.display).toBe('block');
        expect(container.textContent).toContain('Gobo × 90 kills');
    });

    test('a zone summary follows the progress of the other cards in the zone', async () => {
        stubGame();
        taskProfitDisplay.isInitialized = true;
        // 40 fights an hour: 20 gobo kills, 10 ooze kills
        runSimulation.mockResolvedValue({
            deaths: { '/monsters/gobo': 20, '/monsters/ooze': 10 },
            encounters: 40,
        });
        const [gobo, ooze] = buildBoard([
            ['Gobo', 100, 0],
            ['Ooze', 100, 0],
        ]);

        await taskProfitDisplay._runCombatSimEstimate(gobo.container, taskDataOf(gobo.card), '', 'zone');
        const summaryOf = () =>
            [...gobo.container.children].map((c) => c.textContent).find((t) => t.startsWith('Gobo Planet'));
        // Ooze is the bottleneck: 100 kills at 10 an hour, a quarter of a kill a fight. The line
        // quotes the 90% quantile of the fights that takes (the mean would be 400)
        const before = fightsForKillConfidence({ killsNeeded: 100, killsPerFight: 0.25, confidencePercent: 90 });
        expect(summaryOf()).toContain(`~${before} fights (90%)`);
        expect(summaryOf()).toContain('bottleneck: Ooze');

        ooze.card.dataset.progress = '50';
        taskProfitDisplay._refreshOpenCombatEstimates();
        // Gobo and Ooze both 5h on average now, but Ooze is the rarer kill (50 kills at a quarter of
        // a kill a fight) and needs more fights for 90% coverage, so it sets the figure
        const after = fightsForKillConfidence({ killsNeeded: 50, killsPerFight: 0.25, confidencePercent: 90 });
        expect(after).not.toBe(before);
        expect(summaryOf()).toContain(`~${after} fights (90%)`);
        expect(summaryOf()).toContain('bottleneck: Ooze');

        // A finished task is not part of the zone any more, so a single
        // task left in it is not a zone summary
        ooze.card.dataset.progress = '100';
        taskProfitDisplay._refreshOpenCombatEstimates();
        expect(summaryOf()).toBeUndefined();
        expect(runSimulation).toHaveBeenCalledTimes(1);
    });

    test('changing the zone estimate coverage redraws an open zone summary', async () => {
        stubGame();
        taskProfitDisplay.isInitialized = true;
        runSimulation.mockResolvedValue({ deaths: { '/monsters/gobo': 20, '/monsters/ooze': 10 }, encounters: 40 });
        const [gobo] = buildBoard([
            ['Gobo', 100, 0],
            ['Ooze', 100, 0],
        ]);
        await taskProfitDisplay._runCombatSimEstimate(gobo.container, taskDataOf(gobo.card), '', 'zone');
        const summaryOf = () =>
            [...gobo.container.children].map((c) => c.textContent).find((t) => t.startsWith('Gobo Planet'));
        expect(summaryOf()).toContain('(90%)');

        const real = config.getSettingValue.bind(config);
        vi.spyOn(config, 'getSettingValue').mockImplementation((key, fallback) =>
            key === 'taskCombatEstimatePercentile' ? '95' : real(key, fallback)
        );
        // No progress moved, so a plain pass leaves it; the setting's forced pass redraws it
        taskProfitDisplay._refreshOpenCombatEstimates();
        expect(summaryOf()).toContain('(90%)');
        taskProfitDisplay._refreshOpenCombatEstimates({ force: true });
        expect(summaryOf()).toContain('(95%)');
        expect(runSimulation).toHaveBeenCalledTimes(1);
    });

    test('a result put back to the config UI is not redrawn over it', async () => {
        stubGame();
        taskProfitDisplay.isInitialized = true;
        runSimulation.mockResolvedValue({ deaths: { '/monsters/gobo': 10 }, encounters: 10 });
        const [{ card, container }] = buildBoard([['Gobo', 100, 0]]);

        await taskProfitDisplay._runCombatSimEstimate(container, taskDataOf(card), '', 'solo');
        taskProfitDisplay._renderCombatEstimateConfig(container, taskDataOf(card));
        card.dataset.progress = '50';
        taskProfitDisplay._refreshOpenCombatEstimates();

        expect(container.querySelector('.mwi-combat-est-btn')).not.toBeNull();
        expect(taskProfitDisplay._cardEstimates.get(card)).toBeUndefined();
    });

    test('a run started from stale task data counts the card as it reads when the sim ends', async () => {
        stubGame();
        taskProfitDisplay.isInitialized = true;
        runSimulation.mockResolvedValue({ deaths: { '/monsters/gobo': 10 }, encounters: 10 });
        const [{ card, container }] = buildBoard([['Gobo', 100, 0]]);
        const staleTaskData = taskDataOf(card);

        card.dataset.progress = '70';
        await taskProfitDisplay._runCombatSimEstimate(container, staleTaskData, '', 'solo');

        expect(taskProfitDisplay._cardEstimates.get(card)).toMatchObject({ killsNeeded: 30, predictedFights: 30 });
        expect(container.textContent).toContain('Gobo × 30 kills');
    });

    test('a quests update refreshes open estimates', () => {
        vi.useFakeTimers();
        const handlers = {};
        vi.spyOn(webSocketHook, 'on').mockImplementation((type, fn) => {
            handlers[type] = fn;
        });
        const refresh = vi.spyOn(taskProfitDisplay, '_refreshOpenCombatEstimates').mockImplementation(() => {});
        vi.spyOn(taskProfitDisplay, 'updateTaskProfits').mockImplementation(() => {});
        taskProfitDisplay.unregisterHandlers = [];
        taskProfitDisplay.registerWebSocketListeners();

        handlers.quests_updated({ endCharacterQuests: [] });
        vi.advanceTimersByTime(250);

        expect(refresh).toHaveBeenCalledTimes(1);
        taskProfitDisplay.unregisterHandlers.forEach((fn) => fn());
        taskProfitDisplay.unregisterHandlers = [];
    });
});
