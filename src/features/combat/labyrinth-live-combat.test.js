import { describe, test, expect } from 'vitest';
import {
    estimateLiveClearChance,
    formatLiveClearChance,
    normalCdf,
    FIGHT_TIMEOUT_SECONDS,
    MIN_ELAPSED_SECONDS,
} from './labyrinth-live-combat.js';

const at = (monsterHpFraction, playerHpFraction, elapsedSeconds) =>
    estimateLiveClearChance({ monsterHpFraction, playerHpFraction, elapsedSeconds });

describe('normalCdf', () => {
    test('matches the values it will be judged on', () => {
        expect(normalCdf(0)).toBeCloseTo(0.5, 6);
        expect(normalCdf(1)).toBeCloseTo(0.841345, 5);
        expect(normalCdf(-1)).toBeCloseTo(0.158655, 5);
        expect(normalCdf(1.96)).toBeCloseTo(0.975, 4);
    });

    test('is symmetric about zero', () => {
        for (const z of [0.3, 1.1, 2.4]) {
            expect(normalCdf(z) + normalCdf(-z)).toBeCloseTo(1, 6);
        }
    });
});

describe('estimateLiveClearChance', () => {
    test('a settled fight is reported, not estimated', () => {
        expect(at(0, 0.5, 30).clearChance).toBe(1);
        expect(at(0.5, 0, 30).clearChance).toBe(0);
        expect(at(0.5, 0.5, FIGHT_TIMEOUT_SECONDS).clearChance).toBe(0);
    });

    test('says nothing before the rates mean anything', () => {
        const early = at(0.9, 0.95, MIN_ELAPSED_SECONDS - 1);
        expect(early.clearChance).toBeNull();
        expect(formatLiveClearChance(early)).toBe('');
    });

    test('winning comfortably reads high, losing badly reads low', () => {
        // Monster down to 30% in 30s, you have barely been touched
        expect(at(0.3, 0.95, 30).clearChance).toBeGreaterThan(0.9);
        // You are down to 20% and it is still on 80%
        expect(at(0.8, 0.2, 30).clearChance).toBeLessThan(0.1);
    });

    test('an even race sits near the middle', () => {
        // Both sides half gone at the same moment: the kill and the death land
        // together, so it is close to a coin toss
        const even = at(0.5, 0.5, 40);
        expect(even.clearChance).toBeGreaterThan(0.35);
        expect(even.clearChance).toBeLessThan(0.65);
    });

    test('the clock is a finish line of its own', () => {
        // Untouchable, but 100s in with 80% of the monster still up: the kill
        // lands minutes away and the room ends in 20 seconds
        const slow = at(0.8, 1, 100);
        expect(slow.clearChance).toBeLessThan(0.05);
        expect(slow.deathSeconds).toBe(Infinity);
        expect(slow.reason).toBe('racing the clock');
    });

    test('dealing no damage is a loss however healthy you are', () => {
        const stuck = at(1, 1, 60);
        expect(stuck.clearChance).toBe(0);
        expect(stuck.reason).toBe('not damaging it');
    });

    test('the same race firms up as the fight supplies evidence', () => {
        // Identical rates, more of the fight seen: the estimate should not
        // wander, but it should get more sure of itself
        const early = at(0.75, 0.95, 10);
        const late = at(0.25, 0.85, 30);
        expect(late.clearChance).toBeGreaterThan(early.clearChance);
        expect(early.confident).toBe(false);
        expect(late.confident).toBe(true);
    });

    test('rejects states it cannot read', () => {
        expect(estimateLiveClearChance(null)).toBeNull();
        expect(at(1.4, 0.5, 20)).toBeNull();
        expect(at(0.5, -0.1, 20)).toBeNull();
        expect(at(0.5, 0.5, NaN)).toBeNull();
    });
});

describe('estimateLiveClearChance joined in progress', () => {
    test('rates come from the watched window, not from a full health bar', () => {
        // Picked the fight up with the monster already at 60%: over the next
        // 20 seconds it drops to 20%, so the last fifth takes ~10s more
        const late = estimateLiveClearChance({
            monsterHpFraction: 0.2,
            playerHpFraction: 0.7,
            observedSeconds: 20,
            monsterLostFraction: 0.4,
            playerLostFraction: 0.1,
            remainingSeconds: null,
        });
        expect(late.killSeconds).toBeCloseTo(10, 6);
        expect(late.deathSeconds).toBeCloseTo(140, 6);
        expect(late.clearChance).toBeGreaterThan(0.9);
    });

    test('an unknown clock is left out rather than guessed', () => {
        const state = {
            monsterHpFraction: 0.5,
            playerHpFraction: 1,
            observedSeconds: 30,
            monsterLostFraction: 0.1,
            playerLostFraction: 0,
        };
        // Kill is 150s away — past any room timer — but with no clock to race,
        // an untouchable player is winning
        const unknownClock = estimateLiveClearChance({ ...state, remainingSeconds: null });
        expect(unknownClock.timerKnown).toBe(false);
        expect(unknownClock.clearChance).toBe(1);

        // Give it the clock and the same fight is lost
        const knownClock = estimateLiveClearChance({ ...state, remainingSeconds: 40 });
        expect(knownClock.timerKnown).toBe(true);
        expect(knownClock.clearChance).toBeLessThan(0.05);
    });

    test('healing between sightings is a zero loss, not a negative one', () => {
        const healed = estimateLiveClearChance({
            monsterHpFraction: 0.5,
            playerHpFraction: 0.9,
            observedSeconds: 20,
            monsterLostFraction: 0.5,
            playerLostFraction: -0.2, // ended the window healthier than it started
            remainingSeconds: 60,
        });
        expect(healed.deathSeconds).toBe(Infinity);
        expect(healed.reason).toBe('racing the clock');
    });

    test('a fight watched from the start needs none of the extra fields', () => {
        const explicit = estimateLiveClearChance({
            monsterHpFraction: 0.4,
            playerHpFraction: 0.8,
            observedSeconds: 30,
            monsterLostFraction: 0.6,
            playerLostFraction: 0.2,
            remainingSeconds: 90,
        });
        const implied = at(0.4, 0.8, 30);
        expect(implied.reason).toBe(explicit.reason);
        expect(implied.timerKnown).toBe(explicit.timerKnown);
        expect(implied.remainingSeconds).toBe(explicit.remainingSeconds);
        // Derived losses go through 1 - fraction, so they land a rounding error
        // away from the same figure written out
        expect(implied.killSeconds).toBeCloseTo(explicit.killSeconds, 9);
        expect(implied.deathSeconds).toBeCloseTo(explicit.deathSeconds, 9);
        expect(implied.clearChance).toBeCloseTo(explicit.clearChance, 9);
    });
});

describe('formatLiveClearChance', () => {
    test('marks a number the fight has not yet earned', () => {
        expect(formatLiveClearChance(at(0.3, 0.95, 10))).toMatch(/^Clear ~\d+%\?$/);
        expect(formatLiveClearChance(at(0.3, 0.95, 40))).toMatch(/^Clear ~\d+%$/);
    });

    test('says nothing when there is nothing to say', () => {
        expect(formatLiveClearChance(null)).toBe('');
    });
});
