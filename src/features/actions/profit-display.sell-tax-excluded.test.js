/** @vitest-environment happy-dom */
/**
 * With the personal-use sell-tax exclusion on, the profit breakdown must say the tax is excluded
 * (not show a 0% rate that reads like a glitch) and put a warning under Net Profit. With it off
 * the panel is unchanged.
 */
import { describe, test, expect } from 'vitest';

import { buildGatheringPerActionBreakdown, buildProductionPerActionBreakdown } from './profit-display.js';
import { MARKET_TAX } from '../../utils/profit-constants.js';

function gatheringData(excludeSellTax) {
    const completions = 600;
    const revenuePerHour = completions * 100;
    const marketTax = excludeSellTax ? 0 : revenuePerHour * MARKET_TAX;
    const profitPerHour = revenuePerHour - marketTax;
    return {
        actionsPerHour: 600,
        efficiencyMultiplier: 1,
        revenuePerHour,
        marketTax,
        excludeSellTax,
        drinkCostPerHour: 0,
        profitPerHour,
        profitPerAction: profitPerHour / completions,
        hasMissingPrices: false,
        processingRevenueBonus: 0,
        gourmetRevenueBonus: 0,
        baseOutputs: [
            {
                itemHrid: '/items/milk',
                name: 'Milk',
                itemsPerHour: completions,
                itemsPerAction: 1,
                priceEach: 100,
                revenuePerHour: revenuePerHour,
                revenuePerAction: 100,
                missingPrice: false,
            },
        ],
        drinkCosts: [],
        bonusRevenue: { hasMissingPrices: false, essenceFindBonus: 0, totalBonusRevenue: 0, bonusDrops: [] },
    };
}

const text = (root, prefix) =>
    [...root.querySelectorAll('span, div')].find((el) => el.textContent.trim().startsWith(prefix))?.textContent;

describe('gathering per-action breakdown and the sell-tax exclusion', () => {
    test('off: shows the tax rate and no warning', () => {
        const section = buildGatheringPerActionBreakdown(gatheringData(false));

        expect(text(section, 'Market Tax:')).toContain(`${Math.round(MARKET_TAX * 100)}%`);
        expect(section.querySelector('.mwi-sell-tax-excluded-warning')).toBeNull();
        expect(section.textContent).not.toContain('Excluded');
    });

    test('on: says the tax is excluded, deducts nothing, and warns under Net Profit', () => {
        const data = gatheringData(true);
        const section = buildGatheringPerActionBreakdown(data);

        expect(text(section, 'Market Tax:')).toContain('Excluded');
        expect(text(section, 'Market Tax:')).not.toContain('%');
        expect(section.querySelector('.mwi-sell-tax-excluded-warning')).not.toBeNull();
        // Net profit per action is the full 100 revenue, no tax taken out of it
        expect(text(section, 'Net Profit:')).toContain('100');
    });
});

describe('production per-action breakdown and the sell-tax exclusion', () => {
    function productionData(excludeSellTax) {
        const actionsPerHour = 360;
        const revenuePerHour = actionsPerHour * 100;
        const marketTax = excludeSellTax ? 0 : revenuePerHour * MARKET_TAX;
        const materialCostPerHour = actionsPerHour * 10;
        const profitPerHour = revenuePerHour - marketTax - materialCostPerHour;
        return {
            itemName: 'Cheese',
            actionsPerHour,
            efficiencyMultiplier: 1,
            itemsPerHour: actionsPerHour,
            totalItemsPerHour: actionsPerHour,
            gourmetBonusItems: 0,
            gourmetBonus: 0,
            outputAmount: 1,
            outputPrice: 100,
            revenuePerHour,
            marketTax,
            excludeSellTax,
            materialCosts: [],
            totalMaterialCost: 10,
            materialCostPerHour,
            teaCosts: [],
            totalTeaCostPerHour: 0,
            profitPerHour,
            profitPerAction: profitPerHour / actionsPerHour,
            hasMissingPrices: false,
            bonusRevenue: { hasMissingPrices: false, totalBonusRevenue: 0, bonusDrops: [] },
        };
    }

    test('off: unchanged (tax rate shown, no warning)', () => {
        const section = buildProductionPerActionBreakdown(productionData(false));

        expect(text(section, 'Market Tax:')).toContain(`${Math.round(MARKET_TAX * 100)}%`);
        expect(section.querySelector('.mwi-sell-tax-excluded-warning')).toBeNull();
    });

    test('on: tax excluded, warning present, net profit is revenue minus materials only', () => {
        const section = buildProductionPerActionBreakdown(productionData(true));

        expect(text(section, 'Market Tax:')).toContain('Excluded');
        expect(section.querySelector('.mwi-sell-tax-excluded-warning')).not.toBeNull();
        expect(text(section, 'Net Profit:')).toContain('90');
    });
});
