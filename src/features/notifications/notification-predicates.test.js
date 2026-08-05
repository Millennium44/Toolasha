/**
 * Tests for the "has something actually happened" half of each notification.
 *
 * These are the rules that decide whether the player is interrupted, so the
 * cases worth pinning down are the ones that would produce a *wrong*
 * interruption: a count that went down because you collected it, a supply that
 * has been low for hours and is not news any more, a queue that never ends.
 */

import { describe, test, expect } from 'vitest';
import {
    listingsNewlyFinished,
    thresholdCrossing,
    isQueueExhausted,
    newlyIdleCharacters,
    labyrinthRunState,
    newDeaths,
} from './notification-predicates.js';

describe('labyrinthRunState', () => {
    test('the server’s own flag is believed either way', () => {
        expect(labyrinthRunState({ isActive: true })).toBe('active');
        expect(labyrinthRunState({ isActive: false })).toBe('ended');
    });

    test('the flag wins over the grid, so an ended run with a stale grid still reads ended', () => {
        expect(labyrinthRunState({ isActive: false, roomData: [[{}]], pathData: '[{"x":0,"y":0}]' })).toBe('ended');
    });

    test('without the flag, a grid or a queued path is what says a run is going', () => {
        expect(labyrinthRunState({ roomData: [[{}]] })).toBe('active');
        expect(labyrinthRunState({ pathData: '[{"x":0,"y":0}]' })).toBe('active');
        expect(labyrinthRunState({ roomData: '[[{}]]' })).toBe('active');
        expect(labyrinthRunState({ pathData: [{ x: 0, y: 0 }] })).toBe('active');
    });

    test('a payload that describes neither is unknown, never ended', () => {
        expect(labyrinthRunState({ currentFloor: 4 })).toBe('unknown');
        expect(labyrinthRunState({ roomData: [], pathData: '[]' })).toBe('unknown');
        expect(labyrinthRunState(null)).toBe('unknown');
        expect(labyrinthRunState(undefined)).toBe('unknown');
        expect(labyrinthRunState('nope')).toBe('unknown');
    });
});

describe('newDeaths', () => {
    test('a rise is the number of new deaths', () => {
        expect(newDeaths(0, 1)).toBe(1);
        expect(newDeaths(2, 5)).toBe(3);
    });

    test('the same count is nothing new', () => {
        expect(newDeaths(3, 3)).toBe(0);
    });

    test('a new session takes the count down, which is not a resurrection', () => {
        expect(newDeaths(7, 0)).toBe(0);
    });

    test('the first sighting is a baseline, not a death', () => {
        expect(newDeaths(null, 4)).toBe(0);
        expect(newDeaths(undefined, 4)).toBe(0);
    });

    test('an unreadable count on either side reports nothing', () => {
        expect(newDeaths(1, 'two')).toBe(0);
        expect(newDeaths('one', 2)).toBe(0);
        expect(newDeaths(1, undefined)).toBe(0);
    });
});

describe('listingsNewlyFinished', () => {
    test('a rise is news', () => {
        expect(listingsNewlyFinished(1, 2)).toBe(true);
        expect(listingsNewlyFinished(0, 1)).toBe(true);
    });

    test('the same count is not', () => {
        expect(listingsNewlyFinished(2, 2)).toBe(false);
    });

    test('collecting takes the count down and says nothing', () => {
        expect(listingsNewlyFinished(3, 0)).toBe(false);
    });

    test('the first observation of a session is never a change', () => {
        // Otherwise every page refresh announces a backlog that was already there
        expect(listingsNewlyFinished(null, 4)).toBe(false);
        expect(listingsNewlyFinished(undefined, 4)).toBe(false);
    });
});

