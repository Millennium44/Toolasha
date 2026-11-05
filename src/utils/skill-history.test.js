import { describe, test, expect } from 'vitest';
import { createSkillHistory } from './skill-history.js';

const MINUTE = 60 * 1000;
const at = (experience) => [{ skillHrid: '/skills/melee', experience }];

describe('createSkillHistory', () => {
    test('two readings far enough apart make a rate', () => {
        const tracker = createSkillHistory();
        tracker.sample(at(0), 0);
        tracker.sample(at(1000), 60 * MINUTE);

        expect(tracker.rateFor('/skills/melee')).toBeCloseTo(1000, 6);
    });

    test('a window too short to divide is no rate rather than a wild one', () => {
        const tracker = createSkillHistory();
        tracker.sample(at(0), 0);
        tracker.sample(at(1000), 10 * 1000);

        expect(tracker.rateFor('/skills/melee')).toBeNull();
    });

    test('readings are not taken faster than the sampling interval', () => {
        const tracker = createSkillHistory({ sampleMs: 5000 });
        tracker.sample(at(0), 0);
        tracker.sample(at(500), 1000);

        expect(tracker.readings('/skills/melee')).toHaveLength(1);
    });

    test('a skill nobody has read has no rate and no readings', () => {
        const tracker = createSkillHistory();
        expect(tracker.rateFor('/skills/magic')).toBeNull();
        expect(tracker.readings('/skills/magic')).toEqual([]);
    });
});

describe('the window', () => {
    test('readings older than the window are dropped', () => {
        const tracker = createSkillHistory({ windowMs: 10 * MINUTE, sampleMs: 1 });
        for (let minute = 0; minute <= 30; minute++) tracker.sample(at(minute * 100), minute * MINUTE);

        const readings = tracker.readings('/skills/melee');
        expect(readings[0].t).toBeGreaterThanOrEqual(19 * MINUTE);
    });

    test('the reading just outside the window survives, since it is the far end', () => {
        // Dropping it would leave one reading and nothing to measure against
        const tracker = createSkillHistory({ windowMs: 10 * MINUTE, sampleMs: 1 });
        tracker.sample(at(0), 0);
        tracker.sample(at(5000), 60 * MINUTE);

        expect(tracker.readings('/skills/melee')).toHaveLength(2);
        expect(tracker.rateFor('/skills/melee')).toBeCloseTo(5000, 6);
    });
});

describe('readings that are not progress', () => {
    test('experience below the last reading is a different character', () => {
        const tracker = createSkillHistory();
        tracker.sample(at(1000000), 0);
        tracker.sample(at(50), 10 * MINUTE);

        // The old reading is gone rather than subtracted across
        expect(tracker.readings('/skills/melee')).toEqual([{ t: 10 * MINUTE, xp: 50 }]);
        expect(tracker.rateFor('/skills/melee')).toBeNull();
    });

    test('and the measurement starts again from there', () => {
        const tracker = createSkillHistory();
        tracker.sample(at(1000000), 0);
        tracker.sample(at(50), 10 * MINUTE);
        tracker.sample(at(1050), 70 * MINUTE);

        expect(tracker.rateFor('/skills/melee')).toBeCloseTo(1000, 6);
    });

    test('a clock that goes backwards starts again rather than going quiet', () => {
        const tracker = createSkillHistory();
        tracker.sample(at(0), 60 * MINUTE);
        tracker.sample(at(1000), 120 * MINUTE);
        expect(tracker.rateFor('/skills/melee')).toBeCloseTo(1000, 6);

        // An hour lost to a correction leaves the old stamps in the future
        tracker.sample(at(1000), 30 * MINUTE);
        expect(tracker.readings('/skills/melee')).toHaveLength(1);

        tracker.sample(at(2000), 90 * MINUTE);
        expect(tracker.rateFor('/skills/melee')).toBeCloseTo(1000, 6);
    });

    test('a reading with no usable experience is skipped rather than stored', () => {
        const tracker = createSkillHistory();
        tracker.sample([{ skillHrid: '/skills/melee' }, { experience: 5 }], 0);
        expect(tracker.readings('/skills/melee')).toEqual([]);
    });
});

