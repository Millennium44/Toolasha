/**
 * Tests for dungeon key costing
 *
 * The market book and the recipe book are mocked; the costing is not — the real
 * `describeCraft` and `computeBestCraftingPlan` run underneath, because the
 * thing worth pinning is that the two sources of a key are compared correctly,
 * not that a stub returned what it was told to.
 *
 * Standing fixture (unless a test says otherwise):
 *   chimerical essence   — no recipe, ask 1000 / bid 900
 *   chimerical chest key — 5 essence → 1, ask 8000 / bid 4000
 *                          craft is 5000 at ask, 4500 at bid
 *   chimerical entry key — no recipe, ask 20000
 *   pirate chest key     — 5 essence → 1, not on the market
 *   sinister chest key   — no recipe, not on the market
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const settings = vi.hoisted(() => ({ keyPricingMode: 'ask' }));

const game = vi.hoisted(() => ({ initClientData: null, itemDetails: {} }));

const market = vi.hoisted(() => ({
    /** itemHrid → {ask, bid}, or absent for "nobody is selling" */
    book: {},
}));

const buffs = vi.hoisted(() => ({ actionStats: { actionTime: 60, totalEfficiency: 0 } }));

vi.mock('../core/config.js', () => ({
    default: { getSettingValue: () => settings.keyPricingMode },
}));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.initClientData,
        getItemDetails: (hrid) => game.itemDetails[hrid] ?? null,
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => [],
        getSkills: () => [],
    },
}));

vi.mock('../api/marketplace.js', () => ({
    default: { getPrice: (hrid) => market.book[hrid] ?? null },
}));

vi.mock('./market-data.js', () => ({
    getItemPrice: (hrid, options = {}) => {
        const entry = market.book[hrid];
        if (!entry) return null;
        return entry[options.mode || 'ask'] ?? entry.ask ?? null;
    },
}));

vi.mock('./game-lookups.js', () => ({ getShopCoinCost: () => 0 }));

vi.mock('./tea-parser.js', () => ({ parseArtisanBonus: () => 0, getDrinkConcentration: () => 0 }));

vi.mock('./action-calculator.js', () => ({ calculateActionStats: () => buffs.actionStats }));

const { describeKeyCost, describeKeyCosts, formatKeyCostNote, getKeyPricingMode } = await import('./key-cost.js');

const ESSENCE = '/items/chimerical_essence';
const CHEST_KEY = '/items/chimerical_chest_key';
const ENTRY_KEY = '/items/chimerical_entry_key';
const PIRATE_KEY = '/items/pirate_chest_key';
const SINISTER_KEY = '/items/sinister_chest_key';

/** A recipe of `count` essence into one of `itemHrid` */
function essenceRecipe(itemHrid, count = 5) {
    return {
        type: '/action_types/crafting',
        category: '/action_categories/crafting/key',
        inputItems: [{ itemHrid: ESSENCE, count }],
        outputItems: [{ itemHrid, count: 1 }],
        levelRequirement: { skillHrid: '/skills/crafting', level: 60 },
    };
}

beforeEach(() => {
    settings.keyPricingMode = 'ask';
    buffs.actionStats = { actionTime: 60, totalEfficiency: 0 };

    game.itemDetails = {
        [ESSENCE]: { name: 'Chimerical Essence', isTradable: true },
        [CHEST_KEY]: { name: 'Chimerical Chest Key', isTradable: true },
        [ENTRY_KEY]: { name: 'Chimerical Entry Key', isTradable: true },
        [PIRATE_KEY]: { name: 'Pirate Chest Key', isTradable: true },
        [SINISTER_KEY]: { name: 'Sinister Chest Key', isTradable: true },
    };

    // A fresh object each time: the production index is cached against the
    // identity of `actionDetailMap`, so reusing one would leak recipes between
    // tests that deliberately have none.
    game.initClientData = {
        itemDetailMap: game.itemDetails,
        actionDetailMap: {
            '/actions/crafting/chimerical_chest_key': essenceRecipe(CHEST_KEY),
            '/actions/crafting/pirate_chest_key': essenceRecipe(PIRATE_KEY),
        },
    };

    market.book = {
        [ESSENCE]: { ask: 1000, bid: 900 },
        [CHEST_KEY]: { ask: 8000, bid: 4000 },
        [ENTRY_KEY]: { ask: 20000, bid: 15000 },
    };
});

