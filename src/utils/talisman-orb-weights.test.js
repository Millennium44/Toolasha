import { describe, test, expect, vi, beforeEach } from 'vitest';
import { ORB_ITEMS, TALISMAN_INFO } from '../__fixtures__/talisman-reroll.js';

const game = vi.hoisted(() => ({ actions: {}, inputPrices: {}, artisan: 0 }));

vi.mock('../core/data-manager.js', () => ({
    default: { getInitClientData: () => ({ actionDetailMap: game.actions }) },
}));
vi.mock('./market-data.js', () => ({ getItemPriceInfo: () => ({ price: null, source: null }) }));
vi.mock('./material-calculator.js', () => ({ calculateArtisanBonus: () => game.artisan }));
vi.mock('./profit-helpers.js', () => ({
    resolveItemPrice: (hrid) => {
        const price = game.inputPrices[hrid];
        return price === undefined
            ? { price: null, custom: false, missing: true, estimated: false }
            : { price: price.value ?? price, custom: false, missing: false, estimated: !!price.estimated };
    },
}));

const { orbWeights, coinCost, roundWeights } = await import('./talisman-orb-weights.js');
const { orbRecipeCost } = await import('./talisman-orb-recipe-cost.js');

const RESHAPING = '/items/reshaping_orb';
const ORBS = Object.keys(ORB_ITEMS);

// The real action, as the test server sends it
const RESHAPING_ACTION = {
    hrid: '/actions/crafting/reshaping_orb',
    function: '/action_functions/production',
    type: '/action_types/crafting',
    category: '/action_categories/crafting/talisman',
    levelRequirement: { skillHrid: '/skills/crafting', level: 100 },
    baseTimeCost: 30000000000,
    upgradeItemHrid: '',
    inputItems: [
        { itemHrid: '/items/ancient_lumber', count: 20 },
        { itemHrid: '/items/dragon_leather', count: 20 },
    ],
    outputItems: [{ itemHrid: RESHAPING, count: 1 }],
};

/** Market quotes: every orb in `listed` is priced 1000 on the book, the rest have no listing */
const market =
    (listed, source = 'book') =>
    (hrid) =>
        listed.includes(hrid) ? { price: 1000, source } : { price: null, source: null };

beforeEach(() => {
    game.actions = { [RESHAPING_ACTION.hrid]: structuredClone(RESHAPING_ACTION) };
    game.inputPrices = { '/items/ancient_lumber': 10, '/items/dragon_leather': 40 };
    game.artisan = 0;
});

describe('orb recipe cost', () => {
    test('prices every input, no partial sum', () => {
        expect(orbRecipeCost(RESHAPING)).toBe(20 * 10 + 20 * 40);
        delete game.inputPrices['/items/dragon_leather'];
        expect(orbRecipeCost(RESHAPING)).toBeNull();
    });

    test('an estimated or zero input price is not a price', () => {
        game.inputPrices['/items/dragon_leather'] = { value: 40, estimated: true };
        expect(orbRecipeCost(RESHAPING)).toBeNull();
        game.inputPrices['/items/dragon_leather'] = 0;
        expect(orbRecipeCost(RESHAPING)).toBeNull();
    });

    test('divides by the output count', () => {
        game.actions[RESHAPING_ACTION.hrid].outputItems = [{ itemHrid: RESHAPING, count: 2 }];
        expect(orbRecipeCost(RESHAPING)).toBe(500);
    });

    test('artisan tea reduces inputs and a coin input', () => {
        game.artisan = 0.1;
        game.actions[RESHAPING_ACTION.hrid].inputItems.push({ itemHrid: '/items/coin', count: 1000 });
        expect(orbRecipeCost(RESHAPING)).toBeCloseTo((200 + 800 + 1000) * 0.9);
    });

    test('an upgrade base is added whole, and an unpriced one blocks the price', () => {
        game.actions[RESHAPING_ACTION.hrid].upgradeItemHrid = '/items/base';
        expect(orbRecipeCost(RESHAPING)).toBeNull();
        game.inputPrices['/items/base'] = 500;
        expect(orbRecipeCost(RESHAPING)).toBe(1000 + 500);
    });

    test('no recipe, no action map, or an empty recipe: null', () => {
        expect(orbRecipeCost('/items/focus_orb')).toBeNull();
        game.actions = {};
        expect(orbRecipeCost(RESHAPING)).toBeNull();
        game.actions = { a: { inputItems: [], outputItems: [{ itemHrid: RESHAPING, count: 1 }] } };
        expect(orbRecipeCost(RESHAPING)).toBeNull();
    });

    test('an input that is itself an orb uses its market price only, never its recipe', () => {
        const orbHrids = new Set(ORBS);
        game.actions['/actions/crafting/focus_orb'] = {
            inputItems: [{ itemHrid: '/items/ancient_lumber', count: 1 }],
            outputItems: [{ itemHrid: '/items/focus_orb', count: 1 }],
        };
        game.actions[RESHAPING_ACTION.hrid].inputItems = [{ itemHrid: '/items/focus_orb', count: 2 }];
        expect(orbRecipeCost(RESHAPING, { orbHrids, priceOrb: () => null })).toBeNull();
        expect(orbRecipeCost(RESHAPING, { orbHrids, priceOrb: () => 300 })).toBe(600);
    });
});

