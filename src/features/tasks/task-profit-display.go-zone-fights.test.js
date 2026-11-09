/**
 * @vitest-environment happy-dom
 *
 * Go on a zone-mode combat task card fills the fight count the card's zone
 * summary quotes ("Gobo Planet: ~558 fights (90%) | ... (bottleneck: Smashy ×4)"),
 * not only this one card's own kills (Stabby 65 kills -> ~153 fights).
 *
 * The summary covers every open Defeat task in the zone because Go opens that
 * one zone and every kill there progresses whichever task wants the monster.
 * Before this fix the stored estimate carried only the card's own figure, so
 * the dialog showed a count a fraction of what the card told the player to
 * expect. The tier is whatever the estimate simulated (the player's queue, T0
 * when the zone is nowhere in it) and Go opens that same tier.
 */

import { describe, test, expect, afterEach, beforeEach, vi } from 'vitest';
import taskProfitDisplay from './task-profit-display.js';
import dataManager from '../../core/data-manager.js';
import config from '../../core/config.js';
import { paddedZoneFights } from './task-zone-estimate-percentile.js';
import { runSimulation } from '../combat-sim/combat-sim-runner.js';
import { buildAllPlayerDTOs, buildGameDataPayload } from '../combat-sim/combat-sim-adapter.js';
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
                                { combatMonsterHrid: '/monsters/shooty' },
                            ],
                        },
                        bossSpawns: [{ combatMonsterHrid: '/monsters/gobo_chieftain' }],
                    },
                },
            },
        },
        actionCategoryDetailMap: { '/categories/gobo': { sortIndex: 1 } },
        combatMonsterDetailMap: {
            '/monsters/stabby': { name: 'Stabby' },
            '/monsters/smashy': { name: 'Smashy' },
            '/monsters/shooty': { name: 'Shooty' },
            '/monsters/gobo_chieftain': { name: 'Gobo Chieftain' },
        },
    };
}

/** A parseable task card: name, "Progress: x / y", empty rewards. */
function card(description, progress, quantity) {
    const info = document.createElement('div');
    info.className = 'RandomTask_taskInfo__1a';
    const name = document.createElement('div');
    name.className = 'RandomTask_name__1a';
    name.textContent = description;
    info.appendChild(name);
    const p = document.createElement('div');
    p.textContent = `Progress: ${progress} / ${quantity}`;
    info.appendChild(p);
    const rewards = document.createElement('div');
    rewards.className = 'RandomTask_rewards__1a';
    info.appendChild(rewards);
    return info;
}

/** The board, with an estimate container inside the first card. */
function mountBoard(tasks) {
    const list = document.createElement('div');
    list.className = 'TasksPanel_taskList__1a';
    const cards = tasks.map(([d, progress, qty]) => card(d, progress, qty));
    cards.forEach((c) => list.appendChild(c));
    document.body.appendChild(list);
    const container = document.createElement('div');
    cards[0].appendChild(container);
    return { container, firstCard: cards[0] };
}

function detailPanel(zoneName, tier) {
    const panel = document.createElement('div');
    panel.className = 'SkillActionDetail_skillActionDetail__1a';
    const name = document.createElement('div');
    name.className = 'SkillActionDetail_name__1a';
    name.textContent = zoneName;
    panel.appendChild(name);
    const id = 'lb-go-zone-fights';
    const combobox = document.createElement('div');
    combobox.setAttribute('role', 'combobox');
    combobox.setAttribute('aria-controls', id);
    combobox.textContent = `T${tier}`;
    panel.appendChild(combobox);
    const listbox = document.createElement('ul');
    listbox.id = id;
    listbox.setAttribute('role', 'listbox');
    document.body.appendChild(listbox);
    const inputContainer = document.createElement('div');
    inputContainer.className = 'maxActionCountInput__1a';
    const input = document.createElement('input');
    inputContainer.appendChild(input);
    panel.appendChild(inputContainer);
    document.body.appendChild(panel);
    return { input, combobox };
}

/** Sim over the default 1h window: per-monster kills and encounters. */
const SIM = {
    deaths: {
        '/monsters/stabby': 100,
        '/monsters/smashy': 40,
        '/monsters/shooty': 100,
        '/monsters/gobo_chieftain': 5,
    },
    encounters: 120,
};

/** The game's own Difficulty pick for the zone (null: none), kept in the page's localStorage */
function stubGamePick(tier) {
    dataManager.currentCharacterId = 'char-a';
    const map = new Map(
        tier === null ? [] : [['lastSelectedActionDifficultyMap_char-a', JSON.stringify({ [ZONE]: tier })]]
    );
    vi.stubGlobal('localStorage', { getItem: (key) => (map.has(key) ? map.get(key) : null) });
}

