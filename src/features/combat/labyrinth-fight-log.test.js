import { describe, test, expect } from 'vitest';
import {
    classifyFight,
    fightTally,
    failureShape,
    isFreshLabyrinthFight,
    TIMEOUT_GRACE_SECONDS,
} from './labyrinth-fight-log.js';
import { FIGHT_TIMEOUT_SECONDS } from './labyrinth-live-combat.js';

const fight = (over = {}) => ({ monsterHpFraction: 0.4, playerHpFraction: 0.6, seconds: 40, ...over });

describe('isFreshLabyrinthFight', () => {
    const prev = (over = {}) => ({
        battleId: 'b1',
        monsterMaxHp: 1000,
        lastMonsterHp: 700,
        lastAtkCounter: 10,
        ...over,
    });
    const curr = (over = {}) => ({ battleId: 'b1', monsterMaxHp: 1000, monsterHp: 650, atkCounter: 11, ...over });

    test('no fight in progress is always fresh', () => {
        expect(isFreshLabyrinthFight(null, curr())).toBe(true);
    });

    test('a changed battleId or monster maximum is fresh', () => {
        expect(isFreshLabyrinthFight(prev(), curr({ battleId: 'b2' }))).toBe(true);
        expect(isFreshLabyrinthFight(prev(), curr({ monsterMaxHp: 1200, monsterHp: 1200 }))).toBe(true);
    });

    test('an attack counter that reset is fresh', () => {
        expect(isFreshLabyrinthFight(prev({ lastAtkCounter: 30 }), curr({ atkCounter: 0 }))).toBe(true);
    });

    test('a continuing fight with falling health is not fresh', () => {
        expect(isFreshLabyrinthFight(prev({ lastMonsterHp: 700 }), curr({ monsterHp: 650 }))).toBe(false);
    });

    test('a self-heal mid-fight does NOT read as a new fight', () => {
        // The Dryad life-drains from 600 back up to 660 — nowhere near full
        expect(isFreshLabyrinthFight(prev({ lastMonsterHp: 600 }), curr({ monsterHp: 660 }))).toBe(false);
    });

    test('a self-heal while near full does NOT read as a new fight', () => {
        // Health went up and is above 95%, but it did not come back from the low
        // a spawn revives from — so it is a heal, not a spawn
        expect(isFreshLabyrinthFight(prev({ lastMonsterHp: 980 }), curr({ monsterHp: 995 }))).toBe(false);
    });

    test('a spawn — the jump from low to full — is fresh', () => {
        expect(isFreshLabyrinthFight(prev({ lastMonsterHp: 40 }), curr({ monsterHp: 1000 }))).toBe(true);
    });
});

describe('classifyFight', () => {
    test('the floor outranks the last tick', () => {
        // The killing blow's tick often never arrives, so the monster still
        // shows health left on a fight that was won
        expect(classifyFight(fight({ cleared: true, monsterHpFraction: 0.07 })).outcome).toBe('clear');
    });

    test('a monster on zero is a clear even before the floor says so', () => {
        expect(classifyFight(fight({ monsterHpFraction: 0 })).outcome).toBe('clear');
    });

    test('names a death', () => {
        expect(classifyFight(fight({ playerHpFraction: 0, cleared: false })).outcome).toBe('death');
    });

    test('a fight that ran the clock out timed out', () => {
        const attempt = classifyFight(fight({ seconds: FIGHT_TIMEOUT_SECONDS - 1, cleared: false }));
        expect(attempt.outcome).toBe('timeout');
    });

    test('ticks stopping a beat early still counts as the clock running out', () => {
        const attempt = classifyFight(
            fight({ seconds: FIGHT_TIMEOUT_SECONDS - TIMEOUT_GRACE_SECONDS, cleared: false })
        );
        expect(attempt.outcome).toBe('timeout');
    });

    test('a fight abandoned early is not called anything', () => {
        // Refreshing the page mid-room must not be recorded as a defeat
        expect(classifyFight(fight({ seconds: 12 })).outcome).toBe('unknown');
    });

    test('a win reads as its duration, a loss as the margin', () => {
        expect(classifyFight(fight({ cleared: true, seconds: 31.4 })).text).toBe('31s');
        expect(classifyFight(fight({ playerHpFraction: 0, monsterHpFraction: 0.115 })).text).toBe('12%');
    });

    test('survives junk', () => {
        const attempt = classifyFight(null);
        expect(attempt.outcome).toBe('clear'); // no monster health is a dead monster
        expect(classifyFight({ monsterHpFraction: 5, playerHpFraction: -2, seconds: -9 })).toMatchObject({
            monsterHpLeft: 1,
            playerHpLeft: 0,
            seconds: 0,
        });
    });
});

describe('fightTally', () => {
    const attempts = [
        { outcome: 'death' },
        { outcome: 'timeout' },
        { outcome: 'clear' },
        { outcome: 'unknown' },
        { outcome: 'death' },
    ];

    test('counts each ending', () => {
        expect(fightTally(attempts)).toMatchObject({ total: 4, clears: 1, deaths: 2, timeouts: 1, unknown: 1 });
    });

    test('the rate leaves the unknown attempt out rather than losing it', () => {
        // 1 in 4 counted, not 1 in 5 — an attempt nobody saw the end of is not
        // evidence the room was lost
        expect(fightTally(attempts).rate).toBe(0.25);
    });

    test('no attempts means no rate, not a rate of zero', () => {
        expect(fightTally([]).rate).toBeNull();
        expect(fightTally(null).total).toBe(0);
    });
});

describe('failureShape', () => {
    test('says nothing about a room that is not being lost', () => {
        expect(failureShape(fightTally([{ outcome: 'clear' }]))).toBe('');
    });

    test('names the single cause when there is one', () => {
        expect(failureShape(fightTally([{ outcome: 'death' }, { outcome: 'death' }]))).toBe('dying');
        expect(failureShape(fightTally([{ outcome: 'timeout' }]))).toBe('running out of time');
    });

    test('splits a mixed record, because the two fixes conflict', () => {
        expect(failureShape(fightTally([{ outcome: 'death' }, { outcome: 'timeout' }]))).toBe('1 died, 1 timed out');
    });
});
