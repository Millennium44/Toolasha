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
    settings: { guildTrialAutoRecord: true, guildTrialLedger: true },
    store: {},
    breakdown: null,
    characterId: 30404,
    loadouts: { players: {}, updatedAt: 0 },
    record: { weekStart: 0, tiles: {} },
    traceId: null,
    /** Every call the recorder made into the attendance ledger */
    accrued: [],
    /** The guild's member metas, as the XP tracker would list them */
    members: [],
    /** The sign-up week the tracker would answer with */
    currentWeek: null,
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
    compareTrialStats: ({ reported } = {}) => (reported ? Object.keys(reported).map((name) => ({ name })) : []),
}));
vi.mock('./guild-loadouts.js', () => ({
    loadLoadouts: async () => game.loadouts,
}));
vi.mock('./guild-trials-store.js', () => ({
    loadTrialRecord: async () => game.record,
}));
vi.mock('./guild-member-skills.js', () => ({
    default: { all: () => ({ ada: { name: 'Ada', skills: { '/skills/alchemy': 90 } } }) },
}));
vi.mock('./guild-trial-trace.js', () => ({
    default: { activeTraceId: () => game.traceId },
}));
vi.mock('./guild-trial-abilities.js', () => ({
    default: { exportSnapshot: () => game.abilitiesSnapshot },
}));
// The ledger's fold is replaced with a spy; `signupParticipation` stays real,
// because what `_participation` does with the sheet is exactly what the
// participation tests below are about
vi.mock('./guild-trial-ledger.js', async (importOriginal) => ({
    ...(await importOriginal()),
    recordFinishedTrial: async (options) => {
        game.accrued.push(options);
        return null;
    },
}));
// The whole-guild roster `_participation` reads sign-ups off; a fixture list,
// so a test decides who signed up for what this week
vi.mock('./guild-xp-tracker.js', () => ({
    guildXPTracker: {
        getMemberList: () => game.members,
        getCurrentWeekStartAt: () => game.currentWeek,
    },
}));

const {
    buildTrialExport,
    GAP_AFTER_MS,
    guildTrialRecorder,
    IDLE_STOP_MS,
    MANUAL_MAX_MS,
    RECONCILE_WAIT_MS,
    reconcileSnapshot,
    SNAPSHOT_MS,
    thinBreakdown,
    trialSessionStorageKey,
    trialExportIsEmpty,
    downloadTrialExport,
} = await import('./guild-trial-recorder.js');

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
                {
                    index: '1',
                    name: 'Moo',
                    healingDone: 40_000,
                    damageTaken: 1_000,
                    manaSpent: 12_000,
                    manaRestored: 3_000,
                    manaOuts: 2,
                    emptyManaMs: 30_000,
                    outOfMana: true,
                    lowestHealthFraction: 0.4,
                    casts: 80,
                    healCasts: 50,
                    buffCasts: 5,
                    castsByAbility: { '/abilities/heal': 50 },
                },
            ],
            unattributedHealing: 500,
        },
        ...overrides,
    };
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    game.settings = { guildTrialAutoRecord: true, guildTrialLedger: true };
    game.store = {};
    game.breakdown = breakdown();
    game.traceId = null;
    game.abilitiesSnapshot = null;
    game.accrued = [];
    game.members = [];
    game.currentWeek = null;
    guildTrialRecorder.session = null;
    guildTrialRecorder.lastActivityAt = 0;
    guildTrialRecorder.phase = null;
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
            {
                index: '0',
                name: 'Tib',
                damage: 300_000,
                deaths: 0,
                healingDone: 0,
                damageTaken: 90_000,
                // A support row that never said anything about mana reads as
                // the zeros it is, not as absent fields
                manaSpent: 0,
                manaRestored: 0,
                manaOuts: 0,
                emptyManaMs: 0,
                outOfMana: false,
                lowManaOuts: 0,
                lowManaMs: 0,
                starvedOuts: 0,
                starvedMs: 0,
                lowestHealthFraction: null,
                casts: 0,
                healCasts: 0,
                buffCasts: 0,
            },
            {
                index: '1',
                name: 'Moo',
                damage: 200_000,
                deaths: 1,
                healingDone: 40_000,
                damageTaken: 1_000,
                manaSpent: 12_000,
                manaRestored: 3_000,
                manaOuts: 2,
                emptyManaMs: 30_000,
                outOfMana: true,
                lowManaOuts: 0,
                lowManaMs: 0,
                starvedOuts: 0,
                starvedMs: 0,
                lowestHealthFraction: 0.4,
                casts: 80,
                healCasts: 50,
                buffCasts: 5,
                // and deliberately no castsByAbility — a map per player per
                // fifteen seconds is what the thinning exists to avoid
            },
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

