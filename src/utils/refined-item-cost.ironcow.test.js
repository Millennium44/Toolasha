/**
 * An Iron Cow character valuing a refined (★) item off-market (vendor `sellPrice`
 * or coinify output) gets that figure from `getItemPriceInfo` before the market
 * is even consulted — see `ironcow-valuation.js`. For `/items/gatherer_cape_refined`
 * that vendor figure is 100,000, roughly 800x cheaper than the ~79M of shards the
 * cape actually cost to refine. `priceInputWithRefinementFallback` used to accept
 * any positive `marketPrice` at face value, so an Iron Cow session costed a
 * destroyed cape at its vendor price instead of what refining one costs.
 *
 * The fix: a caller now also passes `marketSource` (from `getItemPriceInfo`), and
 * a `'vendor'`/`'coinify'` source on a refined item is treated as no market price
 * at all — not a real quote to compare craft against, but a valuation to fall
 * back on only if craft itself cannot be resolved.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const CAPE_HRID = '/items/gatherer_cape_refined';
const SHARD_HRID = '/items/labyrinth_refinement_shard';
const BASE_CAPE_HRID = '/items/gatherer_cape';

const mocks = vi.hoisted(() => ({
    // itemHrid -> { price, source }
    prices: {},
    refineAction: null,
    capeTradable: false,
}));

vi.mock('../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: (key, fallback) => fallback,
    },
}));

vi.mock('./market-data.js', () => {
    const infoOf = (itemHrid) =>
        itemHrid in mocks.prices ? mocks.prices[itemHrid] : { price: null, source: null, estimated: false };
    return {
        getItemPrice: (itemHrid) => infoOf(itemHrid).price,
        getItemPriceInfo: (itemHrid) => infoOf(itemHrid),
        getPricingMode: () => 'ask',
    };
});

vi.mock('../core/data-manager.js', () => ({
    default: {
        getItemDetails: (itemHrid) => (itemHrid === CAPE_HRID ? { sellPrice: 100_000 } : null),
        getInitClientData: () => ({
            itemDetailMap: {
                [CAPE_HRID]: { name: 'Gatherer Cape ★', isTradable: false },
                [BASE_CAPE_HRID]: { name: 'Gatherer Cape', isTradable: mocks.capeTradable },
                [SHARD_HRID]: { name: 'Labyrinth Refinement Shard' },
            },
            actionDetailMap: mocks.refineAction ? { '/actions/refine_cape': mocks.refineAction } : {},
        }),
    },
}));

const { priceInputWithRefinementFallback } = await import('./refined-item-cost.js');

beforeEach(() => {
    mocks.prices = {
        [SHARD_HRID]: { price: 892_000, source: 'book', estimated: false },
    };
    mocks.capeTradable = false;
    mocks.refineAction = {
        type: '/action_types/enhancing',
        upgradeItemHrid: BASE_CAPE_HRID,
        outputItems: [{ itemHrid: CAPE_HRID }],
        inputItems: [{ itemHrid: SHARD_HRID, count: 100 }],
    };
});

describe('refined-item cost vs an Iron Cow off-market valuation', () => {
    test('a vendor-valuation Iron Cow character costs the cape at its craft cost, not the vendor price', () => {
        const result = priceInputWithRefinementFallback(CAPE_HRID, 100_000, {
            enhancementLevel: 0,
            marketSource: 'vendor',
        });

        expect(result.price).toBeCloseTo(100 * 892_000, 6);
        expect(result.basis).toBe('refinement craft cost');
        expect(result.unpriced).toBe(false);
    });

    test('a coinify-valuation Iron Cow character also loses to the craft cost', () => {
        const result = priceInputWithRefinementFallback(CAPE_HRID, 60_000, {
            enhancementLevel: 0,
            marketSource: 'coinify',
        });

        expect(result.price).toBeCloseTo(100 * 892_000, 6);
        expect(result.basis).toBe('refinement craft cost');
    });

    test('a market-valuation (non-Iron-Cow) character is unaffected: no source, no change', () => {
        const result = priceInputWithRefinementFallback(CAPE_HRID, 1_000_000, {
            enhancementLevel: 0,
            marketSource: 'book',
        });

        expect(result.price).toBe(1_000_000);
        expect(result.basis).toBe('current buy');
    });

    test('an unrecognised/absent source is treated like a real quote (no regression for existing callers)', () => {
        const result = priceInputWithRefinementFallback(CAPE_HRID, 1_000_000, { enhancementLevel: 0 });

        expect(result.price).toBe(1_000_000);
        expect(result.basis).toBe('current buy');
    });

    test('a real book quote still wins when cheaper than the craft cost (no regression to cheaper-of-two)', () => {
        // Craft cost here is 100 * 892K = 89.2M; a 5M book quote is far cheaper
        const result = priceInputWithRefinementFallback(CAPE_HRID, 5_000_000, {
            enhancementLevel: 0,
            marketSource: 'book',
        });

        expect(result.price).toBe(5_000_000);
        expect(result.basis).toBe('current buy');
    });

    test('a custom override still beats both the vendor valuation and the craft cost', () => {
        const result = priceInputWithRefinementFallback(CAPE_HRID, 500, {
            enhancementLevel: 0,
            marketSource: 'custom',
        });

        expect(result.price).toBe(500);
        expect(result.basis).toBe('current buy');
    });

    test('when craft cannot be resolved, the vendor/coinify valuation is used as a last resort', () => {
        mocks.refineAction = null;

        const result = priceInputWithRefinementFallback(CAPE_HRID, 100_000, {
            enhancementLevel: 0,
            marketSource: 'vendor',
        });

        expect(result.price).toBe(100_000);
        expect(result.basis).toBe('current buy');
        expect(result.unpriced).toBe(false);
    });

    test('an off-market valuation on a non-refined item is untouched', () => {
        const result = priceInputWithRefinementFallback('/items/some_vendor_item', 40, {
            enhancementLevel: 0,
            marketSource: 'vendor',
        });

        expect(result.price).toBe(40);
        expect(result.basis).toBe('current buy');
    });
});
