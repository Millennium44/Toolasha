/**
 * zone-tier-memory: the tier the character last RAN each combat zone at, recorded from the server's
 * action data and used by task cards (estimate + Go) once the zone has left the queue.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const storageMock = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    return {
        stores,
        storeFor,
        unavailable: false,
        failWrites: false,
        /** When set, tryGet waits for it: a slow read */
        gate: null,
        reset() {
            stores.clear();
            storageMock.unavailable = false;
            storageMock.failWrites = false;
            storageMock.gate = null;
        },
        get: vi.fn(async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? map.get(key) : fallback;
        }),
        tryGet: vi.fn(async (key, store = 'settings') => {
            if (storageMock.gate) await storageMock.gate;
            if (storageMock.unavailable) return null;
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null
                ? { found: true, value: structuredClone(map.get(key)) }
                : { found: false, value: null };
        }),
        set: vi.fn(async (key, value, store = 'settings', _immediate = false, options = {}) => {
            if (storageMock.unavailable || storageMock.failWrites) return false;
            const map = storeFor(store);
            const folded = options?.fold ? options.fold(map.get(key), value) : undefined;
            map.set(key, structuredClone(folded === undefined ? value : folded));
            return true;
        }),
        delete: vi.fn(async () => true),
        getAllKeys: vi.fn(async (store = 'settings') => Array.from(storeFor(store).keys())),
        flushAll: vi.fn(async () => {}),
        onBeforeTeardown: vi.fn(() => () => {}),
    };
});

const dm = vi.hoisted(() => {
    const listeners = new Map();
    const state = {
        characterId: 'char-a',
        actions: [],
        listeners,
        on(event, fn) {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event).add(fn);
        },
        off(event, fn) {
            listeners.get(event)?.delete(fn);
        },
        emitted: [],
        emit(event, data) {
            state.emitted.push([event, data]);
            for (const fn of Array.from(listeners.get(event) || [])) fn(data);
        },
        getCurrentCharacterId: () => state.characterId,
        getCurrentCharacterGameMode: () => 'standard',
        getCurrentCharacterName: () => 'Main',
        getCurrentActions: () => state.actions,
    };
    return state;
});

vi.mock('../core/storage.js', () => ({ default: storageMock }));
vi.mock('../core/data-manager.js', () => ({ default: dm }));
vi.mock('./adoption-consent.js', () => ({
    getAdoptionTargetId: async () => dm.characterId,
    requestAdoptionConsent: () => Promise.resolve(null),
}));

const mem = await import('./zone-tier-memory.js');

const GOBO = '/actions/combat/gobo_planet';
const FLY = '/actions/combat/fly';

/** A combat action as the server sends it: full hrids, a tier, an ordinal. */
function combat(actionHrid, difficultyTier, ordinal = 0, extra = {}) {
    return { id: ordinal + 1, actionHrid, difficultyTier, ordinal, isDone: false, partyID: 0, ...extra };
}

