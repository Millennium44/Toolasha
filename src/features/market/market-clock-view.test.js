/**
 * @vitest-environment happy-dom
 *
 * The "When it trades" section: what it fetches, what it says when it cannot,
 * and that a fetched history draws without a hole in it.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
    enabled: true,
    source: { key: 'mooket2', label: 'mooket II (Q7)', host: 'x', hasVolume: true, avgLabel: 'Avg' },
    currentSource: () => apiMock.source,
    fetchHistory: vi.fn(async () => []),
    cooldownRemainingMs: vi.fn(() => 0),
}));

vi.mock('./mooket/market-history-api.js', () => ({ default: apiMock }));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: (key, fallback) => fallback,
    },
}));

const { MarketClockPanel, hourLabel, formatDeviation } = await import('./market-clock-view.js');
const { MIN_HOUR_SAMPLES } = await import('./market-clock-stats.js');

/** Hourly mooket II rows over `days` local days, starting Monday 2026-06-01 */
function hourlyRows(days, make = () => ({})) {
    const rows = [];
    for (let d = 0; d < days; d += 1) {
        for (let h = 0; h < 24; h += 1) {
            const date = new Date(2026, 5, 1 + d, h, 6);
            rows.push({ time: date.getTime() / 1000, a: 1000, b: 990, p: 995, v: 100, ...make(d, h, date) });
        }
    }
    return rows;
}

const ITEMS = [
    { itemHrid: '/items/cheese', enhancementLevel: 0, name: 'Cheese' },
    { itemHrid: '/items/holy_sword', enhancementLevel: 10, name: 'Holy Sword' },
];

let panel = null;

function mount(options = {}) {
    panel = new MarketClockPanel({ items: ITEMS, ...options });
    document.body.appendChild(panel.element);
    return panel;
}

const text = () => panel.element.textContent;

beforeEach(() => {
    apiMock.enabled = true;
    apiMock.source = { key: 'mooket2', label: 'mooket II (Q7)', host: 'x', hasVolume: true, avgLabel: 'Avg' };
    apiMock.fetchHistory.mockReset();
    apiMock.fetchHistory.mockImplementation(async () => []);
    apiMock.cooldownRemainingMs.mockReset();
    apiMock.cooldownRemainingMs.mockImplementation(() => 0);
});

afterEach(() => {
    panel?.destroy();
    panel = null;
});

describe('labels', () => {
    test('hours follow the clock setting', () => {
        expect(hourLabel(0, false)).toBe('00:00');
        expect(hourLabel(14, false)).toBe('14:00');
        expect(hourLabel(0, true)).toBe('12 AM');
        expect(hourLabel(13, true)).toBe('1 PM');
    });

    test('deviations are signed percentages, and a rounding speck is zero', () => {
        expect(formatDeviation(-0.0123)).toBe('-1.2%');
        expect(formatDeviation(0.004)).toBe('+0.4%');
        expect(formatDeviation(-0.0001)).toBe('0.0%');
    });
});

describe('fetching', () => {
    test('with pooled history off it says so and asks nobody', async () => {
        apiMock.enabled = false;
        await mount().load();
        expect(apiMock.fetchHistory).not.toHaveBeenCalled();
        expect(text()).toContain('Market: Price history panel');
    });

    test('it asks for the chosen item at its level over the default range', async () => {
        await mount({ initial: { itemHrid: '/items/holy_sword', enhancementLevel: 10 } }).load();
        expect(apiMock.fetchHistory).toHaveBeenCalledWith('/items/holy_sword', 10, 90);
    });

    test('a cool-down is explained rather than drawn as nothing', async () => {
        apiMock.fetchHistory.mockImplementation(async () => null);
        apiMock.cooldownRemainingMs.mockImplementation(() => 120_000);
        await mount().load();
        expect(text()).toContain('retrying in ~2m');
    });

    test('an answer for the previous pick cannot draw over the current one', async () => {
        let releaseFirst;
        apiMock.fetchHistory.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    releaseFirst = () => resolve(hourlyRows(10));
                })
        );
        apiMock.fetchHistory.mockImplementationOnce(async () => []);
        mount();
        const first = panel.load();
        await panel.load();
        releaseFirst();
        await first;
        expect(panel.element.querySelector('.mwi-market-clock-grid')).toBeNull();
        expect(text()).toContain('has no history');
    });
});

describe('drawing', () => {
    test('a history draws both grids, names the cheap hour and greys nothing it has enough of', async () => {
        apiMock.fetchHistory.mockImplementation(async () => hourlyRows(14, (d, h) => ({ a: h === 4 ? 990 : 1000 })));
        await mount().load();

        const grids = panel.element.querySelectorAll('.mwi-market-clock-grid');
        expect(grids).toHaveLength(2);
        const askCells = grids[0].querySelectorAll('tr[data-row="ask"] td');
        expect(askCells).toHaveLength(24);
        expect(grids[1].querySelectorAll('tr[data-row="ask"] td')).toHaveLength(7);
        expect(grids[0].querySelector('tr[data-row="volume"]')).not.toBeNull();

        expect(askCells[4].textContent).toBe('-1.0%');
        expect(askCells[4].classList.contains('mwi-market-clock-best')).toBe(true);
        expect(grids[0].querySelectorAll('.mwi-market-clock-thin')).toHaveLength(0);
        expect(text()).toContain('Cheapest to buy: 04:00');
        expect(text()).toMatch(/buckets are in your time zone/);
        expect(text()).not.toMatch(/NaN|undefined|Infinity/);
    });

    test('too few samples are greyed and not named', async () => {
        apiMock.fetchHistory.mockImplementation(async () =>
            hourlyRows(MIN_HOUR_SAMPLES - 1, (d, h) => ({ a: h === 4 ? 900 : 1000 }))
        );
        await mount().load();

        const hourGrid = panel.element.querySelector('.mwi-market-clock-grid');
        const askCells = hourGrid.querySelectorAll('tr[data-row="ask"] td');
        expect(askCells[4].classList.contains('mwi-market-clock-thin')).toBe(true);
        expect(askCells[4].title).toContain('too few');
        expect(text()).not.toContain('Cheapest to buy');
        expect(text()).toContain('Not enough history');
    });

    test('a source without volume draws no volume row', async () => {
        apiMock.source = { key: 'mooket1', label: 'mooket I (IOMisaka)', host: 'x', hasVolume: false, avgLabel: 'Mid' };
        apiMock.fetchHistory.mockImplementation(async () => hourlyRows(10, () => ({ v: 0 })));
        await mount().load();

        expect(panel.element.querySelector('tr[data-row="volume"]')).toBeNull();
        expect(text()).toContain('reports no volume');
        expect(text()).not.toContain('Busiest');
    });

    test('changing the range fetches again at the new range', async () => {
        await mount().load();
        const range = panel.element.querySelector('.mwi-market-clock-range');
        range.value = '180';
        range.dispatchEvent(new Event('change'));
        await vi.waitFor(() => expect(apiMock.fetchHistory).toHaveBeenLastCalledWith('/items/cheese', 0, 180));
    });
});
