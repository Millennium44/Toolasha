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

const capMock = vi.hoisted(() => ({ cap: null }));
vi.mock('../../utils/liquidity-cap.js', async (importOriginal) => ({
    ...(await importOriginal()),
    // Market volume bounds a rate only where the test says so (by tier, through the fixture's own rate)
    capProfitRateCached: vi.fn(({ goldPerHour }) =>
        capMock.cap ? capMock.cap(goldPerHour) : { goldPerHour, capped: false, limit: null }
    ),
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
    capMock.cap = null;
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

    test('XP and profit pulling opposite ways tie on Score; the tier that kills the task monster fastest wins', async () => {
        // Measured shape on the test server (Eye, Solo): T0 best profit, T2 best XP, all three Score 50
        installTiers({
            0: simResult({ xp: 1000, net: 90_000, stabbyKills: 100 }),
            1: simResult({ xp: 2000, net: 40_000, stabbyKills: 300 }),
            2: simResult({ xp: 3000, net: 10_000, stabbyKills: 200 }),
            3: simResult({ xp: 500, net: 5_000, playerDeaths: 4 }),
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

    test('a character switch mid-search stops it, and nothing is cached under the new character', async () => {
        const tiers = ladder();
        runSimulation.mockImplementation(async ({ difficultyTier }) => {
            if (difficultyTier === 1) dataManager.currentCharacterId = 'char-b';
            return tiers[difficultyTier];
        });
        const card = mountCard();

        const record = await estimate(card, 'zone');

        expect(runSimulation).toHaveBeenCalledTimes(2);
        expect(record).toBeUndefined();
        const keys = [...taskProfitDisplay._zoneSimCache.keys()];
        expect(keys.length).toBeGreaterThan(0);
        expect(keys.every((key) => key.startsWith('char-a|'))).toBe(true);
    });

    test('a card removed mid-search stops it', async () => {
        const tiers = ladder();
        const card = mountCard();
        runSimulation.mockImplementation(async ({ difficultyTier }) => {
            if (difficultyTier === 0) document.body.innerHTML = '';
            return tiers[difficultyTier];
        });

        await estimate(card);

        expect(runSimulation).toHaveBeenCalledTimes(1);
    });
});

describe('Best Score judges the local character and sellable profit', () => {
    test('in a party listed with someone else first, deaths and XP are read for the local character', async () => {
        // Party member first in the roster; the local character is PLAYER, second. T2 kills the local
        // character, so it must lose though the member survives it.
        buildAllPlayerDTOs.mockResolvedValue({ players: [{ hrid: 'player2' }, { hrid: PLAYER }], selfHrid: PLAYER });
        installTiers({ ...ladder(), 2: simResult({ xp: 9000, net: 900_000, playerDeaths: 3 }) });
        const card = mountCard();

        const record = await estimate(card);

        expect(record.tier).toBe(3);
    });

    test('a tier whose loot cannot be sold at that pace is ranked on the market-bounded profit', async () => {
        // T2 leads on raw profit, but market volume bounds it below every other tier's
        installTiers({
            0: simResult({ xp: 1000, net: 10_000 }),
            1: simResult({ xp: 2000, net: 40_000 }),
            2: simResult({ xp: 2100, net: 900_000 }),
            3: simResult({ xp: 2500, net: 60_000 }),
        });
        capMock.cap = (goldPerHour) =>
            goldPerHour === 900_000
                ? { goldPerHour: 1_000, capped: true, limit: {} }
                : { goldPerHour, capped: false, limit: null };
        const card = mountCard();

        const record = await estimate(card);

        expect(record.tier).toBe(3);
    });
});

describe("a Solo card follows the monster's own fight pick", () => {
    const EYE_FIGHT = '/actions/combat/eye';
    const PLANET = '/actions/combat/planet_of_the_eyes';
    const BOSS_ZONE = '/actions/combat/boss_zone';
    beforeEach(() => {
        // The game's shapes: a planet spawning several monsters, the monster's own one-slot fight, and a
        // zone where the monster is the boss
        dataManager.initClientData = {
            actionDetailMap: {
                [PLANET]: {
                    hrid: PLANET,
                    combatZoneInfo: {
                        fightInfo: {
                            randomSpawnInfo: {
                                maxSpawnCount: 3,
                                spawns: [
                                    { combatMonsterHrid: '/monsters/eye' },
                                    { combatMonsterHrid: '/monsters/eyes' },
                                ],
                            },
                            bossSpawns: [],
                        },
                    },
                },
                [EYE_FIGHT]: {
                    hrid: EYE_FIGHT,
                    combatZoneInfo: {
                        fightInfo: {
                            randomSpawnInfo: { maxSpawnCount: 1, spawns: [{ combatMonsterHrid: '/monsters/eye' }] },
                            bossSpawns: [],
                        },
                    },
                },
                [BOSS_ZONE]: {
                    hrid: BOSS_ZONE,
                    combatZoneInfo: {
                        fightInfo: {
                            randomSpawnInfo: { maxSpawnCount: 3, spawns: [{ combatMonsterHrid: '/monsters/eyes' }] },
                            bossSpawns: [{ combatMonsterHrid: '/monsters/eye' }],
                        },
                    },
                },
            },
        };
        tierMode = 'game';
        const picks = new Map([
            ['lastSelectedActionDifficultyMap_char-a', JSON.stringify({ [EYE_FIGHT]: 2, [PLANET]: 4 })],
        ]);
        vi.stubGlobal('localStorage', { getItem: (key) => (picks.has(key) ? picks.get(key) : null) });
    });

    test("Solo reads the Eye fight's pick (where Go lands), not the planet's", () => {
        expect(taskProfitDisplay._resolveEstimateTier(PLANET, '/monsters/eye', 'solo')).toMatchObject({
            tier: 2,
            source: 'selected',
        });
    });

    test("Zone mode reads the planet's pick", () => {
        expect(taskProfitDisplay._resolveEstimateTier(PLANET, '/monsters/eye', 'zone').tier).toBe(4);
    });

    test("a boss target follows its zone's pick, and a monster with no own fight the zone's", () => {
        expect(taskProfitDisplay._tierActionHrid(BOSS_ZONE, '/monsters/eye', 'solo')).toBe(BOSS_ZONE);
        expect(taskProfitDisplay._tierActionHrid(PLANET, '/monsters/eyes', 'solo')).toBe(PLANET);
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

    test('the setting switched to the game pick while a Best Score search runs: the card ends in the new mode', async () => {
        const tiers = ladder();
        stubGamePick(1);
        runSimulation.mockImplementation(async ({ difficultyTier }) => {
            // Switched mid-search, before the run has a result the setting handler could find
            if (difficultyTier === 0) tierMode = 'game';
            return tiers[difficultyTier];
        });
        const card = mountCard();

        const record = await estimate(card);

        expect(record.tier).toBe(1);
        expect(card.container.innerHTML).toContain('T1 (the tier selected in the game)');
    });
});
