/** @vitest-environment happy-dom */

/**
 * The Zone Task Progress section of the Task Statistics popup: opt-in, filled in
 * after the popup is up, and stopped when the popup closes.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
    enabled: true,
    compute: vi.fn(),
    openZone: vi.fn(async () => ({ opened: true })),
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => (key === 'taskStatistics_zoneProgress' ? h.enabled : true),
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
vi.mock('../../core/data-manager.js', () => ({
    default: {
        characterQuests: [],
        characterData: { characterInfo: null },
        on: () => {},
        off: () => {},
        getInitClientData: () => ({ actionDetailMap: {}, combatMonsterDetailMap: {} }),
    },
}));
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
vi.mock('../../utils/combat-zone-open.js', () => ({ openCombatZoneAtTier: h.openZone }));

const { default: taskStatistics } = await import('./task-statistics.js');

let statsData;

const row = (over = {}) => ({
    zoneHrid: '/actions/combat/zone_a',
    zoneName: 'Zone A',
    tier: 2,
    hoursNeeded: 2,
    fightsNeeded: 120,
    bottleneckHrid: '/monsters/ooze',
    bottleneckName: 'Ooze',
    taskCount: 1,
    shared: false,
    ...over,
});

const popupText = () => document.body.textContent;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
    statsData = await taskStatistics.calculateAllStatistics();
    h.enabled = true;
    h.compute.mockReset();
    h.openZone.mockClear();
    document.body.innerHTML = '';
    taskStatistics.overlay = null;
    taskStatistics.zoneRun = null;
});

afterEach(() => {
    taskStatistics.closePopup();
});

describe('Zone Task Progress section', () => {
    test('is absent, and nothing is computed, when the setting is off', async () => {
        h.enabled = false;
        taskStatistics.createPopup(statsData);
        await flush();
        expect(popupText()).not.toContain('Zone Task Progress');
        expect(h.compute).not.toHaveBeenCalled();
    });

    test('shows a computing state, then the zone rows', async () => {
        let resolveRun;
        h.compute.mockReturnValue(new Promise((resolve) => (resolveRun = resolve)));
        taskStatistics.createPopup(statsData);

        expect(popupText()).toContain('Zone Task Progress');
        expect(popupText()).toContain('Computing…');

        resolveRun([row()]);
        await flush();

        expect(popupText()).not.toContain('Computing…');
        expect(popupText()).toContain('Zone A');
        expect(popupText()).toContain('~120 fights');
        expect(popupText()).toContain('bottleneck: Ooze');
    });

    test('draws zones as they finish, keeping the computing note until done', async () => {
        let resolveRun;
        h.compute.mockImplementation(({ onProgress }) => {
            onProgress([row()]);
            return new Promise((resolve) => (resolveRun = resolve));
        });
        taskStatistics.createPopup(statsData);
        await flush();
        expect(popupText()).toContain('Zone A');
        expect(popupText()).toContain('Computing…');

        resolveRun([row(), row({ zoneHrid: '/actions/combat/zone_b', zoneName: 'Zone B' })]);
        await flush();
        expect(popupText()).toContain('Zone B');
        expect(popupText()).not.toContain('Computing…');
    });

    test('says so when there are no combat tasks', async () => {
        h.compute.mockResolvedValue([]);
        taskStatistics.createPopup(statsData);
        await flush();
        expect(popupText()).toContain('No active combat tasks');
    });

    test('failed zones are reported, and an all-failed run never reads as no combat tasks', async () => {
        h.compute.mockResolvedValue([
            { zoneHrid: '/actions/combat/zone_a', zoneName: 'Zone A', tier: 0, failed: true, interrupted: false },
            { zoneHrid: '/actions/combat/zone_b', zoneName: 'Zone B', tier: 0, failed: true, interrupted: false },
        ]);
        taskStatistics.createPopup(statsData);
        await flush();
        expect(popupText()).toContain('2 zones could not be simulated (try again)');
        expect(popupText()).not.toContain('No active combat tasks');

        taskStatistics.closePopup();
        h.compute.mockResolvedValue([row(), { zoneHrid: 'z', zoneName: 'Z', failed: true, interrupted: true }]);
        taskStatistics.createPopup(statsData);
        await flush();
        expect(popupText()).toContain('Zone A');
        expect(popupText()).toContain('1 zone not simulated (another simulation interrupted this one');
    });

    test('a zone that can never be cleared reads ???', async () => {
        h.compute.mockResolvedValue([row({ hoursNeeded: Infinity, fightsNeeded: Infinity })]);
        taskStatistics.createPopup(statsData);
        await flush();
        expect(popupText()).toContain('??? (no kills for Ooze in sim)');
    });

    test('clicking a zone closes the popup and opens the zone at its simulated tier with the fight count', async () => {
        h.compute.mockResolvedValue([row()]);
        taskStatistics.createPopup(statsData);
        await flush();

        const zoneRow = [...document.querySelectorAll('div')].find((d) => d.title === 'Open this zone');
        zoneRow.onclick();

        expect(taskStatistics.overlay).toBe(null);
        expect(h.openZone).toHaveBeenCalledWith('/actions/combat/zone_a', 2, { count: 126 }); // 120 plus the default 5% flat buffer (no kill rate on this row)
    });

    test('clicking a stochastic zone pads the fight count with the Go flow settings', async () => {
        h.compute.mockResolvedValue([
            row({ fightsNeeded: 200, killsNeeded: 100, killsPerFight: 0.5, slotsPerFight: 3 }),
        ]);
        taskStatistics.createPopup(statsData);
        await flush();

        [...document.querySelectorAll('div')].find((d) => d.title === 'Open this zone').onclick();

        const { count } = h.openZone.mock.calls[0][2];
        expect(count).toBeGreaterThan(200);
    });

    test('closing the popup mid-compute cancels the run and draws nothing afterwards', async () => {
        let resolveRun;
        let isCancelled;
        h.compute.mockImplementation((options) => {
            isCancelled = options.isCancelled;
            return new Promise((resolve) => (resolveRun = resolve));
        });
        taskStatistics.createPopup(statsData);
        expect(isCancelled()).toBe(false);

        taskStatistics.closePopup();
        expect(isCancelled()).toBe(true);

        resolveRun(null);
        await flush();
        expect(document.body.textContent).toBe('');
        expect(taskStatistics.zoneRun).toBe(null);
    });

    test('a run that throws shows an error row instead of leaving the popup computing', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        h.compute.mockRejectedValue(new Error('boom'));
        taskStatistics.createPopup(statsData);
        await flush();
        expect(popupText()).toContain('Could not compute');
        expect(popupText()).not.toContain('Computing…');
    });

    test('notes that shared monsters count toward each zone only when some row is shared', async () => {
        h.compute.mockResolvedValue([row({ shared: true })]);
        taskStatistics.createPopup(statsData);
        await flush();
        expect(popupText()).toContain('counts toward each of those zones');

        taskStatistics.closePopup();
        h.compute.mockResolvedValue([row()]);
        taskStatistics.createPopup(statsData);
        await flush();
        expect(popupText()).not.toContain('counts toward each of those zones');
    });
});
