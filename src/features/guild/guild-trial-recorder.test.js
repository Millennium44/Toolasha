/** @vitest-environment happy-dom */

/**
 * The recorder, over a faked trial.
 *
 * What is worth pinning here is the lifecycle rather than the arithmetic: that a
 * session starts without being asked, that it stops by itself when the trial is
 * over, that the reason it stopped is recorded, and that a session survives the
 * page being reloaded — which is the whole point of writing it down.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    settings: { guildTrialAutoRecord: true },
    store: {},
    breakdown: null,
    characterId: 30404,
    loadouts: { players: {}, updatedAt: 0 },
    record: { weekStart: 0, tiles: {} },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback) => (key in game.settings ? game.settings[key] : fallback),
        getSettingValue: (key, fallback) => fallback,
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => game.characterId,
        getInitClientData: () => ({}),
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) => (key in game.store ? game.store[key] : fallback),
        set: async (key, value) => {
            game.store[key] = value;
            return true;
        },
    },
}));
vi.mock('./guild-trial-damage.js', () => ({
    default: {
        breakdown: () => game.breakdown,
        reset: vi.fn(),
    },
}));
vi.mock('./guild-loadouts.js', () => ({
    loadLoadouts: async () => game.loadouts,
}));
vi.mock('./guild-trials-store.js', () => ({
    loadTrialRecord: async () => game.record,
}));

const { buildTrialExport, guildTrialRecorder, IDLE_STOP_MS, SNAPSHOT_MS, thinBreakdown, trialSessionStorageKey } =
    await import('./guild-trial-recorder.js');

const now = Date.parse('2026-08-05T15:00:00Z');

/**
 * A breakdown as the damage module reports one.
 * @param {Object} overrides - Fields to override
 * @returns {Object} The breakdown
 */
function breakdown(overrides = {}) {
    return {
        measured: true,
        active: true,
        seconds: 60,
        fights: 1,
        totalDamage: 500_000,
        partyDps: 8333,
        reason: 'the monster says it is a trial',
        players: [
            { index: '0', name: 'Tib', damage: 300_000, deaths: 0 },
            { index: '1', name: 'Moo', damage: 200_000, deaths: 1 },
        ],
        support: {
            players: [
                { index: '0', name: 'Tib', healingDone: 0, damageTaken: 90_000 },
                { index: '1', name: 'Moo', healingDone: 40_000, damageTaken: 1_000 },
            ],
            unattributedHealing: 500,
        },
        ...overrides,
    };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    game.settings = { guildTrialAutoRecord: true };
    game.store = {};
    game.breakdown = breakdown();
    guildTrialRecorder.session = null;
    guildTrialRecorder.lastActivityAt = 0;
    guildTrialRecorder.initialize(null);
});

afterEach(() => {
    guildTrialRecorder.cleanup();
    guildTrialRecorder.session = null;
    vi.useRealTimers();
});

describe('thinBreakdown', () => {
    test('keeps what a series needs and drops what repeats', () => {
        const snapshot = thinBreakdown(breakdown(), now);

        expect(snapshot).toMatchObject({ t: now, seconds: 60, totalDamage: 500_000, partyDps: 8333 });
        expect(snapshot.players).toEqual([
            { index: '0', name: 'Tib', damage: 300_000, deaths: 0, healingDone: 0, damageTaken: 90_000 },
            { index: '1', name: 'Moo', damage: 200_000, deaths: 1, healingDone: 40_000, damageTaken: 1_000 },
        ]);
    });

    test('a breakdown with nothing in it thins to nothing rather than throwing', () => {
        expect(thinBreakdown(null, now).players).toEqual([]);
    });
});

describe('starting by itself', () => {
    test('a trial fight starts a session', () => {
        expect(guildTrialRecorder.recording).toBe(false);

        vi.advanceTimersByTime(SNAPSHOT_MS);

        expect(guildTrialRecorder.recording).toBe(true);
        expect(guildTrialRecorder.session.startedBy).toBe('trial-fight');
        expect(guildTrialRecorder.session.snapshots.length).toBeGreaterThan(0);
    });

    test('a reading off the tab starts one too', () => {
        game.breakdown = breakdown({ active: false });
        guildTrialRecorder.noteActivity('tab-reading');

        expect(guildTrialRecorder.recording).toBe(true);
        expect(guildTrialRecorder.session.startedBy).toBe('tab-reading');
    });

    test('switched off, it waits to be asked', () => {
        game.settings = { guildTrialAutoRecord: false };
        vi.advanceTimersByTime(SNAPSHOT_MS * 2);

        expect(guildTrialRecorder.recording).toBe(false);

        // The button still works
        guildTrialRecorder.start('button');
        expect(guildTrialRecorder.recording).toBe(true);
    });

    test('starting twice is starting once', () => {
        guildTrialRecorder.start('button');
        const first = guildTrialRecorder.session;
        guildTrialRecorder.start('button');
        expect(guildTrialRecorder.session).toBe(first);
    });
});

