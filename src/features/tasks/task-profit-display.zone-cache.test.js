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
import {
    applyLoadoutSnapshotToDTO,
    buildAllPlayerDTOs,
    buildGameDataPayload,
    getCommunityBuffs,
} from '../combat-sim/combat-sim-adapter.js';

const ZONE = '/actions/combat/gobo_planet';
const STABBY = '/monsters/stabby';
const SMASHY = '/monsters/smashy';
const BOSS = '/monsters/robo';
const SIM = { deaths: { [STABBY]: 100, [SMASHY]: 60, [BOSS]: 10 }, encounters: 120 };
let players;
let buffs;
let tier;

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
        key === 'taskCombatGoTier' ? 'game' : fallback
    );
    vi.spyOn(expectedValueCalculator, 'isInitialized', 'get').mockReturnValue(true);
    vi.spyOn(taskProfitDisplay, '_placeCombatEstimate').mockImplementation(() => {});
    tier = 0;
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
    taskProfitDisplay._cardEstimates = new WeakMap();
    taskProfitDisplay._staleGoEstimates = new WeakMap();
    dataManager.currentCharacterId = null;
    dataManager.initClientData = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.clearAllMocks();
    runSimulation.mockReset();
    applyLoadoutSnapshotToDTO.mockReset();
});

