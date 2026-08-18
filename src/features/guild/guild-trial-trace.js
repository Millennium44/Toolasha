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
 * and carries raw combat data with participant names in it. Memory only — a
 * trace is for exporting, not for keeping, and persisting a stream this size
 * would be the wrong kind of durable.
 *
 * The websocket hook deliberately exempts `new_guild_battle` and
 * `guild_battle_updated` from its content-hash dedup (consecutive ticks open
 * with identical text), so the trace drops adjacent byte-identical
 * `guild_battle_updated` payloads itself and counts them — a trace that silently
 * kept doubles would read as twice the cadence it really had.
 */

import config from '../../core/config.js';
import webSocketHook from '../../core/websocket.js';
import { compressionAvailable, gzipText } from '../sync/sync-compress.js';
import { scriptVersion } from '../../utils/script-version.js';

/** The settings toggle the capture is gated on */
export const TRACE_SETTING = 'guildTrialDiagnosticTrace';

/** What the export file names itself, so a reader knows what it is holding */
export const TRACE_FORMAT = 'toolasha-guild-trial-trace';

/**
 * Events kept before the oldest fall off. A trial hour of the spectator
 * firehose (~2/s) is well under this; the cap only exists so a tab left open
 * across many sessions cannot grow without bound.
 */
export const MAX_EVENTS = 200_000;

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

/** Monotonic tail for traceId, so two starts in one millisecond still differ */
let traceSeq = 0;

class GuildTrialTrace {
    /**
     * @param {Object} [options] - Test seams; the singleton takes the defaults
     * @param {number} [options.maxEvents] - Ring-buffer cap
     */
    constructor({ maxEvents = MAX_EVENTS } = {}) {
        this.maxEvents = maxEvents;
        this.initialized = false;
        this.handlers = null;
        this._reset();
    }

    /** Empty-trace state, shared by the constructor and {@link clear} */
    _reset() {
        this.events = [];
        this.traceId = null;
        this.startedAt = 0;
        this.duplicatesDiscarded = 0;
        this.eventsDropped = 0;
        this.lastGuildBattleKey = null;
    }

    /** Whether the opt-in toggle is on right now */
    _enabled() {
        return config.getSetting(TRACE_SETTING, false);
    }

    /** Listen for the trial stream. Capture itself stays gated on the setting per message. */
    initialize() {
        if (this.initialized) return;
        this.initialized = true;

        this.handlers = new Map();
        for (const type of TRACE_MESSAGES) {
            const handler = (data) => this._onMessage(type, data);
            this.handlers.set(type, handler);
            webSocketHook.on(type, handler);
        }
    }

    /** Let go of every listener. The buffer is kept — an export can still read it. */
    cleanup() {
        if (this.handlers) {
            for (const [type, handler] of this.handlers) webSocketHook.off(type, handler);
            this.handlers = null;
        }
        this.initialized = false;
    }

    /**
     * One message off the stream, kept as received.
     *
     * Gated on the setting at message time rather than at subscribe time, so
     * turning the toggle off mid-session stops the capture without discarding
     * what is already held, and turning it on starts one without a re-init.
     *
     * @param {string} type - The message name
     * @param {Object} data - The payload, exactly as the hook delivered it
     */
    _onMessage(type, data) {
        try {
            if (!this._enabled()) return;

            const now = Date.now();
            if (!this.traceId) {
                // The trace starts on the first trial event, whatever it is — a
                // spectator joining mid-fight still gets a trace, and the file
                // says so via startedMidFight
                this.traceId = `${now.toString(36)}-${(traceSeq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
                this.startedAt = now;
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

            this.events.push({ at: now, rel: now - this.startedAt, type, payload: data });
            // Keep the newest: an overflowed trace should hold the recent trial,
            // and the count says the file is a window, not the whole feed
            if (this.events.length > this.maxEvents) {
                this.eventsDropped += this.events.length - this.maxEvents;
                this.events = this.events.slice(this.events.length - this.maxEvents);
            }
        } catch (error) {
            console.error('[GuildTrialTrace] Recording a trial message failed:', error);
        }
    }

    /**
     * How much has been traced, for a button to read.
     * @returns {{running: boolean, eventCount: number, duplicatesDiscarded: number,
     *   eventsDropped: number, traceId: string|null, startedAt: number|null}}
     */
    status() {
        return {
            running: Boolean(this.initialized && this.traceId && this._enabled()),
            eventCount: this.events.length,
            duplicatesDiscarded: this.duplicatesDiscarded,
            eventsDropped: this.eventsDropped,
            traceId: this.traceId,
            startedAt: this.startedAt || null,
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

    /** Throw the trace away. The next trial event starts a fresh one, with a new id. */
    clear() {
        this._reset();
    }

    /**
     * The whole trace in a shape safe to write out and read back.
     *
     * Carries what a reader needs to trust the stream: which script produced it,
     * against which server, how many repeated ticks were dropped, whether the
     * ring trimmed anything, where the stream went quiet, and whether the first
     * event caught the fight already in progress.
     *
     * @returns {Object} Metadata plus the ordered events
     */
    buildTraceFile() {
        const host = typeof location !== 'undefined' ? location.hostname || null : null;
        // Stalls in the retained feed: one O(n) pass at export, not per-event
        // bookkeeping. A reader trusting tick cadence needs to know where the
        // stream went quiet (tab throttled, fight view closed).
        let maxGapMs = null;
        let gapsOver5s = 0;
        for (let i = 1; i < this.events.length; i++) {
            const gap = this.events[i].at - this.events[i - 1].at;
            if (maxGapMs === null || gap > maxGapMs) maxGapMs = gap;
            if (gap > 5000) gapsOver5s++;
        }
        return {
            format: TRACE_FORMAT,
            version: 1,
            traceId: this.traceId,
            toolashaVersion: scriptVersion(),
            host,
            isTestServer: host ? host.includes('test.') : null,
            recordedAt: this.startedAt || null,
            exportedAt: Date.now(),
            eventCount: this.events.length,
            duplicatesDiscarded: this.duplicatesDiscarded,
            eventsDropped: this.eventsDropped,
            maxGapMs,
            gapsOver5s,
            // The tier-opening message is the only boundary marker; a trace that
            // does not begin with one caught the fight already running
            startedMidFight: this.events.length ? this.events[0].type !== BOUNDARY_MESSAGE : null,
            events: this.events.map((event) => ({ ...event })),
        };
    }

    /**
     * The trace as NDJSON: the metadata object on the first line (without
     * `events`), then one JSON line per event — a reader can stream a large
     * file line by line rather than parsing one giant object.
     * @returns {string}
     */
    buildTraceNdjson() {
        const file = this.buildTraceFile();
        const { events, ...metadata } = file;
        const lines = [JSON.stringify(metadata)];
        for (const event of events) lines.push(JSON.stringify(event));
        return lines.join('\n') + '\n';
    }

    /**
     * Write the trace out as a file — gzipped NDJSON where the environment can
     * compress, plain NDJSON where it cannot. The buffer is kept afterwards; a
     * second press downloads the same trace again.
     * @returns {Promise<boolean>} Whether there was anything to write
     */
    async exportTrace() {
        if (!this.events.length) return false;
        try {
            const text = this.buildTraceNdjson();
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

const guildTrialTrace = new GuildTrialTrace();

export default guildTrialTrace;
export { guildTrialTrace, GuildTrialTrace };