describe('rates', () => {
    test('is every skill that has one, and only those', () => {
        const tracker = createSkillHistory();
        tracker.sample(
            [
                { skillHrid: '/skills/melee', experience: 0 },
                { skillHrid: '/skills/magic', experience: 500 },
            ],
            0
        );
        tracker.sample(
            [
                { skillHrid: '/skills/melee', experience: 1000 },
                { skillHrid: '/skills/magic', experience: 500 },
            ],
            60 * MINUTE
        );

        expect(tracker.rates()).toEqual({ '/skills/melee': 1000 });
    });
});

describe('two trackers do not share a memory', () => {
    test('one clearing does not blank the other', () => {
        const panel = createSkillHistory();
        const overlayRow = createSkillHistory();

        panel.sample(at(0), 0);
        overlayRow.sample(at(0), 0);
        panel.sample(at(1000), 60 * MINUTE);
        overlayRow.sample(at(1000), 60 * MINUTE);

        panel.clear();

        expect(panel.rateFor('/skills/melee')).toBeNull();
        expect(overlayRow.rateFor('/skills/melee')).toBeCloseTo(1000, 6);
    });
});

describe('startAtFirstGain', () => {
    const SEC = 1000;
    /** Nine minutes flat, then a minute of 1,000 xp per minute */
    function nineFlatThenOneActive(options) {
        const tracker = createSkillHistory(options);
        for (let t = 0; t <= 9 * MINUTE; t += 5 * SEC) tracker.sample(at(0), t);
        for (let t = 9 * MINUTE + 5 * SEC, xp = 0; t <= 10 * MINUTE; t += 5 * SEC) {
            xp += 1000 / 12;
            tracker.sample(at(xp), t);
        }
        return tracker;
    }

    test('by default the flat readings before the skill started dilute the rate (the old behavior)', () => {
        const rate = nineFlatThenOneActive({}).rateFor('/skills/melee');
        expect(rate).toBeLessThan(7000);
    });

    test('with the option the rate is measured from just before the first gain', () => {
        const rate = nineFlatThenOneActive({ startAtFirstGain: true }).rateFor('/skills/melee');
        // 1,000 xp a minute is 60,000 an hour
        expect(rate).toBeGreaterThan(59000);
        expect(rate).toBeLessThan(61000);
    });

    test('a skill that never flattened is measured over the whole window as before', () => {
        const tracker = createSkillHistory({ startAtFirstGain: true });
        for (let i = 0; i <= 12; i += 1) tracker.sample(at(i * 100), i * 5 * SEC);
        expect(tracker.rateFor('/skills/melee')).toBeCloseTo(72000, 6);
    });

    test('a pause after the skill has been gaining is part of the measurement, not trimmed', () => {
        const tracker = createSkillHistory({ startAtFirstGain: true });
        tracker.sample(at(0), 0);
        tracker.sample(at(100), 5 * SEC);
        tracker.sample(at(100), 30 * SEC);
        tracker.sample(at(100), 60 * SEC);
        expect(tracker.rateFor('/skills/melee')).toBeCloseTo((100 / 60) * 3600, 6);
    });

    test('a first gain across a sampling gap starts after the gap and reads unmeasured until the next window', () => {
        const tracker = createSkillHistory({ startAtFirstGain: true });
        tracker.sample(at(0), 0);
        tracker.sample(at(0), 5 * SEC);
        // Panel hidden for nine minutes; the skill started somewhere in there
        tracker.sample(at(900), 9 * MINUTE);
        expect(tracker.rateFor('/skills/melee')).toBeNull();
        for (let i = 1; i <= 6; i += 1) tracker.sample(at(900 + i * 100), 9 * MINUTE + i * 5 * SEC);
        const rate = tracker.rateFor('/skills/melee');
        expect(rate).toBeCloseTo((600 / 30) * 3600, 6);
    });

    test('a skill with no gain at all is no rate', () => {
        const tracker = createSkillHistory({ startAtFirstGain: true });
        for (let t = 0; t <= MINUTE; t += 5 * SEC) tracker.sample(at(50), t);
        expect(tracker.rateFor('/skills/melee')).toBeNull();
    });
});
