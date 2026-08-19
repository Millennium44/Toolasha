/**
 * The diagnostic trace keeps the raw trial stream, gated on an opt-in setting.
 *
 * What is worth pinning is the contract an external reader depends on: capture
 * only when asked, adjacent duplicate ticks dropped and counted, events flushed
 * to character-scoped IndexedDB chunks a reload can adopt, whole-chunk eviction
 * that says when it trimmed, NDJSON whose first line is the metadata, and a
 * traceId that is stable for the trace's whole life — across reloads too — so
 * the summary export can name its pair.
 *
 * Storage is an in-memory map behind mocked character-key/storage modules, and
 * compression is mocked as identity, so the persistence contract is tested
 * without IndexedDB or CompressionStream.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const bus = vi.hoisted(() => new Map());
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, fn) => {
            if (!bus.has(type)) bus.set(type, new Set());
            bus.get(type).add(fn);
        },
        off: (type, fn) => bus.get(type)?.delete(fn),
    },
}));

const settings = vi.hoisted(() => ({ guildTrialDiagnosticTrace: true }));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback) => (key in settings ? settings[key] : fallback),
    },
}));

// One in-memory map stands in for the guildHistory store, shared by the
// character-key mock (scoped reads/writes) and the storage mock (deletes)
const store = vi.hoisted(() => new Map());
vi.mock('../../utils/character-key.js', () => ({
    characterKey: (base) => `${base}_c1`,
    readScoped: async (base, storeName, defaultValue = null) => {
        const value = store.get(`${base}_c1`);
        return value === undefined ? defaultValue : value;
    },
    writeScoped: async (base, value) => {
        store.set(`${base}_c1`, value);
        return true;
    },
}));
// `unavailable` stands in for a dropped IndexedDB connection: a read that says
// it could not be made, rather than one that says "nothing there"
const storageMock = vi.hoisted(() => ({ unavailable: false }));
vi.mock('../../core/storage.js', () => ({
    default: {
        tryGet: async (key) => {
            if (storageMock.unavailable) return null;
            return store.has(key) ? { found: true, value: store.get(key) } : { found: false, value: null };
        },
        delete: async (key) => {
            store.delete(key);
            return true;
        },
    },
}));

// Identity compression: chunks take the gz:false path, so the tests need no
// CompressionStream and can read stored chunk data as plain text
vi.mock('../sync/sync-compress.js', () => ({
    compressionAvailable: () => false,
    gzipText: async (text) => text,
    gunzipToText: async (text) => text,
}));

import trace, { GuildTrialTrace, MAX_EVENTS, MAX_STORED_BYTES, TRACE_MESSAGES } from './guild-trial-trace.js';

function emit(type, payload) {
    for (const fn of bus.get(type) || []) fn(payload);
}

/** The trace's events, parsed back out of its NDJSON */
async function tracedEvents(instance = trace) {
    const lines = (await instance.buildTraceNdjson()).trimEnd().split('\n');
    return lines.slice(1).map((line) => JSON.parse(line));
}

/** The trace's metadata, parsed off the NDJSON first line */
async function tracedMetadata(instance = trace) {
    return JSON.parse((await instance.buildTraceNdjson()).split('\n', 1)[0]);
}

const tick = { battleId: 1, tier: 2, pMap: { 0: { cHP: 100 } }, mMap: { 0: { cHP: 500_000 } } };

beforeEach(async () => {
    settings.guildTrialDiagnosticTrace = true;
    storageMock.unavailable = false;
    store.clear();
    await trace.clear();
    trace.initialize();
    await trace.whenReady();
});

afterEach(async () => {
    trace.cleanup();
    await trace.clear();
    store.clear();
});

