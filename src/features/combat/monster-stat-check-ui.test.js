/** @vitest-environment happy-dom */

/**
 * The stat-check panel's persistence and fight-start snapshot.
 *
 * The history is a labelled corpus — one monster in each distinct buff state —
 * so the restore must key entries exactly as they were recorded. An earlier
 * restore rebuilt only monster|room, which collapsed every effect-state
 * snapshot of one room down to the oldest and then persisted the loss.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const stored = vi.hoisted(() => ({ value: null }));
/** Mutable state behind the clear-rate mock, reset per test. */
const clearRate = vi.hoisted(() => ({
    fingerprint: 'fp-now',
    probeResults: [],
    probeCalls: 0,
    harnessCalls: [],
    harnessResult: null,
}));
/** Mutable state behind the tick-capture mock, reset per test. */
const tickCapture = vi.hoisted(() => ({ file: { ticks: [] }, started: [] }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, onSettingChange: () => {} },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'me-id',
        getCurrentCharacterName: () => 'Benny',
    },
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async () => stored.value,
        set: async (_k, v) => {
            stored.value = v;
        },
    },
}));
vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: () => {},
    unregisterFloatingPanel: () => {},
    bringPanelToFront: () => {},
}));
vi.mock('../../utils/panel-minimize.js', () => ({ attachMinimize: () => {} }));
vi.mock('../../utils/csv-export.js', () => ({ downloadFile: () => {} }));
vi.mock('../combat-sim/combat-sim-adapter.js', () => ({ buildGameDataPayload: () => ({}) }));
vi.mock('../combat-sim/engine/game-data.js', () => ({ setGameData: () => {} }));
vi.mock('../combat-sim/engine/monster.js', () => ({ default: class {} }));
vi.mock('./labyrinth-clear-rate.js', () => ({
    default: {
        simPlayerDetails: async () => null,
        _snapshotContentFingerprint: () => clearRate.fingerprint,
        blindBuffProbe: async () => {
            const result = clearRate.probeResults[clearRate.probeCalls] ?? { produced: [], ran: true };
            clearRate.probeCalls++;
            return result;
        },
        uptimeHarness: async (...args) => {
            clearRate.harnessCalls.push(args);
            return clearRate.harnessResult;
        },
    },
}));
vi.mock('./labyrinth-tick-capture.js', () => ({
    captureFile: () => tickCapture.file,
    startCapture: (ctx) => tickCapture.started.push(ctx),
}));

const { panel } = await import('./monster-stat-check-ui.js');

/** A recorded snapshot of one monster/level in one buff state */
function snap(buffs, hp = 100) {
    return {
        hrid: '/monsters/cyclops',
        roomLevel: 206,
        combatBuffMap: buffs,
        combatDetails: { maxHitpoints: hp },
    };
}

beforeEach(() => {
    panel.history = new Map();
    panel.fightStartBuffMap = null;
    panel.displayed = null;
    stored.value = null;
    clearRate.fingerprint = 'fp-now';
    clearRate.probeResults = [];
    clearRate.probeCalls = 0;
    clearRate.harnessCalls = [];
    clearRate.harnessResult = null;
    tickCapture.file = { ticks: [] };
    tickCapture.started = [];
});

describe('restoring the persisted history', () => {
    test('distinct buff states of one monster/level all survive a reload', async () => {
        const bare = snap({});
        const buffed = snap({ '/buff_uniques/fierce_aura': { typeHrid: '/buff_types/damage', ratioBoost: 0.2 } });
        stored.value = { entries: [bare, buffed] };

        await panel._loadPersisted();

        // The old restore keyed both as "cyclops|206" and kept only the first
        expect(panel.history.size).toBe(2);
        expect(panel.history.has(panel._recordKey(bare))).toBe(true);
        expect(panel.history.has(panel._recordKey(buffed))).toBe(true);
    });

    test('a restored entry re-recorded in the same state updates in place', async () => {
        const entry = snap({ '/buff_uniques/precision': { typeHrid: '/buff_types/accuracy', ratioBoost: 0.5 } });
        stored.value = { entries: [entry] };
        await panel._loadPersisted();

        panel.last = snap(entry.combatBuffMap, 120);
        panel._record();

        // Same key — replaced, not duplicated under a second key shape
        expect(panel.history.size).toBe(1);
        expect(panel.history.get(panel._recordKey(entry)).combatDetails.maxHitpoints).toBe(120);
    });

    test('an entry recorded before buff maps existed still restores under a stable key', async () => {
        const legacy = { hrid: '/monsters/cyclops', roomLevel: 206, combatDetails: {} };
        stored.value = { entries: [legacy, snap({})] };

        await panel._loadPersisted();

        // buffSignature(undefined) and buffSignature({}) are both '' — the two
        // collide by design: neither carries an effect state
        expect(panel.history.size).toBe(1);
    });
});

