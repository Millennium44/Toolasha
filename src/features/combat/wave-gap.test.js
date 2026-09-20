import { describe, it, expect } from 'vitest';
import {
    createWaveGapWatch,
    cycleAnalysis,
    emptyTally,
    foldDiscard,
    foldJitter,
    foldObservation,
    percentile,
    robustScale,
    summarize,
    CATEGORIES,
    CYCLE_BINS,
} from './wave-gap.js';
import recordedRun from '../../utils/__fixtures__/combat-run.json';
import recordedFight from '../../utils/__fixtures__/combat-dungeon.json';

const OPEN = { zoneKey: '/actions/combat/golem_cave:0', isDungeon: false, wave: 0 };
const DUNGEON = { zoneKey: '/actions/combat/chimerical_den:0', isDungeon: true };

/**
 * A tick that reports the given monster slots at zero hitpoints.
 * @param {Array<string>} slots - Slots that just died
 * @returns {Object} `battle_updated` payload
 */
function deaths(slots) {
    const mMap = {};
    for (const slot of slots) mMap[slot] = { cHP: 0 };
    return { mMap, pMap: {} };
}

/** A `new_battle` payload with two monsters. @returns {Object} Payload */
function wave() {
    return { monsters: { 0: { hrid: '/monsters/eye' }, 1: { hrid: '/monsters/eyes' } } };
}

describe('createWaveGapWatch', () => {
    it('times a dungeon wave gap from the last death to the next new_battle', () => {
        const watch = createWaveGapWatch();
        watch.newBattle(wave(), 1000, { ...DUNGEON, wave: 3 });
        watch.battleUpdated(deaths(['0']), 4000, {});
        watch.battleUpdated(deaths(['1']), 5000, {});
        watch.newBattle(wave(), 8037, { ...DUNGEON, wave: 4 });

        const { observations, discards } = watch.drain();
        expect(discards).toEqual([]);
        expect(observations).toEqual([
            { category: CATEGORIES.dungeonWave, gapMs: 3037, deathAt: 5000, waveFrom: 3, waveTo: 4 },
        ]);
    });

    it('files an open-zone respawn as its own category', () => {
        const watch = createWaveGapWatch();
        watch.newBattle(wave(), 0, OPEN);
        watch.battleUpdated(deaths(['0', '1']), 4000, {});
        watch.newBattle(wave(), 7011, OPEN);

        const { observations } = watch.drain();
        expect(observations).toHaveLength(1);
        expect(observations[0].category).toBe(CATEGORIES.openZone);
        expect(observations[0].gapMs).toBe(3011);
    });

    it('files the last wave of a run to the first of the next as a boundary', () => {
        const watch = createWaveGapWatch();
        watch.newBattle(wave(), 0, { ...DUNGEON, wave: 50 });
        watch.battleUpdated(deaths(['0', '1']), 4000, {});
        watch.newBattle(wave(), 7042, { ...DUNGEON, wave: 1 });

        const { observations } = watch.drain();
        expect(observations).toHaveLength(1);
        expect(observations[0].category).toBe(CATEGORIES.dungeonBoundary);
        expect(observations[0].waveFrom).toBe(50);
        expect(observations[0].waveTo).toBe(1);
    });

    it('does not count a wipe as a wave gap', () => {
        const watch = createWaveGapWatch();
        watch.newBattle(wave(), 0, OPEN);
        // One monster dies, the party does not finish the other, the wave restarts
        watch.battleUpdated(deaths(['0']), 4000, {});
        watch.battleUpdated({ mMap: {}, pMap: { 0: { cHP: 0, leftCombat: true } } }, 5000, {});
        watch.newBattle(wave(), 8000, OPEN);

        const { observations, discards } = watch.drain();
        expect(observations).toEqual([]);
        expect(discards).toEqual(['wipe']);
    });

    it('throws away a transition whose tick stream stalled', () => {
        const watch = createWaveGapWatch();
        watch.newBattle(wave(), 0, OPEN);
        // The server said the next action was 2 s away and it arrived 2.9 s
        // later: the arrival clock in this wave is not measuring what it claims
        watch.battleUpdated({ pMap: { 0: { atkCounter: 1, int: 2_000_000_000 } }, mMap: {} }, 1000, {});
        watch.battleUpdated({ pMap: { 0: { atkCounter: 2, int: 2_000_000_000 } }, mMap: {} }, 3900, {});
        watch.battleUpdated(deaths(['0', '1']), 4000, {});
        watch.newBattle(wave(), 7037, OPEN);

        const { observations, discards } = watch.drain();
        expect(observations).toEqual([]);
        expect(discards).toEqual(['streamHole']);
    });

    it('keeps a wave whose ticks were merely far apart', () => {
        const watch = createWaveGapWatch();
        watch.newBattle(wave(), 0, OPEN);
        // A slow weapon: five seconds between ticks, every one of them on time
        watch.battleUpdated({ pMap: { 0: { atkCounter: 1, int: 5_000_000_000 } }, mMap: {} }, 1000, {});
        watch.battleUpdated({ pMap: { 0: { atkCounter: 2, int: 5_000_000_000 } }, mMap: {} }, 6000, {});
        watch.battleUpdated(deaths(['0', '1']), 11_000, {});
        watch.newBattle(wave(), 14_037, OPEN);

        const { observations, discards } = watch.drain();
        expect(discards).toEqual([]);
        expect(observations[0].gapMs).toBe(3037);
    });

    it('throws away a transition across a zone change or a background tab', () => {
        const watch = createWaveGapWatch();
        watch.newBattle(wave(), 0, OPEN);
        watch.battleUpdated(deaths(['0', '1']), 1000, {});
        watch.newBattle(wave(), 4037, { ...OPEN, zoneKey: '/actions/combat/aqua_planet:0' });
        expect(watch.drain().discards).toEqual(['zoneChanged']);

        watch.battleUpdated(deaths(['0', '1']), 5000, { hidden: true });
        watch.newBattle(wave(), 8037, OPEN);
        expect(watch.drain().discards).toEqual(['hidden']);
    });

    it('throws away a dungeon transition with no wave number, and an absurd interval', () => {
        const watch = createWaveGapWatch();
        watch.newBattle(wave(), 0, { ...DUNGEON, wave: 0 });
        watch.battleUpdated(deaths(['0', '1']), 1000, {});
        watch.newBattle(wave(), 4037, { ...DUNGEON, wave: 0 });
        expect(watch.drain().discards).toEqual(['waveUnknown']);

        watch.battleUpdated(deaths(['0', '1']), 5000, {});
        watch.newBattle(wave(), 90_000, { ...DUNGEON, wave: 2 });
        expect(watch.drain().discards).toEqual(['outOfRange']);
    });

    it('reads the jitter calibration only off consecutive actions by the same player', () => {
        const watch = createWaveGapWatch();
        watch.newBattle(wave(), 0, OPEN);
        // Acted at 1000, server says the next one is 2 s away
        watch.battleUpdated({ pMap: { 0: { atkCounter: 1, int: 2_000_000_000 } }, mMap: {} }, 1000, {});
        // A delta that is not an action — the counter did not move — is not a pair
        watch.battleUpdated({ pMap: { 0: { atkCounter: 1, int: 2_000_000_000 } }, mMap: {} }, 1500, {});
        // The next action landed 12 ms late
        watch.battleUpdated({ pMap: { 0: { atkCounter: 2, int: 2_000_000_000 } }, mMap: {} }, 3012, {});

        expect(watch.drain().jitter).toEqual([12]);
    });
});

