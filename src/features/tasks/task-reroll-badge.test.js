/**
 * The reroll spend badge's arithmetic.
 *
 * The one thing worth getting wrong here is scope: the live map keeps a
 * just-retired task for a grace window (see `task-reroll-tracker.js`), and a
 * sum that did not filter by the active id set would count it twice — once on
 * its own card before it left, and again in the badge after.
 */

import { describe, test, expect } from 'vitest';
import { sumBoardRerollSpend, formatRerollSpendBadge } from './task-reroll-badge.js';

describe('sumBoardRerollSpend', () => {
    test('sums gold and cowbells across the active tasks only', () => {
        const taskRerollData = new Map([
            [1, { coinRerollCount: 2, cowbellRerollCount: 0 }], // 10K + 20K = 30K
            [2, { coinRerollCount: 0, cowbellRerollCount: 2 }], // 1 + 2 = 3
            [3, { coinRerollCount: 5, cowbellRerollCount: 5 }], // retired, not counted
        ]);
        const activeIds = new Set([1, 2]);

        expect(sumBoardRerollSpend(taskRerollData, activeIds)).toEqual({ gold: 30000, cowbells: 3 });
    });

    test('a task with no reroll data yet contributes nothing', () => {
        const taskRerollData = new Map([[1, { coinRerollCount: 0, cowbellRerollCount: 0 }]]);
        expect(sumBoardRerollSpend(taskRerollData, new Set([1]))).toEqual({ gold: 0, cowbells: 0 });
    });

    test('an empty board is zero, not a throw', () => {
        expect(sumBoardRerollSpend(new Map(), new Set())).toEqual({ gold: 0, cowbells: 0 });
        expect(sumBoardRerollSpend(null, null)).toEqual({ gold: 0, cowbells: 0 });
    });
});

describe('formatRerollSpendBadge', () => {
    test('nothing spent draws nothing', () => {
        expect(formatRerollSpendBadge({ gold: 0, cowbells: 0 })).toBe('');
    });

    test('gold only', () => {
        expect(formatRerollSpendBadge({ gold: 30000, cowbells: 0 })).toBe('Rerolls: 30.0K\u{1f4b0}');
    });

    test('cowbells only', () => {
        expect(formatRerollSpendBadge({ gold: 0, cowbells: 3 })).toBe('Rerolls: 3\u{1f514}');
    });

    test('both currencies, cowbells first', () => {
        expect(formatRerollSpendBadge({ gold: 30000, cowbells: 3 })).toBe('Rerolls: 3\u{1f514} + 30.0K\u{1f4b0}');
    });
});
