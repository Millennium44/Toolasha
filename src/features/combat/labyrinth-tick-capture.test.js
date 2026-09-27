/**
 * The tick capture arms a socket listener, keeps the ordered feed trimmed to
 * what a fight reads, and lets go of the listener when it stops. These pin the
 * arming, the trimming, and that a stopped capture hears nothing more.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

// Hoisted: the recommendation-module graph the fingerprint-spec import pulls in
// registers websocket listeners while the imports are still being evaluated
const bus = vi.hoisted(() => new Map());
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, fn) => {
            if (!bus.has(type)) bus.set(type, new Set());
            bus.get(type).add(fn);
        },
        off: (type, fn) => bus.get(type)?.delete(fn),
        // The fingerprint-spec import pulls the recommendation module's graph,
        // whose connection-state listens for socket lifecycle at import time
        onSocketEvent: () => {},
    },
}));

// A minimal in-memory stand-in, scoped by (store, key) like the real thing —
// good enough to exercise the autosave's write/read/delete without touching
// IndexedDB (unavailable in this test's node environment anyway).
const storageMock = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    return {
        stores,
        storeFor,
        quotaExceeded: false,
        reset() {
            stores.clear();
            storageMock.quotaExceeded = false;
        },
        isQuotaExceeded: () => storageMock.quotaExceeded,
        get: async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) ? structuredClone(map.get(key)) : fallback;
        },
        set: async (key, value, store = 'settings') => {
            if (storageMock.quotaExceeded) return false;
            storeFor(store).set(key, structuredClone(value));
            return true;
        },
        delete: async (key, store = 'settings') => {
            storeFor(store).delete(key);
            return true;
        },
    };
});
vi.mock('../../core/storage.js', () => ({ default: storageMock }));

import capture from './labyrinth-tick-capture.js';
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';

function emit(type, payload) {
    for (const fn of bus.get(type) || []) fn(payload);
}

const battle = { pMap: { 0: { cHP: 100 } }, mMap: { 0: { cHP: 200 } }, battleId: 'b1', chat: 'ignored' };

/**
 * The ref as a freshly loaded script has it.
 *
 * `lastCaptureRef` describes the file on disk and so is deliberately sticky —
 * it survives clearCapture, later starts, and every reset a test hook could do.
 * Nothing can put it back to null, so "null before anything has been saved" is
 * read here, at import, rather than from inside a test that would then only
 * hold while it ran before every test that downloads.
 */
const refBeforeAnySave = capture.lastCaptureRef();

