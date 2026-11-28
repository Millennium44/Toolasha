/**
 * The retransmute figure: books valued as max(sell, retransmute), found by iteration over the drop tables, and the
 * first attempt's gain added to the plain figure.
 *
 * Fixtures use the game's field names (`alchemyDetail.transmuteDropTable` rows of `itemHrid`, `dropRate`, `minCount`,
 * `maxCount`; `transmuteSuccessRate`). The 8-book group is the real ability-book family: each book drops all eight at
 * 0.125, success 0.5. Per-attempt terms are the calculator's, supplied by a stub.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const engine = vi.hoisted(() => ({
    itemDetails: {},
    /** hrid -> sell price before tax; absent = no order */
    sells: {},
    estimated: new Set(),
    settings: {},
    signature: 'a',
    taxKeep: 1,
    /** hrid -> terms the calculator would give; absent = null */
    terms: {},
    termsCalls: [],
}));

vi.mock('../core/config.js', () => ({ default: { getSetting: (key) => engine.settings[key] ?? null } }));
vi.mock('../core/data-manager.js', () => ({
    default: {
        getItemDetails: (hrid) => engine.itemDetails[hrid] ?? null,
        getSkills: () => [{ skillHrid: '/skills/alchemy', level: engine.settings.alchemyLevel ?? 100 }],
    },
}));
vi.mock('./bundle-bridge.js', async (importOriginal) => ({
    ...(await importOriginal()),
    alchemyProfitCalculator: () => ({
        calculateTransmuteAttemptTerms: (hrid, setup) => {
            engine.termsCalls.push([hrid, setup]);
            return engine.terms[hrid] ?? null;
        },
    }),
}));
vi.mock('./market-data.js', () => ({
    getItemPriceInfo: (hrid) => ({
        price: engine.sells[hrid] ?? null,
        source: engine.sells[hrid] == null ? null : 'book',
        estimated: engine.estimated.has(hrid),
    }),
}));
vi.mock('./profit-helpers.js', () => ({ calculatePriceAfterTax: (price) => price * engine.taxKeep }));
vi.mock('./decompose-chain-value.js', () => ({ pricingSignature: () => engine.signature }));

const { retransmuteValue, clearRetransmuteCaches, describeRetransmutePolicy, RETRANSMUTE_SETTING, MAX_NODES } =
    await import('./retransmute-value.js');

const GOLD_RATE = 'actionPanel_craftingPlanGoldPerHour';
const BOOKS = [
    'revive',
    'insanity',
    'invincible',
    'speed_aura',
    'guardian_aura',
    'fierce_aura',
    'critical_aura',
].concat('mystic_aura');
const hridOf = (name) => `/items/${name}`;
const row = (name, dropRate = 0.125, count = 1) => ({
    itemHrid: hridOf(name),
    dropRate,
    minCount: count,
    maxCount: count,
});

/** The closed 8-book family: every book's table is the same eight rows */
function eightBooks() {
    for (const name of BOOKS) {
        engine.itemDetails[hridOf(name)] = {
            alchemyDetail: { transmuteSuccessRate: 0.5, transmuteDropTable: BOOKS.map((book) => row(book)) },
        };
        engine.terms[hridOf(name)] = terms();
    }
}
/** Per-attempt terms: 1000 attempts an hour, no catalyst or coin cost, success 0.5 */
function terms(over = {}) {
    return {
        successRate: 0.5,
        actionsPerHour: 1000,
        catalystCostPerAttempt: 0,
        coinCost: 0,
        bulkMultiplier: 1,
        ...over,
    };
}
/** A plain result for the root, as the calculator returns it */
function plainFor(name, over = {}) {
    return {
        actionType: 'transmute',
        itemHrid: hridOf(name),
        enhancementLevel: 0,
        requirementCosts: [{ itemHrid: hridOf(name), count: 1, price: 20 }],
        successRate: 0.5,
        actionsPerHour: 1000,
        netProfitPerAttempt: 5,
        profitPerHour: 5000,
        winningCatalystHrid: null,
        winningTeaUsed: false,
        ...over,
    };
}
/** Sell prices where only insanity is worth more than a retransmute */
function priceBooks() {
    engine.sells = Object.fromEntries(BOOKS.map((name) => [hridOf(name), 20]));
    engine.sells[hridOf('revive')] = 10;
    engine.sells[hridOf('insanity')] = 1000;
}
const named = (result, name) => result.policy.find((entry) => entry.itemHrid === hridOf(name));

