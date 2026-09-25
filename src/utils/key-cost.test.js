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
import { patientTickPrice } from './patient-tick.js';

const settings = vi.hoisted(() => ({
    keyPricingMode: 'ask',
    pricingMode: 'hybrid',
    patientTickBuy: false,
    patientTickSell: false,
}));

const game = vi.hoisted(() => ({ initClientData: null, itemDetails: {} }));

const market = vi.hoisted(() => ({
    /** itemHrid → {ask, bid}, or absent for "nobody is selling" */
    book: {},
}));

const buffs = vi.hoisted(() => ({ actionStats: { actionTime: 60, totalEfficiency: 0 } }));

/** Who is logged in, and the artisan bonus that makes their craft cost theirs */
const player = vi.hoisted(() => ({ id: 'char-1', artisan: 0 }));

vi.mock('../core/config.js', () => ({
    default: {
        getSettingValue: (id) => {
            if (id === 'profitCalc_pricingMode') return settings.pricingMode;
            if (id === 'profitCalc_patientTickBuy') return settings.patientTickBuy;
            if (id === 'profitCalc_patientTickSell') return settings.patientTickSell;
            return settings.keyPricingMode;
        },
    },
}));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.initClientData,
        getItemDetails: (hrid) => game.itemDetails[hrid] ?? null,
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => [],
        getSkills: () => [],
        getCurrentCharacterId: () => player.id,
    },
}));

vi.mock('../api/marketplace.js', () => ({
    default: { getPrice: (hrid) => market.book[hrid] ?? null },
}));

vi.mock('./market-data.js', () => ({
    // The real rule, kept to the two modes these tests use: hybrid buys at the
    // ask, patientBuy at the bid.
    getPricingMode: (context, side) =>
        context === 'profit' && side === 'buy' && settings.pricingMode === 'patientBuy' ? 'bid' : 'ask',
    // Mirrors the two things the real getItemPrice does that this suite cares
    // about: an explicit `mode` is an exact book side, and a caller that hands
    // no `mode` at all (computeBestCraftingPlan's "follow global" branch, taken
    // whenever `mode` is not the literal 'ask'/'bid'/'average') resolves the side
    // from the pricing-mode setting and picks up the patient tick. That second
    // branch is what `describeKeyCost` now routes a key's own craft materials
    // through whenever the key setting follows the global buy side.
    getItemPrice: (hrid, options = {}) => {
        const entry = market.book[hrid];
        if (!entry) return null;

        const resolvedMode =
            options.mode || (settings.pricingMode === 'patientBuy' && options.side === 'buy' ? 'bid' : 'ask');
        const basis = entry[resolvedMode] != null ? resolvedMode : 'ask';
        const price = entry[basis];
        if (price == null) return null;
        if (options.mode || options.context !== 'profit') return price;

        return patientTickPrice(price, options.side || 'sell', basis, {
            ask: entry.ask,
            bid: entry.bid,
            itemHrid: hrid,
        });
    },
}));

vi.mock('./game-lookups.js', () => ({ getShopCoinCost: () => 0 }));

vi.mock('./tea-parser.js', () => ({ parseArtisanBonus: () => player.artisan, getDrinkConcentration: () => 0 }));

// parseArtisanBonus above ignores its arguments, so what resolveActionContext
// returns is not what this suite is pinning — only that calling it does not
// throw (the real one reaches a loadout-snapshot feature module this suite
// never mocks).
vi.mock('./action-context.js', () => ({
    resolveActionContext: () => ({ equipment: new Map(), drinks: [] }),
}));

vi.mock('./action-calculator.js', () => ({ calculateActionStats: () => buffs.actionStats }));

const {
    describeKeyCost,
    describeKeyCosts,
    formatKeyCostNote,
    getKeyPricingMode,
    getKeyUnitCost,
    invalidateKeyCostCache,
    resolveKeyPricing,
} = await import('./key-cost.js');
const { nextPriceUp } = await import('./market-values.js');

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
    settings.pricingMode = 'hybrid';
    settings.patientTickBuy = false;
    settings.patientTickSell = false;
    player.id = 'char-1';
    player.artisan = 0;
    invalidateKeyCostCache();
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

