/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const world = vi.hoisted(() => ({
    character: 'char1',
    records: new Map(),
    gates: new Map(),
    reads: [],
    unavailable: false,
    runs: [],
}));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => false, getSettingValue: (_key, fallback) => fallback, Z_FLOATING_PANEL: 1100 },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => world.character,
        getCurrentCharacterName: () => `Name ${world.character}`,
        getCurrentCharacterGameMode: () => 'standard',
        getSkills: () => null,
        getInitClientData: () => ({}),
        characterData: null,
    },
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback = null) => world.records.get(key) ?? fallback,
        getJSON: async () => null,
        setJSON: async () => true,
        tryGet: async (key) => {
            const value = structuredClone(world.records.get(key));
            if (key.startsWith('labyrinthFightRecorder_')) {
                world.reads.push(key);
                await world.gates.get(key)?.promise;
                if (world.unavailable) return null;
            }
            return value === undefined ? { found: false, value: null } : { found: true, value };
        },
        set: async (key, value) => {
            world.records.set(key, structuredClone(value));
            return true;
        },
        delete: async (key) => world.records.delete(key),
        getAllKeys: async () => [...world.records.keys()],
    },
}));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'char1',
    requestAdoptionConsent: async () => null,
}));
vi.mock('./labyrinth-tick-capture.js', () => ({
    default: {
        captureStatus: () => ({ capturing: false, ticks: 0 }),
        isCapturing: () => false,
        heldTickCount: () => 0,
        stopCapture: () => {},
        forgetForCharacterSwitch: () => {},
    },
}));
vi.mock('../combat-sim/combat-sim-adapter.js', () => ({
    seedSimPriceCache: (cache) => cache,
    buildGameDataPayload: () => ({}),
    buildPlayerDTO: () => ({ hrid: 'player1' }),
    getLabyrinthMonsters: () => [],
    getCommunityBuffs: () => ({}),
}));
vi.mock('../combat-sim/combat-sim-runner.js', () => ({
    runLabyrinthSimulation: async (options) => {
        world.runs.push(options);
        return { simulatedTime: 20e9, labyAttemptCount: 1, encounters: 1 };
    },
    runBlindBuffProbe: async () => [],
    runPlayerStatProbe: async () => null,
    cancelSimulation: () => {},
}));

import recorder from './labyrinth-fight-recorder.js';
import { labyrinthRoomLogs as logs } from './labyrinth-room-logs.js';
import { simCacheMethods } from './labyrinth-sim-cache.js';
import { FINGERPRINT_VERSION } from './labyrinth-fingerprint.js';

function deferred() {
    let resolve;
    const promise = new Promise((done) => {
        resolve = done;
    });
    return { promise, resolve };
}
const key = (character = world.character) => `labyrinthFightRecorder_${character}`;
const fights = (count = 3, prefix = 'saved') =>
    Array.from({ length: count }, (_, index) => ({
        recordId: `${prefix}-${index}`,
        monsterHrid: '/monsters/fly',
        monsterName: 'Fly',
        roomLevel: 12,
        seconds: 20,
        battleStartedAt: 1000 + index * 1000,
        resolvedAt: 1020 + index * 1000,
        outcome: 'clear',
        complete: true,
        cleared: true,
        playerMaxHp: 100,
        playerHpStart: 100,
        fingerprintVersion: FINGERPRINT_VERSION,
        fingerprint: 'current-build',
        replayInputs: {
            version: 1,
            playerDTO: { hrid: 'player1', attackLevel: 23 },
            crates: [],
            communityBuffs: {},
            labyrinthCombatBuffs: [],
            fullAbilities: true,
        },
    }));
const settle = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
};
let context;
let downloads;
let poolButton;

beforeEach(async () => {
    await logs.disable();
    world.character = 'char1';
    world.records.clear();
    world.gates.clear();
    world.reads = [];
    world.runs = [];
    world.unavailable = false;
    world.records.set(key(), { clearedAt: 0, entries: fights() });
    downloads = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
        downloads.push(blob);
        return 'blob:test';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    context = {
        ...simCacheMethods,
        _snapshotContentFingerprint: () => 'current-build',
        getSimHours: () => 1,
        getSimStopRule: () => ({ maxTrials: 10 }),
    };
    logs.useSimSource({
        fingerprint: () => 'current-build',
        accuracy: async () => null,
        replay: () => context.replayRecordedFights(),
        replayCohorts: () => context.replayCohortOptions(),
    });
    logs.poolAllGear = false;
    logs.ensurePanel();
    logs.view = 'pool';
    logs.render(false);
    poolButton = [...logs.panel.querySelectorAll('button')].find((button) => button.textContent === 'Save pool');
});
afterEach(async () => {
    for (const gate of world.gates.values()) gate.resolve();
    await settle();
    await logs.disable();
    for (const timer of logs._buttonFlashes?.values() || []) clearTimeout(timer);
    logs._buttonFlashes?.clear();
    document.body.textContent = '';
    vi.restoreAllMocks();
});

