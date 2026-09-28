/**
 * @vitest-environment happy-dom
 *
 * The Dungeon/Team filters both narrow the inline and pop-out charts, but the
 * Tier filter used to be silently ignored by both — the dropdown could read
 * "T1" while the plotted points and the "Avg" line mixed in every other
 * tier's runs. These tests pin the tier filter into both render paths.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./dungeon-tracker-storage.js', () => ({
    default: { getAllRuns: vi.fn(async () => []) },
    filterRunsForCharacter: (runs) => runs,
    currentCharacter: () => ({ id: 'char1', name: 'Marketcow' }),
    minMaxOf: (numbers) => {
        let min = Infinity;
        let max = -Infinity;
        for (const value of numbers) {
            if (value < min) min = value;
            if (value > max) max = value;
        }
        return { min, max };
    },
}));
vi.mock('../../utils/panel-z-index.js', () => ({ PANEL_Z_CAP: 100 }));

const { default: DungeonTrackerUIChart } = await import('./dungeon-tracker-ui-chart.js');
const { default: dungeonTrackerStorage } = await import('./dungeon-tracker-storage.js');

/** A fresh panel state, the shape dungeon-tracker-ui-state.js hands over. */
function freshState() {
    return {
        filterDungeon: 'all',
        filterTier: 'all',
        filterTeam: 'all',
        filterCharacter: 'all',
    };
}

/** A stored run at a given tier, enough of one for the chart to plot a point. */
function run(tier, minutes) {
    return {
        recordedBy: 'char1',
        teamKey: 'solo',
        dungeonName: 'Chimerical Den',
        tier,
        duration: minutes * 60_000,
        timestamp: '2026-08-04T10:00:00.000Z',
    };
}

/** Every Chart.js instance ever constructed in a test, with the config it was built with. */
const built = [];

beforeEach(() => {
    document.body.innerHTML = '<canvas id="mwi-dt-chart-canvas"></canvas>';
    built.length = 0;
    globalThis.Chart = class {
        constructor(ctx, cfg) {
            this.cfg = cfg;
            this.destroyed = false;
            built.push(this);
        }
        destroy() {
            this.destroyed = true;
        }
    };
    HTMLCanvasElement.prototype.getContext = () => ({});
});

afterEach(() => {
    delete globalThis.Chart;
    document.body.innerHTML = '';
});

describe('the inline chart', () => {
    test('a tier filter excludes runs of other tiers from the plotted labels', async () => {
        dungeonTrackerStorage.getAllRuns.mockResolvedValue([run(1, 10), run(2, 20), run(1, 12)]);
        const state = freshState();
        state.filterTier = '1';
        const chart = new DungeonTrackerUIChart(state, (ms) => `${ms}ms`);

        await chart.render(document.body);

        expect(built).toHaveLength(1);
        expect(built[0].cfg.data.labels).toEqual(['Run 1', 'Run 2']);
    });

    test('a specific tier excludes untiered runs too', async () => {
        dungeonTrackerStorage.getAllRuns.mockResolvedValue([run(1, 10), run(null, 20)]);
        const state = freshState();
        state.filterTier = '1';
        const chart = new DungeonTrackerUIChart(state, (ms) => `${ms}ms`);

        await chart.render(document.body);

        expect(built).toHaveLength(1);
        expect(built[0].cfg.data.labels).toEqual(['Run 1']);
    });

    test('"all" plots every tier, as before', async () => {
        dungeonTrackerStorage.getAllRuns.mockResolvedValue([run(1, 10), run(2, 20)]);
        const state = freshState();
        const chart = new DungeonTrackerUIChart(state, (ms) => `${ms}ms`);

        await chart.render(document.body);

        expect(built).toHaveLength(1);
        expect(built[0].cfg.data.labels).toEqual(['Run 1', 'Run 2']);
    });
});

describe('the pop-out chart', () => {
    test('a tier filter excludes runs of other tiers, matching the inline chart', async () => {
        dungeonTrackerStorage.getAllRuns.mockResolvedValue([run(1, 10), run(2, 20), run(1, 12)]);
        const state = freshState();
        state.filterTier = '1';
        const chart = new DungeonTrackerUIChart(state, (ms) => `${ms}ms`);
        const canvas = document.createElement('canvas');
        document.body.appendChild(canvas);

        await chart.renderModalChart(canvas);

        expect(built).toHaveLength(1);
        expect(built[0].cfg.data.labels).toEqual(['Run 1', 'Run 2']);
    });

    test('re-rendering an already-open modal (a scope change) replots at the new filter and destroys the old chart', async () => {
        // The dungeon tracker panel calls this again while the modal is still
        // open, on a filter-scope change — not just once at modal creation.
        dungeonTrackerStorage.getAllRuns.mockResolvedValue([run(1, 10), run(2, 20)]);
        const state = freshState();
        const chart = new DungeonTrackerUIChart(state, (ms) => `${ms}ms`);
        const canvas = document.createElement('canvas');
        document.body.appendChild(canvas);

        await chart.renderModalChart(canvas);
        const firstInstance = chart.modalChartInstance;
        expect(built[0].cfg.data.labels).toEqual(['Run 1', 'Run 2']);

        state.filterTier = '1';
        await chart.renderModalChart(canvas);

        expect(firstInstance.destroyed).toBe(true);
        expect(built).toHaveLength(2);
        expect(built[1].cfg.data.labels).toEqual(['Run 1']);
        expect(chart.modalChartInstance).toBe(built[1]);
    });
});

