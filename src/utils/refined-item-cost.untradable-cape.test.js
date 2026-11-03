import { describe, test, expect, vi } from 'vitest';

const mode = vi.hoisted(() => ({ value: 'mirror' }));
const CAPES = new Set(['/items/gatherer_cape', '/items/gatherer_cape_refined']);

vi.mock('../core/config.js', () => ({ default: { getSetting: () => true, getSettingValue: (k, f) => f } }));
vi.mock('./market-data.js', () => ({
    getItemPrice: () => null,
    getItemPriceInfo: () => ({ price: null, source: null, estimated: false }),
    getPricingMode: () => 'ask',
}));
vi.mock('../core/data-manager.js', () => ({
    default: {
        getItemDetails: () => null,
        getInitClientData: () => ({ itemDetailMap: {}, actionDetailMap: {} }),
        getInventory: () => [],
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => [],
    },
}));
vi.mock('./untradable-cape.js', () => ({
    isUntradableCape: (hrid) => CAPES.has(hrid),
    getCapeBaseValueMode: () => mode.value,
    CAPE_BASE_VALUE_ZERO: 'zero',
}));

const { priceInputWithRefinementFallback } = await import('./refined-item-cost.js');

describe('priceInputWithRefinementFallback: untradable capes', () => {
    const capeValue = (hrid, level) =>
        hrid === '/items/gatherer_cape_refined' && level === 3
            ? { value: 9e6, partial: false }
            : { value: null, partial: true };

    test('values a cape through the injected convention at its level', () => {
        const out = priceInputWithRefinementFallback('/items/gatherer_cape_refined', 0, {
            enhancementLevel: 3,
            capeValue,
        });
        expect(out).toEqual({ price: 9e6, basis: 'untradable-cape value', unpriced: false });
    });

    test('a real market price wins; a cape the convention cannot value stays unpriced', () => {
        expect(priceInputWithRefinementFallback('/items/gatherer_cape', 55, { capeValue }).price).toBe(55);
        expect(priceInputWithRefinementFallback('/items/gatherer_cape', 0, { capeValue })).toEqual({
            price: 0,
            basis: null,
            unpriced: true,
        });
    });

    test('without the convention injected, behavior is unchanged', () => {
        expect(priceInputWithRefinementFallback('/items/gatherer_cape', 0, {}).unpriced).toBe(true);
    });

    test('a refined cape reads its stones through the injected value under either setting; an unpriced stone stays unpriced', () => {
        const stones = { value: 2000, partial: false };
        const unpricedStone = { value: null, partial: true };
        for (const m of ['zero', 'mirror']) {
            mode.value = m;
            expect(
                priceInputWithRefinementFallback('/items/gatherer_cape_refined', 0, { capeValue: () => stones })
            ).toEqual({ price: 2000, basis: 'untradable-cape value', unpriced: false });
            expect(
                priceInputWithRefinementFallback('/items/gatherer_cape_refined', 0, { capeValue: () => unpricedStone })
            ).toEqual({ price: 0, basis: null, unpriced: true });
        }
        // An unrefined cape on the "nothing" setting is the player's own plain 0
        mode.value = 'zero';
        expect(
            priceInputWithRefinementFallback('/items/gatherer_cape', 0, {
                capeValue: () => ({ value: null, partial: true }),
            })
        ).toMatchObject({ price: 0, unpriced: false });
        mode.value = 'mirror';
    });
});
