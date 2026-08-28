/**
 * @vitest-environment happy-dom
 *
 * The ability book calculator injected into the Item Dictionary.
 *
 * The arithmetic itself lives in `utils/ability-books.js` and is tested there;
 * this file is about what the calculator does with it at the level 200 cap,
 * where `booksToLevel` returns null (the experience table has nothing past
 * 200) rather than a number of books.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ data: {}, price: null }));

vi.mock('../../core/config.js', () => ({
    default: {
        COLOR_ACCENT: '#22c55e',
        COLOR_LOSS: '#f87171',
        getSetting: () => true,
        onSettingChange: () => {},
    },
}));
vi.mock('../../core/data-manager.js', () => ({ default: { getInitClientData: () => game.data } }));
vi.mock('../../api/marketplace.js', () => ({ default: { getPrice: () => game.price } }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));
vi.mock('../../utils/marketplace-autofill.js', () => ({
    createAutofillManager: () => ({ initialize: () => {}, setQuantity: () => {}, cleanup: () => {} }),
}));

const { default: abilityBookCalculator } = await import('./ability-book-calculator.js');

/** Each level costs 1,000 more experience than the last, up to the level 200 cap */
const table = [0, 0];
for (let level = 2; level <= 200; level++) table[level] = table[level - 1] + 1000;

beforeEach(() => {
    game.data = { levelExperienceTable: table };
    game.price = { ask: 100, bid: 90 };
});

/** A bare Item Dictionary panel, standing in for the real modal content */
const panel = () => document.createElement('div');

describe('the level 200 cap', () => {
    test('an ability already at the cap reads as maxed, not as needing zero books', async () => {
        const el = panel();
        await abilityBookCalculator.injectCalculator(el, { level: 200, xp: table[200] }, 500, '/items/poke');

        const text = el.textContent;
        expect(text).toContain('max');
        // Not the old behaviour: null coerced to 0 read as "Books needed: 0",
        // which said "buy nothing" rather than "cannot go further"
        expect(text).not.toContain('Books needed: 0');
        expect(text).not.toContain('NaN');
    });

    test('a maxed ability gets no level input to mistype 201 into', async () => {
        const el = panel();
        await abilityBookCalculator.injectCalculator(el, { level: 200, xp: table[200] }, 500, '/items/poke');

        expect(el.querySelector('#tillLevelInput')).toBeNull();
    });

    test('an ability one level below the cap still shows a normal calculator', async () => {
        const el = panel();
        await abilityBookCalculator.injectCalculator(el, { level: 199, xp: table[199] }, 500, '/items/poke');

        const input = el.querySelector('#tillLevelInput');
        expect(input).not.toBeNull();
        expect(input.value).toBe('200');
        // 1,000 experience to level 200 at 500 a book
        expect(el.textContent).toContain('Books needed: 2');
    });
});
