// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
/**
 * Fury stacks, and the one event that expires them.
 *
 * Fury changes on nearly every swing, which is what made it the slowest damage
 * type to simulate: each change rewrote the event queue and rebuilt every combat
 * stat from the equipment up. The rewrite keeps a single expiry event alive and
 * lets it re-arm itself when the timer moves, so the tests here are about the
 * thing that can go wrong with that — stacks that never expire, or expire early.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import CombatSimulator from './combat-simulator.js';
import EventQueue from './events/event-queue.js';
import FuryExpirationEvent from './events/fury-expiration-event.js';

const FURY_EXPIRE = 15_000_000_000;

/** Just enough simulator to drive the fury paths, with no game data behind it */
function harness() {
    const sim = Object.create(CombatSimulator.prototype);
    sim.eventQueue = new EventQueue();
    sim.simulationTime = 0;

    const source = {
        furyAmount: 0,
        furyExpireTime: 0,
        furyExpirationEvent: null,
        combatDetails: { combatStats: { fury: 0.05 } },
        updateFuryBuffs: vi.fn(),
    };
    return { sim, source };
}

const queued = (sim) => sim.eventQueue.minHeap.data.filter((event) => event.type === FuryExpirationEvent.type);

describe('building stacks', () => {
    let sim, source;
    beforeEach(() => {
        ({ sim, source } = harness());
    });

    test('a hit adds one and arms the timer', () => {
        sim._processFuryUpdate(source, true);

        expect(source.furyAmount).toBe(1);
        expect(source.furyExpireTime).toBe(FURY_EXPIRE);
        expect(queued(sim)).toHaveLength(1);
    });

    test('further hits do not pile up events', () => {
        // One per swing was the old behaviour, each one preceded by a scan of
        // the queue and a throwaway array
        for (let i = 0; i < 5; i++) {
            sim.simulationTime = i * 1e9;
            sim._processFuryUpdate(source, true);
        }

        expect(source.furyAmount).toBe(5);
        expect(queued(sim)).toHaveLength(1);
    });

    test('and stacks cap at five', () => {
        for (let i = 0; i < 9; i++) sim._processFuryUpdate(source, true);

        expect(source.furyAmount).toBe(5);
    });

    test('a miss halves them', () => {
        for (let i = 0; i < 5; i++) sim._processFuryUpdate(source, true);

        sim._processFuryUpdate(source, false);

        expect(source.furyAmount).toBe(2);
    });

    test('and losing the last one clears the timer', () => {
        sim._processFuryUpdate(source, true);

        sim._processFuryUpdate(source, false);

        expect(source.furyAmount).toBe(0);
        expect(source.furyExpireTime).toBe(0);
    });

    test('the stats are rebuilt only when the count actually moves', () => {
        // At the cap every further hit changes nothing, and a rebuild is the
        // most expensive thing in the loop
        for (let i = 0; i < 5; i++) sim._processFuryUpdate(source, true);
        source.updateFuryBuffs.mockClear();

        sim._processFuryUpdate(source, true);

        expect(source.updateFuryBuffs).not.toHaveBeenCalled();
    });
});

describe('when the timer runs out', () => {
    let sim, source;
    beforeEach(() => {
        ({ sim, source } = harness());
    });

    test('stacks go, and so does the buff', () => {
        sim._processFuryUpdate(source, true);
        const [expiry] = queued(sim);

        sim.simulationTime = FURY_EXPIRE;
        sim.eventQueue.getNextEvent();
        sim.processFuryExpirationEvent(expiry);

        expect(source.furyAmount).toBe(0);
        expect(source.updateFuryBuffs).toHaveBeenLastCalledWith(0, 0, 0, 0);
    });

    test('but an event whose timer was refreshed re-arms instead', () => {
        // Every landed hit pushes the expiry back. The queued event fires at the
        // old time, and expiring stacks there would cut fury short by however
        // long the streak ran
        sim._processFuryUpdate(source, true);
        const [expiry] = queued(sim);

        sim.simulationTime = 10e9;
        sim._processFuryUpdate(source, true);

        sim.simulationTime = FURY_EXPIRE;
        sim.eventQueue.getNextEvent();
        sim.processFuryExpirationEvent(expiry);

        expect(source.furyAmount).toBe(2);
        const rearmed = queued(sim);
        expect(rearmed).toHaveLength(1);
        expect(rearmed[0].time).toBe(10e9 + FURY_EXPIRE);
    });

    test('and the re-armed one expires when its own time comes', () => {
        sim._processFuryUpdate(source, true);
        const [first] = queued(sim);
        sim.simulationTime = 10e9;
        sim._processFuryUpdate(source, true);
        sim.simulationTime = FURY_EXPIRE;
        sim.eventQueue.getNextEvent();
        sim.processFuryExpirationEvent(first);

        const [second] = queued(sim);
        sim.simulationTime = 10e9 + FURY_EXPIRE;
        sim.eventQueue.getNextEvent();
        sim.processFuryExpirationEvent(second);

        expect(source.furyAmount).toBe(0);
        expect(queued(sim)).toHaveLength(0);
    });
});

describe('when the fight ends underneath it', () => {
    test('a cleared queue does not leave fury unable to expire again', () => {
        // The event is gone but the unit still points at it. Left unnoticed,
        // the next streak would queue nothing and fury would never run out
        const { sim, source } = harness();
        sim._processFuryUpdate(source, true);
        sim.eventQueue.clearEventsForUnit(source);
        expect(queued(sim)).toHaveLength(0);

        sim.simulationTime = 40e9;
        sim._processFuryUpdate(source, true);

        expect(queued(sim)).toHaveLength(1);
        expect(queued(sim)[0].time).toBe(40e9 + FURY_EXPIRE);
    });
});
