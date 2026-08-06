/**
 * Combat estimates.
 *
 * One rule runs through every helper here: no input, no number. Each estimate
 * has a case where the honest answer is "cannot say" — a health bar never
 * reported, a rate not yet divisible, too few swings — and every one of those
 * must come back null rather than zero, because a dash and a zero mean
 * different things on a meter.
 */

import { describe, test, expect } from 'vitest';
import {
    MIN_SWINGS_FOR_ACCURACY,
    MANA_RUNWAY_SHOW_SECONDS,
    MANA_RUNWAY_MIN_SPAN_MS,
    ENRAGE_WARN_SECONDS,
    formatSecondsShort,
    timeToKillSeconds,
    timeToKillText,
    waveClearSeconds,
    waveClearText,
    pushManaSample,
    manaRunwaySeconds,
    manaRunwayText,
    sustainLine,
    accuracyText,
    outgoingText,
    enrageSecondsLeft,
    enrageLine,
} from './combat-estimates.js';

describe('formatting a short duration', () => {
    test('seconds under a minute, minutes over it', () => {
        expect(formatSecondsShort(8.4)).toBe('8s');
        expect(formatSecondsShort(59)).toBe('59s');
        expect(formatSecondsShort(102)).toBe('1:42');
        expect(formatSecondsShort(600)).toBe('10:00');
    });

    test('never negative', () => {
        expect(formatSecondsShort(-5)).toBe('0s');
    });
});

describe('time to kill', () => {
    test('remaining health over the rate', () => {
        expect(timeToKillSeconds(800, 100)).toBe(8);
        expect(timeToKillText(timeToKillSeconds(800, 100))).toBe('dead ~8s');
    });

    test('no health reading is no estimate', () => {
        expect(timeToKillSeconds(null, 100)).toBeNull();
        expect(timeToKillSeconds(undefined, 100)).toBeNull();
    });

    test('no rate is no estimate — including a rate of zero', () => {
        // Zero is "nobody is hitting it", and dividing by it would claim the
        // monster lives forever, which is a different statement entirely
        expect(timeToKillSeconds(800, null)).toBeNull();
        expect(timeToKillSeconds(800, 0)).toBeNull();
    });

    test('a dead monster needs no countdown', () => {
        expect(timeToKillSeconds(0, 100)).toBeNull();
        expect(timeToKillText(null)).toBeNull();
    });
});

describe('the wave-clear countdown', () => {
    test('every living health bar over the combined rate', () => {
        const enemies = {
            0: { hp: 900, dps: 100 },
            1: { hp: 1000, dps: 90 },
        };
        expect(waveClearSeconds(enemies)).toBeCloseTo(1900 / 190);
        expect(waveClearText(10)).toBe('wave ~10s');
    });

    test('a dead enemy drops out of both sums', () => {
        expect(
            waveClearSeconds([
                { hp: 0, dps: 50 },
                { hp: 100, dps: 100 },
            ])
        ).toBe(1);
    });

    test('an untouched enemy still counts its health', () => {
        // Its rate is genuinely nothing so far; its health bar is genuinely
        // still to be chewed through. Both facts belong in the estimate.
        expect(
            waveClearSeconds([
                { hp: 100, dps: 100 },
                { hp: 300, dps: null },
            ])
        ).toBe(4);
    });

    test('one unknown health bar voids the whole estimate', () => {
        // A countdown that silently excluded a monster would read as the wave
        // ending while something is still alive
        expect(
            waveClearSeconds([
                { hp: 100, dps: 100 },
                { hp: null, dps: 50 },
            ])
        ).toBeNull();
    });

    test('nothing alive, or nothing at all, is nothing', () => {
        expect(waveClearSeconds([])).toBeNull();
        expect(waveClearSeconds(null)).toBeNull();
        expect(waveClearSeconds([{ hp: 0, dps: 100 }])).toBeNull();
    });
});

