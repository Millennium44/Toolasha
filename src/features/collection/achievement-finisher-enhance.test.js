/**
 * Enhancer achievements: the cheapest piece and start level to buy, plus the expected enhancing to the
 * first success at or above the target, on the shared enhancing chain.
 */

import { describe, test, expect, vi } from 'vitest';

import { resolveAchievement, readiness } from './achievement-finisher-resolve.js';
import { enhanceRunCost } from './achievement-finisher-enhance.js';
import {
    BASE_SUCCESS_RATES,
    calculateEnhancement,
    calculateSuccessMultiplier,
} from '../../utils/enhancement-calculator.js';
import { ENHANCE_ACHIEVEMENTS as A, ENHANCE_DATA as D, BENCH } from './__fixtures__/achievement-finisher-enhance.js';

const get = (slug) => A[`/achievements/${slug}`];

/** Listing prices per item and level; a level absent from the table has no listing */
function ctxWith({ listings = {}, materials = {}, protection = {}, over = {} } = {}) {
    return {
        skillLevels: new Map([['/skills/enhancing', 100]]),
        combatLevel: 50,
        inventory: [],
        ironCow: false,
        buyPrice: () => null,
        buyPriceAt: vi.fn((hrid, level) => listings[hrid]?.[level] ?? null),
        enhanceMaterialCost: vi.fn((hrid) => materials[hrid] ?? { cost: 100, hasMissingPrices: false }),
        protectionFor: vi.fn((hrid) => protection[hrid] ?? { price: 50, itemHrid: '/items/cheese' }),
        enhanceParams: () => BENCH,
        enhanceCache: new Map(),
        ...over,
    };
}

const chain = (itemLevel, start, target, protectFrom) =>
    calculateEnhancement({
        enhancingLevel: BENCH.enhancingLevel,
        toolBonus: 0,
        speedBonus: 0,
        itemLevel,
        targetLevel: target,
        startLevel: start,
        protectFrom,
        blessedTea: false,
        guzzlingBonus: 1,
        blessedTeaBonus: 0.01,
    });

/** The cheapest strategy's cost by brute force over protect-from 0 and 2..target */
function bestRun(itemLevel, start, target, mat, prot) {
    const costs = [chain(itemLevel, start, target, 0).attempts * mat];
    if (prot > 0) {
        for (let from = 2; from <= target; from += 1) {
            const calc = chain(itemLevel, start, target, from);
            costs.push(calc.attempts * mat + calc.protectionCount * prot);
        }
    }
    return Math.min(...costs);
}

describe('enhancer: what qualifies', () => {
    test('any equipment: tradable, enhanceable equipment only', () => {
        const res = resolveAchievement(get('enhance_to_3'), D);
        expect(res).toMatchObject({ kind: 'enhance', target: 3, minItemLevel: 0 });
        expect(res.candidates.map((c) => c.itemHrid)).toEqual([
            '/items/cheese_gloves',
            '/items/chrono_gloves',
            '/items/magnetic_gloves',
            '/items/marsh_gloves',
        ]);
    });

    test('80+ recommended level: itemLevel, not the wear requirement; 79 is out', () => {
        const res = resolveAchievement(get('enhance_level_80_to_10'), D);
        expect(res).toMatchObject({ target: 10, minItemLevel: 80 });
        expect(res.candidates).toEqual([
            { itemHrid: '/items/chrono_gloves', itemLevel: 90 },
            { itemHrid: '/items/magnetic_gloves', itemLevel: 85 },
        ]);
    });

    test('another enhance id is not an Enhancer achievement', () => {
        expect(
            resolveAchievement({ ...get('enhance_to_3'), steamAchievementId: 'ach_enhance_something_plus_10' }, D)
        ).toBeNull();
    });
});