describe.each(['zone', 'solo'])('shared %s simulations follow their actual inputs', (mode) => {
    beforeEach(() => {
        taskProfitDisplay._estimateMode = mode;
    });

    test('a rerolled board refresh uses the new task damage targets', async () => {
        const card = mountCard();
        await taskProfitDisplay.addProfitToTask(card);
        await taskProfitDisplay._simQueue;
        expect(runSimulation).toHaveBeenCalledTimes(1);
        expect(runSimulation.mock.calls[0][0].playerDTOs[0].taskMonsterHrids).toEqual([STABBY]);

        players[0].taskMonsterHrids = [SMASHY];
        players[0].taskMonsterRemaining = { [SMASHY]: 65 };
        card.querySelector('.RandomTask_name__1a').textContent = 'Defeat - Smashy';
        taskProfitDisplay.updateTaskProfits();
        await vi.waitFor(() => expect(buildAllPlayerDTOs).toHaveBeenCalledTimes(2));
        await taskProfitDisplay._simQueue;

        expect(runSimulation).toHaveBeenCalledTimes(2);
        expect(runSimulation.mock.calls[1][0]).toMatchObject({
            playerDTOs: [{ taskMonsterHrids: [SMASHY], taskMonsterRemaining: { [SMASHY]: 65 } }],
            taskDamageMode: 'perMonster',
        });
        expect(taskProfitDisplay._cardEstimates.get(card).monsterHrid).toBe(SMASHY);
    });

    test('a rerolled card rejects a prior manual result after its replacement estimate completes', async () => {
        let finishOld;
        runSimulation.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finishOld = resolve;
                })
        );
        const card = mountCard();
        const oldRun = estimate(card);
        await vi.waitFor(() => expect(runSimulation).toHaveBeenCalledTimes(1));

        players[0].taskMonsterHrids = [SMASHY];
        players[0].taskMonsterRemaining = { [SMASHY]: 65 };
        card.querySelector('.RandomTask_name__1a').textContent = 'Defeat - Smashy';
        taskProfitDisplay.updateTaskProfits();
        await vi.waitFor(() => expect(taskProfitDisplay._cardEstimates.get(card)?.monsterHrid).toBe(SMASHY));
        const replacement = taskProfitDisplay._resolveGoEstimate(card);

        finishOld(SIM);
        await oldRun;

        expect(taskProfitDisplay._resolveGoEstimate(card)).toEqual(replacement);
        expect(taskProfitDisplay._cardEstimates.get(card)?.monsterHrid).toBe(SMASHY);
    });

    test('a same-task refresh does not let its detached manual run replace the new Go estimate', async () => {
        let finishOld;
        runSimulation.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finishOld = resolve;
                })
        );
        const card = mountCard();
        const oldRun = estimate(card);
        await vi.waitFor(() => expect(runSimulation).toHaveBeenCalledTimes(1));
        const oldContainer = card.querySelector('.mwi-task-profit');

        players[0].attackLevel++;
        taskProfitDisplay.updateTaskProfits(true);
        await vi.waitFor(() => expect(taskProfitDisplay._cardEstimates.has(card)).toBe(true));
        const replacement = taskProfitDisplay._resolveGoEstimate(card);
        expect(oldContainer.isConnected).toBe(false);

        finishOld({ ...SIM, encounters: 600 });
        await oldRun;

        expect(taskProfitDisplay._resolveGoEstimate(card)).toEqual(replacement);
    });

    test.each(['monster', 'quantity', 'removed'])(
        'a manual result never primes Go after its card is %s, even before a display refresh',
        async (change) => {
            let finish;
            runSimulation.mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        finish = resolve;
                    })
            );
            const card = mountCard();
            const pending = estimate(card);
            await vi.waitFor(() => expect(runSimulation).toHaveBeenCalledTimes(1));
            const container = card.querySelector('.mwi-task-profit');
            if (change === 'monster') card.querySelector('.RandomTask_name__1a').textContent = 'Defeat - Smashy';
            if (change === 'quantity') card.children[3].textContent = 'Progress: 0 / 100';
            if (change === 'removed') card.remove();
            finish(SIM);
            await pending;

            expect(taskProfitDisplay._resolveGoEstimate(card)).toBeNull();
            expect(container._mwiCombatEstimate).toBeNull();
        }
    );

    test('a manual request whose card changes during the roster read never starts an obsolete simulation', async () => {
        let finishRoster;
        buildAllPlayerDTOs.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finishRoster = resolve;
                })
        );
        const card = mountCard();
        const pending = estimate(card);
        await vi.waitFor(() => expect(buildAllPlayerDTOs).toHaveBeenCalledTimes(1));
        card.querySelector('.RandomTask_name__1a').textContent = 'Defeat - Smashy';
        finishRoster({ players: structuredClone(players), selfHrid: 'player1' });
        await pending;

        expect(runSimulation).not.toHaveBeenCalled();
        expect(taskProfitDisplay._resolveGoEstimate(card)).toBeNull();
    });

    test.each([
        [
            'remaining kills',
            () => {
                players.at(-1).taskMonsterRemaining[STABBY] = 3;
            },
        ],
        [
            'completed task',
            () => {
                players.at(-1).taskMonsterRemaining[STABBY] = 0;
            },
        ],
        [
            'empty task board',
            () => {
                players.at(-1).taskMonsterHrids = [];
                players.at(-1).taskMonsterRemaining = {};
            },
        ],
        [
            'equipment enhancement',
            () => {
                players.at(-1).equipment['/equipment_types/main_hand'].enhancementLevel = 7;
            },
        ],
        [
            'combat level',
            () => {
                players.at(-1).attackLevel = 71;
            },
        ],
        [
            'ability rotation',
            () => {
                players.at(-1).abilities[1] = { hrid: '/abilities/puncture', level: 3, triggers: [] };
            },
        ],
        [
            'party member',
            () => {
                players[1].attackLevel = 92;
            },
        ],
        [
            'community buffs',
            () => {
                buffs.comDrop = 5;
            },
        ],
    ])('%s changes cannot reuse a cached result', async (_name, change) => {
        // Self need not lead the roster, and three participants exercise the whole roster identity.
        players = [player('player2'), player('player3'), player('player1')];
        for (const other of players.slice(0, 2)) {
            delete other.taskMonsterHrids;
            delete other.taskMonsterRemaining;
        }
        const card = mountCard();
        await estimate(card);
        await estimate(card);
        expect(runSimulation).toHaveBeenCalledTimes(1);
        change();
        await estimate(card);
        expect(runSimulation).toHaveBeenCalledTimes(2);
    });

    test('an edited snapshot under the same loadout name uses its new applied gear', async () => {
        let enhancementLevel = 4;
        applyLoadoutSnapshotToDTO.mockImplementation((dto) => {
            dto.equipment['/equipment_types/main_hand'].enhancementLevel = enhancementLevel;
        });
        const card = mountCard();
        await estimate(card, { loadout: 'Combat' });
        enhancementLevel = 8;
        await estimate(card, { loadout: 'Combat' });
        expect(runSimulation).toHaveBeenCalledTimes(2);
        expect(
            runSimulation.mock.calls[1][0].playerDTOs[0].equipment['/equipment_types/main_hand'].enhancementLevel
        ).toBe(8);
    });

    test('three identical cards still share one simulation with freshly built DTO objects', async () => {
        for (let i = 0; i < 3; i++) await estimate(mountCard());
        expect(buildAllPlayerDTOs).toHaveBeenCalledTimes(3);
        expect(runSimulation).toHaveBeenCalledTimes(1);
    });

    test('object insertion order does not split an identical build', async () => {
        players[0].taskMonsterRemaining[SMASHY] = 3;
        const card = mountCard();
        await estimate(card);
        players[0].taskMonsterRemaining = { [SMASHY]: 3, [STABBY]: 65 };
        await estimate(card);
        expect(runSimulation).toHaveBeenCalledTimes(1);
    });

    test('different task cards share one whole-zone simulation when their board and gear match', async () => {
        players[0].taskMonsterHrids = [STABBY, SMASHY];
        players[0].taskMonsterRemaining[SMASHY] = 3;
        for (const name of ['Stabby', 'Smashy', 'Robo']) await estimate(mountCard(name), { mode: 'zone' });
        expect(runSimulation).toHaveBeenCalledTimes(1);
    });

    test('boss targets in Solo mode also invalidate on changed task inputs', async () => {
        const card = mountCard('Robo');
        await estimate(card, { mode: 'solo' });
        players[0].taskMonsterHrids = [BOSS];
        players[0].taskMonsterRemaining = { [BOSS]: 8 };
        await estimate(card, { mode: 'solo' });
        expect(runSimulation).toHaveBeenCalledTimes(2);
    });

    test('character identity stays separate even when two builds happen to match', async () => {
        const card = mountCard();
        await estimate(card);
        dataManager.currentCharacterId = 'char-b';
        await estimate(card);
        expect(runSimulation).toHaveBeenCalledTimes(2);
    });

    test('different tiers remain separate', async () => {
        const card = mountCard();
        await estimate(card);
        tier = 3;
        await estimate(card);
        expect(runSimulation).toHaveBeenCalledTimes(2);
    });

    test('an expired promise failing cannot evict the newer result for the same inputs', async () => {
        let now = 1000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        vi.spyOn(console, 'error').mockImplementation(() => {});
        let rejectOld;
        runSimulation.mockImplementationOnce(
            () =>
                new Promise((_resolve, reject) => {
                    rejectOld = reject;
                })
        );
        const pending = estimate(mountCard());
        await vi.waitFor(() => expect(runSimulation).toHaveBeenCalledTimes(1));
        now += 3 * 60 * 1000;
        await estimate(mountCard());
        expect(runSimulation).toHaveBeenCalledTimes(2);
        rejectOld(new Error('old worker failed'));
        await pending;
        await estimate(mountCard());
        expect(runSimulation).toHaveBeenCalledTimes(2);
    });

    test('new game data cannot reuse a result for the previous tables', async () => {
        const card = mountCard();
        await estimate(card);
        dataManager.initClientData = structuredClone(dataManager.initClientData);
        dataManager.initClientData.actionDetailMap[ZONE].combatZoneInfo.fightInfo.randomSpawnInfo.maxSpawnCount = 5;
        await estimate(card);
        expect(runSimulation).toHaveBeenCalledTimes(2);
    });
});

