/**
 * The combat pair recorder, with the game faked around it.
 *
 * The load-bearing rules are honesty rules. The forecast context — zone, tier,
 * gear signature, snapshot row — must be captured while the session is running,
 * because the archive keeps none of it; a session never seen live is skipped
 * rather than paired against whatever the character looks like later. And a
 * pair only exists when the snapshot actually had a row for the zone and tier
 * that was fought.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    calibrationOn: true,
    /** websocket handlers by type */
    handlers: {},
    /** The character's live action queue */
    actions: [],
    /** The archived session history the collector writes */
    archived: [],
    /** The sim's saved all-zones snapshot */
    snapshot: null,
    /** What the character's gear signs as right now */
    wornFingerprint: 'gear-a',
    /** What calculatePlayerStats reports for the archived player */
    stats: { dailyIncome: { ask: 2400, bid: 1200 }, dailyConsumableCosts: 0, expPerHour: 5000 },
    /** Pairs handed to the shared ledger */
    recorded: [],
}));

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => game.calibrationOn } }));
vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentActions: () => game.actions },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, handler) => {
            game.handlers[type] = handler;
        },
        off: (type) => {
            delete game.handlers[type];
        },
    },
}));
vi.mock('../combat-sim/combat-sim-ui.js', () => ({
    default: { currentGearFingerprint: async () => game.wornFingerprint },
}));
vi.mock('../combat-stats/combat-session-history.js', () => ({
    // The real key is roster + start time; the fake keeps the same shape
    sessionKey: (data) =>
        data?.players?.length && data?.combatStartTime
            ? `${data.players.map((p) => p?.name || p?.character?.name || '?').join(',')}|${data.combatStartTime}`
            : null,
    loadSessions: async () => game.archived,
}));
vi.mock('../combat-stats/combat-stats-calculator.js', () => ({
    calculatePlayerStats: () => game.stats,
}));
vi.mock('./prediction-calibration.js', () => ({
    MIN_DURATION_SEC: 60,
    predictionCalibration: {
        addRecord: async (record) => {
            game.recorded.push(record);
            return true;
        },
    },
}));
vi.mock('../../utils/all-zones-snapshot.js', () => ({
    loadAllZonesSnapshot: async () => game.snapshot,
}));

const { CombatCalibration } = await import('./combat-calibration.js');

const ZONE = '/actions/combat/rat_cave';

/** A saved all-zones snapshot with one row for the rat cave at tier 1. */
function snapshot(overrides = {}) {
    return {
        savedAt: Date.parse('2026-08-04T00:00:00Z'),
        fingerprint: 'gear-a',
        zones: [{ zoneHrid: ZONE, zoneName: 'Rat Cave', difficultyTier: 1, profitPerHour: 1000, xpPerHour: 4000 }],
        ...overrides,
    };
}

/** A new_battle payload for a session that started at `start`. */
function battle(start, names = ['Millennium44']) {
    return { combatStartTime: start, players: names.map((name) => ({ character: { name } })) };
}

/** The archived entry the collector would write for that session. */
function archivedSession(start, overrides = {}) {
    return {
        key: `Millennium44|${start}`,
        combatStartTime: start,
        actionHrid: ZONE,
        battleId: 42,
        durationSeconds: 3600,
        players: [{ name: 'Millennium44', isCurrentPlayer: true }],
        ...overrides,
    };
}

let calibration;

/** Deliver a new_battle and wait for the queued pass. */
async function send(data) {
    game.handlers.new_battle(data);
    await calibration.queue;
}

beforeEach(async () => {
    game.calibrationOn = true;
    game.handlers = {};
    game.actions = [{ actionHrid: ZONE, difficultyTier: 1, isDone: false }];
    game.archived = [];
    game.snapshot = snapshot();
    game.wornFingerprint = 'gear-a';
    game.stats = { dailyIncome: { ask: 24000, bid: 12000 }, dailyConsumableCosts: 2400, expPerHour: 5000 };
    game.recorded = [];
    calibration = new CombatCalibration();
    await calibration.initialize();
});

