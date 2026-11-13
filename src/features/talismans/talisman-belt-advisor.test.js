import { describe, test, expect, vi, beforeEach } from 'vitest';
import { BELT_ITEMS, TALISMAN_ENHANCEMENT_TABLE } from '../../__fixtures__/talisman-bonuses.js';
import { FULL_MODIFIER_DETAILS } from '../../__fixtures__/talisman-full-modifiers.js';

const mocks = vi.hoisted(() => ({
    test: true,
    testerSetting: false,
    /** (hrid, options) => {price, source}; set per test */
    price: null,
    shopMap: {},
}));

vi.mock('../../utils/game-server.js', async (importOriginal) => ({
    ...(await importOriginal()),
    isTestServer: () => mocks.test,
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPriceInfo: (hrid, options) => mocks.price(hrid, options),
}));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => (key === 'pricing_testerShop' ? mocks.testerSetting : undefined),
        getSettingValue: (key, fallback) => fallback,
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getInitClientData: () => ({ shopItemDetailMap: mocks.shopMap, itemDetailMap: BELT_ITEMS }) },
}));

const advisor = await import('./talisman-belt-advisor.js');
const { beltCandidates, beltCosts, listBelts, quoteBelt, rateRow, runSkillingBeltAdvisor, scaleBonuses, sortBeltRows } =
    advisor;
const { BELT_LOCATION, computeTalismanBonuses, talismanBonusesOf, attachTalismanBonuses } =
    await import('../../utils/talisman-bonuses.js');
const { calculateDirectEnhancementCost } = await import('../combat-sim/direct-enhancement-cost.js');

const SMALL = '/items/small_talisman_belt';
const MEDIUM = '/items/medium_talisman_belt';
const LARGE = '/items/large_talisman_belt';
const TABLE = TALISMAN_ENHANCEMENT_TABLE;
const book = (price) => ({ price, source: 'book', estimated: false });
const none = { price: null, source: null, estimated: false };

beforeEach(() => {
    mocks.test = true;
    mocks.testerSetting = false;
    mocks.shopMap = {};
    mocks.price = () => none;
});

describe('beltCandidates', () => {
    const keys = (list) => list.map((c) => c.key.replace('/items/', '').replace('_talisman_belt', ''));

    test('belts are listed smallest first', () => {
        expect(listBelts(BELT_ITEMS).map((b) => b.hrid)).toEqual([SMALL, MEDIUM, LARGE]);
    });

    test('a Small +0 is offered the next levels, the landmarks, and both larger belts at +0', () => {
        const list = beltCandidates({ hrid: SMALL, enhancementLevel: 0 }, BELT_ITEMS, TABLE);
        expect(keys(list)).toEqual([
            'small@1',
            'small@2',
            'small@3',
            'small@10',
            'small@15',
            'small@20',
            'medium@0',
            'large@0',
        ]);
        expect(list.find((c) => c.key === `${MEDIUM}@0`).emptySlots).toBe(1);
        expect(list.find((c) => c.key === `${LARGE}@0`).emptySlots).toBe(2);
        expect(list.find((c) => c.kind === 'enhance').emptySlots).toBe(0);
    });

    test('a Medium +4 is offered a Large at +0 and at +4, never a smaller belt', () => {
        const list = beltCandidates({ hrid: MEDIUM, enhancementLevel: 4 }, BELT_ITEMS, TABLE);
        expect(keys(list)).toEqual([
            'medium@5',
            'medium@6',
            'medium@7',
            'medium@10',
            'medium@15',
            'medium@20',
            'large@0',
            'large@4',
        ]);
    });

    test('the largest belt at a high level is offered only what is left, and at +20 nothing', () => {
        expect(keys(beltCandidates({ hrid: LARGE, enhancementLevel: 18 }, BELT_ITEMS, TABLE))).toEqual([
            'large@19',
            'large@20',
        ]);
        expect(keys(beltCandidates({ hrid: LARGE, enhancementLevel: 10 }, BELT_ITEMS, TABLE))).toEqual([
            'large@11',
            'large@12',
            'large@13',
            'large@15',
            'large@20',
        ]);
        expect(beltCandidates({ hrid: LARGE, enhancementLevel: 20 }, BELT_ITEMS, TABLE)).toEqual([]);
    });

    test('carries the measured Talisman Power (Large +10 is 0.258)', () => {
        const list = beltCandidates({ hrid: LARGE, enhancementLevel: 9 }, BELT_ITEMS, TABLE);
        expect(list.find((c) => c.level === 10).power).toBeCloseTo(0.258, 10);
    });

    test('no belt, or an item that is not a belt, is no candidates', () => {
        expect(beltCandidates(null, BELT_ITEMS, TABLE)).toEqual([]);
        expect(beltCandidates({ hrid: '/items/coin', enhancementLevel: 0 }, BELT_ITEMS, TABLE)).toEqual([]);
    });
});