beforeEach(() => {
    capture.stopCapture();
    capture.clearCapture();
    storageMock.reset();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('labyrinth tick capture', () => {
    test('room swaps retain ordered equipment evidence and detached fight-opening client builds', () => {
        const item = { itemHrid: '/items/sword', enhancementLevel: 3, id: 123 };
        const gear = vi.spyOn(dataManager, 'getEquipment').mockReturnValue(new Map([['main_hand', item]]));
        const ability = { abilityHrid: '/abilities/smash', level: 4, slotNumber: 1, characterId: 456 };
        const kit = vi.spyOn(dataManager, 'getEquippedAbilities').mockReturnValue([ability]);
        try {
            capture.startCapture(null, { stopOnLeave: false });
            item.itemHrid = '/items/staff';
            emit('items_updated', {
                endCharacterItems: [
                    { ...item, itemLocationHrid: '/item_locations/main_hand', count: 1 },
                    { id: 789, itemHrid: '/items/coin', itemLocationHrid: '/item_locations/inventory', count: 999 },
                ],
            });
            ability.abilityHrid = '/abilities/fireball';
            emit('abilities_updated', { characterId: 456 });
            emit('new_battle', { monsters: [{ hrid: '/monsters/fly' }] });
            item.itemHrid = '/items/sword';
            ability.level = 99;
            const file = capture.captureFile();
            expect(file.initialClientBuild.equipment[0].itemHrid).toBe('/items/sword');
            expect(file.ticks.map((tick) => tick.type)).toEqual(['items_updated', 'abilities_updated', 'new_battle']);
            expect(file.ticks[2].clientBuild.equipment[0].itemHrid).toBe('/items/staff');
            expect(file.ticks[2].clientBuild.abilities[0]).toEqual({
                abilityHrid: '/abilities/fireball',
                level: 4,
                slotNumber: 1,
            });
            expect(file.ticks[0].payload.equipment).toHaveLength(1);
            expect(JSON.stringify(file)).not.toContain('characterId');
            expect(JSON.stringify(file)).not.toContain('"id":');
            capture.stopCapture();
            emit('items_updated', { endCharacterItems: [{ ...item, count: 1 }] });
            emit('abilities_updated', {});
            expect(capture.captureFile().ticks).toHaveLength(3);
        } finally {
            gear.mockRestore();
            kit.mockRestore();
        }
    });

    test('a disarmed capture hears nothing', () => {
        emit('battle_updated', battle);
        expect(capture.captureStatus().ticks).toBe(0);
    });

    test('an armed capture keeps the feed, trimmed to what a fight reads', () => {
        capture.startCapture({ monsterHrid: '/monsters/pyre_hunter', roomLevel: 300 });
        emit('battle_updated', battle);
        const file = capture.captureFile();
        expect(file.ticks).toHaveLength(1);
        expect(file.ticks[0].type).toBe('battle_updated');
        expect(file.ticks[0].payload).toEqual({ pMap: battle.pMap, mMap: battle.mMap, battleId: 'b1' });
        // The chat and other noise is dropped
        expect(file.ticks[0].payload.chat).toBeUndefined();
        expect(file.context.monsterHrid).toBe('/monsters/pyre_hunter');
        expect(file.format).toBe('toolasha-labyrinth-tick-capture');
    });

    test('new_battle is kept whole, since it names the units and abilities', () => {
        capture.startCapture();
        emit('new_battle', { players: {}, monsters: {}, extra: 1 });
        const file = capture.captureFile();
        expect(file.ticks[0].type).toBe('new_battle');
        expect(file.ticks[0].payload.extra).toBe(1);
    });

    test('the capture labels itself from the fight when given no monster', () => {
        capture.startCapture();
        emit('new_battle', { monsters: [{ hrid: '/monsters/dryad', name: 'Dryad' }], players: [] });
        const file = capture.captureFile();
        expect(file.context.monsterHrid).toBe('/monsters/dryad');
        expect(file.context.monsterName).toBe('Dryad');
    });

    test('a caller-supplied room level survives the monster backfill', () => {
        capture.startCapture({ roomLevel: 322 });
        emit('new_battle', { monsters: [{ hrid: '/monsters/dryad', name: 'Dryad' }] });
        const file = capture.captureFile();
        expect(file.context.roomLevel).toBe(322);
        expect(file.context.monsterHrid).toBe('/monsters/dryad');
    });

    test('a caller-supplied build fingerprint is exported, and survives the monster backfill', () => {
        // The uptime harness binds captures to the build they were fought in;
        // the file must carry the fingerprint even when the monster label is
        // filled in later from the fight's own feed.
        capture.startCapture({ fingerprint: 'fp-abc' });
        emit('new_battle', { monsters: [{ hrid: '/monsters/dryad', name: 'Dryad' }] });
        const file = capture.captureFile();
        expect(file.context.fingerprint).toBe('fp-abc');
        expect(file.context.monsterHrid).toBe('/monsters/dryad');
    });

    test('a stopped capture hears nothing more', () => {
        capture.startCapture();
        emit('battle_updated', battle);
        capture.stopCapture();
        emit('battle_updated', battle);
        expect(capture.captureStatus().ticks).toBe(1);
        expect(capture.isCapturing()).toBe(false);
    });

    test('starting again drops the previous capture, once it is no longer held', () => {
        capture.startCapture();
        emit('battle_updated', battle);
        // Held ticks: a bare startCapture() must refuse rather than silently
        // drop them (see the guard describe block below)
        expect(capture.startCapture()).toEqual({ started: false, heldTicks: 1 });
        expect(capture.captureStatus().ticks).toBe(1);

        capture.clearCapture();
        capture.startCapture();
        expect(capture.captureStatus().ticks).toBe(0);
    });
});

describe('the file says which capture it is, and how the capture ended', () => {
    test('lastCaptureRef is null before any capture has been saved', () => {
        expect(refBeforeAnySave).toBeNull();
    });

    test('captureId is stable across captureFile calls, and new on the next start', () => {
        capture.startCapture();
        const first = capture.captureFile().captureId;
        expect(first).toEqual(expect.any(String));
        expect(first.length).toBeGreaterThan(0);
        expect(capture.captureFile().captureId).toBe(first);
        expect(capture.captureStatus().captureId).toBe(first);

        capture.startCapture();
        expect(capture.captureFile().captureId).not.toBe(first);
    });

    test('a manual stop is recorded as manual, and a redundant stop does not relabel it', () => {
        vi.useFakeTimers();
        capture.startCapture();
        expect(capture.captureFile().stoppedReason).toBeNull();
        capture.stopCapture();
        expect(capture.captureFile().stoppedReason).toBe('manual');

        capture.startCapture();
        vi.advanceTimersByTime(60 * 60 * 1000);
        expect(capture.isCapturing()).toBe(false);
        expect(capture.captureFile().stoppedReason).toBe('auto_max_duration');
        // The button's stop on an already-finished capture must not rewrite why
        capture.stopCapture();
        expect(capture.captureFile().stoppedReason).toBe('auto_max_duration');
        vi.useRealTimers();
    });

    test('leaving the monster is its own stop reason', () => {
        capture.startCapture({ monsterHrid: '/monsters/cyclops' });
        emit('new_battle', { monsters: [{ hrid: '/monsters/gobo_stabber' }], players: [] });
        expect(capture.captureFile().stoppedReason).toBe('left_monster');
    });

    test('ring-buffer overflow is counted, not silent', () => {
        capture.startCapture();
        // 8000 retained plus 5 pushed off the front; every payload distinct so
        // the duplicate filter keeps out of the way
        for (let i = 0; i < 8005; i++) {
            emit('battle_updated', { ...battle, pMap: { 0: { cHP: i } } });
        }
        const file = capture.captureFile();
        expect(file.ticks).toHaveLength(8000);
        expect(file.ticksDropped).toBe(5);
        expect(capture.captureStatus().ticksDropped).toBe(5);
        // The oldest fell off: the first retained tick is the sixth pushed
        expect(file.ticks[0].payload.pMap[0].cHP).toBe(5);
    });

    test('a clean capture reports zero drops', () => {
        capture.startCapture();
        emit('battle_updated', battle);
        expect(capture.captureFile().ticksDropped).toBe(0);
    });

    test('gap stats come from the retained tick times', () => {
        vi.useFakeTimers();
        capture.startCapture();
        emit('battle_updated', { ...battle, pMap: { 0: { cHP: 100 } } });
        vi.advanceTimersByTime(300);
        emit('battle_updated', { ...battle, pMap: { 0: { cHP: 90 } } });
        vi.advanceTimersByTime(6000); // the tab stalled
        emit('battle_updated', { ...battle, pMap: { 0: { cHP: 80 } } });
        vi.advanceTimersByTime(400);
        emit('battle_updated', { ...battle, pMap: { 0: { cHP: 70 } } });

        const file = capture.captureFile();
        expect(file.maxGapMs).toBe(6000);
        expect(file.gapsOver5s).toBe(1);
        vi.useRealTimers();
    });

    test('a capture too short to have gaps reports none', () => {
        capture.startCapture();
        emit('battle_updated', battle);
        const file = capture.captureFile();
        expect(file.maxGapMs).toBeNull();
        expect(file.gapsOver5s).toBe(0);
    });

    test('loadout markers cannot conceal a gap in the battle feed', () => {
        vi.useFakeTimers();
        try {
            capture.startCapture();
            emit('battle_updated', battle);
            vi.advanceTimersByTime(3000);
            emit('abilities_updated', {});
            vi.advanceTimersByTime(3000);
            emit('battle_updated', { ...battle, pMap: { 0: { cHP: 90 } } });
            expect(capture.captureFile()).toMatchObject({ maxGapMs: 6000, gapsOver5s: 1 });
        } finally {
            capture.stopCapture();
            vi.useRealTimers();
        }
    });

    test('the file names the fingerprint spec beside its context', () => {
        capture.startCapture({ fingerprint: 'fp-abc' });
        const file = capture.captureFile();
        expect(file.fingerprintSpec).toEqual(expect.any(String));
        expect(file.fingerprintSpec).toContain('djb2');
    });

    test('the file carries savedAt, and lastCaptureRef survives the clear after a save', () => {
        const written = [];
        vi.stubGlobal(
            'Blob',
            class {
                constructor(parts) {
                    written.push(parts.join(''));
                }
            }
        );
        vi.stubGlobal('URL', { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} });
        vi.stubGlobal('document', { createElement: () => ({ click: () => {} }) });

        capture.startCapture({ monsterHrid: '/monsters/cyclops', roomLevel: 206 });
        emit('battle_updated', battle);
        const id = capture.captureFile().captureId;
        expect(capture.captureFile().savedAt).toBeNull();

        capture.stopCapture();
        expect(capture.downloadCapture()).toBe(true);
        expect(capture.captureFile().savedAt).not.toBeNull();

        const ref = capture.lastCaptureRef();
        expect(ref).toEqual({
            captureId: id,
            savedAt: expect.any(Number),
            monsterHrid: '/monsters/cyclops',
            roomLevel: 206,
        });
        // The file on disk says when it was saved, and agrees with the ref
        expect(JSON.parse(written.at(-1)).savedAt).toBe(ref.savedAt);

        // The ref names the file on disk, so throwing away the held ticks —
        // and even starting a new capture — must not lose it
        capture.clearCapture();
        expect(capture.lastCaptureRef()).toEqual(ref);
        capture.startCapture();
        expect(capture.lastCaptureRef()).toEqual(ref);
        capture.stopCapture();

        vi.unstubAllGlobals();
    });
});

describe('adjacent duplicate ticks are dropped, and counted', () => {
    test('a fight boundary preserves an identical first update without a battle id', () => {
        capture.startCapture();
        const fight = { monsters: [{ hrid: '/monsters/cyclops' }], players: [] };
        const update = { pMap: battle.pMap, mMap: battle.mMap };
        emit('new_battle', fight);
        emit('battle_updated', update);
        emit('new_battle', fight);
        emit('battle_updated', update);
        expect(capture.captureFile().ticks).toHaveLength(4);
        expect(capture.captureStatus().duplicatesDiscarded).toBe(0);
        emit('battle_updated', update);
        expect(capture.captureFile().ticks).toHaveLength(4);
        expect(capture.captureStatus().duplicatesDiscarded).toBe(1);
    });

    test('clearing an active capture removes listeners and its auto-stop timer', () => {
        vi.useFakeTimers();
        try {
            const battleListeners = bus.get('battle_updated')?.size || 0;
            const newBattleListeners = bus.get('new_battle')?.size || 0;
            capture.startCapture();
            emit('battle_updated', battle);
            capture.clearCapture();
            expect(capture.isCapturing()).toBe(false);
            expect(bus.get('battle_updated')?.size).toBe(battleListeners);
            expect(bus.get('new_battle')?.size).toBe(newBattleListeners);
            expect(vi.getTimerCount()).toBe(0);
            emit('battle_updated', battle);
            expect(capture.captureFile().ticks).toEqual([]);
            expect(capture.captureFile().recordedAt).toBeNull();
            capture.startCapture();
            emit('battle_updated', battle);
            expect(capture.captureFile().ticks[0].at).toBe(0);
        } finally {
            capture.stopCapture();
            vi.useRealTimers();
        }
    });

    test('an exact repeat of the previous battle tick is discarded, not kept', () => {
        capture.startCapture();
        emit('battle_updated', battle);
        emit('battle_updated', battle); // the game repeating itself
        emit('battle_updated', { ...battle, pMap: { 0: { cHP: 90 } } });

        const file = capture.captureFile();
        expect(file.ticks.filter((t) => t.type === 'battle_updated')).toHaveLength(2);
        expect(file.duplicatesDiscarded).toBe(1);
        expect(capture.captureStatus().duplicatesDiscarded).toBe(1);
    });

    test('the same reading returning later is kept — only adjacency is noise', () => {
        capture.startCapture();
        emit('battle_updated', battle);
        emit('battle_updated', { ...battle, pMap: { 0: { cHP: 90 } } });
        emit('battle_updated', battle); // healed back to the same numbers: real

        expect(capture.captureFile().ticks).toHaveLength(3);
        expect(capture.captureFile().duplicatesDiscarded).toBe(0);
    });

    test('identical new_battle messages are never deduplicated — two of them are two fights', () => {
        capture.startCapture();
        const fight = { monsters: [{ hrid: '/monsters/cyclops' }], players: [] };
        emit('new_battle', fight);
        emit('new_battle', fight);

        expect(capture.captureFile().ticks.filter((t) => t.type === 'new_battle')).toHaveLength(2);
        expect(capture.captureFile().duplicatesDiscarded).toBe(0);
    });

    test('saving marks the capture saved; only Discard unmarks it — a Save click alone does not authorize a fresh start', () => {
        vi.stubGlobal('Blob', class {});
        vi.stubGlobal('URL', { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} });
        vi.stubGlobal('document', { createElement: () => ({ click: () => {} }) });

        capture.startCapture();
        emit('battle_updated', battle);
        expect(capture.captureStatus().savedAt).toBeNull();

        capture.stopCapture();
        expect(capture.downloadCapture()).toBe(true);
        // The ticks stay held (the uptime harness reuses them); only the
        // "still needs saving" flag flips
        expect(capture.captureStatus().ticks).toBe(1);
        expect(capture.captureStatus().savedAt).not.toBeNull();

        // A bare startCapture is refused: saved is not discarded
        expect(capture.startCapture()).toEqual({ started: false, heldTicks: 1 });
        expect(capture.captureStatus().savedAt).not.toBeNull();

        capture.stopCapture();
        capture.clearCapture();
        expect(capture.captureStatus().savedAt).toBeNull();
        // Discard having run, a fresh start is allowed again
        expect(capture.startCapture()).toEqual({ started: true });
        expect(capture.captureStatus().savedAt).toBeNull();

        vi.unstubAllGlobals();
    });

    test('a fresh capture forgets the previous one’s duplicate count and last tick', () => {
        capture.startCapture();
        emit('battle_updated', battle);
        emit('battle_updated', battle);
        // The held tick is unsaved; force past the guard the way a caller
        // that has gotten explicit go-ahead would (see the guard tests below)
        capture.startCapture(null, { force: true });
        // Same payload as before the restart, but the first of this capture
        emit('battle_updated', battle);

        expect(capture.captureFile().ticks).toHaveLength(1);
        expect(capture.captureFile().duplicatesDiscarded).toBe(0);
    });
});

