/**
 * @vitest-environment happy-dom
 *
 * Go on a combat task card while its estimate is being redone for a new zone tier. A tier-change redo
 * clears the card's estimate when it starts; Go then found nothing and the game's own Go opened the
 * monster's default zone instead of the planet the estimate named. The redo only changes tier and
 * count, so Go keeps the zone (and the remembered tier) and fills no count until the redo finishes.
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
vi.mock('../../utils/combat-zone-open.js', async (importOriginal) => {
    const original = await importOriginal();
    return { ...original, openCombatZoneAtTierSequence: vi.fn() };
});

import taskProfitDisplay from './task-profit-display.js';
import dataManager from '../../core/data-manager.js';
import config from '../../core/config.js';
import { runSimulation } from '../combat-sim/combat-sim-runner.js';
import { buildAllPlayerDTOs, buildGameDataPayload } from '../combat-sim/combat-sim-adapter.js';
import { openCombatZoneAtTierSequence } from '../../utils/combat-zone-open.js';

const PLANET = '/actions/combat/gobo_planet';
const SMASHY_OWN = '/actions/combat/smashy_own';
const SIM = { deaths: { '/monsters/stabby': 100, '/monsters/smashy': 60 }, encounters: 120 };
const T3 = { tier: 3, known: true, source: 'remembered', pending: false };

function zone(name, spawns, category = '/categories/gobo') {
    return {
        type: '/action_types/combat',
        name,
        category,
        combatZoneInfo: {
            isDungeon: false,
            fightInfo: {
                randomSpawnInfo: { maxSpawnCount: 3, spawns: spawns.map((m) => ({ combatMonsterHrid: m })) },
                bossSpawns: [],
            },
        },
    };
}

function gameData() {
    return {
        actionDetailMap: {
            [PLANET]: zone('Gobo Planet', ['/monsters/stabby', '/monsters/smashy']),
            [SMASHY_OWN]: zone('Smashy Own', ['/monsters/smashy'], '/categories/other'),
        },
        actionCategoryDetailMap: { '/categories/gobo': { sortIndex: 1 }, '/categories/other': { sortIndex: 9 } },
        combatMonsterDetailMap: { '/monsters/stabby': { name: 'Stabby' }, '/monsters/smashy': { name: 'Smashy' } },
    };
}

/** The game's card: RandomTask_randomTask > RandomTask_taskInfo (+ estimate container) and the Go button. */
function mountCard(description = 'Defeat - Smashy', progress = 0) {
    let list = document.querySelector('.TasksPanel_taskList__1a');
    if (!list) {
        list = document.createElement('div');
        list.className = 'TasksPanel_taskList__1a';
        document.body.appendChild(list);
    }
    const card = document.createElement('div');
    card.className = 'RandomTask_randomTask__1a';
    const info = document.createElement('div');
    info.className = 'RandomTask_taskInfo__1a';
    const name = document.createElement('div');
    name.className = 'RandomTask_name__1a';
    name.textContent = description;
    info.appendChild(name);
    const prog = document.createElement('div');
    prog.textContent = `Progress: ${progress} / 65`;
    info.appendChild(prog);
    const rewards = document.createElement('div');
    rewards.className = 'RandomTask_rewards__1a';
    info.appendChild(rewards);
    const container = document.createElement('div');
    info.appendChild(container);
    card.appendChild(info);
    const go = document.createElement('button');
    go.className = 'Button_button__1a Button_success__1a';
    card.appendChild(go);
    list.appendChild(card);
    return { card, info, container, go };
}

/** The panel the game's own Go landed on: the monster's default zone, not the planet. */
function landOnDefaultZone() {
    const panel = document.createElement('div');
    panel.className = 'SkillActionDetail_skillActionDetail__1a';
    const name = document.createElement('div');
    name.className = 'SkillActionDetail_name__1a';
    name.textContent = 'Smashy Own';
    panel.appendChild(name);
    document.body.appendChild(panel);
}

/** A runner whose runs finish when the test says so, and can be cancelled the way the real one is. */
const runs = [];
function installRunner() {
    runs.length = 0;
    runSimulation.mockImplementation(
        () =>
            new Promise((resolve, reject) => {
                runs.push({ resolve: () => resolve(SIM), cancel: () => reject(new Error('Cancelled')) });
            })
    );
}

async function estimateAt(card, mode = 'zone') {
    const pending = taskProfitDisplay._runCombatSimEstimate(
        card.container,
        taskProfitDisplay.parseTaskData(card.info),
        '',
        mode
    );
    // A second Zone card in the same zone reuses the shared sim and starts no run of its own
    let settled = false;
    pending.then(() => {
        settled = true;
    });
    for (let i = 0; i < 200 && !settled; i += 1) {
        if (runs.length) runs.shift().resolve();
        await new Promise((r) => setTimeout(r, 1));
    }
    await pending;
}