beforeEach(() => {
    engine.itemDetails = {};
    engine.sells = {};
    engine.estimated = new Set();
    engine.settings = { [GOLD_RATE]: 10_000 };
    engine.signature = 'a';
    engine.taxKeep = 1;
    engine.terms = {};
    engine.termsCalls = [];
    clearRetransmuteCaches();
});

describe('the closed 8-book group', () => {
    test('keeps the cheap books for retransmuting and sells insanity, by hand', () => {
        eightBooks();
        priceBooks();
        // Time costs 10,000 gold/hr over 1000 attempts/hr = 10 per attempt. Seven books retransmute at x, with
        // insanity sold at 1000: x = (0.5 * (6x + 1000) / 8 - 10) / (1 - 0.5 / 8) -> 0.5625x = 52.5
        const x = 52.5 / 0.5625;

        const result = retransmuteValue(plainFor('invincible'));

        expect(result.status).toBe('ok');
        expect(result.converged).toBe(true);
        expect(named(result, 'insanity').action).toBe('sell');
        for (const name of BOOKS.filter((book) => book !== 'insanity')) {
            expect(named(result, name).action).toBe('retransmute');
            expect(named(result, name).retransmuteValue).toBeCloseTo(x, 6);
        }
        // Gain per attempt: success 0.5 x 0.125 x (revive lifts x - 10; the other five books and the root's own
        // self-return lift x - 20, the self-return against the buy price of 20)
        const lifts = x - 10 + 6 * (x - 20);
        const perHour = 5000 + 0.5 * 0.125 * lifts * 1000;
        expect(result.adjustedPerHour).toBeCloseTo(perHour, 4);
        expect(result.plainPerHour).toBe(5000);
        expect(result.differs).toBe(true);
        expect(result.partial).toBe(false);
    });

    test('the iteration matches a brute-force fixed point of V = max(sell, retransmute)', () => {
        eightBooks();
        priceBooks();
        const sells = BOOKS.map((name) => engine.sells[hridOf(name)]);
        const step = (current) =>
            current.map((_, i) => {
                const others = current.reduce((sum, v, k) => (k === i ? sum : sum + v), 0);
                return Math.max(sells[i], (0.5 * (others / 8) - 10) / (1 - 0.0625));
            });
        let values = [...sells];
        for (let round = 0; round < 500; round += 1) values = step(values);

        const result = retransmuteValue(plainFor('invincible'));

        BOOKS.forEach((name, i) => {
            const entry = named(result, name);
            const value = entry.action === 'retransmute' ? entry.retransmuteValue : entry.sellValue;
            expect(value).toBeCloseTo(values[i], 6);
        });
    });

    test('market tax is charged once, on the sell side only', () => {
        eightBooks();
        priceBooks();
        engine.taxKeep = 0.5;

        const result = retransmuteValue(plainFor('invincible'));

        expect(named(result, 'insanity').sellValue).toBe(500);
        expect(named(result, 'revive').sellValue).toBe(5);
    });

    test('a book whose sell price beats every transmute is sold', () => {
        eightBooks();
        priceBooks();
        engine.sells[hridOf('mystic_aura')] = 5000;

        const result = retransmuteValue(plainFor('invincible'));

        expect(named(result, 'mystic_aura').action).toBe('sell');
        expect(named(result, 'insanity').action).toBe('sell');
    });

    test('where retransmuting never pays the figure is the plain one and nothing differs', () => {
        eightBooks();
        for (const name of BOOKS) engine.sells[hridOf(name)] = 1000;

        const result = retransmuteValue(plainFor('invincible'));

        expect(result.status).toBe('ok');
        expect(result.adjustedPerHour).toBe(5000);
        expect(result.differs).toBe(false);
        expect(result.policy.every((entry) => entry.action === 'sell')).toBe(true);
    });

    test('a self-return worth less than the buy price it is credited at adds nothing', () => {
        eightBooks();
        priceBooks();
        // Everything retransmutes to x = 93.3; a buy price above that leaves the plain credit standing
        const result = retransmuteValue(plainFor('invincible', { requirementCosts: [{ count: 1, price: 500 }] }));

        const x = 52.5 / 0.5625;
        const withoutSelf = 0.5 * 0.125 * (x - 10 + 5 * (x - 20)) * 1000;
        expect(result.adjustedPerHour).toBeCloseTo(5000 + withoutSelf, 4);
    });

    test('a bulk multiplier shares an attempt cost between the copies it consumes', () => {
        engine.itemDetails[hridOf('root')] = {
            alchemyDetail: { transmuteSuccessRate: 1, transmuteDropTable: [row('keep', 1)] },
        };
        engine.itemDetails[hridOf('keep')] = {
            alchemyDetail: { transmuteSuccessRate: 1, transmuteDropTable: [row('gem', 1)] },
        };
        engine.sells = { [hridOf('keep')]: 10, [hridOf('gem')]: 100 };
        // 100 attempts/hr at 1000 gold/hr is 10 an attempt; catalyst 5 and coin 5 make it 20 for ten copies
        engine.settings[GOLD_RATE] = 1000;
        engine.terms[hridOf('keep')] = terms({
            successRate: 1,
            actionsPerHour: 100,
            catalystCostPerAttempt: 5,
            coinCost: 5,
            bulkMultiplier: 10,
        });

        const result = retransmuteValue(
            plainFor('root', { successRate: 1, requirementCosts: [{ count: 1, price: 1 }], actionsPerHour: 100 })
        );

        expect(named(result, 'keep').retransmuteValue).toBeCloseTo(98, 9);
        expect(named(result, 'keep').action).toBe('retransmute');
    });
});