describe('not recording when nothing is running', () => {
    test('a phase that has never been read is not permission to record', () => {
        // Reported: "Stop recording" was active on a guild whose weekly trials
        // were not on. Unknown must not be treated as live.
        game.breakdown = breakdown({ active: false });
        guildTrialRecorder.noteLifecycle(null);
        vi.advanceTimersByTime(SNAPSHOT_MS * 2);

        expect(guildTrialRecorder.recording).toBe(false);
    });

    test('a scheduled cycle stops a session that armed itself', () => {
        guildTrialRecorder.noteActivity('tab-reading');
        expect(guildTrialRecorder.recording).toBe(true);

        guildTrialRecorder.noteLifecycle('scheduled');

        expect(guildTrialRecorder.recording).toBe(false);
        expect(guildTrialRecorder.session.endedBy).toBe('the trial is scheduled');
    });

    test('a session somebody pressed Record for is theirs to stop', () => {
        guildTrialRecorder.start('button');
        guildTrialRecorder.noteLifecycle('completed');

        expect(guildTrialRecorder.recording).toBe(true);
    });

    test('the watcher stops promptly rather than waiting out the idle timer', () => {
        guildTrialRecorder.noteActivity('trial-fight');
        expect(guildTrialRecorder.recording).toBe(true);

        // The fight ends and the panel says the cycle is over — well inside the
        // ten minutes the idle rule would have taken
        game.breakdown = breakdown({ active: false });
        guildTrialRecorder.phase = 'completed';
        vi.advanceTimersByTime(SNAPSHOT_MS);

        expect(guildTrialRecorder.recording).toBe(false);
        expect(guildTrialRecorder.session.endedBy).toBe('the trial is completed');
    });

    test('a live phase keeps it running', () => {
        guildTrialRecorder.noteActivity('tab-reading');
        guildTrialRecorder.noteLifecycle('live');
        game.breakdown = breakdown({ active: false, totalDamage: 600_000 });
        vi.advanceTimersByTime(SNAPSHOT_MS);

        expect(guildTrialRecorder.recording).toBe(true);
    });
});

describe('a session somebody pressed Record for', () => {
    // Reported live: a manual recording stopped by itself mid-trial. Readings
    // only arrive while the guild panel is open, so closing it to go and do
    // something else starved the recorder and the ten-minute silence rule
    // killed a session the user had started by hand.
    test('fifteen minutes of silence during a live trial does not stop it', () => {
        guildTrialRecorder.start('button');
        guildTrialRecorder.noteLifecycle('live');

        game.breakdown = breakdown({ active: false });
        vi.setSystemTime(now + 15 * 60_000);
        vi.advanceTimersByTime(SNAPSHOT_MS);

        expect(guildTrialRecorder.recording).toBe(true);
    });

    test('nor does a phase reading that is not live', () => {
        guildTrialRecorder.start('button');

        for (const phase of ['completed', 'scheduled', null]) {
            guildTrialRecorder.noteLifecycle(phase);
            vi.advanceTimersByTime(SNAPSHOT_MS);
            expect(guildTrialRecorder.recording).toBe(true);
        }
    });

    test('the silence is written down as a gap rather than acted on', () => {
        guildTrialRecorder.start('button');
        guildTrialRecorder.noteLifecycle('live');
        // Nothing arriving: the panel is shut
        game.breakdown = breakdown({ active: false });

        vi.setSystemTime(now + 12 * 60_000);
        vi.advanceTimersByTime(SNAPSHOT_MS);

        const gaps = guildTrialRecorder.session.gaps || [];
        expect(gaps.length).toBeGreaterThan(0);
        expect(gaps[0].ms).toBeGreaterThan(GAP_AFTER_MS);
    });

    test('one silence is one gap, however many ticks it spans', () => {
        guildTrialRecorder.start('button');
        guildTrialRecorder.noteLifecycle('live');
        // Nothing arriving: the panel is shut
        game.breakdown = breakdown({ active: false });

        for (let step = 1; step <= 4; step += 1) {
            vi.setSystemTime(now + 10 * 60_000 + step * SNAPSHOT_MS);
            vi.advanceTimersByTime(SNAPSHOT_MS);
        }

        expect(guildTrialRecorder.session.gaps).toHaveLength(1);
    });

    test('a session left open for six hours is still stopped', () => {
        guildTrialRecorder.start('button');
        guildTrialRecorder.noteLifecycle('live');
        // Nothing arriving: the panel is shut
        game.breakdown = breakdown({ active: false });

        vi.setSystemTime(now + MANUAL_MAX_MS + 60_000);
        vi.advanceTimersByTime(SNAPSHOT_MS);

        expect(guildTrialRecorder.recording).toBe(false);
        expect(guildTrialRecorder.session.endedBy).toContain('six hours');
    });
});

