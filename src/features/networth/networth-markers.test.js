import { describe, test, expect, vi } from 'vitest';

const settings = vi.hoisted(() => ({ values: {} }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: (id, fallback) => (id in settings.values ? settings.values[id] : fallback) },
}));
vi.mock('../../utils/ironcow-valuation.js', () => ({ IRONCOW_VALUATION_SETTING: 'profitCalc_ironCowValuation' }));

const {
    VALUATION_SETTINGS,
    readValuationSignature,
    diffSignatures,
    buildMarker,
    stepsAfter,
    rebasedWithoutSteps,
    withoutSteps,
    growthNote,
    describeChanges,
    countedMarkerTimes,
    mergeMarkers,
    relevanceContext,
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
            current: { rows },
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
            current: { rows: [tokenRow('/items/task_token', 10, 0, 1)] },
            prevTotal: 100,
            total: 90,
        });
        expect(off.step).toBe(-5_000_000);
        const zero = buildMarker({
            changes: [change('networth_includeGuildTokens', false, true)],
            prevRecord: { rows: [] },
            current: { rows: [] },
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
            current: { rows },
            prevTotal: 0,
            total: 1600,
        });
        const bells = buildMarker({
            changes: [change('networth_includeCowbells', false, true)],
            prevRecord: prev,
            current: { rows },
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
            current: { rows: [] },
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
            current: { rows: [] },
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
            current: { rows: [tokenRow('/items/task_token', 5, 250)] },
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
            current: { rows: [] },
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
    /** A marker for a distinct change, so no two of them are taken for the same one */
    const m = (step, id = 'x', extra = {}) => ({
        changes: [{ id, from: 1, to: 2 }],
        step,
        stepCounted: step,
        unseparated: [],
        raw: step,
        ...extra,
    });

    test('stepsAfter counts only markers after the baseline and separates the unseparable ones', () => {
        const history = [
            point(1, 100, m(40, 'a')),
            point(2, 200, m(60, 'b')),
            point(3, 300, m(null, 'c', { unseparated: ['networth_pricingMode'] })),
            point(4, 400),
        ];
        expect(stepsAfter(history, 1)).toMatchObject({ step: 60, count: 1, inexact: 1, floor: 0 });
        expect(stepsAfter(history, 4)).toMatchObject({ step: 0, count: 0, inexact: 0 });
    });

    test('a small unseparated marker is not reported as unseparable', () => {
        const history = [point(1, 100), point(2, 100, m(null, 'c', { unseparated: ['x'], small: true }))];
        expect(stepsAfter(history, 1).inexact).toBe(0);
    });

    test('withoutSteps shifts later points by every earlier step and does not touch the recorded ones', () => {
        const history = [
            point(1, 1000),
            point(2, 1363, m(363, 'a')),
            point(3, 1400),
            point(4, 1500, m(-100, 'b')),
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

    test('an excluded token moves the total but not the non-excluded line or inventory', () => {
        const history = [point(1, 1000), point(2, 1400, m(400, 'a', { stepCounted: 0 }))];
        const out = withoutSteps(history);
        expect(out[1].total).toBe(1000);
        expect(out[1].nonExcluded).toBe(1400);
        expect(out[1].inventory).toBe(1390);
        expect(stepsAfter(history, 1)).toMatchObject({ step: 400, stepCounted: 0 });
    });

    test('no step to take out returns the very same array', () => {
        const history = [point(1, 1), point(2, 2, m(0)), point(3, 3, m(null, 'z'))];
        expect(withoutSteps(history)).toBe(history);
    });

    test('the note says how many and how much, what was left in, and when a step is only a floor', () => {
        expect(growthNote({ step: 363e6, count: 1, inexact: 0 }, money)).toBe('excludes 1 setting change: +363M');
        expect(growthNote({ step: -5e6, count: 2, inexact: 1 }, money)).toContain('excludes 2 setting changes: -5M');
        expect(growthNote({ step: 5e6, count: 1, inexact: 0, floor: 1 }, money)).toBe(
            'excludes 1 setting change: at least +5M'
        );
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

describe('one change marked twice', () => {
    const HOUR = 3_600_000;
    const flip = (id, from, to) => ({ id, from, to });
    const mark = (t, change, step = 363) => ({
        t,
        total: 1000 + step,
        nonExcluded: 1000 + step,
        marker: { changes: [change], step, stepCounted: step, unseparated: [], raw: step },
    });
    const on = flip('networth_includeLabyrinthTokens', false, true);
    const off = flip('networth_includeLabyrinthTokens', true, false);

    test('two devices marking the same change within the window count once, whichever order they merged in', () => {
        const a = mark(10 * HOUR, on);
        const b = mark(10 * HOUR + 40 * 60_000, on);
        for (const history of [
            [a, b],
            [b, a],
        ]) {
            expect(stepsAfter(history, 0)).toMatchObject({ step: 363, count: 1 });
            expect(countedMarkerTimes(history)).toEqual(new Set([a.t]));
            const out = withoutSteps(history.slice().sort((x, y) => x.t - y.t));
            expect(out.map((p) => p.total)).toEqual([1000, 1000]);
        }
    });

    test('the same change a day apart is a real second change', () => {
        const history = [mark(10 * HOUR, on), mark(40 * HOUR, on)];
        expect(stepsAfter(history, 0)).toMatchObject({ step: 726, count: 2 });
    });

    test('a flip and a flip back inside the window are three real changes, not one counted twice', () => {
        const history = [mark(10 * HOUR, on), mark(11 * HOUR, off, -363), mark(12 * HOUR, on)];
        expect(stepsAfter(history, 0)).toMatchObject({ step: 363, count: 3 });
    });

    test('different changes at once are both counted', () => {
        const history = [
            mark(10 * HOUR, on),
            mark(10 * HOUR + 1000, flip('networth_includeTaskTokens', false, true), 50),
        ];
        expect(stepsAfter(history, 0)).toMatchObject({ step: 413, count: 2 });
    });
});

describe('mergeMarkers', () => {
    test('joins changes without repeating one, adds the steps, keeps null only when both are', () => {
        const a = {
            changes: [{ id: 'a', from: 1, to: 2 }],
            step: 10,
            unseparated: [],
            raw: 10,
        };
        const b = {
            changes: [
                { id: 'a', from: 1, to: 2 },
                { id: 'b', from: 1, to: 2 },
            ],
            step: 5,
            unseparated: ['b'],
            raw: 5,
            floor: ['b'],
        };
        const merged = mergeMarkers(a, b);
        expect(merged.changes.map((c) => c.id)).toEqual(['a', 'b']);
        expect(merged.step).toBe(15);
        expect(merged.unseparated).toEqual(['b']);
        expect(merged.floor).toEqual(['b']);
        expect(mergeMarkers({ ...a, step: null }, { ...a, step: null }).step).toBe(null);
        expect(mergeMarkers(null, b)).toBe(b);
        expect(mergeMarkers(a, null)).toBe(a);
    });
});

describe('a step is never an exact zero when it cannot be known', () => {
    const row = (hrid, count, value, flags) =>
        flags ? ['h', hrid, 0, count, value, flags] : ['h', hrid, 0, count, value];
    const labOn = { id: 'networth_includeLabyrinthTokens', from: false, to: true };
    const labOff = { id: 'networth_includeLabyrinthTokens', from: true, to: false };

    test('turning a switch on over a token nothing prices is a floor, not an exact 0', () => {
        const marker = buildMarker({
            changes: [labOn],
            prevRecord: { rows: [row('/items/labyrinth_token', 8, 0, 1)] },
            current: { rows: [row('/items/labyrinth_token', 8, 0, 1)] },
            prevTotal: 1000,
            total: 1000,
        });
        expect(marker.step).toBe(0);
        expect(marker.floor).toEqual(['networth_includeLabyrinthTokens']);
    });

    test('turning it off over rows that were only partly priced is a floor too', () => {
        const marker = buildMarker({
            changes: [labOff],
            prevRecord: { rows: [row('/items/labyrinth_token', 8, 300, 2)] },
            current: { rows: [row('/items/labyrinth_token', 8, 0, 1)] },
            prevTotal: 1000,
            total: 700,
        });
        expect(marker.step).toBe(-300);
        expect(marker.floor).toEqual(['networth_includeLabyrinthTokens']);
    });

    test('turning it off, the unpriced zero rows of the new reading are not what was valued', () => {
        const marker = buildMarker({
            changes: [labOff],
            prevRecord: { rows: [row('/items/labyrinth_token', 8, 300)] },
            current: { rows: [row('/items/labyrinth_token', 8, 0, 1)] },
            prevTotal: 1000,
            total: 700,
        });
        expect(marker.floor).toBeUndefined();
    });

    test('a token excluded by name is not in the rows but is in the total: the total step has it, the counted one does not', () => {
        const marker = buildMarker({
            changes: [labOn],
            prevRecord: { rows: [], ex: { '/items/labyrinth_token': 0 }, exOther: false },
            current: { rows: [], ex: { '/items/labyrinth_token': 363 }, exOther: false },
            prevTotal: 1000,
            total: 1363,
        });
        expect(marker.step).toBe(363);
        expect(marker.stepCounted).toBe(0);
        expect(marker.floor).toBeUndefined();
    });

    test('a category exclusion may hide more of it: the step is a floor', () => {
        const marker = buildMarker({
            changes: [labOn],
            prevRecord: { rows: [], ex: {}, exOther: true },
            current: { rows: [], ex: {}, exOther: true },
            prevTotal: 1000,
            total: 1000,
        });
        expect(marker.floor).toEqual(['networth_includeLabyrinthTokens']);
    });

    test('an unseparated change in a reading that barely moved is on record as small, not as unseparable', () => {
        const quiet = buildMarker({
            changes: [{ id: 'enhanceSim_baseItemCraftingCost', from: false, to: true }],
            prevRecord: { rows: [] },
            current: { rows: [] },
            prevTotal: 10_000_000_000,
            total: 10_003_000_000,
        });
        expect(quiet.small).toBe(true);
        expect(quiet.step).toBe(null);
        const loud = buildMarker({
            changes: [{ id: 'enhanceSim_baseItemCraftingCost', from: false, to: true }],
            prevRecord: { rows: [] },
            current: { rows: [] },
            prevTotal: 10_000_000_000,
            total: 10_200_000_000,
        });
        expect(loud.small).toBeUndefined();
    });
});

describe('a setting that cannot matter is not a change', () => {
    const base = { networth_valueSource: 'orderBook', networth_highEnhancementUseCost: false };

    test('Iron Cow valuation off an Iron Cow, min level with the use-cost switch off, pricing mode under official value', () => {
        expect(
            diffSignatures(
                { ...base, profitCalc_ironCowValuation: 'market' },
                { ...base, profitCalc_ironCowValuation: 'vendor' },
                { ironCow: false }
            )
        ).toEqual([]);
        expect(
            diffSignatures(
                { ...base, networth_highEnhancementMinLevel: 13 },
                { ...base, networth_highEnhancementMinLevel: 14 }
            )
        ).toEqual([]);
        expect(
            diffSignatures(
                { ...base, networth_highEnhancementUseCost: true, networth_highEnhancementMinLevel: 13 },
                { ...base, networth_highEnhancementUseCost: true, networth_highEnhancementMinLevel: 14 }
            )
        ).toHaveLength(1);
        const official = { networth_valueSource: 'officialValue' };
        expect(
            diffSignatures({ ...official, networth_pricingMode: 'ask' }, { ...official, networth_pricingMode: 'bid' })
        ).toEqual([]);
        expect(
            diffSignatures({ ...base, networth_pricingMode: 'ask' }, { ...base, networth_pricingMode: 'bid' })
        ).toHaveLength(1);
    });

    test('the guild token rate with none held, the cape base with no cape held', () => {
        const rate = [
            { ...base, guildTokenCreditRate: 1 },
            { ...base, guildTokenCreditRate: 2 },
        ];
        expect(diffSignatures(...rate, { guildTokenHeld: false })).toEqual([]);
        expect(diffSignatures(...rate, { guildTokenHeld: true })).toHaveLength(1);
        // Not known: stays relevant
        expect(diffSignatures(...rate, {})).toHaveLength(1);
        const cape = [
            { ...base, untradableCapeBaseValue: 'zero' },
            { ...base, untradableCapeBaseValue: 'mirror' },
        ];
        expect(diffSignatures(...cape, { capeHeld: false })).toEqual([]);
        expect(diffSignatures(...cape, { capeHeld: true })).toHaveLength(1);
    });

    test('relevanceContext reads what is held from the calculation', () => {
        const held = {
            currentAssets: { inventory: { breakdown: [{ itemHrid: '/items/guild_token' }] } },
            valuationFacts: { capeHeld: false },
        };
        expect(relevanceContext(held, true)).toEqual({ ironCow: true, guildTokenHeld: true, capeHeld: false });
        expect(relevanceContext({}, false)).toEqual({ ironCow: false });
    });
});

describe('rebasedWithoutSteps', () => {
    const switchedOff = [
        { t: 1, total: 1000 },
        { t: 2, total: 1010 },
        { t: 3, total: 120, marker: { step: -900, changes: [{ setting: 'a', from: true, to: false }] } },
        { t: 4, total: 130 },
    ];

    test('growth keeps its real scale after a large step down', () => {
        const rebased = rebasedWithoutSteps(switchedOff);
        expect(rebased.map((point) => point.total)).toEqual([100, 110, 120, 130]);
        expect(Math.log(rebased[3].total / rebased[2].total)).toBeCloseTo(Math.log(130 / 120));
    });

    test('a step up lifts the earlier points onto the current level', () => {
        const rebased = rebasedWithoutSteps([
            { t: 1, total: 100 },
            { t: 2, total: 1010, marker: { step: 900, changes: [{ setting: 'a', from: false, to: true }] } },
        ]);
        expect(rebased.map((point) => point.total)).toEqual([1000, 1010]);
    });

    test('a history with no step is the same array', () => {
        const plain = [{ t: 1, total: 5 }];
        expect(rebasedWithoutSteps(plain)).toBe(plain);
    });

    test('nothing stored is changed', () => {
        rebasedWithoutSteps(switchedOff);
        expect(switchedOff[0].total).toBe(1000);
    });
});
