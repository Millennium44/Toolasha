// @vitest-environment happy-dom
import { describe, test, expect } from 'vitest';
import { describeCost, renderPlanHtml, renderCombinationHtml } from './lab-skilling-goals.js';

describe('large costs in the goal tables', () => {
    const big = { gold: 5_190_259_500, tokens: 0, cowbells: 0 };

    test('describeCost keeps the whole number by default and has a short form for a cell', () => {
        expect(describeCost(big)).toBe('5,190,259,500 gold');
        expect(describeCost(big, { short: true })).toBe('5.2B gold');
        // Small figures, free and unpriced read as they always did
        expect(describeCost({ gold: 950, tokens: 40, cowbells: 0 }, { short: true })).toBe('950 gold + 40 tokens');
        expect(describeCost({ gold: 0, tokens: 0, cowbells: 0 }, { short: true })).toBe('free');
        expect(describeCost({ gold: null, tokens: 0, cowbells: 0 }, { short: true })).toBe('unpriced');
    });

    test('a plan step prints the short cost and opens to the exact one', () => {
        const step = { index: 1, description: 'Big swap', cost: big, cumulative: big, clearRate: 0.6 };
        const html = renderPlanHtml(
            { baselineRate: 0.5, poolSize: 1, sims: 1, steps: [step], reached: true, totals: big, finalRate: 0.6 },
            { goalText: '60%' }
        );
        const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
        const row = doc.querySelector('tr[data-plan-step="1"]');
        expect(row.textContent).toContain('5.2B gold');
        expect(row.textContent).not.toContain('5,190,259,500');
        expect(row.getAttribute('data-exact-row')).toBe('step-1');
        const detail = doc.querySelector('tr[data-exact-detail="step-1"]');
        expect(detail.textContent).toContain('Step cost 5,190,259,500 gold');
        expect(detail.textContent).toContain('Total cost 5,190,259,500 gold');
    });

    test('a step with no large figure gets no detail row', () => {
        const small = { gold: 12, tokens: 0, cowbells: 0 };
        const html = renderPlanHtml(
            {
                baselineRate: 0.5,
                poolSize: 1,
                sims: 1,
                steps: [{ index: 1, description: 'Cheap', cost: small, cumulative: small, clearRate: 0.6 }],
                reached: true,
                totals: small,
                finalRate: 0.6,
            },
            { goalText: '60%' }
        );
        expect(html).not.toContain('data-exact-detail');
    });

    test('the combined check prints short cost and Gold/1% and keeps the exact ones in a detail row', () => {
        const combo = {
            clearRate: 0.7,
            clearRateDelta: 0.1,
            xpPerRoom: 10,
            xpPerRoomDelta: 0,
            costs: big,
            goldPerPct: 139_763_077,
            kept: [{ candidate: { description: 'Big swap' } }],
            dropped: [],
        };
        const doc = new DOMParser().parseFromString(`<div>${renderCombinationHtml(combo)}</div>`, 'text/html');
        const cells = doc.querySelector('tr[data-exact-row="combo"]').textContent;
        expect(cells).toContain('5.2B gold');
        expect(cells).toContain('139.8M');
        expect(cells).not.toContain('139,763,077');
        const detail = doc.querySelector('tr[data-exact-detail="combo"]').textContent;
        expect(detail).toContain('5,190,259,500 gold');
        expect(detail).toContain('139,763,077');
    });

    test('an unpriced combined check keeps unknown unknown', () => {
        const combo = {
            clearRate: 0.7,
            clearRateDelta: 0.1,
            xpPerRoom: 10,
            xpPerRoomDelta: 0,
            costs: { gold: null, tokens: 0, cowbells: 0 },
            goldPerPct: null,
            kept: [],
            dropped: [],
        };
        const html = renderCombinationHtml(combo);
        expect(html).toContain('unpriced');
        expect(html).not.toContain('data-exact-detail');
    });
});
