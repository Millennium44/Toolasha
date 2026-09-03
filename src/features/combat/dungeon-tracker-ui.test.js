/**
 * @vitest-environment happy-dom
 *
 * What the dungeon tracker panel puts on screen when it does not have a whole
 * run behind it.
 *
 * Two states earn their own tests. A page loaded part-way through a dungeon has
 * a dungeon but no run — nothing is tracked until the next wave, some
 * thirty-five seconds away — and the panel names it provisionally rather than
 * sitting blank. A run picked up part-way through has figures, but its clock
 * started when we noticed it, not when the run began; the panel must never
 * present that number as the run's duration.
 *
 * The sub-modules (chart, history, interactions, ROI board) are stubs: this is
 * about the header the run state drives, not about what the collapsible
 * sections draw.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const world = vi.hoisted(() => ({
    currentRun: null,
    pending: null,
    settings: { dungeonTrackerUI: true, dungeonPace: true },
}));

vi.mock('./dungeon-tracker.js', () => ({
    default: {
        getCurrentRun: () => world.currentRun,
        getPendingDungeon: () => world.pending,
        onUpdate: vi.fn(),
        offUpdate: vi.fn(),
    },
}));
vi.mock('./dungeon-tracker-chat-annotations.js', () => ({ default: { annotateAllMessages: vi.fn() } }));
vi.mock('./dungeon-tracker-ui-state.js', () => ({
    default: {
        load: vi.fn(async () => {}),
        updatePosition: vi.fn(),
        isKeysExpanded: false,
        isChartExpanded: false,
        isRoiExpanded: false,
        expandedGroups: new Set(),
        groupBy: 'dungeon',
        filterDungeon: 'all',
        filterTier: 'all',
        filterTeam: 'all',
        filterCharacter: 'all',
        hasActiveFilters: () => false,
    },
}));

/** The collapsible sections: constructed and called, but drawing nothing here. */
const stubModule = vi.hoisted(() => () => ({
    default: class {
        render = vi.fn(async () => {});
        update = vi.fn(async () => {});
        setupAll = vi.fn();
        applyInitialStates = vi.fn();
        onDelete = vi.fn();
    },
}));
vi.mock('./dungeon-tracker-ui-chart.js', stubModule);
vi.mock('./dungeon-tracker-ui-history.js', stubModule);
vi.mock('./dungeon-tracker-ui-interactions.js', stubModule);
vi.mock('./dungeon-roi-board-ui.js', stubModule);

vi.mock('./dungeon-tracker-storage.js', () => ({
    default: {
        getAllRuns: vi.fn(async () => []),
        getStats: vi.fn(async () => ({ totalRuns: 0, avgTime: 0, fastestTime: 0, slowestTime: 0, avgWaveTime: 0 })),
        getDungeonInfo: () => null,
    },
    filterRunsForCharacter: (runs) => runs,
    currentCharacter: () => ({ id: 'market123', name: 'Marketcow' }),
}));
vi.mock('./dungeon-pace.js', () => ({
    historyAvgWaveMs: () => null,
    historyCumulativeProfile: () => [],
    splitPacePercent: () => null,
    pacePercent: () => null,
    paceChip: () => null,
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        characterData: { character: { name: 'Marketcow' } },
        on: vi.fn(),
        off: vi.fn(),
    },
}));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: (key) => world.settings[key] },
}));
vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: vi.fn(),
    unregisterFloatingPanel: vi.fn(),
}));
vi.mock('../../utils/command-registry.js', () => ({ registerCommand: vi.fn(), unregisterCommand: vi.fn() }));

const ui = (await import('./dungeon-tracker-ui.js')).default;

/** A live run as `getCurrentRun` hands it over. */
function run(overrides = {}) {
    return {
        dungeonName: 'Pirate Cove',
        tier: 1,
        currentWave: 48,
        maxWaves: 65,
        wavesCompleted: 0,
        totalElapsed: 90_000,
        currentWaveElapsed: 5_000,
        avgWaveTime: 0,
        fastestWave: 0,
        slowestWave: 0,
        waveTimes: [],
        estimatedTimeRemaining: 0,
        keyCountsMap: {},
        hibernationDetected: false,
        joinedMidRun: false,
        joinedAtWave: null,
        elapsedIsSinceNoticed: false,
        ...overrides,
    };
}

const text = (id) => ui.container.querySelector(id)?.textContent.trim();
const titleOf = (id) => ui.container.querySelector(id)?.title;

beforeEach(async () => {
    document.body.innerHTML = '';
    world.currentRun = null;
    world.pending = null;
    ui.isInitialized = false;
    ui.container = null;
    if (ui.updateInterval) clearInterval(ui.updateInterval);
    await ui.initialize();
});

describe('the provisional card', () => {
    test('a dungeon running with no run behind it is named, with every figure blank', async () => {
        world.pending = { dungeonHrid: '/actions/combat/pirate_cove', dungeonName: 'Pirate Cove', tier: 1 };

        ui.dungeonUpdateHandler(null, null);

        expect(ui.container.style.display).toBe('block');
        expect(text('#mwi-dt-dungeon-name')).toBe('Pirate Cove (T1)');
        expect(text('#mwi-dt-wave-counter')).toBe('waiting for next wave');
        // No run, so no elapsed and no progress — blanks, not guesses
        expect(text('#mwi-dt-current-time')).toBe('--:--');
        expect(ui.container.querySelector('#mwi-dt-progress-bar').style.width).toBe('0%');
        expect(text('#mwi-dt-progress-text')).toBe('');
    });

    test('a tierless dungeon is named without a tier', () => {
        world.pending = { dungeonHrid: '/actions/combat/pirate_cove', dungeonName: 'Pirate Cove', tier: null };
        ui.dungeonUpdateHandler(null, null);
        expect(text('#mwi-dt-dungeon-name')).toBe('Pirate Cove');
    });

    test('no run and no pending dungeon hides the panel, as before', () => {
        ui.dungeonUpdateHandler(null, null);
        expect(ui.container.style.display).toBe('none');
    });
});

describe('a run joined part-way through', () => {
    test('the panel says where it was picked up and refuses to call the clock a duration', async () => {
        await ui.update(run({ joinedMidRun: true, joinedAtWave: 48, elapsedIsSinceNoticed: true }), false);

        expect(text('#mwi-dt-dungeon-name')).toBe('Pirate Cove (T1) · joined W48');
        // The figure is still shown — it is true, it is just not the run's length
        expect(text('#mwi-dt-time-label')).toBe('Watched:');
        expect(titleOf('#mwi-dt-time-label')).toContain('not the run');
        expect(titleOf('#mwi-dt-time-label')).toContain('wave 48');
        expect(text('#mwi-dt-current-time')).toBe('01:30');
        expect(text('#mwi-dt-wave-counter')).toBe('Wave 48/65');
    });

    test('a whole run is labelled as elapsed, exactly as before', async () => {
        await ui.update(run({ currentWave: 3, wavesCompleted: 2 }), false);

        expect(text('#mwi-dt-dungeon-name')).toBe('Pirate Cove (T1)');
        expect(text('#mwi-dt-time-label')).toBe('Elapsed:');
        expect(titleOf('#mwi-dt-time-label')).toBe('Time since dungeon started');
    });

    test('the pace chip stays down: two waves timed at wave 48 are not a run’s first two', async () => {
        await ui.update(
            run({ joinedMidRun: true, joinedAtWave: 48, elapsedIsSinceNoticed: true, waveTimes: [3000, 4000] }),
            false
        );

        expect(ui.container.querySelector('#mwi-dt-pace').style.display).toBe('none');
    });
});
