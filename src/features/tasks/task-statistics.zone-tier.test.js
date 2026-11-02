/** @vitest-environment happy-dom */

/**
 * The Zone Task Progress rows follow the zone tiers: opened before the remembered tiers loaded, they
 * were simulated at T0 and stayed there. They redraw when a zone's tier changes or the record arrives,
 * stop listening when the popup closes, and a row's click never fills less than the figure it quotes.
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
vi.mock('../../utils/zone-tier-memory.js', async (importOriginal) => ({
    ...(await importOriginal()),
    resolveZoneTier: vi.fn(() => ({ tier: h.tier, known: true, source: 'remembered', pending: false })),
}));

const { default: taskStatistics } = await import('./task-statistics.js');
const { ZONE_TIER_MEMORY_EVENT } = await import('../../utils/zone-tier-memory.js');

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

function watch() {
    const section = document.createElement('div');
    const start = vi.spyOn(taskStatistics, 'startZoneProgress').mockImplementation(async () => {});
    taskStatistics._watchZoneTiers(section, '#fff');
    return { section, start };
}

describe('zone rows follow the zone tiers', () => {
    test('a row drawn at T0 is redrawn when the zone turns out to be remembered at T3', () => {
        const { section, start } = watch();
        taskStatistics._zoneRows = [{ zoneHrid: ZONE, tier: 0 }];

        h.tier = 3;
        h.dm.emit(ZONE_TIER_MEMORY_EVENT, {});

        expect(start).toHaveBeenCalledTimes(1);
        expect(start).toHaveBeenCalledWith(section, '#fff');
    });

    test('rows already at the right tier are left alone', () => {
        const { start } = watch();
        taskStatistics._zoneRows = [{ zoneHrid: ZONE, tier: 3 }];
        h.tier = 3;
        h.dm.emit(ZONE_TIER_MEMORY_EVENT, {});
        expect(start).not.toHaveBeenCalled();
    });

    test('a run still computing is restarted, since its first zone may have started at T0', () => {
        const { start } = watch();
        taskStatistics._zoneRows = [];
        taskStatistics.zoneRun = { cancelled: false };
        h.dm.emit(ZONE_TIER_MEMORY_EVENT, {});
        expect(start).toHaveBeenCalledTimes(1);
        taskStatistics.zoneRun = null;
    });

    test('closing the popup removes the listener', () => {
        const { start } = watch();
        taskStatistics._zoneRows = [{ zoneHrid: ZONE, tier: 0 }];
        taskStatistics.closePopup();
        expect(h.listeners.get(ZONE_TIER_MEMORY_EVENT)?.size ?? 0).toBe(0);

        h.tier = 3;
        h.dm.emit(ZONE_TIER_MEMORY_EVENT, {});
        expect(start).not.toHaveBeenCalled();
    });

    test('watching twice adds one listener', () => {
        watch();
        taskStatistics._watchZoneTiers(document.createElement('div'), '#fff');
        expect(h.listeners.get(ZONE_TIER_MEMORY_EVENT).size).toBe(1);
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