const estimateOf = (card) => taskProfitDisplay._cardEstimates.get(card.info);

beforeEach(() => {
    dataManager.initClientData = gameData();
    dataManager.currentCharacterId = 'char-a';
    dataManager.characterQuests = [];
    buildGameDataPayload.mockReturnValue(dataManager.initClientData);
    buildAllPlayerDTOs.mockResolvedValue({ players: [{ hrid: 'player1' }] });
    tierMock.resolved = { tier: 0, known: false, source: 'default', pending: false };
    vi.spyOn(config, 'getSetting').mockImplementation((key) => key === 'taskCombatEstimate');
    taskProfitDisplay.isInitialized = true;
    taskProfitDisplay._cardEstimates = new WeakMap();
    taskProfitDisplay._staleGoEstimates = new WeakMap();
    taskProfitDisplay._zoneSimCache = new Map();
    openCombatZoneAtTierSequence.mockReset();
    openCombatZoneAtTierSequence.mockResolvedValue({ opened: true, tierConfirmed: true, filled: true });
    installRunner();
});

afterEach(() => {
    taskProfitDisplay.isInitialized = false;
    taskProfitDisplay._retierQueue = [];
    taskProfitDisplay._retierRunning = false;
    taskProfitDisplay._retierActive = null;
    dataManager.initClientData = null;
    dataManager.currentCharacterId = null;
    dataManager.characterQuests = [];
    document.body.innerHTML = '';
    runSimulation.mockReset();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

/** Draw the card in Zone mode at T0, then the player runs the zone and its remembered tier becomes T3. */
async function drawThenTierChanges(card) {
    await estimateAt(card);
    expect(estimateOf(card)).toMatchObject({ zoneHrid: PLANET, mode: 'zone', tier: 0 });
    tierMock.resolved = T3;
    taskProfitDisplay._retierOpenCombatEstimates();
    await vi.waitFor(() => expect(runs.length).toBe(1));
}

async function pressGo(card) {
    vi.useFakeTimers();
    taskProfitDisplay._setupTaskNode(card.card);
    card.go.click();
    await vi.advanceTimersByTimeAsync(400);
    vi.useRealTimers();
}

describe('Go while the card is being redone for a new zone tier', () => {
    test('baseline: with a finished Zone estimate, Go opens the planet', async () => {
        const card = mountCard();
        await estimateAt(card);
        landOnDefaultZone();

        await pressGo(card);

        expect(openCombatZoneAtTierSequence).toHaveBeenCalledTimes(1);
        expect(openCombatZoneAtTierSequence.mock.calls[0].slice(0, 2)).toEqual([PLANET, 0]);
    });

    test('redo in flight: Go still opens the planet, at the remembered tier, with no count', async () => {
        const card = mountCard();
        await drawThenTierChanges(card);
        expect(estimateOf(card)).toBeUndefined(); // the fresh record is gone for the run
        landOnDefaultZone();

        await pressGo(card);

        expect(openCombatZoneAtTierSequence).toHaveBeenCalledTimes(1);
        expect(openCombatZoneAtTierSequence).toHaveBeenCalledWith(PLANET, 3, {}, 'char-a');
    });

    test('redo in flight: Go on a panel already on the planet confirms the tier and fills nothing', async () => {
        const card = mountCard();
        await drawThenTierChanges(card);

        const result = taskProfitDisplay._resolveGoEstimate(card.card);

        expect(result).toMatchObject({ zoneHrid: PLANET, mode: 'zone', tier: 3, countless: true });
        const panel = document.createElement('div');
        panel.className = 'SkillActionDetail_skillActionDetail__1a';
        const name = document.createElement('div');
        name.className = 'SkillActionDetail_name__1a';
        name.textContent = 'Gobo Planet';
        panel.appendChild(name);
        const box = document.createElement('div');
        box.className = 'maxActionCountInput__1a';
        const input = document.createElement('input');
        box.appendChild(input);
        panel.appendChild(box);
        document.body.appendChild(panel);

        await taskProfitDisplay._applyGoEstimate(result, 'char-a');

        expect(input.value).toBe('');
    });

    test('after the redo completes Go uses the fresh estimate: the planet at T3 with its count', async () => {
        const card = mountCard();
        await drawThenTierChanges(card);
        runs.shift().resolve();
        await vi.waitFor(() => expect(estimateOf(card)?.tier).toBe(3));
        expect(taskProfitDisplay._staleGoEstimates.get(card.info)).toBeUndefined();
        landOnDefaultZone();

        await pressGo(card);

        expect(openCombatZoneAtTierSequence.mock.calls[0].slice(0, 2)).toEqual([PLANET, 3]);
        expect(openCombatZoneAtTierSequence.mock.calls[0][2].count).toBeGreaterThan(0);
    });

    test('a redo cancelled by the player run goes again, and Go keeps the planet through the wait', async () => {
        const card = mountCard();
        await drawThenTierChanges(card);
        runs.shift().cancel();
        await vi.waitFor(() => expect(runs.length).toBe(1)); // the second attempt

        expect(taskProfitDisplay._resolveGoEstimate(card.card)).toMatchObject({ zoneHrid: PLANET, countless: true });

        runs.shift().resolve();
        await vi.waitFor(() => expect(estimateOf(card)?.tier).toBe(3));
    });

    test('a redo that fails every attempt shows the failure and Go goes back to the game default', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const card = mountCard();
        await drawThenTierChanges(card);
        for (let attempt = 0; attempt < 3; attempt += 1) {
            await vi.waitFor(() => expect(runs.length).toBe(1));
            runs.shift().cancel();
        }
        await vi.waitFor(() => expect(card.container.innerHTML).toContain('Estimate failed'));

        expect(taskProfitDisplay._resolveGoEstimate(card.card)).toBeNull();
    });

    test('a player re-run, a reroll (config redraw) or a character switch drops the kept zone', async () => {
        const card = mountCard();
        await drawThenTierChanges(card);
        expect(taskProfitDisplay._resolveGoEstimate(card.card)).not.toBeNull();

        dataManager.currentCharacterId = 'char-b';
        expect(taskProfitDisplay._resolveGoEstimate(card.card)).toBeNull();
        dataManager.currentCharacterId = 'char-a';
        expect(taskProfitDisplay._resolveGoEstimate(card.card)).not.toBeNull();

        taskProfitDisplay._renderCombatEstimateConfig(card.container, taskProfitDisplay.parseTaskData(card.info));
        expect(taskProfitDisplay._resolveGoEstimate(card.card)).toBeNull();
    });

    test('turning the estimate setting off drops the kept zone', async () => {
        const card = mountCard();
        await drawThenTierChanges(card);
        config.getSetting.mockImplementation(() => false);

        expect(taskProfitDisplay._resolveGoEstimate(card.card)).toBeNull();
    });

    test('a redrawn card (new node) does not inherit the old node record', async () => {
        const card = mountCard();
        await drawThenTierChanges(card);
        const redrawn = mountCard();

        expect(taskProfitDisplay._resolveGoEstimate(redrawn.card)).toBeNull();
        expect(taskProfitDisplay._resolveGoEstimate(card.card)).not.toBeNull();
    });

    test('two cards in one zone: the one waiting in the queue and the one running both keep the planet', async () => {
        const first = mountCard('Defeat - Smashy');
        const second = mountCard('Defeat - Stabby');
        await estimateAt(first);
        await estimateAt(second);
        tierMock.resolved = T3;
        taskProfitDisplay._retierOpenCombatEstimates();
        await vi.waitFor(() => expect(runs.length).toBe(1));

        expect(taskProfitDisplay._resolveGoEstimate(first.card)).toMatchObject({ zoneHrid: PLANET });
        expect(taskProfitDisplay._resolveGoEstimate(second.card)).toMatchObject({ zoneHrid: PLANET });
        // The zone sim is shared, so finishing the first run also feeds the second card's redo
        runs.shift().resolve();
        await vi.waitFor(() => expect(estimateOf(second)?.tier).toBe(3));
        expect(estimateOf(first)?.tier).toBe(3);
    });
});

describe('Go with taskGoMerge and several tasks on one monster (Smashy x4)', () => {
    function fourSmashy() {
        dataManager.characterQuests = [0, 1, 2, 3].map(() => ({
            status: '/quest_status/in_progress',
            category: '/quest_category/random_task',
            monsterHrid: '/monsters/smashy',
            goalCount: 65,
            currentCount: 5,
        }));
        config.getSetting.mockImplementation((key) => key === 'taskCombatEstimate' || key === 'taskGoMerge');
    }

    test('a finished estimate still opens the planet, with the merged total as the count', async () => {
        const card = mountCard();
        await estimateAt(card);
        fourSmashy();
        landOnDefaultZone();

        await pressGo(card);

        expect(openCombatZoneAtTierSequence).toHaveBeenCalledWith(PLANET, 0, { count: 240 }, 'char-a');
    });

    test('a redo in flight on a merged card opens the planet at the remembered tier with the merged total', async () => {
        const card = mountCard();
        await drawThenTierChanges(card);
        fourSmashy();
        landOnDefaultZone();

        await pressGo(card);

        expect(openCombatZoneAtTierSequence).toHaveBeenCalledWith(PLANET, 3, { count: 240 }, 'char-a');
    });

    test('a merged card with no estimate at all leaves Go to the game and the merge fill', () => {
        const card = mountCard();
        fourSmashy();

        expect(taskProfitDisplay._resolveGoEstimate(card.card)).toBeNull();
    });
});