/** `count` runs, oldest to newest, with a duration in minutes that climbs by one per run. */
function manyRuns(count) {
    const runs = [];
    for (let i = 0; i < count; i++) {
        runs.push({
            recordedBy: 'char1',
            teamKey: 'solo',
            dungeonName: 'Chimerical Den',
            tier: 1,
            duration: (i + 1) * 60_000, // minutes: 1, 2, 3, ..., count
            timestamp: new Date(2020, 0, 1 + i).toISOString(),
        });
    }
    return runs;
}

describe('a run history large enough to make Chart.js lag gets its plotted points bounded', () => {
    test('50k runs plot at most 1000 points on the inline chart, one dataset per stat line', async () => {
        dungeonTrackerStorage.getAllRuns.mockResolvedValue(manyRuns(50_000));
        const state = freshState();
        const chart = new DungeonTrackerUIChart(state, (ms) => `${ms}ms`);

        await chart.render(document.body);

        expect(built).toHaveLength(1);
        const { labels, datasets } = built[0].cfg.data;
        expect(labels.length).toBeLessThanOrEqual(1000);
        for (const dataset of datasets) {
            expect(dataset.data.length).toBe(labels.length);
        }
    });

    test('50k runs plot at most 1000 points on the pop-out chart too', async () => {
        dungeonTrackerStorage.getAllRuns.mockResolvedValue(manyRuns(50_000));
        const state = freshState();
        const chart = new DungeonTrackerUIChart(state, (ms) => `${ms}ms`);
        const canvas = document.createElement('canvas');
        document.body.appendChild(canvas);

        await chart.renderModalChart(canvas);

        expect(built).toHaveLength(1);
        const { labels, datasets } = built[0].cfg.data;
        expect(labels.length).toBeLessThanOrEqual(1000);
        for (const dataset of datasets) {
            expect(dataset.data.length).toBe(labels.length);
        }
    });

    test('decimation keeps the first and last run exact, not bucket-averaged', async () => {
        dungeonTrackerStorage.getAllRuns.mockResolvedValue(manyRuns(50_000));
        const state = freshState();
        const chart = new DungeonTrackerUIChart(state, (ms) => `${ms}ms`);

        await chart.render(document.body);

        const { labels, datasets } = built[0].cfg.data;
        const runTimes = datasets.find((d) => d.label === 'Run Times').data;
        // Run 1 is 1 minute, Run 50000 is 50000 minutes — a bucket average
        // would blur both toward their neighbors.
        expect(labels[0]).toBe('Run 1');
        expect(runTimes[0]).toBe(1);
        expect(labels[labels.length - 1]).toBe('Run 50000');
        expect(runTimes[runTimes.length - 1]).toBe(50_000);
    });

    test('the Average/Fastest/Slowest lines are computed from the full 50k runs, not the decimated plot', async () => {
        dungeonTrackerStorage.getAllRuns.mockResolvedValue(manyRuns(50_000));
        const state = freshState();
        const chart = new DungeonTrackerUIChart(state, (ms) => `${ms}ms`);

        await chart.render(document.body);

        const { datasets } = built[0].cfg.data;
        const fullDurations = Array.from({ length: 50_000 }, (_, i) => i + 1);
        const expectedAvg = fullDurations.reduce((a, b) => a + b, 0) / fullDurations.length;

        expect(datasets.find((d) => d.label === 'Average').data[0]).toBeCloseTo(expectedAvg);
        expect(datasets.find((d) => d.label === 'Fastest').data[0]).toBe(1);
        expect(datasets.find((d) => d.label === 'Slowest').data[0]).toBe(50_000);
    });

    test('a run history under the bound is not decimated at all', async () => {
        dungeonTrackerStorage.getAllRuns.mockResolvedValue(manyRuns(500));
        const state = freshState();
        const chart = new DungeonTrackerUIChart(state, (ms) => `${ms}ms`);

        await chart.render(document.body);

        const { labels, datasets } = built[0].cfg.data;
        expect(labels.length).toBe(500);
        expect(datasets.find((d) => d.label === 'Run Times').data.length).toBe(500);
    });
});
