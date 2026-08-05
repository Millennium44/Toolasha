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