describe('the two hours of one cycle', () => {
    test('the combat hour arms itself after the skilling hour ends', () => {
        // Asked directly: does the user have to stop and start between the two?
        // No. The lull between them reads as completed, which closes the
        // skilling session, and the first sign of the combat hour opens a new one
        guildTrialRecorder.noteActivity('tab-reading');
        const skilling = guildTrialRecorder.session;
        expect(guildTrialRecorder.recording).toBe(true);

        guildTrialRecorder.noteLifecycle('completed');
        expect(guildTrialRecorder.recording).toBe(false);

        // The combat hour starts: a reading, or a fight
        vi.setSystemTime(now + 10 * 60_000);
        guildTrialRecorder.noteActivity('tab-reading', now + 10 * 60_000);

        expect(guildTrialRecorder.recording).toBe(true);
        expect(guildTrialRecorder.session).not.toBe(skilling);
    });

    test('a stale phase does not stop the new session on the very next tick', () => {
        // The ping-pong this guards against: start, then the watcher sees a
        // `completed` nobody has re-read and closes it again immediately
        guildTrialRecorder.noteLifecycle('completed');
        guildTrialRecorder.noteActivity('trial-fight');
        expect(guildTrialRecorder.recording).toBe(true);

        game.breakdown = breakdown({ active: false });
        vi.advanceTimersByTime(SNAPSHOT_MS);

        expect(guildTrialRecorder.recording).toBe(true);
    });

    test('a session started by hand spans both hours untouched', () => {
        guildTrialRecorder.start('button');
        guildTrialRecorder.noteLifecycle('completed');
        guildTrialRecorder.noteLifecycle('scheduled');
        guildTrialRecorder.noteLifecycle('live');

        expect(guildTrialRecorder.recording).toBe(true);
        expect(guildTrialRecorder.session.startedBy).toBe('button');
    });
});