describe('the capture ends when the fight leaves its monster', () => {
    test('a fresh fight against a different monster stops it, keeping what was captured', () => {
        capture.startCapture({ monsterHrid: '/monsters/cyclops', roomLevel: 206 });
        emit('new_battle', { monsters: [{ hrid: '/monsters/cyclops', name: 'Cyclops' }], players: [] });
        emit('battle_updated', battle);
        const kept = capture.captureFile().ticks.length;
        expect(capture.isCapturing()).toBe(true);

        // Room cleared → the game moves on to the next fight (a different monster
        // or your main-game action). The capture ends without recording it.
        emit('new_battle', { monsters: [{ hrid: '/monsters/gobo_stabber' }], players: [] });
        expect(capture.isCapturing()).toBe(false);
        emit('battle_updated', battle); // ignored — stopped
        expect(capture.captureFile().ticks.length).toBe(kept);
    });

    test('a retry against the same monster keeps recording', () => {
        capture.startCapture({ monsterHrid: '/monsters/cyclops', roomLevel: 206 });
        emit('new_battle', { monsters: [{ hrid: '/monsters/cyclops' }], players: [] });
        emit('battle_updated', battle);
        emit('new_battle', { monsters: [{ hrid: '/monsters/cyclops' }], players: [] }); // died, retry
        emit('battle_updated', { ...battle, pMap: { 0: { cHP: 90 } } });
        expect(capture.isCapturing()).toBe(true);
        expect(capture.captureFile().ticks.length).toBe(4);
    });

    test('stopOnLeave:false records across monsters (a general capture)', () => {
        capture.startCapture({ monsterHrid: '/monsters/cyclops' }, { stopOnLeave: false });
        emit('new_battle', { monsters: [{ hrid: '/monsters/cyclops' }], players: [] });
        emit('new_battle', { monsters: [{ hrid: '/monsters/other' }], players: [] });
        expect(capture.isCapturing()).toBe(true);
    });
});

