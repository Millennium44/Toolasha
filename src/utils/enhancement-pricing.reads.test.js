/**
 * The production-cost memo hands the prices behind a remembered cost to whoever is recording.
 *
 * The net-worth cost cache records what each enhancement cost read so a patch drops only the
 * costs built on that item. A crafted base's cost often comes out of this memo without a single
 * getPrice() call, so the memo must replay the reads it saw when it computed the cost, or a cost
 * built on a remembered bill would survive a patch to the bill's inputs.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const market = vi.hoisted(() => {
    const recorders = new Set();
    return {
        recorders,
        prices: {},
        read(key) {
            for (const recorder of recorders) recorder.keys.add(key);
        },
        api: {
            on: () => {},
            recordPriceReads() {
                const recorder = { keys: new Set(), wide: false, stop: () => recorders.delete(recorder) };
                recorders.add(recorder);
                return recorder;
            },
            notePriceReads(keys) {
                for (const recorder of recorders) {
                    if (!keys) recorder.wide = true;
                    else for (const key of keys) recorder.keys.add(key);
                }
            },
        },
    };
});

vi.mock('../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({
            itemDetailMap: { '/items/holy_bar': { name: 'Bar' }, '/items/holy_ore': { name: 'Ore' } },
            actionDetailMap: {
                '/actions/smelt_holy_bar': {
                    type: '/action_types/crafting',
                    inputItems: [{ itemHrid: '/items/holy_ore', count: 3 }],
                    outputItems: [{ itemHrid: '/items/holy_bar', count: 1 }],
                },
            },
        }),
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => [],
        getBuffStateVersion: () => 0,
    },
}));
vi.mock('./action-context.js', () => {
    const mod = { resolveActionContext: () => ({ equipment: new Map(), drinks: [] }) };
    return { ...mod, resolveLoadoutContext: (actionTypeHrid) => mod.resolveActionContext(actionTypeHrid) };
});
vi.mock('../api/marketplace.js', () => ({ default: market.api }));
vi.mock('../features/settings/custom-price-overrides.js', () => ({ getCustomPriceVersion: () => 0 }));
vi.mock('./market-data.js', () => ({
    getItemPrices: (hrid, level = 0) => {
        market.read(`${hrid}:${level}`);
        return market.prices[`${hrid}:${level}`] || null;
    },
    getItemPrice: (hrid, { mode = 'ask' } = {}) => {
        market.read(`${hrid}:0`);
        return market.prices[`${hrid}:0`]?.[mode] || 0;
    },
}));

const { getProductionCost } = await import('./enhancement-pricing.js');

beforeEach(() => {
    market.prices = { '/items/holy_ore:0': { ask: 200, bid: 190 } };
});

describe('production-cost memo read replay', () => {
    test('a remembered cost credits an outer recorder with the prices it was built from', () => {
        // Computed once with nobody watching
        expect(getProductionCost('/items/holy_bar')).toBe(600);

        const outer = market.api.recordPriceReads();
        expect(getProductionCost('/items/holy_bar')).toBe(600);
        outer.stop();

        expect(outer.keys.has('/items/holy_ore:0')).toBe(true);
        expect(outer.wide).toBe(false);
    });

    test('nothing is left recording once a cost is computed', () => {
        getProductionCost('/items/holy_bar', 'bid');
        expect(market.recorders.size).toBe(0);
    });
});
