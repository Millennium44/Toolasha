/**
 * Raw diagnostic trace of a guild trial's websocket stream.
 *
 * The trials feature analyses a trial through summaries — tallies, snapshots,
 * comparisons — and every one of them is a derivation. When a derived figure is
 * disputed, the only thing that settles it is the stream the derivation was made
 * from, and nothing keeps that today. This does: every trial battle message,
 * exactly as received and in order, timestamped so a reader can reconstruct the
 * timeline offline.
 *
 * Opt-in (`guildTrialDiagnosticTrace`, default off), because the file is large
 * and carries raw combat data with participant names in it.
 *
 * Persisted, not memory-only: a full-hour 50-player fight is ~36,000 ticks at
 * the observed ~10/s cadence, each tick 2–4KB of JSON — holding that as parsed
 * objects in a tab that must also render the fight is what used to make the
 * trace the thing that killed the evidence. Events are kept as pre-stringified
 * NDJSON lines, flushed to IndexedDB in gzipped chunks, and re-adopted on
 * reload, so a mid-fight refresh loses at most one flush interval instead of
 * the whole trace. Keys are character-scoped — two characters in two tabs each
 * keep their own trace.
 *
 * The websocket hook deliberately exempts `new_guild_battle` and
 * `guild_battle_updated` from its content-hash dedup (consecutive ticks open
 * with identical text), so the trace drops adjacent byte-identical
 * `guild_battle_updated` payloads itself and counts them — a trace that silently
 * kept doubles would read as twice the cadence it really had.
 */

import config from '../../core/config.js';
import storage from '../../core/storage.js';
import webSocketHook from '../../core/websocket.js';
import { compressionAvailable, gzipText, gunzipToText } from '../sync/sync-compress.js';
import { characterKey, readScoped, writeScoped } from '../../utils/character-key.js';
import { scriptVersion } from '../../utils/script-version.js';

/** The settings toggle the capture is gated on */
export const TRACE_SETTING = 'guildTrialDiagnosticTrace';

/** What the export file names itself, so a reader knows what it is holding */
export const TRACE_FORMAT = 'toolasha-guild-trial-trace';

/**
 * Events kept across chunks before the oldest whole chunks fall off. A trial
 * hour of the 50-player firehose (~36k ticks) is well under this; the cap only
 * exists so a runaway stream cannot grow without bound.
 */
export const MAX_EVENTS = 200_000;

/**
 * Stored-bytes ceiling across chunks, enforced the same way as the event cap.
 * A full hour gzips to ~10–15MB; this is runaway protection, not a budget.
 */
export const MAX_STORED_BYTES = 64 * 1024 * 1024;

/** Pending lines that force a flush to IndexedDB */
export const FLUSH_EVENTS = 500;

/** How long pending lines may sit unflushed before the next message flushes them */
export const FLUSH_INTERVAL_MS = 10_000;

/** How recent a persisted trace must be for a reload to resume it rather than discard it */
export const RESUME_WINDOW_MS = 3 * 60 * 60 * 1000;

/**
 * How long a restore whose manifest read failed keeps waiting for storage before
 * it gives up and starts a fresh trace — and how many events it will hold in
 * memory meanwhile. The manifest is the index of every chunk on disk, and a
 * failed read is not "no trace": writing a new manifest over one that could not
 * be read orphans every chunk the old one named. So the trace holds its events
 * and re-probes, bounded because held events are parsed payloads in a tab that
 * also has to render the fight.
 */
export const UNKNOWN_MANIFEST_GIVE_UP_MS = 2 * 60 * 1000;
export const UNKNOWN_MANIFEST_GIVE_UP_EVENTS = 5000;

/**
 * The trial battle stream, verbatim. Mirrors the names `guild-trial-damage.js`
 * subscribes to: the tier-opening message (roster, tier-scaled boss — every one
 * is a boundary marker in the trace), the spectator tick firehose, the
 * end-of-trial message, and the server's own per-member totals.
 */
export const TRACE_MESSAGES = [
    'new_guild_battle',
    'guild_battle_updated',
    'end_guild_battle',
    'guild_trial_stats_updated',
];

/** The message whose absence at the head of a trace means the fight was joined late */
const BOUNDARY_MESSAGE = 'new_guild_battle';

/** Object store the chunks and manifest live in */
const TRACE_STORE = 'guildHistory';

