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