describe('capture', () => {
    test('nothing is captured while the setting is off', () => {
        settings.guildTrialDiagnosticTrace = false;
        emit('guild_battle_updated', tick);
        emit('new_guild_battle', { battleId: 1, tier: 1 });

        const status = trace.status();
        expect(status.eventCount).toBe(0);
        expect(status.traceId).toBeNull();
        expect(status.running).toBe(false);
        expect(trace.activeTraceId()).toBeNull();
    });

    test('a trace starts on the first trial event, keeping the payload as received', async () => {
        emit('new_guild_battle', { battleId: 1, tier: 1, players: [{ character: { name: 'Ada' } }] });

        const status = trace.status();
        expect(status.running).toBe(true);
        expect(status.eventCount).toBe(1);
        expect(status.traceId).toEqual(expect.any(String));
        expect(status.startedAt).toEqual(expect.any(Number));

        const [event] = await tracedEvents();
        expect(event.type).toBe('new_guild_battle');
        expect(event.rel).toBe(0);
        expect(event.at).toEqual(expect.any(Number));
        // Raw, not thinned: the payload is the record
        expect(event.payload).toEqual({ battleId: 1, tier: 1, players: [{ character: { name: 'Ada' } }] });
    });

    test('every message in the trial family is kept, in arrival order', async () => {
        for (const type of TRACE_MESSAGES) emit(type, { marker: type });
        expect((await tracedEvents()).map((event) => event.type)).toEqual(TRACE_MESSAGES);
    });

    test('an adjacent byte-identical tick is dropped, and counted', () => {
        emit('guild_battle_updated', tick);
        emit('guild_battle_updated', tick); // the hook does not dedup this stream, so the trace must
        emit('guild_battle_updated', { ...tick, pMap: { 0: { cHP: 90 } } });

        const status = trace.status();
        expect(status.eventCount).toBe(2);
        expect(status.duplicatesDiscarded).toBe(1);
    });

    test('the same reading returning later is kept — only adjacency is noise', () => {
        emit('guild_battle_updated', tick);
        emit('guild_battle_updated', { ...tick, pMap: { 0: { cHP: 90 } } });
        emit('guild_battle_updated', tick); // healed back to the same numbers: real

        expect(trace.status().eventCount).toBe(3);
        expect(trace.status().duplicatesDiscarded).toBe(0);
    });

    test('identical lifecycle messages are never deduplicated — two of them are two events', () => {
        const opener = { battleId: 1, tier: 1 };
        emit('new_guild_battle', opener);
        emit('new_guild_battle', opener);
        expect(trace.status().eventCount).toBe(2);
        expect(trace.status().duplicatesDiscarded).toBe(0);
    });

    test('turning the setting off mid-session stops capture but keeps the buffer', () => {
        emit('guild_battle_updated', tick);
        const id = trace.activeTraceId();

        settings.guildTrialDiagnosticTrace = false;
        emit('guild_battle_updated', { ...tick, pMap: { 0: { cHP: 90 } } });

        const status = trace.status();
        expect(status.eventCount).toBe(1);
        expect(status.running).toBe(false);
        // Held, not discarded: the trace can still be exported and paired
        expect(trace.activeTraceId()).toBe(id);
    });

    test('traceId is stable within a trace, and new after clear and restart', async () => {
        emit('guild_battle_updated', tick);
        const first = trace.activeTraceId();
        emit('guild_battle_updated', { ...tick, pMap: { 0: { cHP: 90 } } });
        expect(trace.activeTraceId()).toBe(first);
        expect((await tracedMetadata()).traceId).toBe(first);

        await trace.clear();
        expect(trace.activeTraceId()).toBeNull();
        expect(trace.status().eventCount).toBe(0);

        emit('guild_battle_updated', tick);
        expect(trace.activeTraceId()).toEqual(expect.any(String));
        expect(trace.activeTraceId()).not.toBe(first);
    });

    test('cleanup unsubscribes: a cleaned-up trace hears nothing more', () => {
        emit('guild_battle_updated', tick);
        trace.cleanup();
        emit('guild_battle_updated', { ...tick, pMap: { 0: { cHP: 90 } } });

        const status = trace.status();
        expect(status.eventCount).toBe(1); // the buffer is kept, nothing new lands
        expect(status.running).toBe(false);
    });
});

