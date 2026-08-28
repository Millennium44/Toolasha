/**
 * The count and value badges on a custom-tab header say a number but not what
 * it is measuring — these tooltips are the two sentences that fill that gap.
 * Tested on their own because the header they decorate is built inside
 * `_injectSectionHeader`, which is deep in `custom-tabs-ui.js`'s DOM-rebuild
 * machinery with no harness of its own.
 */
import { describe, test, expect, vi } from 'vitest';

// These two helpers are pure string formatting; the rest of the module's
// heavy singleton imports are stubbed just enough for it to load, same as
// custom-tabs-unorganized.test.js does for the same reason.
vi.mock('../../../core/config.js', () => ({ default: {} }));
vi.mock('../../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../../core/data-manager.js', () => ({ default: { getInitClientData: () => ({}) } }));
vi.mock('../inventory-sort.js', () => ({ default: {} }));
vi.mock('../inventory-badge-manager.js', () => ({ default: {} }));
vi.mock('../../combat/loadout-snapshot.js', () => ({ default: {} }));
vi.mock('../../../utils/bundle-bridge.js', () => ({ loadoutSnapshot: () => null }));

const { tabItemCountTooltip, tabValueTooltip } = await import('./custom-tabs-ui.js');

describe('tabItemCountTooltip', () => {
    test('states what the count is: configured, not currently visible', () => {
        expect(tabItemCountTooltip(3)).toBe('3 items assigned to this tab');
    });

    test('one item reads as singular', () => {
        expect(tabItemCountTooltip(1)).toBe('1 item assigned to this tab');
    });
});

describe('tabValueTooltip', () => {
    test('names the price side taken from the dataset key', () => {
        expect(tabValueTooltip('askValue', 5)).toBe(
            "Total ask value of the 5 items shown in this tab, from Toolasha's inventory badges."
        );
        expect(tabValueTooltip('bidValue', 5)).toContain('Total bid value');
    });

    test('a badges-on-none mode reads the same way its dataset key is named', () => {
        expect(tabValueTooltip('vendorValue', 2)).toContain('Total vendor value');
    });

    test('one tile reads as singular', () => {
        expect(tabValueTooltip('askValue', 1)).toContain('the 1 item shown');
    });
});
