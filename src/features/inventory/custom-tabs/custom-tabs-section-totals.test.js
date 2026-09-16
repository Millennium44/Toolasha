/**
 * @vitest-environment happy-dom
 *
 * Custom-tab section totals used to consult `inv_valueBadges` the same way the
 * per-item stack badge does: with the mode set to 'off' or 'prices',
 * `stackBadgeValueKey` returns null, and the header injection code guarded the
 * whole total behind `if (valueKey) { ... }` — so the section total simply
 * never appeared in those two modes. That guard is gone; both the expanded
 * section sum and the collapsed rollup (`_peekTileValue`) now key off
 * `totalValueKey`, which always resolves to a usable dataset key ('askValue'
 * unless a live Ask/Bid sort or 'alwaysBid' says otherwise), matching how
 * inventory category totals have always behaved.
 *
 * `_peekTileValue` is exercised directly (same pattern as
 * custom-tabs-unorganized.test.js): it is pure DOM/Map math with no
 * dependency on the rest of the class, and it is the same sum-over-tiles the
 * expanded-section path inlines, so covering it here proves the mechanism
 * both call sites share.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const settings = vi.hoisted(() => ({}));

vi.mock('../../../core/config.js', () => ({
    default: {
        getSettingValue: (key, fallback = null) => settings[key] ?? fallback,
    },
}));
vi.mock('../../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../../core/data-manager.js', () => ({ default: { getInitClientData: () => ({}) } }));
vi.mock('../inventory-sort.js', () => ({ default: {} }));
vi.mock('../inventory-badge-manager.js', () => ({ default: {} }));
vi.mock('../../combat/loadout-snapshot.js', () => ({ default: {} }));
vi.mock('../../../utils/bundle-bridge.js', () => ({ loadoutSnapshot: () => null }));

const { default: CustomTabsUI } = await import('./custom-tabs-ui.js');
const { totalValueKey, stackBadgeValueKey } = await import('../inventory-badge-mode.js');

beforeEach(() => {
    for (const key of Object.keys(settings)) delete settings[key];
});

/** A tile priced on both sides, registered under its own hrid */
function tile(askValue, bidValue) {
    const el = document.createElement('div');
    el.dataset.askValue = String(askValue);
    el.dataset.bidValue = String(bidValue);
    return el;
}

/** Sum a tab's tiles via the real prototype method, keyed by the current mode/sort */
function rollup(tileMap, tab, sortMode) {
    const valueKey = totalValueKey(sortMode);
    return CustomTabsUI.prototype._peekTileValue.call({}, tab, tileMap, valueKey);
}

describe('collapsed section rollup across every badge mode and sort', () => {
    const tab = { id: 'loots', items: ['/items/cheese'], children: [] };

    function tileMap() {
        return new Map([['/items/cheese', [tile(1000, 900)]]]);
    }

    // [mode, sortMode, expectedTotal] — 1000 = ask side, 900 = bid side
    const table = [
        ['off', 'none', 1000],
        ['off', 'ask', 1000],
        ['off', 'bid', 900],
        ['sorting', 'none', 1000],
        ['sorting', 'ask', 1000],
        ['sorting', 'bid', 900],
        ['alwaysAsk', 'none', 1000],
        ['alwaysAsk', 'ask', 1000],
        ['alwaysAsk', 'bid', 900],
        ['alwaysBid', 'none', 900],
        ['alwaysBid', 'ask', 1000],
        ['alwaysBid', 'bid', 900],
        ['prices', 'none', 1000],
        ['prices', 'ask', 1000],
        ['prices', 'bid', 900],
    ];

    test.each(table)('mode=%s, sort=%s -> total %i', (mode, sortMode, expected) => {
        settings.inv_valueBadges = mode;
        expect(rollup(tileMap(), tab, sortMode)).toBe(expected);
    });

    test('off and prices modes now produce a total (the bug: they used to produce none)', () => {
        for (const mode of ['off', 'prices']) {
            settings.inv_valueBadges = mode;
            // Pre-fix, `_injectAccordionHeaders` called `stackBadgeValueKey` directly and
            // skipped the whole total under `if (valueKey) {...}` — null in these two modes,
            // so no badge was ever appended. Documenting that guard here:
            expect(stackBadgeValueKey('none')).toBeNull(); // the old code stopped right here

            // Post-fix: the rollup still resolves a real total, on the ask side.
            expect(rollup(tileMap(), tab, 'none')).toBe(1000);
        }
    });
});
