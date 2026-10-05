/** @vitest-environment happy-dom */

import { describe, test, expect, vi } from 'vitest';

const state = vi.hoisted(() => ({
    profitData: { profitPerHour: 1200, hasMissingPrices: true },
    profitByAction: {},
    sortedProfit: undefined,
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) =>
            key === 'actionPanel_showProfitPerHour_gathering' || key === 'actionPanel_showExpPerHour_gathering',
        COLOR_PROFIT: '#0f0',
        COLOR_LOSS: '#f00',
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getActionDetails: (hrid) => ({ name: hrid.split('/').at(-1) }),
    },
}));
vi.mock('./action-panel-sort.js', () => ({
    default: {
        updateProfit: (_panel, profit) => (state.sortedProfit = profit),
        updateExpPerHour: () => {},
        isPinned: () => false,
    },
}));
vi.mock('./action-filter.js', () => ({ default: { isFilterHidden: () => false } }));
vi.mock('./gathering-profit.js', () => ({
    calculateGatheringProfit: async (actionHrid) => state.profitByAction[actionHrid] ?? state.profitData,
}));
vi.mock('../../utils/experience-calculator.js', () => ({
    calculateExpPerHour: (actionHrid) => ({ expPerHour: actionHrid.endsWith('/apple') ? 50 : 100 }),
}));
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

    test('removes effective XP derived from profit after that action becomes incomplete', async () => {
        const appleHrid = '/actions/foraging/apple';
        const competitorHrid = '/actions/foraging/berries';
        const applePanel = document.createElement('div');
        const competitorPanel = document.createElement('div');
        const appleDisplay = document.createElement('div');
        const competitorDisplay = document.createElement('div');
        document.body.append(applePanel, competitorPanel);
        state.profitByAction = {
            [appleHrid]: { profitPerHour: -100, hasMissingPrices: false },
            [competitorHrid]: { profitPerHour: 100, hasMissingPrices: false },
        };
        stats.actionElements.set(applePanel, { actionHrid: appleHrid, displayElement: appleDisplay });
        stats.actionElements.set(competitorPanel, { actionHrid: competitorHrid, displayElement: competitorDisplay });
        vi.spyOn(stats, 'fitLineFontSizes').mockImplementation(() => {});

        await stats.updateStats(applePanel);
        await stats.updateStats(competitorPanel);
        stats.addBestActionIndicators();
        expect(appleDisplay.textContent).toContain('Eff. XP/hr: 75');
        expect(appleDisplay.textContent).toContain('50');

        state.profitByAction[appleHrid] = { profitPerHour: -100, hasMissingPrices: true };
        await stats.updateStats(applePanel, { skipRender: true });
        stats.renderIndicators(applePanel, stats.actionElements.get(applePanel));
        stats.addBestActionIndicators();

        expect(appleDisplay.textContent).toContain('Exp/hr: 50');
        expect(appleDisplay.textContent).toContain('Profit/hr: --');
        expect(appleDisplay.textContent).not.toContain('Eff. XP/hr: 75');
        expect(appleDisplay.textContent).not.toContain('Eff. XP/hr:');
        expect(stats.actionElements.get(applePanel).effectiveXpPerHour).toBeNull();

        stats.actionElements.clear();
        applePanel.remove();
        competitorPanel.remove();
        vi.restoreAllMocks();
    });

    test('drops a stale blended effective XP once no action is profitable to recover the loss', async () => {
        const appleHrid = '/actions/foraging/apple';
        const competitorHrid = '/actions/foraging/berries';
        const applePanel = document.createElement('div');
        const competitorPanel = document.createElement('div');
        const appleDisplay = document.createElement('div');
        const competitorDisplay = document.createElement('div');
        document.body.append(applePanel, competitorPanel);
        state.profitByAction = {
            [appleHrid]: { profitPerHour: -100, hasMissingPrices: false },
            [competitorHrid]: { profitPerHour: 100, hasMissingPrices: false },
        };
        stats.actionElements.set(applePanel, { actionHrid: appleHrid, displayElement: appleDisplay });
        stats.actionElements.set(competitorPanel, { actionHrid: competitorHrid, displayElement: competitorDisplay });
        vi.spyOn(stats, 'fitLineFontSizes').mockImplementation(() => {});

        await stats.updateStats(applePanel);
        await stats.updateStats(competitorPanel);
        stats.addBestActionIndicators();
        expect(appleDisplay.textContent).toContain('Eff. XP/hr: 75');

        // The only profitable action loses its prices, so nothing can recover the apple loss
        state.profitByAction[competitorHrid] = { profitPerHour: 100, hasMissingPrices: true };
        await stats.updateStats(competitorPanel, { skipRender: true });
        stats.renderIndicators(competitorPanel, stats.actionElements.get(competitorPanel));
        stats.addBestActionIndicators();

        expect(stats.actionElements.get(applePanel).effectiveXpPerHour).toBeNull();
        expect(appleDisplay.textContent).not.toContain('Eff. XP/hr: 75');
        expect(appleDisplay.textContent).toContain('Eff. XP/hr: 50');

        stats.actionElements.clear();
        applePanel.remove();
        competitorPanel.remove();
        vi.restoreAllMocks();
    });
});
