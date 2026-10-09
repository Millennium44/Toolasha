/** @vitest-environment happy-dom */

/**
 * A tile Profit/hr computed with the sell-tax exclusion must carry a marker so it is not read as a
 * sale profit; a normally taxed tile must not.
 */

import { describe, test, expect, vi } from 'vitest';

const state = vi.hoisted(() => ({ profitData: {}, taxedData: null, updateProfitCalls: [] }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) =>
            key === 'actionPanel_showProfitPerHour_gathering' || key === 'actionPanel_showExpPerHour_gathering',
        COLOR_PROFIT: '#0f0',
        COLOR_LOSS: '#f00',
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getActionDetails: (hrid) => ({ name: hrid.split('/').at(-1) }) },
}));
vi.mock('./action-panel-sort.js', () => ({
    default: {
        updateProfit: (...args) => state.updateProfitCalls.push(args),
        updateExpPerHour: () => {},
        isPinned: () => false,
    },
}));
vi.mock('./action-filter.js', () => ({ default: { isFilterHidden: () => false } }));
vi.mock('./gathering-profit.js', () => ({
    calculateGatheringProfit: async (_hrid, opts) => (opts?.keepSellTax ? state.taxedData : state.profitData),
}));
vi.mock('../../utils/experience-calculator.js', () => ({ calculateExpPerHour: () => ({ expPerHour: 100 }) }));
vi.mock('../../utils/action-panel-helper.js', () => ({ onActionTile: () => () => {}, resolveActionTile: () => null }));

const stats = (await import('./gathering-stats.js')).default;

async function renderTile() {
    const panel = document.createElement('div');
    const display = document.createElement('div');
    stats.actionElements.set(panel, { actionHrid: '/actions/foraging/apple', displayElement: display });
    vi.spyOn(stats, 'fitLineFontSizes').mockImplementation(() => {});
    await stats.updateStats(panel);
    stats.actionElements.delete(panel);
    vi.restoreAllMocks();
    return display;
}

describe('gathering tile Profit/hr and the sell-tax exclusion', () => {
    test('excluded: the figure is marked and explains itself on hover', async () => {
        state.profitData = { profitPerHour: 1200, hasMissingPrices: false, excludeSellTax: true };

        const display = await renderTile();
        const span = display.querySelector('[data-stat="profit"]');

        expect(span.textContent).toContain('Profit/hr: 1.2K');
        expect(span.textContent).toContain('⚠');
        expect(span.getAttribute('title')).toContain('Sell tax excluded');
    });

    test('taxed (default): no marker, no tooltip', async () => {
        state.profitData = { profitPerHour: 1200, hasMissingPrices: false, excludeSellTax: false };

        const display = await renderTile();
        const span = display.querySelector('[data-stat="profit"]');

        expect(span.textContent).not.toContain('⚠');
        expect(span.getAttribute('title')).toBeNull();
    });

    test('untaxed tile hands the sort cache its taxed twin; taxed tile pays for no second calculation', async () => {
        state.updateProfitCalls.length = 0;
        state.taxedData = { profitPerHour: 1000, hasMissingPrices: false };
        state.profitData = { profitPerHour: 1200, hasMissingPrices: false, excludeSellTax: true };
        await renderTile();
        expect(state.updateProfitCalls.at(-1)[1]).toBe(1200);
        expect(state.updateProfitCalls.at(-1)[2]).toEqual({ excludeSellTax: true, taxedProfitPerHour: 1000 });

        state.taxedData = null;
        state.profitData = { profitPerHour: 1200, hasMissingPrices: false, excludeSellTax: false };
        await renderTile();
        expect(state.updateProfitCalls.at(-1)[2]).toEqual({ excludeSellTax: false, taxedProfitPerHour: null });
    });
});
