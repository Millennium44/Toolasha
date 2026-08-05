import { describe, test, expect } from 'vitest';
import { beginSession, sessionProgress, sessionIsStale } from './exp-session.js';

const MINUTE = 60 * 1000;
const readings = (values) => Object.entries(values).map(([hrid, experience]) => ({ hrid, experience }));

describe('beginSession', () => {
    test('records what every skill was at', () => {
        const session = beginSession(readings({ '/skills/melee': 500, '/skills/defense': 200 }), 1000);
        expect(session).toEqual({ startedAt: 1000, baseline: { '/skills/melee': 500, '/skills/defense': 200 } });
    });

    test('ignores a skill with no readable experience', () => {
        const session = beginSession([{ hrid: '/skills/melee' }, { experience: 5 }], 0);
        expect(session.baseline).toEqual({});
    });
});

describe('sessionProgress', () => {
    const session = beginSession(readings({ '/skills/melee': 1000, '/skills/defense': 500 }), 0);

    test('is the difference, per skill and in total', () => {
        const now = 60 * MINUTE;
        const result = sessionProgress(session, readings({ '/skills/melee': 4000, '/skills/defense': 1500 }), now);

        expect(result.total).toBe(4000);
        expect(result.perHour).toBeCloseTo(4000, 6);
        expect(result.bySkill).toEqual([
            { hrid: '/skills/melee', gained: 3000, perHour: 3000 },
            { hrid: '/skills/defense', gained: 1000, perHour: 1000 },
        ]);
    });

    test('a window too short to divide reports no rate rather than a wild one', () => {
        // Ten seconds and one drop would read as tens of millions an hour
        const result = sessionProgress(session, readings({ '/skills/melee': 1100 }), 10 * 1000);
        expect(result.total).toBe(100);
        expect(result.perHour).toBeNull();
    });

    test('a skill that appeared mid-session is not credited with its whole history', () => {
        // The game sends the skill list in pieces, and counting from zero would
        // book a hundred thousand experience as this session's work
        const result = sessionProgress(session, readings({ '/skills/magic': 100000 }), 60 * MINUTE);
        expect(result.total).toBe(0);
    });

    test('experience going backwards is nothing gained, not a negative rate', () => {
        const result = sessionProgress(session, readings({ '/skills/melee': 400 }), 60 * MINUTE);
        expect(result.total).toBe(0);
    });
});

describe('sessionIsStale', () => {
    const session = beginSession(readings({ '/skills/melee': 1000 }), 0);

    test('going backwards means a different character', () => {
        expect(sessionIsStale(session, readings({ '/skills/melee': 10 }))).toBe(true);
    });

    test('going forwards is just progress', () => {
        expect(sessionIsStale(session, readings({ '/skills/melee': 1001 }))).toBe(false);
    });

    test('an unseen skill is not evidence of anything', () => {
        expect(sessionIsStale(session, readings({ '/skills/magic': 0 }))).toBe(false);
    });
});
