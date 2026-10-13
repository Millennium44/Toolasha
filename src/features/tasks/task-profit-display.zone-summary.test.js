/**
 * @vitest-environment happy-dom
 *
 * The combat task card's zone summary line. It names the bottleneck the way
 * task-zone-bottleneck.js finds it, and quotes the fights at the coverage the
 * `taskCombatEstimatePercentile` setting asks for (task-zone-estimate-percentile.js).
 */

import { describe, test, expect, vi, afterEach } from 'vitest';

vi.mock('../combat-sim/combat-sim-runner.js', () => ({ runSimulation: vi.fn() }));
vi.mock('../combat-sim/combat-sim-adapter.js', () => ({
    buildAllPlayerDTOs: vi.fn(),
    buildGameDataPayload: vi.fn(),
    getCommunityBuffs: vi.fn(() => ({})),
    applyLoadoutSnapshotToDTO: vi.fn(),
    calculateSimRevenue: vi.fn(() => ({ netPerHour: 0, dropEntries: [], consumableEntries: [] })),
}));

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import taskProfitDisplay from './task-profit-display.js';
import { fightsForKillConfidence } from '../../utils/fight-confidence.js';
import { timeReadable } from '../../utils/formatters.js';

const ZONE = '/actions/combat/zone_z';
const rewardValue = {
    coins: 0,
    taskTokens: 0,
    purpleGift: 0,
    total: 0,
    isPartial: false,
    breakdown: { tokenValue: 0, tokensReceived: 0, giftPerTaskPoint: 0 },
    error: null,
};

/**
 * Render a zone-mode card with the given board and return the summary line.
 * @param {Array<[string, number, number]>} tasks - [monster name, quantity, progress]
 * @param {Object} simResult - Sim result
 * @returns {string|undefined} Summary text
 */
function renderSummary(tasks, simResult) {
    const line = renderSummaryLine(tasks, simResult);
    if (!line) return undefined;
    // The line's own text, without the median hint's "?"
    const copy = line.cloneNode(true);
    copy.querySelector('.mwi-zone-estimate-hint')?.remove();
    return copy.textContent;
}

/**
 * @returns {HTMLElement|undefined} The summary line element
 */
function renderSummaryLine(tasks, simResult) {
    const list = document.createElement('div');
    list.className = 'TasksPanel_taskList__x';
    for (const [name, quantity, currentProgress] of tasks) {
        const node = document.createElement('div');
        node.className = 'RandomTask_taskInfo__x';
        node.dataset.name = name;
        node.dataset.quantity = String(quantity);
        node.dataset.progress = String(currentProgress);
        list.appendChild(node);
    }
    document.body.appendChild(list);

    const container = document.createElement('div');
    taskProfitDisplay._renderCombatEstimateResult(
        container,
        { quantity: 100, currentProgress: 0, coinReward: 0, taskTokenReward: 0 },
        'Slime',
        100,
        '1h',
        3600,
        '',
        0,
        rewardValue,
        [],
        [],
        'zone',
        simResult,
        ZONE,
        0,
        true,
        { drops: [], consumables: [] }
    );
    return [...container.children].find((c) => c.textContent.startsWith('Zone Z'));
}

/** Pin the zone estimate coverage setting */
function setPercent(value) {
    const real = config.getSettingValue.bind(config);
    vi.spyOn(config, 'getSettingValue').mockImplementation((key, fallback) =>
        key === 'taskCombatEstimatePercentile' ? value : real(key, fallback)
    );
}

function stubGame({ maxSpawnCount } = {}) {
    vi.spyOn(dataManager, 'getInitClientData').mockReturnValue({
        actionDetailMap: {
            [ZONE]: {
                name: 'Zone Z',
                combatZoneInfo: {
                    fightInfo: {
                        randomSpawnInfo: {
                            maxSpawnCount,
                            spawns: [{ combatMonsterHrid: '/monsters/slime' }, { combatMonsterHrid: '/monsters/ooze' }],
                        },
                        bossSpawns: [],
                    },
                },
            },
        },
    });
    vi.spyOn(dataManager, 'getMonsterHridFromName').mockImplementation((n) => `/monsters/${n.toLowerCase()}`);
    vi.spyOn(taskProfitDisplay, 'parseTaskData').mockImplementation((node) => ({
        description: `Defeat - ${node.dataset.name}`,
        quantity: Number(node.dataset.quantity),
        currentProgress: Number(node.dataset.progress),
    }));
}

afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
});

