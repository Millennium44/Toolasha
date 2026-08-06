/**
 * Dungeon pace.
 *
 * The comparison only exists where both sides genuinely do: a live wave
 * average with a few waves behind it, and stored runs of the same dungeon.
 * Everything else — no history, an unnamed dungeon, a run one wave old —
 * renders nothing rather than a pace against a guess.
 */

import { describe, test, expect } from 'vitest';
import { MIN_WAVES_FOR_PACE, runAvgWaveMs, historyAvgWaveMs, pacePercent, paceChip } from './dungeon-pace.js';

const MAX_WAVES = 50;

/** A stored run, as chat backfill writes one: duration and no wave times */
const chatRun = (dungeonName, durationMs, tier = null) => ({ dungeonName, duration: durationMs, tier });

describe('a stored run’s wave average', () => {
    test('a stated average wins over division', () => {
        expect(runAvgWaveMs({ avgWaveTime: 9_000, duration: 600_000 }, MAX_WAVES)).toBe(9_000);
    });

    test('a chat run is its duration over the wave count', () => {
        // Every saved run finished, or it would not have been saved — so the
        // dungeon's wave count is the run's wave count
        expect(runAvgWaveMs(chatRun('Chimerical Den', 500_000), MAX_WAVES)).toBe(10_000);
    });

    test('no duration, or no wave count to divide by, is nothing', () => {
        expect(runAvgWaveMs(chatRun('Chimerical Den', 0), MAX_WAVES)).toBeNull();
        expect(runAvgWaveMs(chatRun('Chimerical Den', 500_000), 0)).toBeNull();
        expect(runAvgWaveMs(null, MAX_WAVES)).toBeNull();
    });
});

describe('the stored average for a dungeon', () => {
    const runs = [
        chatRun('Chimerical Den', 500_000),
        chatRun('Chimerical Den', 600_000),
        chatRun('Sinister Circus', 100_000),
    ];

    test('only the same dungeon’s runs are averaged', () => {
        // (10s + 12s) / 2, and the Circus run never enters it
        expect(historyAvgWaveMs(runs, { dungeonName: 'Chimerical Den', tier: null, maxWaves: MAX_WAVES })).toBe(11_000);
    });

    test('a run whose tier is stated only counts when it matches', () => {
        const tiered = [chatRun('Chimerical Den', 500_000, 1), chatRun('Chimerical Den', 900_000, 2)];
        expect(historyAvgWaveMs(tiered, { dungeonName: 'Chimerical Den', tier: 1, maxWaves: MAX_WAVES })).toBe(10_000);
    });

    test('a run with no stated tier still counts — chat history carries none', () => {
        expect(historyAvgWaveMs(runs, { dungeonName: 'Chimerical Den', tier: 1, maxWaves: MAX_WAVES })).toBe(11_000);
    });

    test('no history is no average', () => {
        expect(historyAvgWaveMs([], { dungeonName: 'Chimerical Den', maxWaves: MAX_WAVES })).toBeNull();
        expect(historyAvgWaveMs(null, { dungeonName: 'Chimerical Den', maxWaves: MAX_WAVES })).toBeNull();
    });

    test('an unnamed dungeon matches nothing', () => {
        // 'Unknown' is what a run gets when nothing named it, and matching on
        // it would average unrelated dungeons together
        expect(
            historyAvgWaveMs([chatRun('Unknown', 500_000)], { dungeonName: 'Unknown', maxWaves: MAX_WAVES })
        ).toBeNull();
        expect(historyAvgWaveMs(runs, { dungeonName: null, maxWaves: MAX_WAVES })).toBeNull();
    });
});

describe('the pace itself', () => {
    test('faster than history is positive', () => {
        // 9.4s waves against a 10s average is 6% ahead
        expect(pacePercent(9_400, 10_000, 10)).toBe(6);
    });

    test('slower than history is negative', () => {
        expect(pacePercent(11_000, 10_000, 10)).toBe(-10);
    });

    test('too few waves is one wave’s luck, not a pace', () => {
        expect(pacePercent(9_400, 10_000, MIN_WAVES_FOR_PACE - 1)).toBeNull();
        expect(pacePercent(9_400, 10_000, MIN_WAVES_FOR_PACE)).toBe(6);
    });

    test('either side missing is no pace', () => {
        expect(pacePercent(null, 10_000, 10)).toBeNull();
        expect(pacePercent(0, 10_000, 10)).toBeNull();
        expect(pacePercent(9_400, null, 10)).toBeNull();
    });
});

describe('the chip', () => {
    test('green ahead, red behind, dim even', () => {
        expect(paceChip(6)).toEqual({ text: 'pace +6% vs your avg', tone: 'good' });
        expect(paceChip(-9)).toEqual({ text: 'pace −9% vs your avg', tone: 'bad' });
        expect(paceChip(0)).toEqual({ text: 'pace even with your avg', tone: 'dim' });
    });

    test('no pace is no chip', () => {
        expect(paceChip(null)).toBeNull();
        expect(paceChip(undefined)).toBeNull();
    });
});
