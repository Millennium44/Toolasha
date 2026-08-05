import { describe, test, expect } from 'vitest';
import { healthDeltas, createCombatLog } from './combat-events.js';

const units = (health) =>
    Object.fromEntries(Object.entries(health).map(([id, currentHitpoints]) => [id, { currentHitpoints }]));

describe('healthDeltas', () => {
    test('health lost is damage', () => {
        const previous = new Map();
        healthDeltas(units({ rat: 1000 }), previous);

        expect(healthDeltas(units({ rat: 588 }), previous)).toEqual([
            { id: 'rat', side: 'enemy', amount: 412, kind: 'damage' },
        ]);
    });

    test('health gained is a heal, not damage of the other sign', () => {
        // Otherwise a healer's output cancels the party's
        const previous = new Map();
        healthDeltas(units({ bob: 500 }), previous, 'ally');

        expect(healthDeltas(units({ bob: 800 }), previous, 'ally')).toEqual([
            { id: 'bob', side: 'ally', amount: 300, kind: 'heal' },
        ]);
    });

    test('a unit seen for the first time has not been hit for its whole bar', () => {
        // The single most visible way to get this wrong
        expect(healthDeltas(units({ rat: 1000 }), new Map())).toEqual([]);
    });

    test('a unit that has gone does not take its remaining health as damage', () => {
        // It died, or the wave ended, and the state cannot tell those apart
        const previous = new Map();
        healthDeltas(units({ rat: 1000 }), previous);

        expect(healthDeltas(units({}), previous)).toEqual([]);
        expect(previous.has('rat')).toBe(false);
    });

    test('a unit that has not changed produces nothing', () => {
        const previous = new Map();
        healthDeltas(units({ rat: 1000 }), previous);
        expect(healthDeltas(units({ rat: 1000 }), previous)).toEqual([]);
    });

    test('several units in one tick each get their own event', () => {
        const previous = new Map();
        healthDeltas(units({ a: 100, b: 100 }), previous);

        const events = healthDeltas(units({ a: 90, b: 50 }), previous);
        expect(events.map((event) => event.amount).sort((x, y) => x - y)).toEqual([10, 50]);
    });

    test('unreadable health is skipped rather than counted as zero', () => {
        const previous = new Map();
        expect(healthDeltas({ ghost: {} }, previous)).toEqual([]);
        expect(previous.has('ghost')).toBe(false);
    });

    test('nothing at all is nothing, not a crash', () => {
        expect(healthDeltas(null, new Map())).toEqual([]);
    });
});

describe('createCombatLog', () => {
    const event = (amount) => ({ id: 'rat', side: 'enemy', amount, kind: 'damage' });

    test('newest first, stamped with when', () => {
        const log = createCombatLog();
        log.add([event(1)], 100);
        log.add([event(2)], 200);

        expect(log.entries().map((entry) => entry.amount)).toEqual([2, 1]);
        expect(log.entries()[0].at).toBe(200);
    });

    test('it is bounded, since a fight runs all night', () => {
        // An unbounded list of these is a memory leak with a scrollbar
        const log = createCombatLog(3);
        for (let index = 0; index < 50; index++) log.add([event(index)], index);

        expect(log.entries()).toHaveLength(3);
        expect(log.entries()[0].amount).toBe(49);
    });

    test('nothing to add changes nothing', () => {
        const log = createCombatLog();
        log.add([], 1);
        log.add(null, 2);
        expect(log.entries()).toEqual([]);
    });

    test('clearing empties it', () => {
        const log = createCombatLog();
        log.add([event(1)], 1);
        log.clear();
        expect(log.entries()).toEqual([]);
    });
});