/** Let loads, saves and emitted handlers settle. */
async function settle() {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function stored(characterId = 'char-a') {
    return storageMock.storeFor('settings').get(`combatZoneTiers_${characterId}`);
}

/** Pretend the server sent a new queue. */
function sendActions(actions) {
    dm.actions = actions;
    dm.emit('actions_updated', {});
}

async function switchTo(characterId) {
    dm.emit('character_switching', {});
    dm.characterId = characterId;
    dm.emit('character_initialized', {});
    await settle();
}

beforeEach(() => {
    storageMock.reset();
    dm.characterId = 'char-a';
    dm.actions = [];
    dm.emitted.length = 0;
    dm.listeners.clear();
    mem._resetZoneTierMemoryForTests();
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
});

afterEach(() => {
    mem.stopZoneTierMemory();
    vi.restoreAllMocks();
});

describe('recording from the server action data', () => {
    test('a running zone at a nonzero tier is remembered and survives the zone leaving the queue', async () => {
        dm.actions = [combat(GOBO, 3)];
        mem.startZoneTierMemory();
        await settle();

        expect(mem.rememberedTier(GOBO)).toBe(3);
        expect(stored()[GOBO]).toEqual({ tier: 3, at: 1000 });

        // The zone leaves the queue: the queue no longer says, the memory does
        sendActions([]);
        expect(mem.resolveZoneTier(GOBO)).toEqual({ tier: 3, known: true, source: 'remembered', pending: false });
    });

    test('actions_updated while nothing recorded the zone yet records it, with no panel involved', async () => {
        mem.startZoneTierMemory();
        await settle();
        expect(mem.rememberedTier(GOBO)).toBeNull();

        sendActions([combat(GOBO, 2)]);
        await settle();

        expect(mem.rememberedTier(GOBO)).toBe(2);
        expect(stored()[GOBO].tier).toBe(2);
    });

    test('running at T0 overwrites a remembered T3: zero is a tier, not missing', async () => {
        dm.actions = [combat(GOBO, 3)];
        mem.startZoneTierMemory();
        await settle();
        expect(mem.rememberedTier(GOBO)).toBe(3);

        Date.now.mockReturnValue(2_000);
        sendActions([combat(GOBO, 0)]);
        await settle();

        expect(mem.rememberedTier(GOBO)).toBe(0);
        expect(stored()[GOBO]).toEqual({ tier: 0, at: 2000 });
        sendActions([]);
        expect(mem.resolveZoneTier(GOBO)).toMatchObject({ tier: 0, known: true, source: 'remembered' });
    });

    test('an action without a tier records nothing', async () => {
        dm.actions = [{ id: 1, actionHrid: GOBO, ordinal: 0, isDone: false }];
        mem.startZoneTierMemory();
        await settle();

        expect(mem.rememberedTier(GOBO)).toBeNull();
        expect(stored()).toBeUndefined();
    });

    test('only the RUNNING combat action counts: a zone queued behind it is not a zone the player ran', async () => {
        dm.actions = [combat(FLY, 1, 0), combat(GOBO, 3, 5)];
        mem.startZoneTierMemory();
        await settle();

        expect(mem.rememberedTier(FLY)).toBe(1);
        expect(mem.rememberedTier(GOBO)).toBeNull();
    });

    test('a running non-combat action records nothing, even with a combat zone queued behind it', async () => {
        dm.actions = [{ id: 9, actionHrid: '/actions/cooking/tea', ordinal: 0, isDone: false }, combat(GOBO, 3, 4)];
        mem.startZoneTierMemory();
        await settle();
        expect(mem.rememberedTier(GOBO)).toBeNull();
    });

    test('an unchanged tier is not written again', async () => {
        dm.actions = [combat(GOBO, 3)];
        mem.startZoneTierMemory();
        await settle();
        const writes = storageMock.set.mock.calls.length;

        for (let i = 0; i < 5; i += 1) sendActions([combat(GOBO, 3)]);
        await settle();
        expect(storageMock.set.mock.calls.length).toBe(writes);
    });
});

describe('the order a tier is chosen in', () => {
    test('the queue beats the remembered tier', async () => {
        dm.actions = [combat(GOBO, 3)];
        mem.startZoneTierMemory();
        await settle();

        // Queued again at T5: the queue is the freshest word
        expect(mem.resolveZoneTier(GOBO, [combat(FLY, 0, 0), combat(GOBO, 5, 3)])).toEqual({
            tier: 5,
            known: true,
            source: 'queue',
            pending: false,
        });
    });

    test('an unknown zone is T0, not known, and not pending once the record has loaded', async () => {
        mem.startZoneTierMemory();
        await settle();
        expect(mem.resolveZoneTier(GOBO, [])).toEqual({ tier: 0, known: false, source: 'default', pending: false });
    });

    test('words for each source', () => {
        expect(mem.describeZoneTier(3, { source: 'remembered', known: true })).toBe('T3 (the tier you last ran here)');
        expect(mem.describeZoneTier(3, { source: 'queue', known: true })).toBe('T3');
        expect(mem.describeZoneTier(0, { source: 'default', known: false, pending: false })).toBe(
            'T0, no recorded tier for this zone'
        );
        expect(mem.describeZoneTier(0, { source: 'default', known: false, pending: true })).toContain('yet');
    });
});

describe('per character', () => {
    test('two characters keep separate tiers', async () => {
        dm.actions = [combat(GOBO, 3)];
        mem.startZoneTierMemory();
        await settle();
        expect(mem.rememberedTier(GOBO)).toBe(3);

        dm.actions = [combat(GOBO, 1)];
        await switchTo('char-b');
        expect(mem.rememberedTier(GOBO)).toBe(1);
        expect(stored('char-b')[GOBO].tier).toBe(1);
        expect(stored('char-a')[GOBO].tier).toBe(3);

        dm.actions = [];
        await switchTo('char-a');
        expect(mem.rememberedTier(GOBO)).toBe(3);
    });

    test('a switch while the first character is still loading: the first record is never read as the second', async () => {
        let release;
        storageMock.gate = new Promise((r) => {
            release = r;
        });
        storageMock.storeFor('settings').set('combatZoneTiers_char-a', { [GOBO]: { tier: 4, at: 5 } });
        storageMock.storeFor('settings').set('combatZoneTiers_char-b', { [FLY]: { tier: 2, at: 5 } });
        mem.startZoneTierMemory(); // char-a, read hangs
        await settle();
        expect(mem.rememberedTier(GOBO)).toBeNull();

        dm.emit('character_switching', {});
        dm.characterId = 'char-b';
        dm.emit('character_initialized', {});
        storageMock.gate = null;
        release();
        await settle();

        expect(mem.rememberedTier(GOBO)).toBeNull(); // char-a's tier did not leak
        expect(mem.rememberedTier(FLY)).toBe(2);
        expect(stored('char-a')).toEqual({ [GOBO]: { tier: 4, at: 5 } }); // untouched
    });
});

describe('before the record has loaded', () => {
    test('the T0 fallback is marked pending, then a change event says the record arrived', async () => {
        let release;
        storageMock.gate = new Promise((r) => {
            release = r;
        });
        storageMock.storeFor('settings').set('combatZoneTiers_char-a', { [GOBO]: { tier: 3, at: 5 } });
        mem.startZoneTierMemory();
        await settle();

        expect(mem.isReady()).toBe(false);
        expect(mem.resolveZoneTier(GOBO, [])).toEqual({ tier: 0, known: false, source: 'default', pending: true });

        dm.emitted.length = 0;
        storageMock.gate = null;
        release();
        await settle();

        expect(dm.emitted.some(([e]) => e === mem.ZONE_TIER_MEMORY_EVENT)).toBe(true);
        expect(mem.resolveZoneTier(GOBO, [])).toMatchObject({ tier: 3, source: 'remembered', pending: false });
    });

    test('what the server showed running while the record loaded is kept, not lost to the load', async () => {
        let release;
        storageMock.gate = new Promise((r) => {
            release = r;
        });
        storageMock.storeFor('settings').set('combatZoneTiers_char-a', { [FLY]: { tier: 2, at: 5 } });
        dm.actions = [combat(GOBO, 3)];
        mem.startZoneTierMemory();
        await settle();

        storageMock.gate = null;
        release();
        await settle();

        expect(mem.rememberedTier(GOBO)).toBe(3);
        expect(mem.rememberedTier(FLY)).toBe(2);
    });

    test('an unreadable store is not an empty one: nothing is claimed and nothing is written', async () => {
        storageMock.unavailable = true;
        dm.actions = [combat(GOBO, 3)];
        mem.startZoneTierMemory();
        await settle();

        expect(mem.isReady()).toBe(false);
        expect(mem.resolveZoneTier(GOBO, [])).toMatchObject({ known: false, pending: true });
        expect(storageMock.set).not.toHaveBeenCalled();
    });
});

describe('a failed write', () => {
    test('keeps the stored value, logs, and keeps the tier for the session', async () => {
        dm.actions = [combat(GOBO, 3)];
        mem.startZoneTierMemory();
        await settle();
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});

        storageMock.failWrites = true;
        Date.now.mockReturnValue(2_000);
        sendActions([combat(GOBO, 1)]);
        await settle();

        expect(stored()[GOBO].tier).toBe(3); // storage still holds the old value
        expect(mem.rememberedTier(GOBO)).toBe(1); // this session uses the new one
        expect(error).toHaveBeenCalled();
    });
});

