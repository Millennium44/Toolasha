/**
 * The enhancing panel's Philosopher's Mirror column.
 *
 * A mirror combines a +(L-1) and a +(L-2) into a +L. Each of those two items started life as a
 * base item, while the panel's Total Cost column is the bill for climbing a base item the player
 * already holds. The mirror route therefore costs one more base item than its two enhancement
 * bills say, and the column has to count it or every expensive base item looks mirror-cheap.
 */
import { describe, test, expect, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => false, getSettingValue: () => false } }));
vi.mock('../../core/data-manager.js', () => ({ default: {} }));
vi.mock('../../utils/enhancement-config.js', () => ({ getEnhancingParams: () => ({}) }));
vi.mock('../../api/marketplace.js', () => ({ default: { getPrice: () => null, on: () => {} } }));
vi.mock('../../utils/tester-shop.js', () => ({
    testerShopEnabled: () => false,
    testerGearPrice: () => null,
    MIRROR_HRID: '/items/philosophers_mirror',
}));
vi.mock('../../utils/bundle-bridge.js', () => ({ missingMaterialsButton: () => null }));
vi.mock('../../utils/dom-observer-helpers.js', () => ({ createMutationWatcher: () => () => {} }));

import { mirrorCostColumn } from './enhancement-display.js';

/** Twenty levels of a steep hard-way climb */
const steep = Array.from({ length: 20 }, (_, i) => 1000 * 2 ** i);

describe('mirrorCostColumn', () => {
    test('+1 and +2 have no mirror route; +3 is the first', () => {
        const { levels } = mirrorCostColumn(steep, 0, 1);
        expect(levels[0]).toBeUndefined();
        expect(levels[1]).toBeUndefined();
        expect(levels[2]).toBeDefined();
    });

    test('the second base item the mirror route consumes is counted', () => {
        // +3 the hard way: 4,000. Mirroring a +2 (2,000) with a +1 (1,000) and a 500 mirror
        // looks like 3,500 — but the +1 had to be a whole second base item at 1,000.
        const { levels, mirrorStartLevel } = mirrorCostColumn(steep, 1000, 500);
        expect(levels[2].mirrorCost).toBe(2000 + 1000 + 500 + 1000);
        expect(levels[2].isMirrorCheaper).toBe(false);
        expect(mirrorStartLevel).not.toBe(3);
    });

    test('a mirrored level feeds the levels above it', () => {
        const { levels, mirrorStartLevel } = mirrorCostColumn(steep, 0, 100);
        // +3: 2,000 + 1,000 + 100 beats 4,000
        expect(levels[2].mirrorCost).toBe(3100);
        expect(levels[2].isMirrorCheaper).toBe(true);
        // +4 combines the mirrored +3 (3,100), not the hard-way one (4,000), with the +2
        expect(levels[3].mirrorCost).toBe(3100 + 2000 + 100);
        expect(mirrorStartLevel).toBe(3);
    });

    test('an unmirrorable climb saves nothing', () => {
        const flat = Array.from({ length: 20 }, (_, i) => i + 1);
        const column = mirrorCostColumn(flat, 1000, 1000);
        expect(column.mirrorStartLevel).toBeNull();
        expect(column.totalSavings).toBe(0);
    });
});
