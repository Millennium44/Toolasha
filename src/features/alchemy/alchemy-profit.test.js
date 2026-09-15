/** @vitest-environment happy-dom */

/**
 * Tests for the alchemy panel reader.
 *
 * alchemy-profit.js reads the alchemy panel; it does not calculate. What is
 * pinned here is the arithmetic it still owns — the locale-aware count/rate
 * parsing — and the action-hrid lookup the display and the tea recommendation
 * both call.
 *
 * Expected values are hand-computed in comments so the fixture is auditable.
 *
 * Not covered (pure DOM scraping, no arithmetic): extractRequirements,
 * extractDrops, extractItemData, getStateFingerprint.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    initClientData: null,
    currentActions: [],
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.initClientData,
        getCurrentActions: () => game.currentActions,
        getItemDetails: (hrid) => game.initClientData?.itemDetailMap?.[hrid] || null,
    },
}));

const alchemyProfitModule = await import('./alchemy-profit.js');
const alchemyProfit = alchemyProfitModule.default;
const { parseRequirementCount, parseDropCountAndRate } = alchemyProfitModule;
const { _resetGameNumberSeparators } = await import('../../utils/number-parser.js');

beforeEach(() => {
    game.initClientData = null;
    game.currentActions = [];
});

afterEach(() => {
    document.body.innerHTML = '';
});

describe('getCurrentActionHrid', () => {
    test('picks the running alchemy action by execution order, not the first in the array', () => {
        // A repeating alchemy action requeued to the front of the array with
        // the highest ordinal, ahead of the one actually running: the old
        // first-match loop priced the queued one
        game.currentActions = [
            { actionHrid: '/actions/alchemy/transmute', isDone: false, ordinal: 8589934588 },
            { actionHrid: '/actions/milking/cow', isDone: false, ordinal: 1 },
            { actionHrid: '/actions/alchemy/coinify', isDone: false, ordinal: 0 },
        ];
        expect(alchemyProfit.getCurrentActionHrid()).toBe('/actions/alchemy/coinify');
    });

    test('picks the alchemy action out of the queue', () => {
        // The milking action already finished; alchemy is what is running now.
        // Realistic queue entries always carry isDone/ordinal — a fixture missing
        // both ties every entry at ordinal 0 and hides which one is truly running.
        game.currentActions = [
            { actionHrid: '/actions/milking/cow', isDone: true, ordinal: 0 },
            { actionHrid: '/actions/alchemy/coinify', isDone: false, ordinal: 1 },
        ];

        expect(alchemyProfit.getCurrentActionHrid()).toBe('/actions/alchemy/coinify');
    });

    test('returns null when nothing is queued or nothing is alchemy', () => {
        game.currentActions = [];
        expect(alchemyProfit.getCurrentActionHrid()).toBeNull();

        game.currentActions = [{ actionHrid: '/actions/milking/cow' }];
        expect(alchemyProfit.getCurrentActionHrid()).toBeNull();
    });
});

describe('parseRequirementCount / parseDropCountAndRate — locale-grouped DOM text', () => {
    const asLocale = (value) => {
        localStorage.setItem('i18nextLng', value);
        _resetGameNumberSeparators();
    };

    afterEach(() => {
        localStorage.removeItem('i18nextLng');
        _resetGameNumberSeparators();
    });

    describe('en-US', () => {
        beforeEach(() => asLocale('en-US'));

        test('parseRequirementCount reads comma grouping', () => {
            expect(parseRequirementCount('/ 1,450')).toBe(1450);
        });

        test('parseDropCountAndRate reads comma and period', () => {
            expect(parseDropCountAndRate('1,200 Item ~7.29%', null)).toEqual({ count: 1200, dropRate: 0.0729 });
        });

        test('parseDropCountAndRate prefers game data over the DOM rate', () => {
            expect(parseDropCountAndRate('12 Item 7.29%', 0.5)).toEqual({ count: 12, dropRate: 0.5 });
        });
    });

    describe('de-DE (period grouping) — the bug this replaces', () => {
        beforeEach(() => asLocale('de-DE'));

        test('parseRequirementCount reads period grouping instead of stopping at the first group', () => {
            // A hardcoded `[\d,]+` reads "/ 1.450" as "/ 1": the period isn't in
            // the class, so the match stops at the first group boundary.
            expect(parseRequirementCount('/ 1.450')).toBe(1450);
        });

        test('parseDropCountAndRate reads a period-grouped count and a comma decimal rate', () => {
            expect(parseDropCountAndRate('1.200 Item ~7,29%', null)).toEqual({ count: 1200, dropRate: 0.0729 });
        });
    });
});