/** Base key of the manifest record (character-scoped through writeScoped/readScoped) */
const MANIFEST_BASE = 'trialTraceManifest';

/** Monotonic tail for traceId, so two starts in one millisecond still differ */
let traceSeq = 0;

/**
 * Base key of one chunk record.
 * @param {number} seq - The chunk's sequence number
 * @returns {string} Unscoped chunk key
 */
function chunkBase(seq) {
    return `trialTraceChunk_${seq}`;
}

class GuildTrialTrace {
    /**
     * @param {Object} [options] - Test seams; the singleton takes the defaults
     * @param {number} [options.maxEvents] - Total retained-event cap across chunks and pending
     * @param {number} [options.maxStoredBytes] - Total stored chunk bytes cap
     * @param {number} [options.flushEvents] - Pending lines that force a flush
     * @param {number} [options.flushIntervalMs] - Age of pending lines that forces a flush
     * @param {number} [options.resumeWindowMs] - How recent a persisted trace must be to resume
     * @param {number} [options.unknownGiveUpMs] - How long to wait on an unreadable manifest
     * @param {number} [options.unknownGiveUpEvents] - How many events to hold while waiting
     */
    constructor({
        maxEvents = MAX_EVENTS,
        maxStoredBytes = MAX_STORED_BYTES,
        flushEvents = FLUSH_EVENTS,
        flushIntervalMs = FLUSH_INTERVAL_MS,
        resumeWindowMs = RESUME_WINDOW_MS,
        unknownGiveUpMs = UNKNOWN_MANIFEST_GIVE_UP_MS,
        unknownGiveUpEvents = UNKNOWN_MANIFEST_GIVE_UP_EVENTS,
    } = {}) {
        this.maxEvents = maxEvents;
        this.maxStoredBytes = maxStoredBytes;
        this.flushEvents = flushEvents;
        this.flushIntervalMs = flushIntervalMs;
        this.resumeWindowMs = resumeWindowMs;
        this.unknownGiveUpMs = unknownGiveUpMs;
        this.unknownGiveUpEvents = unknownGiveUpEvents;
        this.initialized = false;
        this.handlers = null;
        this._restored = false;
        this._restorePromise = Promise.resolve();
        /** True while the manifest could not be read and the restore is still waiting on storage */
        this._manifestUnknown = false;
        this._unknownSince = 0;
        this._lastProbeAt = 0;
        this._probing = false;
        this._reset();
    }

    /** Empty-trace state, shared by the constructor and {@link clear} */
    _reset() {
        this.pending = []; // unflushed NDJSON lines
        this.chunks = []; // persisted chunks, oldest first: {seq, events, bytes}
        this.nextSeq = 0;
        this.storedBytes = 0;
        this.eventCount = 0; // retained events: persisted chunks + pending
        this.traceId = null;
        this.startedAt = 0;
        this.duplicatesDiscarded = 0;
        this.eventsDropped = 0;
        this.maxGapMs = null;
        this.gapsOver5s = 0;
        this.firstEventType = null;
        this.lastEventAt = 0;
        this.lastFlushAt = 0;
        this.resumed = false;
        this.lastGuildBattleKey = null;
        this._queue = []; // messages that arrived before the restore settled
        this._flushChain = Promise.resolve();
        this._flushQueued = false;
    }

    /** Whether the opt-in toggle is on right now */
    _enabled() {
        return config.getSetting(TRACE_SETTING, false);
    }

    /**
     * Listen for the trial stream and adopt or discard any persisted trace.
     * Capture itself stays gated on the setting per message. The restore is
     * async so it cannot block feature init; messages that arrive before it
     * settles are queued and replayed through the normal path afterwards, so an
     * early tick can never both start a fresh trace and adopt the old one.
     */
    initialize() {
        if (this.initialized) return;
        this.initialized = true;
        this._restored = false;

        this.handlers = new Map();
        for (const type of TRACE_MESSAGES) {
            const handler = (data) => this._onMessage(type, data);
            this.handlers.set(type, handler);
            webSocketHook.on(type, handler);
        }

        this._restorePromise = this._restore()
            .catch((error) => {
                console.error('[GuildTrialTrace] Restoring the persisted trace failed:', error);
                return 'unknown';
            })
            .then((outcome) => {
                if (outcome === 'unknown') {
                    // The manifest could not be read. That is not "no trace": a
                    // fresh manifest written now would orphan every chunk the
                    // unreadable one names. Hold events and ask again; see
                    // _retryProbe for how long.
                    this._manifestUnknown = true;
                    this._unknownSince = Date.now();
                    this._lastProbeAt = this._unknownSince;
                    console.warn('[GuildTrialTrace] The trace manifest could not be read; holding events until it can');
                    return;
                }
                this._settleRestore();
            });
    }

