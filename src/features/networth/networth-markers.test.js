import { describe, test, expect, vi } from 'vitest';

const settings = vi.hoisted(() => ({ values: {} }));

vi.mock('../../core/config.js', () => ({
    default: { getSettingValue: (id, fallback) => (id in settings.values ? settings.values[id] : fallback) },
}));
vi.mock('../../utils/ironcow-valuation.js', () => ({ IRONCOW_VALUATION_SETTING: 'profitCalc_ironCowValuation' }));

const {
    VALUATION_SETTINGS,
    readValuationSignature,
    diffSignatures,
    buildMarker,
    stepsAfter,
    withoutSteps,
    growthNote,
    describeChanges,
} = await import('./networth-markers.js');

const money = (n) => `${Math.round(n / 1e6)}M`;

describe('the settings list', () => {
    test('covers every setting the calculation reads, and the signature holds each one', () => {
        settings.values = { networth_includeLabyrinthTokens: true };
        const signature = readValuationSignature();
        expect(Object.keys(signature).sort()).toEqual([...VALUATION_SETTINGS].sort());
        expect(signature.networth_includeLabyrinthTokens).toBe(true);
        expect(signature.networth_pricingMode).toBe(null);
        for (const id of [
            'networth_includeCowbells',
            'networth_includeTaskTokens',
            'networth_includeLabyrinthTokens',
            'networth_includeGuildTokens',
            'networth_includeGuildCredits',
            'networth_pricingMode',
            'networth_valueSource',
            'untradableCapeBaseValue',
            'profitCalc_ironCowValuation',
        ]) {
            expect(VALUATION_SETTINGS).toContain(id);
        }
    });
});

describe('diffSignatures', () => {
    test('nothing seen before gives no change, equal gives none, a flip on then off between readings gives none', () => {
        const a = { networth_includeTaskTokens: true };
        expect(diffSignatures(null, a)).toEqual([]);
        expect(diffSignatures(a, { ...a })).toEqual([]);
        // on, then off again before the next reading: the two readings agree
        const off = { networth_includeLabyrinthTokens: false };
        expect(diffSignatures(off, { networth_includeLabyrinthTokens: false })).toEqual([]);
    });

    test('several changes before one reading come back together, in list order', () => {
        const before = {
            networth_pricingMode: 'ask',
            networth_includeLabyrinthTokens: false,
            networth_includeCowbells: false,
        };
        const after = {
            networth_pricingMode: 'bid',
            networth_includeLabyrinthTokens: true,
            networth_includeCowbells: false,
        };
        expect(diffSignatures(before, after).map((c) => c.id)).toEqual([
            'networth_pricingMode',
            'networth_includeLabyrinthTokens',
        ]);
    });

    test('Iron Cow valuation counts only on an Iron Cow character', () => {
        const before = { profitCalc_ironCowValuation: 'market' };
        const after = { profitCalc_ironCowValuation: 'vendor' };
        expect(diffSignatures(before, after)).toEqual([]);
        expect(diffSignatures(before, after, { ironCow: true })).toHaveLength(1);
    });

    test('a setting the stored state never held is not a change', () => {
        expect(
            diffSignatures(
                { networth_pricingMode: 'ask' },
                { networth_pricingMode: 'ask', untradableCapeBaseValue: 'mirror' }
            )
        ).toEqual([]);
    });
});

