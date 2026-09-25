import { describe, test, expect, vi, afterEach } from 'vitest';

const gates = vi.hoisted(() => ({ september: false }));

vi.mock('./server-gate.js', () => ({
    isMarketplacePatchLive: () => true,
    isSeptember2026MarketPatchLive: () => gates.september,
}));

afterEach(() => {
    gates.september = false;
});
import {
    filterWindow,
    snapPriceTier,
    weightedMedianPrice,
    splitBuySellVolume,
    computeMarketStats,
    computeAllWindows,
    trimTrailingZeros,
    STAT_WINDOWS_DAYS,
} from './market-volume-stats-math.js';

describe('filterWindow', () => {
    test('keeps only rows within the trailing N days of `now`', () => {
        const now = 10 * 24 * 60 * 60 * 1000; // day 10, in ms
        const rows = [
            { time: 9.5 * 86400 }, // 0.5 days ago
            { time: 6 * 86400 }, // 4 days ago
            { time: 1 * 86400 }, // 9 days ago
        ];
        expect(filterWindow(rows, 1, now)).toHaveLength(1);
        expect(filterWindow(rows, 5, now)).toHaveLength(2);
        expect(filterWindow(rows, 30, now)).toHaveLength(3);
    });

    test('drops rows with no numeric time and tolerates a non-array input', () => {
        expect(filterWindow([{ time: 'x' }, {}], 1)).toEqual([]);
        expect(filterWindow(null, 1)).toEqual([]);
        expect(filterWindow(undefined, 1)).toEqual([]);
    });
});

describe('snapPriceTier', () => {
    test('snaps down to the ladder step at or below the price', () => {
        expect(snapPriceTier(1234, 'down')).toBe(1230);
        expect(snapPriceTier(100, 'down')).toBe(100);
    });

    test('snaps up to the ladder step at or above the price, unchanged when already on it', () => {
        expect(snapPriceTier(1231, 'up')).toBe(1235);
        expect(snapPriceTier(120, 'up')).toBe(120);
    });

    test('non-positive or non-finite input is 0; 1 and below round up to 2', () => {
        expect(snapPriceTier(0, 'down')).toBe(0);
        expect(snapPriceTier(-5, 'up')).toBe(0);
        expect(snapPriceTier(NaN, 'up')).toBe(0);
        expect(snapPriceTier(1, 'down')).toBe(2);
    });
});

describe('weightedMedianPrice', () => {
    test('finds the price at which half the traded volume has accumulated', () => {
        const rows = [
            { p: 100, v: 10 },
            { p: 120, v: 5 },
        ];
        // sorted: [100 x10, 120 x5], total 15, half 7.5, cumulative hits 10 >= 7.5 at price 100
        expect(weightedMedianPrice(rows)).toBe(100);
    });

    test('excludes rows with a non-positive price or volume', () => {
        const rows = [
            { p: -1, v: 10 },
            { p: 100, v: 0 },
            { p: 50, v: 3 },
        ];
        expect(weightedMedianPrice(rows)).toBe(50);
    });

    test('0 with nothing priced', () => {
        expect(weightedMedianPrice([])).toBe(0);
        expect(weightedMedianPrice([{ p: -1, v: 5 }])).toBe(0);
    });
});

describe('splitBuySellVolume — golden test against the source formulas', () => {
    // Reproduces processMarketData's L2288-2370 hourly heuristic by hand, for
    // one hour with two rows and no previous hour (so last* falls back to cur*):
    //   row1 p=100, v=10: not >= avgAsk(110), not <= avgBid(90) -> split
    //     avgRange = ((110-90)+(110-90))/2 = 20 > 0
    //     minBid=90, maxAsk=110, actualRange=20, buyRatio=(100-90)/20=0.5
    //     -> buy += 5, sell += 5
    //   row2 p=120, v=5: p >= avgAsk(110) -> all buy: buy += 5
    // totals: buy = 10, sell = 5
    const hour = 100000;
    const rows = [
        { a: 110, b: 90, p: 100, v: 10, time: hour * 3600 },
        { a: 110, b: 90, p: 120, v: 5, time: hour * 3600 + 10 },
    ];

    test('matches the hand-computed split', () => {
        expect(splitBuySellVolume(rows)).toEqual({ buyVolume: 10, sellVolume: 5 });
    });

    test('a row at or above either hour’s mean ask counts entirely as bought', () => {
        const result = splitBuySellVolume([{ a: 100, b: 80, p: 100, v: 7, time: hour * 3600 }]);
        expect(result).toEqual({ buyVolume: 7, sellVolume: 0 });
    });

    test('a row at or below either hour’s mean bid counts entirely as sold', () => {
        const result = splitBuySellVolume([{ a: 100, b: 80, p: 80, v: 7, time: hour * 3600 }]);
        expect(result).toEqual({ buyVolume: 0, sellVolume: 7 });
    });

    test('no ask or bid quoted at all splits the row 50/50', () => {
        const result = splitBuySellVolume([{ a: 0, b: 0, p: 90, v: 9, time: hour * 3600 }]);
        // 4.5/4.5, each rounded independently (JS rounds .5 up) -> 5/5
        expect(result).toEqual({ buyVolume: 5, sellVolume: 5 });
    });

    test('zero volume rows and rows with no time contribute nothing', () => {
        expect(splitBuySellVolume([{ a: 110, b: 90, p: 100, v: 0, time: hour * 3600 }])).toEqual({
            buyVolume: 0,
            sellVolume: 0,
        });
        expect(splitBuySellVolume([{ a: 110, b: 90, p: 100, v: 5 }])).toEqual({ buyVolume: 0, sellVolume: 0 });
        expect(splitBuySellVolume([])).toEqual({ buyVolume: 0, sellVolume: 0 });
    });
});