describe('quoteBelt', () => {
    test('asks for a market quote on the profit pricing mode, with the level and side', () => {
        const seen = [];
        mocks.price = (hrid, options) => {
            seen.push([hrid, options]);
            return book(5);
        };
        expect(quoteBelt(LARGE, 7, 'buy', mocks.price)).toBe(5);
        expect(seen[0]).toEqual([LARGE, { enhancementLevel: 7, context: 'profit', side: 'buy', marketQuote: true }]);
    });

    test('a value-map estimate, a missing price, zero and a throwing reader are all no price (never zero)', () => {
        expect(quoteBelt(LARGE, 7, 'buy', () => ({ price: 99, source: 'value', estimated: true }))).toBeNull();
        expect(quoteBelt(LARGE, 7, 'buy', () => none)).toBeNull();
        expect(quoteBelt(LARGE, 7, 'buy', () => book(0))).toBeNull();
        expect(
            quoteBelt(LARGE, 7, 'buy', () => {
                throw new Error('boom');
            })
        ).toBeNull();
        expect(quoteBelt(LARGE, 7, 'buy', () => ({ price: 5, source: 'custom', estimated: false }))).toBe(5);
    });
});

describe('beltCosts', () => {
    const current = { hrid: MEDIUM, enhancementLevel: 4 };
    const sameBelt = beltCandidates(current, BELT_ITEMS, TABLE).find((c) => c.level === 10);
    const larger = beltCandidates(current, BELT_ITEMS, TABLE).find((c) => c.hrid === LARGE && c.level === 4);
    const prices = { [`${MEDIUM}@4`]: 100, [`${MEDIUM}@10`]: 1000, [`${LARGE}@4`]: 3000, [`${LARGE}@0`]: 500 };
    const priceInfo = (hrid, options) => {
        const price = prices[`${hrid}@${options.enhancementLevel}`];
        return price ? book(price) : none;
    };
    const afterTax = (price) => price * 0.96;

    test('market is the buy quote; net takes your belt off after tax', () => {
        const costs = beltCosts(sameBelt, current, BELT_ITEMS, {
            priceInfo,
            afterTax,
            testerOn: () => false,
            enhanceCost: () => 250,
        });
        expect(costs.market.price).toBe(1000);
        expect(costs.net).toEqual({ price: 1000 - Math.floor(100 * 0.96), resale: 96 });
        expect(costs.enhance.price).toBe(250);
    });

    test('an unpriced belt has no cost on any basis that needs it, and says why: never 0', () => {
        const costs = beltCosts(sameBelt, current, BELT_ITEMS, {
            priceInfo: () => none,
            afterTax,
            testerOn: () => false,
            enhanceCost: () => null,
        });
        expect(costs.market.price).toBeNull();
        expect(costs.market.reason).toMatch(/No market listing/);
        expect(costs.net.price).toBeNull();
        expect(costs.enhance.price).toBeNull();
        expect(costs.enhance.reason).toMatch(/cannot be estimated/);
    });

    test('net is unknown when your own belt has no listing, even if the candidate has one', () => {
        const costs = beltCosts(sameBelt, current, BELT_ITEMS, {
            priceInfo: (hrid, o) => (o.side === 'buy' ? book(1000) : none),
            afterTax,
            testerOn: () => false,
            enhanceCost: () => 1,
        });
        expect(costs.market.price).toBe(1000);
        expect(costs.net.price).toBeNull();
        expect(costs.net.reason).toMatch(/current belt has no market listing/);
    });

    test('a larger belt: enhance is the +0 purchase plus the enhancement from +0, from its own base', () => {
        const calls = [];
        const costs = beltCosts(larger, current, BELT_ITEMS, {
            priceInfo,
            afterTax,
            testerOn: () => false,
            enhanceCost: (hrid, from, to) => {
                calls.push([hrid, from, to]);
                return 40;
            },
        });
        expect(calls).toEqual([[LARGE, 0, 4]]);
        expect(costs.enhance.price).toBe(540);
        // Unpriced +0 base: nothing to enhance from
        const noBase = beltCosts(larger, current, BELT_ITEMS, {
            priceInfo: (hrid, o) => (o.enhancementLevel === 0 ? none : book(3000)),
            afterTax,
            testerOn: () => false,
            enhanceCost: () => 40,
        });
        expect(noBase.enhance.price).toBeNull();
    });

    test('a larger belt at +0 needs no enhancement', () => {
        const atZero = beltCandidates(current, BELT_ITEMS, TABLE).find((c) => c.hrid === LARGE && c.level === 0);
        const enhanceCost = vi.fn(() => 40);
        const costs = beltCosts(atZero, current, BELT_ITEMS, {
            priceInfo,
            afterTax,
            testerOn: () => false,
            enhanceCost,
        });
        expect(costs.enhance.price).toBe(500);
        expect(enhanceCost).not.toHaveBeenCalled();
    });

    test('Tester-shop pricing on: the enhancement estimate is withheld, and never asked', () => {
        const enhanceCost = vi.fn(() => 1);
        const costs = beltCosts(sameBelt, current, BELT_ITEMS, {
            priceInfo,
            afterTax,
            testerOn: () => true,
            enhanceCost,
        });
        expect(enhanceCost).not.toHaveBeenCalled();
        expect(costs.enhance.price).toBeNull();
        expect(costs.enhance.reason).toMatch(/Tester-shop/);
        // The market bases do not touch the shop
        expect(costs.market.price).toBe(1000);
    });

    test('with the real Tester-shop setting on and a tester entry selling the belt, nothing is priced from it', () => {
        mocks.testerSetting = true;
        mocks.shopMap = {
            '/shop_items/tester_large_belt': {
                itemHrid: LARGE,
                category: '/shop_categories/tester',
                enhancementLevel: 10,
                costs: [{ itemHrid: '/items/coin', count: 1000 }],
            },
        };
        // The premise: the shared estimate would answer from the shop
        expect(calculateDirectEnhancementCost(LARGE, 0, 10, { itemDetailMap: BELT_ITEMS })).toBe(1000);
        const candidate = beltCandidates({ hrid: SMALL, enhancementLevel: 0 }, BELT_ITEMS, TABLE).find(
            (c) => c.hrid === LARGE
        );
        const costs = beltCosts(candidate, { hrid: SMALL, enhancementLevel: 0 }, BELT_ITEMS, {
            priceInfo: () => none,
        });
        expect(costs.enhance.price).toBeNull();
        expect(costs.market.price).toBeNull();
    });
});