describe('pairing a forecast with an archived session', () => {
    test('writes nothing while the session is still running', async () => {
        await send(battle('2026-08-04T10:00:00Z'));
        expect(game.recorded).toHaveLength(0);
    });

    test('writes the pair once the finished session reaches the archive', async () => {
        await send(battle('2026-08-04T10:00:00Z'));
        game.archived = [archivedSession('2026-08-04T10:00:00Z')];
        await send(battle('2026-08-04T11:00:00Z'));

        expect(game.recorded).toHaveLength(1);
        expect(game.recorded[0]).toMatchObject({
            id: 'combat|Millennium44|2026-08-04T10:00:00Z',
            actionType: 'combat',
            actionHrid: ZONE,
            difficultyTier: 1,
            predicted: 1000,
            // Income minus consumables per hour: (24000 − 2400) / 24
            actual: 900,
            actualBid: 400,
            predictedXpPerHour: 4000,
            actualXpPerHour: 5000,
            fingerprintMatch: true,
        });
        expect(game.recorded[0].snapshotAgeMs).toBeGreaterThan(0);
    });

    test('keeps the forecast captured while the run was live, not a later one', async () => {
        await send(battle('2026-08-04T10:00:00Z'));
        // A new sim run lands mid-session with a different figure
        game.snapshot = snapshot({ zones: [{ ...snapshot().zones[0], profitPerHour: 9999 }] });
        game.archived = [archivedSession('2026-08-04T10:00:00Z')];
        await send(battle('2026-08-04T11:00:00Z'));

        expect(game.recorded[0].predicted).toBe(1000);
    });

    test('skips a session that was never seen live', async () => {
        // The archive already holds a finished run, but no battle of it was
        // ever observed — there is no honestly-captured context to pair with
        game.archived = [archivedSession('2026-08-04T09:00:00Z')];
        await send(battle('2026-08-04T11:00:00Z'));

        expect(game.recorded).toHaveLength(0);
    });

    test('takes no forecast when the snapshot has no row for that zone and tier', async () => {
        game.actions = [{ actionHrid: ZONE, difficultyTier: 2, isDone: false }];
        await send(battle('2026-08-04T10:00:00Z'));
        game.archived = [archivedSession('2026-08-04T10:00:00Z')];
        await send(battle('2026-08-04T11:00:00Z'));

        expect(game.recorded).toHaveLength(0);
    });

    test('flags gear that no longer matches the sim run, and unknowns as unknown', async () => {
        game.wornFingerprint = 'gear-b';
        await send(battle('2026-08-04T10:00:00Z'));
        game.archived = [archivedSession('2026-08-04T10:00:00Z')];
        await send(battle('2026-08-04T11:00:00Z'));
        expect(game.recorded[0].fingerprintMatch).toBe(false);

        // An unsigned snapshot is not evidence of change
        game.snapshot = snapshot({ fingerprint: null });
        await send(battle('2026-08-04T12:00:00Z'));
        game.archived.push(archivedSession('2026-08-04T12:00:00Z'));
        await send(battle('2026-08-04T13:00:00Z'));
        expect(game.recorded[1].fingerprintMatch).toBeNull();
    });

    test('skips sessions too short for their rate to mean anything', async () => {
        await send(battle('2026-08-04T10:00:00Z'));
        game.archived = [archivedSession('2026-08-04T10:00:00Z', { durationSeconds: 30 })];
        await send(battle('2026-08-04T11:00:00Z'));

        expect(game.recorded).toHaveLength(0);
    });

    test('refuses a pair when the archive remembers a different zone', async () => {
        await send(battle('2026-08-04T10:00:00Z'));
        game.archived = [archivedSession('2026-08-04T10:00:00Z', { actionHrid: '/actions/combat/other_zone' })];
        await send(battle('2026-08-04T11:00:00Z'));

        expect(game.recorded).toHaveLength(0);
    });

    test('does not initialize when the feature is off', async () => {
        game.calibrationOn = false;
        const off = new CombatCalibration();
        expect(await off.initialize()).toBe(false);
    });
});
