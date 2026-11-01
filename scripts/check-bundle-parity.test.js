import { describe, expect, test } from 'vitest';
import { Window } from 'happy-dom';
import { crossBuildFailures, fixtureWorld, stubStartupSurface, withinBuildFailures } from './check-bundle-parity.mjs';
import { loadBundles } from './check-bundle-smoke.mjs';

const consistent = () => ({
    'owner.ev.innerCrate': 9900,
    'owner.ev.outerChest(nested)': 18277,
    'owner.ev.taskCache': 4000,
    'utils.bonusRevenue.innerCrate': 9900,
    'utils.bonusRevenue.outerChest(nested)': 18277,
    'utils.taskShop.bestPerToken': 100,
    'utils.taskShop.crystalToken': 5000,
    'utils.priceMaterial.crystal': 5000,
});

describe('fixture world', () => {
    test('has a nested container, a crystal and a cache in the task shop, and an enhancement bill', () => {
        const { initClientData, marketData } = fixtureWorld();
        const outer = initClientData.openableLootDropMap['/items/parity_outer_chest'];
        expect(outer.some((drop) => initClientData.openableLootDropMap[drop.itemHrid])).toBe(true);
        const shopped = Object.values(initClientData.taskShopItemDetailMap).map((line) => line.itemHrid);
        expect(shopped).toEqual(expect.arrayContaining(['/items/task_crystal', '/items/parity_task_cache']));
        expect(initClientData.itemDetailMap['/items/parity_task_badge'].enhancementCosts).toHaveLength(2);
        // The crystal is untradable: it must have no quote, or the token path would never be taken
        expect(marketData['/items/task_crystal']).toBeUndefined();
    });
});

describe('cross-build comparison', () => {
    test('identical goldens pass', () => {
        expect(crossBuildFailures(consistent(), consistent())).toEqual([]);
    });

    test('a value that is null in one build and a number in the other fails and names the key', () => {
        const prod = { ...consistent(), 'utils.priceMaterial.crystal': null };
        const failures = crossBuildFailures(prod, consistent());
        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('utils.priceMaterial.crystal');
    });

    test('a key present in only one build fails', () => {
        const dev = { ...consistent(), extra: 1 };
        expect(crossBuildFailures(consistent(), dev)).toHaveLength(1);
    });
});

describe('within-build comparison', () => {
    test('a consistent build passes', () => {
        expect(withinBuildFailures(consistent())).toEqual([]);
    });

    test('the utils path disagreeing with the owner fails', () => {
        const golden = { ...consistent(), 'utils.bonusRevenue.innerCrate': null };
        expect(withinBuildFailures(golden).join('\n')).toContain('utils.bonusRevenue.innerCrate');
    });

    test('an unpriced Task Crystal fails even when both paths agree on null', () => {
        const golden = { ...consistent(), 'utils.priceMaterial.crystal': null, 'utils.taskShop.crystalToken': null };
        expect(withinBuildFailures(golden).join('\n')).toContain('Task Crystal priced as null');
    });

    test('a best token value that is not the cache EV per token fails', () => {
        const golden = { ...consistent(), 'utils.taskShop.bestPerToken': 99 };
        expect(withinBuildFailures(golden).join('\n')).toContain('best token value');
    });
});

describe('startup surface', () => {
    test('a bundle that reads the MessageEvent data accessor at load can run', () => {
        const source = `Object.getOwnPropertyDescriptor(window.MessageEvent.prototype, 'data').get; window.ok = true;`;
        const { window, errors } = loadBundles(['x'], () => source, { Window, setup: stubStartupSurface });
        expect(errors).toEqual([]);
        expect(window.ok).toBe(true);
    });
});
