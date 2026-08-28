/**
 * What levelling an ability actually costs.
 *
 * It is books, bought at the market price of the book — not a listing for the
 * ability at a level, which does not exist. The breakdown exists because a row
 * reading "no price found" for Fireball 48 → 53 is not a missing price, it is a
 * question asked of the wrong market.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ data: null, prices: {} }));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.data,
    },
}));
vi.mock('../api/marketplace.js', () => ({
    default: { getPrice: (hrid) => game.prices[hrid] ?? null },
}));

const abilityCostCalculator = await import('./ability-cost-calculator.js');
const { explainAbilityLevelUpCost, explainAbilityCost } = abilityCostCalculator;

const FIREBALL = '/abilities/fireball';
const SMOKE = '/abilities/smoke_burst';

beforeEach(() => {
    game.data = {
        // Level → cumulative XP; enough rungs for the cases below
        levelExperienceTable: [0, 0, 500, 1500, 3000, 5000],
        itemDetailMap: { '/items/fireball': { name: 'Fireball' } },
    };
    game.prices = {
        '/items/fireball': { ask: 1200, bid: 800 },
        '/items/smoke_burst': { ask: 20_000, bid: 20_000 },
    };
});

describe('the book, and how many of it', () => {
    test('the book is the ability, on the item side', () => {
        expect(explainAbilityLevelUpCost(FIREBALL, 2, 500, 4)).toMatchObject({
            bookHrid: '/items/fireball',
            bookName: 'Fireball',
        });
    });

    test('books are the XP gap over what one book gives', () => {
        // 3000 − 500 = 2500 XP, at 50 per book for a starter ability
        expect(explainAbilityLevelUpCost(FIREBALL, 2, 500, 4).books).toBe(50);
    });

    test('a non-starter ability gives ten times the XP per book', () => {
        expect(explainAbilityLevelUpCost(SMOKE, 2, 500, 4)).toMatchObject({ xpPerBook: 500, books: 5 });
    });

    test('a leftover XP balance that is not an exact book boundary still costs a whole book', () => {
        // 3000 − 520 = 2480 XP needed, at 50 per book: 49.6 books on paper, but
        // only whole books can be bought, so it must round up to 50 rather than
        // undercount the last, partially-wasted book.
        const detail = explainAbilityLevelUpCost(FIREBALL, 2, 520, 4);
        expect(detail.books).toBe(50);
        expect(detail.total).toBe(50_000);
    });

    test('learning it from nothing costs one book more than the levels do', () => {
        const learn = explainAbilityLevelUpCost(FIREBALL, 0, 0, 2);

        expect(learn.learnBook).toBe(true);
        expect(learn.books).toBe(11); // 500 XP / 50, plus the book that learns it
    });

    test('levelling one you already have does not pay to learn it again', () => {
        expect(explainAbilityLevelUpCost(FIREBALL, 2, 500, 3).learnBook).toBe(false);
    });
});

describe('what it comes to', () => {
    test('the mid price of the book, times the books', () => {
        const detail = explainAbilityLevelUpCost(FIREBALL, 2, 500, 4);

        expect(detail.bookPrice).toBe(1000);
        expect(detail.total).toBe(50_000);
    });

    test('one side of an empty order book stands in for the other', () => {
        game.prices['/items/fireball'] = { ask: 1500, bid: null };

        expect(explainAbilityLevelUpCost(FIREBALL, 2, 500, 4).bookPrice).toBe(1500);
    });

    test('no listing at all is unknown, not free', () => {
        // Ranked as free, an unsellable book would sit at the top of a list
        // sorted by gold — the one place a wrong number does the most damage
        game.prices = {};
        const detail = explainAbilityLevelUpCost(FIREBALL, 2, 500, 4);

        expect(detail.total).toBe(null);
        expect(detail.bookPrice).toBe(null);
        // Still says how many books, which is the part the market cannot answer
        expect(detail.books).toBe(50);
    });

    test('no game data is nothing known, rather than a throw', () => {
        game.data = null;

        expect(explainAbilityLevelUpCost(FIREBALL, 2, 500, 4).total).toBe(null);
    });
});

describe('owning it from nothing', () => {
    test('is the levelling cost starting from zero', () => {
        // 3000 XP at 50 per book, plus the book that learns it
        expect(explainAbilityCost(FIREBALL, 4)).toMatchObject({ books: 61, total: 61_000 });
    });

    test('and is null, not zero, when the book has no listing', () => {
        // The whole reason the old `calculateAbilityCost` was retired: a score
        // or a networth that reads an unpriceable ability as free is wrong in
        // the direction nobody checks
        game.prices = {};

        expect(explainAbilityCost(FIREBALL, 4).total).toBe(null);
    });
});

describe('the retired zero-returning wrappers', () => {
    test('are gone rather than deprecated, so nothing can reach for them', () => {
        expect(abilityCostCalculator.calculateAbilityCost).toBeUndefined();
        expect(abilityCostCalculator.calculateAbilityLevelUpCost).toBeUndefined();
    });
});
