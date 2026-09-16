/**
 * Which badge a tile gets, from the one setting that now decides it.
 *
 * Four settings used to answer this between them, and two of them were the same
 * badge under different sort states — so "do I see a badge right now?" could
 * only be answered by reading three of them and knowing which sort was active.
 * The table below is that question asked once per (mode, sort) pair.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const settings = vi.hoisted(() => ({}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSettingValue: (key, fallback = null) => settings[key] ?? fallback,
    },
}));

const { stackBadgeValueKey, showsItemPriceBadges, badgeMode, totalValueKey } =
    await import('./inventory-badge-mode.js');

beforeEach(() => {
    for (const key of Object.keys(settings)) delete settings[key];
});

describe('stack value badges', () => {
    test('nothing is drawn with the badges off, whatever the sort', () => {
        settings.inv_valueBadges = 'off';
        expect(stackBadgeValueKey('none')).toBeNull();
        expect(stackBadgeValueKey('ask')).toBeNull();
        expect(stackBadgeValueKey('bid')).toBeNull();
    });

    test('"only while sorting" follows the sorted side and goes quiet when unsorted', () => {
        settings.inv_valueBadges = 'sorting';
        expect(stackBadgeValueKey('ask')).toBe('askValue');
        expect(stackBadgeValueKey('bid')).toBe('bidValue');
        expect(stackBadgeValueKey('none')).toBeNull();
    });

    test('"always" keeps drawing when the sort is None, on the side chosen', () => {
        settings.inv_valueBadges = 'alwaysAsk';
        expect(stackBadgeValueKey('none')).toBe('askValue');
        settings.inv_valueBadges = 'alwaysBid';
        expect(stackBadgeValueKey('none')).toBe('bidValue');
    });

    test('a live sort still wins over the chosen side — that side is the one being looked at', () => {
        settings.inv_valueBadges = 'alwaysAsk';
        expect(stackBadgeValueKey('bid')).toBe('bidValue');
        settings.inv_valueBadges = 'alwaysBid';
        expect(stackBadgeValueKey('ask')).toBe('askValue');
    });

    test('the per-item price badges are a different badge, so no stack value goes with them', () => {
        settings.inv_valueBadges = 'prices';
        expect(stackBadgeValueKey('none')).toBeNull();
        expect(stackBadgeValueKey('ask')).toBeNull();
    });
});

describe('per-item price badges', () => {
    test('only the prices mode draws them', () => {
        for (const mode of ['off', 'sorting', 'alwaysAsk', 'alwaysBid']) {
            settings.inv_valueBadges = mode;
            expect(showsItemPriceBadges(), mode).toBe(false);
        }
        settings.inv_valueBadges = 'prices';
        expect(showsItemPriceBadges()).toBe(true);
    });
});

describe('an unset setting', () => {
    test('reads as sorting, which is the schema default', () => {
        expect(badgeMode()).toBe('sorting');
        expect(stackBadgeValueKey('ask')).toBe('askValue');
        expect(showsItemPriceBadges()).toBe(false);
    });
});

describe('totalValueKey — the summary totals (category totals, custom-tab section totals)', () => {
    // Unlike the per-item stack badge, a summary total always shows a number.
    // Five modes x three sort states: the table below is the whole contract.
    const table = [
        // [mode, sortMode, expectedKey]
        ['off', 'none', 'askValue'],
        ['off', 'ask', 'askValue'],
        ['off', 'bid', 'bidValue'],
        ['sorting', 'none', 'askValue'],
        ['sorting', 'ask', 'askValue'],
        ['sorting', 'bid', 'bidValue'],
        ['alwaysAsk', 'none', 'askValue'],
        ['alwaysAsk', 'ask', 'askValue'],
        ['alwaysAsk', 'bid', 'bidValue'],
        ['alwaysBid', 'none', 'bidValue'],
        ['alwaysBid', 'ask', 'askValue'],
        ['alwaysBid', 'bid', 'bidValue'],
        ['prices', 'none', 'askValue'],
        ['prices', 'ask', 'askValue'],
        ['prices', 'bid', 'bidValue'],
    ];

    test.each(table)('mode=%s, sort=%s -> %s', (mode, sortMode, expected) => {
        settings.inv_valueBadges = mode;
        expect(totalValueKey(sortMode)).toBe(expected);
    });

    test('a live sort still wins over alwaysAsk/alwaysBid, same precedence as the item badge', () => {
        settings.inv_valueBadges = 'alwaysAsk';
        expect(totalValueKey('bid')).toBe('bidValue');
        settings.inv_valueBadges = 'alwaysBid';
        expect(totalValueKey('ask')).toBe('askValue');
    });

    test('off and prices never draw a stack badge, but the total still resolves a key (the fix)', () => {
        for (const mode of ['off', 'prices']) {
            settings.inv_valueBadges = mode;
            // The per-item badge is suppressed...
            expect(stackBadgeValueKey('none')).toBeNull();
            // ...but the summary total is not: it always gets a usable dataset key.
            expect(totalValueKey('none')).toBe('askValue');
        }
    });
});