describe('persistence', () => {
    // These tests read the shared store; the singleton must not also be
    // writing chunks into it off the same bus
    beforeEach(() => {
        trace.cleanup();
    });

    test('pending events flush to a chunk and manifest at the event threshold', async () => {
        const small = new GuildTrialTrace({ flushEvents: 3 });
        small.initialize();
        await small.whenReady();
        try {
            emit('new_guild_battle', { battleId: 1, tier: 1 });
            emit('guild_battle_updated', tick);
            expect(store.has('trialTraceChunk_0_c1')).toBe(false); // below the threshold: still pending
            emit('guild_battle_updated', { ...tick, pMap: { 0: { cHP: 90 } } });
            await small._settle();

            const chunk = store.get('trialTraceChunk_0_c1');
            expect(chunk).toMatchObject({ seq: 0, events: 3, gz: false });
            expect(chunk.data.split('\n')).toHaveLength(3);

            const manifest = store.get('trialTraceManifest_c1');
            expect(manifest.traceId).toBe(small.activeTraceId());
            expect(manifest.chunkSeqs).toEqual([0]);
            expect(manifest.eventCount).toBe(3);
            expect(manifest.firstEventType).toBe('new_guild_battle');
            expect(manifest.lastEventAt).toEqual(expect.any(Number));
        } finally {
            small.cleanup();
        }
    });

    test('end_guild_battle flushes immediately, below any threshold', async () => {
        const instance = new GuildTrialTrace();
        instance.initialize();
        await instance.whenReady();
        try {
            emit('guild_battle_updated', tick);
            emit('end_guild_battle', { battleId: 1 });
            await instance._settle();

            const chunk = store.get('trialTraceChunk_0_c1');
            expect(chunk).toMatchObject({ seq: 0, events: 2 });
            expect(store.get('trialTraceManifest_c1').chunkSeqs).toEqual([0]);
        } finally {
            instance.cleanup();
        }
    });

    test('a reload adopts a fresh manifest and stitches old chunks before new events', async () => {
        const before = new GuildTrialTrace();
        before.initialize();
        await before.whenReady();
        emit('new_guild_battle', { battleId: 1, tier: 1 });
        emit('guild_battle_updated', tick);
        emit('end_guild_battle', { battleId: 1 });
        await before._settle();
        const id = before.activeTraceId();
        const startedAt = before.status().startedAt;
        before.cleanup();

        // A new instance is what a reloaded page holds: nothing in memory
        const after = new GuildTrialTrace();
        after.initialize();
        await after.whenReady();
        try {
            expect(after.activeTraceId()).toBe(id);
            expect(after.status().startedAt).toBe(startedAt);
            expect(after.status().eventCount).toBe(3);

            emit('guild_battle_updated', { ...tick, pMap: { 0: { cHP: 80 } } });
            emit('guild_trial_stats_updated', { stats: [] });
            expect(after.status().eventCount).toBe(5);

            const metadata = await tracedMetadata(after);
            expect(metadata.version).toBe(2);
            expect(metadata.traceId).toBe(id);
            expect(metadata.resumedAcrossReloads).toBe(true);
            expect(metadata.chunkCount).toBe(1);
            expect(metadata.eventCount).toBe(5);
            expect(metadata.startedMidFight).toBe(false);

            expect((await tracedEvents(after)).map((event) => event.type)).toEqual([
                'new_guild_battle',
                'guild_battle_updated',
                'end_guild_battle',
                'guild_battle_updated',
                'guild_trial_stats_updated',
            ]);
        } finally {
            after.cleanup();
        }
    });

    test('a message arriving before the restore settles joins the adopted trace, not a fresh one', async () => {
        const before = new GuildTrialTrace();
        before.initialize();
        await before.whenReady();
        emit('guild_battle_updated', tick);
        emit('end_guild_battle', { battleId: 1 });
        await before._settle();
        const id = before.activeTraceId();
        before.cleanup();

        const after = new GuildTrialTrace();
        after.initialize();
        emit('guild_battle_updated', { ...tick, pMap: { 0: { cHP: 70 } } }); // lands before the restore settles
        expect(after.activeTraceId()).toBeNull(); // queued, not recorded — no fresh trace started
        await after.whenReady();
        try {
            expect(after.activeTraceId()).toBe(id);
            expect(after.status().eventCount).toBe(3);
        } finally {
            after.cleanup();
        }
    });

    test('a manifest older than the resume window is discarded, chunks and all', async () => {
        store.set('trialTraceManifest_c1', {
            traceId: 'stale-trace',
            startedAt: Date.now() - 5 * 60 * 60 * 1000,
            chunkSeqs: [0, 1],
            chunkStats: [
                { seq: 0, events: 2, bytes: 100 },
                { seq: 1, events: 2, bytes: 100 },
            ],
            eventCount: 4,
            lastEventAt: Date.now() - 4 * 60 * 60 * 1000,
        });
        store.set('trialTraceChunk_0_c1', { seq: 0, events: 2, gz: false, data: '{}\n{}' });
        store.set('trialTraceChunk_1_c1', { seq: 1, events: 2, gz: false, data: '{}\n{}' });

        const instance = new GuildTrialTrace();
        instance.initialize();
        await instance.whenReady();
        try {
            expect(store.has('trialTraceManifest_c1')).toBe(false);
            expect(store.has('trialTraceChunk_0_c1')).toBe(false);
            expect(store.has('trialTraceChunk_1_c1')).toBe(false);

            emit('guild_battle_updated', tick);
            expect(instance.activeTraceId()).not.toBe('stale-trace');
            expect(instance.status().eventCount).toBe(1);
        } finally {
            instance.cleanup();
        }
    });

    test('past the event cap the oldest whole chunks are evicted and counted', async () => {
        expect(MAX_EVENTS).toBe(200_000); // the shipped cap stands; eviction is exercised on a small one

        const instance = new GuildTrialTrace({ maxEvents: 4, flushEvents: 2 });
        instance.initialize();
        await instance.whenReady();
        try {
            for (let hp = 100; hp > 40; hp -= 10) {
                emit('guild_battle_updated', { ...tick, pMap: { 0: { cHP: hp } } });
                if (hp % 20 === 10) await instance._settle(); // let each pair land as its own chunk
            }
            await instance._settle();

            const status = instance.status();
            expect(status.eventCount).toBe(4);
            expect(status.eventsDropped).toBe(2);
            expect(store.has('trialTraceChunk_0_c1')).toBe(false); // the oldest chunk's record is gone
            expect(store.get('trialTraceManifest_c1').chunkSeqs).toEqual([1, 2]);
            expect(store.get('trialTraceManifest_c1').eventsDropped).toBe(2);

            // The window that remains is the newest four events
            const events = await tracedEvents(instance);
            expect(events.map((event) => event.payload.pMap[0].cHP)).toEqual([80, 70, 60, 50]);
            expect((await tracedMetadata(instance)).eventsDropped).toBe(2);
        } finally {
            instance.cleanup();
        }
    });

    test('past the stored-bytes cap the oldest whole chunks are evicted the same way', async () => {
        expect(MAX_STORED_BYTES).toBe(64 * 1024 * 1024); // the shipped cap stands

        const instance = new GuildTrialTrace({ maxStoredBytes: 250, flushEvents: 1 });
        instance.initialize();
        await instance.whenReady();
        try {
            for (let hp = 100; hp > 70; hp -= 10) {
                emit('guild_battle_updated', { ...tick, pMap: { 0: { cHP: hp } } });
                await instance._settle(); // one chunk per event, ~110 bytes each
            }

            expect(instance.status().eventsDropped).toBeGreaterThan(0);
            expect(store.has('trialTraceChunk_0_c1')).toBe(false);
            const manifest = store.get('trialTraceManifest_c1');
            expect(manifest.storedBytes).toBeLessThanOrEqual(250);
            expect(manifest.chunkSeqs.length + instance.status().eventsDropped).toBe(3);
        } finally {
            instance.cleanup();
        }
    });

    test('clear() removes the manifest and every stored chunk', async () => {
        const instance = new GuildTrialTrace({ flushEvents: 1 });
        instance.initialize();
        await instance.whenReady();
        try {
            emit('guild_battle_updated', tick);
            emit('guild_battle_updated', { ...tick, pMap: { 0: { cHP: 90 } } });
            await instance._settle();
            expect([...store.keys()].some((key) => key.startsWith('trialTrace'))).toBe(true);

            await instance.clear();
            expect([...store.keys()].some((key) => key.startsWith('trialTrace'))).toBe(false);
            expect(instance.status().eventCount).toBe(0);
            expect(instance.activeTraceId()).toBeNull();
        } finally {
            instance.cleanup();
        }
    });

    /**
     * A manifest and one chunk, as a tab that died mid-fight leaves them.
     * @returns {{id: string, startedAt: number}} The persisted trace's identity
     */
    function persistedTrace() {
        const startedAt = Date.now() - 60_000;
        store.set('trialTraceManifest_c1', {
            traceId: 'held-trace',
            startedAt,
            chunkSeqs: [0, 1],
            chunkStats: [
                { seq: 0, events: 2, bytes: 100 },
                { seq: 1, events: 1, bytes: 50 },
            ],
            eventCount: 3,
            firstEventType: 'new_guild_battle',
            lastEventAt: Date.now() - 30_000,
        });
        store.set('trialTraceChunk_0_c1', {
            seq: 0,
            events: 2,
            gz: false,
            data: '{"type":"new_guild_battle"}\n{"type":"guild_battle_updated"}',
        });
        store.set('trialTraceChunk_1_c1', { seq: 1, events: 1, gz: false, data: '{"type":"guild_battle_updated"}' });
        return { id: 'held-trace', startedAt };
    }

    test('a manifest that cannot be read does not start a fresh trace: events are held', async () => {
        persistedTrace();
        storageMock.unavailable = true;

        const instance = new GuildTrialTrace({ flushEvents: 1 });
        instance.initialize();
        await instance.whenReady();
        try {
            emit('guild_battle_updated', tick);
            emit('guild_battle_updated', { ...tick, pMap: { 0: { cHP: 90 } } });
            await instance._settle();

            // No trace started, nothing flushed, and above all no manifest
            // written over the one that could not be read
            expect(instance.activeTraceId()).toBeNull();
            expect(instance.status().running).toBe(false);
            expect(instance.status().heldCount).toBe(2);
            expect(store.get('trialTraceManifest_c1').traceId).toBe('held-trace');
            expect(store.has('trialTraceChunk_2_c1')).toBe(false);
        } finally {
            instance.cleanup();
        }
    });

    test('once the manifest reads, it is adopted and the held events are stitched on in order', async () => {
        vi.useFakeTimers();
        try {
            const { id, startedAt } = persistedTrace();
            storageMock.unavailable = true;

            const instance = new GuildTrialTrace({ flushEvents: 1, flushIntervalMs: 1000 });
            instance.initialize();
            await instance.whenReady();
            try {
                emit('guild_battle_updated', { ...tick, pMap: { 0: { cHP: 90 } } });
                emit('guild_battle_updated', { ...tick, pMap: { 0: { cHP: 80 } } });
                await instance._settle();
                expect(instance.activeTraceId()).toBeNull();

                // Storage comes back; the next message past the retry interval re-probes
                storageMock.unavailable = false;
                vi.advanceTimersByTime(1500);
                emit('guild_battle_updated', { ...tick, pMap: { 0: { cHP: 70 } } });
                await instance._settle();

                expect(instance.activeTraceId()).toBe(id);
                expect(instance.status().startedAt).toBe(startedAt);
                expect(instance.status().heldCount).toBe(0);
                expect(instance.status().eventCount).toBe(6); // 3 persisted + 3 held

                // New chunks continue after the adopted manifest's last seq —
                // the replay lands as one chunk, so no seq collides with a stored one
                const manifest = store.get('trialTraceManifest_c1');
                expect(manifest.traceId).toBe(id);
                expect(manifest.chunkSeqs).toEqual([0, 1, 2]);
                expect(store.get('trialTraceChunk_2_c1').events).toBe(3);
                expect(manifest.resumed).toBe(true);

                const events = await tracedEvents(instance);
                expect(events.slice(3).map((event) => event.payload.pMap[0].cHP)).toEqual([90, 80, 70]);
                // Held events keep their real arrival order and times
                expect(events[3].at).toBeLessThanOrEqual(events[4].at);
                expect(events[4].at).toBeLessThanOrEqual(events[5].at);
            } finally {
                instance.cleanup();
            }
        } finally {
            vi.useRealTimers();
        }
    });

    test('a manifest that stays unreadable past the bound gives way to a fresh trace, and says so', async () => {
        vi.useFakeTimers();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            persistedTrace();
            storageMock.unavailable = true;

            const instance = new GuildTrialTrace({ flushEvents: 1, flushIntervalMs: 1000, unknownGiveUpMs: 5000 });
            instance.initialize();
            await instance.whenReady();
            try {
                emit('guild_battle_updated', tick);
                vi.advanceTimersByTime(2000);
                emit('guild_battle_updated', { ...tick, pMap: { 0: { cHP: 90 } } });
                await instance._settle();
                expect(instance.activeTraceId()).toBeNull(); // still within the bound: still waiting

                vi.advanceTimersByTime(4000);
                emit('guild_battle_updated', { ...tick, pMap: { 0: { cHP: 80 } } });
                await instance._settle();

                expect(instance.activeTraceId()).toEqual(expect.any(String));
                expect(instance.activeTraceId()).not.toBe('held-trace');
                expect(instance.status().heldCount).toBe(0);
                expect(instance.status().eventCount).toBe(3); // nothing held was lost
                expect(warn).toHaveBeenCalledWith(expect.stringContaining('starting a fresh trace'));
            } finally {
                instance.cleanup();
            }
        } finally {
            warn.mockRestore();
            vi.useRealTimers();
        }
    });

    test('the held-event bound also gives up, before the clock does', async () => {
        persistedTrace();
        storageMock.unavailable = true;

        const instance = new GuildTrialTrace({ flushEvents: 100, unknownGiveUpEvents: 3 });
        instance.initialize();
        await instance.whenReady();
        try {
            emit('guild_battle_updated', tick);
            emit('guild_battle_updated', { ...tick, pMap: { 0: { cHP: 90 } } });
            await instance._settle();
            expect(instance.activeTraceId()).toBeNull();

            emit('guild_battle_updated', { ...tick, pMap: { 0: { cHP: 80 } } });
            await instance._settle();
            expect(instance.activeTraceId()).toEqual(expect.any(String));
            expect(instance.status().eventCount).toBe(3);
        } finally {
            instance.cleanup();
        }
    });

    test('status() counts persisted chunks plus the unflushed pending lines', async () => {
        const instance = new GuildTrialTrace({ flushEvents: 2 });
        instance.initialize();
        await instance.whenReady();
        try {
            emit('guild_battle_updated', tick);
            emit('guild_battle_updated', { ...tick, pMap: { 0: { cHP: 90 } } });
            await instance._settle(); // two events now live in a chunk
            emit('guild_battle_updated', { ...tick, pMap: { 0: { cHP: 80 } } }); // one still pending

            expect(store.get('trialTraceChunk_0_c1').events).toBe(2);
            expect(instance.status().eventCount).toBe(3);
            expect(await tracedEvents(instance)).toHaveLength(3);
        } finally {
            instance.cleanup();
        }
    });
});

