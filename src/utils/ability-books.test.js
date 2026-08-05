import { describe, test, expect } from 'vitest';
import {
    bookItemFor,
    booksToLevel,
    experienceOwed,
    abilityPlan,
    cheapestNextLevel,
    planTotals,
    aimedTotals,
} from './ability-books.js';

/** A table where each level costs 1,000 more experience than the last */
const table = [0, 0];
for (let level = 2; level <= 200; level++) table[level] = table[level - 1] + 1000;

describe('bookItemFor', () => {
    test('an ability and its book share a name', () => {
        expect(bookItemFor('/abilities/poke')).toBe('/items/poke');
    });

    test('nothing in is nothing out, rather than a crash', () => {
        expect(bookItemFor(null)).toBe('');
    });
});

describe('booksToLevel', () => {
    const base = { perBookExperience: 500, table };

    test('divides what is owed by what a book grants, rounding up', () => {
        // Level 3 is at 2,000; from 1,000 that is 1,000 owed, so two books
        expect(booksToLevel({ ...base, level: 2, experience: 1000, targetLevel: 3 })).toBe(2);
    });

    test('a part-used book still has to be bought whole', () => {
        expect(booksToLevel({ ...base, level: 2, experience: 1400, targetLevel: 3 })).toBe(2);
    });

    test('an unlearned ability costs one book more, for the one that teaches it', () => {
        // The error this catches leaves you exactly one book short, every time
        const learned = booksToLevel({ ...base, level: 1, experience: 0, targetLevel: 2 });
        const unlearned = booksToLevel({ ...base, level: 0, experience: 0, targetLevel: 2 });
        expect(unlearned).toBe(learned + 1);
    });

    test('already past the target is nothing to buy, not a negative order', () => {
        expect(booksToLevel({ ...base, level: 5, experience: 99999, targetLevel: 3 })).toBe(0);
    });

    test('but an unlearned ability still needs its first book', () => {
        expect(booksToLevel({ ...base, level: 0, experience: 99999, targetLevel: 3 })).toBe(1);
    });

    test('no answer rather than a wrong one when the level or the book is unknown', () => {
        expect(booksToLevel({ ...base, level: 1, experience: 0, targetLevel: 9999 })).toBeNull();
        expect(booksToLevel({ ...base, perBookExperience: 0, level: 1, experience: 0, targetLevel: 2 })).toBeNull();
    });
});

describe('abilityPlan', () => {
    const ability = { abilityHrid: '/abilities/poke', level: 2, experience: 1000 };
    const base = { ability, perBookExperience: 500, bookPrice: 300, table };

    test('says what the next level costs, and where to buy it', () => {
        const plan = abilityPlan(base);
        expect(plan.itemHrid).toBe('/items/poke');
        expect(plan.booksToNext).toBe(2);
        expect(plan.costToNext).toBe(600);
    });

    test('a target beyond the next level is costed too', () => {
        // Level 5 is at 4,000; from 1,000 that is 3,000 owed, so six books
        const plan = abilityPlan({ ...base, targetLevel: 5 });
        expect(plan.booksToTarget).toBe(6);
        expect(plan.costToTarget).toBe(1800);
    });

    test('a target at or below the current level is not a target', () => {
        expect(abilityPlan({ ...base, targetLevel: 2 }).booksToTarget).toBeNull();
    });

    test('an unpriced book is unknown rather than free', () => {
        // Zero would make it the cheapest thing to level, which is the opposite
        // of what an item nobody is selling means
        const plan = abilityPlan({ ...base, bookPrice: 0 });
        expect(plan.booksToNext).toBe(2);
        expect(plan.costToNext).toBeNull();
    });

    test('nothing to plan without an ability or a book', () => {
        expect(abilityPlan({ ...base, ability: null })).toBeNull();
        expect(abilityPlan({ ...base, perBookExperience: 0 })).toBeNull();
    });
});

describe('cheapestNextLevel', () => {
    const plan = (hrid, costToNext) => ({ abilityHrid: hrid, costToNext });

    test('is the least coin, not the fewest books', () => {
        // The ability nearest its next level is rarely the cheapest, because
        // books differ in price by orders of magnitude
        const best = cheapestNextLevel([plan('/abilities/a', 900000), plan('/abilities/b', 4000)]);
        expect(best.abilityHrid).toBe('/abilities/b');
    });

    test('an unpriced plan cannot win by being unpriced', () => {
        const best = cheapestNextLevel([plan('/abilities/a', null), plan('/abilities/b', 4000)]);
        expect(best.abilityHrid).toBe('/abilities/b');
    });

    test('nothing priced is no answer', () => {
        expect(cheapestNextLevel([plan('/abilities/a', null)])).toBeNull();
        expect(cheapestNextLevel([])).toBeNull();
    });
});

describe('planTotals', () => {
    const plans = [
        { booksToNext: 2, costToNext: 600, booksToTarget: 6, costToTarget: 1800 },
        { booksToNext: 1, costToNext: null, booksToTarget: 3, costToTarget: null },
    ];

    test('sums the books and the coin', () => {
        expect(planTotals(plans)).toEqual({ books: 3, cost: 600, unpriced: 1 });
    });

    test('counts what it could not price, so a lower bound is not read as a total', () => {
        expect(planTotals(plans).unpriced).toBe(1);
    });

    test('totals the target column when asked for it', () => {
        expect(planTotals(plans, 'costToTarget')).toEqual({ books: 9, cost: 1800, unpriced: 1 });
    });

    test('nothing is zero rather than nothing', () => {
        expect(planTotals([])).toEqual({ books: 0, cost: 0, unpriced: 0 });
    });
});

describe('experienceOwed', () => {
    test('what is left to earn', () => {
        expect(experienceOwed(table, 5, 2500)).toBe(table[5] - 2500);
    });

    test('past it is nothing left, not a negative amount of experience', () => {
        expect(experienceOwed(table, 2, 999_999)).toBe(0);
    });

    test('a level the table does not reach is unknown rather than zero', () => {
        expect(experienceOwed(table, 500, 0)).toBeNull();
    });
});

describe('aimedTotals', () => {
    // The mixed set is the point: one ability aimed at a level, one left alone
    const plans = [
        { targetLevel: 10, booksToNext: 2, costToNext: 600, booksToTarget: 6, costToTarget: 1800 },
        { targetLevel: null, booksToNext: 1, costToNext: 300, booksToTarget: null, costToTarget: null },
    ];

    test('each plan counts where it is aimed', () => {
        // Not 6+1 books at one field or 2+0 at the other — 6 for the aimed one
        // and 1 for the one still going to its next level
        expect(aimedTotals(plans)).toEqual({ books: 7, cost: 2100, unpriced: 0 });
    });

    test('with nothing aimed it is the next levels', () => {
        const none = plans.map((plan) => ({ ...plan, targetLevel: null }));
        expect(aimedTotals(none)).toEqual({ books: 3, cost: 900, unpriced: 0 });
    });

    test('an unpriced target is still counted as unpriced', () => {
        const unpriced = [{ targetLevel: 10, booksToNext: 2, costToNext: 600, booksToTarget: 6, costToTarget: null }];
        expect(aimedTotals(unpriced)).toEqual({ books: 6, cost: 0, unpriced: 1 });
    });
});