describe('patient +1 tick', () => {
    test('synced to a patient global buy side, the bid steps one tick up', () => {
        settings.keyPricingMode = 'synced';
        settings.pricingMode = 'patientBuy';
        settings.patientTickBuy = true;

        expect(describeKeyCost(ENTRY_KEY).buyPrice).toBe(nextPriceUp(15000));
        expect(getKeyUnitCost(ENTRY_KEY)).toBe(nextPriceUp(15000));
        // A caller echoing the resolved side back (as combat stats does) still follows it
        expect(describeKeyCost(ENTRY_KEY, { mode: 'bid' }).buyPrice).toBe(nextPriceUp(15000));
        // Asking for the other side is asking for an exact price
        expect(describeKeyCost(ENTRY_KEY, { mode: 'ask' }).buyPrice).toBe(20000);
    });

    test('the craft basis follows the global side too, and its cache misses when the tick flips', () => {
        settings.keyPricingMode = 'craft';
        settings.pricingMode = 'patientBuy';
        settings.patientTickBuy = true;

        // No recipe, so the craft basis settles on the market quote
        expect(getKeyUnitCost(ENTRY_KEY)).toBe(nextPriceUp(15000));
        settings.patientTickBuy = false;
        expect(getKeyUnitCost(ENTRY_KEY)).toBe(15000);
    });

    test('the craft basis ticks its recipe materials too, not just a keyless market quote', () => {
        settings.keyPricingMode = 'craft';
        settings.pricingMode = 'patientBuy';
        settings.patientTickBuy = true;

        // Essence bids at 900; a patient buy queues one tick above it
        const tickedEssence = nextPriceUp(900);
        expect(tickedEssence).toBeGreaterThan(900);
        expect(describeKeyCost(CHEST_KEY).craftCost).toBe(5 * tickedEssence);
    });

    test('with the tick off, the craft basis prices its materials at the exact bid', () => {
        settings.keyPricingMode = 'craft';
        settings.pricingMode = 'patientBuy';
        settings.patientTickBuy = false;

        expect(describeKeyCost(CHEST_KEY).craftCost).toBe(4500);
    });

    test('an explicit mode on the craft basis prices materials at the exact side, never ticked', () => {
        settings.keyPricingMode = 'craft';
        settings.pricingMode = 'patientBuy';
        settings.patientTickBuy = true;

        // The setting resolves to 'bid'; asking for 'ask' explicitly is asking
        // for an exact book price, both for the key and for its materials
        expect(describeKeyCost(CHEST_KEY, { mode: 'ask' }).craftCost).toBe(5000);
    });

    test('synced also ticks the craft-cost comparison, even though its basis stays market', () => {
        // 'synced' stays on the market basis for the KEY itself, but the same
        // "does this mode follow the global side" gate governs the materials
        // priced for the buy-vs-craft comparison, so they tick the same way
        // craft's materials do
        settings.keyPricingMode = 'synced';
        settings.pricingMode = 'patientBuy';
        settings.patientTickBuy = true;

        const cost = describeKeyCost(CHEST_KEY);
        expect(cost.basis).toBe('market');
        expect(cost.craftCost).toBe(5 * nextPriceUp(900));
    });

    test('an explicit bid setting is an exact side and is never moved', () => {
        settings.keyPricingMode = 'bid';
        settings.pricingMode = 'patientBuy';
        settings.patientTickBuy = true;

        expect(describeKeyCost(ENTRY_KEY).buyPrice).toBe(15000);
        expect(getKeyUnitCost(ENTRY_KEY)).toBe(15000);
    });

    test('with the tick off, synced is exact', () => {
        settings.keyPricingMode = 'synced';
        settings.pricingMode = 'patientBuy';

        expect(getKeyUnitCost(ENTRY_KEY)).toBe(15000);
    });

    test('keys are only bought, so the sell tick alone never moves one', () => {
        settings.keyPricingMode = 'synced';
        settings.pricingMode = 'patientBuy';
        settings.patientTickSell = true;

        expect(describeKeyCost(ENTRY_KEY).buyPrice).toBe(15000);
        settings.keyPricingMode = 'craft';
        expect(describeKeyCost(CHEST_KEY).craftCost).toBe(4500);
    });

    test('an instant global buy side has no queue to jump', () => {
        settings.keyPricingMode = 'synced';
        settings.patientTickBuy = true;

        expect(getKeyUnitCost(ENTRY_KEY)).toBe(20000);
    });
});

