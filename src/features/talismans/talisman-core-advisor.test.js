import { describe, test, expect, vi, beforeEach } from 'vitest';
import { BELT_ITEMS } from '../../__fixtures__/talisman-bonuses.js';
import { TALISMAN_INFO } from '../../__fixtures__/talisman-reroll.js';

const mocks = vi.hoisted(() => ({ test: true }));

vi.mock('../../utils/game-server.js', async (importOriginal) => ({
    ...(await importOriginal()),
    isTestServer: () => mocks.test,
}));
vi.mock('../enhancement/enhancement-params-source.js', () => ({
    enhancementParamsFor: () => ({ paramsSource: 'auto' }),
    benchNote: () => null,
}));
vi.mock('../../utils/market-data.js', () => ({ getItemPriceInfo: () => ({ price: null, source: null }) }));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => false, getSettingValue: (key, fallback) => fallback },
}));
vi.mock('../../core/data-manager.js', () => ({ default: { getInitClientData: () => ({}) } }));

const { adviseCores, coreQuoteKey, nextLineCost, talismanTypeOf } = await import('./talisman-core-advisor.js');
const { rateRow } = await import('./talisman-belt-advisor.js');
const { gradeOdds } = await import('../../utils/talisman-reroll-solver.js');

const COMBAT = '/talisman_types/combat';
const SKILLING = '/talisman_types/skilling';
const BASIC = '/items/basic_talisman_core';
const ADVANCED = '/items/advanced_talisman_core';
const EXPERT = '/items/expert_talisman_core';
const ITEMS = {
    ...BELT_ITEMS,
    [BASIC]: { name: 'Basic Talisman Core' },
    [ADVANCED]: { name: 'Advanced Talisman Core' },
    [EXPERT]: { name: 'Expert Talisman Core' },
};
const H = (name) => `/talisman_modifiers/${name}`;
// The game's shape: keyed by hrid, with the draw weight, group, type and six grade values
const mod = (name, weight, extra = {}) => ({
    hrid: H(name),
    name,
    talismanTypeHrid: COMBAT,
    weight,
    groupHrid: weight < 1 ? '/talisman_modifier_groups/special' : '/talisman_modifier_groups/offense',
    gradeValues: [1, 2, 3, 4, 5, 6],
    ...extra,
});
const DETAILS = Object.fromEntries(
    [
        mod('a', 1),
        mod('b', 1),
        mod('c', 1),
        mod('zero', 1),
        mod('unreal', 1),
        mod('nogo', 1),
        mod('echo', 0.1),
        mod('mine', 1, { talismanTypeHrid: SKILLING }),
    ].map((d) => [d.hrid, d])
);
const GAME = { talismanInfo: TALISMAN_INFO, talismanModifierDetailMap: DETAILS, itemDetailMap: ITEMS };

/** A ranking row: `per` times the grade at each grade 1..6 */
const row = (name, per, extra = {}) => ({
    hrid: H(name),
    name,
    byGrade: [1, 2, 3, 4, 5, 6].map((g) => per * g),
    value: per * 3,
    significant: true,
    ...extra,
});
const ranking = (rows, extra = {}) => ({
    status: 'done',
    rows,
    power: 0.5,
    slots: 3,
    grade: 3,
    metricKey: 'dps',
    ...extra,
});
const worn = (slotIndex, names, extra = {}) => ({
    id: 100 + slotIndex,
    talismanTypeHrid: COMBAT,
    slotIndex,
    modifiers: names.map((n) => ({ hrid: H(n), grade: 1 })),
    ...extra,
});
const book = (price) => ({ price, source: 'book', estimated: false });
const none = { price: null, source: null, estimated: false };
const prices = (map) => (hrid) => (map[hrid] ? book(map[hrid]) : none);

const run = (over = {}) =>
    adviseCores({
        talismans: [worn(1, ['a'])],
        ranking: ranking([row('a', 1), row('b', 2), row('c', 3)]),
        power: 0.5,
        typeHrid: COMBAT,
        gameData: GAME,
        priceInfo: prices({}),
        ...over,
    });
const odds = gradeOdds(3);
const S = odds.reduce((sum, p, i) => sum + p * (i + 1), 0); // expected grade of a core line

beforeEach(() => {
    mocks.test = true;
});