describe('heldTickCount and the start/reset guard', () => {
    test('zero with nothing held', () => {
        expect(capture.heldTickCount()).toBe(0);
    });

    test('non-zero once ticks are held, whether running or stopped', () => {
        capture.startCapture();
        emit('battle_updated', battle);
        expect(capture.heldTickCount()).toBe(1);
        capture.stopCapture();
        expect(capture.heldTickCount()).toBe(1);
    });

    test('a Save click does NOT bring it back to zero — a click is not proof the file reached disk', () => {
        vi.stubGlobal('Blob', class {});
        vi.stubGlobal('URL', { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} });
        vi.stubGlobal('document', { createElement: () => ({ click: () => {} }) });
        capture.startCapture();
        emit('battle_updated', battle);
        capture.stopCapture();
        capture.downloadCapture();
        expect(capture.captureStatus().savedAt).not.toBeNull();
        expect(capture.heldTickCount()).toBe(1);
        vi.unstubAllGlobals();
    });

    test('only Discard brings it back to zero', () => {
        capture.startCapture();
        emit('battle_updated', battle);
        capture.clearCapture();
        expect(capture.heldTickCount()).toBe(0);
    });

    test('a bare startCapture refuses while ticks are held, and changes nothing', () => {
        capture.startCapture({ monsterHrid: '/monsters/cyclops' });
        emit('battle_updated', battle);
        const before = capture.captureFile();
        const result = capture.startCapture({ monsterHrid: '/monsters/dryad' });
        expect(result).toEqual({ started: false, heldTicks: 1 });
        expect(capture.captureFile()).toEqual(before);
    });

    test('a bare startCapture refuses even once the held capture is saved — this is the exact loss the guard exists for', () => {
        vi.stubGlobal('Blob', class {});
        vi.stubGlobal('URL', { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} });
        vi.stubGlobal('document', { createElement: () => ({ click: () => {} }) });
        capture.startCapture({ monsterHrid: '/monsters/cyclops' });
        emit('battle_updated', battle);
        capture.stopCapture();
        capture.downloadCapture();

        const result = capture.startCapture({ monsterHrid: '/monsters/dryad' });

        expect(result).toEqual({ started: false, heldTicks: 1 });
        expect(capture.captureFile().ticks).toHaveLength(1);
        expect(capture.captureFile().context.monsterHrid).toBe('/monsters/cyclops');
        vi.unstubAllGlobals();
    });

    test('force starts anyway, discarding the held ticks', () => {
        capture.startCapture({ monsterHrid: '/monsters/cyclops' });
        emit('battle_updated', battle);
        const result = capture.startCapture({ monsterHrid: '/monsters/dryad' }, { force: true });
        expect(result).toEqual({ started: true });
        expect(capture.captureFile().ticks).toHaveLength(0);
        expect(capture.captureFile().context.monsterHrid).toBe('/monsters/dryad');
    });

    test('starting is allowed once the held capture is discarded', () => {
        capture.startCapture({ monsterHrid: '/monsters/cyclops' });
        emit('battle_updated', battle);
        capture.clearCapture();
        expect(capture.startCapture({ monsterHrid: '/monsters/dryad' })).toEqual({ started: true });
        expect(capture.captureFile().context.monsterHrid).toBe('/monsters/dryad');
    });
});

