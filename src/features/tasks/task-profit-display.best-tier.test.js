/**
 * @vitest-environment happy-dom
 *
 * "Best Score" combat tier (`taskCombatGoTier` = 'best'): the task card simulates every tier of the zone
 * (T0 to the zone's maxDifficulty), ranks them by the All Zones ladder Score (XP/hr and Profit/day), leaves
 * out tiers where the player dies or the task monster is never killed, and lets the lowest tier win a tie.
 * In that mode a changed game pick does not redo the estimate; only the setting changing does.
 */

import { describe, test, expect, afterEach, beforeEach, vi } from 'vitest';

vi.mock('../combat-sim/combat-sim-runner.js', () => ({ runSimulation: vi.fn() }));
vi.mock('../combat-sim/combat-sim-adapter.js', () => ({
    seedSimPriceCache: (cache) => cache,
    buildAllPlayerDTOs: vi.fn(),
    buildGameDataPayload: vi.fn(),
    getCommunityBuffs: vi.fn(() => ({})),
    applyLoadoutSnapshotToDTO: vi.fn(),
    // Profit per hour is carried on the fixture so each tier can be given its own
    calculateSimRevenue: vi.fn((sim) => ({
        netPerHour: sim?.netPerHour ?? 0,
        dropEntries: [],
        consumableEntries: [],
    })),
}));

import taskProfitDisplay from './task-profit-display.js';
import dataManager from '../../core/data-manager.js';
import config from '../../core/config.js';
import { runSimulation } from '../combat-sim/combat-sim-runner.js';
import { buildAllPlayerDTOs, buildGameDataPayload } from '../combat-sim/combat-sim-adapter.js';

const ZONE = '/actions/combat/gobo_planet';
const PLAYER = 'player1';
const STABBY = '/monsters/stabby';
const SMASHY = '/monsters/smashy';
const HOUR_NS = 3600 * 1e9;

function gameData(maxDifficulty) {
    return {
        actionDetailMap: {
            [ZONE]: {
                type: '/action_types/combat',
                name: 'Gobo Planet',
                category: '/categories/gobo',
                ...(maxDifficulty === null ? {} : { maxDifficulty }),
                combatZoneInfo: {
                    isDungeon: false,
                    fightInfo: {
                        randomSpawnInfo: {
                            maxSpawnCount: 3,
                            spawns: [{ combatMonsterHrid: STABBY }, { combatMonsterHrid: SMASHY }],
                        },
                        bossSpawns: [],
                    },
                },
            },
        },
        actionCategoryDetailMap: { '/categories/gobo': { sortIndex: 1 } },
        combatMonsterDetailMap: { [STABBY]: { name: 'Stabby' }, [SMASHY]: { name: 'Smashy' } },
    };
}

/**
 * One tier's sim result, shaped like the runner's: `experienceGained[playerHrid]` per skill, deaths by
 * hrid (the player's and each monster's), `simulatedTime` in nanoseconds.
 */
function simResult({ xp, net, playerDeaths = 0, stabbyKills = 100, smashyKills = 60 }) {
    const deaths = { [SMASHY]: smashyKills };
    if (stabbyKills) deaths[STABBY] = stabbyKills;
    if (playerDeaths) deaths[PLAYER] = playerDeaths;
    return {
        deaths,
        encounters: 120,
        experienceGained: { [PLAYER]: { attack: xp * 0.6, defense: xp * 0.4 } },
        simulatedTime: HOUR_NS,
        netPerHour: net,
    };
}

/** The ladder: tier 2 is best on both metrics, tier 3 second, tier 1 third. */
function ladder() {
    return {
        0: simResult({ xp: 1000, net: 10_000 }),
        1: simResult({ xp: 2000, net: 40_000 }),
        2: simResult({ xp: 3000, net: 90_000 }),
        3: simResult({ xp: 2500, net: 60_000 }),
    };
}