describe('nextLineCost', () => {
    test('reads the core and count for that line from the game data', () => {
        expect(nextLineCost(TALISMAN_INFO, ITEMS, 2, prices({ [BASIC]: 1000 }))).toMatchObject({
            price: 5000,
            itemHrid: BASIC,
            count: 5,
        });
        expect(nextLineCost(TALISMAN_INFO, ITEMS, 4, prices({ [EXPERT]: 7e6 })).price).toBe(7e6);
    });

    test('a missing quote is unpriced with the reason, never zero', () => {
        const cost = nextLineCost(TALISMAN_INFO, ITEMS, 2, prices({}));
        expect(cost.price).toBeNull();
        expect(cost.reason).toContain('5 × Basic Talisman Core');
    });

    test('a value-map estimate or a zero price is not a price', () => {
        expect(
            nextLineCost(TALISMAN_INFO, ITEMS, 3, () => ({ price: 123, source: 'value', estimated: true })).price
        ).toBeNull();
        expect(nextLineCost(TALISMAN_INFO, ITEMS, 3, () => book(0)).price).toBeNull();
    });

    test('no entry, or a zero count, for the line is unpriced, not free', () => {
        expect(nextLineCost(TALISMAN_INFO, ITEMS, 5, prices({ [BASIC]: 1 })).price).toBeNull();
        const info = { addModifierInputMap: { 2: { itemHrid: BASIC, count: 0 } } };
        expect(nextLineCost(info, ITEMS, 2, prices({ [BASIC]: 1 })).price).toBeNull();
        expect(nextLineCost(null, ITEMS, 2, prices({ [BASIC]: 1 })).price).toBeNull();
    });

    test('coreQuoteKey lists the unit quote of each core, null when unlisted', () => {
        expect(coreQuoteKey(TALISMAN_INFO, ITEMS, prices({ [EXPERT]: 9 }))).toEqual({
            [BASIC]: null,
            [ADVANCED]: null,
            [EXPERT]: 9,
        });
    });
});

describe('adviseCores: the draw', () => {
    test('expected gain is the weighted average over types the talisman does not hold, at G1-G3', () => {
        // Holding a: rollable b c zero unreal nogo (1 each) and echo (0.1)
        const r = run({ ranking: ranking([row('a', 1), row('b', 2), row('c', 3)]) });
        expect(r.status).toBe('done');
        expect(r.rows[0].value).toBeCloseTo((1 / 5.1) * 2 * S + (1 / 5.1) * 3 * S, 10);
    });

    test('types with no ranking row keep their share of the draw and count 0', () => {
        const r = run({ ranking: ranking([row('b', 2)]) });
        expect(r.rows[0].value).toBeCloseTo((1 / 5.1) * 2 * S, 10);
        expect(r.rows[0].unvaluedShare).toBeCloseTo(4.1 / 5.1, 10);
    });

    test('a special line draws at its weight 0.1', () => {
        const r = run({ ranking: ranking([row('echo', 100)]) });
        expect(r.rows[0].value).toBeCloseTo((0.1 / 5.1) * 100 * S, 10);
    });

    test('a type the talisman already holds cannot roll', () => {
        const r = run({
            talismans: [worn(1, ['a', 'b'])],
            ranking: ranking([row('a', 50), row('b', 50), row('c', 3)]),
        });
        expect(r.rows[0].value).toBeCloseTo((1 / 4.1) * 3 * S, 10);
        expect(r.rows[0].lineNumber).toBe(3);
    });

    test('a type of another talisman type is not in the pool', () => {
        const r = run({ ranking: ranking([row('mine', 99)]) });
        expect(r.rows[0].value).toBe(0);
    });

    test('a type worn on another talisman adds its later-copy marginal, not its first-copy value', () => {
        // G3: first copy 30, three copies 40, so a later copy adds (40 - 30) / 2 = 5
        const rows = [row('b', 10, { copiesValue: 40 })];
        const alone = run({ talismans: [worn(1, ['a'])], ranking: ranking(rows) });
        const shared = run({ talismans: [worn(1, ['a']), worn(2, ['b'])], ranking: ranking(rows) });
        const slot1 = shared.rows.find((x) => x.slotIndex === 1);
        expect(slot1.value).toBeCloseTo(alone.rows[0].value * (5 / 30), 10);
        // the talisman holding b cannot roll b at all
        expect(shared.rows.find((x) => x.slotIndex === 2).value).toBe(0);
    });

    test('a row never measured with copies is assumed linear and marked', () => {
        const rows = [row('b', 10)];
        const shared = run({ talismans: [worn(1, ['a']), worn(2, ['b'])], ranking: ranking(rows) });
        expect(shared.rows.find((x) => x.slotIndex === 1).assumedShare).toBeGreaterThan(0);
        expect(run({ talismans: [worn(1, ['a'])], ranking: ranking(rows) }).rows[0].assumedShare).toBe(0);
    });

    test('a gainUnreal row counts 0 and is said', () => {
        const r = run({ ranking: ranking([row('unreal', 100, { gainUnreal: true }), row('b', 2)]) });
        expect(r.rows[0].value).toBeCloseTo((1 / 5.1) * 2 * S, 10);
        expect(r.rows[0].unrealShare).toBeCloseTo(1 / 5.1, 10);
    });

    test('mechanic and non-linear lines mark the row by their share of the gain', () => {
        const half = run({ ranking: ranking([row('b', 2, { mechanic: true }), row('c', 2)]) });
        expect(half.rows[0].mechanicShare).toBeCloseTo(0.5, 10);
        expect(run({ ranking: ranking([row('b', 2), row('c', 2)]) }).rows[0].mechanicShare).toBe(0);
        expect(run({ ranking: ranking([row('b', 2, { nonlinear: true })]) }).rows[0].mechanicShare).toBe(1);
    });

    test('a line that costs the build something counts negative, it is not clamped', () => {
        const r = run({ ranking: ranking([row('b', -2)]) });
        expect(r.rows[0].value).toBeCloseTo((1 / 5.1) * -2 * S, 10);
        expect(r.rows[0].pUseful).toBe(0);
    });

    test('chance of a useful line and the best outcome', () => {
        const r = run({ ranking: ranking([row('b', 2), row('c', 3), row('zero', 0)]) });
        expect(r.rows[0].pUseful).toBeCloseTo(2 / 5.1, 10);
        expect(r.rows[0].best).toMatchObject({ hrid: H('c'), grade: 3, value: 9 });
        expect(r.rows[0].best.chance).toBeCloseTo((1 / 5.1) * odds[2], 10);
    });
});