beforeEach(() => {
    dataManager.initClientData = gameData();
    buildGameDataPayload.mockReturnValue(dataManager.initClientData);
    buildAllPlayerDTOs.mockResolvedValue({ players: [{ hrid: 'player1' }] });
    vi.spyOn(dataManager, 'isBossMonster').mockImplementation((h) => h === '/monsters/gobo_chieftain');
});

afterEach(() => {
    dataManager.initClientData = null;
    dataManager.characterActions = [];
    dataManager.characterQuests = [];
    dataManager.currentCharacterId = null;
    document.body.innerHTML = '';
    taskProfitDisplay._zoneSimCache?.clear?.();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    runSimulation.mockReset();
});

async function runCardEstimate(board, sim, mode = 'zone') {
    runSimulation.mockResolvedValue(sim);
    const { container, firstCard } = mountBoard(board);
    const taskData = taskProfitDisplay.parseTaskData(firstCard);
    await taskProfitDisplay._runCombatSimEstimate(container, taskData, '', mode);
    return { container, firstCard, estimate: taskProfitDisplay._cardEstimates.get(firstCard) };
}

function quotedFights(container) {
    const line = [...container.children].find((c) => c.textContent.startsWith('Gobo Planet'));
    return line ? Number(line.textContent.match(/~([\d,]+) fights/)?.[1].replace(/,/g, '')) : null;
}

describe('Go fills the fights the zone summary quotes', () => {
    const BOARD = [
        ['Defeat - Stabby', 0, 65],
        ['Defeat - Smashy', 4, 30],
        ['Defeat - Smashy', 0, 30],
        ['Defeat - Smashy', 10, 30],
        ['Defeat - Gobo Chieftain', 0, 2],
    ];

    test('the stored zone figure is the quoted one, and it exceeds this card own kills', async () => {
        stubGamePick(3);
        const { container, estimate } = await runCardEstimate(BOARD, SIM);

        const quoted = quotedFights(container);
        expect(quoted).toBeGreaterThan(estimate.predictedFights);
        expect(estimate.zoneFights).toBe(quoted);
        expect(estimate.tier).toBe(3);
        expect(runSimulation).toHaveBeenCalledWith(expect.objectContaining({ difficultyTier: 3 }));
        // The card says which tier the quoted figure is for
        const line = [...container.children].find((c) => c.textContent.startsWith('Gobo Planet'));
        expect(line.title).toContain('T3');
    });

    test('Go opens the estimate tier and types the quoted count, not the card own padded count', async () => {
        stubGamePick(3);
        const { container, estimate } = await runCardEstimate(BOARD, SIM);
        const { input, combobox } = detailPanel('Gobo Planet', 3);

        await taskProfitDisplay._applyGoEstimate(estimate);

        expect(combobox.textContent).toBe('T3');
        expect(Number(input.value)).toBe(quotedFights(container));
        // The pre-fix fill: this card's own 65 kills, padded to a confidence quantile
        const own = fightsForKillConfidence({
            killsNeeded: 65,
            killsPerFight: estimate.killsPerFight,
            slotsPerFight: 3,
            confidencePercent: 90,
        });
        expect(Number(input.value)).toBeGreaterThan(own);
    });

    test('a progress change redraws the stored figure with the board', async () => {
        stubGamePick(3);
        const { container, firstCard, estimate } = await runCardEstimate(BOARD, SIM);
        const before = estimate.zoneFights;

        // Smashy tasks nearly done: far fewer fights needed
        const progress = [...document.querySelectorAll('.RandomTask_taskInfo__1a')]
            .filter((n) => n.textContent.includes('Smashy'))
            .map((n) => [...n.querySelectorAll('div')].find((d) => d.textContent.startsWith('Progress:')));
        progress.forEach((d) => (d.textContent = 'Progress: 29 / 30'));
        const wasInit = taskProfitDisplay.isInitialized;
        taskProfitDisplay.isInitialized = true;
        taskProfitDisplay._refreshOpenCombatEstimates();
        taskProfitDisplay.isInitialized = wasInit;

        const after = taskProfitDisplay._cardEstimates.get(firstCard);
        expect(after.zoneFights).toBeLessThan(before);
        expect(after.zoneFights).toBe(quotedFights(container));
    });

    test('a zone the game has no pick for stays T0, says so on the line, and still fills the quoted count', async () => {
        stubGamePick(null);
        const { container, estimate } = await runCardEstimate(BOARD, SIM);
        expect(estimate.tier).toBe(0);
        const line = [...container.children].find((c) => c.textContent.startsWith('Gobo Planet'));
        expect(line.title).toContain("the game's default");
        expect(estimate.zoneFights).toBe(quotedFights(container));
    });

    test('a monster missing from the rate data: the card says ??? and Go falls back to its own count', async () => {
        const sim = { deaths: { '/monsters/stabby': 100, '/monsters/shooty': 100 }, encounters: 120 };
        const { container, estimate } = await runCardEstimate(BOARD, sim);
        const line = [...container.children].find((c) => c.textContent.startsWith('Gobo Planet'));
        expect(line.textContent).toContain('???');
        expect(estimate.zoneFights).toBeNull();
        expect(Number.isFinite(estimate.predictedFights)).toBe(true);

        const { input } = detailPanel('Gobo Planet', 0);
        await taskProfitDisplay._applyGoEstimate(estimate);
        expect(Number(input.value)).toBeGreaterThanOrEqual(estimate.predictedFights);
    });

    test('only one open task in the zone: no summary, no zone figure, own count as before', async () => {
        const { container, estimate } = await runCardEstimate([['Defeat - Stabby', 0, 65]], SIM);
        expect(quotedFights(container)).toBeNull();
        expect(estimate.zoneFights).toBeNull();
    });

    test('solo mode never carries a zone figure', async () => {
        const { estimate } = await runCardEstimate(BOARD, SIM, 'solo');
        expect(estimate.zoneFights).toBeNull();
    });
});

