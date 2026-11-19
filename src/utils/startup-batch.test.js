import { beforeEach, describe, expect, test, vi } from 'vitest';

const world = vi.hoisted(() => ({
    characterId: 'c1',
    stored: new Map(),
    unreadable: false,
    manyCalls: [],
    tryManyCalls: [],
    singleGets: [],
    singleTryGets: [],
    /** Fired inside a batched read, so a test can land a character switch in it */
    onBatch: null,
}));

vi.mock('../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => world.characterId },
}));
vi.mock('./adoption-consent.js', () => ({
    getAdoptionTargetId: async () => world.characterId,
    requestAdoptionConsent: () => {},
}));
vi.mock('../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback = null) => {
            world.singleGets.push(key);
            if (world.unreadable) return fallback;
            return world.stored.has(key) ? world.stored.get(key) : fallback;
        },
        tryGet: async (key) => {
            world.singleTryGets.push(key);
            if (world.unreadable) return null;
            return world.stored.has(key)
                ? { found: true, value: world.stored.get(key) }
                : { found: false, value: null };
        },
        getMany: async (keys) => {
            world.manyCalls.push([...keys]);
            world.onBatch?.();
            return new Map(
                keys.map((key) => [key, !world.unreadable && world.stored.has(key) ? world.stored.get(key) : null])
            );
        },
        tryGetMany: async (keys) => {
            world.tryManyCalls.push([...keys]);
            world.onBatch?.();
            if (world.unreadable) return null;
            return new Map(
                keys.map((key) => [
                    key,
                    world.stored.has(key)
                        ? { found: true, value: world.stored.get(key) }
                        : { found: false, value: null },
                ])
            );
        },
        updateMany: async (_store, keys, mutate) => {
            const values = Object.fromEntries(keys.map((key) => [key, world.stored.get(key)]));
            const entries = mutate(values) || {};
            for (const [key, value] of Object.entries(entries)) world.stored.set(key, value);
            return { values: { ...values, ...entries }, written: Object.keys(entries) };
        },
        delete: async (key) => {
            world.stored.delete(key);
            return true;
        },
    },
}));

const { createStartupReader, DIRECT_READS } = await import('./startup-batch.js');

beforeEach(() => {
    world.characterId = 'c1';
    world.stored = new Map();
    world.unreadable = false;
    world.manyCalls = [];
    world.tryManyCalls = [];
    world.singleGets = [];
    world.singleTryGets = [];
    world.onBatch = null;
});

const spec = {
    plain: ['plainA', 'plainB', 'plainZero'],
    scoped: ['scopedOn', 'scopedAbsent', 'scopedLegacy'],
    checked: ['record', 'recordAbsent'],
};

describe('createStartupReader', () => {
    test('every key rides one getMany and one tryGetMany, and no single read is made', async () => {
        world.stored.set('plainA', 'a');
        world.stored.set('scopedOn_c1', true);
        world.stored.set('record_c1', { values: {} });
        const reader = createStartupReader(spec);

        await reader.get('plainA', 'settings', null);
        await reader.scoped('scopedOn', 'settings', false);
        await reader.checked('record', 'settings');

        expect(world.manyCalls).toHaveLength(1);
        expect(world.manyCalls[0]).toEqual(
            expect.arrayContaining(['plainA', 'plainB', 'scopedOn_c1', 'scopedOn', 'scopedLegacy_c1', 'scopedLegacy'])
        );
        expect(world.tryManyCalls).toEqual([['record_c1', 'record', 'recordAbsent_c1', 'recordAbsent']]);
        expect(world.singleGets).toEqual([]);
        expect(world.singleTryGets).toEqual([]);
    });

    test('stored values come back, absent keys give their own default, a stored falsy value is kept', async () => {
        world.stored.set('plainA', 'a');
        world.stored.set('plainZero', 0);
        world.stored.set('scopedOn_c1', false);
        const reader = createStartupReader(spec);

        expect(await reader.get('plainA', 'settings', 'dflt')).toBe('a');
        expect(await reader.get('plainB', 'settings', 'dflt')).toBe('dflt');
        expect(await reader.get('plainZero', 'settings', 5)).toBe(0);
        expect(await reader.scoped('scopedOn', 'settings', true)).toBe(false);
        expect(await reader.scoped('scopedAbsent', 'settings', true)).toBe(true);
        expect(await reader.checked('record', 'settings')).toEqual({ ok: true, value: null });
        expect(await reader.checked('recordAbsent', 'settings')).toEqual({ ok: true, value: null });
    });

    test('a checked record reads as the stored value, and the legacy bare key is adopted when the scoped one is absent', async () => {
        world.stored.set('record_c1', { values: { a: 1 } });
        world.stored.set('scopedLegacy', 'old');
        const reader = createStartupReader(spec);

        expect(await reader.checked('record', 'settings')).toEqual({ ok: true, value: { values: { a: 1 } } });
        expect(await reader.scoped('scopedLegacy', 'settings', 'dflt')).toBe('old');
        expect(world.stored.get('scopedLegacy_c1')).toBe('old');
        expect(world.stored.has('scopedLegacy')).toBe(false);
    });

    test('an unreadable store keeps the defaults for get, and ok:false for the checked read', async () => {
        world.stored.set('plainA', 'a');
        world.stored.set('record_c1', { values: {} });
        world.unreadable = true;
        const reader = createStartupReader(spec);

        expect(await reader.get('plainA', 'settings', 'dflt')).toBe('dflt');
        expect(await reader.scoped('scopedOn', 'settings', true)).toBe(true);
        // The failed batch is re-read key by key, which is what says "could not be read"
        expect(await reader.checked('record', 'settings')).toEqual({ ok: false, value: null });
        expect(world.singleTryGets).toEqual(['record_c1']);
    });

    test("a character switch inside the batch is never answered with the departing character's values", async () => {
        world.stored.set('scopedOn_c1', 'from-c1');
        world.stored.set('scopedOn_c2', 'from-c2');
        world.stored.set('record_c1', { who: 'c1' });
        world.stored.set('record_c2', { who: 'c2' });
        world.onBatch = () => {
            world.characterId = 'c2';
        };
        const reader = createStartupReader(spec);

        expect(await reader.scoped('scopedOn', 'settings', null)).toBe('from-c2');
        expect(await reader.checked('record', 'settings')).toEqual({ ok: true, value: { who: 'c2' } });
    });

    test('a key or store the batch was not made for is read directly', async () => {
        world.stored.set('other', 'x');
        world.stored.set('foreign_c1', 'y');
        const reader = createStartupReader(spec);

        expect(await reader.get('other', 'settings', null)).toBe('x');
        expect(await reader.scoped('foreign', 'settings', null)).toBe('y');
        expect(await reader.get('plainA', 'otherStore', 'dflt')).toBe('dflt');
        expect(world.singleGets).toEqual(expect.arrayContaining(['other', 'foreign_c1', 'plainA']));
    });
});

describe('DIRECT_READS', () => {
    test('reads one key at a time, as the restore functions did before', async () => {
        world.stored.set('k', 1);
        expect(await DIRECT_READS.get('k', 'settings', 0)).toBe(1);
        expect(await DIRECT_READS.checked('nope', 'settings')).toEqual({ ok: true, value: null });
        expect(world.manyCalls).toEqual([]);
    });
});
