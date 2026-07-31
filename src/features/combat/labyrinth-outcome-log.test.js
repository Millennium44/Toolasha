import { describe, test, expect } from 'vitest';
import {
    outcomeKey,
    readCombatRooms,
    foldFloorOutcomes,
    compareToPrediction,
    binomialTailLikelihood,
} from './labyrinth-outcome-log.js';
import { wilsonInterval } from '../combat-sim/engine/wilson.js';

const grid = (rooms) => [rooms];
const combat = (over = {}) => ({
    monsterHrid: '/monsters/mimic',
    recommendedLevel: 252,
    entryCount: 0,
    isCleared: false,
    ...over,
});

describe('readCombatRooms', () => {
    test('picks out the fights and leaves everything else', () => {
        const rooms = readCombatRooms([[combat(), null, { roomType: '/labyrinth_room_types/treasure' }]]);
        expect(rooms).toHaveLength(1);
        expect(rooms[0]).toMatchObject({ coord: '0,0', monsterHrid: '/monsters/mimic', roomLevel: 252 });
    });

    test('survives a grid that is not one', () => {
        expect(readCombatRooms(null)).toEqual([]);
        expect(readCombatRooms([null, undefined])).toEqual([]);
    });
});

describe('foldFloorOutcomes', () => {
    test('the same floor folded twice counts once', () => {
        const rooms = readCombatRooms(grid([combat({ entryCount: 3, isCleared: true })]));
        const first = foldFloorOutcomes({}, {}, rooms);
        const second = foldFloorOutcomes(first.totals, first.seen, rooms);

        const key = outcomeKey('/monsters/mimic', 252);
        expect(first.totals[key]).toMatchObject({ attempts: 3, clears: 1 });
        expect(second.totals[key]).toMatchObject({ attempts: 3, clears: 1 });
        expect(second.changed).toBe(false);
    });

    test('counts attempts as they accrue and the clear once', () => {
        let state = { totals: {}, seen: {} };
        for (const [entries, cleared] of [
            [1, false],
            [2, false],
            [3, true],
            [3, true],
        ]) {
            state = foldFloorOutcomes(
                state.totals,
                state.seen,
                readCombatRooms(grid([combat({ entryCount: entries, isCleared: cleared })]))
            );
        }
        expect(state.totals[outcomeKey('/monsters/mimic', 252)]).toMatchObject({ attempts: 3, clears: 1 });
    });

    test('a room given up on still contributes its attempts', () => {
        // Only counting rooms you finished would quietly drop every fight you
        // walked away from, which is exactly the losing half of the sample
        const state = foldFloorOutcomes({}, {}, readCombatRooms(grid([combat({ entryCount: 6, isCleared: false })])));
        expect(state.totals[outcomeKey('/monsters/mimic', 252)]).toMatchObject({ attempts: 6, clears: 0 });
    });

    test('a new monster on the same square starts over', () => {
        const first = foldFloorOutcomes({}, {}, readCombatRooms(grid([combat({ entryCount: 4, isCleared: true })])));
        const next = foldFloorOutcomes(
            first.totals,
            first.seen,
            readCombatRooms(grid([combat({ monsterHrid: '/monsters/wark', entryCount: 2, isCleared: false })]))
        );
        expect(next.totals[outcomeKey('/monsters/wark', 252)]).toMatchObject({ attempts: 2, clears: 0 });
        expect(next.totals[outcomeKey('/monsters/mimic', 252)]).toMatchObject({ attempts: 4, clears: 1 });
    });

    test('the same monster at another level is another fight', () => {
        const state = foldFloorOutcomes(
            {},
            {},
            readCombatRooms([[combat({ entryCount: 1 }), combat({ recommendedLevel: 199, entryCount: 2 })]])
        );
        expect(Object.keys(state.totals)).toHaveLength(2);
    });
});

describe('compareToPrediction', () => {
    const cmp = (clears, attempts, predicted) => compareToPrediction(clears, attempts, predicted, wilsonInterval);

    test('names the direction the model is wrong in', () => {
        // The reported case: 0 clears in 21, against a simulated 24.4%
        const verdict = cmp(0, 21, 0.244);
        expect(verdict.verdict).toBe('sim too high');
        expect(verdict.observed).toBe(0);
        expect(verdict.likelihood).toBeLessThan(0.01);
    });

    test('the same record does not condemn a modest claim', () => {
        // 0 in 21 is unremarkable if the room really is a 5% one
        expect(cmp(0, 21, 0.05).verdict).toBe('consistent');
        expect(cmp(0, 21, 0.05).likelihood).toBeGreaterThan(0.3);
    });

    test('catches a model that is too pessimistic too', () => {
        expect(cmp(19, 20, 0.3).verdict).toBe('sim too low');
    });

    test('says nothing without fights to say it from', () => {
        expect(cmp(0, 0, 0.5).verdict).toBe('no data');
    });
});

describe('binomialTailLikelihood', () => {
    test('matches the hand calculation', () => {
        // P(0 wins in 21 at p=0.244) = 0.756^21
        expect(binomialTailLikelihood(0, 21, 0.244)).toBeCloseTo(Math.pow(0.756, 21), 10);
        // Both tails of a fair coin over one toss
        expect(binomialTailLikelihood(0, 1, 0.5)).toBeCloseTo(0.5, 10);
        expect(binomialTailLikelihood(1, 1, 0.5)).toBeCloseTo(0.5, 10);
    });

    test('a result right at the expectation is unsurprising', () => {
        expect(binomialTailLikelihood(50, 100, 0.5)).toBeGreaterThan(0.5);
    });

    test('degenerate predictions surprise nobody', () => {
        expect(binomialTailLikelihood(5, 10, 0)).toBe(1);
        expect(binomialTailLikelihood(5, 10, 1)).toBe(1);
        expect(binomialTailLikelihood(0, 0, 0.5)).toBe(1);
    });
});