    /**
     * The restore is decided: replay what arrived meanwhile through the normal
     * path. Sequence numbers are only ever allocated from here on, so chunks
     * written after an adoption continue from the adopted manifest's last.
     */
    _settleRestore() {
        this._manifestUnknown = false;
        this._restored = true;
        const queued = this._queue;
        this._queue = [];
        for (const message of queued) this._record(message.type, message.data, message.at);
    }

    /**
     * Ask storage for the manifest again, from a message that arrived while it
     * was unknown. Rate-limited to the flush interval, and bounded: past
     * `unknownGiveUpMs` or `unknownGiveUpEvents` held, the trace gives up and
     * starts fresh — logged, because that fresh manifest may be orphaning chunks.
     */
    _retryProbe() {
        if (this._probing || !this._manifestUnknown) return;
        const now = Date.now();
        const overdue =
            now - this._unknownSince >= this.unknownGiveUpMs || this._queue.length >= this.unknownGiveUpEvents;
        if (!overdue && now - this._lastProbeAt < this.flushIntervalMs) return;

        this._probing = true;
        this._lastProbeAt = now;
        this._restorePromise = this._restore()
            .catch((error) => {
                console.error('[GuildTrialTrace] Re-reading the trace manifest failed:', error);
                return 'unknown';
            })
            .then((outcome) => {
                if (!this._manifestUnknown) return; // cleared meanwhile
                if (outcome === 'unknown') {
                    if (!overdue) return;
                    console.warn(
                        `[GuildTrialTrace] The trace manifest stayed unreadable for ${Math.round(
                            (Date.now() - this._unknownSince) / 1000
                        )}s with ${this._queue.length} events held; starting a fresh trace`
                    );
                }
                this._settleRestore();
            })
            .finally(() => {
                this._probing = false;
            });
    }

    /**
     * Settles once any persisted trace has been adopted or discarded and the
     * queued early messages have been replayed.
     * @returns {Promise<void>}
     */
    whenReady() {
        return this._restorePromise;
    }

    /** Let go of every listener. The buffer and the persisted chunks are kept — an export can still read them. */
    cleanup() {
        if (this.handlers) {
            for (const [type, handler] of this.handlers) webSocketHook.off(type, handler);
            this.handlers = null;
        }
        this.initialized = false;
    }

    /**
     * Read the persisted manifest: resume a trace whose stream went quiet less
     * than the resume window ago, delete anything older. A live in-memory trace
     * (re-initialize without a reload) is never overwritten.
     *
     * A read that could not be made is told apart from "no manifest": the first
     * answers `'unknown'` and the caller waits; only a trustworthy absence goes
     * on to the legacy-adoption read and a fresh start.
     * @returns {Promise<'adopted'|'fresh'|'unknown'>} What was decided
     */
    async _restore() {
        if (this.traceId) return 'fresh';
        const probe = await storage.tryGet(characterKey(MANIFEST_BASE), TRACE_STORE);
        if (probe === null) return 'unknown';
        const manifest = probe.found ? probe.value : await readScoped(MANIFEST_BASE, TRACE_STORE, null);
        if (!manifest) return 'fresh';

        const fresh =
            typeof manifest.lastEventAt === 'number' && Date.now() - manifest.lastEventAt <= this.resumeWindowMs;
        if (!fresh) {
            for (const seq of manifest.chunkSeqs || []) {
                await storage.delete(characterKey(chunkBase(seq)), TRACE_STORE);
            }
            await storage.delete(characterKey(MANIFEST_BASE), TRACE_STORE);
            return 'fresh';
        }

        const stats = Array.isArray(manifest.chunkStats)
            ? manifest.chunkStats
            : (manifest.chunkSeqs || []).map((seq) => ({ seq, events: 0, bytes: 0 }));
        this.chunks = stats.map((chunk) => ({
            seq: chunk.seq,
            events: chunk.events || 0,
            bytes: chunk.bytes || 0,
        }));
        this.storedBytes = this.chunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
        // Recomputed from the chunks rather than read back: pending lines the
        // old tab had not flushed died with it and must not be counted
        this.eventCount = this.chunks.reduce((sum, chunk) => sum + chunk.events, 0);
        this.nextSeq = this.chunks.length ? Math.max(...this.chunks.map((chunk) => chunk.seq)) + 1 : 0;
        this.traceId = manifest.traceId;
        this.startedAt = manifest.startedAt || 0;
        this.duplicatesDiscarded = manifest.duplicatesDiscarded || 0;
        this.eventsDropped = manifest.eventsDropped || 0;
        this.maxGapMs = typeof manifest.maxGapMs === 'number' ? manifest.maxGapMs : null;
        this.gapsOver5s = manifest.gapsOver5s || 0;
        this.firstEventType = manifest.firstEventType || null;
        this.lastEventAt = manifest.lastEventAt;
        this.lastFlushAt = Date.now();
        this.resumed = true;
        return 'adopted';
    }