describe('thresholdCrossing', () => {
    const threshold = 24 * 3600;

    test('fires on the way down, once', () => {
        const first = thresholdCrossing({ armed: true, secondsLeft: 3600, thresholdSeconds: threshold });
        expect(first).toEqual({ fire: true, armed: false });

        const second = thresholdCrossing({ armed: first.armed, secondsLeft: 1800, thresholdSeconds: threshold });
        expect(second.fire).toBe(false);
    });

    test('a healthy supply is silent and stays armed', () => {
        expect(thresholdCrossing({ armed: true, secondsLeft: 48 * 3600, thresholdSeconds: threshold })).toEqual({
            fire: false,
            armed: true,
        });
    });

    test('restocking above the threshold re-arms it', () => {
        const low = thresholdCrossing({ armed: true, secondsLeft: 60, thresholdSeconds: threshold });
        expect(low.fire).toBe(true);

        const restocked = thresholdCrossing({
            armed: low.armed,
            secondsLeft: 96 * 3600,
            thresholdSeconds: threshold,
        });
        expect(restocked.armed).toBe(true);

        // ...and the next time it runs down it is news again
        expect(thresholdCrossing({ armed: restocked.armed, secondsLeft: 60, thresholdSeconds: threshold })).toEqual({
            fire: true,
            armed: false,
        });
    });

    test('a missing reading changes nothing either way', () => {
        expect(thresholdCrossing({ armed: true, secondsLeft: Infinity, thresholdSeconds: threshold })).toEqual({
            fire: false,
            armed: true,
        });
        expect(thresholdCrossing({ armed: false, secondsLeft: NaN, thresholdSeconds: threshold })).toEqual({
            fire: false,
            armed: false,
        });
    });

    test('no threshold configured means no crossing', () => {
        expect(thresholdCrossing({ armed: true, secondsLeft: 1, thresholdSeconds: 0 }).fire).toBe(false);
    });
});

describe('isQueueExhausted', () => {
    const now = 1_000_000_000;
    const snapshot = (overrides) => ({
        characterId: 'alt',
        characterName: 'Alt',
        timestamp: now - 3600_000,
        actions: [{ actionName: 'Chopping' }],
        totalQueueSeconds: 1800,
        hasInfiniteAction: false,
        ...overrides,
    });

    test('projects from the snapshot: an hour has passed on half an hour of work', () => {
        expect(isQueueExhausted(snapshot(), now)).toBe(true);
    });

    test('still working when less time has passed than was queued', () => {
        expect(isQueueExhausted(snapshot({ totalQueueSeconds: 7200 }), now)).toBe(false);
    });

    test('an unbounded action never runs out', () => {
        expect(isQueueExhausted(snapshot({ hasInfiniteAction: true, totalQueueSeconds: 0 }), now)).toBe(false);
    });

    test('a snapshot with nothing queued was already idle', () => {
        expect(isQueueExhausted(snapshot({ actions: [], totalQueueSeconds: 0 }), now)).toBe(true);
    });

    test('nothing to project from', () => {
        expect(isQueueExhausted(null, now)).toBe(false);
        expect(isQueueExhausted(snapshot({ timestamp: 0 }), now)).toBe(false);
    });
});

describe('newlyIdleCharacters', () => {
    const now = 1_000_000_000;
    const queued = [{ actionName: 'Chopping' }];
    const done = {
        characterId: 'a',
        characterName: 'Alt',
        timestamp: now - 7200_000,
        totalQueueSeconds: 60,
        actions: queued,
    };
    const busy = {
        characterId: 'b',
        characterName: 'Bee',
        timestamp: now - 60_000,
        totalQueueSeconds: 99999,
        actions: queued,
    };

    test('reports only the ones that have run out', () => {
        expect(newlyIdleCharacters([done, busy], now, new Map()).map((c) => c.characterId)).toEqual(['a']);
    });

    test('an already-announced character stays quiet', () => {
        const announced = new Map([['a', done.timestamp]]);
        expect(newlyIdleCharacters([done, busy], now, announced)).toEqual([]);
    });

    test('a fresh snapshot for the same character can be announced again', () => {
        // A newer timestamp means you switched away from it again since
        const announced = new Map([['a', done.timestamp - 1]]);
        expect(newlyIdleCharacters([done], now, announced).map((c) => c.characterId)).toEqual(['a']);
    });

    test('a nameless character still gets said out loud', () => {
        const [reported] = newlyIdleCharacters([{ ...done, characterName: '' }], now, new Map());
        expect(reported.characterName).toBe('A character');
    });
});