describe('cycleAnalysis', () => {
    it('bins by position inside the cycle and finds nothing in flat data', () => {
        const rows = [];
        for (let index = 0; index < 240; index += 1) rows.push({ g: 3037, t: index * 503 });
        const result = cycleAnalysis(rows, 120_000);

        expect(result.bins).toHaveLength(CYCLE_BINS);
        expect(result.bins.reduce((sum, bin) => sum + bin.n, 0)).toBe(240);
        expect(result.resolved).toBe(true);
        // Identical values leave no within-bin variance to divide by
        expect(result.f).toBeNull();
    });

    it('puts an observation in the bin its phase falls in', () => {
        const result = cycleAnalysis([{ g: 3000, t: 125_000 }], 120_000);
        // 125 s into a 120 s cycle is 5 s of phase, which is the first 10 s bin
        expect(result.bins[0].n).toBe(1);
        expect(result.bins[1].n).toBe(0);
    });

    it('separates bins that really do differ, and says what it could not have seen', () => {
        const rows = [];
        for (let index = 0; index < 600; index += 1) {
            const phase = (index % CYCLE_BINS) * 10_000 + 1000;
            const high = index % CYCLE_BINS < 6;
            rows.push({ g: (high ? 3200 : 3000) + (index % 5), t: phase });
        }
        const result = cycleAnalysis(rows, 120_000);
        expect(result.f).toBeGreaterThan(10);
        expect(result.spread).toBeGreaterThan(150);
        expect(result.detectableMs).toBeGreaterThan(0);
    });

    it('cannot resolve anything from a handful of observations', () => {
        const result = cycleAnalysis(
            [
                { g: 3000, t: 0 },
                { g: 3100, t: 70_000 },
            ],
            120_000
        );
        expect(result.resolved).toBe(false);
    });
});

