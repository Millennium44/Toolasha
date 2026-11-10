/** A recorder stopped during storage loading must not persist a late observation. */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
    characterId: 42,
    characterData: null,
    enabled: true,
    reads: [],
    writes: [],
    handlers: new Map(),
    socketHandlers: new Map(),
    settingHandlers: new Map(),
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => state.characterId,
        get characterData() {
            return state.characterData;
        },
        isFromActiveSocket: () => true,
        on: (event, handler) => state.handlers.set(event, handler),
        off: (event, handler) => {
            if (state.handlers.get(event) === handler) state.handlers.delete(event);
        },
    },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (event, handler) => state.socketHandlers.set(event, handler),
        off: (event, handler) => {
            if (state.socketHandlers.get(event) === handler) state.socketHandlers.delete(event);
        },
    },
}));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => state.enabled,
        onSettingChange: (key, handler) => state.settingHandlers.set(key, handler),
        offSettingChange: (key, handler) => {
            if (state.settingHandlers.get(key) === handler) state.settingHandlers.delete(key);
        },
    },
}));
vi.mock('../../core/storage.js', () => ({ default: { isQuotaExceeded: () => false } }));
vi.mock('../../utils/chunked-history.js', () => ({
    timeChunkId: () => '2026-08-20',
    createChunkedHistory: () => ({
        load: (characterId) => new Promise((resolve) => state.reads.push({ characterId, resolve })),
        save: (characterId, rows) => state.writes.push({ characterId, rows: structuredClone(rows) }),
        forget: () => {},
    }),
}));
vi.mock('./day-row-retention.js', () => ({ registerDayRowRetention: () => {}, pruneDayRows: () => (rows) => rows }));
vi.mock('./gold-sources.js', () => ({
    localDayId: (time) => new Date(time).toISOString().slice(0, 10),
    dayStart: (time) => Date.parse(new Date(time).toISOString().slice(0, 10)),
}));

// Existing combat-loot-recorder.test.js documents these cached init and battle shapes.
const summary = (id = 42) => ({
    character: { id, lastOfflineTime: '2026-08-20T00:00:00.000Z' },
    currentTimestamp: '2026-08-20T08:00:00.000Z',
    offlineItems: [{ itemHrid: '/items/milk', offlineCount: 3 }],
});
const battle = () => ({
    combatStartTime: '2026-08-20T08:00:00.000Z',
    players: [{ character: { id: 42 }, totalLootMap: { a: { itemHrid: '/items/milk', count: 4 } } }],
});
let recorder;
beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-20T09:00:00.000Z'));
    state.characterId = 42;
    state.characterData = summary();
    state.enabled = true;
    state.reads = [];
    state.writes = [];
    state.handlers.clear();
    state.socketHandlers.clear();
    state.settingHandlers.clear();
    recorder = (await import('./combat-loot-recorder.js')).default;
});
afterEach(() => {
    recorder.cleanup();
    vi.useRealTimers();
});

describe('combat-loot startup ownership', () => {
    test('does not record its cached summary after cleanup during the initial load', async () => {
        const starting = recorder.initialize();
        recorder.cleanup();
        state.reads[0].resolve([]);
        await starting;
        expect(state.writes).toEqual([]);
        expect(recorder.isActive).toBe(false);
        expect(state.handlers.size).toBe(0);
        expect(state.socketHandlers.size).toBe(0);
    });

    test('a retired startup cannot record again after same-character re-enable', async () => {
        const oldStart = recorder.initialize();
        recorder.cleanup();
        const newStart = recorder.initialize();
        state.reads[0].resolve([]);
        await Promise.all([oldStart, newStart]);
        expect(state.writes).toHaveLength(1);
    });

    test('a current startup still records the cached offline window', async () => {
        const starting = recorder.initialize();
        state.reads[0].resolve([]);
        await starting;
        expect(state.writes).toHaveLength(1);
        expect(state.writes[0].characterId).toBe(42);
        expect(state.writes[0].rows[0].offline).toEqual([
            [Date.parse('2026-08-20T00:00:00.000Z'), Date.parse('2026-08-20T08:00:00.000Z')],
        ]);
    });
});

describe('observations suspended in the shared history load', () => {
    test.each(['battle', 'offline'])('does not save an in-flight %s after cleanup', async (kind) => {
        state.characterData = null;
        const starting = recorder.initialize();
        const observing =
            kind === 'battle'
                ? state.socketHandlers.get('new_battle')(battle(), {})
                : state.handlers.get('character_initialized')(summary());
        recorder.cleanup();
        state.reads[0].resolve([]);
        await Promise.all([starting, observing]);
        expect(state.writes).toEqual([]);
    });

    test.each(['battle', 'offline'])(
        'does not save an in-flight %s after the recording setting is turned off',
        async (kind) => {
            state.characterData = null;
            const starting = recorder.initialize();
            const observing =
                kind === 'battle'
                    ? state.socketHandlers.get('new_battle')(battle(), {})
                    : state.handlers.get('character_initialized')(summary());
            state.enabled = false;
            state.reads[0].resolve([]);
            await Promise.all([starting, observing]);
            expect(state.writes).toEqual([]);
        }
    );
});

