/** @vitest-environment happy-dom */

/**
 * `actionPanel_foragingTotal` gates the "overall profit" total that only means
 * something on a multi-outcome Foraging map — a drop table of mutually
 * exclusive rewards, unlike Woodcutting/Milking's guaranteed single output.
 * The setting existed in the schema (default true) but was read nowhere;
 * `displayGatheringProfit` now checks it before building the section.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';

const settings = vi.hoisted(() => ({
    values: { actionPanel_showProfitDetail: true, actionPanel_foragingTotal: true },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        COLOR_TOOLTIP_PROFIT: '#0f0',
        COLOR_TOOLTIP_LOSS: '#f00',
        COLOR_LOSS: '#f00',
        SCRIPT_COLOR_ALERT: '#ff0',
        getSetting: (key, fallback) => (key in settings.values ? settings.values[key] : fallback),
        getSettingValue: (key, fallback) => (key in settings.values ? settings.values[key] : fallback),
        getPricingModeDisplayLabel: (mode) => mode,
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getActionDetails: (actionHrid) => ({
            type: actionHrid.includes('foraging') ? '/action_types/foraging' : '/action_types/woodcutting',
        }),
        setScrollSimulation: () => {},
        clearScrollSimulation: () => {},
        isBuffBeingSimulated: () => false,
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
    gatheringQuantity: 0,
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
        communityBuffQuantity: 0,
        gatheringTeaBonus: 0,
        achievementGathering: 0,
        personalGathering: 0,
    },
});

const calculateGatheringProfitMock = vi.hoisted(() => vi.fn());
vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: calculateGatheringProfitMock }));
vi.mock('./production-profit.js', () => ({ calculateProductionProfit: vi.fn() }));

vi.mock('../combat/loadout-snapshot.js', () => ({
    default: { getSnapshotInfoForSkill: () => null },
}));
vi.mock('../../utils/bundle-bridge.js', () => ({
    loadoutSnapshot: () => null,
    scrollSimulator: () => null,
}));
vi.mock('../combat/scroll-simulator.js', () => ({
    default: { getScrollSetForActionType: () => [] },
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

function makePanel() {
    const panel = document.createElement('div');
    document.body.appendChild(panel);
    return panel;
}

describe('actionPanel_foragingTotal gates the multi-outcome foraging total', () => {
    afterEach(() => {
        settings.values = { actionPanel_showProfitDetail: true, actionPanel_foragingTotal: true };
        calculateGatheringProfitMock.mockReset();
        document.body.innerHTML = '';
    });

    test('renders the overall total for a multi-outcome foraging map when the setting is on', async () => {
        calculateGatheringProfitMock.mockResolvedValue(profitDataFor(2));
        const panel = makePanel();

        await displayGatheringProfit(panel, '/actions/foraging/map', '.drop-table');

        expect(panel.querySelector('#mwi-foraging-profit')).toBeTruthy();
    });

    test('the total is absent for a multi-outcome foraging map when the setting is off', async () => {
        settings.values.actionPanel_foragingTotal = false;
        calculateGatheringProfitMock.mockResolvedValue(profitDataFor(2));
        const panel = makePanel();

        await displayGatheringProfit(panel, '/actions/foraging/map', '.drop-table');

        expect(panel.querySelector('#mwi-foraging-profit')).toBeFalsy();
    });

    test('a single-outcome foraging spot is unaffected by the setting', async () => {
        settings.values.actionPanel_foragingTotal = false;
        calculateGatheringProfitMock.mockResolvedValue(profitDataFor(1));
        const panel = makePanel();

        await displayGatheringProfit(panel, '/actions/foraging/single', '.drop-table');

        expect(panel.querySelector('#mwi-foraging-profit')).toBeTruthy();
    });

    test('Woodcutting/Milking profit is unaffected by the setting even with a multi-row drop table', async () => {
        settings.values.actionPanel_foragingTotal = false;
        calculateGatheringProfitMock.mockResolvedValue(profitDataFor(2));
        const panel = makePanel();

        await displayGatheringProfit(panel, '/actions/woodcutting/tree', '.drop-table');

        expect(panel.querySelector('#mwi-foraging-profit')).toBeTruthy();
    });

    test('the panel updates when the setting changes', async () => {
        calculateGatheringProfitMock.mockResolvedValue(profitDataFor(2));
        const panel = makePanel();

        await displayGatheringProfit(panel, '/actions/foraging/map', '.drop-table');
        expect(panel.querySelector('#mwi-foraging-profit')).toBeTruthy();

        settings.values.actionPanel_foragingTotal = false;
        await displayGatheringProfit(panel, '/actions/foraging/map', '.drop-table');
        expect(panel.querySelector('#mwi-foraging-profit')).toBeFalsy();

        settings.values.actionPanel_foragingTotal = true;
        await displayGatheringProfit(panel, '/actions/foraging/map', '.drop-table');
        expect(panel.querySelector('#mwi-foraging-profit')).toBeTruthy();
    });
});
