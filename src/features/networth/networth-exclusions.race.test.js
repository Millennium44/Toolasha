/** A slow exclusions read must not replace newer character state or newer edits. */
import { beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
    characterId: 'alice',
    reads: [],
    writes: [],
    writeResult: true,
    handlers: new Map(),
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => state.characterId,
        on: (event, handler) => state.handlers.set(event, handler),
    },
}));
vi.mock('../../core/storage.js', () => {
    const read = (key) => new Promise((resolve, reject) => state.reads.push({ key, resolve, reject }));
    const parse = (value, _key, fallback = null) => {
        if (value == null) return fallback;
        try {
            return typeof value === 'string' ? JSON.parse(value) : value;
        } catch {
            return fallback;
        }
    };
    return {
        default: {
            getJSON: (key) => read(key).then((value) => parse(value, key, [])),
            tryGet: (key) => read(key).then((value) => (value === null ? null : { found: value !== undefined, value })),
            parseJSON: parse,
            setJSON: async (key, value) => {
                // Record each save call by value so later edits do not alter this test evidence.
                state.writes.push({ key, value: structuredClone(value) });
                return state.writeResult;
            },
        },
    };
});

let exclusions;
const houses = { type: 'assetType', value: 'houses' };
const ability = { type: 'ability', value: '/abilities/hammer_throw' };
const sword = { type: 'item', value: '/items/sword' };
const cheese = { type: 'item', value: '/items/cheese' };

beforeEach(async () => {
    vi.resetModules();
    state.characterId = 'alice';
    state.reads = [];
    state.writes = [];
    state.writeResult = true;
    state.handlers.clear();
    exclusions = await import('./networth-exclusions.js');
});

describe('character-owned exclusion loading', () => {
    test('does not serve the departed character while the new list is still loading', async () => {
        const alice = exclusions.initExclusions();
        state.reads[0].resolve([houses]);
        await alice;
        state.characterId = 'bob';
        const bob = exclusions.initExclusions();
        expect(exclusions.getExclusions()).toEqual([]);
        expect(exclusions.isExcluded(houses.type, houses.value)).toBe(false);
        state.reads[1].resolve([ability]);
        await bob;
        expect(exclusions.getExclusions()).toEqual([ability]);
    });

    test('a late old-character read cannot replace the current list after its initialization', async () => {
        const alice = exclusions.initExclusions();
        state.characterId = 'bob';
        const bob = exclusions.initExclusions();
        state.reads[1].resolve([ability]);
        await bob;
        state.reads[0].resolve([houses]);
        await alice;
        expect(exclusions.getExclusions()).toEqual([ability]);
        expect(exclusions.isExcluded(houses.type, houses.value)).toBe(false);
        expect(exclusions.isExcluded(ability.type, ability.value)).toBe(true);
    });

    test('an old read cannot resurrect exclusions cleared after it started', async () => {
        const loading = exclusions.initExclusions();
        await exclusions.clearExclusions();
        state.reads[0].resolve([houses]);
        await loading;
        expect(exclusions.getExclusions()).toEqual([]);
        await exclusions.addExclusion(sword.type, sword.value);
        expect(state.writes.at(-1)).toEqual({ key: 'networth_exclusions_alice', value: [sword] });
    });

    test('a newer clear cancels an add still waiting on a cold read', async () => {
        const adding = exclusions.addExclusion(sword.type, sword.value);
        await exclusions.clearExclusions();
        state.reads[0].resolve([houses]);
        await adding;
        expect(exclusions.getExclusions()).toEqual([]);
        expect(state.writes).toEqual([{ key: 'networth_exclusions_alice', value: [] }]);
    });

    test('a newer clear cancels a remove still waiting on a cold read', async () => {
        const removing = exclusions.removeExclusion(sword.type, sword.value);
        await exclusions.clearExclusions();
        state.reads[0].resolve([houses, sword]);
        await removing;
        expect(exclusions.getExclusions()).toEqual([]);
        expect(state.writes).toEqual([{ key: 'networth_exclusions_alice', value: [] }]);
    });

    test('same-character cold additions share one load and retain both changes', async () => {
        const addingSword = exclusions.addExclusion(sword.type, sword.value);
        const addingCheese = exclusions.addExclusion(cheese.type, cheese.value);
        // Resolve independent snapshots if the old implementation started two reads.
        for (const read of state.reads) read.resolve(structuredClone([houses]));
        await Promise.all([addingSword, addingCheese]);
        expect(exclusions.getExclusions()).toEqual([houses, sword, cheese]);
        expect(state.writes.at(-1)).toEqual({ key: 'networth_exclusions_alice', value: [houses, sword, cheese] });
        expect(state.reads).toHaveLength(1);
    });

    test('same-character initialization cannot erase a concurrent saved addition', async () => {
        const initial = exclusions.initExclusions();
        const adding = exclusions.addExclusion(sword.type, sword.value);
        // A deduplicated load has only the first read; otherwise land the edit first.
        (state.reads[1] || state.reads[0]).resolve(structuredClone([houses]));
        await adding;
        state.reads[0].resolve(structuredClone([houses]));
        await initial;
        expect(exclusions.getExclusions()).toEqual([houses, sword]);
        expect(state.reads).toHaveLength(1);
    });

    test('returning to the same character cannot revive a mutation from an earlier visit', async () => {
        const oldAdd = exclusions.addExclusion(sword.type, sword.value);
        state.characterId = 'bob';
        const bob = exclusions.initExclusions();
        state.characterId = 'alice';
        const newAlice = exclusions.initExclusions();
        state.reads[2].resolve([cheese]);
        await newAlice;
        state.reads[1].resolve([ability]);
        await bob;
        state.reads[0].resolve([houses]);
        await oldAdd;
        expect(exclusions.getExclusions()).toEqual([cheese]);
        expect(state.writes).toEqual([]);
    });

    test('a failed current load can be retried without discarding stored exclusions', async () => {
        const first = exclusions.initExclusions();
        state.reads[0].reject(new Error('read failed'));
        await expect(first).rejects.toThrow('read failed');
        expect(exclusions.getExclusions()).toEqual([]);
        const second = exclusions.initExclusions();
        state.reads[1].resolve([houses]);
        await second;
        expect(exclusions.getExclusions()).toEqual([houses]);
        expect(state.writes).toEqual([]);
    });

    test('a switched-away mutation still cannot write to either character', async () => {
        const adding = exclusions.addExclusion(sword.type, sword.value);
        state.characterId = 'bob';
        const bob = exclusions.initExclusions();
        state.reads[1].resolve([ability]);
        await bob;
        state.reads[0].resolve([houses]);
        await adding;
        expect(state.writes).toEqual([]);
    });
});

