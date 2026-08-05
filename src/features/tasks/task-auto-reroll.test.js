/**
 * Tests for the Task Auto-Reroll Reminder's decision rule.
 *
 * The badge used to mean nothing more than "this hrid is on a list". The rule
 * covered here is what makes it a decision: a task is only worth rerolling when
 * it trails the board by more than the reroll costs, priced over the hours the
 * task would otherwise occupy. Getting that comparison wrong in either
 * direction costs real coins — badging good tasks, or staying quiet on bad ones.
 */

import { describe, test, expect, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => false, getSettingValue: (_k, d) => d } }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/storage.js', () => ({ default: { getJSON: async () => [], setJSON: async () => {} } }));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../core/data-manager.js', () => ({ default: { getCurrentCharacterId: () => 'test' } }));
vi.mock('./task-profit-calculator.js', () => ({ calculateTaskTokenValue: () => ({ tokenValue: 2000 }) }));
vi.mock('./task-profit-display.js', () => ({ readVisibleTaskRatings: () => ({}) }));

const { nextRerollCostInRatingUnits, ratesBelowBoard } = await import('./task-auto-reroll.js');

describe('nextRerollCostInRatingUnits', () => {
    test('doubles with each coin reroll already spent, up to the cap', () => {
        expect(nextRerollCostInRatingUnits(0, 'gold', null)).toBe(10000);
        expect(nextRerollCostInRatingUnits(3, 'gold', null)).toBe(80000);
        expect(nextRerollCostInRatingUnits(5, 'gold', null)).toBe(320000);
        expect(nextRerollCostInRatingUnits(12, 'gold', null)).toBe(320000);
    });

    test('restates the cost in tokens when the board is rated in tokens', () => {
        expect(nextRerollCostInRatingUnits(0, 'tokens', 2000)).toBe(5);
    });

    test('gives up rather than guess when a token has no price', () => {
        expect(nextRerollCostInRatingUnits(0, 'tokens', 0)).toBe(null);
        expect(nextRerollCostInRatingUnits(0, 'tokens', null)).toBe(null);
    });
});

describe('ratesBelowBoard', () => {
    // A 2-hour task on a board whose median is 100K/hr: a 10K reroll spread
    // over those hours is 5K/hr, so the task has to trail 95K/hr to be worth it
    const twoHourTask = (value) => ({ value, hours: 2 });

    test('badges a task that trails the board by more than the reroll costs', () => {
        expect(ratesBelowBoard(twoHourTask(90000), 100000, 10000)).toBe(true);
    });

    test('leaves a task alone when the reroll costs more than the gap', () => {
        expect(ratesBelowBoard(twoHourTask(96000), 100000, 10000)).toBe(false);
    });

    test('leaves the board median itself alone', () => {
        expect(ratesBelowBoard(twoHourTask(100000), 100000, 10000)).toBe(false);
    });

    test('a dearer reroll makes the rule stricter', () => {
        // Same task, but this card has been rerolled up to 320K already
        expect(ratesBelowBoard(twoHourTask(90000), 100000, 320000)).toBe(false);
    });

    test('stays quiet without a board, a rating time, or a priced reroll', () => {
        expect(ratesBelowBoard(twoHourTask(1), null, 10000)).toBe(false);
        expect(ratesBelowBoard({ value: 1, hours: null }, 100000, 10000)).toBe(false);
        expect(ratesBelowBoard(undefined, 100000, 10000)).toBe(false);
        expect(ratesBelowBoard(twoHourTask(1), 100000, null)).toBe(false);
    });

    test('a short task is judged more harshly — the reroll amortises over less time', () => {
        const gap = { value: 90000, hours: 0.1 };
        // 10K spread over 6 minutes is 100K/hr, far more than the 10K/hr gap
        expect(ratesBelowBoard(gap, 100000, 10000)).toBe(false);
    });
});
