/** @vitest-environment happy-dom */

/**
 * The tax-excluded warning sits inside the collapsed Profitability content, so the collapsed
 * summary (the figure a player actually reads) carries its own compact marker.
 */

import { afterEach, describe, expect, test, vi } from 'vitest';

const settings = vi.hoisted(() => ({ values: { actionPanel_showProfitDetail: true } }));

vi.mock('../../core/config.js', () => ({
    default: {
        COLOR_TOOLTIP_PROFIT: '#0f0',
        COLOR_TOOLTIP_LOSS: '#f00',
        COLOR_LOSS: '#f00',
        SCRIPT_COLOR_ALERT: '#ff0',
        getSetting: (key, fallback) => (key in settings.values ? settings.values[key] : (fallback ?? true)),
        getSettingValue: (key, fallback) => (key in settings.values ? settings.values[key] : fallback),
        getPricingModeDisplayLabel: (mode) => mode,
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getActionDetails: (actionHrid) => ({
            type: actionHrid.includes('woodcutting') ? '/action_types/woodcutting' : '/action_types/crafting',
        }),
        getItemDetails: () => null,
        getInitClientData: () => null,
        setScrollSimulation: () => {},
        clearScrollSimulation: () => {},
        isBuffBeingSimulated: () => false,
    },
}));

const formatRunningActionProfitTextMock = vi.hoisted(() => vi.fn());
vi.mock('./unlimited-action-estimate.js', () => ({
    estimateUnlimitedAction: vi.fn(),
    formatUnlimitedProfitText: vi.fn(() => '∞'),
    formatRunningActionProfitText: formatRunningActionProfitTextMock,
}));

const calculateGatheringProfitMock = vi.hoisted(() => vi.fn());
const calculateProductionProfitMock = vi.hoisted(() => vi.fn());
vi.mock('./gathering-profit.js', () => ({ calculateGatheringProfit: calculateGatheringProfitMock }));
vi.mock('./production-profit.js', () => ({ calculateProductionProfit: calculateProductionProfitMock }));

vi.mock('../combat/loadout-snapshot.js', () => ({
    default: { getSnapshotInfoForSkill: () => null },
}));
vi.mock('../../utils/bundle-bridge.js', () => ({
    guildMemberSkills: () => null,
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

const { displayGatheringProfit, displayProductionProfit } = await import('./profit-display.js');

/** A gathering (woodcutting) profitData with one guaranteed output. */
function gatheringProfitData() {
    return {
        profitPerHour: 1000,
        profitPerAction: 10,
        profitPerDay: 24000,
        revenuePerHour: 1200,
        drinkCostPerHour: 0,
        drinkCosts: [],
        actionsPerHour: 100,
        baseOutputs: [
            {
                itemHrid: '/items/log',
                name: 'Log',
                itemsPerHour: 100,
                dropRate: 1,
                priceEach: 12,
                revenuePerHour: 1200,
                missingPrice: false,
            },
        ],
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
    };
}

/** A production (crafting) profitData with every field renderProductionProfit reads. */
function productionProfitData() {
    return {
        profitPerHour: 1000,
        profitPerAction: 10,
        profitPerDay: 24000,
        itemsPerHour: 100,
        itemHrid: '/items/plank',
        itemName: 'Plank',
        outputPrice: 12,
        priceAfterTax: 11,
        outputPriceMissing: false,
        outputPriceEstimated: false,
        gourmetBonusItems: 0,
        gourmetBonus: 0,
        materialCostPerHour: 200,
        totalMaterialCost: 2,
        totalTeaCostPerHour: 0,
        actionsPerHour: 100,
        totalEfficiency: 0,
        levelEfficiency: 0,
        houseEfficiency: 0,
        teaEfficiency: 0,
        equipmentEfficiency: 0,
        equipmentEfficiencyItems: [],
        communityEfficiency: 0,
        personalEfficiency: 0,
        achievementEfficiency: 0,
        artisanBonus: 0,
        efficiencyMultiplier: 1,
        materialCosts: [],
        teaCosts: [],
        bonusRevenue: { bonusDrops: [], hasMissingPrices: false },
        hasMissingPrices: false,
        pricingMode: 'hybrid',
    };
}

function makePanel() {
    const panel = document.createElement('div');
    document.body.appendChild(panel);
    return panel;
}

function summaryText(panel, id) {
    return panel.querySelector(`#${id} .mwi-section-header + div`)?.textContent ?? null;
}

const CASES = [
    {
        label: 'gathering',
        display: displayGatheringProfit,
        data: gatheringProfitData,
        calc: calculateGatheringProfitMock,
        actionHrid: '/actions/woodcutting/log',
        id: 'mwi-foraging-profit',
    },
    {
        label: 'production',
        display: displayProductionProfit,
        data: productionProfitData,
        calc: calculateProductionProfitMock,
        actionHrid: '/actions/crafting/plank',
        id: 'mwi-production-profit',
    },
];

describe.each(CASES)(
    'collapsed summary marks the sell-tax exclusion ($label)',
    ({ display, data, calc, actionHrid, id }) => {
        afterEach(() => {
            settings.values = { actionPanel_showProfitDetail: true };
            calc.mockReset();
            formatRunningActionProfitTextMock.mockReset();
            document.body.innerHTML = '';
        });

        test('on: the summary carries the marker', async () => {
            calc.mockResolvedValue({ ...data(), excludeSellTax: true });
            formatRunningActionProfitTextMock.mockReturnValue(null);
            const panel = makePanel();

            await display(panel, actionHrid, '.drop-table');

            expect(summaryText(panel, id)).toBe('1.00K/hr, 24.00K/day (no sell tax)');
        });

        test('off: the summary is unchanged', async () => {
            calc.mockResolvedValue(data());
            formatRunningActionProfitTextMock.mockReturnValue(null);
            const panel = makePanel();

            await display(panel, actionHrid, '.drop-table');

            expect(summaryText(panel, id)).toBe('1.00K/hr, 24.00K/day');
        });
    }
);