describe('rateRow and sortBeltRows', () => {
    const row = (value, price, extra = {}) => ({
        value,
        costs: { market: price === undefined ? { price: null, reason: 'no listing' } : { price } },
        ...extra,
    });

    test('a ratio only for a priced, positive, real gain at a positive cost', () => {
        expect(rateRow(row(5, 1e8), 'market')).toMatchObject({ kind: 'ratio', per100m: 5 });
        expect(rateRow(row(0, 1e8), 'market').kind).toBe('none');
        expect(rateRow(row(-3, 1e8), 'market').kind).toBe('none');
        expect(rateRow(row(5, 1e8, { significant: false }), 'market')).toMatchObject({ kind: 'none' });
        expect(rateRow(row(5, 1e8, { gainUnreal: true }), 'market').kind).toBe('none');
    });

    test('an unpriced row has no ratio, however large its gain', () => {
        expect(rateRow(row(1e9, undefined), 'market')).toMatchObject({ kind: 'unpriced', cost: null });
    });

    test('a cost at or below zero is free, never divided', () => {
        expect(rateRow(row(5, 0), 'market').kind).toBe('free');
        expect(rateRow(row(5, -300), 'market')).toMatchObject({ kind: 'free', cost: -300 });
        expect(rateRow(row(-5, -300), 'market').kind).toBe('none');
    });

    test('order: free, then gain per cost, then priced without a ratio, then unpriced by gain', () => {
        const rows = [
            { name: 'unpricedBig', ...row(1000, undefined) },
            { name: 'noise', ...row(50, 1e8, { significant: false }) },
            { name: 'cheap', ...row(2, 1e7) },
            { name: 'dear', ...row(9, 9e8) },
            { name: 'free', ...row(1, -5) },
            { name: 'loss', ...row(-4, 1e6) },
            { name: 'unpricedSmall', ...row(1, undefined) },
        ];
        expect(sortBeltRows(rows, 'market').map((r) => r.name)).toEqual([
            'free',
            'cheap',
            'dear',
            'noise',
            'loss',
            'unpricedBig',
            'unpricedSmall',
        ]);
        // The input is not reordered in place
        expect(rows[0].name).toBe('unpricedBig');
    });

    test('an empty list sorts to an empty list', () => {
        expect(sortBeltRows([], 'market')).toEqual([]);
        expect(sortBeltRows(null, 'market')).toEqual([]);
    });
});