describe('stopping', () => {
    test('a trial that goes quiet ends the session it armed itself, and says why', () => {
        guildTrialRecorder.noteActivity('tab-reading');
        guildTrialRecorder.noteLifecycle('completed');
        guildTrialRecorder.noteActivity('tab-reading');
        guildTrialRecorder.phase = 'scheduled';

        game.breakdown = breakdown({ active: false });
        vi.setSystemTime(now + IDLE_STOP_MS + SNAPSHOT_MS);
        vi.advanceTimersByTime(SNAPSHOT_MS);

        expect(guildTrialRecorder.recording).toBe(false);
        expect(guildTrialRecorder.session.endedAt).toBeGreaterThan(now);
    });

    test('an hour is as long as a trial runs, for a session that armed itself', () => {
        guildTrialRecorder.noteActivity('tab-reading');

        // Still active, so it is not the idle rule that fires
        vi.setSystemTime(now + 61 * 60_000);
        guildTrialRecorder.lastActivityAt = now + 61 * 60_000;
        vi.advanceTimersByTime(SNAPSHOT_MS);

        expect(guildTrialRecorder.recording).toBe(false);
        expect(guildTrialRecorder.session.endedBy).toMatch(/hour a trial runs/);
    });

    test('a closed session is folded into the attendance ledger, once', () => {
        guildTrialRecorder.start('button');
        guildTrialRecorder.stop('button');
        guildTrialRecorder.stop('button again');

        expect(game.accrued).toHaveLength(1);
        expect(game.accrued[0].session).toBe(guildTrialRecorder.session);
        expect(game.accrued[0].characterId).toBe(game.characterId);
        expect(game.accrued[0].encounter).toBe(game.breakdown.encounter ?? null);
        // The roster arrives as names, not as the `{name, characterId}` entries
        // the damage module keys by unit index
        expect(game.accrued[0].roster.every((name) => typeof name === 'string')).toBe(true);
    });

    test('the ledger is not written when the ledger setting is off', () => {
        // The setting is the record, not merely the panel that reads it: half a
        // year of per-member rows for somebody who asked for none is exactly
        // what switching it off is for
        game.settings = { guildTrialAutoRecord: true, guildTrialLedger: false };

        guildTrialRecorder.start('button');
        guildTrialRecorder.stop('button');

        expect(game.accrued).toHaveLength(0);
    });

    test('a ledger that throws is not allowed to lose the recording', () => {
        game.accrued = {
            push() {
                throw new Error('the ledger is having a day');
            },
        };

        guildTrialRecorder.start('button');
        expect(() => guildTrialRecorder.stop('button')).not.toThrow();
        expect(guildTrialRecorder.session.endedBy).toBe('button');
    });

    test('stopping by hand is recorded as by hand', () => {
        guildTrialRecorder.start('button');
        guildTrialRecorder.stop('button');

        expect(guildTrialRecorder.session.endedBy).toBe('button');
        // And written down, so a reload still has it
        expect(game.store[trialSessionStorageKey(null, game.characterId)]).toBeTruthy();
    });

    test('stopping what was never started is not an error', () => {
        expect(guildTrialRecorder.stop('button')).toBeNull();
    });
});

describe('the participation the ledger is handed', () => {
    /** A guild member meta with this week's combat sign-up on it */
    const signup = (name) => ({
        name,
        signedUpCombatTrialHrid: '/guild_combat/badger',
        signupWeekStartAt: 'this-week',
    });

    test('the server roster joins the sign-up sheet instead of replacing it', () => {
        game.currentWeek = 'this-week';
        game.members = [signup('Tank'), signup('Ghost')];
        // The server credited Tank and a member whose id the sheet no longer
        // carries (renamed, or gone from the guild by the time the stats
        // landed) — and never mentioned Ghost, whose id nothing could name
        game.breakdown = breakdown({
            storedStats: {
                badger: {
                    reported: {
                        Tank: { damage: 1, healing: 0, taken: 0 },
                        Renamed: { damage: 2, healing: 0, taken: 0 },
                    },
                    measured: null,
                    at: now,
                },
            },
        });

        guildTrialRecorder.start('button');
        guildTrialRecorder.stop('button');

        const roster = game.accrued[0].participation.badger;
        expect(roster.source).toBe('stats');
        // The credited names, and the signed-up member the stats could not
        // name — a signed-up member took part either way, and dropping them
        // would settle a credited member as absent
        expect(roster.names.sort()).toEqual(['Ghost', 'Renamed', 'Tank']);
    });

    test('a stale week’s stored roster does not become this cycle’s participation', () => {
        // `storedStats` outlives the weekly reset in memory on purpose — the
        // cycle archive is its last reader — but a page left open across the
        // rollover must not file last week's fight as this cycle's evidence
        game.breakdown = breakdown({
            storedStats: {
                badger: {
                    reported: { Tank: { damage: 1, healing: 0, taken: 0 } },
                    measured: null,
                    at: now - 14 * 86_400_000,
                },
            },
        });

        guildTrialRecorder.start('button');
        guildTrialRecorder.stop('button');

        expect(game.accrued[0].participation).toBe(null);
    });
});

