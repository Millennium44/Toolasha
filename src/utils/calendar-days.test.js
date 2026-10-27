/* global process */
import { describe, test, expect, afterEach } from 'vitest';
import { calendarDaysBefore } from './calendar-days.js';

describe('calendarDaysBefore', () => {
    const originalTZ = process.env.TZ;
    afterEach(() => {
        if (originalTZ === undefined) delete process.env.TZ;
        else process.env.TZ = originalTZ;
    });

    test('keeps the wall-clock time across a clock change', () => {
        // 2026-03-08 is the spring-forward day: a week back from the 12th crosses it
        process.env.TZ = 'America/New_York';
        const now = new Date(2026, 2, 12, 15, 30).getTime();
        const back = new Date(calendarDaysBefore(now, 7));
        expect(back.getHours()).toBe(15);
        expect(back.getMinutes()).toBe(30);
        expect(back.getDate()).toBe(5);
    });

    test('keeps the wall-clock time across a fall-back', () => {
        process.env.TZ = 'America/New_York';
        const now = new Date(2026, 10, 5, 9, 0).getTime();
        const back = new Date(calendarDaysBefore(now, 7));
        expect(back.getHours()).toBe(9);
        expect(back.getDate()).toBe(29);
        expect(back.getMonth()).toBe(9);
    });

    test('a window of zero days is now', () => {
        expect(calendarDaysBefore(123456789, 0)).toBe(123456789);
    });
});
