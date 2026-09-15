/**
 * Pricing mode cycle
 *
 * The order the "Mode:" buttons step through the profit calculator's pricing
 * modes. One list, so the action-panel toolbar and the alchemy Best Items modal
 * cannot drift apart. Constants and a pure function only — no module state.
 */

/** Pricing modes in the order a "Mode:" button cycles them */
export const PRICING_MODE_CYCLE = Object.freeze(['hybrid', 'conservative', 'optimistic', 'patientBuy']);

/**
 * The mode after `current` in the cycle, wrapping at the end. An unknown or
 * missing mode steps to the first entry.
 * @param {string} current - Current `profitCalc_pricingMode` value
 * @returns {string} Next pricing mode
 */
export function nextPricingMode(current) {
    const index = PRICING_MODE_CYCLE.indexOf(current);
    return PRICING_MODE_CYCLE[(index + 1) % PRICING_MODE_CYCLE.length];
}