describe('the trace metadata', () => {
    test('gap stats are tracked as the stream goes by', async () => {
        vi.useFakeTimers();
        try {
            emit('guild_battle_updated', tick);
            vi.advanceTimersByTime(300);
            emit('guild_battle_updated', { ...tick, pMap: { 0: { cHP: 90 } } });
            vi.advanceTimersByTime(6000); // the fight view was closed for a while
            emit('guild_battle_updated', { ...tick, pMap: { 0: { cHP: 80 } } });

            const metadata = await tracedMetadata();
            expect(metadata.maxGapMs).toBe(6000);
            expect(metadata.gapsOver5s).toBe(1);
            const events = await tracedEvents();
            expect(events[1].rel).toBe(300);
            expect(events[2].rel).toBe(6300);
        } finally {
            vi.useRealTimers();
        }
    });

    test('a trace too short to have gaps reports none', async () => {
        emit('guild_battle_updated', tick);
        const metadata = await tracedMetadata();
        expect(metadata.maxGapMs).toBeNull();
        expect(metadata.gapsOver5s).toBe(0);
    });

    test('startedMidFight is true when the trace opens on a tick rather than a tier start', async () => {
        emit('guild_battle_updated', tick);
        expect((await tracedMetadata()).startedMidFight).toBe(true);
    });

    test('startedMidFight is false when the trace opens on new_guild_battle', async () => {
        emit('new_guild_battle', { battleId: 1, tier: 1 });
        emit('guild_battle_updated', tick);
        expect((await tracedMetadata()).startedMidFight).toBe(false);
    });

    test('names its format, version and origin, with no userscript sandbox to ask', async () => {
        emit('guild_battle_updated', tick);
        const metadata = await tracedMetadata();

        expect(metadata.format).toBe('toolasha-guild-trial-trace');
        expect(metadata.version).toBe(2);
        // No GM_info and no location in a node test environment: null, not a throw
        expect(metadata.toolashaVersion).toBeNull();
        expect(metadata.host).toBeNull();
        expect(metadata.isTestServer).toBeNull();
        expect(metadata.recordedAt).toBe(trace.status().startedAt);
        expect(metadata.exportedAt).toEqual(expect.any(Number));
        expect(metadata.eventCount).toBe(1);
        expect(metadata.duplicatesDiscarded).toBe(0);
        expect(metadata.eventsDropped).toBe(0);
        expect(metadata.resumedAcrossReloads).toBe(false);
        expect(metadata.chunkCount).toBe(0);
        expect(metadata.events).toBeUndefined();
    });

    test('carries the running script version when GM_info is there', async () => {
        globalThis.GM_info = { script: { version: '9.9.9' } };
        try {
            emit('guild_battle_updated', tick);
            expect((await tracedMetadata()).toolashaVersion).toBe('9.9.9');
        } finally {
            delete globalThis.GM_info;
        }
    });
});