describe('describeKeyCost', () => {
    test('prefers crafting when the materials come to less than the market price', () => {
        const cost = describeKeyCost(CHEST_KEY);

        expect(cost.buyPrice).toBe(8000);
        expect(cost.craftCost).toBe(5000);
        expect(cost.cheaper).toBe('craft');
        expect(cost.unitCost).toBe(5000);
        expect(cost.savings).toBe(3000);
        expect(cost.itemName).toBe('Chimerical Chest Key');
    });

    test('prefers buying when the market undercuts the recipe', () => {
        market.book[CHEST_KEY] = { ask: 3000, bid: 2500 };

        const cost = describeKeyCost(CHEST_KEY);

        expect(cost.craftCost).toBe(5000);
        expect(cost.cheaper).toBe('buy');
        expect(cost.unitCost).toBe(3000);
        expect(cost.savings).toBe(2000);
    });

    test('reports the crafting time in seconds rather than folding it into the cost', () => {
        const cost = describeKeyCost(CHEST_KEY);

        // One 60s action per key at no efficiency, and the cost is materials only
        expect(cost.craftSeconds).toBe(60);
        expect(cost.craftCost).toBe(5000);
        expect(cost.craftActionHrid).toBe('/actions/crafting/chimerical_chest_key');
    });

    test('a key with no recipe can only be bought', () => {
        const cost = describeKeyCost(ENTRY_KEY);

        expect(cost.craftCost).toBeNull();
        expect(cost.craftSeconds).toBeNull();
        expect(cost.buyPrice).toBe(20000);
        expect(cost.cheaper).toBe('buy');
        expect(cost.unitCost).toBe(20000);
        expect(cost.savings).toBe(0);
    });

    test('a key nobody is selling can still be crafted', () => {
        const cost = describeKeyCost(PIRATE_KEY);

        expect(cost.buyPrice).toBeNull();
        expect(cost.craftCost).toBe(5000);
        expect(cost.cheaper).toBe('craft');
        expect(cost.unitCost).toBe(5000);
        expect(cost.savings).toBe(0);
    });

    test('a key with neither a price nor a recipe is uncosted, not free', () => {
        const cost = describeKeyCost(SINISTER_KEY);

        expect(cost.buyPrice).toBeNull();
        expect(cost.craftCost).toBeNull();
        expect(cost.cheaper).toBeNull();
        expect(cost.unitCost).toBeNull();
    });

    test('the pricing mode setting decides both sides, and can flip the verdict', () => {
        settings.keyPricingMode = 'bid';

        const cost = describeKeyCost(CHEST_KEY);

        expect(cost.pricingMode).toBe('bid');
        // Bid on the key is 4000, and the materials at bid come to 4500
        expect(cost.buyPrice).toBe(4000);
        expect(cost.craftCost).toBe(4500);
        expect(cost.cheaper).toBe('buy');
        expect(cost.unitCost).toBe(4000);
    });

    test('an explicit mode overrides the setting', () => {
        settings.keyPricingMode = 'bid';

        const cost = describeKeyCost(CHEST_KEY, { mode: 'ask' });

        expect(cost.pricingMode).toBe('ask');
        expect(cost.buyPrice).toBe(8000);
        expect(cost.craftCost).toBe(5000);
        expect(cost.cheaper).toBe('craft');
    });

    test('a tie goes to buying, because only crafting also costs time', () => {
        market.book[CHEST_KEY] = { ask: 5000, bid: 5000 };

        const cost = describeKeyCost(CHEST_KEY);

        expect(cost.craftCost).toBe(5000);
        expect(cost.cheaper).toBe('buy');
        expect(cost.savings).toBe(0);
    });

    test('artisan-style material reduction lands in the craft cost', () => {
        game.initClientData.actionDetailMap['/actions/crafting/chimerical_chest_key'] = essenceRecipe(CHEST_KEY, 4);

        expect(describeKeyCost(CHEST_KEY).craftCost).toBe(4000);
    });
});

describe('describeKeyCosts', () => {
    test('costs several keys at once and skips repeats', () => {
        const costs = describeKeyCosts([CHEST_KEY, ENTRY_KEY, CHEST_KEY, null]);

        expect(costs.size).toBe(2);
        expect(costs.get(CHEST_KEY).cheaper).toBe('craft');
        expect(costs.get(ENTRY_KEY).cheaper).toBe('buy');
    });
});

describe('formatKeyCostNote', () => {
    const plain = { formatNumber: (value) => String(Math.round(value)), formatSeconds: (s) => `${s}s` };

    test('names both sides and the one that was used', () => {
        const note = formatKeyCostNote(describeKeyCost(CHEST_KEY), plain);

        expect(note).toBe('craft 5000 (60s) ea vs buy 8000 — using crafted, saves 3000 ea');
    });

    test('says which side is missing when only one exists', () => {
        expect(formatKeyCostNote(describeKeyCost(ENTRY_KEY), plain)).toBe('buy 20000 ea — no recipe, using bought');
        expect(formatKeyCostNote(describeKeyCost(PIRATE_KEY), plain)).toBe(
            'craft 5000 (60s) ea — not on the market, using crafted'
        );
    });

    test('says nothing about a key it could not cost', () => {
        expect(formatKeyCostNote(describeKeyCost(SINISTER_KEY), plain)).toBe('');
        expect(formatKeyCostNote(null, plain)).toBe('');
    });
});

describe('getKeyPricingMode', () => {
    test('falls back to ask when the setting is unset', () => {
        settings.keyPricingMode = '';
        expect(getKeyPricingMode()).toBe('ask');
    });
});
