/**
 * @vitest-environment happy-dom
 *
 * The Ability Book panel, built rather than reasoned about.
 *
 * The arithmetic is tested where it lives. What only building the panel catches
 * is that it reads the character's abilities the way the game actually hands
 * them over, and that every section draws.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ data: {}, prices: {}, character: null }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.data,
        get characterData() {
            return game.character;
        },
    },
}));
vi.mock('../../core/config.js', () => ({ default: { Z_FLOATING_PANEL: 1100 } }));
vi.mock('../../utils/panel-geometry.js', () => ({ restoreGeometry: () => {}, saveGeometry: () => {} }));
vi.mock('../../utils/market-data.js', () => ({ getItemPrices: (hrid) => game.prices[hrid] || null }));
vi.mock('../../utils/marketplace-tabs.js', () => ({ navigateToMarketplace: () => {} }));

const { abilityBookPanel, abilityPlans } = await import('./ability-book-panel.js');

/** Each level costs 1,000 more experience than the last */
const table = [0, 0];
for (let level = 2; level <= 200; level++) table[level] = table[level - 1] + 1000;

beforeEach(() => {
    game.data = {
        levelExperienceTable: table,
        abilityDetailMap: {
            '/abilities/poke': { name: 'Poke' },
            '/abilities/smack': { name: 'Smack' },
            '/abilities/rare_move': { name: 'Rare Move' },
        },
        itemDetailMap: {
            '/items/poke': { abilityBookDetail: { experienceGain: 500 } },
            '/items/smack': { abilityBookDetail: { experienceGain: 500 } },
            '/items/rare_move': { abilityBookDetail: { experienceGain: 500 } },
        },
    };
    // Equipped is the kit; characterAbilities is where the experience lives
    game.character = {
        combatUnit: {
            combatAbilities: [
                { abilityHrid: '/abilities/poke', level: 2 },
                { abilityHrid: '/abilities/smack', level: 2 },
                { abilityHrid: '/abilities/rare_move', level: 0 },
            ],
        },
        characterAbilities: [
            { abilityHrid: '/abilities/poke', level: 2, experience: 1000 },
            { abilityHrid: '/abilities/smack', level: 2, experience: 1000 },
            { abilityHrid: '/abilities/never_slotted', level: 9, experience: 0 },
        ],
    };
    game.prices = {
        '/items/poke': { ask: 900000, bid: 1 },
        '/items/smack': { ask: 4000, bid: 1 },
    };
});

afterEach(() => {
    abilityBookPanel.hide();
});

const text = () => abilityBookPanel.panel.textContent;
const FAILED = 'could not be drawn';

describe('the panel renders', () => {
    test('every section draws, and none of them fails', () => {
        abilityBookPanel.show();

        expect(text()).toContain('Poke');
        expect(text()).toContain('Smack');
        expect(text()).not.toContain(FAILED);
    });

    test('only the equipped kit is listed, not everything ever learned', () => {
        // The panel is about what to buy next for the build you are running
        expect(abilityPlans().map((plan) => plan.name)).not.toContain('Never Slotted');
        expect(abilityPlans()).toHaveLength(3);
    });

    test('experience comes from the character, not from the equipped slot', () => {
        // The slot carries a level and no experience; without joining the two
        // every ability reads as freshly levelled and every plan costs a full
        // level more than it should
        expect(abilityPlans().find((plan) => plan.name === 'Poke').experience).toBe(1000);
    });

    test('it draws before the game has sent anything', () => {
        game.data = {};
        game.character = null;
        abilityBookPanel.show();
        expect(text()).toContain('No abilities');
        expect(text()).not.toContain(FAILED);
    });

    test('opening it twice does not build a second one', () => {
        abilityBookPanel.show();
        abilityBookPanel.show();
        expect(document.querySelectorAll('#toolasha-ability-book-panel')).toHaveLength(1);
    });
});

describe('what it puts first', () => {
    test('cheapest, not nearest', () => {
        // Poke and Smack are the same distance from their next level; Smack's
        // book costs a fraction of Poke's, and that is the whole question
        expect(abilityPlans()[0].name).toBe('Smack');
    });

    test('the cheapest reaches the header', () => {
        abilityBookPanel.show();
        expect(abilityBookPanel.headerBest.textContent).toContain('Smack');
    });

    test('an unpriced book sorts last and cannot win', () => {
        const plans = abilityPlans();
        expect(plans[plans.length - 1].name).toBe('Rare Move');
        expect(abilityBookPanel.panel).toBeNull();
    });

    test('an unpriced book says so rather than showing nothing', () => {
        abilityBookPanel.show();
        expect(text()).toContain('no price');
    });
});

describe('the rows', () => {
    test('an unlearned ability costs exactly the book that teaches it', () => {
        // Level 1 sits at zero experience, so nothing is owed towards it — the
        // one book is the ability itself, which is the case a plain division
        // reports as zero books
        const rare = abilityPlans().find((plan) => plan.name === 'Rare Move');
        expect(rare.level).toBe(0);
        expect(rare.booksToNext).toBe(1);

        abilityBookPanel.show();
        expect(text()).toContain('Rare Move');
    });

    test('and a learned ability pays only for the experience', () => {
        // Poke is 1,000 experience from level 3 at 500 a book
        expect(abilityPlans().find((plan) => plan.name === 'Poke').booksToNext).toBe(2);
    });

    test('an ability whose book the game does not describe is not a row', () => {
        game.data.itemDetailMap = {};
        expect(abilityPlans()).toEqual([]);
    });
});

describe('the shared target', () => {
    test('typing a level costs every ability up to it', () => {
        abilityBookPanel.show();

        const input = abilityBookPanel.panel.querySelector('input[type="number"]');
        input.value = '5';
        input.dispatchEvent(new Event('change'));

        // Level 5 is at 4,000; Poke is at 1,000, so six books
        expect(abilityPlans().find((plan) => plan.name === 'Poke').booksToTarget).toBe(6);
        expect(text()).toContain('To 5');
    });

    test('the total says how many it could not price', () => {
        // Otherwise a lower bound reads as a total
        abilityBookPanel.show();
        expect(text()).toContain('1 unpriced');
    });

    test('clearing it goes back to the next level', () => {
        abilityBookPanel.show();
        const input = abilityBookPanel.panel.querySelector('input[type="number"]');

        input.value = '5';
        input.dispatchEvent(new Event('change'));
        input.value = '';
        input.dispatchEvent(new Event('change'));

        expect(abilityPlans()[0].booksToTarget).toBeNull();
    });
});