describe('the autosave', () => {
    beforeEach(() => {
        vi.spyOn(dataManager, 'getCurrentCharacterId').mockReturnValue('char1');
    });

    test('is written on stop, so a capture that ends by itself survives a reload', async () => {
        capture.startCapture({ monsterHrid: '/monsters/cyclops' });
        emit('battle_updated', battle);
        capture.stopCapture();
        const stored = await storage.get('labyrinthTickCaptureAutosave_char1', 'labyrinth', null);
        expect(stored?.ticks).toHaveLength(1);
    });

    test('throttles writes while ticks accumulate, at most once per interval', () => {
        vi.useFakeTimers();
        try {
            capture.startCapture({ monsterHrid: '/monsters/cyclops' });
            emit('battle_updated', battle); // the first tick's own immediate write, not under test here
            const setSpy = vi.spyOn(storage, 'set');
            emit('battle_updated', { ...battle, pMap: { 0: { cHP: 90 } } });
            emit('battle_updated', { ...battle, pMap: { 0: { cHP: 80 } } });
            expect(setSpy).not.toHaveBeenCalled();
            vi.advanceTimersByTime(10_000);
            emit('battle_updated', { ...battle, pMap: { 0: { cHP: 70 } } });
            expect(setSpy).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    test('is cleared on Discard', async () => {
        capture.startCapture({ monsterHrid: '/monsters/cyclops' });
        emit('battle_updated', battle);
        capture.stopCapture();
        capture.clearCapture();
        const stored = await storage.get('labyrinthTickCaptureAutosave_char1', 'labyrinth', null);
        expect(stored).toBeNull();
    });

    test('is cleared when a new capture explicitly replaces it (force)', async () => {
        capture.startCapture({ monsterHrid: '/monsters/cyclops' });
        emit('battle_updated', battle);
        capture.stopCapture();
        capture.startCapture({ monsterHrid: '/monsters/dryad' }, { force: true });
        // Nothing pushed yet for the new capture — no ticks to write — so the
        // key holding the discarded fight must simply be gone, not stale
        const stored = await storage.get('labyrinthTickCaptureAutosave_char1', 'labyrinth', null);
        expect(stored).toBeNull();
    });

    test('stands down under quota pressure rather than fail on every tick', () => {
        storageMock.quotaExceeded = true;
        capture.startCapture({ monsterHrid: '/monsters/cyclops' });
        expect(() => emit('battle_updated', battle)).not.toThrow();
        expect(capture.captureFile().ticks).toHaveLength(1);
    });
});

describe('recovering an autosaved capture on load', () => {
    beforeEach(() => {
        vi.spyOn(dataManager, 'getCurrentCharacterId').mockReturnValue('char1');
    });

    test('restores a held capture as stopped, unsaved, and shaped like a live one', async () => {
        capture.startCapture({ monsterHrid: '/monsters/cyclops', roomLevel: 206, fingerprint: 'fp1' });
        emit('new_battle', { monsters: [{ hrid: '/monsters/cyclops' }], players: [] });
        emit('battle_updated', battle);
        const liveFile = capture.captureFile();
        capture.stopCapture();

        // A fresh module load forgets everything in memory but leaves the
        // autosave behind — that is what a page reload does.
        capture.forgetForCharacterSwitch();
        expect(capture.captureFile().ticks).toHaveLength(0);

        const recovered = await capture.loadAutosave();
        expect(recovered).toBe(true);
        const restored = capture.captureFile();
        expect(restored.ticks).toEqual(liveFile.ticks);
        expect(restored.captureId).toBe(liveFile.captureId);
        expect(restored.context).toEqual(liveFile.context);
        expect(restored.format).toBe(liveFile.format);
        // Always presented as unsaved, whatever the autosave's own savedAt said
        expect(restored.savedAt).toBeNull();
        expect(capture.isCapturing()).toBe(false);
        expect(capture.heldTickCount()).toBe(liveFile.ticks.length);
    });

    test('does nothing when nothing is autosaved', async () => {
        expect(await capture.loadAutosave()).toBe(false);
        expect(capture.captureFile().ticks).toHaveLength(0);
    });

    test('a character switch mid-read is not restored — the read is for whoever asked, not whoever is current when it lands', async () => {
        const spy = vi.spyOn(dataManager, 'getCurrentCharacterId').mockReturnValue('charA');
        storageMock.storeFor('labyrinth').set('labyrinthTickCaptureAutosave_charA', {
            ticks: [{ at: 0, type: 'battle_updated', payload: {} }],
        });

        // Delay the read so the switch can land while it is in flight — the
        // existing mock resolves instantly and cannot exercise this at all.
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const getSpy = vi.spyOn(storage, 'get').mockImplementation(async (key, store, fallback) => {
            await gate;
            const map = storageMock.storeFor(store);
            return map.has(key) ? structuredClone(map.get(key)) : fallback;
        });

        const pending = capture.loadAutosave(); // reads under charA
        spy.mockReturnValue('charB'); // the switch lands while the read is in flight
        release();
        expect(await pending).toBe(false);
        expect(capture.captureFile().ticks).toHaveLength(0);

        getSpy.mockRestore();
    });

    test('a restored capture reports its own recorded span, not wall time since the original session', async () => {
        vi.useFakeTimers();
        try {
            capture.startCapture({ monsterHrid: '/monsters/cyclops' });
            emit('battle_updated', battle);
            vi.advanceTimersByTime(5000);
            emit('battle_updated', { ...battle, pMap: { 0: { cHP: 90 } } });
            capture.stopCapture();
            capture.forgetForCharacterSwitch();

            // A reload days later — the original startedAt is now far in the past
            vi.advanceTimersByTime(3 * 24 * 60 * 60 * 1000);
            expect(await capture.loadAutosave()).toBe(true);

            // The capture's own span (5s), not the days elapsed since it ran
            expect(capture.captureStatus().seconds).toBeCloseTo(5, 5);
        } finally {
            vi.useRealTimers();
        }
    });

    test('never overwrites a capture already held or running in this session', async () => {
        await storage.set(
            'labyrinthTickCaptureAutosave_char1',
            { ticks: [{ at: 0, type: 'battle_updated', payload: {} }] },
            'labyrinth'
        );
        capture.startCapture({ monsterHrid: '/monsters/dryad' });
        emit('battle_updated', battle);
        const before = capture.captureFile();
        expect(await capture.loadAutosave()).toBe(false);
        expect(capture.captureFile()).toEqual(before);
    });
});

describe('per-character scoping', () => {
    test('character B never sees character A held capture', async () => {
        const spy = vi.spyOn(dataManager, 'getCurrentCharacterId').mockReturnValue('charA');
        capture.startCapture({ monsterHrid: '/monsters/cyclops' });
        emit('battle_updated', battle);
        capture.stopCapture();
        capture.forgetForCharacterSwitch();

        spy.mockReturnValue('charB');
        expect(await capture.loadAutosave()).toBe(false);
        expect(capture.captureFile().ticks).toHaveLength(0);

        spy.mockReturnValue('charA');
        expect(await capture.loadAutosave()).toBe(true);
        expect(capture.captureFile().ticks).toHaveLength(1);
    });

    test('a mid-capture character switch autosaves under whoever fought it, not whoever is current at write time', async () => {
        const spy = vi.spyOn(dataManager, 'getCurrentCharacterId').mockReturnValue('charA');
        capture.startCapture({ monsterHrid: '/monsters/cyclops' });
        emit('battle_updated', battle);
        // The character switches while the ticks are still held; re-reading
        // "current character" at write time would autosave this under
        // charB's key instead of the one who actually fought it
        spy.mockReturnValue('charB');
        capture.stopCapture();

        const underA = await storage.get('labyrinthTickCaptureAutosave_charA', 'labyrinth', null);
        const underB = await storage.get('labyrinthTickCaptureAutosave_charB', 'labyrinth', null);
        expect(underA?.ticks).toHaveLength(1);
        expect(underB).toBeNull();
    });
});

describe('downloadCapture refreshes the autosave, but never clears it', () => {
    test('a saved capture stays autosaved until Discard', async () => {
        vi.spyOn(dataManager, 'getCurrentCharacterId').mockReturnValue('char1');
        vi.stubGlobal('Blob', class {});
        vi.stubGlobal('URL', { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} });
        vi.stubGlobal('document', { createElement: () => ({ click: () => {} }) });

        capture.startCapture({ monsterHrid: '/monsters/cyclops' });
        emit('battle_updated', battle);
        capture.stopCapture();
        capture.downloadCapture();

        const stored = await storage.get('labyrinthTickCaptureAutosave_char1', 'labyrinth', null);
        // Firefox's Save dialog can be cancelled, so the click alone must not
        // be what clears the safety net
        expect(stored?.ticks).toHaveLength(1);
        expect(stored?.savedAt).not.toBeNull();

        vi.unstubAllGlobals();
    });
});

describe('per-fight room level', () => {
    /**
     * A labyrinth monster shaped like the real payload (measured against a
     * live capture, 2026-09-27): `combatDetails.combatLevel` — and
     * `staminaLevel`, which the labyrinth scales identically — equals the
     * room level directly. `maxHitpoints` here mirrors the actual measured
     * pair (255 -> 10600, 242 -> 10080) as corroborating context, not
     * something the code reads.
     */
    const labMonster = (hrid, roomLevel, maxHitpoints) => ({
        hrid,
        combatDetails: {
            combatLevel: roomLevel,
            staminaLevel: roomLevel,
            maxHitpoints,
            currentHitpoints: maxHitpoints,
        },
    });

    test('a new_battle tick carries its own fight room level', () => {
        capture.startCapture({ monsterHrid: '/monsters/pyre_hunter', roomLevel: 255 });
        emit('new_battle', { monsters: [labMonster('/monsters/pyre_hunter', 255, 10600)], players: [] });

        const file = capture.captureFile();
        expect(file.ticks[0].roomLevel).toBe(255);
    });

    test('a capture followed across rooms tags each fight with its own level, not the one it started at', () => {
        capture.startCapture({ monsterHrid: '/monsters/pyre_hunter', roomLevel: 255 }, { stopOnLeave: false });
        emit('new_battle', { monsters: [labMonster('/monsters/pyre_hunter', 255, 10600)], players: [] });
        emit('new_battle', { monsters: [labMonster('/monsters/pyre_hunter', 255, 10600)], players: [] });
        emit('new_battle', { monsters: [labMonster('/monsters/pyre_hunter', 255, 10600)], players: [] });
        emit('new_battle', { monsters: [labMonster('/monsters/pyre_hunter', 255, 10600)], players: [] });
        // The room the maintainer's capture actually moved to: same monster,
        // lower level, and a correspondingly lower max HP
        emit('new_battle', { monsters: [labMonster('/monsters/pyre_hunter', 242, 10080)], players: [] });

        const file = capture.captureFile();
        const fights = file.ticks.filter((t) => t.type === 'new_battle');
        expect(fights).toHaveLength(5);
        expect(fights.map((f) => f.roomLevel)).toEqual([255, 255, 255, 255, 242]);

        // context.roomLevel is kept exactly as before — the level the capture
        // started at, for whatever already reads it — never overwritten by a
        // later fight
        expect(file.context.roomLevel).toBe(255);

        // The reader that must prefer the per-fight level sees the true
        // current one, not the stale capture-wide context
        expect(capture.lastFightRoomLevel(file)).toBe(242);
    });

    test('lastFightRoomLevel falls back to context.roomLevel for a legacy file with no per-tick level', () => {
        const legacy = {
            context: { roomLevel: 206 },
            ticks: [
                { type: 'new_battle', payload: {} },
                { type: 'battle_updated', payload: {} },
            ],
        };
        expect(capture.lastFightRoomLevel(legacy)).toBe(206);
    });

    test('lastFightRoomLevel is null when neither a per-fight level nor a context level is known', () => {
        expect(capture.lastFightRoomLevel({ ticks: [], context: {} })).toBeNull();
    });

    test('a monster payload with no scaled level tags the tick null rather than guessing', () => {
        capture.startCapture({ monsterHrid: '/monsters/fly', roomLevel: 10 });
        emit('new_battle', { monsters: [{ hrid: '/monsters/fly' }], players: [] });

        const file = capture.captureFile();
        expect(file.ticks[0].roomLevel).toBeNull();
        // Falls back to the capture-wide context rather than reporting nothing
        expect(capture.lastFightRoomLevel(file)).toBe(10);
    });
});