describe('enhancer: the expected run', () => {
    test('below the target: the cheapest protect-from strategy of the shared chain', () => {
        for (const start of [0, 4, 9]) {
            const run = enhanceRunCost({
                params: BENCH,
                itemLevel: 85,
                start,
                target: 10,
                materialCost: 1000,
                protectionPrice: 20000,
                cache: new Map(),
            });
            expect(run.cost).toBeCloseTo(bestRun(85, start, 10, 1000, 20000), 6);
        }
    });

    test('bought at the target: one attempt; a success counts, a failure drops a level (protected) or to +0', () => {
        const mat = 1000;
        const prot = 20000;
        const p = Math.min(
            1,
            (BASE_SUCCESS_RATES[10] / 100) *
                calculateSuccessMultiplier({ enhancingLevel: 100, toolBonus: 0, itemLevel: 85 })
        );
        const unprotected = mat + (1 - p) * bestRun(85, 0, 10, mat, prot);
        const protectedRun = mat + (1 - p) * (prot + bestRun(85, 9, 10, mat, prot));
        const run = enhanceRunCost({
            params: BENCH,
            itemLevel: 85,
            start: 10,
            target: 10,
            materialCost: mat,
            protectionPrice: prot,
            cache: new Map(),
        });
        expect(run.cost).toBeCloseTo(Math.min(unprotected, protectedRun), 6);
        expect(run.protected).toBe(protectedRun < unprotected);
        // With no protection price: only the fall to +0
        const bare = enhanceRunCost({
            params: BENCH,
            itemLevel: 85,
            start: 10,
            target: 10,
            materialCost: mat,
            protectionPrice: null,
            cache: new Map(),
        });
        expect(bare.cost).toBeCloseTo(mat + (1 - p) * bestRun(85, 0, 10, mat, 0), 6);
        expect(bare.protected).toBe(false);
    });

    test('chain solves are shared by every piece of one item level in a render', () => {
        const cache = new Map();
        const args = { params: BENCH, itemLevel: 85, target: 10, materialCost: 10, protectionPrice: 5, cache };
        enhanceRunCost({ ...args, start: 3 });
        const size = cache.size;
        enhanceRunCost({ ...args, start: 3, materialCost: 99 });
        expect(cache.size).toBe(size);
    });
});

