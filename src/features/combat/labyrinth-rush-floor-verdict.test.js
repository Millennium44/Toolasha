import { describe, test, expect } from 'vitest';

import {
    rushFloorVerdict,
    attemptFingerprints,
    MIN_TRUSTED_RUNS,
    CLOSE_MEDIAN,
} from './labyrinth-rush-floor-verdict.js';
import { MIN_LAB_FIGHTS } from './labyrinth-replay-check.js';

/**
 * A recorded losing fight that ended with `remainder` of the monster standing.
 * @param {number} remainder - Fraction left, 0..1
 * @param {Object} [over] - Fields to override
 * @returns {Object}
 */
function loss(remainder, over = {}) {
    return {
        cleared: false,
        outcome: 'death',
        complete: true,
        monsterHpLeft: remainder,
        fingerprint: 'gear-a',
        ...over,
    };
}

/**
 * `n` losses all ending at the same remainder.
 * @param {number} n - How many
 * @param {number} remainder - Fraction left, 0..1
 * @param {Object} [over] - Fields to override on each
 * @returns {Array<Object>}
 */
function losses(n, remainder, over = {}) {
    return Array.from({ length: n }, () => loss(remainder, over));
}

/**
 * A trusted ledger run that spent `torches`.
 * @param {number} torches - Torches spent
 * @returns {Object}
 */
function run(torches) {
    return { startTrusted: true, floor: 7, spent: { torch: torches } };
}

describe('attemptFingerprints', () => {
    test('collects the distinct gear the fights were fought in', () => {
        expect(attemptFingerprints([loss(0.1), loss(0.1, { fingerprint: 'gear-b' }), loss(0.1)]).sort()).toEqual([
            'gear-a',
            'gear-b',
        ]);
    });

    test('an unfingerprinted fight is unknown, not a second cohort', () => {
        expect(attemptFingerprints([loss(0.1), loss(0.1, { fingerprint: null })])).toEqual(['gear-a']);
        expect(attemptFingerprints([])).toEqual([]);
        expect(attemptFingerprints(null)).toEqual([]);
    });
});

describe('rushFloorVerdict — the verdicts', () => {
    test('close losses and spare torches: supported', () => {
        const result = rushFloorVerdict({
            attempts: losses(14, 0.08),
            runs: [run(300), run(290), run(310)],
            torchCap: 510,
        });

        expect(result.verdict).toBe('supported');
        expect(result.reason).toBeNull();
        expect(result.text).toBe(
            'losses end at 8.0% median (n=14) and runs return 210 torches spare — lowering the rush floor is supported'
        );
    });

    test('distant losses: not close, and the headroom is not quoted at it', () => {
        const result = rushFloorVerdict({
            attempts: losses(14, 0.47),
            runs: [run(300), run(290), run(310)],
            torchCap: 510,
        });

        expect(result.verdict).toBe('not-close');
        expect(result.text).toBe("losses aren't close — they end at 47% median (n=14), and supply headroom won't help");
        expect(result.text).not.toContain('spare');
    });

    test('close losses but no spare torches: not supported, and it says which half failed', () => {
        const result = rushFloorVerdict({
            attempts: losses(14, 0.08),
            runs: [run(500), run(505), run(510)],
            torchCap: 500,
        });

        expect(result.verdict).toBe('no-headroom');
        expect(result.text).toContain('8.0% median (n=14)');
        expect(result.text).toContain('no torches spare');
    });

    test('the close/not-close boundary sits at CLOSE_MEDIAN, inclusive', () => {
        const runs = [run(300), run(290), run(310)];
        expect(rushFloorVerdict({ attempts: losses(9, CLOSE_MEDIAN), runs, torchCap: 510 }).verdict).toBe('supported');
        expect(rushFloorVerdict({ attempts: losses(9, CLOSE_MEDIAN + 0.01), runs, torchCap: 510 }).verdict).toBe(
            'not-close'
        );
    });

    test('a zero torch capacity is no headroom rather than infinite headroom', () => {
        const result = rushFloorVerdict({
            attempts: losses(14, 0.05),
            runs: [run(10), run(10), run(10)],
            torchCap: 0,
        });
        expect(result.verdict).toBe('no-headroom');
        expect(result.headroom).toBeNull();
    });
});