describe('stopping', () => {
    test('stop removes every listener it added and records nothing afterwards', async () => {
        mem.startZoneTierMemory();
        await settle();
        mem.stopZoneTierMemory();
        for (const set of dm.listeners.values()) {
            expect(set.size).toBe(0);
        }
        sendActions([combat(GOBO, 3)]);
        await settle();
        expect(stored()).toBeUndefined();
        expect(mem.rememberedTier(GOBO)).toBeNull();
    });
});

describe('mergeZoneTiers: the later change wins per zone', () => {
    test('later at wins, a tie goes to the second side, zones from both sides are kept', () => {
        const merged = mem.mergeZoneTiers(
            { [GOBO]: { tier: 3, at: 10 }, [FLY]: { tier: 1, at: 5 } },
            { [GOBO]: { tier: 0, at: 20 }, '/actions/combat/x': { tier: 2, at: 1 } }
        );
        expect(merged[GOBO]).toEqual({ tier: 0, at: 20 });
        expect(merged[FLY]).toEqual({ tier: 1, at: 5 });
        expect(merged['/actions/combat/x']).toEqual({ tier: 2, at: 1 });

        expect(mem.mergeZoneTiers({ [GOBO]: { tier: 3, at: 10 } }, { [GOBO]: { tier: 1, at: 10 } })[GOBO].tier).toBe(1);
        expect(mem.mergeZoneTiers({ [GOBO]: { tier: 3, at: 30 } }, { [GOBO]: { tier: 1, at: 10 } })[GOBO].tier).toBe(3);
    });

    test('malformed entries and non-records are dropped, never read as tier 0', () => {
        const merged = mem.mergeZoneTiers(null, {
            [GOBO]: { tier: 'x', at: 1 },
            [FLY]: { at: 1 },
            a: { tier: -1, at: 1 },
            b: { tier: 1.5, at: 1 },
        });
        expect(merged).toEqual({});
        expect(mem.mergeZoneTiers([], 'junk')).toEqual({});
    });
});
