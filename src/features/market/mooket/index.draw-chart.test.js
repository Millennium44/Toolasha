/**
 * drawChart: what it hands Chart.js for grouped and ungrouped series, volume bars, the hidden Avg line,
 * and the existing-chart update path. Chart.js is faked; these are the options the real one would be given.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const source = vi.hoisted(() => ({ hasVolume: true }));

vi.mock('../../../core/storage.js', () => ({
    default: {
        ready: Promise.resolve(true),
        getJSON: async () => null,
        setJSON: async () => true,
        get: async () => null,
    },
}));
vi.mock('../../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => 'c1', getItemDetails: () => null, on: () => {}, off: () => {} },
}));
vi.mock('../../../core/config.js', () => ({ default: { getSetting: () => false, onSettingChange: () => {} } }));
vi.mock('../../../api/marketplace.js', () => ({ default: { on: () => {}, off: () => {}, marketData: {} } }));
vi.mock('../../../utils/cleanup-registry.js', () => ({
    createCleanupRegistry: () => ({
        registerCleanup: () => {},
        registerInterval: () => {},
        registerTimeout: () => {},
        registerListener: () => {},
        cleanupAll: () => {},
    }),
}));
vi.mock('../../../utils/dom-observer-helpers.js', () => ({ createMutationWatcher: () => () => {} }));
vi.mock('../../../utils/marketplace-tabs.js', () => ({
    navigateToMarketplace: () => {},
    insertTabInOrder: (container, tab) => container.appendChild(tab),
}));
vi.mock('../../../utils/mobile.js', () => ({ hasCoarsePointer: () => false }));
vi.mock('./market-price-store.js', () => ({
    default: { initialize: async () => {}, cleanup: () => {}, ingestSnapshot: () => {}, priceFor: () => null },
}));
vi.mock('./market-history-api.js', () => ({
    default: {
        connect: () => {},
        disconnect: () => {},
        fetchHistory: async () => [],
        cooldownRemainingMs: () => 0,
        currentSource: () => ({ key: 'mooket2', hasVolume: source.hasVolume, avgLabel: 'Avg' }),
    },
}));

const { default: panel } = await import('./index.js');
const { groupSeries } = await import('./market-history-data.js');

const NEWEST = 1_700_000_000;
const point = (t, over = {}) => ({ time: t, ask: 100, bid: 90, avg: 95, volume: 10, atAsk: 4, atBid: 6, ...over });
const series = (hours, over = () => ({})) => {
    const out = [];
    for (let t = NEWEST - hours * 3600; t <= NEWEST; t += 1200) out.push(point(t, over(t)));
    return out;
};

class FakeChart {
    constructor(canvas, config) {
        this.config = config;
        this.data = config.data;
        this.options = config.options;
        this.hidden = new Set();
        FakeChart.last = this;
    }
    isDatasetVisible(index) {
        return !this.hidden.has(index);
    }
    update() {}
    destroy() {}
}

beforeEach(() => {
    globalThis.Chart = FakeChart;
    FakeChart.last = null;
    source.hasVolume = true;
    panel.chart = null;
    panel.canvas = {};
    panel.savePrefs = vi.fn();
    panel.prefs = { days: 7, groupHours: 3, showAvg: false };
});

describe('drawChart', () => {
    test('grouped: straight lines, medians, no zeros for missing prices, bars on a hidden volume axis', () => {
        const input = series(72, (t) => (t > NEWEST - 3 * 3600 ? { ask: 0 } : {}));
        panel.drawChart(input);
        const { datasets } = FakeChart.last.data;
        const [ask, bid, avg, volume] = datasets;
        expect(ask.stepped).toBe(false);
        expect(ask.data.at(-1)).toBeNull();
        expect(bid.data.at(-1)).toBe(90);
        expect(ask.data.every((value) => value === null || value > 0)).toBe(true);
        expect(ask.borderColor).toBe('#f87171');
        expect(bid.borderColor).toBe('#4ade80');
        expect(bid.fill).toBe(0);
        expect(avg.hidden).toBe(true);
        expect(volume.type).toBe('bar');
        expect(FakeChart.last.options.scales.volume.display).toBe(false);
        expect(FakeChart.last.options.scales.volume.max).toBe(4 * Math.max(...volume.data));
        expect(FakeChart.last.options.scales.y.min).toBeLessThan(90);
    });

    test('hourly: every reading, stepped, same labels count as readings', () => {
        panel.prefs.groupHours = 1;
        const input = series(72);
        panel.drawChart(input);
        expect(FakeChart.last.data.datasets[0].stepped).toBe('before');
        expect(FakeChart.last.data.labels).toHaveLength(input.length);
    });

    test('1d range stays ungrouped whatever the select says', () => {
        panel.prefs.days = 1;
        const input = series(24);
        panel.drawChart(input);
        expect(FakeChart.last.data.labels).toHaveLength(input.length);
        expect(FakeChart.last.data.datasets[0].stepped).toBe('before');
    });

    test('a missing volume is a missing bar, and a source without volume gets no bars or reserved space', () => {
        panel.drawChart(series(72, () => ({ volume: null })));
        expect(FakeChart.last.data.datasets[3].data.every((value) => value === null)).toBe(true);
        expect(FakeChart.last.options.scales.volume.max).toBeUndefined();
        expect(FakeChart.last.options.scales.y.min).toBeUndefined();

        panel.chart = null;
        source.hasVolume = false;
        panel.drawChart(series(72));
        expect(FakeChart.last.data.datasets).toHaveLength(3);
        expect(FakeChart.last.options.scales.y.min).toBeUndefined();
    });

    test('an empty series draws without throwing', () => {
        expect(() => panel.drawChart([])).not.toThrow();
        expect(FakeChart.last.data.datasets[0].data).toEqual([]);
    });

    test('tooltip: grouped title is the window; hidden Avg is added to the body; labels say median', () => {
        const input = series(72);
        panel.drawChart(input);
        const chart = FakeChart.last;
        const callbacks = chart.options.plugins.tooltip.callbacks;
        const grouped = groupSeries(input, 3).series;
        const index = grouped.length - 1;
        expect(callbacks.title([{ dataIndex: index, label: 'x' }])).toMatch(/\d{2}:\d{2}-/);
        expect(callbacks.label({ dataset: { label: 'Ask', toolKey: 'ask' }, parsed: { y: 100 } })).toBe(
            'Ask (3-hour median): 100'
        );
        expect(callbacks.label({ dataset: { label: 'Volume', toolKey: 'volume' }, parsed: { y: 80 } })).toBe(
            'Volume (3-hour total): 80'
        );
        chart.hidden.add(2); // Avg's line is off: Chart.js leaves it out of the body, so the callback adds it
        expect(callbacks.afterBody([{ dataIndex: index }])).toBe('Avg (3-hour median): 95');
        chart.hidden.delete(2); // the player turned Avg on: the line shows it, the body must not repeat it
        expect(callbacks.afterBody([{ dataIndex: index }])).toBe('');
    });

    test('tooltip: ungrouped keeps the plain title and label', () => {
        panel.prefs.groupHours = 1;
        panel.drawChart(series(72));
        const callbacks = FakeChart.last.options.plugins.tooltip.callbacks;
        expect(callbacks.title([{ dataIndex: 0, label: '11/02 14h' }])).toBe('11/02 14h');
        expect(callbacks.label({ dataset: { label: 'Ask', toolKey: 'ask' }, parsed: { y: 100 } })).toBe('Ask: 100');
    });

    test('legend: clicking Avg is remembered; other entries are not saved', () => {
        panel.drawChart(series(72));
        const chart = FakeChart.last;
        const defaultClick = vi.fn();
        globalThis.Chart.defaults = { plugins: { legend: { onClick: defaultClick } } };
        const legend = { chart };
        chart.options.plugins.legend.onClick({}, { datasetIndex: 2 }, legend);
        expect(defaultClick).toHaveBeenCalled();
        expect(panel.prefs.showAvg).toBe(true); // visible after the (faked) toggle
        expect(panel.savePrefs).toHaveBeenCalledTimes(1);
        chart.options.plugins.legend.onClick({}, { datasetIndex: 0 }, legend);
        expect(panel.savePrefs).toHaveBeenCalledTimes(1);
    });

    test('redraw on an existing chart refreshes data-dependent options and keeps a legend toggle', () => {
        panel.drawChart(series(72));
        const chart = FakeChart.last;
        chart.hidden.add(0); // the player hid Ask
        chart.hidden.add(3); // and Volume
        panel.drawChart(series(72, () => ({ volume: 50 })));
        expect(FakeChart.last).toBe(chart); // updated, not rebuilt
        expect(chart.data.datasets[0].hidden).toBe(true);
        expect(chart.data.datasets[1].hidden).toBe(false);
        expect(chart.data.datasets[3].hidden).toBe(true);
        expect(chart.data.datasets[2].hidden).toBe(true); // Avg from prefs
        expect(chart.options.scales.volume.max).toBe(4 * Math.max(...chart.data.datasets[3].data));
        expect(chart.options.scales.volume.max).toBeGreaterThan(200); // summed per 3-hour bucket

        panel.prefs.groupHours = 1;
        panel.drawChart(series(72));
        expect(chart.data.datasets[0].stepped).toBe('before');
        panel.prefs.showAvg = true;
        panel.drawChart(series(72));
        expect(chart.data.datasets[2].hidden).toBe(false);
    });
});
