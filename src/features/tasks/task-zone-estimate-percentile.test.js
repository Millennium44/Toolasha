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
