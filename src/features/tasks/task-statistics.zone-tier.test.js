/** @vitest-environment happy-dom */

/**
 * A Zone Task Progress row click opens the zone at the tier the row simulated and never changes the
 * game's own Difficulty pick (`keepTier`), and never fills less than the figure the row quotes.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => {
    const listeners = new Map();
    return {
        listeners,
        tier: 0,
        compute: vi.fn(),
        dm: {
            characterQuests: [],
            characterData: { characterInfo: null },
            on: (event, fn) => {
                if (!listeners.has(event)) listeners.set(event, new Set());
                listeners.get(event).add(fn);
            },
            off: (event, fn) => listeners.get(event)?.delete(fn),
            emit: (event, data) => {
                for (const fn of Array.from(listeners.get(event) || [])) fn(data);
            },
            getInitClientData: () => ({ actionDetailMap: {}, combatMonsterDetailMap: {} }),
        },
    };
});

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: (_key, fallback) => fallback,
        onSettingChange: () => {},
        COLOR_TEXT_PRIMARY: '#fff',
        COLOR_TEXT_SECONDARY: '#888',
        COLOR_ACCENT: '#0af',
        COLOR_PROFIT: '#0f0',
        COLOR_LOSS: '#f00',
        COLOR_ESSENCE: '#a0f',
        COLOR_GOLD: '#fa0',
    },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {}, onReady: () => () => {} } }));
vi.mock('../../api/marketplace.js', () => ({ default: {} }));
vi.mock('../../core/data-manager.js', () => ({ default: h.dm }));
vi.mock('./task-profit-calculator.js', () => ({
    formatTokenFigure: (v) => String(v),
    valueTaskRewards: () => 0,
    calculateTaskTokenValue: () => ({}),
    calculateTaskRewardValue: () => ({ total: 0, breakdown: {} }),
    calculateTaskProfit: async () => ({ action: null }),
    getCowbellValue: () => 0,
    valueOfRewardItem: () => null,
}));
vi.mock('./task-profit-display.js', () => ({ calculateTaskCompletionSeconds: () => 3600 }));
vi.mock('./task-completion-tracker.js', () => ({
    default: { summary: async () => null, getCompletions: async () => [], initialize: () => {} },
}));
vi.mock('./task-reroll-tracker.js', () => ({
    default: {
        taskRerollData: new Map(),
        loadHistory: async () => [],
        calculateGoldSpent: () => 0,
        calculateCowbellSpent: () => 0,
    },
}));
vi.mock('./task-slot-forecast.js', async (importOriginal) => ({
    ...(await importOriginal()),
    forecastTaskSlots: () => ({}),
}));
vi.mock('./task-zone-progress.js', () => ({ computeAllZoneProgress: h.compute }));
vi.mock('../../utils/combat-zone-open.js', () => ({ openCombatZoneAtTier: vi.fn(async () => ({ opened: true })) }));
const { default: taskStatistics } = await import('./task-statistics.js');

const ZONE = '/actions/combat/gobo_planet';

beforeEach(() => {
    h.tier = 0;
    h.listeners.clear();
    h.compute.mockReset();
    h.compute.mockResolvedValue([]);
    taskStatistics.overlay = document.createElement('div');
});

afterEach(() => {
    taskStatistics.closePopup();
    taskStatistics.overlay = null;
    vi.restoreAllMocks();
});

describe("a row click and the game's own Difficulty pick", () => {
    test('opens at the tier the row simulated with keepTier, so the game pick is never written', async () => {
        const { openCombatZoneAtTier } = await import('../../utils/combat-zone-open.js');
        openCombatZoneAtTier.mockClear();
        await taskStatistics._openZoneRow({ zoneHrid: ZONE, tier: 2, fightsNeeded: 100 }, true);
        expect(openCombatZoneAtTier).toHaveBeenCalledWith(ZONE, 2, { count: expect.any(Number), keepTier: true });
    });

    test('a row with no finite count opens with no count, still keepTier', async () => {
        const { openCombatZoneAtTier } = await import('../../utils/combat-zone-open.js');
        openCombatZoneAtTier.mockClear();
        await taskStatistics._openZoneRow({ zoneHrid: ZONE, tier: 2 }, false);
        expect(openCombatZoneAtTier).toHaveBeenCalledWith(ZONE, 2, { keepTier: true });
    });

    test('a row with no tier opens T0', async () => {
        const { openCombatZoneAtTier } = await import('../../utils/combat-zone-open.js');
        openCombatZoneAtTier.mockClear();
        await taskStatistics._openZoneRow({ zoneHrid: ZONE }, false);
        expect(openCombatZoneAtTier).toHaveBeenCalledWith(ZONE, 0, { keepTier: true });
    });
});

describe('a row click fills at least the figure the row quotes', () => {
    test('at the median the padded count would be smaller; the quoted figure is the floor', () => {
        const zone = {
            fightsNeeded: 100,
            estimate: { fightsNeeded: 400, hoursNeeded: 4, percent: 50 },
            monsterThresholds: [{ meanFights: 100, killsNeeded: 10, killsPerFight: 0.1, slotsPerFight: null }],
        };
        expect(taskStatistics.paddedZoneFightCount(zone)).toBeGreaterThanOrEqual(400);
    });
});