describe('enhancer: the cheapest route', () => {
    const res = () => resolveAchievement(get('enhance_level_80_to_10'), D);

    test('every piece and start level is priced; a level with no listing is skipped, never 0', () => {
        const listings = {
            // +10 is cheap but +0..+9 have no listing except +0
            '/items/magnetic_gloves': { 0: 1_000_000, 10: 30_000_000 },
            '/items/chrono_gloves': { 0: 50_000_000, 9: 60_000_000 },
        };
        const ctx = ctxWith({
            listings,
            materials: {
                '/items/magnetic_gloves': { cost: 50_000, hasMissingPrices: false },
                '/items/chrono_gloves': { cost: 80_000, hasMissingPrices: false },
            },
            protection: {
                '/items/magnetic_gloves': { price: 1_000_000, itemHrid: '/items/mirror_of_protection' },
                '/items/chrono_gloves': { price: 2_000_000, itemHrid: '/items/mirror_of_protection' },
            },
        });
        const ready = readiness(res(), ctx);
        const totals = [
            [
                '/items/magnetic_gloves',
                0,
                1_000_000 +
                    enhanceRunCost({
                        params: BENCH,
                        itemLevel: 85,
                        start: 0,
                        target: 10,
                        materialCost: 50_000,
                        protectionPrice: 1_000_000,
                        cache: new Map(),
                    }).cost,
            ],
            [
                '/items/magnetic_gloves',
                10,
                30_000_000 +
                    enhanceRunCost({
                        params: BENCH,
                        itemLevel: 85,
                        start: 10,
                        target: 10,
                        materialCost: 50_000,
                        protectionPrice: 1_000_000,
                        cache: new Map(),
                    }).cost,
            ],
            [
                '/items/chrono_gloves',
                0,
                50_000_000 +
                    enhanceRunCost({
                        params: BENCH,
                        itemLevel: 90,
                        start: 0,
                        target: 10,
                        materialCost: 80_000,
                        protectionPrice: 2_000_000,
                        cache: new Map(),
                    }).cost,
            ],
            [
                '/items/chrono_gloves',
                9,
                60_000_000 +
                    enhanceRunCost({
                        params: BENCH,
                        itemLevel: 90,
                        start: 9,
                        target: 10,
                        materialCost: 80_000,
                        protectionPrice: 2_000_000,
                        cache: new Map(),
                    }).cost,
            ],
        ].sort((a, b) => a[2] - b[2]);
        expect([ready.buyHrid, ready.buyLevel]).toEqual([totals[0][0], totals[0][1]]);
        expect(ready.cost).toBeCloseTo(totals[0][2], 3);
        expect(ready.listingPrice).toBe(listings[totals[0][0]][totals[0][1]]);
        expect(ready).toMatchObject({ owned: false, levelMet: true, protectionUnpriced: false });
        // Every level up to the target was asked for; the unlisted ones (+5 here) were never picked
        expect(ctx.buyPriceAt).toHaveBeenCalledWith('/items/magnetic_gloves', 5);
        expect(ctx.buyPriceAt).toHaveBeenCalledWith('/items/magnetic_gloves', 10);
        expect(ctx.buyPriceAt).not.toHaveBeenCalledWith('/items/magnetic_gloves', 11);
    });

    test('buying at the target wins when the listing at +target is cheap enough', () => {
        const ctx = ctxWith({
            listings: { '/items/magnetic_gloves': { 0: 1_000_000, 10: 1_500_000 } },
            materials: { '/items/magnetic_gloves': { cost: 200_000, hasMissingPrices: false } },
            protection: { '/items/magnetic_gloves': { price: 100_000, itemHrid: '/items/mirror_of_protection' } },
        });
        const ready = readiness(res(), ctx);
        expect([ready.buyHrid, ready.buyLevel]).toEqual(['/items/magnetic_gloves', 10]);
        expect(ready.protectionHrid).toBe('/items/mirror_of_protection');
    });

    test('a listing dearer than the best route found is never costed', () => {
        const ctx = ctxWith({
            listings: {
                '/items/magnetic_gloves': { 9: 1_000 },
                '/items/chrono_gloves': { 0: 1e12 },
            },
            materials: { '/items/magnetic_gloves': { cost: 1, hasMissingPrices: false } },
            protection: { '/items/magnetic_gloves': { price: 1, itemHrid: '/items/cheese' } },
        });
        readiness(res(), ctx);
        expect(ctx.enhanceMaterialCost.mock.calls.map(([hrid]) => hrid)).toEqual(['/items/magnetic_gloves']);
    });

    test('unpriced protection: only the unprotected run is costed, and the hint can say so', () => {
        const ctx = ctxWith({
            listings: { '/items/magnetic_gloves': { 0: 1_000 } },
            materials: { '/items/magnetic_gloves': { cost: 100, hasMissingPrices: false } },
            protection: { '/items/magnetic_gloves': { price: null, itemHrid: null } },
        });
        const ready = readiness(res(), ctx);
        expect(ready).toMatchObject({ protectionHrid: null, protectionUnpriced: true });
        expect(ready.cost).toBeCloseTo(1_000 + bestRun(85, 0, 10, 100, 0), 3);
    });

    test('a partial bill never wins as a priced route: partial materials rank as unpriced, partial protection is not used', () => {
        // The cheap piece's materials are craft-priced with an unpriced input (cost understated)
        const ctx = ctxWith({
            listings: { '/items/magnetic_gloves': { 0: 1_000 }, '/items/chrono_gloves': { 0: 9_000_000 } },
            materials: {
                '/items/magnetic_gloves': { cost: 10, hasMissingPrices: false, hasPartialPrices: true },
                '/items/chrono_gloves': { cost: 10, hasMissingPrices: false, hasPartialPrices: false },
            },
        });
        expect(readiness(res(), ctx).buyHrid).toBe('/items/chrono_gloves');
        // A protection priced from a partial bill: the route is costed unprotected and says so
        const partialProt = readiness(
            res(),
            ctxWith({
                listings: { '/items/magnetic_gloves': { 0: 1_000 } },
                materials: { '/items/magnetic_gloves': { cost: 100, hasMissingPrices: false } },
                protection: { '/items/magnetic_gloves': { price: 1, itemHrid: '/items/cheese', partial: true } },
            })
        );
        expect(partialProt).toMatchObject({ protectionHrid: null, protectionUnpriced: true });
        expect(partialProt.cost).toBeCloseTo(1_000 + bestRun(85, 0, 10, 100, 0), 3);
    });

    test('unpriced materials rank after any priced route; with none priced the cheapest listing is named, no total', () => {
        const unpricedMats = { cost: 10, hasMissingPrices: true };
        const ctx = ctxWith({
            listings: { '/items/magnetic_gloves': { 0: 1_000 }, '/items/chrono_gloves': { 0: 9_000_000 } },
            materials: {
                '/items/magnetic_gloves': unpricedMats,
                '/items/chrono_gloves': { cost: 10, hasMissingPrices: false },
            },
        });
        expect(readiness(res(), ctx).buyHrid).toBe('/items/chrono_gloves');
        const none = readiness(
            res(),
            ctxWith({
                listings: { '/items/magnetic_gloves': { 0: 1_000, 3: 2_000 } },
                materials: { '/items/magnetic_gloves': unpricedMats },
            })
        );
        expect(none).toMatchObject({
            buyHrid: '/items/magnetic_gloves',
            buyLevel: 0,
            cost: null,
            partialCost: 1_000,
            unpriced: ['/items/magnetic_gloves'],
        });
    });

    test('no listing at all, Iron Cow, and enhancing stats not loaded', () => {
        expect(readiness(res(), ctxWith())).toMatchObject({ noListing: true, buyHrid: null, cost: null });
        const cow = readiness(
            res(),
            ctxWith({ listings: { '/items/magnetic_gloves': { 0: 1 } }, over: { ironCow: true } })
        );
        expect(cow).toMatchObject({ ironCow: true, buyHrid: null, cost: null });
        const unloaded = readiness(
            res(),
            ctxWith({ listings: { '/items/magnetic_gloves': { 0: 1 } }, over: { enhanceParams: () => null } })
        );
        expect(unloaded).toMatchObject({ levelMet: null, buyHrid: null });
    });
});

