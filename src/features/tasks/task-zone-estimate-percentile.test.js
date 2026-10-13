/** @vitest-environment happy-dom */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ value: undefined }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSettingValue: (key, fallback) =>
            key === 'taskCombatEstimatePercentile' && h.value !== undefined ? h.value : fallback,
    },
}));

import { getSettingDefinition } from '../../core/settings-schema.js';
import { fightsForKillConfidence } from '../../utils/fight-confidence.js';
import {
    createMedianHint,
    formatPercentSuffix,
    getZoneEstimatePercent,
    zoneBottleneckEstimate,
    zoneFightEstimate,
    ZONE_ESTIMATE_PERCENTS,
} from './task-zone-estimate-percentile.js';

beforeEach(() => {
    h.value = undefined;
});

/** A rare bottleneck: 20 kills wanted at a tenth of a kill a fight, 50 fights an hour */
const rare = {
    meanFights: 200,
    meanHours: 4,
    fightsPerHour: 50,
    killsNeeded: 20,
    killsPerFight: 0.1,
    slotsPerFight: 1,
};

describe('the setting', () => {
    test('defaults to 90%, the maintainer-chosen default, and offers exactly the four coverages', () => {
        const def = getSettingDefinition('taskCombatEstimatePercentile');
        expect(def.default).toBe('90');
        expect(def.options.map((o) => Number(o.value))).toEqual(ZONE_ESTIMATE_PERCENTS);
        expect(getZoneEstimatePercent()).toBe(90);
    });

    test('reads the chosen coverage, and an unrecognized value as the default', () => {
        h.value = '95';
        expect(getZoneEstimatePercent()).toBe(95);
        h.value = '50';
        expect(getZoneEstimatePercent()).toBe(50);
        h.value = '77';
        expect(getZoneEstimatePercent()).toBe(90);
        h.value = 'garbage';
        expect(getZoneEstimatePercent()).toBe(90);
    });
});

describe('zoneFightEstimate', () => {
    test('quotes the quantile from the fight-confidence engine, and turns it into hours', () => {
        const est = zoneFightEstimate({ ...rare, percent: 90 });
        const p90 = fightsForKillConfidence({
            killsNeeded: 20,
            killsPerFight: 0.1,
            slotsPerFight: 1,
            confidencePercent: 90,
        });
        expect(est.fightsNeeded).toBe(p90);
        expect(est.fightsNeeded).toBeGreaterThan(rare.meanFights);
        expect(est.hoursNeeded).toBeCloseTo(p90 / 50);
        expect(est.percent).toBe(90);
    });

    test('higher coverage asks for more fights; the median sits near the mean', () => {
        const at = (percent) => zoneFightEstimate({ ...rare, percent }).fightsNeeded;
        expect(at(50)).toBeLessThan(at(80));
        expect(at(80)).toBeLessThan(at(90));
        expect(at(90)).toBeLessThan(at(95));
        const est = zoneFightEstimate({ ...rare, percent: 90 });
        expect(Math.abs(est.medianFightsNeeded - rare.meanFights)).toBeLessThan(15);
        expect(est.medianHoursNeeded).toBeCloseTo(est.medianFightsNeeded / 50);
    });

    test('a boss bottleneck keeps the mean: its kill count is arithmetic', () => {
        expect(zoneFightEstimate({ ...rare, deterministic: true, percent: 90 })).toEqual({
            fightsNeeded: 200,
            hoursNeeded: 4,
            percent: null,
            medianFightsNeeded: null,
            medianHoursNeeded: null,
        });
    });

    test('an unknown kill rate or an uncleared zone keeps the mean', () => {
        expect(zoneFightEstimate({ ...rare, killsPerFight: null, percent: 90 }).percent).toBeNull();
        expect(zoneFightEstimate({ ...rare, fightsPerHour: 0, percent: 90 }).percent).toBeNull();
        const never = zoneFightEstimate({ ...rare, meanFights: Infinity, meanHours: Infinity, percent: 90 });
        expect(never.fightsNeeded).toBe(Infinity);
        expect(never.percent).toBeNull();
    });
});

describe('labels', () => {
    test('the suffix names the coverage, and nothing for the mean', () => {
        expect(formatPercentSuffix(90)).toBe(' (90%)');
        expect(formatPercentSuffix(null)).toBe('');
    });

    test('the hint gives the median, and is absent at the median or for the mean', () => {
        const est = zoneFightEstimate({ ...rare, percent: 90 });
        const hint = createMedianHint(est);
        expect(hint.textContent).toBe('?');
        expect(hint.title).toContain('Planning for 90% confidence. Median (50%): ~');
        expect(createMedianHint(zoneFightEstimate({ ...rare, percent: 50 }))).toBeNull();
        expect(createMedianHint(zoneFightEstimate({ ...rare, deterministic: true, percent: 90 }))).toBeNull();
    });
});

describe('zoneBottleneckEstimate', () => {
    const entries = [
        { hrid: '/monsters/slime', name: 'Slime', remaining: 110, taskCount: 1 },
        { hrid: '/monsters/ooze', name: 'Ooze', remaining: 10, taskCount: 2 },
    ];
    const simResult = { deaths: { '/monsters/slime': 100, '/monsters/ooze': 10 }, encounters: 100 };

    test('takes the largest per-monster requirement, not the largest mean', () => {
        const est = zoneBottleneckEstimate({ monsterEntries: entries, simResult, percent: 90 });
        const ooze = fightsForKillConfidence({ killsNeeded: 10, killsPerFight: 0.1, confidencePercent: 90 });
        const oozeMedian = fightsForKillConfidence({ killsNeeded: 10, killsPerFight: 0.1, confidencePercent: 50 });
        expect(est.fightsNeeded).toBe(ooze);
        expect(est.hoursNeeded).toBeCloseTo(ooze / 100);
        // The median hint belongs to the monster that set the figure
        expect(est.medianFightsNeeded).toBe(oozeMedian);
        expect(est.limiting).toEqual({ hrid: '/monsters/ooze', name: 'Ooze', taskCount: 2 });
    });

    test('a boss contributes its mean, and a mean that wins shows unlabeled', () => {
        const est = zoneBottleneckEstimate({
            monsterEntries: [{ hrid: '/monsters/boss', name: 'Boss', remaining: 1000, taskCount: 1 }, entries[1]],
            simResult: { deaths: { '/monsters/boss': 50, '/monsters/ooze': 10 }, encounters: 100 },
            isBoss: (hrid) => hrid === '/monsters/boss',
            percent: 90,
        });
        expect(est).toMatchObject({ fightsNeeded: 2000, percent: null, limiting: { name: 'Boss' } });
    });

    test('an uncleared monster makes the whole zone infinite', () => {
        const est = zoneBottleneckEstimate({
            monsterEntries: entries,
            simResult: { deaths: { '/monsters/slime': 100 }, encounters: 100 },
            percent: 90,
        });
        expect(est.fightsNeeded).toBe(Infinity);
        expect(est.limiting.name).toBe('Ooze');
    });

    test('no entries gives null', () => {
        expect(zoneBottleneckEstimate({ monsterEntries: [], simResult, percent: 90 })).toBeNull();
    });
});
