/**
 * Regression coverage for the "leans on an unpriced material" warning in the tea
 * recommendation popup.
 *
 * tea-optimizer.js's findOptimalTeas()/calculateSkillPerformance() compute a
 * `hasMissingPrices` flag whenever a counted action's gold score depends on an item with no
 * price data (treated as free rather than excluded — see actionHasUnpricedMaterials). Before
 * this fix nothing in the UI read that flag, so a gold recommendation could rest on a free-item
 * assumption with no visible sign of it.
 *
 * tea-recommendation.js builds its popup with direct DOM calls and has no happy-dom test file —
 * a full render test would mean standing up a DOM environment and mocking every dependency
 * (config, dataManager, domObserver, actionFilter, alchemyProfit) just to check one conditional.
 * shouldWarnUnpriced() is the pure decision this file makes wherever it draws the marker, so it
 * is extracted and tested directly instead.
 */
import { describe, test, expect } from 'vitest';

import { shouldWarnUnpriced } from './tea-recommendation.js';

describe('shouldWarnUnpriced', () => {
    test('warns for a gold recommendation that leans on an unpriced material', () => {
        expect(shouldWarnUnpriced('gold', true)).toBe(true);
    });

    test('does not warn for a gold recommendation with fully priced materials', () => {
        expect(shouldWarnUnpriced('gold', false)).toBe(false);
    });

    test('never warns for xp, even if the flag is somehow set', () => {
        expect(shouldWarnUnpriced('xp', true)).toBe(false);
    });

    test('treats a missing/undefined flag as false (older or partial results)', () => {
        expect(shouldWarnUnpriced('gold', undefined)).toBe(false);
    });
});