describe('adviseCores: cost and order', () => {
    test('unpriced is the common case: the gain shows, no ratio, labelled', () => {
        const x = run().rows[0];
        expect(x.value).toBeGreaterThan(0);
        expect(x.costs.market.price).toBeNull();
        expect(rateRow(x, 'market')).toMatchObject({ kind: 'unpriced' });
        expect(rateRow(x, 'market').per100m).toBeUndefined();
    });

    test('talismans with 1, 2 and 3 lines pay for lines 2, 3 and 4; an expert core priced but a basic one not', () => {
        const r = run({
            talismans: [worn(1, ['a']), worn(2, ['a', 'b']), worn(3, ['a', 'b', 'c'])],
            priceInfo: prices({ [EXPERT]: 4e7, [ADVANCED]: 1e6 }),
        });
        const by = (slot) => r.rows.find((x) => x.slotIndex === slot);
        expect(by(1).lineNumber).toBe(2);
        expect(by(1).costs.market.price).toBeNull();
        expect(by(2).costs.market.price).toBe(1e6);
        expect(by(3).costs.market.price).toBe(4e7);
    });

    test('priced and positive: gain per 100m, and unpriced rows sort last whatever their gain', () => {
        const r = run({
            talismans: [worn(1, ['a']), worn(2, ['a', 'b'])],
            ranking: ranking([row('a', 1), row('b', 2), row('c', 300)]),
            priceInfo: prices({ [ADVANCED]: 1e6 }),
        });
        expect(r.rows.map((x) => x.slotIndex)).toEqual([2, 1]);
        const rate = rateRow(r.rows[0], 'market');
        expect(rate.kind).toBe('ratio');
        expect(rate.per100m).toBeCloseTo((r.rows[0].value / 1e6) * 1e8, 8);
        expect(rateRow(r.rows[1], 'market').kind).toBe('unpriced');
    });

    test('zero gain: priced but no ratio', () => {
        const r = run({ ranking: ranking([row('zero', 0), row('b', 0)]), priceInfo: prices({ [BASIC]: 10 }) });
        expect(r.rows[0].value).toBe(0);
        expect(r.rows[0].pUseful).toBe(0);
        expect(r.rows[0].best).toBeNull();
        expect(rateRow(r.rows[0], 'market')).toMatchObject({ kind: 'none', why: 'No gain.' });
    });

    test('a gain within the ranking noise gets no ratio', () => {
        const r = run({
            ranking: ranking([row('b', 2, { significant: false }), row('c', 2, { significant: false })]),
            priceInfo: prices({ [BASIC]: 10 }),
        });
        expect(r.rows[0].value).toBeGreaterThan(0);
        expect(r.rows[0].significant).toBe(false);
        expect(rateRow(r.rows[0], 'market')).toMatchObject({ kind: 'none', why: 'The gain is within noise.' });
    });

    test('a gain mostly from real rows stays significant', () => {
        const r = run({ ranking: ranking([row('b', 2), row('c', 1, { significant: false })]) });
        expect(r.rows[0].significant).toBe(true);
    });
});

