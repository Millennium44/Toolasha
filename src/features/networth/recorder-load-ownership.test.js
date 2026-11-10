/** Gold Sources can read these histories while their recording listeners are off. */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ characterId: 'alice', reads: [], writes: [] }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => state.characterId,
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
vi.mock('../../core/storage.js', () => ({ default: { isQuotaExceeded: () => false } }));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../utils/chunked-history.js', () => ({
    timeChunkId: () => '2026-08-20',
    createChunkedHistory: ({ prefix }) => ({
        load: (characterId) => new Promise((resolve) => state.reads.push({ prefix, characterId, resolve })),
        save: (characterId, rows) => state.writes.push({ characterId, rows: structuredClone(rows) }),
        forget: () => {},
    }),
}));
vi.mock('./day-row-retention.js', () => ({ registerDayRowRetention: () => {}, pruneDayRows: () => (rows) => rows }));
vi.mock('./gold-sources.js', () => ({
    localDayId: (time) => new Date(time).toISOString().slice(0, 10),
    dayStart: (time) => Date.parse(new Date(time).toISOString().slice(0, 10)),
    GATHERING_ACTION_TYPES: new Set(),
}));
vi.mock('../inventory/treasure-tracker.js', () => ({ isScrollItem: () => false }));
vi.mock('../../utils/offline-economics-calculator.js', () => ({ calculateOfflineEconomics: () => null }));
vi.mock('../../utils/market-data.js', () => ({ getItemPrice: () => 0 }));
vi.mock('../../utils/dungeon-key-forecast.js', () => ({ dungeonEntryKey: () => null }));

beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-20T09:00:00.000Z'));
    state.characterId = 'alice';
    state.reads = [];
    state.writes = [];
});

afterEach(() => vi.useRealTimers());

const modules = [
    ['production', () => import('./production-income-recorder.js')],
    ['chests', () => import('./chest-opening-recorder.js')],
    ['item flow', () => import('./item-flow-recorder.js')],
];

describe.each(modules)('%s history load ownership', (_name, module) => {
    test.each(['old-first', 'new-first'])(
        'keeps concurrent character reads separate when completed %s',
        async (order) => {
            const recorder = (await module()).default;
            const aliceRows = [{ d: '2026-08-19' }];
            const bobRows = [{ d: '2026-08-20' }];
            const alice = recorder.load();
            state.characterId = 'bob';
            const bob = recorder.load();
            const reads = order === 'old-first' ? state.reads : [...state.reads].reverse();
            for (const read of reads) read.resolve(read.characterId === 'alice' ? aliceRows : bobRows);
            const [oldRows, currentRows] = await Promise.all([alice, bob]);
            expect(currentRows).toEqual(bobRows);
            expect(oldRows).toEqual([]);
            expect(recorder._rows).toEqual(bobRows);
            expect(state.writes).toEqual([]);
        }
    );

    test('does not publish or return old-character rows before a new reader starts', async () => {
        const recorder = (await module()).default;
        const alice = recorder.load();
        state.characterId = 'bob';
        state.reads[0].resolve([{ d: '2026-08-19' }]);
        expect(await alice).toEqual([]);
        expect(recorder._rows).toEqual([]);
    });
});

describe.each(modules)('%s history reload controls', (_name, module) => {
    test('returning after an abandoned read reloads full history before saving', async () => {
        const recorder = (await module()).default;
        const saved = [{ d: '2026-08-19' }];
        const old = recorder.load();
        state.characterId = 'bob';
        state.reads[0].resolve(structuredClone(saved));
        await old;
        state.characterId = 'alice';
        const current = recorder.load();
        state.reads[1]?.resolve(structuredClone(saved));
        expect(await current).toEqual(saved);
        recorder._rowFor('2026-08-20');
        recorder._save();
        expect(state.writes.at(-1).rows).toContainEqual(saved[0]);
    });

    test('three readers of the current character share one history load', async () => {
        const recorder = (await module()).default;
        const readers = [recorder.load(), recorder.load(), recorder.load()];
        expect(state.reads).toHaveLength(1);
        state.reads[0].resolve([{ d: '2026-08-20' }]);
        for (const rows of await Promise.all(readers)) expect(rows).toEqual([{ d: '2026-08-20' }]);
    });
});

test('history ownership changes preserve a freshly seeded production counter baseline', async () => {
    const recorder = (await import('./production-income-recorder.js')).default;
    const old = recorder.load();
    state.characterId = 'bob';
    recorder._counts.set('bob-action', 123);
    const current = recorder.load();
    for (const read of state.reads) read.resolve([]);
    await Promise.all([old, current]);
    expect(recorder._counts.get('bob-action')).toBe(123);
});

test('history ownership changes preserve freshly seeded item-flow inventory and food slots', async () => {
    const recorder = (await import('./item-flow-recorder.js')).default;
    const old = recorder.load();
    state.characterId = 'bob';
    const inventory = new Map([['/items/milk', 123]]);
    const slots = [{ itemHrid: '/items/milk', isActive: true }];
    recorder._inventory = inventory;
    recorder._combatFoodSlots = slots;
    const current = recorder.load();
    for (const read of state.reads) read.resolve([]);
    await Promise.all([old, current]);
    expect(recorder._inventory).toBe(inventory);
    expect(recorder._combatFoodSlots).toBe(slots);
});

test('an awaiting gathering consumer uses its own load result, not the next character’s rows', async () => {
    const recorder = (await import('./item-flow-recorder.js')).default;
    const gathering = (count) => [
        {
            d: '2026-08-20',
            gathering: { 42: { stretches: [{ from: 100, to: 200, gained: { '/items/milk': count } }] } },
        },
    ];
    const old = recorder.getRunGathering(42);
    state.characterId = 'bob';
    const current = recorder.load();
    for (const read of [...state.reads].reverse()) read.resolve(gathering(read.characterId === 'alice' ? 3 : 99));
    await current;
    expect(await old).toBeNull();
});
