/**
 * @vitest-environment happy-dom
 *
 * A combat task's profit line when the sim's drops or consumables are unpriced.
 *
 * `calculateSimRevenue` counts an item nothing can price at zero. For a drop that
 * makes the total a floor; for a consumable (a potion with no market listing) it
 * makes the cost too small and the profit too big. The line used to draw both as
 * a complete figure; it now says "≥" for the first and withholds the second.
 */

import { describe, test, expect, vi } from 'vitest';
import taskProfitDisplay from './task-profit-display.js';

vi.mock('../combat-sim/combat-sim-runner.js', () => ({ runSimulation: vi.fn() }));
vi.mock('../combat-sim/combat-sim-adapter.js', () => ({
    buildAllPlayerDTOs: vi.fn(),
    buildGameDataPayload: vi.fn(),
    getCommunityBuffs: vi.fn(() => ({})),
    applyLoadoutSnapshotToDTO: vi.fn(),
    calculateSimRevenue: vi.fn(() => ({ netPerHour: 0, dropEntries: [], consumableEntries: [] })),
}));

const rewardValue = {
    coins: 1000,
    taskTokens: 0,
    purpleGift: 0,
    total: 1000,
    isPartial: false,
    breakdown: { tokenValue: 0, tokensReceived: 0, giftPerTaskPoint: 0 },
    error: null,
};
const dropEntries = [{ itemHrid: '/items/cheese', name: 'Cheese', countPerHour: 10, unitValue: 100, totalValue: 1000 }];

/**
 * @param {{drops: string[], consumables: string[]}} unpriced - What nothing could price
 * @param {Array<Object>} consumableEntries - Priced consumables
 * @returns {string} The first line of the rendered estimate
 */
function render(unpriced, consumableEntries = []) {
    const container = document.createElement('div');
    taskProfitDisplay._renderCombatEstimateResult(
        container,
        { quantity: 100, currentProgress: 0, coinReward: 1000, taskTokenReward: 0 },
        'Rat',
        100,
        '1h',
        3600,
        '',
        0,
        rewardValue,
        dropEntries,
        consumableEntries,
        'solo',
        null,
        null,
        0,
        true,
        unpriced
    );
    return container.firstElementChild.textContent;
}

describe('combat estimate with unpriced items', () => {
    test('fully priced reads as a plain figure', () => {
        const line = render({ drops: [], consumables: [] });
        expect(line).toContain('2.0K');
        expect(line).not.toContain('≥');
        expect(line).not.toContain('--');
    });

    test('an unpriced drop makes the figure a floor', () => {
        const line = render({ drops: ['/items/odd_drop'], consumables: [] });
        expect(line).toContain('≥ 2.0K');
    });

    test('an unpriced consumable withholds the figure instead of charging it at zero', () => {
        const line = render({ drops: [], consumables: ['/items/mystery_tea'] });
        expect(line).toContain('-- ⚠');
        expect(line).not.toContain('2.0K');
    });
});
