/**
 * The Balanced score in a dungeon: a failed run (a party wipe) loses the key and the run's time, which
 * deaths per hour alone did not price. Outside a dungeon the score must not move at all.
 */
import { describe, test, expect } from 'vitest';
import {
    DEATH_POINTS_PER_PER_HOUR,
    DUNGEON_FAIL_POINTS_PER_PER_HOUR,
    balancedScore,
    objectiveScore,
    scopeMetrics,
    runTriggerSearch,
    PRECISIONS,
    KIND_ALLY_PCT,
} from './trigger-tuning.js';
import { objectiveFooterText } from './trigger-optimizer-view.js';

const base = { xp: 1000, profit: 2000, deaths: 1, dps: 100, encounters: 10 };

describe('failed dungeon runs in the score', () => {
    test('one extra failed run per hour costs clearly more than one extra death per hour', () => {
        const oneDeath = balancedScore({ ...base, deaths: 2 }, base);
        const oneFailure = balancedScore({ ...base, failedRuns: 1 }, { ...base, failedRuns: 0 });
        expect(oneDeath).toBeCloseTo(-DEATH_POINTS_PER_PER_HOUR, 6);
        expect(oneFailure).toBeCloseTo(-DUNGEON_FAIL_POINTS_PER_PER_HOUR, 6);
        expect(DUNGEON_FAIL_POINTS_PER_PER_HOUR).toBeGreaterThanOrEqual(2 * DEATH_POINTS_PER_PER_HOUR);
    });

    test('fewer failures score a gain, and the term stacks with the death term outside the average', () => {
        const baseline = { ...base, failedRuns: 2 };
        expect(balancedScore({ ...base, failedRuns: 1 }, baseline)).toBeCloseTo(DUNGEON_FAIL_POINTS_PER_PER_HOUR, 6);
        const worse = { ...base, deaths: 2, failedRuns: 2.5 };
        expect(balancedScore(worse, baseline)).toBeCloseTo(
            -DEATH_POINTS_PER_PER_HOUR - 0.5 * DUNGEON_FAIL_POINTS_PER_PER_HOUR,
            6
        );
    });

    test('the term is clamped like the others', () => {
        expect(balancedScore({ ...base, failedRuns: 50 }, { ...base, failedRuns: 0 })).toBeCloseTo(-100, 6);
    });

    test('XP/h and Profit/h objectives pay it too', () => {
        const worse = { ...base, failedRuns: 1 };
        const baseline = { ...base, failedRuns: 0 };
        expect(objectiveScore(worse, baseline, 'xp')).toBeCloseTo(-DUNGEON_FAIL_POINTS_PER_PER_HOUR, 6);
        expect(objectiveScore(worse, baseline, 'profit')).toBeCloseTo(-DUNGEON_FAIL_POINTS_PER_PER_HOUR, 6);
    });

    test('metrics with no failure figure (every non-dungeon zone) score exactly as before', () => {
        const better = { xp: 1100, profit: 2200, deaths: 1.5, dps: 110, encounters: 11 };
        expect(balancedScore(better, base)).toBeCloseTo(10 - 5, 6);
        // Equal on both sides is also nothing, even when the figure is present
        expect(balancedScore({ ...better, failedRuns: 3 }, { ...base, failedRuns: 3 })).toBeCloseTo(10 - 5, 6);
        expect(scopeMetrics({ perPlayer: {}, encounters: 0 }, []).failedRuns).toBe(0);
    });

    test('scopeMetrics reads the sample dungeon figure once, not per player', () => {
        const sample = {
            perPlayer: { a: { deaths: 1 }, b: { deaths: 1 } },
            encounters: 0,
            dungeon: { failedPerHour: 0.75, completedPerHour: 3 },
        };
        expect(scopeMetrics(sample, ['a', 'b']).failedRuns).toBe(0.75);
    });
});

describe('the score footer', () => {
    test('mentions failed runs only for a dungeon', () => {
        expect(objectiveFooterText('balanced')).not.toMatch(/failed/);
        expect(objectiveFooterText('balanced', { dungeon: true })).toContain(
            `${DUNGEON_FAIL_POINTS_PER_PER_HOUR} per extra failed dungeon run per hour`
        );
        expect(objectiveFooterText('xp', { dungeon: true })).toMatch(/failed dungeon run/);
        expect(objectiveFooterText('balanced', { dungeon: false })).toBe(objectiveFooterText('balanced'));
    });
});

describe('runTriggerSearch in a dungeon', () => {
    const TARGET = '/combat_trigger_dependencies/all_allies';
    const LOWEST = '/combat_trigger_conditions/lowest_hp_percentage';
    const LTE = '/combat_trigger_comparators/less_than_equal';
    const tunable = {
        key: 'player1|abilities|/abilities/quick_aid|0',
        playerIndex: 0,
        playerHrid: 'player1',
        playerName: 'Healer',
        slotType: 'abilities',
        slotIndex: 0,
        itemHrid: '/abilities/quick_aid',
        itemName: 'Quick Aid',
        rowIndex: 0,
        kind: KIND_ALLY_PCT,
        dependencyHrid: TARGET,
        conditionHrid: LOWEST,
        comparatorHrid: LTE,
        original: 0,
        fromDefault: false,
        baseRows: [{ dependencyHrid: TARGET, conditionHrid: LOWEST, comparatorHrid: LTE, value: 0 }],
    };

    // The row's value is the fraction of wipes avoided: a higher threshold heals earlier and wipes less
    const measureFor =
        (dungeon) =>
        async (overrides, hours, stream, count, offset = 0) =>
            Array.from({ length: count }, (_, k) => {
                const value = overrides[tunable.key] ?? tunable.original;
                const noise = (((offset + k) * 7919) % 13) / 1000;
                const sample = {
                    perPlayer: {
                        player1: { xp: 1000, profit: 0, revenue: 0, cost: 0, deaths: 1, dps: 100, unpriced: [] },
                    },
                    encounters: 10,
                    pools: { player1: { hp: 1000, mp: 500 } },
                    triggerUse: { player1: { '/abilities/quick_aid': 50 } },
                };
                if (dungeon)
                    sample.dungeon = { failedPerHour: Math.max(0, 3 - value / 25) + noise, completedPerHour: 5 };
                else sample.perPlayer.player1.deaths = 1;
                return sample;
            });

    const run = (dungeon) =>
        runTriggerSearch({
            tunables: [tunable],
            scopeHrids: ['player1'],
            measure: measureFor(dungeon),
            precision: PRECISIONS.quick,
            minGain: 0.5,
        });

    test('a heal threshold that avoids wipes is recommended, and the result says the zone is a dungeon', async () => {
        const result = await run(true);
        expect(result.dungeon).toBe(true);
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0].to).toBeGreaterThan(tunable.original);
        expect(result.changes[0].deltaScore).toBeGreaterThan(10);
    });

    test('with no failure figure on the samples nothing is recommended and the result is not a dungeon', async () => {
        const result = await run(false);
        expect(result.dungeon).toBe(false);
        expect(result.changes).toHaveLength(0);
    });
});
