/**
 * The diagnostic trace keeps the raw trial stream, gated on an opt-in setting.
 *
 * What is worth pinning is the contract an external reader depends on: capture
 * only when asked, adjacent duplicate ticks dropped and counted, a bounded ring
 * that says when it trimmed, NDJSON whose first line is the metadata, and a
 * traceId that is stable for the trace's whole life so the summary export can
 * name its pair.
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

import trace, { GuildTrialTrace, MAX_EVENTS, TRACE_MESSAGES } from './guild-trial-trace.js';

function emit(type, payload) {
    for (const fn of bus.get(type) || []) fn(payload);
}

const tick = { battleId: 1, tier: 2, pMap: { 0: { cHP: 100 } }, mMap: { 0: { cHP: 500_000 } } };

beforeEach(() => {
    settings.guildTrialDiagnosticTrace = true;
    trace.clear();
    trace.initialize();
});

afterEach(() => {
    trace.cleanup();
    trace.clear();
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

    test('a trace starts on the first trial event, keeping the payload as received', () => {
        emit('new_guild_battle', { battleId: 1, tier: 1, players: [{ character: { name: 'Ada' } }] });

        const status = trace.status();
        expect(status.running).toBe(true);
        expect(status.eventCount).toBe(1);
        expect(status.traceId).toEqual(expect.any(String));
        expect(status.startedAt).toEqual(expect.any(Number));

        const event = trace.buildTraceFile().events[0];
        expect(event.type).toBe('new_guild_battle');
        expect(event.rel).toBe(0);
        expect(event.at).toEqual(expect.any(Number));
        // Raw, not thinned: the payload is the record
        expect(event.payload).toEqual({ battleId: 1, tier: 1, players: [{ character: { name: 'Ada' } }] });
    });

    test('every message in the trial family is kept, in arrival order', () => {
        for (const type of TRACE_MESSAGES) emit(type, { marker: type });
        expect(trace.buildTraceFile().events.map((event) => event.type)).toEqual(TRACE_MESSAGES);
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

    test('ring-buffer overflow drops the oldest and counts them', () => {
        // The shipped cap stands; the ring itself is exercised on a small one
        expect(MAX_EVENTS).toBe(200_000);

        const small = new GuildTrialTrace({ maxEvents: 5 });
        small.initialize();
        try {
            for (let i = 0; i < 8; i++) emit('new_guild_battle', { battleId: 1, tier: i });
            const file = small.buildTraceFile();
            expect(file.events).toHaveLength(5);
            expect(file.eventsDropped).toBe(3);
            expect(small.status().eventsDropped).toBe(3);
            // The oldest fell off: the first retained event is the fourth pushed
            expect(file.events[0].payload.tier).toBe(3);
        } finally {
            small.cleanup();
        }
    });

    test('traceId is stable within a trace, and new after clear and restart', () => {
        emit('guild_battle_updated', tick);
        const first = trace.activeTraceId();
        emit('guild_battle_updated', { ...tick, pMap: { 0: { cHP: 90 } } });
        expect(trace.activeTraceId()).toBe(first);
        expect(trace.buildTraceFile().traceId).toBe(first);

        trace.clear();
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

describe('the trace file', () => {
    test('gap stats come from the retained event times', () => {
        vi.useFakeTimers();
        try {
            emit('guild_battle_updated', tick);
            vi.advanceTimersByTime(300);
            emit('guild_battle_updated', { ...tick, pMap: { 0: { cHP: 90 } } });
            vi.advanceTimersByTime(6000); // the fight view was closed for a while
            emit('guild_battle_updated', { ...tick, pMap: { 0: { cHP: 80 } } });

            const file = trace.buildTraceFile();
            expect(file.maxGapMs).toBe(6000);
            expect(file.gapsOver5s).toBe(1);
            expect(file.events[1].rel).toBe(300);
            expect(file.events[2].rel).toBe(6300);
        } finally {
            vi.useRealTimers();
        }
    });

    test('a trace too short to have gaps reports none', () => {
        emit('guild_battle_updated', tick);
        const file = trace.buildTraceFile();
        expect(file.maxGapMs).toBeNull();
        expect(file.gapsOver5s).toBe(0);
    });

    test('startedMidFight is true when the trace opens on a tick rather than a tier start', () => {
        emit('guild_battle_updated', tick);
        expect(trace.buildTraceFile().startedMidFight).toBe(true);
    });

    test('startedMidFight is false when the trace opens on new_guild_battle', () => {
        emit('new_guild_battle', { battleId: 1, tier: 1 });
        emit('guild_battle_updated', tick);
        expect(trace.buildTraceFile().startedMidFight).toBe(false);
    });

    test('names its format, version and origin, with no userscript sandbox to ask', () => {
        emit('guild_battle_updated', tick);
        const file = trace.buildTraceFile();

        expect(file.format).toBe('toolasha-guild-trial-trace');
        expect(file.version).toBe(1);
        // No GM_info and no location in a node test environment: null, not a throw
        expect(file.toolashaVersion).toBeNull();
        expect(file.host).toBeNull();
        expect(file.isTestServer).toBeNull();
        expect(file.recordedAt).toBe(trace.status().startedAt);
        expect(file.exportedAt).toEqual(expect.any(Number));
        expect(file.eventCount).toBe(1);
        expect(file.duplicatesDiscarded).toBe(0);
        expect(file.eventsDropped).toBe(0);
    });

    test('carries the running script version when GM_info is there', () => {
        globalThis.GM_info = { script: { version: '9.9.9' } };
        try {
            expect(trace.buildTraceFile().toolashaVersion).toBe('9.9.9');
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

    test('the first line is the metadata without events, then one line per event', () => {
        emit('new_guild_battle', { battleId: 1, tier: 1 });
        emit('guild_battle_updated', tick);

        const lines = trace.buildTraceNdjson().trimEnd().split('\n');
        expect(lines).toHaveLength(3);

        const metadata = JSON.parse(lines[0]);
        expect(metadata.format).toBe('toolasha-guild-trial-trace');
        expect(metadata.eventCount).toBe(2);
        expect(metadata.events).toBeUndefined();

        expect(JSON.parse(lines[1])).toMatchObject({ type: 'new_guild_battle', rel: expect.any(Number) });
        expect(JSON.parse(lines[2])).toMatchObject({ type: 'guild_battle_updated', payload: tick });
    });

    test('exports gzipped NDJSON that decompresses back to the trace', async () => {
        emit('new_guild_battle', { battleId: 1, tier: 1 });
        emit('guild_battle_updated', tick);
        const written = armDownload();

        await expect(trace.exportTrace()).resolves.toBe(true);
        expect(written.link.download).toMatch(/^toolasha-trial-trace-.+\.ndjson\.gz$/);
        expect(written.link.click).toHaveBeenCalled();

        const stream = written.blob.stream().pipeThrough(new DecompressionStream('gzip'));
        const text = await new Response(stream).text();
        const lines = text.trimEnd().split('\n');
        expect(lines).toHaveLength(3);
        expect(JSON.parse(lines[0]).traceId).toBe(trace.activeTraceId());
        expect(JSON.parse(lines[2]).payload).toEqual(tick);
    });

    test('falls back to plain NDJSON where CompressionStream is missing', async () => {
        emit('guild_battle_updated', tick);
        const written = armDownload();
        vi.stubGlobal('CompressionStream', undefined);

        await expect(trace.exportTrace()).resolves.toBe(true);
        expect(written.link.download).toMatch(/\.ndjson$/);
        expect(written.link.download).not.toMatch(/\.gz$/);

        const text = await written.blob.text();
        expect(JSON.parse(text.trimEnd().split('\n')[0]).format).toBe('toolasha-guild-trial-trace');
    });

    test('an empty trace has nothing to export', async () => {
        armDownload();
        await expect(trace.exportTrace()).resolves.toBe(false);
    });
});
