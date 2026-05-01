/**
 * Crafting Plan Feature
 * Shows the cheapest way to obtain a crafted item by comparing
 * buy vs craft at each material tier.
 */

import craftingPlanDisplay from './crafting-plan-display.js';

export default {
    name: 'Crafting Plan',
    initialize: () => {
        craftingPlanDisplay.initialize();
    },
    disable: () => {
        craftingPlanDisplay.disable();
    },
};