describe('scaleBonuses', () => {
    const talismans = [
        {
            slotIndex: 1,
            modifiers: [
                { hrid: '/talisman_modifiers/skilling_speed', grade: 3 },
                { hrid: '/talisman_modifiers/milking_speed', grade: 6 },
            ],
        },
        { slotIndex: 2, modifiers: [{ hrid: '/talisman_modifiers/skilling_speed', grade: 5 }] },
    ];
    const bonusesFor = (belt) =>
        computeTalismanBonuses({
            talismans,
            belt,
            itemDetailMap: BELT_ITEMS,
            modifierDetailMap: FULL_MODIFIER_DETAILS,
            enhancementTable: TABLE,
        });

    test('scaling a set to another belt of the same slot count equals working it out on that belt', () => {
        const medium4 = bonusesFor({ itemHrid: MEDIUM, enhancementLevel: 4 });
        const medium20 = bonusesFor({ itemHrid: MEDIUM, enhancementLevel: 20 });
        const [p4] = beltCandidates({ hrid: MEDIUM, enhancementLevel: 3 }, BELT_ITEMS, TABLE).filter(
            (c) => c.level === 4
        );
        const [p20] = beltCandidates({ hrid: MEDIUM, enhancementLevel: 3 }, BELT_ITEMS, TABLE).filter(
            (c) => c.level === 20
        );
        const scaled = scaleBonuses(medium4, p4.power, p20.power);
        for (const [stat, value] of Object.entries(medium20.noncombat)) {
            expect(scaled.noncombat[stat]).toBeCloseTo(value, 12);
        }
        expect(Object.keys(scaled.noncombat).sort()).toEqual(Object.keys(medium20.noncombat).sort());
    });

    test('a bigger belt with the same two talismans slotted gives the same set as a belt that fits them', () => {
        // Medium holds both; a Large +0 holds both and a third slot with nothing in it
        const medium = bonusesFor({ itemHrid: MEDIUM, enhancementLevel: 0 });
        const large = bonusesFor({ itemHrid: LARGE, enhancementLevel: 0 });
        const scaled = scaleBonuses(medium, 0.15, 0.2);
        for (const [stat, value] of Object.entries(large.noncombat)) {
            expect(scaled.noncombat[stat]).toBeCloseTo(value, 12);
        }
    });

    test('does not change its input', () => {
        const medium = bonusesFor({ itemHrid: MEDIUM, enhancementLevel: 0 });
        const before = JSON.stringify(medium);
        scaleBonuses(medium, 0.15, 0.2);
        expect(JSON.stringify(medium)).toBe(before);
    });
});