describe('NDJSON export', () => {
    /** Stub the download plumbing and hand back what exportTrace wrote */
    function armDownload() {
        const written = { blob: null, link: null };
        globalThis.URL.createObjectURL = vi.fn((blob) => {
            written.blob = blob;
            return 'blob:trace';
        });
        globalThis.URL.revokeObjectURL = vi.fn();
        vi.stubGlobal('document', {
            createElement: () => {
                written.link = { click: vi.fn() };
                return written.link;
            },
        });
        return written;
    }

    afterEach(() => {
        delete globalThis.URL.createObjectURL;
        delete globalThis.URL.revokeObjectURL;
        vi.unstubAllGlobals();
    });

    test('the first line is the metadata without events, then one line per event', async () => {
        emit('new_guild_battle', { battleId: 1, tier: 1 });
        emit('guild_battle_updated', tick);

        const lines = (await trace.buildTraceNdjson()).trimEnd().split('\n');
        expect(lines).toHaveLength(3);

        const metadata = JSON.parse(lines[0]);
        expect(metadata.format).toBe('toolasha-guild-trial-trace');
        expect(metadata.eventCount).toBe(2);
        expect(metadata.events).toBeUndefined();

        expect(JSON.parse(lines[1])).toMatchObject({ type: 'new_guild_battle', rel: expect.any(Number) });
        expect(JSON.parse(lines[2])).toMatchObject({ type: 'guild_battle_updated', payload: tick });
    });

    test('exports plain NDJSON where compression is unavailable', async () => {
        emit('new_guild_battle', { battleId: 1, tier: 1 });
        emit('guild_battle_updated', tick);
        const written = armDownload();

        await expect(trace.exportTrace()).resolves.toBe(true);
        expect(written.link.download).toMatch(/^toolasha-trial-trace-.+\.ndjson$/);
        expect(written.link.download).not.toMatch(/\.gz$/);
        expect(written.link.click).toHaveBeenCalled();

        const lines = (await written.blob.text()).trimEnd().split('\n');
        expect(lines).toHaveLength(3);
        expect(JSON.parse(lines[0]).traceId).toBe(trace.activeTraceId());
        expect(JSON.parse(lines[2]).payload).toEqual(tick);
    });

    test('an export stitches persisted chunks and pending lines together', async () => {
        trace.cleanup(); // keep the singleton off the shared store for this one
        const instance = new GuildTrialTrace({ flushEvents: 2 });
        instance.initialize();
        await instance.whenReady();
        const written = armDownload();
        try {
            emit('guild_battle_updated', tick);
            emit('guild_battle_updated', { ...tick, pMap: { 0: { cHP: 90 } } });
            await instance._settle();
            emit('guild_battle_updated', { ...tick, pMap: { 0: { cHP: 80 } } });

            await expect(instance.exportTrace()).resolves.toBe(true);
            const lines = (await written.blob.text()).trimEnd().split('\n');
            expect(lines).toHaveLength(4);
            expect(lines.slice(1).map((line) => JSON.parse(line).payload.pMap[0].cHP)).toEqual([100, 90, 80]);
        } finally {
            instance.cleanup();
        }
    });

    test('an empty trace has nothing to export', async () => {
        armDownload();
        await expect(trace.exportTrace()).resolves.toBe(false);
    });
});
