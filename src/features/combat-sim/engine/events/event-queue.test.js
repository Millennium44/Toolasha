// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
/**
 * Tests for EventQueue heap removal correctness
 */

import { describe, test, expect } from 'vitest';

import EventQueue from './event-queue.js';

function makeEvent(time, type, source = null, target = null) {
    return { time, type, source, target };
}

function drainTimes(queue) {
    const times = [];
    let event;
    while ((event = queue.getNextEvent()) !== undefined) {
        times.push(event.time);
    }
    return times;
}

describe('EventQueue clear* methods', () => {
    test('clearEventsOfType removes all matches even when heap sifts displace events into scanned slots', () => {
        // Push order crafts heap layout [1, 50X, 2, 60X, 51, 3]: removing 60X at index 3 moves the
        // tail element (3) into its slot, and _siftUp swaps it with parent 50X, which lands in the
        // already-visited slot 3 — a backward index scan would skip it and leave 50X in the queue.
        const queue = new EventQueue();
        queue.addEvent(makeEvent(1, 'keep'));
        queue.addEvent(makeEvent(50, 'X'));
        queue.addEvent(makeEvent(2, 'keep'));
        queue.addEvent(makeEvent(60, 'X'));
        queue.addEvent(makeEvent(51, 'keep'));
        queue.addEvent(makeEvent(3, 'keep'));

        queue.clearEventsOfType('X');

        expect(queue.containsEventOfType('X')).toBe(false);
        expect(drainTimes(queue)).toEqual([1, 2, 3, 51]);
    });

    test('clearEventsForUnit removes all events where the unit is source or target', () => {
        const queue = new EventQueue();
        const unitA = { name: 'a' };
        const unitB = { name: 'b' };
        queue.addEvent(makeEvent(1, 'attack', unitA, unitB));
        queue.addEvent(makeEvent(40, 'attack', unitB, unitA));
        queue.addEvent(makeEvent(2, 'tick', unitB, null));
        queue.addEvent(makeEvent(50, 'attack', unitA, null));
        queue.addEvent(makeEvent(41, 'tick', null, unitA));
        queue.addEvent(makeEvent(3, 'tick', null, null));

        queue.clearEventsForUnit(unitA);

        expect(queue.getMatching((e) => e.source === unitA || e.target === unitA)).toBeNull();
        expect(drainTimes(queue)).toEqual([2, 3]);
    });

    test('clearByTypeAndSource reports whether anything was cleared and leaves other events intact', () => {
        const queue = new EventQueue();
        const unit = { name: 'u' };
        queue.addEvent(makeEvent(5, 'attack', unit));
        queue.addEvent(makeEvent(6, 'tick', unit));

        expect(queue.clearByTypeAndSource('attack', unit)).toBe(true);
        expect(queue.clearByTypeAndSource('attack', unit)).toBe(false);
        expect(drainTimes(queue)).toEqual([6]);
    });
});
