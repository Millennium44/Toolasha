import { describe, test, expect, vi } from 'vitest';
import { compareAdvisorAcquisition } from './upgrade-route-comparison.js';
import { sharedRouteText, compactCostLines } from './cost-basis-text.js';

const available = { status: 'available' };
const context = () => ({
    target: { itemHrid: '/items/star', level: 13 },
    recipe: {
        retainAllEnhancement: true,
        upgradeItemHrid: '/items/base',
        outputCount: 1,
        inputItems: [{ itemHrid: '/items/shard', count: 20 }],
    },
    copies: [{ id: 'base:0', itemHrid: '/items/base', level: 12, sale: 100, usable: true }],
    sellIds: [],
    eligibility: available,
});
const services = () => ({
    buy: vi.fn((hrid, level) => (hrid === '/items/star' ? 180 : level === 13 ? 150 : 100)),
    material: vi.fn((hrid, count) => ({ cost: count, eligibility: available })),
    enhance: vi.fn(() => 80),
    combineEligibility: (checks) =>
        checks.some((check) => check.status === 'blocked') ? { status: 'blocked' } : available,
    mirror: vi.fn(() => null),
});

describe('read-only route comparison', () => {
    test('matches the #858 bought-base fixture: 170 instead of 200 real / 100 cash', () => {
        const shared = compareAdvisorAcquisition(context(), services());
        expect(shared).toMatchObject({ route: 'craft', cash: 101, real: 101 });
        // A fresh +0 may itself be crafted in this test: price that base at 100
        // to isolate the issue's 170M bought-at-level comparison.
        const svc = services();
        svc.material.mockImplementation((hrid, count) => ({
            cost: hrid === '/items/base' ? 100 : count,
            eligibility: available,
        }));
        const result = compareAdvisorAcquisition(context(), svc);
        expect(result).toMatchObject({ route: 'craft', cash: 170, real: 170 });
        expect(result.routes.find((route) => route.id === 'craft').upgradeBaseLevel).toBe(13);
    });
    test('prices a recursively crafted base for a zero-level upgrade even when it is unlisted', () => {
        const ctx = context();
        ctx.target.level = 0;
        ctx.copies = [];
        ctx.recipe.retainAllEnhancement = false;
        const svc = services();
        svc.buy.mockImplementation((hrid) => (hrid === '/items/star' ? 180 : null));
        svc.material.mockImplementation((hrid, count) => ({
            cost: hrid === '/items/base' ? 50 : count,
            eligibility: available,
        }));
        expect(compareAdvisorAcquisition(ctx, svc)).toMatchObject({ route: 'craft', real: 70 });
        expect(svc.enhance).not.toHaveBeenCalled();
    });
    test('no sale quote does not make an owned base free', () => {
        const ctx = context();
        ctx.copies[0].sale = null;
        const svc = services();
        svc.material.mockImplementation((hrid, count) => ({
            cost: hrid === '/items/base' ? null : count,
            eligibility: available,
        }));
        expect(compareAdvisorAcquisition(ctx, svc)).toMatchObject({ route: 'craft', real: 170 });
    });
    test('blocked crafting cannot win even with Prefer Craft', () => {
        const ctx = context();
        ctx.eligibility = { status: 'blocked' };
        ctx.preference = 'craft';
        expect(compareAdvisorAcquisition(ctx, services())).toMatchObject({ route: 'buy', real: 180 });
    });
    test('keeps real negative cost distinct from zero cash and applies tax-prepared sale once', () => {
        const ctx = context();
        ctx.copies = [{ id: 'old', sale: 200 }];
        ctx.sellIds = ['old'];
        ctx.preference = 'buy';
        expect(compareAdvisorAcquisition(ctx, services())).toMatchObject({ route: 'buy', real: -20, cash: 0 });
    });
    test('retains recursive Mirror counts and fractional consumed-copy shares', () => {
        const ctx = context();
        ctx.target.level = 5;
        ctx.recipe = null;
        ctx.copies = [{ id: 'lower', sale: 20 }];
        ctx.sellIds = ['lower'];
        const svc = services();
        svc.mirror.mockReturnValue({
            gross: 40,
            consumed: [{ id: 'lower', share: 0.75 }],
            mirrorCount: 2.5,
            boughtCopies: [{ itemHrid: '/items/base', enhancementLevel: 2, count: 3 }],
        });
        const result = compareAdvisorAcquisition(ctx, svc);
        expect(result).toMatchObject({ route: 'mirror', cash: 35, real: 35 });
        expect(result.routes.find((row) => row.id === 'mirror')).toMatchObject({
            mirrorCount: 2.5,
            boughtCopies: [{ count: 3 }],
        });
    });
    test('rejects a non-retaining enhanced craft and missing material subtotal', () => {
        const ctx = context();
        ctx.recipe.retainAllEnhancement = false;
        expect(compareAdvisorAcquisition(ctx, services()).routes).toHaveLength(1);
        ctx.target.level = 0;
        const svc = services();
        svc.material.mockReturnValue({ cost: null, eligibility: available });
        expect(compareAdvisorAcquisition(ctx, svc)).toMatchObject({ route: 'buy' });
        svc.buy.mockReturnValue(null);
        expect(compareAdvisorAcquisition(ctx, svc)).toMatchObject({ status: 'unknown', cash: null, real: null });
    });
    test('does not consult any services for unsupported party or multi-item contexts', () => {
        for (const unsupported of ['Party inventory is unknown.', 'Multi-item allocation is not enabled.']) {
            const svc = services();
            expect(compareAdvisorAcquisition({ unsupported }, svc)).toEqual({
                status: 'unsupported',
                reason: unsupported,
            });
            for (const key of ['buy', 'material', 'enhance', 'mirror']) expect(svc[key]).not.toHaveBeenCalled();
        }
    });
    test('multi-output craft allocation divides one base once, not once per output', () => {
        const ctx = context();
        ctx.target.level = 0;
        ctx.recipe.outputCount = 3;
        ctx.copies = [{ id: 'base', itemHrid: '/items/base', level: 0, sale: 30 }];
        const svc = services();
        svc.buy.mockReturnValue(1000);
        svc.material.mockImplementation((hrid, count) => ({
            cost: hrid === '/items/base' ? 1000 : count,
            eligibility: available,
        }));
        const result = compareAdvisorAcquisition(ctx, svc);
        expect(result).toMatchObject({ route: 'craft' });
        expect(result.real).toBeCloseTo(20 / 3 + 10);
        expect(result.cash).toBeCloseTo(20 / 3);
    });
    test('copies are independent between rows and comparisons do not mutate candidates', () => {
        const ctx = context(),
            before = structuredClone(ctx);
        const result = compareAdvisorAcquisition(ctx, services());
        expect(compareAdvisorAcquisition(ctx, services())).toEqual(result);
        expect(ctx).toEqual(before);
    });
    test('names the route that set the Cost, and how far the advisor quote was from it', () => {
        const applied = {
            sharedRoute: { applied: true, route: 'craft', real: 170, cash: 100, advisorNet: 200, preference: 'auto' },
        };
        const text = sharedRouteText(applied);
        expect(text).toBe("Priced by Craft, the lowest real cost: 170, 30 below the advisor's own quote.");
        // A route-priced row names it whatever the setting is now, first in the compact account
        expect(compactCostLines(applied)[0].text).toBe(text);
        expect(
            sharedRouteText({ sharedRoute: { ...applied.sharedRoute, preference: 'craft', advisorNet: null } })
        ).toBe('Priced by Craft, your preferred route: 170; the advisor had no quote of its own.');
        expect(sharedRouteText({ sharedRoute: { ...applied.sharedRoute, route: 'buy', advisorNet: 150 } })).toContain(
            "20 above the advisor's own quote"
        );
    });
    test('a kept advisor quote says why only while the setting is on; a legacy comparison says nothing', () => {
        const kept = {
            sharedRoute: {
                applied: false,
                route: 'craft',
                real: 170,
                reason: 'The craft is not known to be startable.',
            },
        };
        expect(sharedRouteText(kept)).toBe('');
        expect(sharedRouteText(kept, { showKept: true })).toBe(
            "Advisor's own quote (Craft 170 not used): The craft is not known to be startable."
        );
        expect(
            sharedRouteText(
                { sharedRoute: { applied: false, reason: 'Party inventory and crafting setup are not known.' } },
                { showKept: true }
            )
        ).toBe("Advisor's own quote: Party inventory and crafting setup are not known.");
        expect(
            sharedRouteText(
                { sharedRoute: { applied: false, agrees: true, route: 'buy', real: 5 } },
                { showKept: true }
            )
        ).toBe("Buy route, the same as the advisor's own quote.");
        const legacy = { acquisitionComparison: { status: 'priced', route: 'craft', real: 170, cash: 100 } };
        expect(sharedRouteText(legacy, { showKept: true })).toBe('');
        expect(compactCostLines(legacy, { showAcquisitionComparison: true })).toEqual([]);
        expect(sharedRouteText()).toBe('');
    });
});