describe('stopping', () => {
    test('a trial that goes quiet ends the session, and says that is why', () => {
        guildTrialRecorder.start('button');

        game.breakdown = breakdown({ active: false });
        vi.setSystemTime(now + IDLE_STOP_MS + SNAPSHOT_MS);
        vi.advanceTimersByTime(SNAPSHOT_MS);

        expect(guildTrialRecorder.recording).toBe(false);
        expect(guildTrialRecorder.session.endedBy).toBe('nothing seen');
        expect(guildTrialRecorder.session.endedAt).toBeGreaterThan(now);
    });

    test('an hour is as long as a trial runs', () => {
        guildTrialRecorder.start('button');

        // Still active, so it is not the idle rule that fires
        vi.setSystemTime(now + 61 * 60_000);
        guildTrialRecorder.lastActivityAt = now + 61 * 60_000;
        vi.advanceTimersByTime(SNAPSHOT_MS);

        expect(guildTrialRecorder.recording).toBe(false);
        expect(guildTrialRecorder.session.endedBy).toMatch(/hour a trial runs/);
    });

    test('stopping by hand is recorded as by hand', () => {
        guildTrialRecorder.start('button');
        guildTrialRecorder.stop('button');

        expect(guildTrialRecorder.session.endedBy).toBe('button');
        // And written down, so a reload still has it
        expect(game.store[trialSessionStorageKey(null)]).toBeTruthy();
    });

    test('stopping what was never started is not an error', () => {
        expect(guildTrialRecorder.stop('button')).toBeNull();
    });
});

describe('restarting', () => {
    test('ends the old session and opens a new one in a single gesture', () => {
        guildTrialRecorder.start('button');
        const first = guildTrialRecorder.session;

        vi.setSystemTime(now + 30_000);
        const second = guildTrialRecorder.restart();

        expect(first.endedBy).toBe('restarted');
        expect(second).not.toBe(first);
        expect(second.startedAt).toBe(now + 30_000);
        expect(guildTrialRecorder.recording).toBe(true);
    });
});

describe('snapshots', () => {
    test('a series is built while the trial runs', () => {
        guildTrialRecorder.start('button');

        for (let step = 1; step <= 3; step += 1) {
            game.breakdown = breakdown({ totalDamage: 500_000 + step * 100_000, seconds: 60 + step * 15 });
            vi.setSystemTime(now + step * SNAPSHOT_MS);
            vi.advanceTimersByTime(SNAPSHOT_MS);
        }

        const damages = guildTrialRecorder.session.snapshots.map((snapshot) => snapshot.totalDamage);
        expect(damages).toEqual([500_000, 600_000, 700_000, 800_000]);
    });

    test('a trial nobody is fighting does not fill the series with the same reading', () => {
        guildTrialRecorder.start('button');
        const before = guildTrialRecorder.session.snapshots.length;

        vi.advanceTimersByTime(SNAPSHOT_MS * 3);

        expect(guildTrialRecorder.session.snapshots).toHaveLength(before);
    });
});

describe('the export bundle', () => {
    test('carries everything it used to, plus the session and the coverage note', async () => {
        guildTrialRecorder.start('button');
        const bundle = await buildTrialExport({ guildName: 'Milky Way' });

        // Backward compatible: every field an older reader knows is still here
        expect(bundle).toMatchObject({
            guildName: 'Milky Way',
            characterId: 30404,
            record: game.record,
            loadouts: game.loadouts,
        });
        expect(bundle.trialDamage.totalDamage).toBe(500_000);
        expect(typeof bundle.exportedAt).toBe('string');

        // Additive
        expect(bundle.session.startedBy).toBe('button');
        expect(bundle.coverage.damageMitigated).toMatch(/not carried/);
    });

    test('the last session is read back off storage when none is in hand', async () => {
        game.store[trialSessionStorageKey(null)] = { startedAt: 1, endedAt: 2, snapshots: [] };
        guildTrialRecorder.session = null;

        const bundle = await buildTrialExport({});
        expect(bundle.session).toMatchObject({ startedAt: 1, endedAt: 2 });
    });
});
