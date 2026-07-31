import { describe, test, expect } from 'vitest';
import { classifyFight, fightTally, failureShape, TIMEOUT_GRACE_SECONDS } from './labyrinth-fight-log.js';
import { FIGHT_TIMEOUT_SECONDS } from './labyrinth-live-combat.js';

const fight = (over = {}) => ({ monsterHpFraction: 0.4, playerHpFraction: 0.6, seconds: 40, ...over });

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