describe('enhancer: a live-typical bench (Enhancing ~100-130, below the piece level)', () => {
    const res = (target) => ({
        kind: 'enhance',
        target,
        minItemLevel: 0,
        candidates: [{ itemHrid: '/items/void_gloves', itemLevel: 160 }],
    });
    const bench = (enhancingLevel) => ({ ...BENCH, enhancingLevel });

    test.each([
        [
            'every level listed, protection priced',
            { 0: 1e6, 5: 3e6, 9: 9e6, 10: 2e7 },
            { price: 50, itemHrid: '/items/cheese' },
        ],
        ['only +10 listed (start equals target)', { 10: 2e7 }, { price: 50, itemHrid: '/items/cheese' }],
        ['only +10 listed, no protection price', { 10: 2e7 }, { price: null, itemHrid: null }],
        [
            'listings only above the target are not starts',
            { 12: 1e8, 15: 5e8 },
            { price: 50, itemHrid: '/items/cheese' },
        ],
    ])('%s: finite, non-negative, never cheaper than its listing', (_name, levels, protection) => {
        const ctx = ctxWith({
            listings: { '/items/void_gloves': levels },
            protection: { '/items/void_gloves': protection },
            over: { enhanceParams: () => bench(110) },
        });
        const ready = readiness(res(10), ctx);
        if (Object.keys(levels).every((level) => Number(level) > 10)) {
            expect(ready.noListing).toBe(true);
            return;
        }
        expect(Number.isFinite(ready.cost)).toBe(true);
        expect(ready.cost).toBeGreaterThanOrEqual(ready.listingPrice);
        if (protection.price === null) {
            expect(ready.protectionHrid).toBeNull();
            expect(ready.protectionUnpriced).toBe(true);
        }
    });

    test('+19 at Enhancing 100 on a level 160 piece is finite, and a stronger bench costs less', () => {
        const listings = { '/items/void_gloves': { 0: 1e6, 19: 5e9 } };
        const at = (level) =>
            readiness(res(19), ctxWith({ listings, over: { enhanceParams: () => bench(level) } })).cost;
        const weak = at(100);
        const strong = at(130);
        expect(Number.isFinite(weak)).toBe(true);
        expect(weak).toBeGreaterThan(0);
        expect(strong).toBeLessThan(weak);
    });
});