describe('runSkillingBeltAdvisor', () => {
    const ACTION = '/actions/milking/cow';
    const gameData = {
        itemDetailMap: BELT_ITEMS,
        enhancementLevelTotalBonusMultiplierTable: TABLE,
        talismanModifierDetailMap: FULL_MODIFIER_DETAILS,
        actionDetailMap: {
            [ACTION]: { hrid: ACTION, type: '/action_types/milking', name: 'Cow' },
            '/actions/alchemy/coinify': { hrid: '/actions/alchemy/coinify', type: '/action_types/alchemy', name: 'x' },
        },
    };
    // Three talismans' worth of lines on a Large; a Medium has two slots, so the third record is not worn
    const talismans = [
        { slotIndex: 1, modifiers: [{ hrid: '/talisman_modifiers/milking_speed', grade: 6 }] },
        { slotIndex: 2, modifiers: [{ hrid: '/talisman_modifiers/skilling_speed', grade: 6 }] },
        { slotIndex: 3, modifiers: [{ hrid: '/talisman_modifiers/milking_speed', grade: 6 }] },
    ];
    function contextFor(beltHrid, level, list = talismans) {
        const belt = { itemHrid: beltHrid, enhancementLevel: level, itemLocationHrid: BELT_LOCATION };
        const bonuses = computeTalismanBonuses({
            talismans: list,
            belt,
            itemDetailMap: BELT_ITEMS,
            modifierDetailMap: FULL_MODIFIER_DETAILS,
            enhancementTable: TABLE,
        });
        const equipment = attachTalismanBonuses(new Map([[BELT_LOCATION, belt]]), bonuses);
        return { equipment, drinks: [] };
    }
    const seen = [];
    function makeDeps(context, extra = {}) {
        seen.length = 0;
        return {
            getGameData: () => gameData,
            resolveContext: () => context,
            // Profit rides on the speed share the equipment Map carries: one figure per belt
            evaluate: async (actionHrid, { equipment }) => {
                const share = talismanBonusesOf(equipment).noncombat;
                const belt = equipment.get(BELT_LOCATION);
                seen.push(`${belt.itemHrid}@${belt.enhancementLevel}`);
                const rate = 1000 * (1 + (share.milkingSpeed || 0) + (share.skillingSpeed || 0));
                return { profitPerHour: rate, xpPerHour: rate / 10, revenuePerHour: rate, hasMissingPrices: false };
            },
            yieldNow: async () => {},
            costDeps: { priceInfo: () => none, testerOn: () => false, enhanceCost: () => null },
            ...extra,
        };
    }
    const exact = (belt, level) => {
        const share = computeTalismanBonuses({
            talismans: talismans.filter((t) => t.slotIndex <= 2),
            belt: { itemHrid: belt, enhancementLevel: level },
            itemDetailMap: BELT_ITEMS,
            modifierDetailMap: FULL_MODIFIER_DETAILS,
            enhancementTable: TABLE,
        }).noncombat;
        return 1000 * (1 + (share.milkingSpeed || 0) + (share.skillingSpeed || 0));
    };

    test('every candidate is valued with the belt swapped in, to the figure the belt would really give', async () => {
        const context = contextFor(MEDIUM, 4);
        const result = await runSkillingBeltAdvisor({ actionHrid: ACTION, metricKey: 'profit' }, makeDeps(context));
        expect(result.status).toBe('done');
        expect(result.belt).toEqual({ hrid: MEDIUM, enhancementLevel: 4 });
        const base = exact(MEDIUM, 4);
        expect(result.rows.map((r) => r.key)).toEqual([
            `${MEDIUM}@5`,
            `${MEDIUM}@6`,
            `${MEDIUM}@7`,
            `${MEDIUM}@10`,
            `${MEDIUM}@15`,
            `${MEDIUM}@20`,
            `${LARGE}@0`,
            `${LARGE}@4`,
        ]);
        for (const r of result.rows) expect(r.value).toBeCloseTo(exact(r.hrid, r.level) - base, 9);
        // The baseline plus one evaluation per candidate, each with its own belt in the Map
        expect(seen).toEqual([`${MEDIUM}@4`, ...result.rows.map((r) => r.key)]);
    });

    test('a larger belt does not bring the slot-3 record to life; its new slot is reported empty, not valued', async () => {
        const context = contextFor(MEDIUM, 4);
        const result = await runSkillingBeltAdvisor({ actionHrid: ACTION, metricKey: 'profit' }, makeDeps(context));
        const large = result.rows.find((r) => r.key === `${LARGE}@0`);
        expect(large.emptySlots).toBe(1);
        // Exactly the two worn talismans at the Large's power: a third copy would have added another milking line
        expect(large.value).toBeCloseTo(exact(LARGE, 0) - exact(MEDIUM, 4), 9);
    });

    test('the gear the run was handed is not changed', async () => {
        const context = contextFor(MEDIUM, 4);
        const before = JSON.stringify(talismanBonusesOf(context.equipment));
        await runSkillingBeltAdvisor({ actionHrid: ACTION, metricKey: 'xp' }, makeDeps(context));
        expect(context.equipment.get(BELT_LOCATION).itemHrid).toBe(MEDIUM);
        expect(JSON.stringify(talismanBonusesOf(context.equipment))).toBe(before);
    });

    test('unpriced belts keep their gain, have no cost, and sort last', async () => {
        const context = contextFor(MEDIUM, 4);
        const prices = { [`${MEDIUM}@5`]: 10_000_000, [`${LARGE}@0`]: 90_000_000 };
        const deps = makeDeps(context, {
            costDeps: {
                priceInfo: (hrid, o) =>
                    prices[`${hrid}@${o.enhancementLevel}`] ? book(prices[`${hrid}@${o.enhancementLevel}`]) : none,
                afterTax: (p) => p,
                testerOn: () => false,
                enhanceCost: () => null,
            },
        });
        const result = await runSkillingBeltAdvisor({ actionHrid: ACTION, metricKey: 'profit' }, deps);
        const sorted = sortBeltRows(result.rows, 'market');
        expect(
            sorted
                .slice(0, 2)
                .map((r) => r.key)
                .sort()
        ).toEqual([`${LARGE}@0`, `${MEDIUM}@5`].sort());
        for (const r of sorted.slice(2)) {
            expect(r.costs.market.price).toBeNull();
            expect(rateRow(r, 'market').kind).toBe('unpriced');
        }
        // Every unpriced row still carries its gain
        expect(sorted.slice(2).every((r) => r.value > 0)).toBe(true);
    });

    test('a profit gain that rests on an input counted as free is marked unreal', async () => {
        const context = contextFor(MEDIUM, 4);
        const deps = makeDeps(context, {
            evaluate: async (actionHrid, { equipment }) => {
                const faster = (talismanBonusesOf(equipment).noncombat.milkingSpeed || 0) > 0.14;
                return {
                    profitPerHour: faster ? 2000 : 1000,
                    xpPerHour: 1,
                    revenuePerHour: 1000,
                    hasMissingPrices: true,
                    outputsUnpriced: false,
                    unpricedCost: ['Milk'],
                    unpricedCostRates: { Milk: faster ? 50 : 10 },
                };
            },
        });
        const result = await runSkillingBeltAdvisor({ actionHrid: ACTION, metricKey: 'profit' }, deps);
        expect(result.hasUnpricedInputs).toBe(true);
        const unreal = result.rows.filter((r) => r.gainUnreal);
        expect(unreal.length).toBeGreaterThan(0);
        for (const r of unreal) expect(rateRow({ ...r, costs: { market: { price: 5 } } }, 'market').kind).toBe('none');
    });

    test('Stop keeps the belts already valued, and says it stopped', async () => {
        const context = contextFor(MEDIUM, 4);
        let calls = 0;
        const result = await runSkillingBeltAdvisor({ actionHrid: ACTION, metricKey: 'profit' }, makeDeps(context), {
            abortSignal: () => ++calls > 3,
        });
        expect(result.status).toBe('stopped');
        expect(result.rows.length).toBeGreaterThan(0);
        expect(result.rows.length).toBeLessThan(result.of);
    });

    test('the largest belt at +20 has nothing to compare: done with no rows, no evaluations beyond the baseline', async () => {
        const context = contextFor(LARGE, 20);
        const result = await runSkillingBeltAdvisor({ actionHrid: ACTION, metricKey: 'profit' }, makeDeps(context));
        expect(result).toMatchObject({ status: 'done', rows: [], of: 0 });
        expect(seen).toEqual([`${LARGE}@20`]);
    });

    test('the largest belt at +18 is offered +19 and +20 only', async () => {
        const context = contextFor(LARGE, 18);
        const result = await runSkillingBeltAdvisor({ actionHrid: ACTION, metricKey: 'profit' }, makeDeps(context));
        expect(result.rows.map((r) => r.level)).toEqual([19, 20]);
    });

    test('refuses: live server, no action, a type it cannot value, no belt, no slotted talisman', async () => {
        const context = contextFor(MEDIUM, 4);
        mocks.test = false;
        expect((await runSkillingBeltAdvisor({ actionHrid: ACTION }, makeDeps(context))).reason).toBe('live');
        mocks.test = true;
        expect((await runSkillingBeltAdvisor({ actionHrid: '/actions/nope' }, makeDeps(context))).reason).toBe(
            'no_action'
        );
        expect(
            (await runSkillingBeltAdvisor({ actionHrid: '/actions/alchemy/coinify' }, makeDeps(context))).reason
        ).toBe('unsupported');
        const noBelt = { equipment: new Map(), drinks: [] };
        expect((await runSkillingBeltAdvisor({ actionHrid: ACTION }, makeDeps(noBelt))).reason).toBe('no_belt');
        const bare = contextFor(MEDIUM, 4, []);
        const refused = await runSkillingBeltAdvisor({ actionHrid: ACTION }, makeDeps(bare));
        expect(refused).toMatchObject({ status: 'refused', reason: 'no_talismans' });
        expect(seen).toEqual([]);
    });

    test('a combat-only talisman set changes nothing for skilling: refused as no skilling talisman', async () => {
        const combatOnly = contextFor(MEDIUM, 4, [
            { slotIndex: 1, modifiers: [{ hrid: '/talisman_modifiers/critical_damage', grade: 6 }] },
        ]);
        const refused = await runSkillingBeltAdvisor({ actionHrid: ACTION }, makeDeps(combatOnly));
        expect(refused.reason).toBe('no_talismans');
    });

    test('an action with no figures is refused; prices not loaded is refused for profit only', async () => {
        const context = contextFor(MEDIUM, 4);
        const none1 = await runSkillingBeltAdvisor(
            { actionHrid: ACTION },
            makeDeps(context, { evaluate: async () => null })
        );
        expect(none1.reason).toBe('no_figures');
        const unpriced = makeDeps(context, {
            evaluate: async () => ({ profitPerHour: 0, xpPerHour: 5, revenuePerHour: 0, hasMissingPrices: true }),
        });
        expect((await runSkillingBeltAdvisor({ actionHrid: ACTION, metricKey: 'profit' }, unpriced)).reason).toBe(
            'no_prices'
        );
        expect((await runSkillingBeltAdvisor({ actionHrid: ACTION, metricKey: 'xp' }, unpriced)).status).toBe('done');
    });
});
