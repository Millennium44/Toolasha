/** @vitest-environment happy-dom */

import { describe, test, expect, vi } from 'vitest';

const state = vi.hoisted(() => ({
    profitData: { profitPerHour: 1200, hasMissingPrices: true },
    sortedProfit: undefined,
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => key === 'actionPanel_showProfitPerHour_gathering',
        COLOR_PROFIT: '#0f0',
        COLOR_LOSS: '#f00',
    },
}));
vi.mock('../../core/data-manager.js', () => ({ default: { getActionDetails: () => null } }));
vi.mock('./action-panel-sort.js', () => ({
    default: {
        updateProfit: (_panel, profit) => (state.sortedProfit = profit),
        updateExpPerHour: () => {},
        isPinned: () => false,
    },
}));
vi.mock('./action-filter.js', () => ({ default: { isFilterHidden: () => false } }));
vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: async () => state.profitData }));
vi.mock('../../utils/experience-calculator.js', () => ({ calculateExpPerHour: () => null }));
vi.mock('../../utils/action-panel-helper.js', () => ({ onActionTile: () => () => {}, resolveActionTile: () => null }));

const stats = (await import('./gathering-stats.js')).default;

describe('gathering stats with incomplete prices', () => {
    test('withholds the missing-price estimate from sorting and labels the tile', async () => {
        const panel = document.createElement('div');
        const display = document.createElement('div');
        const data = { actionHrid: '/actions/foraging/apple', displayElement: display };
        stats.actionElements.set(panel, data);
        vi.spyOn(stats, 'fitLineFontSizes').mockImplementation(() => {});

        await stats.updateStats(panel);

        expect(data.profitPerHour).toBe(1200);
        expect(data.hasMissingPrices).toBe(true);
        expect(state.sortedProfit).toBeNull();
        expect(display.textContent).toContain('Profit/hr: --');
        expect(display.textContent).toContain('⚠');

        stats.actionElements.delete(panel);
        vi.restoreAllMocks();
    });
});
