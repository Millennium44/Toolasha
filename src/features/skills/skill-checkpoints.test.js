/**
 * Daily skill checkpoints: the write path, the character scoping, the sync
 * merge, and the display arithmetic the tooltip prints.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
    charId: 'char-1',
    characterData: {},
    skills: [],
    quota: false,
    stored: [],
    saved: null,
    handlers: new Map(),
}));

vi.mock('../../core/storage.js', () => ({
    default: { isQuotaExceeded: () => state.quota },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterData() {
            return state.characterData;
        },
        getCurrentCharacterId: () => state.charId,
        getSkills: () => state.skills,
        on: (event, handler) => state.handlers.set(event, handler),
        off: (event) => state.handlers.delete(event),
    },
}));

const { mergeForKey } = await import('../../utils/sync-merge-registry.js');
const { checkpoints, skillCheckpoints, monthToDate, monthToDateFor, checkpointsFor, RECORD_PREFIX } =
    await import('./skill-checkpoints.js');

/** Local noon, so no timezone offset can move a day id */
const noon = (year, month, day) => new Date(year, month - 1, day, 12).getTime();

beforeEach(() => {
    state.charId = 'char-1';
    state.characterData = { id: 'char-1' };
    state.skills = [
        { skillHrid: '/skills/milking', experience: 1000, level: 10 },
        { skillHrid: '/skills/cooking', experience: 5000, level: 20 },
    ];
    state.quota = false;
    state.stored = [];
    state.saved = null;
    state.handlers.clear();
    skillCheckpoints.cleanup();
    checkpoints.forget();

    checkpoints._store.load = vi.fn(async () => state.stored.map((entry) => ({ ...entry })));
    checkpoints._store.save = vi.fn(async (charId, entries) => {
        state.saved = { charId, entries: entries.map((entry) => ({ ...entry })) };
        return true;
    });
    checkpoints._store.forget = vi.fn();
});

describe('capturing a day', () => {
    test('writes one checkpoint per skill the first time it runs', async () => {
        await skillCheckpoints._capture();

        expect(state.saved.charId).toBe('char-1');
        expect(state.saved.entries.map((entry) => entry.k)).toEqual(['/skills/milking', '/skills/cooking']);
        expect(state.saved.entries[0]).toMatchObject({ xp: 1000, level: 10 });
    });

    test('a second capture the same day writes nothing, however many events fire', async () => {
        await skillCheckpoints._capture();
        const first = state.saved;

        state.skills = [{ skillHrid: '/skills/milking', experience: 9999, level: 12 }];
        await skillCheckpoints._capture();
        await skillCheckpoints._capture();

        // Same list of entries: the morning's reading is the anchor the month's
        // gain is measured from, and moving it forward would shrink the window
        expect(state.saved).toEqual(first);
    });

    test('a skill the game does not report yet is not invented', async () => {
        state.skills = [{ skillHrid: '/skills/milking' }, { skillHrid: '/skills/cooking', experience: 5000, level: 3 }];
        await skillCheckpoints._capture();

        expect(state.saved.entries.map((entry) => entry.k)).toEqual(['/skills/cooking']);
    });

    test('nothing is written before login', async () => {
        state.charId = null;
        expect(await skillCheckpoints._capture()).toBe(0);
        expect(state.saved).toBeNull();
    });

    test('a full disk writes nothing', async () => {
        state.quota = true;
        expect(await skillCheckpoints._capture()).toBe(0);
        expect(state.saved).toBeNull();
    });
});

describe('character scoping', () => {
    test('a switch landing inside the read means nothing is written under the arriving character', async () => {
        let release;
        const gate = new Promise((resolve) => (release = resolve));
        checkpoints._store.load = vi.fn(async () => {
            await gate;
            return [];
        });

        const capturing = skillCheckpoints._capture();
        state.charId = 'char-2';
        checkpoints.forget();
        release();

        expect(await capturing).toBe(0);
        expect(state.saved).toBeNull();
    });

    test('the arriving character does not read the departing one’s checkpoints', async () => {
        await skillCheckpoints._capture();
        expect(checkpointsFor('/skills/milking')).toHaveLength(1);

        await skillCheckpoints.initialize();
        state.handlers.get('character_switching')();

        expect(checkpointsFor('/skills/milking')).toEqual([]);
    });
});

describe('the sync merge', () => {
    test('two devices’ copies of one month are unioned rather than overwritten', () => {
        const merge = mergeForKey('xpHistory', `${RECORD_PREFIX}_char-1_2026-03`);
        expect(merge?.label).toBe('SkillCheckpoints records');

        const local = [{ d: '2026-03-01', k: '/skills/milking', xp: 100, level: 5 }];
        const incoming = [{ d: '2026-03-02', k: '/skills/milking', xp: 300, level: 6 }];

        expect(merge.merge(local, incoming)).toEqual([local[0], incoming[0]]);
    });

    test('one day recorded on both devices stays one checkpoint', () => {
        const merge = mergeForKey('xpHistory', `${RECORD_PREFIX}_char-1_2026-03`);
        const local = [{ d: '2026-03-01', k: '/skills/milking', xp: 100, level: 5 }];
        // Same day, same skill, a different reading: two truths for one day is
        // exactly what the day-and-series identity exists to prevent
        const incoming = [{ d: '2026-03-01', k: '/skills/milking', xp: 180, level: 5 }];

        expect(merge.merge(local, incoming)).toEqual(local);
    });
});

describe('this month’s gain', () => {
    const entries = [
        { d: '2026-02-20', k: '/skills/milking', xp: 100, level: 5 },
        { d: '2026-03-01', k: '/skills/milking', xp: 500, level: 8 },
        { d: '2026-03-09', k: '/skills/milking', xp: 900, level: 9 },
    ];

    test('is measured from the first checkpoint of the month to the live total', () => {
        expect(monthToDate(entries, '/skills/milking', 1500, noon(2026, 3, 14))).toEqual({
            gained: 1000,
            since: '2026-03-01',
            start: '2026-02-20',
        });
    });

    test('reports the day it really starts from when the month is only partly recorded', () => {
        const partial = [{ d: '2026-03-09', k: '/skills/milking', xp: 900, level: 9 }];
        expect(monthToDate(partial, '/skills/milking', 1500, noon(2026, 3, 14))).toEqual({
            gained: 600,
            since: '2026-03-09',
            start: '2026-03-09',
        });
    });

    test('a month with no checkpoint reports nothing rather than a zero gain', () => {
        expect(monthToDate(entries, '/skills/milking', 1500, noon(2026, 4, 2))).toBeNull();
    });

    test('another skill’s checkpoints are not read as this one’s', () => {
        expect(monthToDate(entries, '/skills/cooking', 1500, noon(2026, 3, 14))).toBeNull();
    });

    test('the tooltip reads what is already in memory, and says nothing before the load lands', async () => {
        expect(monthToDateFor('/skills/milking', 1500)).toBeNull();

        state.stored = [{ d: '2026-03-01', k: '/skills/milking', xp: 500, level: 8 }];
        await skillCheckpoints._capture();

        expect(monthToDateFor('/skills/milking', 1500, noon(2026, 3, 14))).toMatchObject({
            gained: 1000,
            since: '2026-03-01',
        });
    });
});