/** Each tier's result by `difficultyTier`; the runner is asked for exactly the tiers the search walks. */
function installTiers(byTier) {
    runSimulation.mockImplementation(async ({ difficultyTier }) => {
        const result = byTier[difficultyTier];
        if (!result) throw new Error(`unexpected tier ${difficultyTier}`);
        return result;
    });
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

async function estimate(card, mode = 'solo') {
    const taskData = taskProfitDisplay.parseTaskData(card.info);
    await taskProfitDisplay._runCombatSimEstimate(card.container, taskData, '', mode);
    return taskProfitDisplay._cardEstimates.get(card.info);
}

function stubGamePick(tier) {
    const picks = new Map([['lastSelectedActionDifficultyMap_char-a', JSON.stringify({ [ZONE]: tier })]]);
    vi.stubGlobal('localStorage', { getItem: (key) => (picks.has(key) ? picks.get(key) : null) });
}

let tierMode;

beforeEach(() => {
    tierMode = 'best';
    vi.spyOn(config, 'getSettingValue').mockImplementation((key, fallback) =>
        key === 'taskCombatGoTier' ? tierMode : fallback
    );
    dataManager.initClientData = gameData(3);
    dataManager.currentCharacterId = 'char-a';
    buildGameDataPayload.mockReturnValue(dataManager.initClientData);
    buildAllPlayerDTOs.mockResolvedValue({ players: [{ hrid: PLAYER }] });
    taskProfitDisplay.isInitialized = true;
});

afterEach(() => {
    taskProfitDisplay.isInitialized = false;
    taskProfitDisplay._zoneSimCache?.clear?.();
    dataManager.initClientData = null;
    dataManager.currentCharacterId = null;
    document.body.innerHTML = '';
    runSimulation.mockReset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('_searchBestTier: which tier the Best Score search keeps', () => {
    test('picks the tier with the highest ladder Score and sims exactly maxDifficulty + 1 tiers', async () => {
        installTiers(ladder());
        const card = mountCard();

        const record = await estimate(card);

        expect(runSimulation).toHaveBeenCalledTimes(4);
        expect(runSimulation.mock.calls.map(([params]) => params.difficultyTier)).toEqual([0, 1, 2, 3]);
        expect(record.tier).toBe(2);
        expect(card.container.innerHTML).toContain('T2 (best Score of the tiers simulated)');
    });

    test('a tier where the player dies is skipped, even when it ranks first', async () => {
        installTiers({ ...ladder(), 2: simResult({ xp: 9000, net: 900_000, playerDeaths: 3 }) });
        const card = mountCard();

        const record = await estimate(card);

        expect(record.tier).toBe(3);
    });

    test('a tier with zero task-monster kills is skipped, even when it ranks first', async () => {
        installTiers({ ...ladder(), 2: simResult({ xp: 9000, net: 900_000, stabbyKills: 0 }) });
        const card = mountCard();

        const record = await estimate(card);

        expect(record.tier).toBe(3);
    });

    test('when no tier finishes, every tier is ranked and the best of them wins', async () => {
        installTiers({
            0: simResult({ xp: 1000, net: 10_000, playerDeaths: 1 }),
            1: simResult({ xp: 2000, net: 40_000, stabbyKills: 0 }),
            2: simResult({ xp: 3000, net: 90_000, playerDeaths: 5 }),
            3: simResult({ xp: 2500, net: 60_000, stabbyKills: 0 }),
        });
        const card = mountCard();

        const record = await estimate(card);

        expect(runSimulation).toHaveBeenCalledTimes(4);
        expect(record.tier).toBe(2);
    });

    test('a tie goes to the lowest tier', async () => {
        const same = () => simResult({ xp: 1000, net: 10_000 });
        installTiers({ 0: same(), 1: same(), 2: same(), 3: same() });
        const card = mountCard();

        const record = await estimate(card);

        expect(record.tier).toBe(0);
    });

    test('tiers that tie for the top Score: the lowest of them wins', async () => {
        installTiers({
            0: simResult({ xp: 1000, net: 10_000 }),
            1: simResult({ xp: 3000, net: 90_000 }),
            2: simResult({ xp: 3000, net: 90_000 }),
            3: simResult({ xp: 2000, net: 40_000 }),
        });
        const card = mountCard();

        const record = await estimate(card);

        expect(record.tier).toBe(1);
    });

    test('a zone with no maxDifficulty is a single T0 run', async () => {
        dataManager.initClientData = gameData(null);
        buildGameDataPayload.mockReturnValue(dataManager.initClientData);
        installTiers({ 0: simResult({ xp: 1000, net: 10_000 }) });
        const card = mountCard();

        const record = await estimate(card);

        expect(runSimulation).toHaveBeenCalledTimes(1);
        expect(record.tier).toBe(0);
    });

    test('the game pick does not decide: a pick of T0 still ends on the best tier', async () => {
        stubGamePick(0);
        installTiers(ladder());
        const card = mountCard();

        const record = await estimate(card);

        expect(record.tier).toBe(2);
    });

    test('Zone mode reuses each tier from the shared cache on a second card', async () => {
        installTiers(ladder());
        await estimate(mountCard(), 'zone');
        expect(runSimulation).toHaveBeenCalledTimes(4);

        const record = await estimate(mountCard(), 'zone');

        expect(runSimulation).toHaveBeenCalledTimes(4);
        expect(record.tier).toBe(2);
    });
});

describe('_retierOpenCombatEstimates in Best Score mode', () => {
    async function drawn() {
        installTiers(ladder());
        const card = mountCard();
        await estimate(card);
        runSimulation.mockClear();
        return card;
    }

    test('a changed game pick enqueues nothing', async () => {
        const card = await drawn();
        const enqueue = vi.spyOn(taskProfitDisplay, '_enqueueRetier');
        stubGamePick(3);

        taskProfitDisplay._retierOpenCombatEstimates();

        expect(enqueue).not.toHaveBeenCalled();
        expect(runSimulation).not.toHaveBeenCalled();
        expect(taskProfitDisplay._cardEstimates.get(card.info).tier).toBe(2);
    });

    test('{ all: true } (the setting changed) redoes the open estimate even when the tier is unchanged', async () => {
        const card = await drawn();
        const enqueue = vi.spyOn(taskProfitDisplay, '_enqueueRetier');

        taskProfitDisplay._retierOpenCombatEstimates({ all: true });

        expect(enqueue).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(runSimulation).toHaveBeenCalledTimes(4));
        await vi.waitFor(() => expect(taskProfitDisplay._cardEstimates.get(card.info)?.tier).toBe(2));
    });

    test('in the game-pick mode a different pick does enqueue (the contrast)', async () => {
        await drawn();
        tierMode = 'game';
        const enqueue = vi.spyOn(taskProfitDisplay, '_enqueueRetier');

        // The card was drawn at the best tier, T2; the game has no pick, so T0 is what it shows
        taskProfitDisplay._retierOpenCombatEstimates();

        expect(enqueue).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(runSimulation).toHaveBeenCalled());
        expect(runSimulation.mock.calls[0][0]).toMatchObject({ difficultyTier: 0 });
    });
});