describe('rushFloorVerdict — the refusals', () => {
    test('refuses below the near-miss minimum, naming the shortfall', () => {
        const result = rushFloorVerdict({
            attempts: losses(MIN_LAB_FIGHTS - 1, 0.05),
            runs: [run(300), run(290), run(310)],
            torchCap: 510,
        });

        expect(result.verdict).toBe('refused');
        expect(result.reason).toBe('too-few-losses');
        expect(result.text).toContain(`${MIN_LAB_FIGHTS} a median needs`);
        expect(result.text).not.toContain('supported');
    });

    test('an incomplete loss is not a usable loss, so it does not lift the count', () => {
        const result = rushFloorVerdict({
            attempts: [...losses(4, 0.05), ...losses(6, 0.05, { complete: false })],
            runs: [run(300), run(290), run(310)],
            torchCap: 510,
        });
        expect(result.reason).toBe('too-few-losses');
    });

    test('refuses across a gear-fingerprint boundary before it looks at anything else', () => {
        const result = rushFloorVerdict({
            // Plenty of losses and plenty of headroom — and it still refuses
            attempts: [...losses(20, 0.05), ...losses(20, 0.05, { fingerprint: 'gear-b' })],
            runs: [run(300), run(290), run(310)],
            torchCap: 510,
        });

        expect(result.verdict).toBe('refused');
        expect(result.reason).toBe('gear-changed');
        expect(result.text).toContain('old gear');
        expect(result.text).not.toContain('median');
    });

    test('refuses when every fight was fought in gear that is no longer worn', () => {
        const result = rushFloorVerdict({
            attempts: losses(20, 0.05),
            runs: [run(300), run(290), run(310)],
            torchCap: 510,
            currentFingerprint: 'gear-b',
        });

        expect(result.reason).toBe('gear-changed');
        expect(result.text).toContain('no longer wearing');
    });

    test('an unknown current fingerprint abstains rather than refusing', () => {
        const result = rushFloorVerdict({
            attempts: losses(20, 0.05),
            runs: [run(300), run(290), run(310)],
            torchCap: 510,
            currentFingerprint: null,
        });
        expect(result.verdict).toBe('supported');
    });

    test('snapshots that have not landed cannot make the pool look stale', () => {
        const result = rushFloorVerdict({
            attempts: losses(20, 0.05),
            runs: [run(300), run(290), run(310)],
            torchCap: 510,
            currentFingerprint: 'gear-b',
            snapshotsReady: false,
        });
        expect(result.verdict).toBe('supported');
    });

    test(`refuses under ${MIN_TRUSTED_RUNS} trusted runs of supply data`, () => {
        const result = rushFloorVerdict({
            attempts: losses(14, 0.05),
            runs: [run(300), run(290)],
            torchCap: 510,
        });

        expect(result.verdict).toBe('refused');
        expect(result.reason).toBe('too-few-runs');
        expect(result.text).toContain(`${MIN_TRUSTED_RUNS} an average needs`);
    });

    test('untrusted runs do not count towards the supply minimum', () => {
        const untrusted = { startTrusted: false, floor: 7, spent: { torch: 300 } };
        const result = rushFloorVerdict({
            attempts: losses(14, 0.05),
            runs: [run(300), untrusted, untrusted],
            torchCap: 510,
        });

        expect(result.reason).toBe('too-few-runs');
        expect(result.text).toContain('only 1 trusted run of torch spend');
    });

    test('no runs at all is the same refusal, not a crash', () => {
        const result = rushFloorVerdict({ attempts: losses(14, 0.05), runs: [], torchCap: 510 });
        expect(result.reason).toBe('too-few-runs');
        expect(result.burn).toBeNull();
    });

    test('nothing recorded at all refuses on the losses, which is the first thing missing', () => {
        const result = rushFloorVerdict({});
        expect(result.verdict).toBe('refused');
        expect(result.reason).toBe('too-few-losses');
    });

    test('the minimums are injectable', () => {
        const attempts = losses(2, 0.05);
        const runs = [run(300)];
        expect(rushFloorVerdict({ attempts, runs, torchCap: 510 }, { minLosses: 2, minRuns: 1 }).verdict).toBe(
            'supported'
        );
    });
});