describe('inactive recorder consumers', () => {
    test('the gold-sources reader can still load saved history without starting recording', async () => {
        const rows = [{ d: '2026-08-20', runs: {} }];
        const reading = recorder.load();
        state.reads[0].resolve(rows);
        expect(await reading).toEqual(rows);
        expect(recorder.isActive).toBe(false);
        expect(state.writes).toEqual([]);
        expect(state.handlers.size).toBe(0);
    });

    test.each(['battle', 'offline'])('a detached %s callback cannot start a new recording', async (kind) => {
        state.characterData = null;
        const starting = recorder.initialize();
        const handler =
            kind === 'battle' ? state.socketHandlers.get('new_battle') : state.handlers.get('character_initialized');
        state.reads[0].resolve([]);
        await starting;
        recorder.cleanup();
        await handler(kind === 'battle' ? battle() : summary(), {});
        expect(state.writes).toEqual([]);
    });
});

describe('recording setting generations', () => {
    test.each(['battle', 'offline'])(
        'an off-then-on change retires a suspended %s without blocking future observations',
        async (kind) => {
            state.characterData = null;
            const starting = recorder.initialize();
            const handler =
                kind === 'battle'
                    ? state.socketHandlers.get('new_battle')
                    : state.handlers.get('character_initialized');
            const payload = kind === 'battle' ? battle() : summary();
            const oldObservation = handler(payload, {});
            state.enabled = false;
            state.settingHandlers.get('networth_goldSources')?.(false);
            state.enabled = true;
            state.settingHandlers.get('networth_goldSources')?.(true);
            state.reads[0].resolve([]);
            await Promise.all([starting, oldObservation]);
            expect(state.writes).toEqual([]);
            await handler(payload, {});
            expect(state.writes).toHaveLength(1);
            recorder.cleanup();
            expect(state.settingHandlers.size).toBe(0);
        }
    );
});

describe('read-only history loads across characters', () => {
    test.each(['old-first', 'new-first'])('does not share an old-character load when completed %s', async (order) => {
        const aliceRows = [{ d: '2026-08-19', runs: { alice: {} } }];
        const bobRows = [{ d: '2026-08-20', runs: { bob: {} } }];
        const alice = recorder.load();
        state.characterId = 77;
        const bob = recorder.load();
        const reads = order === 'old-first' ? state.reads : [...state.reads].reverse();
        for (const read of reads) read.resolve(read.characterId === 42 ? aliceRows : bobRows);
        const [oldRows, currentRows] = await Promise.all([alice, bob]);
        expect(currentRows).toEqual(bobRows);
        expect(oldRows).toEqual([]);
        expect(recorder._rows).toEqual(bobRows);
        expect(state.writes).toEqual([]);
    });

    test('a load that finishes after the character changes cannot publish even before a new read starts', async () => {
        const alice = recorder.load();
        state.characterId = 77;
        state.reads[0].resolve([{ d: '2026-08-19', runs: { alice: {} } }]);
        expect(await alice).toEqual([]);
        expect(recorder._rows).toEqual([]);
        expect(state.writes).toEqual([]);
    });
});

describe('returning after an abandoned read', () => {
    test.each(['read', 'record'])(
        'reloads saved rows before the next %s after A -> B -> A without a B read',
        async (next) => {
            const saved = [{ d: '2026-08-19', runs: { alice: { stretches: [] } } }];
            const oldRead = recorder.load();
            state.characterId = 77;
            state.reads[0].resolve(structuredClone(saved));
            await oldRead;
            state.characterId = 42;
            const returning = next === 'read' ? recorder.load() : recorder.initialize();
            state.reads[1]?.resolve(structuredClone(saved));
            const returned = await returning;
            if (next === 'read') expect(returned).toEqual(saved);
            else {
                expect(state.writes).toHaveLength(1);
                expect(state.writes[0].rows).toContainEqual(saved[0]);
                expect(state.writes[0].rows).toHaveLength(2);
            }
            expect(state.reads).toHaveLength(2);
        }
    );
});

test('three concurrent readers of one character share one load and retain all rows', async () => {
    const rows = [
        { d: '2026-08-19', runs: {} },
        { d: '2026-08-20', runs: {} },
    ];
    const readers = [recorder.load(), recorder.load(), recorder.load()];
    expect(state.reads).toHaveLength(1);
    state.reads[0].resolve(rows);
    const results = await Promise.all(readers);
    for (const result of results) expect(result).toEqual(rows);
    expect(results[0]).not.toBe(results[1]);
    expect(state.writes).toEqual([]);
});
