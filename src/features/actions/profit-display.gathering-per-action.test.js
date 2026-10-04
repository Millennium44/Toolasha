/** @vitest-environment happy-dom */
/**
 * Regression coverage for the gathering "Per action breakdown" panel.
 *
 * Every line in it is per completed action — the unit `profitPerAction` and
 * each output's `itemsPerAction` are in. The header, the costs and the bonus
 * drops used to be divided by time-consuming actions instead, so at any
 * efficiency above 0% Revenue − Costs came out at `efficiencyMultiplier` times
 * the Net Profit printed under them, and the output lines did not add up to
 * the revenue header.
 */
import { describe, test, expect } from 'vitest';

import { buildGatheringPerActionBreakdown } from './profit-display.js';
import { MARKET_TAX } from '../../utils/profit-constants.js';

/**
 * A milking action at 100% efficiency, shaped as gathering-profit.js returns it:
 * 600 time-consuming actions/hr, 2 completions each, 1 milk per roll at 100,
 * one essence drop, one tea, the market tax.
 */
function profitData() {
    const actionsPerHour = 600;
    const efficiencyMultiplier = 2;
    const completions = actionsPerHour * efficiencyMultiplier;
    const essencePerHourUnscaled = 600; // bonus-revenue-calculator: base actions/hour, no efficiency
    const revenuePerHour = completions * 100 + essencePerHourUnscaled * efficiencyMultiplier;
    const drinkCostPerHour = 12000;
    const profitPerHour = revenuePerHour * (1 - MARKET_TAX) - drinkCostPerHour;
    return {
        actionsPerHour,
        efficiencyMultiplier,
        revenuePerHour,
        drinkCostPerHour,
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
                revenuePerHour: completions * 100,
                revenuePerAction: 100,
                missingPrice: false,
            },
        ],
        drinkCosts: [
            {
                name: 'Gathering Tea',
                priceEach: 1000,
                drinksPerHour: 12,
                costPerHour: drinkCostPerHour,
                missingPrice: false,
            },
        ],
        bonusRevenue: {
            hasMissingPrices: false,
            essenceFindBonus: 0,
            totalBonusRevenue: essencePerHourUnscaled,
            bonusDrops: [
                {
                    itemName: 'Milking Essence',
                    type: 'essence',
                    dropRate: 0.1,
                    dropsPerHour: 60,
                    revenuePerHour: essencePerHourUnscaled,
                },
            ],
        },
    };
}

function valueBefore(text, suffix = '/action') {
    const match = text.match(new RegExp(`(-?[\\d.,]+)${suffix.replace('/', '\\/')}`));
    return match ? parseFloat(match[1].replace(/,/g, '')) : NaN;
}

function labelStartingWith(root, prefix) {
    return [...root.querySelectorAll('span, div')].find((el) => el.textContent.trim().startsWith(prefix));
}

describe('buildGatheringPerActionBreakdown', () => {
    test('already-net container bonuses keep revenue intact and reduce the shown tax', () => {
        const data = profitData();
        data.bonusRevenue.taxExemptBonusRevenue = 600;
        data.profitPerHour += 1200 * MARKET_TAX;
        data.profitPerAction = data.profitPerHour / 1200;
        const section = buildGatheringPerActionBreakdown(data);
        const [revenue, costs] = labelStartingWith(section, 'Revenue:').textContent.split('|');

        expect(valueBefore(revenue)).toBe(101);
        expect(valueBefore(costs)).toBe(14);
        expect(valueBefore(labelStartingWith(section, 'Market Tax:').textContent)).toBe(4);
    });

    test('Revenue − Costs equals the Net Profit shown, with efficiency above zero', () => {
        const data = profitData();
        const section = buildGatheringPerActionBreakdown(data);

        const summary = labelStartingWith(section, 'Revenue:');
        const [revenueText, costsText] = summary.textContent.split('|');
        const revenue = valueBefore(revenueText);
        const costs = valueBefore(costsText);
        const net = valueBefore(labelStartingWith(section, 'Net Profit:').textContent);

        expect(net).toBeCloseTo(data.profitPerAction, 2);
        expect(revenue - costs).toBeCloseTo(net, 1);
    });

    test('the primary and bonus lines add up to the revenue header', () => {
        const data = profitData();
        const section = buildGatheringPerActionBreakdown(data);

        const revenue = valueBefore(labelStartingWith(section, 'Revenue:').textContent);
        const primary = valueBefore(labelStartingWith(section, 'Primary Outputs:').textContent);
        const essence = valueBefore(labelStartingWith(section, 'Essence Drops:').textContent);

        // One roll: 1 milk at 100, plus 0.1 essence rolls' worth (600 / 600 base actions)
        expect(primary).toBeCloseTo(100, 6);
        expect(essence).toBeCloseTo(1, 6);
        expect(primary + essence).toBeCloseTo(revenue, 6);
    });

    test('drinks are charged per completion, not per time-consuming action', () => {
        const data = profitData();
        const section = buildGatheringPerActionBreakdown(data);

        const drinkCost = valueBefore(labelStartingWith(section, 'Drink Costs:').textContent);
        expect(drinkCost).toBeCloseTo(data.drinkCostPerHour / (data.actionsPerHour * data.efficiencyMultiplier), 6);
    });
});