describe('adviseCores: every other ending', () => {
    test('no talisman of the type is worn', () => {
        const skilling = { ...worn(1, ['mine']), talismanTypeHrid: SKILLING };
        expect(run({ talismans: [skilling] })).toMatchObject({ status: 'refused', reason: 'no_talisman' });
        expect(run({ talismans: [] })).toMatchObject({ reason: 'no_talisman' });
    });

    test('the type is read from the lines when a record carries none (sim DTO talismans)', () => {
        const dto = { slotIndex: 1, modifiers: [{ hrid: H('a'), grade: 1 }] };
        expect(talismanTypeOf(dto, DETAILS)).toBe(COMBAT);
        expect(run({ talismans: [dto] }).status).toBe('done');
    });

    test('every worn talisman already has 4 lines', () => {
        expect(run({ talismans: [worn(1, ['a', 'b', 'c', 'zero'])] })).toMatchObject({
            status: 'refused',
            reason: 'all_full',
        });
    });

    test('a full talisman is left out while another has room', () => {
        const r = run({ talismans: [worn(1, ['a', 'b', 'c', 'zero']), worn(2, ['a'])] });
        expect(r.rows.map((x) => x.slotIndex)).toEqual([2]);
    });

    test('the ranking has not run, stopped early, or has no rows', () => {
        const never = run({ ranking: null });
        expect(never.reason).toBe('no_ranking');
        expect(never.message).toContain('Run the ranking first');
        const stopped = run({ ranking: ranking([row('b', 1)], { status: 'stopped' }) });
        expect(stopped.reason).toBe('no_ranking');
        expect(stopped.message).toContain('stopped early');
        expect(run({ ranking: ranking([]) }).reason).toBe('no_ranking');
    });

    test('a ranking run with another belt is not used', () => {
        expect(run({ ranking: ranking([row('b', 1)], { power: 0.4 }) })).toMatchObject({ reason: 'other_belt' });
    });

    test('off the test server nothing is valued', () => {
        mocks.test = false;
        expect(run()).toMatchObject({ status: 'refused', reason: 'live' });
    });

    test('a ranking row with a missing output price makes every row that uses it a floor', () => {
        const r = run({
            talismans: [worn(1, ['a']), worn(2, ['b'])],
            ranking: ranking([row('a', 1), row('b', 2), row('c', 3, { hasMissingPrices: true })], {
                hasMissingPrices: true,
            }),
        });
        expect(r.hasMissingPrices).toBe(true);
        // c can roll on both talismans
        expect(r.rows.every((x) => x.hasMissingPrices)).toBe(true);
        const clean = run({ ranking: ranking([row('b', 2)]) });
        expect(clean.hasMissingPrices).toBe(false);
        expect(clean.rows[0].hasMissingPrices).toBe(false);
    });

    test('a flagged row that is not in the pool does not flag the row', () => {
        const r = run({ ranking: ranking([row('b', 2), row('a', 1, { hasMissingPrices: true })]) });
        // a is held by the only talisman, so it cannot roll
        expect(r.rows[0].hasMissingPrices).toBe(false);
    });

    test('a combat profit row with an unpriced extra input (costUnpriced, no gainUnreal) counts 0, like the belt advisor', () => {
        const rows = [row('b', 2), row('c', 100, { costUnpriced: ['Holy Cheese'], significant: false })];
        const profit = run({ ranking: ranking(rows, { metricKey: 'profit' }) });
        expect(profit.rows[0].value).toBeCloseTo((1 / 5.1) * 2 * S, 10);
        expect(profit.rows[0].unrealShare).toBeCloseTo(1 / 5.1, 10);
        expect(profit.rows[0].best).toMatchObject({ hrid: H('b') });
        // Rank by DPS: the unpriced input does not matter, the row counts
        const dps = run({ ranking: ranking(rows, { metricKey: 'dps' }) });
        expect(dps.rows[0].unrealShare).toBe(0);
        expect(dps.rows[0].value).toBeGreaterThan(profit.rows[0].value);
        const xp = run({ ranking: ranking(rows, { metricKey: 'xp' }) });
        expect(xp.rows[0].unrealShare).toBe(0);
        expect(xp.rows[0].value).toBeCloseTo(dps.rows[0].value, 10);
        // Balanced counts it only when profit has weight
        const weighted = run({ ranking: ranking(rows, { metricKey: 'balanced', balanceWeights: { profit: 1 } }) });
        expect(weighted.rows[0].unrealShare).toBeGreaterThan(0);
        const noProfit = run({ ranking: ranking(rows, { metricKey: 'balanced', balanceWeights: { profit: 0 } }) });
        expect(noProfit.rows[0].unrealShare).toBe(0);
    });
});