describe('a trial that has already ended', () => {
    test('a tick trailing in after the end cannot re-open a session, however often the panel closes it', () => {
        // B1: a tick after end_guild_battle leaves the breakdown reading
        // active with endedAt set. Each panel render closed the session and the
        // next signal re-opened it, and every close folded the whole trial again
        game.breakdown = breakdown({ encounter: 'badger' });
        vi.advanceTimersByTime(SNAPSHOT_MS);
        expect(guildTrialRecorder.recording).toBe(true);

        game.breakdown = breakdown({ encounter: 'badger', endedAt: Date.now(), active: true });
        for (let pass = 0; pass < 8; pass += 1) {
            guildTrialRecorder.noteLifecycle('completed');
            guildTrialRecorder.noteActivity('tab-reading');
            guildTrialRecorder.noteActivity('guild-updated');
            vi.advanceTimersByTime(SNAPSHOT_MS);
        }

        expect(guildTrialRecorder.recording).toBe(false);
        expect(game.accrued).toHaveLength(1);
    });

    test('with the panel shut, the hour stop is not followed by a fresh session over the same trial', () => {
        game.breakdown = breakdown({ encounter: 'badger' });
        vi.advanceTimersByTime(SNAPSHOT_MS);
        game.breakdown = breakdown({ encounter: 'badger', endedAt: Date.now(), active: true });

        vi.setSystemTime(now + 61 * 60_000);
        vi.advanceTimersByTime(SNAPSHOT_MS * 4);

        expect(guildTrialRecorder.recording).toBe(false);
        expect(guildTrialRecorder.session.endedBy).toMatch(/hour a trial runs/);
        expect(game.accrued).toHaveLength(1);
    });

    test('the game’s own end flag refuses it too, and the button still records', () => {
        game.breakdown = breakdown({ endedByGame: true });
        vi.advanceTimersByTime(SNAPSHOT_MS);
        expect(guildTrialRecorder.recording).toBe(false);

        guildTrialRecorder.start('button');
        expect(guildTrialRecorder.recording).toBe(true);
    });

    test('an end left in memory from last week does not refuse this week’s trial', () => {
        game.breakdown = breakdown({ active: false, endedAt: now - 7 * 86_400_000 });
        guildTrialRecorder.noteActivity('tab-reading');
        expect(guildTrialRecorder.recording).toBe(true);
    });

    test('a breakdown from an earlier week lends a session no trial identity', () => {
        game.breakdown = breakdown({ active: false, encounter: 'badger', spectator: { lastAt: now - 7 * 86_400_000 } });
        guildTrialRecorder.start('button');
        guildTrialRecorder.stop('button');
        expect(game.accrued[0].encounter).toBeNull();
    });
});