describe('describeKeyCost', () => {
    test('on the market basis, charges the market price even when crafting is cheaper', () => {
        // 'ask' is a market-basis mode: the market price is charged full stop,
        // never compared against the recipe. `craftCost` and `savings` are
        // still reported so a display can say crafting would have been
        // cheaper, but `unitCost` is never the craft cost here.
        const cost = describeKeyCost(CHEST_KEY);

        expect(cost.buyPrice).toBe(8000);
        expect(cost.craftCost).toBe(5000);
        expect(cost.cheaper).toBe('buy');
        expect(cost.unitCost).toBe(8000);
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

    test('an explicit mode overrides the setting, and stays on the market basis', () => {
        settings.keyPricingMode = 'bid';

        const cost = describeKeyCost(CHEST_KEY, { mode: 'ask' });

        expect(cost.pricingMode).toBe('ask');
        expect(cost.buyPrice).toBe(8000);
        expect(cost.craftCost).toBe(5000);
        // An explicit `mode` with no `basis` resolves to the market basis (see
        // `describeKeyCost`'s docstring), so the market price is charged even
        // though the recipe is cheaper here.
        expect(cost.cheaper).toBe('buy');
        expect(cost.unitCost).toBe(8000);
    });

    test('the market basis buys even when the recipe comes to exactly the same gold', () => {
        market.book[CHEST_KEY] = { ask: 5000, bid: 5000 };

        const cost = describeKeyCost(CHEST_KEY);

        expect(cost.craftCost).toBe(5000);
        expect(cost.cheaper).toBe('buy');
        expect(cost.unitCost).toBe(5000);
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
        // Both are market-basis (default 'ask'): the market price wins for
        // both, even though crafting the chest key would be cheaper.
        expect(costs.get(CHEST_KEY).cheaper).toBe('buy');
        expect(costs.get(ENTRY_KEY).cheaper).toBe('buy');
    });
});

describe('formatKeyCostNote', () => {
    const plain = { formatNumber: (value) => String(Math.round(value)), formatSeconds: (s) => `${s}s` };

    test('names both sides and the one that was used', () => {
        // Default 'ask' is a market-basis mode, so the market price is used
        // even though crafting is cheaper here — the note must say so without
        // claiming the figure charged is the cheaper one.
        const note = formatKeyCostNote(describeKeyCost(CHEST_KEY), plain);

        expect(note).toBe('craft 5000 (60s) ea vs buy 8000 — using bought, crafting would save 3000 ea');
    });

    test('says the plain savings when the route used is also the cheaper side', () => {
        settings.keyPricingMode = 'craft';
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

    test('never answers with the raw setting, so a price map lookup cannot come back undefined', () => {
        settings.keyPricingMode = 'craft';
        expect(['ask', 'bid']).toContain(getKeyPricingMode());

        settings.keyPricingMode = 'synced';
        settings.pricingMode = 'patientBuy';
        expect(getKeyPricingMode()).toBe('bid');
    });
});

describe('resolveKeyPricing', () => {
    test('the two stored modes the setting shipped with are passed through untouched', () => {
        settings.keyPricingMode = 'ask';
        expect(resolveKeyPricing()).toEqual({ setting: 'ask', priceSide: 'ask', basis: 'market' });

        settings.keyPricingMode = 'bid';
        expect(resolveKeyPricing()).toEqual({ setting: 'bid', priceSide: 'bid', basis: 'market' });
    });

    test('a legacy stored mode ignores the general pricing setting entirely', () => {
        settings.keyPricingMode = 'ask';
        settings.pricingMode = 'patientBuy';

        expect(resolveKeyPricing().priceSide).toBe('ask');
        expect(describeKeyCost(CHEST_KEY).buyPrice).toBe(8000);
    });

    test('synced follows the general setting buy side', () => {
        settings.keyPricingMode = 'synced';

        settings.pricingMode = 'hybrid';
        expect(resolveKeyPricing()).toEqual({ setting: 'synced', priceSide: 'ask', basis: 'market' });

        settings.pricingMode = 'patientBuy';
        expect(resolveKeyPricing()).toEqual({ setting: 'synced', priceSide: 'bid', basis: 'market' });
    });

    test('craft prices its materials on the general buy side', () => {
        settings.keyPricingMode = 'craft';

        settings.pricingMode = 'hybrid';
        expect(resolveKeyPricing()).toEqual({ setting: 'craft', priceSide: 'ask', basis: 'craft' });

        settings.pricingMode = 'patientBuy';
        expect(resolveKeyPricing()).toEqual({ setting: 'craft', priceSide: 'bid', basis: 'craft' });
    });

    test('a stored value nobody recognises lands on ask instead of breaking key valuation', () => {
        settings.keyPricingMode = 'midpoint-ish';
        expect(resolveKeyPricing()).toEqual({ setting: 'ask', priceSide: 'ask', basis: 'market' });
        expect(describeKeyCost(CHEST_KEY).buyPrice).toBe(8000);
    });
});

describe('the synced pricing mode', () => {
    test('values a key the way the general setting buys', () => {
        settings.keyPricingMode = 'synced';
        settings.pricingMode = 'patientBuy';

        const cost = describeKeyCost(CHEST_KEY);

        expect(cost.basis).toBe('market');
        expect(cost.pricingMode).toBe('bid');
        expect(cost.buyPrice).toBe(4000);
        expect(cost.craftCost).toBe(4500);
        // Same answer 'bid' gives, which is the point of syncing
        expect(cost.unitCost).toBe(4000);
    });
});

describe('the craft pricing mode', () => {
    test('takes the craft cost even when the market is cheaper', () => {
        settings.keyPricingMode = 'craft';
        // Ask 8000 against 5000 of essence: the market basis would still prefer
        // the craft here, so drop the key's ask below the recipe to prove the
        // basis is deciding rather than the comparison.
        market.book[CHEST_KEY] = { ask: 1000, bid: 900 };

        const cost = describeKeyCost(CHEST_KEY);

        expect(cost.basis).toBe('craft');
        expect(cost.buyPrice).toBe(1000);
        expect(cost.craftCost).toBe(5000);
        expect(cost.cheaper).toBe('craft');
        expect(cost.unitCost).toBe(5000);
    });

    test('reports a recipe with an unpriced material as unpriced, and falls back to the market', () => {
        settings.keyPricingMode = 'craft';
        delete market.book[ESSENCE];

        const cost = describeKeyCost(CHEST_KEY);

        // Never a partial total with a free material in it
        expect(cost.craftCost).toBeNull();
        // ...and never a free key either: the replacement cost is what is left
        expect(cost.cheaper).toBe('buy');
        expect(cost.unitCost).toBe(8000);
    });

    test('falls back to the market for a key that has no recipe at all', () => {
        settings.keyPricingMode = 'craft';

        const cost = describeKeyCost(ENTRY_KEY);

        expect(cost.craftCost).toBeNull();
        expect(cost.cheaper).toBe('buy');
        expect(cost.unitCost).toBe(20000);
    });

    test('a key with no recipe and no market is still uncosted, not free', () => {
        settings.keyPricingMode = 'craft';

        const cost = describeKeyCost(SINISTER_KEY);

        expect(cost.unitCost).toBeNull();
    });
});

describe('getKeyUnitCost', () => {
    test('is the market side on every market basis', () => {
        expect(getKeyUnitCost(CHEST_KEY)).toBe(8000);

        settings.keyPricingMode = 'bid';
        invalidateKeyCostCache();
        expect(getKeyUnitCost(CHEST_KEY)).toBe(4000);

        settings.keyPricingMode = 'synced';
        settings.pricingMode = 'patientBuy';
        expect(getKeyUnitCost(CHEST_KEY)).toBe(4000);
    });

    test('is the craft cost on the craft basis', () => {
        settings.keyPricingMode = 'craft';
        expect(getKeyUnitCost(CHEST_KEY)).toBe(5000);
    });

    test('is null, never zero, for a key nothing can price', () => {
        expect(getKeyUnitCost(SINISTER_KEY)).toBeNull();
        expect(getKeyUnitCost(null)).toBeNull();
    });

    test('caches the craft basis per market side, so changing the setting is not a stale read', () => {
        settings.keyPricingMode = 'craft';
        expect(getKeyUnitCost(CHEST_KEY)).toBe(5000);

        settings.pricingMode = 'patientBuy';
        expect(getKeyUnitCost(CHEST_KEY)).toBe(4500);
    });

    test('does not serve one character the craft cost priced for another', () => {
        // A craft cost is personal, and this cache outlives a character switch:
        // net worth, the badges, the tooltip and the chest model all read it
        settings.keyPricingMode = 'craft';
        expect(getKeyUnitCost(CHEST_KEY)).toBe(5000);

        // An alt with artisan tea up buys a fifth fewer materials
        player.id = 'char-2';
        player.artisan = 0.2;
        expect(getKeyUnitCost(CHEST_KEY)).toBe(4000);
    });

    test('does not cache a key nothing could price yet', () => {
        // The market snapshot loads asynchronously, so the first badge pass can
        // legitimately see an empty book; a cached null leaves every `?? 0`
        // downstream deducting a free key for the rest of the minute
        settings.keyPricingMode = 'craft';
        expect(getKeyUnitCost(SINISTER_KEY)).toBeNull();

        market.book[SINISTER_KEY] = { ask: 700, bid: 500 };
        expect(getKeyUnitCost(SINISTER_KEY)).toBe(700);
    });
});