describe('Solo simulation cache boundaries', () => {
    beforeEach(() => {
        taskProfitDisplay._estimateMode = 'solo';
    });

    test('three duplicate tasks share a board simulation but retain their own remaining kills and Go counts', async () => {
        players[0].taskMonsterHrids = [STABBY, STABBY, STABBY];
        players[0].taskMonsterRemaining = { [STABBY]: 79 };
        const cards = [mountCard(), mountCard('Stabby', 4, 18), mountCard('Stabby', 3, 3)];
        for (const card of cards) await estimate(card);

        expect(runSimulation).toHaveBeenCalledTimes(1);
        const records = cards.map((card) => taskProfitDisplay._cardEstimates.get(card));
        expect(records.map((record) => record.killsNeeded)).toEqual([65, 14, 0]);
        expect(records[0].predictedFights).toBeGreaterThan(records[1].predictedFights);
        expect(records[1].predictedFights).toBeGreaterThan(0);
        expect(records[2].predictedFights).toBe(0);
    });

    test('different Solo targets in the same zone keep separate filtered spawn tables', async () => {
        players[0].taskMonsterHrids = [STABBY, SMASHY];
        players[0].taskMonsterRemaining[SMASHY] = 30;
        for (const name of ['Stabby', 'Smashy', 'Stabby']) await estimate(mountCard(name));

        expect(runSimulation).toHaveBeenCalledTimes(2);
        const fights = runSimulation.mock.calls.map(
            ([params]) => params.gameData.actionDetailMap[ZONE].combatZoneInfo.fightInfo
        );
        expect(fights.map((fight) => fight.randomSpawnInfo.spawns)).toEqual([
            [{ combatMonsterHrid: STABBY }],
            [{ combatMonsterHrid: SMASHY }],
        ]);
        expect(fights.every((fight) => fight.bossSpawns.length === 0)).toBe(true);
    });

    test.each([
        ['solo', 'zone'],
        ['zone', 'solo'],
    ])('%s then %s never shares a filtered result with the full zone', async (first, second) => {
        const card = mountCard();
        await estimate(card, { mode: first });
        await estimate(card, { mode: second });
        await estimate(card, { mode: first });
        await estimate(card, { mode: second });

        expect(runSimulation).toHaveBeenCalledTimes(2);
        expect(
            runSimulation.mock.calls.map(
                ([params]) =>
                    params.gameData.actionDetailMap[ZONE].combatZoneInfo.fightInfo.randomSpawnInfo.spawns.length
            )
        ).toEqual(first === 'solo' ? [1, 2] : [2, 1]);
    });

    test('a boss Solo card still shares with full-zone estimates but not an ordinary Solo card', async () => {
        await estimate(mountCard('Robo'));
        await estimate(mountCard('Stabby'), { mode: 'zone' });
        await estimate(mountCard('Stabby'));
        await estimate(mountCard('Stabby'));
        expect(runSimulation).toHaveBeenCalledTimes(2);
        expect(
            runSimulation.mock.calls[0][0].gameData.actionDetailMap[ZONE].combatZoneInfo.fightInfo.bossSpawns
        ).toEqual([{ combatMonsterHrid: BOSS }]);
    });

    test('identical concurrent Solo cards share the pending promise and completed random sample', async () => {
        let finish;
        runSimulation.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                })
        );
        const cards = [mountCard(), mountCard(), mountCard()];
        const requests = cards.map((card) => estimate(card));
        await vi.waitFor(() => expect(buildAllPlayerDTOs).toHaveBeenCalledTimes(3));
        finish(SIM);
        const containers = await Promise.all(requests);
        expect(runSimulation).toHaveBeenCalledTimes(1);
        expect(containers.every((container) => container._mwiCombatEstimate.simResult === SIM)).toBe(true);
        for (const card of cards) expect(taskProfitDisplay._cardEstimates.has(card)).toBe(true);
        // This caller has no fixed seed setting. Each cache miss still asks the runner
        // for its normal independent sample; only equivalent cache hits share one.
        expect(runSimulation.mock.calls[0][0]).not.toHaveProperty('seed');
        expect(runSimulation.mock.calls[0][0].taskDamageMode).toBe('perMonster');
    });

    test('a rejected shared promise is evicted and all waiters can retry', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        let reject;
        runSimulation.mockImplementationOnce(
            () =>
                new Promise((_resolve, no) => {
                    reject = no;
                })
        );
        const cards = [mountCard(), mountCard(), mountCard()];
        const requests = cards.map((card) => estimate(card));
        await vi.waitFor(() => expect(buildAllPlayerDTOs).toHaveBeenCalledTimes(3));
        reject(new Error('worker failed'));
        const containers = await Promise.all(requests);
        expect(runSimulation).toHaveBeenCalledTimes(1);
        expect(containers.every((container) => container.textContent.includes('Estimate failed. Retry'))).toBe(true);
        expect(taskProfitDisplay._zoneSimCache.size).toBe(0);
        for (const card of cards) await estimate(card);
        expect(runSimulation).toHaveBeenCalledTimes(2);
    });

    test('the cache expires at three minutes and prunes entries for other targets', async () => {
        let now = 1000;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const card = mountCard();
        await estimate(card);
        await estimate(mountCard('Smashy'));
        now += 3 * 60 * 1000 - 1;
        await estimate(card);
        expect(runSimulation).toHaveBeenCalledTimes(2);
        now++;
        await estimate(card);
        expect(runSimulation).toHaveBeenCalledTimes(3);
        expect(taskProfitDisplay._zoneSimCache.size).toBe(1);
    });

    test('disable clears Solo entries and an old pending result cannot replace a new generation', async () => {
        let finishOld;
        runSimulation.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finishOld = resolve;
                })
        );
        const oldCard = mountCard();
        const pending = estimate(oldCard);
        await vi.waitFor(() => expect(runSimulation).toHaveBeenCalledTimes(1));
        taskProfitDisplay.disable();
        expect(taskProfitDisplay._zoneSimCache.size).toBe(0);
        taskProfitDisplay.isInitialized = true;
        const card = mountCard();
        await estimate(card);
        finishOld({ ...SIM, encounters: 999 });
        await pending;
        await estimate(card);
        expect(runSimulation).toHaveBeenCalledTimes(2);
        expect(taskProfitDisplay._cardEstimates.has(oldCard)).toBe(false);
        expect(card.querySelector('.mwi-task-profit')._mwiCombatEstimate.simResult).toBe(SIM);
    });
});