describe('the uptime harness capture gate', () => {
    // _render at the end of the run paths needs the panel built once
    beforeEach(() => panel._ensureBuilt());

    test('a held capture from another build is refused BY NAME, and a fresh one armed with the current fingerprint', async () => {
        panel.displayed = snap({});
        tickCapture.file = {
            ticks: [{}, {}],
            context: { monsterHrid: '/monsters/cyclops', roomLevel: 206, fingerprint: 'fp-old' },
        };

        await panel._runUptimeHarness();

        expect(clearRate.harnessCalls).toHaveLength(0);
        expect(panel.displayed.uptime.armed).toBe(true);
        expect(panel.displayed.uptime.message).toContain('different build');
        // The refusal still arms a capture, bound to the current build
        expect(tickCapture.started).toHaveLength(1);
        expect(tickCapture.started[0]).toMatchObject({
            monsterHrid: '/monsters/cyclops',
            roomLevel: 206,
            fingerprint: 'fp-now',
        });
    });

    test('a wrong-monster capture names the monster, not the build', async () => {
        panel.displayed = snap({});
        tickCapture.file = {
            ticks: [{}],
            context: { monsterHrid: '/monsters/dryad', roomLevel: 206, fingerprint: 'fp-now' },
        };

        await panel._runUptimeHarness();

        expect(panel.displayed.uptime.message).toContain('different monster');
        expect(panel.displayed.uptime.message).not.toContain('build');
    });

    test('a legacy capture with no fingerprint still runs, and the section carries the fight counts', async () => {
        panel.displayed = snap({});
        tickCapture.file = { ticks: [{}], context: { monsterHrid: '/monsters/cyclops', roomLevel: 206 } };
        clearRate.harnessResult = {
            comparison: { rows: [] },
            real: { fights: 2, partialFights: 1, captureStartedMidFight: true },
        };

        await panel._runUptimeHarness();

        expect(clearRate.harnessCalls).toHaveLength(1);
        expect(panel.displayed.uptime.fightsLabel).toBe('2 fights (+1 partial excluded) — capture started mid-fight');
    });
});

describe('the blind probe', () => {
    beforeEach(() => panel._ensureBuilt());

    test('runs several probes and unions the produced effects — one quiet run cannot erase an effect', async () => {
        panel.displayed = snap({});
        clearRate.probeResults = [
            {
                ran: true,
                produced: [{ uniqueHrid: '/buff_uniques/toughness', typeHrid: '/buff_types/armor', ratioBoost: 0.4 }],
            },
            {
                ran: true,
                produced: [
                    { uniqueHrid: '/buff_uniques/haste', typeHrid: '/buff_types/attack_speed', ratioBoost: 0.1 },
                ],
            },
            { ran: true, produced: [] },
        ];

        await panel._runBlindSim();

        expect(clearRate.probeCalls).toBe(3);
        const byHrid = Object.fromEntries(panel.displayed.blind.rows.map((r) => [r.uniqueHrid, r.verdict]));
        // The game snapshot is empty, so sim-produced effects grade neutral —
        // not as a defect — and both runs' effects survive the union
        expect(byHrid['/buff_uniques/toughness']).toBe('notInSnapshot');
        expect(byHrid['/buff_uniques/haste']).toBe('notInSnapshot');
    });
});

describe('the fight-start buff snapshot', () => {
    test('your own new_battle entry is kept, a partner’s is not', () => {
        panel.noteBattleStart({
            players: [
                { character: { id: 'friend' }, combatBuffMap: { '/b/theirs': { typeHrid: '/buff_types/damage' } } },
                { character: { id: 'me-id' }, combatBuffMap: { '/b/mine': { typeHrid: '/buff_types/damage' } } },
            ],
        });
        expect(Object.keys(panel.fightStartBuffMap)).toEqual(['/b/mine']);
    });

    test('a payload without a buff map resets the snapshot rather than keeping a stale one', () => {
        panel.fightStartBuffMap = { '/b/old': {} };
        panel.noteBattleStart({ players: [{ character: { id: 'me-id' }, name: 'Benny' }] });
        expect(panel.fightStartBuffMap).toBeNull();
    });
});
