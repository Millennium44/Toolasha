/** @vitest-environment happy-dom */
/**
 * Regression coverage for the production "Per action breakdown" panel.
 *
 * The header line (`bonusRevenuePerAction`, folded into "Revenue: X/action")
 * is deliberately computed with no efficiency multiplier — the comment above
 * it in profit-display.js calls out that this section states the true cost
 * of one animation cycle, not one completion averaged over the free instant
 * repeats efficiency adds. The Essence Drops / Rare Finds subsections nested
 * under that header used to apply the efficiency multiplier anyway (via
 * `getBonusDropPerHourTotals(drop, efficiencyMultiplier)`), so whenever
 * efficiency was above 0% the itemized lines summed to more than the header
 * they sit under — a real, visible inconsistency for any high-efficiency
 * production action with essence or rare-find drops (e.g. late-game cooking
 * or crafting).
 */
import { describe, test, expect } from 'vitest';

import { buildProductionPerActionBreakdown } from './profit-display.js';

/**
 * A production action at 150% efficiency (2.5x completions per animation
 * cycle) with one essence drop and one rare find, matching the shape
 * bonus-revenue-calculator.js produces.
 */
function profitData() {
    return {
        actionsPerHour: 300,
        efficiencyMultiplier: 2.5,
        itemName: 'Cheese',
        outputAmount: 1,
        outputPrice: 1000,
        gourmetBonus: 0,
        totalMaterialCost: 400,
        totalTeaCostPerHour: 0,
        hasMissingPrices: false,
        bonusRevenue: {
            hasMissingPrices: false,
            essenceFindBonus: 5,
            totalBonusRevenue: 6000, // sum of the two drops' revenuePerHour below, unscaled
            bonusDrops: [
                {
                    itemName: 'Cheese Essence',
                    type: 'essence',
                    dropRate: 0.05,
                    dropsPerHour: 15,
                    revenuePerHour: 4500,
                },
                {
                    itemName: 'Rare Cheese Mold',
                    type: 'rare_find',
                    dropRate: 0.01,
                    dropsPerHour: 3,
                    revenuePerHour: 1500,
                },
            ],
        },
    };
}

/**
 * Pull the revenue figure back out of a rendered line's text — the value
 * right before the first "/action" (a per-drop line has a second "/action"
 * later, for its drop rate, which this intentionally ignores).
 */
function perActionValue(text) {
    const match = text.match(/([\d.,]+)\/action/);
    return match ? parseFloat(match[1].replace(/,/g, '')) : NaN;
}

/**
 * Same, but the value after "→" — a per-drop line states drops/action first
 * and revenue/action second.
 */
function revenuePerActionValue(text) {
    const after = text.split('→')[1] || '';
    return perActionValue(after);
}

/** The section header's own label text — an "icon title" span, not a div. */
function findLabel(root, startsWith) {
    return [...root.querySelectorAll('span')].find((el) => el.textContent.trim().startsWith(startsWith));
}

describe('buildProductionPerActionBreakdown', () => {
    test('essence and rare-find subsection totals sum to the header bonus revenue, even with efficiency > 1', () => {
        const data = profitData();
        const section = buildProductionPerActionBreakdown(data);

        const essenceLine = findLabel(section, 'Essence Drops:');
        const rareFindLine = findLabel(section, 'Rare Finds:');
        expect(essenceLine).toBeTruthy();
        expect(rareFindLine).toBeTruthy();

        const essencePerAction = perActionValue(essenceLine.textContent);
        const rareFindPerAction = perActionValue(rareFindLine.textContent);

        // The header basis: bonusRevenueTotal / actionsPerHour, with NO efficiency
        // multiplier (mirrors the private computation in buildProductionPerActionBreakdown).
        const expectedBonusPerAction = data.bonusRevenue.totalBonusRevenue / data.actionsPerHour;

        expect(essencePerAction + rareFindPerAction).toBeCloseTo(expectedBonusPerAction, 6);

        // And explicitly not the (bugged) efficiency-scaled figure, so a
        // regression that reintroduces the multiplier fails loudly rather
        // than by a coincidental rounding match.
        const buggyBonusPerAction = expectedBonusPerAction * data.efficiencyMultiplier;
        expect(essencePerAction + rareFindPerAction).not.toBeCloseTo(buggyBonusPerAction, 6);
    });

    test('per-drop lines also use the unscaled per-action basis', () => {
        const data = profitData();
        const section = buildProductionPerActionBreakdown(data);

        const essenceItemLine = [...section.querySelectorAll('div')].find((el) =>
            el.textContent.startsWith('• Cheese Essence:')
        );
        expect(essenceItemLine).toBeTruthy();

        const drop = data.bonusRevenue.bonusDrops[0];
        const expected = drop.revenuePerHour / data.actionsPerHour;
        expect(revenuePerActionValue(essenceItemLine.textContent)).toBeCloseTo(expected, 6);
    });
});