describe('books and tables that are not in the closed group', () => {
    test('an unpriced book is dropped from the sums and the result is partial, never zero', () => {
        eightBooks();
        priceBooks();
        delete engine.sells[hridOf('mystic_aura')];

        const result = retransmuteValue(plainFor('invincible'));

        expect(result.partial).toBe(true);
        expect(result.partialItems).toEqual([hridOf('mystic_aura')]);
        expect(named(result, 'mystic_aura').action).toBe('unpriced');
        // Six books and the root's own copy retransmute; with one eighth of the table gone each is worth less
        const full = retransmuteValue(plainFor('invincible'));
        engine.sells[hridOf('mystic_aura')] = 20;
        clearRetransmuteCaches();
        const priced = retransmuteValue(plainFor('invincible'));
        expect(full.adjustedPerHour).toBeLessThan(priced.adjustedPerHour);
        expect(full.adjustedPerHour).toBeGreaterThan(5000);
    });

    test('a root output the plain figure counts at an estimate is flagged estimated, not a lower bound', () => {
        eightBooks();
        priceBooks();
        engine.estimated.add(hridOf('mystic_aura'));

        const result = retransmuteValue(plainFor('invincible', { estimatedOutputs: [hridOf('mystic_aura')] }));

        expect(result.status).toBe('ok');
        expect(result.estimated).toBe(true);
        expect(result.estimatedItems).toEqual([hridOf('mystic_aura')]);
        expect(result.partial).toBe(false);
        expect(describeRetransmutePolicy(result)).toContain('estimated price for mystic_aura');
        expect(describeRetransmutePolicy(result)).not.toContain('lower bound');

        // A book the plain figure does not count either is a real gap, and stays a lower bound
        clearRetransmuteCaches();
        const gap = retransmuteValue(plainFor('invincible'));
        expect(gap.estimated).toBe(false);
        expect(gap.partial).toBe(true);
    });

    test('an estimated price is not an order, so that book is left out', () => {
        eightBooks();
        priceBooks();
        engine.estimated.add(hridOf('speed_aura'));

        const result = retransmuteValue(plainFor('invincible'));

        expect(named(result, 'speed_aura').action).toBe('unpriced');
        expect(result.partial).toBe(true);
    });

    test('every output unpriced gives no figure', () => {
        eightBooks();

        const result = retransmuteValue(plainFor('invincible'));

        expect(result.status).toBe('noFigure');
    });

    test('an item with no transmute table, or success 0, has no figure', () => {
        engine.itemDetails[hridOf('plain')] = { alchemyDetail: {} };
        engine.itemDetails[hridOf('dead')] = {
            alchemyDetail: { transmuteSuccessRate: 0, transmuteDropTable: [row('plain', 1)] },
        };
        engine.sells[hridOf('plain')] = 50;

        expect(retransmuteValue(plainFor('plain')).status).toBe('noFigure');
        expect(retransmuteValue(plainFor('dead')).status).toBe('noFigure');
        expect(retransmuteValue(null).status).toBe('noFigure');
    });

    test('an enhanced input is refused', () => {
        eightBooks();
        priceBooks();

        expect(retransmuteValue(plainFor('invincible', { enhancementLevel: 3 })).status).toBe('noFigure');
    });

    test('a book with a table whose terms cannot be priced stays at its sell value and marks the result partial', () => {
        eightBooks();
        priceBooks();
        delete engine.terms[hridOf('revive')];

        const result = retransmuteValue(plainFor('invincible'));

        expect(named(result, 'revive').action).toBe('sell');
        expect(result.partialItems).toContain(hridOf('revive'));
    });

    test('an output with its own different table, and a nested one, are valued through it', () => {
        engine.itemDetails[hridOf('root')] = {
            alchemyDetail: { transmuteSuccessRate: 1, transmuteDropTable: [row('mid', 1)] },
        };
        engine.itemDetails[hridOf('mid')] = {
            alchemyDetail: { transmuteSuccessRate: 1, transmuteDropTable: [row('deep', 0.5), row('dust', 0.5, 2)] },
        };
        engine.itemDetails[hridOf('deep')] = {
            alchemyDetail: { transmuteSuccessRate: 1, transmuteDropTable: [row('gem', 1)] },
        };
        engine.sells = { [hridOf('mid')]: 1, [hridOf('deep')]: 5, [hridOf('dust')]: 3, [hridOf('gem')]: 100 };
        engine.settings[GOLD_RATE] = 100;
        engine.terms[hridOf('mid')] = terms({ successRate: 1, actionsPerHour: 100 });
        engine.terms[hridOf('deep')] = terms({ successRate: 1, actionsPerHour: 100 });

        const result = retransmuteValue(plainFor('root', { successRate: 1, actionsPerHour: 100 }));

        // deep: 100 - 1 = 99; mid: 0.5 * 99 + 0.5 * 2 * 3 - 1 = 51.5
        expect(named(result, 'deep').retransmuteValue).toBeCloseTo(99, 9);
        expect(named(result, 'mid').retransmuteValue).toBeCloseTo(51.5, 9);
        expect(named(result, 'gem').action).toBe('sell');
        expect(result.partial).toBe(false);
    });

    test('hitting the node cap marks the result partial and says so', () => {
        eightBooks();
        priceBooks();

        const result = retransmuteValue(plainFor('invincible'), {}, { maxNodes: 3 });

        expect(result.nodeCapHit).toBe(true);
        expect(result.partial).toBe(true);
        expect(result.policy).toHaveLength(3);
        expect(MAX_NODES).toBe(200);
    });
});

