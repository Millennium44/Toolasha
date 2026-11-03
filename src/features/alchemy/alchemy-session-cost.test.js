/**
 * What a session's inputs and catalysts cost when they were spent.
 *
 * The viewers priced the input and catalysts of every session at the market of
 * the moment somebody looked, so a session's Net drifted with the market while
 * its outputs (priced at result time) did not. Each message now saves its own
 * cost on the session; these tests pin the arithmetic that reads it back, the
 * coverage rule for what a record does not cover, and the merge and import
 * shapes around it.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const GEM = '/items/gem';
const CAPE = '/items/gatherer_cape_refined';
const PRIME = '/items/prime_catalyst';

const mocks = vi.hoisted(() => ({
    prices: {},
    sources: {},
    calls: [],
    throwOnPrice: false,
    capeValue: null,
    capes: new Set(),
    mode: 'ask',
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, getSettingValue: (_key, fallback) => fallback },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: (itemHrid) =>
            mocks.capes.has(itemHrid) ? { equipmentDetail: { type: '/equipment_types/back' } } : { name: itemHrid },
        getInitClientData: () => ({ itemDetailMap: {}, actionDetailMap: {} }),
    },
}));

vi.mock('../../utils/market-data.js', () => {
    const priceOf = (itemHrid) => (itemHrid in mocks.prices ? mocks.prices[itemHrid] : null);
    return {
        getItemPrice: (itemHrid) => priceOf(itemHrid),
        getItemPriceInfo: (itemHrid, options) => {
            if (mocks.throwOnPrice) throw new Error('market unavailable');
            mocks.calls.push({ itemHrid, ...options });
            const price = priceOf(itemHrid);
            return { price, source: price === null ? null : mocks.sources[itemHrid] || 'book', estimated: false };
        },
        getItemPrices: () => null,
        getPricingMode: () => mocks.mode,
    };
});

vi.mock('../enhancement/untradable-cape-value.js', () => ({
    getUntradableCapeValue: () => mocks.capeValue,
}));

const { recordInputCost, recordCatalystCost } = await import('./alchemy-session-cost.js');
const {
    resolveInputCost,
    resolveCatalystCost,
    mergeCosts,
    pickCosts,
    validateCosts,
    TODAYS_PRICE_MARK,
    rescaleCosts,
    resolveBulk,
} = await import('./alchemy-cost-record.js');
const { mergeSessionCopies } = await import('./alchemy-session-store.js');
const { planAlchemyImportMerge } = await import('./alchemy-session-import.js');
const { mergeReloadSplitSessions } = await import('./alchemy-session-merge.js');
const { formatInputCostLine } = await import('../../utils/refined-item-cost.js');

const today = (hrid) => () => {
    const price = mocks.prices[hrid];
    return price > 0 ? { price, basis: 'current buy', unpriced: false } : { price: 0, basis: null, unpriced: true };
};
const todayCatalyst = (hrid) => (mocks.prices[hrid] > 0 ? mocks.prices[hrid] : null);

beforeEach(() => {
    mocks.prices = { [GEM]: 100, [PRIME]: 1000 };
    mocks.sources = {};
    mocks.calls = [];
    mocks.throwOnPrice = false;
    mocks.capeValue = null;
    mocks.capes = new Set();
    mocks.mode = 'ask';
});

describe('recording what an input cost at the time', () => {
    test('the price moves between messages: each message is costed at its own price', () => {
        const session = {};
        recordInputCost(session, { inputItemHrid: GEM, units: 5 });
        mocks.prices[GEM] = 140;
        recordInputCost(session, { inputItemHrid: GEM, units: 3 });

        expect(session.costs.input.cost).toBe(5 * 100 + 3 * 140);
        expect(session.costs.input.units).toBe(8);
        // The market is 300 now; the session does not care
        mocks.prices[GEM] = 300;
        const resolved = resolveInputCost(session, 8, today(GEM));
        expect(resolved.cost).toBe(920);
        expect(resolved.pricedToday).toBe(false);
        expect(resolved.basis).toBe('current buy');
    });

    test('two price changes in one session', () => {
        const session = {};
        for (const [price, units] of [
            [100, 4],
            [80, 6],
            [120, 10],
        ]) {
            mocks.prices[GEM] = price;
            recordInputCost(session, { inputItemHrid: GEM, units });
        }
        expect(session.costs.input.cost).toBe(400 + 480 + 1200);
        expect(resolveInputCost(session, 20, today(GEM)).cost).toBe(2080);
    });

    test('a message with no price saves nothing, never a zero cost, and a later price reads it at today', () => {
        const session = {};
        recordInputCost(session, { inputItemHrid: GEM, units: 4 });
        delete mocks.prices[GEM];
        recordInputCost(session, { inputItemHrid: GEM, units: 6 });
        // The market has it again by the time anyone looks; the unpriced part stays unpriced
        mocks.prices[GEM] = 500;

        expect(session.costs.input).toMatchObject({ cost: 400, units: 4 });
        const resolved = resolveInputCost(session, 10, today(GEM));
        expect(resolved.cost).toBe(400 + 6 * 500);
        expect(resolved).toMatchObject({ unpriced: false, todayUnits: 6, pricedToday: true });
        delete mocks.prices[GEM];
        expect(resolveInputCost(session, 10, today(GEM))).toMatchObject({ unpriced: true, pricedToday: false });
    });

    test('a lookup that throws saves nothing: not a free input and not a lost attempt', () => {
        const session = {};
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        mocks.throwOnPrice = true;
        recordInputCost(session, { inputItemHrid: GEM, units: 7 });
        errors.mockRestore();
        expect(session.costs).toBeUndefined();
    });

    test('an enhanced input is priced at its own level', () => {
        const session = {};
        recordInputCost(session, { inputItemHrid: GEM, enhancementLevel: 8, units: 2 });
        expect(mocks.calls.at(-1)).toMatchObject({
            itemHrid: GEM,
            enhancementLevel: 8,
            side: 'buy',
            context: 'profit',
        });
    });

    test('nothing consumed records nothing', () => {
        const session = {};
        recordInputCost(session, { inputItemHrid: GEM, units: 0 });
        recordCatalystCost(session, PRIME, 0);
        expect(session.costs).toBeUndefined();
    });

    test('a refined cape is costed by the cape rule and the saved figure stands when the cape value later changes', () => {
        mocks.capes.add(CAPE);
        mocks.prices[CAPE] = 0;
        mocks.capeValue = { value: 79_000_000, partial: false };
        const session = {};
        recordInputCost(session, { inputItemHrid: CAPE, units: 1 });

        expect(session.costs.input.cost).toBe(79_000_000);
        expect(session.costs.input.bases).toEqual({ 'untradable-cape value': 1 });

        // The base-cape setting (or the bill) changes later: the recorded cost is not restated
        mocks.capeValue = { value: 12_000_000, partial: false };
        const resolved = resolveInputCost(session, 1, () => ({ price: 12_000_000, basis: 'untradable-cape value' }));
        expect(resolved.cost).toBe(79_000_000);
        expect(resolved.basis).toBe('untradable-cape value');
    });

    test('a priced zero (the base cape counted as nothing) is saved as the zero it is, not as unpriced', () => {
        const BASE_CAPE = '/items/gatherer_cape';
        mocks.capes.add(BASE_CAPE);
        mocks.prices[BASE_CAPE] = 0;
        // The cape value only has a floor to give: the setting values the unrefined +0 cape at nothing
        mocks.capeValue = { value: 0, partial: true };
        const session = {};
        recordInputCost(session, { inputItemHrid: BASE_CAPE, units: 2 });

        expect(session.costs.input).toMatchObject({ cost: 0, units: 2 });
        expect(session.costs.input.bases).toEqual({ 'cape setting: base cape counted as nothing': 2 });
        expect(resolveInputCost(session, 2, today(BASE_CAPE)).unpriced).toBe(false);
    });

    test('the number of bases kept is bounded', () => {
        const session = {};
        for (let i = 0; i < 12; i++) {
            session.costs ||= { input: { cost: 0, units: 0, bases: {} } };
            session.costs.input.bases[`basis ${i}`] = 1;
        }
        // Recording another message under yet another basis folds into the overflow bucket
        mocks.capes.add(CAPE);
        mocks.prices[CAPE] = 0;
        mocks.capeValue = { value: 5, partial: false };
        recordInputCost(session, { inputItemHrid: CAPE, units: 1 });
        expect(Object.keys(session.costs.input.bases)).toContain('mixed');
    });
});

describe('recording what a catalyst cost at the time', () => {
    test('priced per message; an unpriced message is left uncovered', () => {
        const session = {};
        recordCatalystCost(session, PRIME, 2);
        mocks.prices[PRIME] = 1500;
        recordCatalystCost(session, PRIME, 4);
        delete mocks.prices[PRIME];
        recordCatalystCost(session, PRIME, 3);

        expect(session.costs.catalysts[PRIME]).toEqual({ cost: 2 * 1000 + 4 * 1500, count: 6 });
        mocks.prices[PRIME] = 9999;
        const resolved = resolveCatalystCost(session, PRIME, 9, todayCatalyst);
        expect(resolved.cost).toBe(8000 + 3 * 9999);
        expect(resolved).toMatchObject({ unpriced: false, pricedToday: true });
        delete mocks.prices[PRIME];
        expect(resolveCatalystCost(session, PRIME, 9, todayCatalyst)).toMatchObject({ unpriced: true });
    });
});

describe('reading a session back', () => {
    test('a session with no saved costs is priced at today and says so', () => {
        const resolved = resolveInputCost({}, 10, today(GEM));
        expect(resolved).toMatchObject({ cost: 1000, hasSaved: false, pricedToday: true, todayUnits: 10 });
        expect(
            formatInputCostLine({ netConsumed: 10, inputCost: 1000, inputBasis: 'current buy', inputTodayUnits: 10 })
        ).toContain("at today's price");
    });

    test('an old session with an unpriced input is unpriced, not "at today\'s price"', () => {
        delete mocks.prices[GEM];
        const resolved = resolveInputCost({}, 10, today(GEM));
        expect(resolved.unpriced).toBe(true);
        expect(resolved.pricedToday).toBe(false);
    });

    test('a record covering part of the run prices the rest at today', () => {
        const session = { costs: { input: { cost: 400, units: 4, bases: { 'current buy': 4 } } } };
        mocks.prices[GEM] = 250;
        const resolved = resolveInputCost(session, 10, today(GEM));
        expect(resolved.cost).toBe(400 + 6 * 250);
        expect(resolved).toMatchObject({ savedUnits: 4, todayUnits: 6, pricedToday: true });
        const line = formatInputCostLine({
            netConsumed: 10,
            inputCost: resolved.cost,
            inputBasis: resolved.basis,
            inputSavedUnits: 4,
            inputTodayUnits: 6,
        });
        expect(line).toContain('4 at the price saved at the time');
        expect(line).toContain("6 at today's price");
    });

    test('a fully saved session reads as saved', () => {
        const line = formatInputCostLine({
            netConsumed: 10,
            inputCost: 1000,
            inputBasis: 'current buy',
            inputSavedUnits: 10,
        });
        expect(line).toContain('price saved at the time');
        expect(line).not.toContain("today's");
    });

    test('a hand-lowered attempt count lowers the saved cost with it', () => {
        const session = { costs: { input: { cost: 1000, units: 10, bases: { 'current buy': 10 } } } };
        const resolved = resolveInputCost(session, 5, today(GEM));
        expect(resolved.cost).toBe(500);
        expect(resolved.todayUnits).toBe(0);
    });

    test('catalysts: the same coverage rule', () => {
        const session = { costs: { catalysts: { [PRIME]: { cost: 1000, count: 1 } } } };
        mocks.prices[PRIME] = 2000;
        const resolved = resolveCatalystCost(session, PRIME, 3, todayCatalyst);
        expect(resolved.cost).toBe(1000 + 2 * 2000);
        expect(resolved.pricedToday).toBe(true);
        // A catalyst the session saved nothing for at all
        expect(resolveCatalystCost({}, PRIME, 3, todayCatalyst)).toMatchObject({ cost: 6000, pricedToday: true });
        expect(TODAYS_PRICE_MARK).toBe('≈');
    });
});

describe('two copies and two parts of one session', () => {
    const recorded = (units, cost) => ({
        input: { cost, units, bases: { 'current buy': units } },
        catalysts: { [PRIME]: { cost: units * 10, count: units } },
    });

    test('merging a recorded part with an unrecorded one adds coverage, and the rest reads at today', () => {
        const merged = mergeCosts(recorded(10, 1000), undefined);
        expect(merged.input.units).toBe(10);
        const both = mergeCosts(recorded(10, 1000), recorded(5, 700));
        expect(both.input).toMatchObject({ cost: 1700, units: 15 });
        expect(both.input.bases).toEqual({ 'current buy': 15 });
        expect(mergeCosts(undefined, undefined)).toBeUndefined();
    });

    test('a reload-split merge keeps the recorded part when the other part has none', () => {
        const a = {
            id: 'a',
            startTime: 0,
            lastActivityTime: 10_000,
            inputItemHrid: GEM,
            totalAttempts: 10,
            totalSuccesses: 5,
            costs: recorded(10, 1000),
        };
        const b = {
            id: 'b',
            startTime: 10_500,
            lastActivityTime: 20_000,
            inputItemHrid: GEM,
            totalAttempts: 10,
            totalSuccesses: 5,
        };
        // The recorded part first, and last: the fold used to keep only the first part's record
        const withCosts = (session, costs) => ({ ...session, costs });
        for (const [first, second] of [
            [a, b],
            [{ ...a, costs: undefined }, withCosts(b, recorded(10, 1000))],
        ]) {
            const [merged, ...rest] = mergeReloadSplitSessions([first, second]);
            expect(rest).toHaveLength(0);
            expect(merged.totalAttempts).toBe(20);
            expect(merged.costs.input.units).toBe(10);
            // Ten of the twenty are covered; the other ten read at today
            expect(resolveInputCost(merged, 20, today(GEM))).toMatchObject({ savedUnits: 10, todayUnits: 10 });
        }
    });

    test('a sync keeps the copy with more attempts and does not drop the costs the other one carries', () => {
        const older = { id: 's', totalAttempts: 40, costs: recorded(40, 4000) };
        const newer = { id: 's', totalAttempts: 60 }; // recorded on a build that saves none
        const kept = mergeSessionCopies(older, newer);
        expect(kept.totalAttempts).toBe(60);
        expect(kept.costs.input.units).toBe(40);

        // And the other way round: both carry them, the longer wins
        const both = mergeSessionCopies(older, { id: 's', totalAttempts: 60, costs: recorded(60, 6500) });
        expect(both.costs.input.cost).toBe(6500);
        // Neither carries any: nothing invented
        expect(mergeSessionCopies({ id: 's', totalAttempts: 1 }, { id: 's', totalAttempts: 2 }).costs).toBeUndefined();
        expect(pickCosts(undefined, undefined)).toBeUndefined();
    });
});

describe('an imported file', () => {
    test('a file with no costs (an old backup) is fine', () => {
        expect(validateCosts({})).toBeNull();
    });

    test('a well-formed record passes and malformed ones are named', () => {
        expect(
            validateCosts({
                input: { cost: 1, units: 1, bases: { x: 1 } },
                catalysts: { [PRIME]: { cost: 1, count: 1 } },
            })
        ).toBeNull();
        expect(validateCosts('nope')).toMatch(/non-object costs/);
        expect(validateCosts({ input: { cost: -1, units: 1, unpricedUnits: 0 } })).toMatch(/costs\.input\.cost/);
        expect(validateCosts({ input: { cost: 1, units: 'x', unpricedUnits: 0 } })).toMatch(/costs\.input\.units/);
        expect(validateCosts({ catalysts: { [PRIME]: { cost: 1, count: NaN } } })).toMatch(/count/);
    });
});

describe('review follow-ups', () => {
    test("a saved cost carries the pricing mode, and the hover says so when today's differs, without repricing", () => {
        const session = {};
        recordInputCost(session, { inputItemHrid: GEM, units: 4 });
        expect(session.costs.input.mode).toBe('ask');
        mocks.mode = 'bid';
        recordInputCost(session, { inputItemHrid: GEM, units: 2 });
        expect(session.costs.input.mode).toBe('mixed');

        const only = {};
        mocks.mode = 'ask';
        recordInputCost(only, { inputItemHrid: GEM, units: 4 });
        mocks.prices[GEM] = 900;
        const resolved = resolveInputCost(only, 4, today(GEM));
        expect(resolved.cost).toBe(400);
        const line = formatInputCostLine({
            netConsumed: 4,
            inputCost: resolved.cost,
            inputBasis: resolved.basis,
            inputSavedUnits: resolved.savedUnits,
            inputTodayUnits: resolved.todayUnits,
            inputSavedMode: resolved.mode,
            inputTodayMode: 'bid',
        });
        expect(line).toContain('saved under ask pricing; today');
        expect(
            formatInputCostLine({
                netConsumed: 4,
                inputCost: 400,
                inputBasis: 'current buy',
                inputSavedUnits: 4,
                inputSavedMode: 'ask',
                inputTodayMode: 'ask',
            })
        ).not.toContain('saved under');
    });

    test('the tracker and the viewer count units with one bulk rule', () => {
        const details = { alchemyDetail: { bulkMultiplier: 5 } };
        expect(resolveBulk({ bulkMultiplier: 3 }, details)).toBe(3);
        expect(resolveBulk({}, details)).toBe(5);
        expect(resolveBulk({}, null)).toBe(1);
    });

    test('pickCosts is order independent on a tie and lets input coverage outrank catalysts', () => {
        const a = { input: { cost: 100, units: 10, bases: {} }, catalysts: { [PRIME]: { cost: 1, count: 1 } } };
        const b = { input: { cost: 200, units: 10, bases: {} }, catalysts: { [PRIME]: { cost: 1, count: 1 } } };
        expect(pickCosts(a, b)).toBe(pickCosts(b, a));

        const moreInput = { input: { cost: 1, units: 20, bases: {} } };
        const moreCatalyst = {
            input: { cost: 1, units: 10, bases: {} },
            catalysts: { [PRIME]: { cost: 9, count: 500 } },
        };
        expect(pickCosts(moreInput, moreCatalyst)).toBe(moreInput);
        expect(pickCosts(moreCatalyst, moreInput)).toBe(moreInput);
    });

    test('an import of an older file keeps the stored costs; one that carries costs replaces them', () => {
        const costs = { input: { cost: 1000, units: 10, bases: { x: 10 } } };
        const stored = [{ id: 's1', totalAttempts: 10, totalSuccesses: 5, bulkMultiplier: 1, costs }];

        const older = { id: 's1', totalAttempts: 10, totalSuccesses: 5, bulkMultiplier: 1 };
        expect(planAlchemyImportMerge(stored, [older], 5).merged[0]).toBe(stored[0]);

        const edited = { ...older, totalSuccesses: 4 };
        expect(planAlchemyImportMerge(stored, [edited], 5).merged[0]).toMatchObject({ costs, totalSuccesses: 4 });

        const own = { input: { cost: 7, units: 10, bases: {} } };
        expect(planAlchemyImportMerge(stored, [{ ...older, costs: own }], 5).merged[0].costs).toEqual(own);
    });

    test('a hand-lowered count is rescaled at import, so later ticks are not diluted', () => {
        const stored = [];
        const edited = {
            id: 's1',
            totalAttempts: 5,
            totalSuccesses: 2,
            bulkMultiplier: 1,
            costs: { input: { cost: 1000, units: 10, bases: { 'current buy': 10 } } },
        };
        const [session] = planAlchemyImportMerge(stored, [edited], 5).merged;
        expect(session.costs.input).toMatchObject({ cost: 500, units: 5 });

        // Five more attempts run at 200 after the edit
        mocks.prices[GEM] = 200;
        session.totalAttempts += 5;
        recordInputCost(session, { inputItemHrid: GEM, units: 5 });
        const resolved = resolveInputCost(session, 10, today(GEM));
        expect(resolved.cost).toBe(500 + 1000);
        expect(rescaleCosts({ ...session }).input.cost).toBe(1500);
    });

    describe('a hand edit that takes a catalyst out of catalystsUsed', () => {
        const OTHER = '/items/catalyst_of_transmutation';
        const THIRD = '/items/catalyst_of_coinification';
        const base = {
            id: 's1',
            startTime: 1,
            inputItemHrid: GEM,
            totalAttempts: 30,
            totalSuccesses: 15,
            bulkMultiplier: 1,
            lastActivityTime: 100,
        };
        const stored = () => ({
            ...base,
            catalystsUsed: { [PRIME]: 10, [OTHER]: 4 },
            costs: {
                catalysts: {
                    [PRIME]: { cost: 1000, count: 10 },
                    [OTHER]: { cost: 40, count: 4 },
                },
            },
        });
        /** The file as a person corrected it: the prime catalyst gone from the counts, its costs left alone */
        const corrected = () => ({ ...stored(), catalystsUsed: { [OTHER]: 4 } });

        test('its coverage goes too, so a resumed run is costed at what it paid', () => {
            const [session] = planAlchemyImportMerge([stored()], [corrected()], 5).merged;
            expect(session.costs.catalysts[PRIME]).toBeUndefined();
            expect(session.costs.catalysts[OTHER]).toEqual({ cost: 40, count: 4 });

            // The run resumes: five more prime catalysts at 200 each, 1,000 in all
            mocks.prices[PRIME] = 200;
            session.catalystsUsed[PRIME] = 5;
            recordCatalystCost(session, PRIME, 5);
            expect(resolveCatalystCost(session, PRIME, 5, today(PRIME)).cost).toBe(1000);
        });

        test('the catalyst read back with nothing consumed asks for no price at all', () => {
            const [session] = planAlchemyImportMerge([stored()], [corrected()], 5).merged;
            expect(resolveCatalystCost(session, PRIME, 0, () => null)).toEqual({
                cost: 0,
                unpriced: false,
                pricedToday: false,
            });
        });

        test('three catalysts, one left out: only that one goes, and a zero count stays a zero record', () => {
            const edited = {
                ...base,
                catalystsUsed: { [OTHER]: 2, [THIRD]: 0 },
                costs: {
                    catalysts: {
                        [PRIME]: { cost: 1000, count: 10 },
                        [OTHER]: { cost: 40, count: 4 },
                        [THIRD]: { cost: 90, count: 3 },
                    },
                },
            };
            expect(rescaleCosts(edited).catalysts).toEqual({
                [OTHER]: { cost: 20, count: 2 },
                [THIRD]: { cost: 0, count: 0 },
            });
        });

        test('with no catalystsUsed at all nothing is said about catalysts, and the record stands', () => {
            const { catalystsUsed: _gone, ...older } = stored();
            expect(rescaleCosts(older).catalysts).toEqual(stored().costs.catalysts);
        });

        test('coinify and decompose read their legacy counters, so one of those still holds the coverage', () => {
            const legacy = { ...corrected(), primeCatalystUsed: 6 };
            expect(rescaleCosts(legacy).catalysts[PRIME]).toEqual({ cost: 600, count: 6 });
            expect(rescaleCosts({ ...corrected(), primeCatalystUsed: 0 }).catalysts[PRIME]).toBeUndefined();
        });

        test('two devices: the correction wins a pull in either order, costs and all', () => {
            const [edited] = planAlchemyImportMerge([stored()], [corrected()], 500).merged;
            const unedited = stored();
            for (const merged of [mergeSessionCopies(edited, unedited), mergeSessionCopies(unedited, edited)]) {
                expect(merged.catalystsUsed).toEqual({ [OTHER]: 4 });
                expect(merged.costs.catalysts[PRIME]).toBeUndefined();
            }
        });

        test('a replay of the pull changes nothing, and neither does a re-import of the stored copy', () => {
            const [edited] = planAlchemyImportMerge([stored()], [corrected()], 500).merged;
            expect(mergeSessionCopies(edited, edited)).toEqual(edited);
            expect(planAlchemyImportMerge([edited], [edited], 900).merged[0]).toBe(edited);
        });

        test('an edit followed by new data: a device that recorded past the correction keeps its own whole', () => {
            const [edited] = planAlchemyImportMerge([stored()], [corrected()], 500).merged;
            const resumed = structuredClone(edited);
            resumed.lastActivityTime = 900;
            resumed.catalystsUsed[PRIME] = 5;
            recordCatalystCost(resumed, PRIME, 5);
            const merged = mergeSessionCopies(edited, resumed);
            expect(merged.catalystsUsed[PRIME]).toBe(5);
            expect(merged.costs.catalysts[PRIME].count).toBe(5);
        });

        test('an older build reads the new record: the entry is simply absent, as on a session without one', () => {
            const [session] = planAlchemyImportMerge([stored()], [corrected()], 5).merged;
            expect(validateCosts(session.costs)).toBeNull();
            expect(mergeCosts(session.costs, undefined).catalysts).toEqual({ [OTHER]: { cost: 40, count: 4 } });
        });
    });
});
