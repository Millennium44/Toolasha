/** @vitest-environment happy-dom */
import { describe, test, expect, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: {
        COLOR_ACCENT: '#22c55e',
        COLOR_PROFIT: '#047857',
        COLOR_LOSS: '#f87171',
        Z_FLOATING_PANEL: 1100,
        getSettingValue: () => null,
        getSetting: () => false,
    },
}));
vi.mock('../../core/data-manager.js', () => ({ default: { getInitClientData: () => null } }));
vi.mock('../../core/storage.js', () => ({
    default: { get: vi.fn(async (key, store, fallback) => fallback), set: vi.fn() },
}));

const HOUR = 3_600_000;
const getHistory = vi.fn(() => []);
vi.mock('./networth-history.js', () => ({
    default: {
        getHistory,
        getDetailSnapshot: () => ({ t: Date.now() - 24 * HOUR, items: {} }),
        deleteSnapshot: async () => {},
    },
    GAP_THRESHOLD_MS: 2 * HOUR,
}));

const { default: chart } = await import('./networth-history-chart.js');

describe('the 24h breakdown beside a setting change', () => {
    const now = Date.now();
    const history = [
        { t: now - 24 * HOUR, total: 1_000_000, nonExcluded: 1_000_000 },
        {
            t: now - 5 * HOUR,
            total: 1_400_000,
            nonExcluded: 1_400_000,
            marker: {
                changes: [{ id: 'networth_includeLabyrinthTokens', from: false, to: true }],
                step: 400_000,
                stepCounted: 400_000,
                unseparated: [],
                raw: 400_000,
            },
        },
    ];

    test('a Setting change row takes the step back out so the rows sum to the headline', () => {
        getHistory.mockReturnValue(history);
        chart.networthFeature = {
            currentData: {
                totalNetworth: 1_450_000,
                coins: 0,
                excluded: { total: 0 },
                currentAssets: {
                    inventory: {
                        breakdown: [{ itemHrid: '/items/log', enhancementLevel: 0, count: 1, value: 450_000 }],
                    },
                    equipped: { breakdown: [] },
                    listings: { breakdown: [] },
                },
                fixedAssets: {
                    houses: { breakdown: [] },
                    abilities: { breakdown: [] },
                    abilityBooks: { breakdown: [] },
                },
            },
        };
        const container = document.createElement('div');
        chart.render24hBreakdown(container);
        expect(container.textContent).toContain('Setting change (left out of the headline)');
        // headline is +50K (1.45M - 1.0M - 0.4M); the row is the 400K taken back out
        expect(container.textContent).toContain('-400.00K');
    });
});