describe('divergence, tea and the gain arithmetic', () => {
    test('a two-book cycle that returns more than it costs has no figure, never a huge one', () => {
        engine.itemDetails[hridOf('root')] = {
            alchemyDetail: { transmuteSuccessRate: 1, transmuteDropTable: [row('a', 1)] },
        };
        // Each book yields two of the other: every round doubles the value
        engine.itemDetails[hridOf('a')] = {
            alchemyDetail: { transmuteSuccessRate: 1, transmuteDropTable: [row('b', 1, 2)] },
        };
        engine.itemDetails[hridOf('b')] = {
            alchemyDetail: { transmuteSuccessRate: 1, transmuteDropTable: [row('a', 1, 2)] },
        };
        engine.sells = { [hridOf('a')]: 10, [hridOf('b')]: 10 };
        // An attempt costs 1, and returns two books worth 10 each: positive margin, no fixed point
        engine.settings[GOLD_RATE] = 1000;
        engine.terms[hridOf('a')] = terms({ successRate: 1 });
        engine.terms[hridOf('b')] = terms({ successRate: 1 });

        const result = retransmuteValue(plainFor('root', { successRate: 1 }));

        expect(result.status).toBe('noFigure');
        expect(result.reason).toBe('did not settle');
    });

    test('drinks are paid on every extra attempt', () => {
        engine.itemDetails[hridOf('root')] = {
            alchemyDetail: { transmuteSuccessRate: 1, transmuteDropTable: [row('keep', 1)] },
        };
        engine.itemDetails[hridOf('keep')] = {
            alchemyDetail: { transmuteSuccessRate: 1, transmuteDropTable: [row('gem', 1)] },
        };
        engine.sells = { [hridOf('keep')]: 10, [hridOf('gem')]: 100 };
        engine.settings[GOLD_RATE] = 1000;
        // 10 for the time of an attempt at 100 an hour, and 5 of tea: 100 - 15
        engine.terms[hridOf('keep')] = terms({ successRate: 1, actionsPerHour: 100, teaCostPerAttempt: 5 });

        const result = retransmuteValue(plainFor('root', { successRate: 1, actionsPerHour: 100 }));

        expect(named(result, 'keep').retransmuteValue).toBeCloseTo(85, 9);
    });

    test('the gain counts the root bulk and an output count above one, by hand', () => {
        engine.itemDetails[hridOf('root')] = {
            alchemyDetail: {
                transmuteSuccessRate: 0.8,
                transmuteDropTable: [{ itemHrid: hridOf('keep'), dropRate: 0.5, minCount: 1, maxCount: 3 }],
            },
        };
        engine.itemDetails[hridOf('keep')] = {
            alchemyDetail: { transmuteSuccessRate: 1, transmuteDropTable: [row('gem', 1)] },
        };
        engine.sells = { [hridOf('keep')]: 10, [hridOf('gem')]: 100 };
        engine.settings[GOLD_RATE] = 1000;
        engine.terms[hridOf('keep')] = terms({ successRate: 1, actionsPerHour: 100 });
        // keep retransmutes at 100 - 10 = 90, a lift of 80 over its sale. Per attempt: 0.8 success x 3 copies in
        // x (0.5 x average count 2 x 80) = 192; at 100 attempts an hour that is 19,200 over the plain figure
        const plain = plainFor('root', {
            successRate: 0.8,
            actionsPerHour: 100,
            profitPerHour: 1000,
            requirementCosts: [{ itemHrid: hridOf('root'), count: 3, price: 5 }],
        });

        const result = retransmuteValue(plain);

        expect(result.adjustedPerHour).toBeCloseTo(1000 + 19_200, 6);
    });
});