describe('zone summary line', () => {
    test('sums duplicate tasks per monster and names the slowest', () => {
        stubGame();
        const text = renderSummary(
            [
                ['Slime', 100, 50],
                ['Ooze', 400, 100],
                ['Ooze', 400, 100],
            ],
            { deaths: { '/monsters/slime': 100, '/monsters/ooze': 100 }, encounters: 40 }
        );
        // ooze: 600 remaining / 100 per hour = 6h, 240 fights on average at 40 fights an hour.
        // The line quotes the 90% quantile of that instead (the default coverage)
        const fights = fightsForKillConfidence({ killsNeeded: 600, killsPerFight: 2.5, confidencePercent: 90 });
        expect(fights).toBeGreaterThan(240);
        const seconds = Math.round((fights / 40) * 3600);
        expect(text).toBe(`Zone Z: ~${fights} fights (90%) | ${timeReadable(seconds)} (bottleneck: Ooze ×2)`);
    });

    test('says so when the slowest monster is never killed', () => {
        stubGame();
        const text = renderSummary(
            [
                ['Slime', 100, 0],
                ['Ooze', 100, 0],
            ],
            { deaths: { '/monsters/slime': 100 }, encounters: 40 }
        );
        expect(text).toBe('Zone Z: ??? (no kills for Ooze in sim)');
    });

    test('falls back to summed deaths when the sim has no encounter count', () => {
        stubGame();
        const text = renderSummary(
            [
                ['Slime', 100, 0],
                ['Ooze', 50, 0],
            ],
            { deaths: { '/monsters/slime': 100, '/monsters/ooze': 50 } }
        );
        // slime 1h is the bottleneck; fights/hour = 150, so 2/3 of a slime a fight
        const fights = fightsForKillConfidence({ killsNeeded: 100, killsPerFight: 100 / 150, confidencePercent: 90 });
        const seconds = Math.round((fights / 150) * 3600);
        expect(text).toBe(`Zone Z: ~${fights} fights (90%) | ${timeReadable(seconds)} (bottleneck: Slime)`);
    });
});

describe('zone summary coverage', () => {
    const board = [
        ['Slime', 100, 0],
        ['Ooze', 30, 0],
    ];
    const sim = { deaths: { '/monsters/slime': 100, '/monsters/ooze': 10 }, encounters: 40 };

    test('the chosen coverage sets the figure, and the median is on hover', () => {
        stubGame({ maxSpawnCount: 1 });
        setPercent('95');
        const line = renderSummaryLine(board, sim);
        // Ooze: 30 kills at a quarter of a kill a fight, one slot a fight
        const p95 = fightsForKillConfidence({
            killsNeeded: 30,
            killsPerFight: 0.25,
            slotsPerFight: 1,
            confidencePercent: 95,
        });
        const median = fightsForKillConfidence({
            killsNeeded: 30,
            killsPerFight: 0.25,
            slotsPerFight: 1,
            confidencePercent: 50,
        });
        expect(line.textContent).toContain(`~${p95} fights (95%) | ${timeReadable(Math.round((p95 / 40) * 3600))}`);
        const hint = line.querySelector('.mwi-zone-estimate-hint');
        expect(hint.title).toBe(
            `Planning for 95% confidence. Median (50%): ~${median} fights | ${timeReadable(Math.round((median / 40) * 3600))}`
        );
    });

    test('at the median there is no hover hint', () => {
        stubGame({ maxSpawnCount: 1 });
        setPercent('50');
        const line = renderSummaryLine(board, sim);
        expect(line.textContent).toContain('fights (50%)');
        expect(line.querySelector('.mwi-zone-estimate-hint')).toBeNull();
    });

    test('an unrecognized setting value reads as 90%', () => {
        stubGame({ maxSpawnCount: 1 });
        setPercent('42');
        expect(renderSummary(board, sim)).toContain('fights (90%)');
    });

    test('a boss bottleneck quotes the plain mean: its kills are not luck', () => {
        stubGame({ maxSpawnCount: 1 });
        vi.spyOn(dataManager, 'isBossMonster').mockImplementation((hrid) => hrid === '/monsters/ooze');
        const line = renderSummaryLine(board, sim);
        // Ooze: 30 / 10 an hour = 3h, 120 fights
        expect(line.textContent).toBe(`Zone Z: ~120 fights | ${timeReadable(10800)} (bottleneck: Ooze)`);
        expect(line.querySelector('.mwi-zone-estimate-hint')).toBeNull();
    });
});
