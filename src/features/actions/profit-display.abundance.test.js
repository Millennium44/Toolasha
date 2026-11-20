/** @vitest-environment happy-dom */

/**
 * The gathering profit section's modifier summary names the talisman Abundance line (a chance to triple the
 * gathered amount) when the figures include it, beside the gathering quantity, and says nothing without it.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';

const game = vi.hoisted(() => ({
    saved: {},
    armed: [],
    values: { actionPanel_showProfitDetail: true, simulateScrollEffects: true },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        COLOR_ACCENT: '#0ff',
        COLOR_TOOLTIP_PROFIT: '#0f0',
        COLOR_TOOLTIP_LOSS: '#f00',
        COLOR_LOSS: '#f00',
        SCRIPT_COLOR_ALERT: '#ff0',
        getSetting: (key, fallback) => (key in game.values ? game.values[key] : fallback),
        getSettingValue: (key, fallback) => (key in game.values ? game.values[key] : fallback),
        getPricingModeDisplayLabel: (mode) => mode,
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getActionDetails: () => ({ type: '/action_types/foraging' }),
        getCurrentCharacterId: () => 'char1',
        getInitClientData: () => ({
            personalBuffTypeDetailMap: {
                '/personal_buff_types/efficiency': {
                    hrid: '/personal_buff_types/efficiency',
                    usableInActionTypeMap: { '/action_types/foraging': true },
                    buff: { typeHrid: '/buff_types/efficiency', flatBoost: 0.14 },
                },
            },
        }),
        on: () => {},
        setScrollSimulation: (type, set) => game.armed.push([...set]),
        clearScrollSimulation: () => {},
        // True for what the last call to setScrollSimulation armed, as the real data manager does
        isBuffBeingSimulated: (type, buff) => (game.armed.at(-1) ?? []).includes(buff),
    },
}));

const profitDataFor = (outputCount) => ({
    profitPerHour: 1000,
    profitPerAction: 10,
    profitPerDay: 24000,
    revenuePerHour: 1200,
    drinkCostPerHour: 0,
    drinkCosts: [],
    actionsPerHour: 100,
    baseOutputs: Array.from({ length: outputCount }, (_, i) => ({
        itemHrid: `/items/output_${i}`,
        name: `Output ${i}`,
        itemsPerHour: 10,
        dropRate: 1 / outputCount,
        priceEach: 100,
        revenuePerHour: 1000 / outputCount,
        missingPrice: false,
    })),
    gourmetBonuses: [],
    totalEfficiency: 0,
    efficiencyMultiplier: 1,
    speedBonus: 0,
    bonusRevenue: { bonusDrops: [], hasMissingPrices: false },
    gourmetBonus: 0,
    processingBonus: 0,
    processingRevenueBonus: 0,
    processingConversions: [],
    processingRevenueBonusPerAction: 0,
    gourmetRevenueBonus: 0,
    gourmetRevenueBonusPerAction: 0,
    gatheringQuantity: 0.2,
    abundance: 0,
    hasMissingPrices: false,
    pricingMode: 'hybrid',
    details: {
        levelEfficiency: 0,
        houseEfficiency: 0,
        teaEfficiency: 0,
        equipmentEfficiency: 0,
        equipmentEfficiencyItems: [],
        achievementEfficiency: 0,
        personalEfficiency: 0,
        communityBuffQuantity: 0.2,
        gatheringTeaBonus: 0,
        achievementGathering: 0,
        personalGathering: 0,
    },
});

const calculateGatheringProfitMock = vi.hoisted(() => vi.fn());
vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: calculateGatheringProfitMock }));
vi.mock('./production-profit.js', () => ({ calculateProductionProfit: vi.fn() }));

vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async (key, store, fallback) => game.saved[key] ?? fallback,
        setJSON: async (key, value) => {
            game.saved[key] = value;
        },
    },
}));
vi.mock('../combat/loadout-snapshot.js', () => ({
    default: { getSnapshotInfoForSkill: () => null },
}));
vi.mock('../../utils/bundle-bridge.js', () => ({
    marketUndercutAlerts: () => null,
    marketDepthCap: () => null,
    guildMemberSkills: () => null,
    loadoutSnapshot: () => null,
    scrollSimulator: () => null,
}));
vi.mock('../../utils/market-data.js', () => ({
    isPriceOverridden: () => false,
    isPriceEstimated: () => false,
    getPriceAgeString: () => '',
}));
vi.mock('../../utils/calibration-badge.js', () => ({
    appendCalibrationBadge: () => {},
}));

const { displayGatheringProfit } = await import('./profit-display.js');

describe('the gathering profit modifiers name Abundance', () => {
    const draw = async (overrides) => {
        calculateGatheringProfitMock.mockResolvedValue({ ...profitDataFor(1), ...overrides });
        const panel = document.createElement('div');
        document.body.appendChild(panel);
        await displayGatheringProfit(panel, '/actions/foraging/map', '.drop-table');
        return panel.querySelector('#mwi-foraging-profit').textContent;
    };

    afterEach(() => {
        calculateGatheringProfitMock.mockReset();
        document.body.innerHTML = '';
    });

    test('a worn line shows beside the gathering quantity, with what it does on average', async () => {
        const text = await draw({ abundance: 0.04 });
        expect(text).toContain('+4.00% abundance');
        expect(text).toContain('4.00% chance to triple the gather (x1.08 on average)');
        expect(text).toContain('+20.00% gather');
    });

    test('no line (absent, or a profit result from before it existed) shows nothing about it', async () => {
        expect(await draw({ abundance: 0 })).not.toMatch(/abundance/i);
        expect(await draw({ abundance: undefined })).not.toMatch(/abundance/i);
    });

    test('it shows with no gathering quantity at all', async () => {
        const text = await draw({ abundance: 0.01, gatheringQuantity: 0 });
        expect(text).toContain('+1.00% abundance');
        expect(text).not.toContain('% gather');
    });
});