describe('the mana runway', () => {
    const series = (points) => {
        const samples = [];
        for (const [at, mana] of points) pushManaSample(samples, at, mana);
        return samples;
    };

    test('draining mana gives a runway', () => {
        // 300 → 180 over 12s is 10/s, and 180 left is 18s of it
        const samples = series([
            [0, 300],
            [6_000, 240],
            [12_000, 180],
        ]);
        expect(manaRunwaySeconds(samples)).toBeCloseTo(18);
        expect(manaRunwayText(18)).toBe('mana ~18s');
    });

    test('steady or rising mana is nothing to warn about', () => {
        expect(
            manaRunwaySeconds(
                series([
                    [0, 300],
                    [15_000, 300],
                ])
            )
        ).toBeNull();
        expect(
            manaRunwaySeconds(
                series([
                    [0, 200],
                    [15_000, 300],
                ])
            )
        ).toBeNull();
    });

    test('a refill mid-window is part of the net, not an error', () => {
        // Down 100, potion back up 80, down 100 again: net −120 over 20s
        const samples = series([
            [0, 300],
            [5_000, 200],
            [10_000, 280],
            [20_000, 180],
        ]);
        expect(manaRunwaySeconds(samples)).toBeCloseTo(30);
    });

    test('too short a series is one cast read as a trend', () => {
        expect(
            manaRunwaySeconds(
                series([
                    [0, 300],
                    [MANA_RUNWAY_MIN_SPAN_MS - 1, 200],
                ])
            )
        ).toBeNull();
        expect(manaRunwaySeconds(series([[0, 300]]))).toBeNull();
        expect(manaRunwaySeconds([])).toBeNull();
        expect(manaRunwaySeconds(null)).toBeNull();
    });

    test('a comfortable runway earns no line', () => {
        expect(manaRunwayText(MANA_RUNWAY_SHOW_SECONDS + 1)).toBeNull();
        expect(manaRunwayText(null)).toBeNull();
    });

    test('the sample window forgets what is older than it', () => {
        const samples = series([
            [0, 500],
            [100_000, 300],
        ]);
        expect(samples).toHaveLength(1);
        expect(samples[0].mana).toBe(300);
    });
});

describe('the sustain line', () => {
    test('taken and net, red when losing', () => {
        const line = sustainLine({ dps: 220, hps: 185 });
        expect(line.text).toBe('taken 220/s · net −35/s');
        expect(line.negative).toBe(true);
    });

    test('healing that keeps up is a positive net', () => {
        const line = sustainLine({ dps: 220, hps: 260 });
        expect(line.text).toBe('taken 220/s · net +40/s');
        expect(line.negative).toBe(false);
    });

    test('no measurable regen means no net claimed', () => {
        // "taken 220/s" alone is honest; a net that assumed zero healing
        // would call every sustained fight a slow death
        const line = sustainLine({ dps: 220, hps: null });
        expect(line.text).toBe('taken 220/s');
        expect(line.negative).toBe(false);
    });

    test('no rate yet is no line', () => {
        expect(sustainLine({ dps: null, hps: null })).toBeNull();
        expect(sustainLine(null)).toBeNull();
    });
});

describe('the accuracy line', () => {
    test('hit and crit rate once enough swings back it', () => {
        expect(accuracyText({ hits: 47, misses: 3, crits: 15 })).toBe('94% hit · 32% crit');
    });

    test('below the swing floor it is luck, not a rate', () => {
        expect(accuracyText({ hits: MIN_SWINGS_FOR_ACCURACY - 1, misses: 0, crits: 5 })).toBeNull();
        expect(accuracyText({ hits: MIN_SWINGS_FOR_ACCURACY, misses: 0, crits: 0 })).toBe('100% hit · 0% crit');
    });

    test('all misses is a hit rate with no crit rate to state', () => {
        // Zero hits is not a 0% crit rate; it is nothing to compute one from
        expect(accuracyText({ hits: 0, misses: 25, crits: 0 })).toBe('0% hit');
    });

    test('nothing recorded is nothing', () => {
        expect(accuracyText({})).toBeNull();
        expect(accuracyText(null)).toBeNull();
    });
});

describe('the enemy outgoing line', () => {
    test('what it is doing to the party', () => {
        expect(outgoingText(209.6)).toBe('hits for 210/s');
    });

    test('no attributable rate is no line', () => {
        expect(outgoingText(null)).toBeNull();
        expect(outgoingText(undefined)).toBeNull();
    });
});

describe('the enrage countdown', () => {
    test('counts down from the sheet, amber when close', () => {
        expect(enrageSecondsLeft(102_000, 0)).toBe(102);
        expect(enrageLine(102)).toEqual({ text: 'enrage 1:42', warn: false });
        expect(enrageLine(ENRAGE_WARN_SECONDS - 1)).toEqual({ text: 'enrage 29s', warn: true });
    });

    test('past the timer it says so', () => {
        expect(enrageLine(-4)).toEqual({ text: 'enraged', warn: true });
    });

    test('a sheet with no timer counts down to nothing', () => {
        expect(enrageSecondsLeft(null, 0)).toBeNull();
        expect(enrageLine(null)).toBeNull();
    });
});
