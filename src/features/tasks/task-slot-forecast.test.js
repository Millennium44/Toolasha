/**
 * When the task board runs out of room.
 *
 * The arithmetic behind the "your task slots are filling up" alert, and behind
 * the Task Statistics panel's overflow row. Two instants a cadence apart, and
 * the difference between them is the whole of what the alert is for: the board
 * being *full* is the deadline for clearing something, and the first task being
 * *wasted* is one cooldown after that — a warning timed off the second one
 * arrives after the loss it was supposed to prevent.
 */

import { describe, test, expect } from 'vitest';

import { countActiveTasks, forecastTaskSlots } from './task-slot-forecast.js';

const HOUR = 3_600_000;

/** A fixed clock, so every expectation below is exact rather than approximate */
const NOW = Date.parse('2026-08-05T12:00:00.000Z');

/**
 * The character info the server sends, with the four fields that matter.
 * @param {Object} [overrides] - Fields to change
 * @returns {Object} A `characterInfo`
 */
function characterInfo(overrides = {}) {
    return {
        taskSlotCap: 6,
        taskCooldownHours: 3,
        lastTaskTimestamp: '2026-08-05T11:00:00.000Z',
        unreadTaskCount: 0,
        ...overrides,
    };
}

/** A task on the board */
const boardTask = { category: '/quest_category/random_task', status: '/quest_status/in_progress' };

describe('counting what is on the board', () => {
    test('in-progress random tasks are the board', () => {
        expect(countActiveTasks([boardTask, boardTask, boardTask])).toBe(3);
    });

    test('a claimed task has left the board, and so has another quest category', () => {
        expect(
            countActiveTasks([
                boardTask,
                { category: '/quest_category/random_task', status: '/quest_status/claimed' },
                { category: '/quest_category/daily', status: '/quest_status/in_progress' },
            ])
        ).toBe(1);
    });

    test('no quest list at all is no tasks, not a crash', () => {
        expect(countActiveTasks(null)).toBe(0);
        expect(countActiveTasks(undefined)).toBe(0);
        expect(countActiveTasks('nonsense')).toBe(0);
    });
});

describe('when the board fills', () => {
    test('the last free slot takes a task one cadence per free slot from the last one', () => {
        // Four free slots, three hours apart, and the last task arrived an hour
        // ago: the fourth of them lands eleven hours from now
        const forecast = forecastTaskSlots({
            characterInfo: characterInfo(),
            activeTaskCount: 2,
            now: NOW,
        });

        expect(forecast.ok).toBe(true);
        expect(forecast.freeSlots).toBe(4);
        expect(forecast.usedSlots).toBe(2);
        expect(forecast.msUntilFull).toBe(11 * HOUR);
    });

    test('the first wasted task is one cadence after that, and not the same moment', () => {
        // The distinction the alert is built on. Warning at the overflow instant
        // is warning one whole cooldown after the deadline it was meant to catch
        const forecast = forecastTaskSlots({ characterInfo: characterInfo(), activeTaskCount: 2, now: NOW });

        expect(forecast.msUntilWaste).toBe(forecast.msUntilFull + forecast.cooldownMs);
        expect(forecast.msUntilWaste).toBe(14 * HOUR);
    });

    test('unread tasks occupy slots too', () => {
        const forecast = forecastTaskSlots({
            characterInfo: characterInfo({ unreadTaskCount: 3 }),
            activeTaskCount: 2,
            now: NOW,
        });

        expect(forecast.usedSlots).toBe(5);
        expect(forecast.freeSlots).toBe(1);
        expect(forecast.msUntilFull).toBe(2 * HOUR);
    });

    test('a full board fills at the moment the last task arrived, which is behind us', () => {
        const forecast = forecastTaskSlots({
            characterInfo: characterInfo(),
            activeTaskCount: 6,
            now: NOW,
        });

        expect(forecast.isFull).toBe(true);
        expect(forecast.freeSlots).toBe(0);
        expect(forecast.msUntilFull).toBe(-1 * HOUR);
        // The next arrival is the one with nowhere to go
        expect(forecast.msUntilWaste).toBe(2 * HOUR);
    });

    test('a shorter cadence brings the deadline forward', () => {
        // A MooPass or a buff changes the cooldown, and the server re-sends it
        // rather than leaving it to be inferred
        const forecast = forecastTaskSlots({
            characterInfo: characterInfo({ taskCooldownHours: 1.5 }),
            activeTaskCount: 2,
            now: NOW,
        });

        expect(forecast.msUntilFull).toBe(5 * HOUR);
    });

    test('a board reporting more tasks than it holds has no free slots, not negative ones', () => {
        const forecast = forecastTaskSlots({
            characterInfo: characterInfo({ unreadTaskCount: 4 }),
            activeTaskCount: 6,
            now: NOW,
        });

        expect(forecast.usedSlots).toBe(6);
        expect(forecast.freeSlots).toBe(0);
        expect(forecast.isFull).toBe(true);
    });
});

describe('what it refuses to guess', () => {
    test('no character info at all', () => {
        expect(forecastTaskSlots({}).ok).toBe(false);
        expect(forecastTaskSlots().ok).toBe(false);
    });

    test('a missing cadence is not a defaulted cadence', () => {
        // A deadline projected from a guessed cooldown is a deadline that is not
        // the player's, and it would be announced with the same confidence
        for (const missing of [{ taskCooldownHours: undefined }, { taskCooldownHours: 0 }]) {
            const forecast = forecastTaskSlots({ characterInfo: characterInfo(missing), now: NOW });
            expect(forecast.ok).toBe(false);
            expect(forecast.reason).toBe('no task cooldown');
        }
    });

    test('a missing slot cap', () => {
        const forecast = forecastTaskSlots({ characterInfo: characterInfo({ taskSlotCap: undefined }), now: NOW });
        expect(forecast.ok).toBe(false);
        expect(forecast.reason).toBe('no task slot cap');
    });

    test('an unparseable last-task time', () => {
        const forecast = forecastTaskSlots({
            characterInfo: characterInfo({ lastTaskTimestamp: 'never' }),
            now: NOW,
        });
        expect(forecast.ok).toBe(false);
        expect(forecast.reason).toBe('no last task time');
    });
});
