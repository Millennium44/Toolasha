import { describe, test, expect } from 'vitest';
import {
    experiencePerHour,
    experienceToNextLevel,
    timeToNextLevel,
    fastestGaining,
    skillName,
} from './skill-progress.js';

describe('experiencePerHour', () => {
    test('measures the rate over the window', () => {
        expect(experiencePerHour({ t: 0, xp: 0 }, { t: 3600_000, xp: 1000 })).toBe(1000);
    });

    test('a window too short to measure returns nothing, not zero', () => {
        // Zero is a claim that you are gaining no experience, and two seconds
        // cannot support it
        expect(experiencePerHour({ t: 0, xp: 0 }, { t: 2000, xp: 50 })).toBeNull();
    });

    test('experience going backwards is a reset, not a negative rate', () => {
        expect(experiencePerHour({ t: 0, xp: 900 }, { t: 60_000, xp: 100 })).toBeNull();
    });

    test('no movement over a long window is still not a rate', () => {
        expect(experiencePerHour({ t: 0, xp: 500 }, { t: 600_000, xp: 500 })).toBeNull();
    });

    test('survives a missing reading', () => {
        expect(experiencePerHour(null, { t: 1, xp: 1 })).toBeNull();
    });
});

describe('experienceToNextLevel', () => {
    const table = [0, 0, 100, 300, 700];

    test('owes the difference to the next threshold', () => {
        expect(experienceToNextLevel(150, 2, table)).toBe(150);
    });

    test('the cap says nothing rather than zero', () => {
        // Zero would read as "about to level" on a skill that never will
        expect(experienceToNextLevel(700, 4, table)).toBeNull();
    });

    test('past the threshold owes nothing rather than a negative amount', () => {
        expect(experienceToNextLevel(400, 2, table)).toBe(0);
    });

    test('survives no table', () => {
        expect(experienceToNextLevel(100, 1, undefined)).toBeNull();
    });
});

describe('timeToNextLevel', () => {
    const table = [0, 0, 100, 300];

    test('divides what is owed by the rate', () => {
        expect(timeToNextLevel({ experience: 100, level: 2, levelExperienceTable: table, xpPerHour: 200 })).toBe(3600);
    });

    test('no rate means no answer', () => {
        expect(timeToNextLevel({ experience: 100, level: 2, levelExperienceTable: table, xpPerHour: null })).toBeNull();
        expect(timeToNextLevel({ experience: 100, level: 2, levelExperienceTable: table, xpPerHour: 0 })).toBeNull();
    });

    test('the cap has no answer even at a healthy rate', () => {
        expect(timeToNextLevel({ experience: 300, level: 3, levelExperienceTable: table, xpPerHour: 900 })).toBeNull();
    });
});

describe('fastestGaining', () => {
    test('picks the skill actually moving', () => {
        expect(fastestGaining({ '/skills/melee': 1000, '/skills/defense': 4000 })).toBe('/skills/defense');
    });

    test('nothing moving is nobody, not the first one', () => {
        expect(fastestGaining({ '/skills/melee': 0 })).toBeNull();
        expect(fastestGaining({})).toBeNull();
        expect(fastestGaining(null)).toBeNull();
    });
});

describe('skillName', () => {
    test('reads a hrid as a name', () => {
        expect(skillName('/skills/melee')).toBe('Melee');
        expect(skillName('/skills/cheesesmithing')).toBe('Cheesesmithing');
    });

    test('survives nonsense', () => {
        expect(skillName(null)).toBe('');
    });
});
