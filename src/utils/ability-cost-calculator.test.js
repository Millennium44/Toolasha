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

const { explainAbilityLevelUpCost, calculateAbilityLevelUpCost } = await import('./ability-cost-calculator.js');

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

describe('the number the older callers take', () => {
    test('is the same total', () => {
        expect(calculateAbilityLevelUpCost(FIREBALL, 2, 500, 4)).toBe(50_000);
    });

    test('and still zero when nothing is known, as it always was', () => {
        game.data = null;

        expect(calculateAbilityLevelUpCost(FIREBALL, 2, 500, 4)).toBe(0);
    });
});
