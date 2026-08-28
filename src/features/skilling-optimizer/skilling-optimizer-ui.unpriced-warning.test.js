/** @vitest-environment happy-dom */
/**
 * Regression coverage for the "leans on an unpriced material" warning on the
 * skilling optimizer's Gold/hr stats.
 *
 * tea-optimizer.js's findOptimalTeas()/calculateSkillPerformance() compute a
 * `hasMissingPrices` flag whenever a counted action's gold score depends on an item with no
 * price data (treated as free rather than excluded — see actionHasUnpricedMaterials in
 * src/utils/tea-optimizer.js). optimizeSkill() forwards that flag through untouched on
 * xpTeaResult/goldTeaResult, but before this fix _makeStat() had no way to display it, so the
 * "Avg Gold/hr" and per-simulation "Gold / hr" stats never warned a player that the number
 * assumed a missing material was free.
 *
 * This file already stands up happy-dom for skilling-optimizer-ui.js (see
 * skilling-optimizer-ui.character-switch.test.js), so _makeStat — a plain instance method that
 * only touches the DOM it is handed — is exercised directly rather than mocked.
 */
import { describe, test, expect } from 'vitest';

import { skillingSimulatorUI } from './skilling-optimizer-ui.js';

describe('_makeStat unpriced-material warning', () => {
    test('no warning marker when warningTitle is not passed', () => {
        const el = skillingSimulatorUI._makeStat('Avg Gold/hr', 1234, '#22c55e');
        expect(el.innerHTML).not.toContain('⚠');
    });

    test('renders a titled ⚠ marker when warningTitle is passed', () => {
        const el = skillingSimulatorUI._makeStat('Avg Gold/hr', 1234, '#22c55e', 'Leans on an unpriced material');
        expect(el.innerHTML).toContain('⚠');
        expect(el.innerHTML).toContain('title="Leans on an unpriced material"');
    });

    test('suppresses the warning marker when the value itself is not shown (— placeholder)', () => {
        // value <= 0 renders as an em-dash with no number to warn about
        const el = skillingSimulatorUI._makeStat('Avg Gold/hr', 0, '#22c55e', 'Leans on an unpriced material');
        expect(el.innerHTML).not.toContain('⚠');
    });
});
