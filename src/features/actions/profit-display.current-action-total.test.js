/** @vitest-environment happy-dom */

/**
 * The Current Action tab (a running action with a Stop button, no Repeat input at all) used
 * to leave the Profitability summary reading the hardcoded `| Total profit: 0` baseline every
 * `renderGatheringProfit` / `renderProductionProfit` starts from, because the whole
 * `if (inputField && profitSummaryDiv)` block that overwrites it never runs without an input
 * field to find. A configure-tab input left empty had the same problem from the other side:
 * `parseInt('') || 0` reads as "zero requested" even though nothing was entered.
 *
 * `formatRunningActionProfitText` (unlimited-action-estimate.js) is mocked here rather than
 * exercised for real — its own arithmetic (unbounded vs. materials-bounded vs. a counted run's
 * remainder) is covered by unlimited-action-estimate.test.js and
 * alchemy-profit-display.current-action-total assertions in that same file. What this file
 * checks is narrower: that the gathering and production panels wire a Current Action tab to
 * that helper at all, that a `null` result omits the clause instead of printing an invented
 * `0`, and that an empty Repeat box does the same rather than reading as a real zero.
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

/** A configure-tab panel: a Repeat input the way `findActionInput` looks for one. */
function makePanelWithInput(value) {
    const panel = makePanel();
    const wrapper = document.createElement('div');
    wrapper.className = 'maxActionCountInput_wrapper';
    const input = document.createElement('input');
    input.value = value;
    wrapper.appendChild(input);
    panel.appendChild(wrapper);
    return { panel, input };
}

function summaryText(panel, id) {
    return panel.querySelector(`#${id} .mwi-section-header + div`)?.textContent ?? null;
}

describe.each([
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
])('the Current Action tab ($label)', ({ display, data, calc, actionHrid, id }) => {
    afterEach(() => {
        settings.values = { actionPanel_showProfitDetail: true };
        calc.mockReset();
        formatRunningActionProfitTextMock.mockReset();
        document.body.innerHTML = '';
    });

    test('a running action with a real derivable total shows it, not a fabricated 0', async () => {
        calc.mockResolvedValue(data());
        formatRunningActionProfitTextMock.mockReturnValue('8.00T · mat: 51.48K');
        const panel = makePanel();

        await display(panel, actionHrid, '.drop-table');

        expect(summaryText(panel, id)).toContain('| Total profit: 8.00T · mat: 51.48K');
        expect(formatRunningActionProfitTextMock).toHaveBeenCalledWith(
            expect.objectContaining({ actionHrid }),
            expect.any(Function)
        );
    });

    test('with nothing derivable, the clause is omitted rather than printing 0', async () => {
        calc.mockResolvedValue(data());
        formatRunningActionProfitTextMock.mockReturnValue(null);
        const panel = makePanel();

        await display(panel, actionHrid, '.drop-table');

        const text = summaryText(panel, id);
        expect(text).not.toContain('Total profit');
        expect(text).toBe('1.00K/hr, 24.00K/day');
    });

    test('a genuinely-zero running total still prints 0', async () => {
        calc.mockResolvedValue(data());
        formatRunningActionProfitTextMock.mockReturnValue('0');
        const panel = makePanel();

        await display(panel, actionHrid, '.drop-table');

        expect(summaryText(panel, id)).toContain('| Total profit: 0');
    });

    test('missing prices still read -- ⚠ on the Current Action tab', async () => {
        calc.mockResolvedValue({ ...data(), hasMissingPrices: true });
        const panel = makePanel();

        await display(panel, actionHrid, '.drop-table');

        expect(summaryText(panel, id)).toContain('| Total profit: -- ⚠');
        // The missing-price branch is decided before the running-action lookup runs at all.
        expect(formatRunningActionProfitTextMock).not.toHaveBeenCalled();
    });

    test('an empty Repeat box omits the clause rather than reading as zero', async () => {
        calc.mockResolvedValue(data());
        const { panel } = makePanelWithInput('');

        await display(panel, actionHrid, '.drop-table');

        const text = summaryText(panel, id);
        expect(text).not.toContain('Total profit');
        expect(text).toBe('1.00K/hr, 24.00K/day');
        // The configure-tab path never asks the running-action helper — it has its own input.
        expect(formatRunningActionProfitTextMock).not.toHaveBeenCalled();
    });

    test('a literal 0 typed into Repeat is a real zero, not an empty box', async () => {
        calc.mockResolvedValue(data());
        const { panel } = makePanelWithInput('0');

        await display(panel, actionHrid, '.drop-table');

        expect(summaryText(panel, id)).toContain('| Total profit: 0');
    });

    test('the ∞ configure-tab case is unaffected — still reads through formatUnlimitedProfitText', async () => {
        calc.mockResolvedValue(data());
        const { panel } = makePanelWithInput('∞');

        await display(panel, actionHrid, '.drop-table');

        expect(summaryText(panel, id)).toContain('| Total profit: ∞');
        expect(formatRunningActionProfitTextMock).not.toHaveBeenCalled();
    });
});
