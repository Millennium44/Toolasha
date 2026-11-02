import { describe, test, expect } from 'vitest';
import { attributeGoldSources } from './gold-sources.js';
import { forecastNetworth } from './networth-forecast.js';

const D18 = Date.parse('2026-08-18T12:00:00Z');
const D19 = Date.parse('2026-08-19T12:00:00Z');
const D20 = Date.parse('2026-08-20T12:00:00Z');

const marker = (step) => ({
    changes: [{ id: 'networth_includeLabyrinthTokens', from: false, to: true }],
    step,
    stepCounted: step,
    unseparated: [],
    raw: step,
});

const base = {
    from: D19,
    to: D20 + 3600_000,
    price: () => null,
    marketTax: 0.05,
    actionType: () => null,
};

describe('gold sources and a setting change', () => {
    const series = [
        { t: D18, total: 0 },
        { t: D19, total: 5000 },
        { t: D20, total: 25000, marker: marker(15000) },
    ];

    test('the day delta is the real one and the step is its own line, out of the residual', () => {
        const result = attributeGoldSources({ ...base, series });
        const day = result.days.find((row) => row.delta === 20000);
        expect(day.settingChange).toBe(15000);
        expect(day.residual).toBe(5000);
        expect(result.totals.delta).toBe(25000);
        expect(result.totals.settingChange).toBe(15000);
        expect(result.totals.residual).toBe(10000);
    });

    test('without a marker nothing changes: residual is the whole unexplained delta', () => {
        const plain = series.map(({ marker: _marker, ...point }) => point);
        const result = attributeGoldSources({ ...base, series: plain });
        expect(result.totals.settingChange).toBe(0);
        expect(result.totals.residual).toBe(25000);
    });

    test('the same change marked by two devices comes out once', () => {
        const doubled = [...series, { t: D20 + 600_000, total: 25100, marker: marker(15000) }];
        const result = attributeGoldSources({ ...base, series: doubled });
        expect(result.totals.settingChange).toBe(15000);
    });
});

describe('the forecast starts from the real level', () => {
    const DAY = 86_400_000;
    const history = Array.from({ length: 40 }, (_, i) => ({
        t: Date.UTC(2026, 9, 1) + i * DAY,
        total: 1_000_000_000 * (1 + 0.01 * i),
    }));

    test('a level passed in is where the paths start, the series only supplies the drift', () => {
        const fromSeries = forecastNetworth(history, { days: 30, runs: 200, seed: 7 });
        const real = forecastNetworth(history, { days: 30, runs: 200, seed: 7, current: 1_800_000_000 });
        expect(fromSeries.status).toBe('complete');
        expect(real.current).toBe(1_800_000_000);
        expect(fromSeries.current).not.toBe(1_800_000_000);
        expect(real.fan.p50[0]).toBe(1_800_000_000);
    });

    test('a missing or zero level falls back to the series', () => {
        const a = forecastNetworth(history, { days: 30, runs: 200, seed: 7 });
        const b = forecastNetworth(history, { days: 30, runs: 200, seed: 7, current: 0 });
        expect(b.current).toBe(a.current);
    });
});