describe('buildMarker', () => {
    const tokenRow = (hrid, count, value, flags) =>
        flags ? ['h', hrid, 0, count, value, flags] : ['h', hrid, 0, count, value];
    const change = (id, from, to) => ({ id, from, to });

    test('an include switch turned on: the step is the value of exactly the rows it decides', () => {
        const prev = { rows: [tokenRow('/items/labyrinth_token', 400, 0, 1), tokenRow('/items/sword', 1, 5_000_000)] };
        const rows = [
            tokenRow('/items/labyrinth_token', 400, 363_000_000),
            tokenRow('/items/sword', 1, 5_100_000), // market move on an unrelated item stays out of the step
        ];
        const marker = buildMarker({
            changes: [change('networth_includeLabyrinthTokens', false, true)],
            prevRecord: prev,
            rows,
            prevTotal: 1_000_000_000,
            total: 1_363_100_000,
        });
        expect(marker.step).toBe(363_000_000);
        expect(marker.unseparated).toEqual([]);
        expect(marker.raw).toBe(363_100_000);
    });

    test('turned off, the step is negative; a step of zero is recorded as zero, not as missing', () => {
        const prev = { rows: [tokenRow('/items/task_token', 10, 5_000_000)] };
        const off = buildMarker({
            changes: [change('networth_includeTaskTokens', true, false)],
            prevRecord: prev,
            rows: [tokenRow('/items/task_token', 10, 0, 1)],
            prevTotal: 100,
            total: 90,
        });
        expect(off.step).toBe(-5_000_000);
        const zero = buildMarker({
            changes: [change('networth_includeGuildTokens', false, true)],
            prevRecord: { rows: [] },
            rows: [],
            prevTotal: 100,
            total: 100,
        });
        expect(zero.step).toBe(0);
    });

    test('guild credits and cowbells are separable rows too', () => {
        const prev = { rows: [] };
        const rows = [tokenRow('/items/brown_guild_credit', 100, 700), tokenRow('/items/cowbell', 50, 900)];
        const credits = buildMarker({
            changes: [change('networth_includeGuildCredits', false, true)],
            prevRecord: prev,
            rows,
            prevTotal: 0,
            total: 1600,
        });
        const bells = buildMarker({
            changes: [change('networth_includeCowbells', false, true)],
            prevRecord: prev,
            rows,
            prevTotal: 0,
            total: 1600,
        });
        expect(credits.step).toBe(700);
        expect(bells.step).toBe(900);
    });

    test('a setting that reprices many items is not invented into a figure', () => {
        const marker = buildMarker({
            changes: [change('networth_pricingMode', 'ask', 'bid')],
            prevRecord: { rows: [] },
            rows: [],
            prevTotal: 1000,
            total: 1200,
        });
        expect(marker.step).toBe(null);
        expect(marker.unseparated).toEqual(['networth_pricingMode']);
        expect(marker.raw).toBe(200);
    });

    test('an include switch with no item map for the reading before cannot be separated either', () => {
        const marker = buildMarker({
            changes: [change('networth_includeLabyrinthTokens', false, true)],
            prevRecord: null,
            rows: [],
            prevTotal: 1,
            total: 2,
        });
        expect(marker.step).toBe(null);
        expect(marker.unseparated).toEqual(['networth_includeLabyrinthTokens']);
    });

    test('mixed changes: the separable ones make the step, the rest are listed', () => {
        const marker = buildMarker({
            changes: [
                change('networth_includeTaskTokens', false, true),
                change('networth_valueSource', 'orderBook', 'officialValue'),
            ],
            prevRecord: { rows: [tokenRow('/items/task_token', 5, 0, 1)] },
            rows: [tokenRow('/items/task_token', 5, 250)],
            prevTotal: 1000,
            total: 1900,
        });
        expect(marker.step).toBe(250);
        expect(marker.unseparated).toEqual(['networth_valueSource']);
    });

    test('ability books as inventory moves value between lines and leaves the total alone', () => {
        const marker = buildMarker({
            changes: [change('networth_abilityBooksAsInventory', false, true)],
            prevRecord: { rows: [] },
            rows: [],
            prevTotal: 5,
            total: 5,
        });
        expect(marker.step).toBe(0);
    });
});

describe('leaving steps out of growth', () => {
    const point = (t, total, marker) => ({
        t,
        total,
        nonExcluded: total,
        inventory: total - 10,
        ...(marker ? { marker } : {}),
    });
    const m = (step, extra = {}) => ({
        changes: [{ id: 'x', from: 1, to: 2 }],
        step,
        unseparated: [],
        raw: step,
        ...extra,
    });

    test('stepsAfter counts only markers after the baseline and separates the unseparable ones', () => {
        const history = [
            point(1, 100, m(40)),
            point(2, 200, m(60)),
            point(3, 300, m(null, { unseparated: ['networth_pricingMode'] })),
            point(4, 400),
        ];
        expect(stepsAfter(history, 1)).toEqual({ step: 60, count: 1, inexact: 1 });
        expect(stepsAfter(history, 4)).toEqual({ step: 0, count: 0, inexact: 0 });
    });

    test('withoutSteps shifts later points by every earlier step and does not touch the recorded ones', () => {
        const history = [
            point(1, 1000),
            point(2, 1363, m(363)),
            point(3, 1400),
            point(4, 1500, m(-100)),
            point(5, 1450),
        ];
        const out = withoutSteps(history);
        expect(out.map((p) => p.total)).toEqual([1000, 1000, 1037, 1237, 1187]);
        expect(out[2].nonExcluded).toBe(1037);
        expect(out[2].inventory).toBe(1027);
        expect(history[1].total).toBe(1363);
        // before the first marker the same objects come back
        expect(out[0]).toBe(history[0]);
    });

    test('no step to take out returns the very same array', () => {
        const history = [point(1, 1), point(2, 2, m(0)), point(3, 3, m(null))];
        expect(withoutSteps(history)).toBe(history);
    });

    test('the note says how many and how much, and what was left in', () => {
        expect(growthNote({ step: 363e6, count: 1, inexact: 0 }, money)).toBe('excludes 1 setting change: +363M');
        expect(growthNote({ step: -5e6, count: 2, inexact: 1 }, money)).toContain('excludes 2 setting changes: -5M');
        expect(growthNote({ step: 0, count: 0, inexact: 1 }, money)).toBe(
            '1 setting change could not be separated from market movement and is left in'
        );
        expect(growthNote({ step: 0, count: 0, inexact: 0 }, money)).toBe('');
    });

    test('describeChanges names each setting and its two values', () => {
        expect(
            describeChanges({
                changes: [
                    { id: 'networth_includeLabyrinthTokens', from: false, to: true },
                    { id: 'networth_pricingMode', from: 'ask', to: 'bid' },
                ],
            })
        ).toBe('Include labyrinth tokens: off to on; Net worth pricing side: ask to bid');
    });
});