const start = (action) => {
    if (action === 'Replay') return context.replayRecordedFights();
    if (action === 'Cohorts') return context.replayCohortOptions();
    if (action === 'Sanitized') return logs.exportSanitized();
    poolButton.click();
};

describe('requests made before the deferred pool load', () => {
    test.each(
        ['Save pool', 'Sanitized'].flatMap((action) => [false, true].map((unavailable) => ({ action, unavailable })))
    )(
        '$action explains a missing character and permits retry after login (storage unavailable: $unavailable)',
        async ({ action, unavailable }) => {
            world.character = null;
            world.unavailable = unavailable;
            const load = vi.spyOn(recorder, 'load');
            const button = action === 'Save pool' ? poolButton : logs.sanitizedButton;
            for (let click = 0; click < 2; click++) {
                await start(action);
                await settle();
                expect(button.textContent).toBe('Character not ready');
                expect(button.disabled).toBe(false);
            }
            expect(load).not.toHaveBeenCalled();
            expect(world.reads).toEqual([]);
            expect(downloads).toHaveLength(0);
            expect(logs._poolExportRequest).toBeFalsy();
            expect(logs._sanitizedExportRequest).toBeFalsy();

            world.character = 'char1';
            world.unavailable = false;
            await start(action);
            await settle();
            expect(button.textContent).toBe('Saved ✓');
            expect(button.disabled).toBe(false);
            expect(world.reads).toEqual([key()]);
            expect(downloads).toHaveLength(1);
            expect(JSON.parse(await downloads[0].text()).attempts).toHaveLength(3);
        }
    );

    test.each(['Replay', 'Cohorts', 'Save pool', 'Sanitized'])('%s waits for saved fights', async (action) => {
        const gate = deferred();
        world.gates.set(key(), gate);
        const pending = start(action);
        await settle();
        expect(world.reads).toEqual([key()]);
        expect(world.runs).toHaveLength(0);
        expect(downloads).toHaveLength(0);
        gate.resolve();
        const result = await pending;
        await settle();
        if (action === 'Replay') {
            expect(result.groups).toHaveLength(1);
            expect(world.runs).toHaveLength(1);
        } else if (action === 'Cohorts') {
            expect(result.cohorts).toHaveLength(1);
            expect(result.cohorts[0].fights).toBe(3);
        } else {
            expect(downloads).toHaveLength(1);
            const file = JSON.parse(await downloads[0].text());
            expect(file.attempts).toHaveLength(3);
            if (action === 'Save pool') {
                expect(file.poolSummary[0].fights).toBe(3);
                expect(file.characterId).toBe('char1');
            } else {
                expect(file.sanitized).toBe(true);
                expect(JSON.stringify(file)).not.toContain('char1');
            }
        }
    });

    test('all four requests share the pending recorder load', async () => {
        const gate = deferred();
        world.gates.set(key(), gate);
        const pending = ['Replay', 'Cohorts', 'Save pool', 'Sanitized'].map(start);
        await settle();
        expect(world.reads).toEqual([key()]);
        gate.resolve();
        await Promise.all(pending);
        await settle();
        expect(downloads).toHaveLength(2);
        expect(world.runs).toHaveLength(1);
    });

    test.each(['Save pool', 'Sanitized'])(
        '%s coalesces repeated clicks and is usable again afterward',
        async (action) => {
            const gate = deferred();
            world.gates.set(key(), gate);
            const pending = start(action);
            start(action);
            await settle();
            gate.resolve();
            await pending;
            await settle();
            expect(downloads).toHaveLength(1);
            await start(action);
            await settle();
            expect(downloads).toHaveLength(2);
        }
    );

    test('repeated Cohorts clicks cannot leave a late request that reopens a closed picker', async () => {
        const gate = deferred();
        world.gates.set(key(), gate);
        const spy = vi.spyOn(logs.simSource, 'replayCohorts');
        const pending = logs.onCohortsClicked();
        await logs.onCohortsClicked();
        expect(spy).toHaveBeenCalledTimes(1);
        gate.resolve();
        await pending;
        expect(logs.cohortPickerOpen).toBe(true);
        await logs.onCohortsClicked();
        expect(logs.cohortPickerOpen).toBe(false);
    });

    test.each(['Replay', 'Cohorts', 'Save pool', 'Sanitized'])(
        '%s distinguishes a failed read from an empty pool and can retry',
        async (action) => {
            world.unavailable = true;
            if (action === 'Replay' || action === 'Cohorts')
                await expect(start(action)).rejects.toThrow('could not be loaded');
            else {
                await start(action);
                await settle();
                expect(action === 'Save pool' ? poolButton.textContent : logs.sanitizedButton.textContent).toBe(
                    'Load failed'
                );
            }
            expect(world.runs).toHaveLength(0);
            expect(downloads).toHaveLength(0);
            world.unavailable = false;
            const result = await start(action);
            await settle();
            if (action === 'Replay') expect(result.groups).toHaveLength(1);
            else if (action === 'Cohorts') expect(result.cohorts).toHaveLength(1);
            else expect(downloads).toHaveLength(1);
        }
    );

    test.each(['Replay', 'Cohorts', 'Save pool', 'Sanitized'])(
        '%s handles a successfully loaded empty pool',
        async (action) => {
            world.records.set(key(), { clearedAt: 0, entries: [] });
            const result = await start(action);
            await settle();
            expect(world.reads).toEqual([key()]);
            expect(world.runs).toHaveLength(0);
            expect(downloads).toHaveLength(0);
            if (action === 'Replay') expect(result.pool.attempts).toBe(0);
            else if (action === 'Cohorts') expect(result.cohorts).toEqual([]);
            else
                expect(action === 'Save pool' ? poolButton.textContent : logs.sanitizedButton.textContent).toBe(
                    'Nothing yet'
                );
        }
    );

    test.each(['Save pool', 'Sanitized'])(
        '%s discards a request when the character changes before teardown',
        async (action) => {
            const gate = deferred();
            world.gates.set(key(), gate);
            const pending = start(action);
            world.character = 'char2';
            gate.resolve();
            await pending;
            await settle();
            expect(downloads).toHaveLength(0);
        }
    );

    test.each(['Replay', 'Cohorts', 'Save pool', 'Sanitized'])(
        '%s stands down on same-character disable while loading',
        async (action) => {
            const gate = deferred();
            world.gates.set(key(), gate);
            const pending = start(action);
            await logs.disable();
            context.endSimEpoch();
            gate.resolve();
            const result = await pending;
            await settle();
            expect(downloads).toHaveLength(0);
            expect(world.runs).toHaveLength(0);
            if (action === 'Replay') expect(result.diagnostics.cancelled).toBe(true);
            if (action === 'Cohorts') expect(result).toBeNull();
        }
    );

    test('Save pool coalesces another click after the pool view redraws during its load', async () => {
        const gate = deferred();
        world.gates.set(key(), gate);
        poolButton.click();
        logs.render(false);
        const next = [...logs.panel.querySelectorAll('button')].find((button) => button.textContent === 'Save pool');
        expect(next).not.toBe(poolButton);
        next.click();
        gate.resolve();
        await settle();
        expect(downloads).toHaveLength(1);
        expect(world.reads).toEqual([key()]);
    });

    test.each(['Replay', 'Cohorts'])(
        '%s checks a character change even before the source epoch changes',
        async (action) => {
            const gate = deferred();
            world.gates.set(key(), gate);
            const pending = start(action);
            world.character = 'char2';
            gate.resolve();
            const result = await pending;
            expect(world.runs).toHaveLength(0);
            if (action === 'Replay') expect(result.diagnostics.cancelled).toBe(true);
            else expect(result).toBeNull();
        }
    );

    test.each(['Save pool', 'Sanitized'])(
        '%s restores its button and permits retry if loading throws',
        async (action) => {
            const spy = vi.spyOn(recorder, 'load').mockRejectedValueOnce(new Error('unexpected read failure'));
            await start(action);
            await settle();
            const button = action === 'Save pool' ? poolButton : logs.sanitizedButton;
            expect(button.disabled).toBe(false);
            expect(button.textContent).toBe('Load failed');
            expect(downloads).toHaveLength(0);
            spy.mockRestore();
            await start(action);
            await settle();
            expect(downloads).toHaveLength(1);
        }
    );

    test('Sanitized keeps its existing pool-only fallback when the accuracy source fails', async () => {
        logs.simSource.accuracy = async () => {
            throw new Error('accuracy unavailable');
        };
        await logs.exportSanitized();
        expect(downloads).toHaveLength(1);
        expect(JSON.parse(await downloads[0].text()).attempts).toHaveLength(3);
    });

    test('a fight recorded during the read stays beside the saved fights', async () => {
        const gate = deferred();
        world.gates.set(key(), gate);
        const pending = logs.exportSanitized();
        recorder.noteAttempt({ ...fights(1, 'live')[0], monsterMaxHp: 100, resolvedAt: Date.now() });
        gate.resolve();
        await pending;
        await settle();
        expect(JSON.parse(await downloads[0].text()).attempts).toHaveLength(4);
    });

    test('an unreadable stored pool never exports only the fights from this session', async () => {
        world.unavailable = true;
        recorder.noteAttempt({ ...fights(1)[0], monsterMaxHp: 100, resolvedAt: Date.now() });
        await settle();
        expect(recorder.recordedAttempts()).toHaveLength(1);
        await logs.exportSanitized();
        expect(downloads).toHaveLength(0);
        expect(logs.sanitizedButton.textContent).toBe('Load failed');
        world.unavailable = false;
        await logs.exportSanitized();
        expect(JSON.parse(await downloads[0].text()).attempts).toHaveLength(4);
    });

    test.each([3, 101, 1000])('loading on demand preserves a pending reset of %i fights', async (count) => {
        world.records.set(key(), { clearedAt: 0, entries: fights(count) });
        const gate = deferred();
        world.gates.set(key(), gate);
        recorder.clearRecording();
        const pending = recorder.load();
        gate.resolve();
        expect(await pending).toEqual([]);
        expect(recorder.recordedAttempts()).toEqual([]);
        await settle();
        expect(world.records.get(key()).entries).toEqual([]);
    });

    test('a reset during the load does not resurrect more than a hundred old fights', async () => {
        world.records.set(key(), { clearedAt: 0, entries: fights(101) });
        const gate = deferred();
        world.gates.set(key(), gate);
        const pending = recorder.load();
        recorder.clearRecording();
        gate.resolve();
        expect(await pending).toEqual([]);
        expect(recorder.recordedAttempts()).toEqual([]);
    });

    test('a fight recorded after Reset retains its clear epoch when the old pool is still stored', async () => {
        const before = { clearedAt: 0, entries: fights(101) };
        world.records.set(key(), before);
        recorder.clearRecording();
        await settle();
        // A stale read or sync restore still sees the pre-Reset value.
        world.records.set(key(), before);
        recorder.noteAttempt({ ...fights(1, 'live')[0], monsterMaxHp: 100, resolvedAt: Date.now() + 1 });
        await settle();
        expect(recorder.recordedAttempts()).toHaveLength(1);
        expect(world.records.get(key()).entries).toHaveLength(1);
        expect(world.records.get(key()).clearedAt).toBeGreaterThan(0);
    });

    test('a pull keeps a locally held Reset of more than a hundred fights', async () => {
        const { announceSyncPullApplied } = await import('../../utils/sync-merge-registry.js');
        const before = { clearedAt: 0, entries: fights(101) };
        world.records.set(key(), before);
        await recorder.load();
        recorder.clearRecording();
        await settle();
        world.records.set(key(), before);
        announceSyncPullApplied({ labyrinth: [key()] });
        await settle();
        expect(recorder.recordedAttempts()).toEqual([]);
    });

    test('Sanitized rechecks ownership after the separate accuracy read', async () => {
        const gate = deferred();
        logs.simSource.accuracy = () => gate.promise;
        const pending = logs.exportSanitized();
        await settle();
        await logs.disable();
        world.character = 'char2';
        gate.resolve({ rows: [] });
        await pending;
        expect(downloads).toHaveLength(0);
    });

    test("an old load cannot release or publish the new character's pending load", async () => {
        const oldGate = deferred();
        world.gates.set(key(), oldGate);
        const oldLoad = recorder.load();
        recorder.forget();
        world.character = 'char2';
        world.records.set(key(), { clearedAt: 0, entries: fights(4, 'new') });
        const newGate = deferred();
        world.gates.set(key(), newGate);
        const newLoad = recorder.load();
        oldGate.resolve();
        expect(await oldLoad).toBeNull();
        expect(recorder.recordedAttempts()).toEqual([]);
        const joining = recorder.load();
        expect(world.reads).toEqual([key('char1'), key('char2')]);
        newGate.resolve();
        const [first, second] = await Promise.all([newLoad, joining]);
        expect(first).toHaveLength(4);
        expect(second).toEqual(first);
        expect(recorder.recordedAttempts().map((fight) => fight.recordId)).toEqual(
            fights(4, 'new').map((fight) => fight.recordId)
        );
    });
});