describe('orb weights with recipe pricing', () => {
    const others = ORBS.filter((hrid) => hrid !== RESHAPING);

    test('all seven on the market: market scale, nothing crafted', () => {
        const result = orbWeights(TALISMAN_INFO, ORB_ITEMS, market(ORBS));
        expect(result.scale).toBe('market');
        expect(result.crafted).toEqual([]);
    });

    test('six on the market, one with a priced recipe: coin scale with that orb marked crafted', () => {
        const result = orbWeights(TALISMAN_INFO, ORB_ITEMS, market(others));
        expect(result.scale).toBe('market');
        expect(result.crafted).toEqual([RESHAPING]);
        expect(result.prices[RESHAPING]).toBe(1000);
        expect(result.weights[RESHAPING]).toBe(1000);
        const counts = { [RESHAPING]: 2, '/items/binding_orb': 1 };
        expect(coinCost(counts, result.prices)).toBe(3000);
    });

    test('a custom price beats the recipe', () => {
        const result = orbWeights(TALISMAN_INFO, ORB_ITEMS, market(ORBS, 'custom'));
        expect(result.crafted).toEqual([]);
    });

    test('a market listing beats the recipe', () => {
        game.inputPrices = { '/items/ancient_lumber': 1, '/items/dragon_leather': 1 };
        const result = orbWeights(TALISMAN_INFO, ORB_ITEMS, market(ORBS));
        expect(result.prices[RESHAPING]).toBe(1000);
        expect(result.crafted).toEqual([]);
    });

    test('a recipe with an unpriced input falls back to item value for all, with no crafted price kept', () => {
        delete game.inputPrices['/items/dragon_leather'];
        const result = orbWeights(TALISMAN_INFO, ORB_ITEMS, market(others));
        expect(result.scale).toBe('itemValue');
        expect(result.crafted).toEqual([]);
        expect(result.prices[RESHAPING]).toBeUndefined();
        expect(coinCost({ [RESHAPING]: 1 }, result.prices)).toBeNull();
    });

    test('a recipe cannot complete the scale while another orb has neither listing nor recipe', () => {
        const result = orbWeights(TALISMAN_INFO, ORB_ITEMS, market(others.slice(1)));
        expect(result.scale).toBe('itemValue');
        expect(result.crafted).toEqual([]);
        expect(result.prices[RESHAPING]).toBeUndefined();
    });

    test('no recipes anywhere: behavior is unchanged from before recipe pricing', () => {
        game.actions = {};
        const all = orbWeights(TALISMAN_INFO, ORB_ITEMS, market(ORBS));
        expect(all).toMatchObject({ scale: 'market', crafted: [] });
        const partial = orbWeights(TALISMAN_INFO, ORB_ITEMS, market(others));
        expect(partial.scale).toBe('itemValue');
        expect(partial.weights[RESHAPING]).toBe(ORB_ITEMS[RESHAPING].sellPrice);
        expect(partial.prices[RESHAPING]).toBeUndefined();
        expect(orbWeights(TALISMAN_INFO, {}, market([])).scale).toBe('count');
    });

    test('a recipe price change moves the weights the solve cache is keyed on', () => {
        const before = roundWeights(orbWeights(TALISMAN_INFO, ORB_ITEMS, market(others)).weights);
        game.inputPrices['/items/dragon_leather'] = 400;
        const after = roundWeights(orbWeights(TALISMAN_INFO, ORB_ITEMS, market(others)).weights);
        expect(after[RESHAPING]).not.toBe(before[RESHAPING]);
    });
});
