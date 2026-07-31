import { describe, test, expect } from 'vitest';
import {
    outcomeKey,
    readFloorRooms,
    foldFloorOutcomes,
    compareToPrediction,
    binomialTailLikelihood,
    accuracyRows,
    accuracySummary,
    foldRoomResult,
    roomMeasurements,
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

/** A cleared room as the server actually sends it: stripped of its contents */
const clearedRoom = (over = {}) => ({ isCleared: true, entryCount: 0, ...over });

const MIMIC = outcomeKey('/monsters/mimic', 252);

/** Fold one floor state after another, threading the state through */
function foldAll(states, options = {}) {
    let state = { totals: {}, seen: {} };
    for (const rooms of states) {
        state = foldFloorOutcomes(state.totals, state.seen, readFloorRooms(rooms), { scope: 'run|1', ...options });
    }
    return state;
}

describe('readFloorRooms', () => {
    test('returns every room, not just the ones naming a monster', () => {
        // A cleared room names nothing at all, so a reader that filters on
        // monsterHrid cannot see the moment a fight was won
        const rooms = readFloorRooms([[combat(), null, clearedRoom(), { roomType: '/labyrinth_room_types/treasure' }]]);
        expect(rooms).toHaveLength(3);
        expect(rooms[0]).toMatchObject({ coord: '0,0', monsterHrid: '/monsters/mimic', roomLevel: 252 });
        expect(rooms[1]).toMatchObject({ coord: '2,0', monsterHrid: '', isCleared: true });
    });

    test('survives a grid that is not one', () => {
        expect(readFloorRooms(null)).toEqual([]);
        expect(readFloorRooms([null, undefined])).toEqual([]);
    });
});

describe('foldFloorOutcomes', () => {
    test('counts the clear of a room that was stripped when it cleared', () => {
        // The reported bug. Attempts accrued while the monster was there and
        // the win was invisible, so every room read 0 clears in N attempts and
        // the sim could only ever look too optimistic.
        const state = foldAll([
            grid([combat({ entryCount: 1 })]),
            grid([combat({ entryCount: 2 })]),
            grid([clearedRoom()]),
        ]);
        expect(state.totals[MIMIC]).toMatchObject({ attempts: 2, clears: 1, subjectHrid: '/monsters/mimic' });
    });

    test('a stripped room reporting no entries does not restart the count', () => {
        const state = foldAll([grid([combat({ entryCount: 5 })]), grid([clearedRoom()]), grid([clearedRoom()])]);
        expect(state.totals[MIMIC]).toMatchObject({ attempts: 5, clears: 1 });
    });

    test('a win never outruns its own attempt', () => {
        // A room cleared first try can go straight from unseen to cleared with
        // no update in between showing it entered — and 1 clear in 0 attempts
        // would be a rate above 100%
        const state = foldAll([grid([combat({ entryCount: 0 })]), grid([clearedRoom()])]);
        expect(state.totals[MIMIC]).toMatchObject({ attempts: 1, clears: 1 });
    });

    test('the same floor folded twice counts once', () => {
        const rooms = readFloorRooms(grid([combat({ entryCount: 3, isCleared: true })]));
        const first = foldFloorOutcomes({}, {}, rooms, { scope: 'run|1' });
        const second = foldFloorOutcomes(first.totals, first.seen, rooms, { scope: 'run|1' });

        expect(first.totals[MIMIC]).toMatchObject({ attempts: 3, clears: 1 });
        expect(second.totals[MIMIC]).toMatchObject({ attempts: 3, clears: 1 });
        expect(second.changed).toBe(false);
    });

    test('counts attempts as they accrue and the clear once', () => {
        const state = foldAll([
            grid([combat({ entryCount: 1 })]),
            grid([combat({ entryCount: 2 })]),
            grid([combat({ entryCount: 3, isCleared: true })]),
            grid([combat({ entryCount: 3, isCleared: true })]),
        ]);
        expect(state.totals[MIMIC]).toMatchObject({ attempts: 3, clears: 1 });
    });

    test('a room given up on still contributes its attempts', () => {
        // Only counting rooms you finished would quietly drop every fight you
        // walked away from, which is exactly the losing half of the sample
        const state = foldAll([grid([combat({ entryCount: 6, isCleared: false })])]);
        expect(state.totals[MIMIC]).toMatchObject({ attempts: 6, clears: 0 });
    });

    test('a new monster on the same square starts over', () => {
        const state = foldAll([
            grid([combat({ entryCount: 4, isCleared: true })]),
            grid([combat({ monsterHrid: '/monsters/wark', entryCount: 2, isCleared: false })]),
        ]);
        expect(state.totals[outcomeKey('/monsters/wark', 252)]).toMatchObject({ attempts: 2, clears: 0 });
        expect(state.totals[MIMIC]).toMatchObject({ attempts: 4, clears: 1 });
    });

    test('a cleared square on the next floor is not credited to the last one', () => {
        // Coordinates repeat every floor. Without the scope, descending onto a
        // floor whose 0,0 is already cleared would hand a free win to whatever
        // was standing on the previous floor's 0,0.
        const fought = foldFloorOutcomes({}, {}, readFloorRooms(grid([combat({ entryCount: 3 })])), {
            scope: 'run|1',
        });
        const descended = foldFloorOutcomes(fought.totals, fought.seen, readFloorRooms(grid([clearedRoom()])), {
            scope: 'run|2',
        });
        expect(descended.totals[MIMIC]).toMatchObject({ attempts: 3, clears: 0 });
        expect(descended.changed).toBe(false);
    });

    test('reports room state moving even when no fight was counted', () => {
        // Entering a room changes nothing about the record but everything about
        // what the next session must not re-count
        const first = foldFloorOutcomes({}, {}, readFloorRooms(grid([combat({ entryCount: 2 })])), { scope: 'run|1' });
        const same = foldFloorOutcomes(first.totals, first.seen, readFloorRooms(grid([combat({ entryCount: 2 })])), {
            scope: 'run|1',
        });
        expect(same.changed).toBe(false);
        expect(same.seenChanged).toBe(false);

        const revealed = foldFloorOutcomes(
            first.totals,
            first.seen,
            readFloorRooms([[combat({ entryCount: 2 }), { roomType: '/labyrinth_room_types/treasure' }]]),
            { scope: 'run|1' }
        );
        expect(revealed.changed).toBe(false);
        expect(revealed.seenChanged).toBe(true);
    });

    test('drops the previous floor rather than piling every floor up', () => {
        const first = foldFloorOutcomes({}, {}, readFloorRooms(grid([combat({ entryCount: 1 })])), { scope: 'run|1' });
        const second = foldFloorOutcomes(first.totals, first.seen, readFloorRooms(grid([combat()])), {
            scope: 'run|2',
        });
        expect(Object.keys(second.seen)).toEqual(['0,0']);
    });

    test('the same monster at another level is another fight', () => {
        const state = foldAll([[[combat({ entryCount: 1 }), combat({ recommendedLevel: 199, entryCount: 2 })]]]);
        expect(Object.keys(state.totals)).toHaveLength(2);
    });

    test('a skilling room is counted the same way a fight is', () => {
        // Failed by running out of the two minutes rather than by dying, but
        // still a room the calculator gave a chance of clearing
        const state = foldAll([
            grid([{ skillHrid: '/skills/milking', recommendedLevel: 240, entryCount: 2 }]),
            grid([clearedRoom()]),
        ]);
        expect(state.totals[outcomeKey('/skills/milking', 240)]).toMatchObject({
            attempts: 2,
            clears: 1,
            kind: 'skilling',
            subjectHrid: '/skills/milking',
        });
    });

    test('a square that held a skill and now holds a monster starts over', () => {
        const state = foldAll([
            grid([{ skillHrid: '/skills/milking', recommendedLevel: 240, entryCount: 3, isCleared: true }]),
            grid([combat({ entryCount: 1 })]),
        ]);
        expect(state.totals[outcomeKey('/skills/milking', 240)]).toMatchObject({ attempts: 3, clears: 1 });
        expect(state.totals[MIMIC]).toMatchObject({ attempts: 1, clears: 0, kind: 'combat' });
    });
});

describe('foldRoomResult', () => {
    const result = (over = {}) => ({
        subjectHrid: '/skills/milking',
        roomLevel: 240,
        kind: 'skilling',
        seconds: 60,
        xp: 12000,
        actions: 20,
        successes: 14,
        doubles: 3,
        predictedSeconds: 55,
        predictedSuccess: 0.72,
        serverSuccess: 0.7,
        ...over,
    });
    const KEY = outcomeKey('/skills/milking', 240);

    test('accumulates rooms, time, experience and actions', () => {
        const totals = foldRoomResult(foldRoomResult({}, result()), result({ seconds: 80, xp: 13000 }));
        expect(totals[KEY]).toMatchObject({ rooms: 2, seconds: 140, xp: 25000, actions: 40, successes: 28 });
    });

    test('a room with nothing in it is not a room', () => {
        expect(foldRoomResult({}, { roomLevel: 240 })).toEqual({});
        expect(foldRoomResult(null, null)).toEqual({});
    });

    test('keeps the entry counting a floor fold already did', () => {
        const folded = foldAll([grid([{ skillHrid: '/skills/milking', recommendedLevel: 240, entryCount: 4 }])]);
        const totals = foldRoomResult(folded.totals, result());
        expect(totals[KEY]).toMatchObject({ attempts: 4, rooms: 1, seconds: 60 });
    });

    test('the newest prediction replaces the last, rather than averaging with it', () => {
        // Averaging today's prediction with one made for gear since replaced
        // produces a number nothing ever claimed
        const totals = foldRoomResult(foldRoomResult({}, result()), result({ predictedSuccess: 0.9 }));
        expect(totals[KEY].predictedSuccess).toBe(0.9);
    });
});

describe('roomMeasurements', () => {
    test('turns the running totals into rates', () => {
        const measured = roomMeasurements({
            rooms: 2,
            seconds: 120,
            xp: 24000,
            actions: 40,
            successes: 28,
            doubles: 6,
        });
        expect(measured).toMatchObject({ rooms: 2, secondsPerRoom: 60, success: 0.7, double: 0.15 });
        expect(measured.xpPerHour).toBe(720000);
    });

    test('says nothing about a room nobody finished', () => {
        expect(roomMeasurements({ attempts: 9, clears: 0 })).toBeNull();
        expect(roomMeasurements(null)).toBeNull();
    });

    test('no actions means no rate, rather than a rate of zero', () => {
        const measured = roomMeasurements({ rooms: 1, seconds: 90, xp: 0 });
        expect(measured.success).toBeNull();
        expect(measured.xpPerHour).toBeNull();
    });
});

describe('foldFloorOutcomes prediction capture', () => {
    test('stamps the rate the sim was claiming when the fights landed', () => {
        const state = foldAll([grid([combat({ entryCount: 2 })])], { predictedFor: () => 0.244 });
        expect(state.totals[MIMIC].predicted).toBeCloseTo(0.244);
    });

    test('a room with no sim yet keeps whatever was stamped before', () => {
        const first = foldFloorOutcomes({}, {}, readFloorRooms(grid([combat({ entryCount: 1 })])), {
            scope: 'run|1',
            predictedFor: () => 0.3,
        });
        const next = foldFloorOutcomes(first.totals, first.seen, readFloorRooms(grid([combat({ entryCount: 2 })])), {
            scope: 'run|1',
            predictedFor: () => null,
        });
        expect(next.totals[MIMIC]).toMatchObject({ attempts: 2, predicted: 0.3 });
    });

    test('a stripped cleared room is judged against the monster that was there', () => {
        const state = foldAll([grid([combat({ entryCount: 1 })]), grid([clearedRoom()])], {
            predictedFor: (hrid, level) => (hrid === '/monsters/mimic' && level === 252 ? 0.66 : null),
        });
        expect(state.totals[MIMIC]).toMatchObject({ clears: 1, predicted: 0.66 });
    });
});

describe('accuracyRows', () => {
    const totals = {
        [outcomeKey('/monsters/mimic', 252)]: {
            monsterHrid: '/monsters/mimic',
            roomLevel: 252,
            attempts: 21,
            clears: 0,
            predicted: 0.244,
        },
        [outcomeKey('/monsters/wark', 100)]: {
            monsterHrid: '/monsters/wark',
            roomLevel: 100,
            attempts: 4,
            clears: 4,
        },
    };
    const rows = (over = {}) => accuracyRows(totals, { interval: wilsonInterval, ...over });

    test('most-fought first, and names the monster', () => {
        expect(rows().map((row) => row.monster)).toEqual(['mimic', 'wark']);
    });

    test('judges against the stamped rate when nothing is cached', () => {
        const mimic = rows()[0];
        expect(mimic.verdict).toBe('sim too high');
        expect(mimic.fromCache).toBe(false);
        expect(mimic.likelihood).toBeLessThan(0.01);
    });

    test('a live sim result outranks the stamped one', () => {
        const mimic = rows({ predictedFor: () => 0.02 })[0];
        expect(mimic.verdict).toBe('consistent');
        expect(mimic.fromCache).toBe(true);
    });

    test('a room that was never simmed is reported, not judged', () => {
        const wark = rows()[1];
        expect(wark.verdict).toBe('not simmed');
        expect(wark.predicted).toBeNull();
        expect(wark.likelihood).toBeNull();
    });

    test('survives an empty record', () => {
        expect(accuracyRows(null, { interval: wilsonInterval })).toEqual([]);
    });
});

describe('accuracySummary', () => {
    const summary = () =>
        accuracySummary([
            { attempts: 21, clears: 0, predicted: 0.244, verdict: 'sim too high' },
            { attempts: 10, clears: 6, predicted: 0.6, verdict: 'consistent' },
            { attempts: 4, clears: 4, predicted: null, verdict: 'not simmed' },
        ]);

    test('totals every fight but only owes clears for the judged ones', () => {
        // 4 unsimmed fights count toward attempts and clears, but the sim never
        // made a claim about them, so they must not drag the expectation down
        expect(summary()).toMatchObject({ buckets: 3, attempts: 35, clears: 10, judged: 31, judgedClears: 6 });
        expect(summary().expected).toBeCloseTo(21 * 0.244 + 10 * 0.6);
    });

    test('counts the rows the record actually contradicts', () => {
        expect(summary().contested).toBe(1);
    });

    test('says nothing about an empty record', () => {
        expect(accuracySummary([])).toMatchObject({ buckets: 0, attempts: 0, expected: null });
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