describe('coalesced switches and real storage read outcomes', () => {
    test('a switch through an uninitialized character retires an earlier visit', async () => {
        const oldAdd = exclusions.addExclusion(sword.type, sword.value);
        state.handlers.get('character_switching')?.({ oldId: 'alice', newId: 'bob' });
        state.characterId = 'bob';
        // Rapid switches coalesce feature startup: no exclusions API runs for Bob.
        state.handlers.get('character_switching')?.({ oldId: 'bob', newId: 'alice' });
        state.characterId = 'alice';
        const newVisit = exclusions.initExclusions();
        for (const read of state.reads) read.resolve(structuredClone([houses]));
        await Promise.all([oldAdd, newVisit]);
        expect(state.writes).toEqual([]);
        expect(exclusions.getExclusions()).toEqual([houses]);
    });

    test('an unreadable list does not become an empty overwrite and the next edit retries', async () => {
        const failedAdd = exclusions.addExclusion(sword.type, sword.value);
        // tryGet returns null for a failed read; getJSON historically folded this to [].
        state.reads[0].resolve(null);
        await failedAdd;
        expect(state.writes).toEqual([]);
        const retry = exclusions.addExclusion(sword.type, sword.value);
        state.reads[1].resolve([houses]);
        await retry;
        expect(state.writes.at(-1)).toEqual({ key: 'networth_exclusions_alice', value: [houses, sword] });
    });

    test('a missing record is safely initialized by the first edit', async () => {
        const adding = exclusions.addExclusion(sword.type, sword.value);
        state.reads[0].resolve(undefined);
        await adding;
        expect(state.writes).toEqual([{ key: 'networth_exclusions_alice', value: [sword] }]);
    });

    test('legacy JSON-string records still load and keep all existing exclusions', async () => {
        const adding = exclusions.addExclusion(sword.type, sword.value);
        state.reads[0].resolve(JSON.stringify([houses]));
        await adding;
        expect(exclusions.getExclusions()).toEqual([houses, sword]);
    });

    test('a corrupt stored record is not replaced with a partial list', async () => {
        const adding = exclusions.addExclusion(sword.type, sword.value);
        state.reads[0].resolve('{bad json');
        await adding;
        expect(state.writes).toEqual([]);
    });
});

describe('warm edits survive an unflushed coalesced switch', () => {
    test.each(['add', 'remove', 'clear'])(
        'retains a warm %s when a failed flush leaves its save pending',
        async (kind) => {
            const disk = kind === 'add' ? [houses] : [houses, sword];
            const loading = exclusions.initExclusions();
            state.reads[0].resolve(structuredClone(disk));
            await loading;
            // Storage reports a failed flush but retains the queued value for retry.
            state.writeResult = false;
            if (kind === 'add') await exclusions.addExclusion(sword.type, sword.value);
            else if (kind === 'remove') await exclusions.removeExclusion(sword.type, sword.value);
            else await exclusions.clearExclusions();
            state.handlers.get('character_switching')({ oldId: 'alice', newId: 'bob' });
            state.characterId = 'bob';
            state.handlers.get('character_switching')({ oldId: 'bob', newId: 'alice' });
            state.characterId = 'alice';
            const returning = exclusions.initExclusions();
            // If the warm cache was discarded, disk still has the pre-edit value.
            state.reads[1]?.resolve(structuredClone(disk));
            await returning;
            await exclusions.addExclusion(cheese.type, cheese.value);
            const kept = kind === 'add' ? [houses, sword] : kind === 'remove' ? [houses] : [];
            expect(state.writes.at(-1)).toEqual({ key: 'networth_exclusions_alice', value: [...kept, cheese] });
            expect(exclusions.getExclusions()).toEqual([...kept, cheese]);
        }
    );
});