describe('computeMarketStats — golden test against the source formulas', () => {
    const hour = 100000;
    const rows = [
        { a: 110, b: 90, p: 100, v: 10, time: hour * 3600 },
        { a: 110, b: 90, p: 120, v: 5, time: hour * 3600 + 10 },
    ];

    test('volume, average, median, min/max and buy/sell all match hand computation', () => {
        const stats = computeMarketStats(rows);
        expect(stats.volume).toBe(15);
        expect(stats.avgPrice).toBeCloseTo(1600 / 15, 10); // (100*10 + 120*5) / 15
        expect(stats.medianPrice).toBe(100);
        expect(stats.buyVolume).toBe(10);
        expect(stats.sellVolume).toBe(5);
        expect(stats.minPrice).toBe(100); // priceIncrement(100) == 1, already on the ladder
        expect(stats.maxPrice).toBe(120); // priceIncrement(120) == 1, already on the ladder
    });

    test('rows with a non-positive price are excluded from average and median, but still count toward volume', () => {
        const withGap = [...rows, { a: -1, b: -1, p: -1, v: 100, time: hour * 3600 + 20 }];
        const stats = computeMarketStats(withGap);
        expect(stats.volume).toBe(115); // 15 + 100, unlike the source, which would also drag the average down
        expect(stats.avgPrice).toBeCloseTo(1600 / 15, 10); // unaffected by the unpriced row
    });

    test('an empty window is all zeros', () => {
        expect(computeMarketStats([])).toEqual({
            volume: 0,
            avgPrice: 0,
            medianPrice: 0,
            buyVolume: 0,
            sellVolume: 0,
            minPrice: 0,
            maxPrice: 0,
        });
    });

    test('tolerates a non-array input', () => {
        expect(computeMarketStats(null).volume).toBe(0);
    });
});

describe('computeAllWindows', () => {
    test('produces one entry per STAT_WINDOWS_DAYS window, filtered from one row set', () => {
        const nowSeconds = 10 * 86400; // day 10, in seconds
        const nowMs = nowSeconds * 1000;
        const rows = [
            { a: 110, b: 90, p: 100, v: 10, time: nowSeconds - 3600 }, // 1h ago
            { a: 110, b: 90, p: 100, v: 5, time: nowSeconds - 4 * 86400 }, // 4 days ago
        ];
        const windows = computeAllWindows(rows, nowMs);
        expect(windows.map((w) => w.days)).toEqual(STAT_WINDOWS_DAYS);
        expect(windows.find((w) => w.days === 1).stats.volume).toBe(10);
        expect(windows.find((w) => w.days === 3).stats.volume).toBe(10);
        expect(windows.find((w) => w.days === 5).stats.volume).toBe(15);
    });
});

describe('trimTrailingZeros', () => {
    test('trims a trailing fractional zero run, and the decimal point if nothing is left', () => {
        expect(trimTrailingZeros('558.10K')).toBe('558.1K');
        expect(trimTrailingZeros('558.00K')).toBe('558K');
        expect(trimTrailingZeros('10.92K')).toBe('10.92K');
        expect(trimTrailingZeros('100')).toBe('100');
    });

    test('passes non-strings through unchanged', () => {
        expect(trimTrailingZeros(null)).toBe(null);
    });
});

describe('snapPriceTier under the September 2026 market patch', () => {
    // getBinnedPrice(price, roundUp, enhLevel) from the test-server client
    test('snaps to the new bins, down or up, the way getBinnedPrice does', () => {
        gates.september = true;
        expect(snapPriceTier(1003, 'down')).toBe(1000);
        expect(snapPriceTier(1003, 'up')).toBe(1004);
        expect(snapPriceTier(1004, 'up')).toBe(1004);
        expect(snapPriceTier(123456, 'down')).toBe(123000);
        expect(snapPriceTier(123456, 'up')).toBe(123500);
        expect(snapPriceTier(1, 'down')).toBe(2);
    });

    test('an enhanced item snaps to its wider bins', () => {
        gates.september = true;
        expect(snapPriceTier(1003, 'down', 3)).toBe(1000);
        expect(snapPriceTier(1003, 'up', 3)).toBe(1020);
        expect(snapPriceTier(123456, 'up', 1)).toBe(125000);
        expect(snapPriceTier(850, 'up', 1)).toBe(860);
    });

    test('computeAllWindows threads the level to the min/max snap', () => {
        gates.september = true;
        const now = 10 * 86400 * 1000;
        const rows = [
            { time: 10 * 86400 - 60, p: 1003, v: 1, a: 1003, b: 1003 },
            { time: 10 * 86400 - 60, p: 1017, v: 1, a: 1017, b: 1017 },
        ];
        const [plain] = computeAllWindows(rows, now);
        const [enhanced] = computeAllWindows(rows, now, 2);
        expect([plain.stats.minPrice, plain.stats.maxPrice]).toEqual([1000, 1020]);
        expect([enhanced.stats.minPrice, enhanced.stats.maxPrice]).toEqual([1000, 1020]);
        const [wide] = computeAllWindows([{ ...rows[0], p: 1021 }], now, 2);
        expect([wide.stats.minPrice, wide.stats.maxPrice]).toEqual([1020, 1040]);
    });

    test('on live the level changes nothing', () => {
        expect(snapPriceTier(1231, 'up', 5)).toBe(1235);
        expect(snapPriceTier(1234, 'down', 5)).toBe(1230);
    });
});
