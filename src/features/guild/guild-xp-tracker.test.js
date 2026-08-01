import { describe, test, expect } from 'vitest';
import { pushXP, dropFlatRepeats, calcStats } from './guild-xp-tracker.js';

const MIN = 60 * 1000;

describe('pushXP', () => {
    test('a reading that repeats the last one carries nothing and is dropped', () => {
        // The guild leaderboard refreshes every 20 minutes, so opening the panel
        // three times in a row hands back the same snapshot three times
        const history = [];
        pushXP(history, { t: 0, xp: 1000 });
        pushXP(history, { t: 2 * MIN, xp: 1000 });
        pushXP(history, { t: 4 * MIN, xp: 1000 });
        expect(history).toHaveLength(1);
    });

    test('a flat reading is kept once the refresh window has passed', () => {
        // Then it means the guild really did earn nothing, which is a fact
        const history = [];
        pushXP(history, { t: 0, xp: 1000 });
        pushXP(history, { t: 25 * MIN, xp: 1000 });
        expect(history).toHaveLength(2);
    });

    test('real progress is always recorded', () => {
        const history = [];
        pushXP(history, { t: 0, xp: 1000 });
        pushXP(history, { t: 1 * MIN, xp: 1200 });
        expect(history).toHaveLength(2);
    });

    test('experience never goes backwards', () => {
        const history = [{ t: 0, xp: 1000 }];
        pushXP(history, { t: MIN, xp: 900 });
        expect(history).toHaveLength(1);
    });
});

describe('the blank-column bug', () => {
    test('repeat readings used to bury the rate, and no longer do', () => {
        // A day of real progress, then the panel opened twice in quick
        // succession — which is what every guild's history looked like
        const poisoned = [
            { t: 0, xp: 1_000_000 },
            { t: 12 * 60 * MIN, xp: 2_000_000 },
            { t: 12 * 60 * MIN + MIN, xp: 2_000_000 },
            { t: 12 * 60 * MIN + 2 * MIN, xp: 2_000_000 },
        ];
        // The last two readings are identical, so the rate between them is zero
        expect(calcStats(poisoned).lastXPH).toBe(0);

        // Healed, the newest pair spans real progress again
        const healed = dropFlatRepeats(poisoned);
        expect(healed).toHaveLength(2);
        expect(calcStats(healed).lastXPH).toBeCloseTo(1_000_000 / 12, 6);
    });

    test('healing leaves a genuinely idle stretch alone', () => {
        const idle = [
            { t: 0, xp: 1_000_000 },
            { t: 60 * MIN, xp: 1_000_000 },
        ];
        expect(dropFlatRepeats(idle)).toHaveLength(2);
        expect(calcStats(idle).lastXPH).toBe(0);
    });

    test('a history too short to rate says zero rather than guessing', () => {
        expect(calcStats([{ t: 0, xp: 5 }]).lastXPH).toBe(0);
        expect(calcStats([]).lastXPH).toBe(0);
        expect(calcStats(null).lastXPH).toBe(0);
    });
});