describe('gold rate and cache', () => {
    test('a gold rate of 0 gives the note, not a figure', () => {
        eightBooks();
        priceBooks();
        engine.settings[GOLD_RATE] = 0;

        expect(retransmuteValue(plainFor('invincible'))).toEqual({ status: 'noGoldRate' });
    });

    test('a change of gold rate, pricing signature or custom price changes the result', () => {
        eightBooks();
        priceBooks();
        const base = retransmuteValue(plainFor('invincible')).adjustedPerHour;

        engine.settings[GOLD_RATE] = 20_000;
        const slower = retransmuteValue(plainFor('invincible')).adjustedPerHour;
        expect(slower).not.toBe(base);

        engine.settings[GOLD_RATE] = 10_000;
        expect(retransmuteValue(plainFor('invincible')).adjustedPerHour).toBe(base);

        // A pricing mode or custom price moves the signature; the prices behind it move with it
        engine.signature = 'b';
        engine.sells[hridOf('insanity')] = 10;
        const afterSignature = retransmuteValue(plainFor('invincible')).adjustedPerHour;
        expect(afterSignature).not.toBe(base);
    });

    test('the same inputs are worked out once, and a different setup or alchemy level is not served from it', () => {
        eightBooks();
        priceBooks();
        retransmuteValue(plainFor('invincible'));
        const calls = engine.termsCalls.length;
        retransmuteValue(plainFor('invincible'));
        expect(engine.termsCalls.length).toBe(calls);

        retransmuteValue(
            plainFor('invincible', { winningCatalystHrid: '/items/prime_catalyst', winningTeaUsed: true })
        );
        expect(engine.termsCalls.length).toBeGreaterThan(calls);
        const afterSetup = engine.termsCalls.length;

        engine.settings.alchemyLevel = 120;
        retransmuteValue(plainFor('invincible'));
        expect(engine.termsCalls.length).toBeGreaterThan(afterSetup);
    });

    test('the plain result is asked for under its own setup: live, what-if, or the winning combo', () => {
        eightBooks();
        priceBooks();

        retransmuteValue(plainFor('invincible'), { useLiveSetup: true });
        expect(engine.termsCalls.at(-1)[1]).toEqual({ useLiveSetup: true, catalystChoice: null });
        clearRetransmuteCaches();
        retransmuteValue(plainFor('invincible'), { useLiveSetup: true, catalystChoice: 'prime' });
        expect(engine.termsCalls.at(-1)[1]).toEqual({ useLiveSetup: true, catalystChoice: 'prime' });
        clearRetransmuteCaches();
        retransmuteValue(
            plainFor('invincible', { winningCatalystHrid: '/items/prime_catalyst', winningTeaUsed: true })
        );
        expect(engine.termsCalls.at(-1)[1]).toEqual({ catalystHrid: '/items/prime_catalyst', usesTea: true });
    });

    test('a plain result with another catalyst or drinks is not served the old setup terms', () => {
        eightBooks();
        priceBooks();
        const live = { useLiveSetup: true };
        retransmuteValue(plainFor('invincible', { catalystCost: { itemHrid: '/items/prime_catalyst' } }), live);
        const calls = engine.termsCalls.length;

        // Same live setup, same root figures: only the slotted catalyst changed
        retransmuteValue(plainFor('invincible', { catalystCost: { itemHrid: null } }), live);
        expect(engine.termsCalls.length).toBeGreaterThan(calls);
        const afterCatalyst = engine.termsCalls.length;

        retransmuteValue(
            plainFor('invincible', { catalystCost: { itemHrid: null }, consumableCosts: [{ itemHrid: '/items/tea' }] }),
            live
        );
        expect(engine.termsCalls.length).toBeGreaterThan(afterCatalyst);
    });

    test('the setting id is the one the schema declares', () => {
        expect(RETRANSMUTE_SETTING).toBe('alchemy_retransmute');
    });
});