describe('the game’s own totals', () => {
    // As `guild_trial_stats_updated` is surfaced on the breakdown: per name
    const reported = {
        tib: { damage: 350_000, healing: 0, taken: 150_000 },
        Moo: { damage: 180_000, healing: 60_000, taken: 5_000 },
        Ada: { damage: 20_000, healing: 0, taken: 1_000 },
    };
    const lastOf = (session) => session.snapshots[session.snapshots.length - 1];

    test('restate damage, healing and taken by name, and keep what only the stream knows', () => {
        const base = thinBreakdown(breakdown(), now);
        const snapshot = { ...base, players: [...base.players, { index: '2', name: 'Player 3', damage: 7 }] };
        const patched = reconcileSnapshot(snapshot, reported, now + 1);

        expect(patched.basis).toBe('game');
        expect(patched.players.find((row) => row.name === 'Tib')).toMatchObject({
            damage: 350_000,
            healingDone: 0,
            damageTaken: 150_000,
            deaths: 0,
        });
        expect(patched.players.find((row) => row.name === 'Moo')).toMatchObject({
            damage: 180_000,
            healingDone: 60_000,
            damageTaken: 5_000,
            deaths: 1,
            manaSpent: 12_000,
            manaOuts: 2,
        });
        // Credited by the server, never split out by the stream
        expect(patched.players.find((row) => row.name === 'Ada')).toMatchObject({ index: null, damage: 20_000 });
        // An id the server's list could not name is not absence
        expect(patched.players.find((row) => row.name === 'Player 3').damage).toBe(7);
        expect(patched.totalDamage).toBe(550_007);
        expect(patched.streamTotalDamage).toBe(500_000);
        expect(snapshot.basis).toBeUndefined();
        expect(reconcileSnapshot(snapshot, null)).toBe(snapshot);
    });

    test('totals landing after the session closed correct its fold, once', () => {
        game.breakdown = breakdown({ encounter: 'badger' });
        guildTrialRecorder.noteActivity('trial-fight');

        // end_guild_battle: the panel closes the session on the stream's figures
        vi.setSystemTime(now + 1000);
        game.breakdown = breakdown({ encounter: 'badger', endedAt: now + 1000, active: false });
        guildTrialRecorder.noteLifecycle('completed', now + 1000);
        expect(game.accrued).toHaveLength(1);
        expect(lastOf(game.accrued[0].session).basis).toBeUndefined();

        // The stats land 28 s after the end, as in a recorded trial
        vi.setSystemTime(now + 29_000);
        game.breakdown = breakdown({ encounter: 'badger', endedAt: now + 1000, active: false, reported });
        vi.advanceTimersByTime(SNAPSHOT_MS);

        expect(game.accrued).toHaveLength(2);
        expect(game.accrued[1].session).toBe(game.accrued[0].session);
        expect(game.accrued[1].encounter).toBe('badger');
        const final = lastOf(guildTrialRecorder.session);
        expect(final.basis).toBe('game');
        expect(final.players.find((row) => row.name === 'Tib').damage).toBe(350_000);
        expect(lastOf(game.store[trialSessionStorageKey(null, game.characterId)]).basis).toBe('game');

        // The game re-sends the message whenever its Stats panel is opened
        vi.advanceTimersByTime(SNAPSHOT_MS * 4);
        expect(game.accrued).toHaveLength(2);
    });

    test('totals already in hand when the session closes go into its only fold', () => {
        game.breakdown = breakdown({ encounter: 'badger' });
        guildTrialRecorder.noteActivity('trial-fight');
        game.breakdown = breakdown({ encounter: 'badger', endedAt: now, active: false, reported });

        guildTrialRecorder.stop('the trial is completed');
        vi.advanceTimersByTime(SNAPSHOT_MS * 2);

        expect(game.accrued).toHaveLength(1);
        expect(lastOf(game.accrued[0].session).basis).toBe('game');
    });

    test('another trial’s totals are not applied to this one', () => {
        game.breakdown = breakdown({ encounter: 'badger' });
        guildTrialRecorder.start('button');
        guildTrialRecorder.stop('button');

        game.breakdown = breakdown({ encounter: 'swarm', active: false, reported });
        vi.advanceTimersByTime(SNAPSHOT_MS);

        expect(game.accrued).toHaveLength(1);
        expect(lastOf(guildTrialRecorder.session).basis).toBeUndefined();
    });

    test('totals arriving after the wait leave the stream’s figures standing', () => {
        game.breakdown = breakdown({ encounter: 'badger' });
        guildTrialRecorder.start('button');
        guildTrialRecorder.stop('button');

        vi.setSystemTime(now + RECONCILE_WAIT_MS + 30_000);
        game.breakdown = breakdown({ encounter: 'badger', active: false, reported });
        vi.advanceTimersByTime(SNAPSHOT_MS);

        expect(game.accrued).toHaveLength(1);
        expect(lastOf(guildTrialRecorder.session).basis).toBeUndefined();
    });

    test('a character switch drops the wait: later totals are the next character’s', () => {
        game.breakdown = breakdown({ encounter: 'badger' });
        guildTrialRecorder.noteActivity('trial-fight');
        const recorded = guildTrialRecorder.session;
        guildTrialRecorder.forget();

        game.breakdown = breakdown({ encounter: 'badger', active: false, reported });
        vi.advanceTimersByTime(SNAPSHOT_MS);

        expect(game.accrued).toHaveLength(1);
        expect(lastOf(recorded).basis).toBeUndefined();
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

describe('a character switch', () => {
    test('two characters do not share the fallback key', () => {
        // The reported leak, at its root: both wrote to `guildTrialSession_default`
        expect(trialSessionStorageKey(null, 30404)).not.toBe(trialSessionStorageKey(null, 99));
        // And a guild's own key is still shared, which is the point of it
        expect(trialSessionStorageKey('Milky Way', 30404)).toBe(trialSessionStorageKey('Milky Way', 99));
    });

    test('the session is forgotten with the character that recorded it', () => {
        guildTrialRecorder.start('button');
        expect(guildTrialRecorder.recording).toBe(true);

        guildTrialRecorder.forget();

        expect(guildTrialRecorder.session).toBeNull();
        expect(guildTrialRecorder.recording).toBe(false);
    });

    test('a session still recording when the character switches is closed out, not just dropped', () => {
        guildTrialRecorder.start('button');
        const session = guildTrialRecorder.session;

        guildTrialRecorder.forget();

        // Stopped and folded into the ledger before it was thrown away — a
        // session left with `endedAt: null` reads as still running forever,
        // and skipping `_accrue()` is a trial that silently never counts
        expect(session.endedAt).not.toBeNull();
        expect(session.endedBy).toBe('character switched');
        expect(game.accrued).toHaveLength(1);
        expect(game.accrued[0].session).toBe(session);
    });

    test('a session already ended is not folded into the ledger a second time', () => {
        guildTrialRecorder.start('button');
        guildTrialRecorder.stop('button');
        expect(game.accrued).toHaveLength(1);

        guildTrialRecorder.forget();

        expect(game.accrued).toHaveLength(1);
    });
});

describe('a guild switch', () => {
    test('the open session goes with the guild it was recorded in', () => {
        guildTrialRecorder.setGuildName('Testmaxxing');
        guildTrialRecorder.start('button');
        expect(guildTrialRecorder.recording).toBe(true);

        // `_persist` resolves the key afresh on every write, so a session kept
        // across this would land under `guildTrialSession_SuperMoo`
        guildTrialRecorder.setGuildName('SuperMoo');

        expect(guildTrialRecorder.session).toBeNull();
        expect(guildTrialRecorder.guildName).toBe('SuperMoo');
    });

    test('a session still recording when the guild switches mid-trial is closed out first', () => {
        guildTrialRecorder.setGuildName('Testmaxxing');
        guildTrialRecorder.start('button');
        const session = guildTrialRecorder.session;

        guildTrialRecorder.setGuildName('SuperMoo');

        expect(session.endedAt).not.toBeNull();
        expect(game.accrued).toHaveLength(1);
        // Folded in under the guild it was actually recorded in, not the one
        // arriving — `_accrue` reads `this.guildName` before `forget` clears it
        expect(game.accrued[0].guildName).toBe('Testmaxxing');
    });

    test('a name arriving over none is the ordinary adoption and keeps the session', () => {
        guildTrialRecorder.setGuildName(null);
        guildTrialRecorder.start('button');
        guildTrialRecorder.setGuildName('SuperMoo');

        expect(guildTrialRecorder.recording).toBe(true);
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
        expect(bundle.memberSkills.ada.skills['/skills/alchemy']).toBe(90);
    });

    test('names its format, version and origin, with no userscript sandbox to ask', async () => {
        const bundle = await buildTrialExport({ guildName: 'Milky Way' });

        expect(bundle.format).toBe('toolasha-guild-trial');
        expect(bundle.version).toBe(1);
        // No GM_info in a test environment: null, not a throw
        expect(bundle.toolashaVersion).toBeNull();
        // happy-dom serves a hostname, and it is not the test server's
        expect(bundle.host).toBe(location.hostname);
        expect(bundle.isTestServer).toBe(false);
    });

    test('carries the running script version when GM_info is there', async () => {
        globalThis.GM_info = { script: { version: '9.9.9' } };
        try {
            const bundle = await buildTrialExport({});
            expect(bundle.toolashaVersion).toBe('9.9.9');
        } finally {
            delete globalThis.GM_info;
        }
    });

    test('stamps the diagnostic trace id, so the two files can be paired', async () => {
        game.traceId = 'trace-abc-123';
        const bundle = await buildTrialExport({});
        expect(bundle.traceId).toBe('trace-abc-123');
    });

    test('the trace id is null when no trace has run', async () => {
        const bundle = await buildTrialExport({});
        expect(bundle.traceId).toBeNull();
    });

    test('embeds the trial abilities snapshot, null when no session exists', async () => {
        expect((await buildTrialExport({})).trialAbilities).toBeNull();
        game.abilitiesSnapshot = { complete: false, unknownAuras: ['/abilities/mystic_aura'] };
        const bundle = await buildTrialExport({});
        expect(bundle.trialAbilities).toEqual({ complete: false, unknownAuras: ['/abilities/mystic_aura'] });
    });

    test('the last session is read back off storage when none is in hand', async () => {
        game.store[trialSessionStorageKey(null, game.characterId)] = { startedAt: 1, endedAt: 2, snapshots: [] };
        guildTrialRecorder.session = null;

        const bundle = await buildTrialExport({});
        expect(bundle.session).toMatchObject({ startedAt: 1, endedAt: 2 });
    });
});

/**
 * `buildTrialExport` never refuses — an empty week comes back as a well-formed
 * bundle with a fresh record and no session, which is right for the file and
 * useless to a caller that wants to say whether there was anything.
 */
describe('trialExportIsEmpty', () => {
    test('a bundle with a session is not empty, whatever the record says', () => {
        expect(trialExportIsEmpty({ session: { startedAt: 1 }, record: { tiles: {}, history: [] } })).toBe(false);
    });

    test('a ladder with samples is not empty', () => {
        expect(trialExportIsEmpty({ session: null, record: { tiles: { 3: {} }, history: [] } })).toBe(false);
    });

    test('a finished trial in the history is not empty', () => {
        expect(trialExportIsEmpty({ session: null, record: { tiles: {}, history: [{ endedAt: 1 }] } })).toBe(false);
    });

    test('a fresh week with none of the three is empty', () => {
        expect(trialExportIsEmpty({ session: null, record: { weekStart: 0, tiles: {}, history: [] } })).toBe(true);
    });

    test('a bundle whose record could not be read is empty rather than assumed', () => {
        expect(trialExportIsEmpty({ session: null, record: null })).toBe(true);
        expect(trialExportIsEmpty(undefined)).toBe(true);
    });
});

describe('downloadTrialExport', () => {
    // A real browser treats a click on `<a download>` as a save, not a
    // navigation. happy-dom navigates: the click left the document sitting on
    // `blob:trial`, whose hostname is the empty string, and every later test
    // that asked what host it was running on — the export bundle's `host` and
    // `isTestServer` — read that instead of the page's own. Stubbed rather than
    // restored afterwards, because the navigation is the environment's
    // artefact and nothing here is testing it.
    let clicks;
    beforeEach(() => {
        clicks = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    });

    afterEach(() => {
        clicks.mockRestore();
    });

    test('it answers with the name it saved under, which the caller cannot recompute', () => {
        const created = [];
        const originalCreate = URL.createObjectURL;
        const originalRevoke = URL.revokeObjectURL;
        URL.createObjectURL = () => 'blob:trial';
        URL.revokeObjectURL = (url) => created.push(url);
        try {
            const filename = downloadTrialExport({ format: 'toolasha-guild-trial' });
            // The timestamp is taken inside; a second `new Date()` outside would differ
            expect(filename).toMatch(/^toolasha-trial-.+\.json$/);
            expect(created).toEqual(['blob:trial']);
        } finally {
            URL.createObjectURL = originalCreate;
            URL.revokeObjectURL = originalRevoke;
        }
    });

    test('a download that cannot be built answers null rather than a bare false', () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
        const originalCreate = URL.createObjectURL;
        URL.createObjectURL = () => {
            throw new Error('no blob urls here');
        };
        try {
            expect(downloadTrialExport({})).toBe(null);
            expect(logged).toHaveBeenCalled();
        } finally {
            URL.createObjectURL = originalCreate;
            logged.mockRestore();
        }
    });
});
