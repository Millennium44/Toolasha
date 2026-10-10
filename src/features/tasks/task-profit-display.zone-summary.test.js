/**
 * @vitest-environment happy-dom
 *
 * The combat task card's zone summary line, unchanged by the bottleneck extraction
 * into task-zone-bottleneck.js.
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

import dataManager from '../../core/data-manager.js';
import taskProfitDisplay from './task-profit-display.js';
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
    return [...container.children].map((c) => c.textContent).find((t) => t.startsWith('Zone Z'));
}

function stubGame() {
    vi.spyOn(dataManager, 'getInitClientData').mockReturnValue({
        actionDetailMap: {
            [ZONE]: {
                name: 'Zone Z',
                combatZoneInfo: {
                    fightInfo: {
                        randomSpawnInfo: {
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
        // ooze: 600 remaining / 100 per hour = 6h; 40 fights/hour * 6h = 240 fights
        expect(text).toBe(`Zone Z: ~240 fights | ${timeReadable(21600)} (bottleneck: Ooze ×2)`);
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
        // slime 1h is the bottleneck; fights/hour = 150
        expect(text).toBe(`Zone Z: ~150 fights | ${timeReadable(3600)} (bottleneck: Slime)`);
    });
});