describe('summarize', () => {
    it('reports a mean, an interval, percentiles and a histogram per category', () => {
        const tally = emptyTally();
        for (const gap of [3023, 3030, 3037, 3044, 3090]) {
            foldObservation(tally, { category: CATEGORIES.openZone, gapMs: gap, deathAt: gap * 37 });
        }
        const summary = summarize(tally);
        const open = summary.categories[CATEGORIES.openZone];

        expect(open.n).toBe(5);
        expect(open.mean).toBeCloseTo(3044.8, 1);
        expect(open.low).toBeLessThan(open.mean);
        expect(open.high).toBeGreaterThan(open.mean);
        expect(open.percentiles.p50).toBe(3037);
        expect(open.min).toBe(3023);
        expect(open.max).toBe(3090);
        expect(open.histogram.reduce((sum, row) => sum + row.count, 0)).toBe(5);
        expect(summary.categories[CATEGORIES.dungeonWave].n).toBe(0);
    });

    it('says plainly when two categories cannot be told apart', () => {
        const tally = emptyTally();
        for (let index = 0; index < 40; index += 1) {
            foldObservation(tally, { category: CATEGORIES.openZone, gapMs: 3030 + (index % 7), deathAt: index });
            foldObservation(tally, {
                category: CATEGORIES.dungeonWave,
                gapMs: 3030 + ((index + 3) % 7),
                deathAt: index,
            });
        }
        const summary = summarize(tally);
        expect(summary.openVsDungeon.enough).toBe(true);
        expect(summary.openVsDungeon.verdict).toContain('No difference detected');
    });

    it('counts the discards and keeps the jitter calibration robust', () => {
        const tally = emptyTally();
        foldDiscard(tally, 'wipe');
        foldDiscard(tally, 'wipe');
        foldDiscard(tally, 'nonsense');
        for (const residual of [-12, -3, 0, 4, 11, 1900, -1900]) foldJitter(tally, residual);
        // Beyond the clamp: counted as seen, kept out of the scale
        foldJitter(tally, 9000);

        const summary = summarize(tally);
        expect(summary.discarded).toBe(2);
        expect(summary.jitter.seen).toBe(8);
        expect(summary.jitter.n).toBe(7);
        // The two far-out residuals do not drag a median-based scale
        expect(summary.jitter.sd).toBeLessThan(30);
    });
});

describe('robustScale and percentile', () => {
    it('is unmoved by a contaminated tail', () => {
        const clean = robustScale([-2, -1, 0, 1, 2]);
        const dirty = robustScale([-2, -1, 0, 1, 2, 1800, 1900]);
        expect(clean.median).toBe(0);
        expect(dirty.median).toBe(1);
        expect(dirty.sd).toBeLessThan(5);
    });

    it('returns nothing from nothing', () => {
        expect(robustScale([])).toBeNull();
        expect(percentile([], 0.5)).toBeNull();
    });
});

describe('against recordings this repo already has', () => {
    /**
     * Replay a stored recording through the watch. `at` is milliseconds from
     * the start of the recording, which is the same clock on both ends of a
     * gap, so the intervals it yields are the real ones.
     * @param {Object} recording - A combat recording fixture
     * @param {Object} context - Zone context to replay it under
     * @returns {Object} What the watch produced over the whole file
     */
    function replay(recording, context) {
        const watch = createWaveGapWatch();
        const observations = [];
        const jitter = [];
        const reasons = [];
        let clock = 0;
        for (const entry of recording.ticks) {
            if (entry.at !== undefined) clock = entry.at;
            if (entry.type === 'new_battle') watch.newBattle(entry.payload, clock, context);
            else watch.battleUpdated(entry.payload, clock, {});
            const drained = watch.drain();
            observations.push(...drained.observations);
            jitter.push(...drained.jitter);
            reasons.push(...drained.discards);
        }
        return { observations, jitter, reasons };
    }

    it('finds the open-zone respawns in a recorded run', () => {
        const { observations, reasons } = replay(recordedRun, OPEN);
        expect(reasons).toEqual([]);
        expect(observations.map((entry) => entry.gapMs)).toEqual([3011, 2898, 3038, 3032, 3042]);
        // Five intervals cannot separate 3000 from 3037 and the code should not
        // pretend otherwise: the interval on this mean straddles both
        const tally = emptyTally();
        for (const observation of observations) foldObservation(tally, observation);
        const open = summarize(tally).categories[CATEGORIES.openZone];
        expect(open.low).toBeLessThan(3000);
        expect(open.high).toBeGreaterThan(3037);
    });

    it('measures its own arrival noise off the intervals the server stated', () => {
        const { jitter } = replay(recordedFight, OPEN);
        expect(jitter.length).toBeGreaterThan(20);
        const scale = robustScale(jitter.filter((residual) => Math.abs(residual) < 2000));
        // Centred on zero, which is what makes `int` usable as a ruler at all
        expect(Math.abs(scale.median)).toBeLessThan(5);
        // And wide enough that a single reading cannot resolve a 67 ms range
        expect(scale.sd).toBeGreaterThan(5);
    });
});
