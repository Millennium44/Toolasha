/**
 * Daily ability checkpoints.
 *
 * The property this file exists for is the keying: an ability's checkpoints are
 * filed under `<characterId>|<abilityHrid>` and never under the hrid alone. The
 * panel's ten-minute history was keyed on the hrid, and switching between two
 * characters who both know Puncture read as one of them gaining the whole gap
 * between their totals — a rate in the tens of millions per hour. In a series
 * kept on disk the same mistake would not fall out of a window; it would be
 * wrong for as long as the file lasts.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
    charId: 'char-1',
    characterData: {},
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
        on: (event, handler) => state.handlers.set(event, handler),
        off: (event) => state.handlers.delete(event),
    },
}));

const {
    abilityCheckpoints,
    checkpoints,
    checkpointRate,
    rateFor,
    rateWindowLabel,
    seriesKey,
    startDayFor,
    checkpointsFor,
} = await import('./ability-checkpoints.js');

const PUNCTURE = '/abilities/puncture';

/** Local noon, so no timezone offset can move a day id */
const noon = (year, month, day) => new Date(year, month - 1, day, 12).getTime();

/** One checkpoint per day from 2026-03-01, for one character's ability */
const series = (charId, totals) =>
    totals.map((xp, index) => ({
        d: `2026-03-${String(index + 1).padStart(2, '0')}`,
        k: `${charId}|${PUNCTURE}`,
        xp,
        level: 1,
    }));

beforeEach(() => {
    state.charId = 'char-1';
    state.characterData = { characterAbilities: [{ abilityHrid: PUNCTURE, experience: 1000, level: 4 }] };
    state.quota = false;
    state.stored = [];
    state.saved = null;
    state.handlers.clear();
    abilityCheckpoints.cleanup();
    checkpoints.forget();

    checkpoints._store.load = vi.fn(async () => state.stored.map((entry) => ({ ...entry })));
    checkpoints._store.save = vi.fn(async (charId, entries) => {
        state.saved = { charId, entries: entries.map((entry) => ({ ...entry })) };
        return true;
    });
    checkpoints._store.forget = vi.fn();
});

describe('per-character keying', () => {
    test('the series key names the character as well as the ability', () => {
        expect(seriesKey('char-1', PUNCTURE)).toBe(`char-1|${PUNCTURE}`);
        expect(seriesKey(null, PUNCTURE)).toBeNull();
        expect(seriesKey('char-1', null)).toBeNull();
    });

    test('a checkpoint is written under the current character’s key', async () => {
        await abilityCheckpoints._capture();
        expect(state.saved.entries[0].k).toBe(`char-1|${PUNCTURE}`);
    });

    test('two characters who know the same ability keep two separate series', () => {
        // char-2 is an ironcow with far less experience in the same ability.
        // Keyed on the hrid alone these would be one series, and the switch
        // between them would read as a gain of everything between them
        const entries = [...series('char-1', [0, 100, 200, 300]), ...series('char-2', [9_000_000])];

        expect(checkpointRate(entries, 'char-1', PUNCTURE).gained).toBe(300);
        expect(checkpointRate(entries, 'char-2', PUNCTURE)).toBeNull();
    });

    test('the arriving character reads none of the departing one’s checkpoints', async () => {
        await abilityCheckpoints._capture();
        expect(checkpointsFor(PUNCTURE)).toHaveLength(1);

        await abilityCheckpoints.initialize();
        state.handlers.get('character_switching')();

        expect(checkpointsFor(PUNCTURE)).toEqual([]);
        expect(rateFor(PUNCTURE)).toBeNull();
    });

    test('a switch landing inside the read writes nothing under the arriving character', async () => {
        let release;
        const gate = new Promise((resolve) => (release = resolve));
        checkpoints._store.load = vi.fn(async () => {
            await gate;
            return [];
        });

        const capturing = abilityCheckpoints._capture();
        state.charId = 'char-2';
        checkpoints.forget();
        release();

        expect(await capturing).toBe(0);
        expect(state.saved).toBeNull();
    });
});

describe('once a day', () => {
    test('a second capture the same day leaves the morning’s reading alone', async () => {
        await abilityCheckpoints._capture();
        const first = state.saved;

        state.characterData = { characterAbilities: [{ abilityHrid: PUNCTURE, experience: 8000, level: 6 }] };
        await abilityCheckpoints._capture();

        expect(state.saved).toEqual(first);
    });

    test('an ability with no experience reported is not checkpointed', async () => {
        state.characterData = { characterAbilities: [{ abilityHrid: PUNCTURE, level: 4 }] };
        expect(await abilityCheckpoints._capture()).toBe(0);
    });
});

describe('the rate, and the window it must be read with', () => {
    test('an idle stretch is a true zero in the rate and a named absence in the label', () => {
        // Fifteen days, gains on three of them
        const totals = [0, 0, 0, 0, 0, 24000, 48000, 72000, 72000, 72000, 72000, 72000, 72000, 72000, 72000];
        const rate = checkpointRate(series('char-1', totals), 'char-1', PUNCTURE);

        expect(rate.days).toBe(14);
        expect(rate.daysWithGain).toBe(3);
        expect(rate.gained).toBe(72000);
        // 72,000 over a fortnight, not over the three days it was earned in —
        // and over the fortnight's real elapsed hours, which in a zone that
        // changes its clocks inside the window is not fourteen times twenty-four
        const elapsedHours = (new Date(2026, 2, 15) - new Date(2026, 2, 1)) / 3_600_000;
        expect(rate.experiencePerHour).toBeCloseTo(72000 / elapsedHours, 6);
        expect(rateWindowLabel(rate)).toBe('measured over 14 days, 3 with combat');
    });

    test('the label puts one day in the singular', () => {
        expect(rateWindowLabel({ days: 1, daysWithGain: 1 })).toBe('measured over 1 day, 1 with combat');
    });

    test('a window shorter than three days falls back rather than reporting', () => {
        expect(checkpointRate(series('char-1', [0, 100, 200]), 'char-1', PUNCTURE)).toBeNull();
        expect(checkpointRate(series('char-1', [0, 100, 200, 300]), 'char-1', PUNCTURE)).not.toBeNull();
    });

    test('a long window with no combat in it at all has no rate', () => {
        expect(checkpointRate(series('char-1', [500, 500, 500, 500, 500]), 'char-1', PUNCTURE)).toBeNull();
    });

    test('nothing recorded yet is a fallback to the live rate, not a zero', () => {
        expect(rateFor(PUNCTURE)).toBeNull();
        expect(startDayFor(PUNCTURE)).toBeNull();
    });

    test('the rate read from memory is the current character’s', async () => {
        state.stored = series('char-1', [0, 24000, 48000, 72000, 96000]);
        await abilityCheckpoints._capture(noon(2026, 3, 6));

        const rate = rateFor(PUNCTURE);
        expect(rate.daysWithGain).toBeGreaterThanOrEqual(4);
        expect(startDayFor(PUNCTURE)).toBe('2026-03-01');
    });
});