/**
 * The quoted zone figure follows `taskCombatEstimatePercentile` (the median is an option), so Go also
 * pads the zone from the means by the confidence setting and keeps the flat buffer as a floor, and fills
 * the larger of the two: never less than the card says, nor less than the player's confidence asks.
 */
describe('Go pads the zone count as well as quoting it', () => {
    const BOARD = [
        ['Defeat - Stabby', 0, 65],
        ['Defeat - Smashy', 4, 30],
        ['Defeat - Smashy', 0, 30],
        ['Defeat - Gobo Chieftain', 0, 2],
    ];

    function settings({ percentile = '90', confidence = 90, buffer = 5 } = {}) {
        const real = config.getSettingValue.bind(config);
        vi.spyOn(config, 'getSettingValue').mockImplementation((key, fallback) => {
            if (key === 'taskCombatEstimatePercentile') return percentile;
            if (key === 'combatFightConfidence') return confidence;
            if (key === 'taskCombatGoBuffer') return buffer;
            return real(key, fallback);
        });
    }

    async function goFill(percentile, extra = {}) {
        settings({ percentile, ...extra });
        stubGamePick(3);
        const { container, estimate } = await runCardEstimate(BOARD, SIM);
        const { input } = detailPanel('Gobo Planet', 3);
        await taskProfitDisplay._applyGoEstimate(estimate);
        return { quoted: quotedFights(container), filled: Number(input.value), estimate };
    }

    test('at Median the card quotes the 50% figure but Go still covers the confidence setting', async () => {
        const { quoted, filled, estimate } = await goFill('50');
        const padded = paddedZoneFights({
            thresholds: estimate.zoneThresholds,
            meanFloor: estimate.zoneMeanFights,
            confidencePercent: 90,
            bufferPercent: 5,
        });
        expect(padded).toBeGreaterThan(quoted);
        expect(filled).toBe(padded);
    });

    test('a higher confidence setting fills more than the card quotes at 90%', async () => {
        const { quoted, filled } = await goFill('90', { confidence: 99 });
        expect(filled).toBeGreaterThan(quoted);
    });

    test('the flat buffer is kept as a floor', async () => {
        const { quoted, filled, estimate } = await goFill('90', { buffer: 60 });
        const limiting = Math.max(
            ...estimate.zoneThresholds.map((t) => (Number.isFinite(t.meanFights) ? t.meanFights : 0))
        );
        expect(filled).toBeGreaterThanOrEqual(Math.ceil(limiting * 1.6) - 1);
        expect(filled).toBeGreaterThan(quoted);
    });

    test('at default settings Go never fills less than the card, and not much more', async () => {
        const { quoted, filled } = await goFill('90');
        expect(filled).toBeGreaterThanOrEqual(quoted);
        expect(filled).toBeLessThanOrEqual(Math.ceil(quoted * 1.06));
    });

    test('the Task Statistics row pads the same way, from the same helper', async () => {
        const { estimate } = await goFill('90');
        const row = {
            fightsNeeded: estimate.zoneMeanFights,
            estimate: { fightsNeeded: estimate.zoneFights },
            monsterThresholds: estimate.zoneThresholds,
        };
        const { default: statistics } = await import('./task-statistics.js');
        const fromRow = statistics.paddedZoneFightCount(row);
        const fromCard = Math.max(
            estimate.zoneFights,
            paddedZoneFights({
                thresholds: estimate.zoneThresholds,
                meanFloor: estimate.zoneMeanFights,
                confidencePercent: 90,
                bufferPercent: 5,
            })
        );
        expect(fromRow).toBe(fromCard);
    });
});