    /**
     * One message off the stream. Gated on the setting at message time rather
     * than at subscribe time, so turning the toggle off mid-session stops the
     * capture without discarding what is already held, and turning it on starts
     * one without a re-init.
     *
     * @param {string} type - The message name
     * @param {Object} data - The payload, exactly as the hook delivered it
     */
    _onMessage(type, data) {
        try {
            if (!this._enabled()) return;
            if (!this._restored) {
                // The restore has not settled: hold the message with its real
                // arrival time so replaying it cannot start a trace the restore
                // is about to adopt over
                this._queue.push({ type, data, at: Date.now() });
                if (this._manifestUnknown) this._retryProbe();
                return;
            }
            this._record(type, data, Date.now());
        } catch (error) {
            console.error('[GuildTrialTrace] Recording a trial message failed:', error);
        }
    }

    /**
     * Keep one message: dedup, count, stringify once, and flush when due.
     * @param {string} type - The message name
     * @param {Object} data - The payload
     * @param {number} at - When the message arrived
     */
    _record(type, data, at) {
        try {
            if (!this.traceId) {
                // The trace starts on the first trial event, whatever it is — a
                // spectator joining mid-fight still gets a trace, and the file
                // says so via startedMidFight
                this.traceId = `${at.toString(36)}-${(traceSeq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
                this.startedAt = at;
                this.lastFlushAt = at;
            }

            if (type === 'guild_battle_updated') {
                // Drop an exact repeat of the previous tick: the hook exempts
                // this message from its own dedup (consecutive ticks open with
                // identical text), so byte-identity here is the only filter.
                // Only ticks — two identical lifecycle messages are two events.
                let key = null;
                try {
                    key = JSON.stringify(data);
                } catch {
                    // Unserializable payload: keep it rather than guess
                }
                if (key !== null && key === this.lastGuildBattleKey) {
                    this.duplicatesDiscarded++;
                    return;
                }
                if (key !== null) this.lastGuildBattleKey = key;
            }

            if (this.lastEventAt) {
                // Stalls in the feed, tracked as the stream goes by — a reader
                // trusting tick cadence needs to know where it went quiet (tab
                // throttled, fight view closed, page reloaded)
                const gap = at - this.lastEventAt;
                if (this.maxGapMs === null || gap > this.maxGapMs) this.maxGapMs = gap;
                if (gap > 5000) this.gapsOver5s++;
            }
            if (!this.firstEventType) this.firstEventType = type;

            this.pending.push(JSON.stringify({ at, rel: at - this.startedAt, type, payload: data }));
            this.eventCount++;
            this.lastEventAt = at;

            // A write failure keeps lines pending for a retry; do not let a dead
            // IndexedDB grow the buffer past the cap the chunks are held to
            if (this.pending.length > this.maxEvents) {
                const excess = this.pending.length - this.maxEvents;
                this.pending.splice(0, excess);
                this.eventsDropped += excess;
                this.eventCount -= excess;
            }

            if (
                this.pending.length >= this.flushEvents ||
                at - this.lastFlushAt >= this.flushIntervalMs ||
                type === 'end_guild_battle'
            ) {
                this._scheduleFlush();
            }
        } catch (error) {
            console.error('[GuildTrialTrace] Recording a trial message failed:', error);
        }
    }

    /** Queue one flush behind any in flight. Never throws into the message handler. */
    _scheduleFlush() {
        if (this._flushQueued) return;
        this._flushQueued = true;
        this._flushChain = this._flushChain
            .then(() => {
                this._flushQueued = false;
                return this._flushNow();
            })
            .catch((error) => console.error('[GuildTrialTrace] Flushing the trace failed:', error));
    }

    /** Write pending lines out as one chunk, evict over caps, update the manifest. */
    async _flushNow() {
        const lines = this.pending;
        if (lines.length) {
            this.pending = [];
            const seq = this.nextSeq++;
            const text = lines.join('\n');
            try {
                const gz = compressionAvailable();
                const data = gz ? await gzipText(text) : text;
                const bytes = gz ? data.byteLength : text.length;
                const ok = await writeScoped(
                    chunkBase(seq),
                    { seq, events: lines.length, gz, data },
                    TRACE_STORE,
                    true
                );
                if (!ok) throw new Error('storage refused the chunk write');
                this.chunks.push({ seq, events: lines.length, bytes });
                this.storedBytes += bytes;
            } catch (error) {
                console.error('[GuildTrialTrace] Persisting a trace chunk failed:', error);
                // Back into pending, ahead of anything recorded meanwhile — the
                // next flush retries, and capture never stops over a bad write
                this.pending = lines.concat(this.pending);
                this.lastFlushAt = Date.now();
                return;
            }
        }
        await this._evictOverCaps();
        await this._writeManifest();
        this.lastFlushAt = Date.now();
    }

    /**
     * Drop the oldest whole chunks while either cap is exceeded, counting their
     * events as dropped. The newest chunk is always kept — an overflowed trace
     * should hold the recent fight, and the count says the file is a window.
     */
    async _evictOverCaps() {
        while (this.chunks.length > 1 && (this.eventCount > this.maxEvents || this.storedBytes > this.maxStoredBytes)) {
            const oldest = this.chunks.shift();
            this.eventCount -= oldest.events;
            this.eventsDropped += oldest.events;
            this.storedBytes -= oldest.bytes;
            try {
                await storage.delete(characterKey(chunkBase(oldest.seq)), TRACE_STORE);
            } catch (error) {
                console.error('[GuildTrialTrace] Evicting an old trace chunk failed:', error);
            }
        }
    }

    /** Persist the trace's identity and counters so a reload can pick it back up. */
    async _writeManifest() {
        try {
            await writeScoped(
                MANIFEST_BASE,
                {
                    traceId: this.traceId,
                    startedAt: this.startedAt,
                    chunkSeqs: this.chunks.map((chunk) => chunk.seq),
                    chunkStats: this.chunks.map((chunk) => ({ ...chunk })),
                    storedBytes: this.storedBytes,
                    eventCount: this.eventCount,
                    duplicatesDiscarded: this.duplicatesDiscarded,
                    eventsDropped: this.eventsDropped,
                    maxGapMs: this.maxGapMs,
                    gapsOver5s: this.gapsOver5s,
                    firstEventType: this.firstEventType,
                    lastEventAt: this.lastEventAt,
                    resumed: this.resumed,
                },
                TRACE_STORE,
                true
            );
        } catch (error) {
            console.error('[GuildTrialTrace] Writing the trace manifest failed:', error);
        }
    }

    /** Settle the restore and every flush queued so far, including ones queued while waiting. */
    async _settle() {
        await this._restorePromise;
        let chain;
        do {
            chain = this._flushChain;
            await chain;
        } while (chain !== this._flushChain);
    }

    /**
     * Whether the trace caught the fight already running.
     *
     * The tier-opening message is the only boundary marker on the stream, so a
     * trace that does not begin with one started mid-fight. Null until anything
     * at all has been seen — an empty trace has not started anywhere.
     *
     * One derivation shared by the export header and {@link status}, so the file
     * and the button can never disagree about it.
     *
     * @returns {boolean|null}
     */
    _startedMidFight() {
        return this.firstEventType ? this.firstEventType !== BOUNDARY_MESSAGE : null;
    }

    /**
     * How much has been traced, and how well. Counts persisted chunks plus the
     * unflushed pending lines.
     *
     * The quality fields are the same five the export header carries, and they
     * are here for the same reason they are there: a count of events says how
     * *much* was captured and nothing about whether it can be trusted. A trace
     * with a forty-second hole in it, or one that began halfway through a fight,
     * has an event count that looks perfectly healthy. Somebody deciding whether
     * to keep a recording should be able to see that before they close the tab,
     * not after they open the file.
     *
     * @returns {{running: boolean, eventCount: number, heldCount: number, duplicatesDiscarded: number,
     *   eventsDropped: number, traceId: string|null, startedAt: number|null, maxGapMs: number|null,
     *   gapsOver5s: number, startedMidFight: boolean|null, resumedAcrossReloads: boolean, chunkCount: number}}
     */
    status() {
        return {
            running: Boolean(this.initialized && this.traceId && this._enabled()),
            eventCount: this.eventCount,
            // Events held back while the persisted manifest could not be read
            heldCount: this._queue.length,
            duplicatesDiscarded: this.duplicatesDiscarded,
            eventsDropped: this.eventsDropped,
            traceId: this.traceId,
            startedAt: this.startedAt || null,
            maxGapMs: this.maxGapMs,
            gapsOver5s: this.gapsOver5s,
            startedMidFight: this._startedMidFight(),
            resumedAcrossReloads: this.resumed,
            chunkCount: this.chunks.length,
        };
    }

    /**
     * The id of the trace in hand — active or held after the setting went off —
     * or null when nothing has been traced. The summary export stamps this so
     * the two files can be paired.
     * @returns {string|null}
     */
    activeTraceId() {
        return this.traceId;
    }

    /**
     * Throw the trace away, in memory and in IndexedDB. The next trial event
     * starts a fresh one, with a new id.
     * @returns {Promise<void>}
     */
    async clear() {
        try {
            await this._settle();
        } catch {
            // A wedged flush must not make the trace unclearable
        }
        const seqs = this.chunks.map((chunk) => chunk.seq);
        const restored = this._restored;
        this._reset();
        this._restored = restored;
        // Whatever the unreadable manifest named is being thrown away anyway;
        // there is nothing left to wait for
        if (this._manifestUnknown) {
            this._manifestUnknown = false;
            this._restored = true;
        }
        try {
            for (const seq of seqs) await storage.delete(characterKey(chunkBase(seq)), TRACE_STORE);
            await storage.delete(characterKey(MANIFEST_BASE), TRACE_STORE);
        } catch (error) {
            console.error('[GuildTrialTrace] Clearing the persisted trace failed:', error);
        }
    }

    /**
     * The trace metadata a reader needs to trust the stream: which script
     * produced it, against which server, how many repeated ticks were dropped,
     * whether the caps trimmed anything, where the stream went quiet, whether
     * the first event caught the fight already in progress, and whether the
     * trace was stitched back together across a reload.
     * @returns {Object} The metadata object, without events
     */
    _buildMetadata() {
        const host = typeof location !== 'undefined' ? location.hostname || null : null;
        return {
            format: TRACE_FORMAT,
            version: 2,
            traceId: this.traceId,
            toolashaVersion: scriptVersion(),
            host,
            isTestServer: host ? host.includes('test.') : null,
            recordedAt: this.startedAt || null,
            exportedAt: Date.now(),
            eventCount: this.eventCount,
            duplicatesDiscarded: this.duplicatesDiscarded,
            eventsDropped: this.eventsDropped,
            maxGapMs: this.maxGapMs,
            gapsOver5s: this.gapsOver5s,
            // The tier-opening message is the only boundary marker; a trace that
            // does not begin with one caught the fight already running
            startedMidFight: this._startedMidFight(),
            resumedAcrossReloads: this.resumed,
            chunkCount: this.chunks.length,
        };
    }

    /**
     * The whole trace as NDJSON: the metadata object on the first line, then
     * one JSON line per event — persisted chunks stitched back in order, the
     * unflushed pending lines after them. A reader can stream a large file line
     * by line rather than parsing one giant object.
     * @returns {Promise<string>}
     */
    async buildTraceNdjson() {
        await this._settle();
        const parts = [JSON.stringify(this._buildMetadata())];
        for (const chunk of this.chunks) {
            try {
                const record = await readScoped(chunkBase(chunk.seq), TRACE_STORE, null);
                if (!record) {
                    console.error(`[GuildTrialTrace] Trace chunk ${chunk.seq} is missing from storage`);
                    continue;
                }
                const text = record.gz ? await gunzipToText(record.data) : record.data;
                if (text) parts.push(text);
            } catch (error) {
                console.error(`[GuildTrialTrace] Reading trace chunk ${chunk.seq} failed:`, error);
            }
        }
        for (const line of this.pending) parts.push(line);
        return parts.join('\n') + '\n';
    }

    /**
     * Write the trace out as a file — gzipped NDJSON where the environment can
     * compress, plain NDJSON where it cannot. The trace is kept afterwards; a
     * second press downloads the same trace again.
     * @returns {Promise<boolean>} Whether there was anything to write
     */
    async exportTrace() {
        try {
            await this._settle();
            if (!this.eventCount) return false;
            const text = await this.buildTraceNdjson();
            const gzip = compressionAvailable();
            const content = gzip ? await gzipText(text) : text;
            const type = gzip ? 'application/gzip' : 'application/x-ndjson';
            const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
            const name = `toolasha-trial-trace-${stamp}.ndjson${gzip ? '.gz' : ''}`;

            const blob = new Blob([content], { type });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = name;
            link.click();
            URL.revokeObjectURL(url);
            return true;
        } catch (error) {
            console.error('[GuildTrialTrace] Writing the trace failed:', error);
            return false;
        }
    }
}

/**
 * A gap, in the coarsest unit that still says how bad it was.
 *
 * Whole seconds up to ninety, whole minutes past that. A hole in the feed is
 * measured to nothing like that precision — it is bounded by two arrival times
 * and everything between them is unknown — so "40s" is the honest shape and
 * "40.317s" would be a claim about the missing part.
 *
 * @param {number} ms - Milliseconds
 * @returns {string} e.g. `40s`, `4m`
 */
export function formatGap(ms) {
    const seconds = Math.round(ms / 1000);
    if (seconds < 90) return `${seconds}s`;
    return `${Math.round(seconds / 60)}m`;
}

/**
 * What a trace's status reads as, for the button that offers to download it.
 *
 * Every line is one of the quality fields, worded as the consequence rather
 * than as the field: a reader deciding whether this recording is worth keeping
 * cares that the opening of the tier is missing, not that `startedMidFight` is
 * true. Silent about a field with nothing to report — a trace with no gaps says
 * nothing about gaps rather than "0 gaps", because a clean recording should read
 * as short.
 *
 * Pure, so the wording can be tested without a DOM or a stream.
 *
 * @param {Object|null} status - From {@link GuildTrialTrace#status}
 * @returns {string} Lines, newline-separated; empty when nothing has been traced
 */
export function describeTraceStatus(status) {
    if (!status?.traceId) return '';

    const lines = [];
    const chunks = status.chunkCount === 1 ? '1 stored chunk' : `${status.chunkCount || 0} stored chunks`;
    lines.push(`${status.running ? 'Recording' : 'Held, not recording'} — ${chunks}.`);

    if (status.gapsOver5s > 0) {
        const gaps = status.gapsOver5s === 1 ? '1 gap over 5s' : `${status.gapsOver5s} gaps over 5s`;
        const longest = Number.isFinite(status.maxGapMs) ? `, longest ${formatGap(status.maxGapMs)}` : '';
        lines.push(`${gaps}${longest} — the stream went quiet there and the events are simply absent.`);
    }
    if (status.startedMidFight === true) {
        lines.push('Started mid-fight, so the opening of the tier is not in the file.');
    }
    if (status.resumedAcrossReloads) {
        lines.push('Stitched back together across a page reload.');
    }

    return lines.join('\n');
}

/**
 * The scoreboard's one-line warning about a hole in the recording, or nothing.
 *
 * Deliberately *not* about attribution coverage, which the damage module
 * accounts for separately and by a different measure: coverage is about which
 * ticks could be split out across players, and this is about ticks that never
 * arrived at all. Conflating them would let a fully-covered attribution look
 * unaffected by a forty-second hole in the feed it was computed from.
 *
 * Only while a trace is actually running. A trace held from an earlier session,
 * or the feature switched off, describes a recording the numbers on screen were
 * not computed from, and warning about it would be warning about nothing.
 *
 * @param {Object|null} status - From {@link GuildTrialTrace#status}
 * @returns {string} The line, or '' when there is nothing to warn about
 */
export function traceGapWarning(status) {
    if (!status?.running) return '';
    if (!(status.gapsOver5s > 0)) return '';
    if (!Number.isFinite(status.maxGapMs)) return '';

    return `recording gap ${formatGap(status.maxGapMs)} — attribution may undercount`;
}

const guildTrialTrace = new GuildTrialTrace();

export default guildTrialTrace;
export { guildTrialTrace, GuildTrialTrace };
