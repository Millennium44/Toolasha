/**
 * Labyrinth WebSocket Capture (debug tool)
 *
 * Records every WebSocket message for a window of time and prints a digest, so
 * the shape of messages nobody subscribes to yet can be read off a real fight.
 * Written for one question — what does the server tell us mid-combat, and where
 * do the hitpoints live — but it is message-type agnostic.
 *
 * Not a feature: nothing registers it and no setting turns it on. It is driven
 * from the console:
 *
 *     Toolasha.Debug.captureLab()        // 60s, then prints
 *     Toolasha.Debug.captureLab(20)      // shorter window
 *     Toolasha.Debug.stopCapture()       // print early
 *
 * Payloads are summarized rather than dumped: init_character_data alone would
 * bury the console, and the interesting part is the shape, not the contents.
 */

import webSocketHook from '../../core/websocket.js';

/** Recursion limit for the shape summary — deep enough for unit.combatDetails.x */
const MAX_DEPTH = 5;
/** Array entries kept per level; the rest is a count */
const ARRAY_SAMPLE = 3;
/** Full samples retained per message type */
const SAMPLES_PER_TYPE = 2;
/** Keys worth calling out — the fields a live clear chance would need */
const VITAL_KEY = /hitpoint|manapoint|\bhp\b|\bmp\b|currentHealth|health|damage|entryCount|isDead/i;

let active = null;

/**
 * Reduce a value to its shape: deep objects truncate, long arrays sample, long
 * strings clip. Numbers and booleans pass through, since those are the ones
 * worth reading.
 * @param {*} value - Anything off the wire
 * @param {number} [depth=0] - Current recursion depth
 * @returns {*} A structure safe to JSON.stringify and read
 */
function summarize(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 120)}…` : value;
    if (typeof value !== 'object') return value;
    if (depth >= MAX_DEPTH) return Array.isArray(value) ? `[${value.length} items]` : '{…}';

    if (Array.isArray(value)) {
        const head = value.slice(0, ARRAY_SAMPLE).map((entry) => summarize(entry, depth + 1));
        return value.length > ARRAY_SAMPLE ? [...head, `…${value.length - ARRAY_SAMPLE} more`] : head;
    }

    const out = {};
    for (const [key, entry] of Object.entries(value)) {
        out[key] = summarize(entry, depth + 1);
    }
    return out;
}

/**
 * Walk a payload for the fields a live estimate would read, so they can be
 * found without eyeballing the whole shape.
 * @param {*} value - Payload
 * @param {string} [path=''] - Dotted path accumulated so far
 * @param {number} [depth=0] - Current recursion depth
 * @returns {Array<{path: string, value: *}>}
 */
function findVitals(value, path = '', depth = 0) {
    if (!value || typeof value !== 'object' || depth >= MAX_DEPTH) return [];
    const found = [];
    const entries = Array.isArray(value)
        ? value.slice(0, ARRAY_SAMPLE).map((v, i) => [String(i), v])
        : Object.entries(value);

    for (const [key, entry] of entries) {
        const here = path ? `${path}.${key}` : key;
        if (VITAL_KEY.test(key) && (typeof entry === 'number' || typeof entry === 'boolean')) {
            found.push({ path: here, value: entry });
        } else if (entry && typeof entry === 'object') {
            found.push(...findVitals(entry, here, depth + 1));
        }
    }
    return found;
}

/**
 * Start recording. Prints automatically when the window closes.
 * @param {number} [seconds=60] - How long to record
 * @returns {string} Confirmation for the console
 */
export function captureLab(seconds = 60) {
    if (active) return 'Already capturing — Toolasha.Debug.stopCapture() to finish.';

    const window_ = Math.max(5, Math.min(600, Math.floor(Number(seconds) || 60)));
    const startedAt = Date.now();
    const counts = new Map();
    const samples = new Map();
    const vitals = new Map();

    const handler = (data) => {
        const type = String(data?.type || 'unknown');
        counts.set(type, (counts.get(type) || 0) + 1);

        const seen = samples.get(type) || [];
        if (seen.length < SAMPLES_PER_TYPE) {
            seen.push({ atMs: Date.now() - startedAt, payload: summarize(data) });
            samples.set(type, seen);
        }

        // Vitals are collected every message, not just sampled ones: what
        // matters is which fields move during a fight, and one sample per type
        // cannot show movement
        for (const hit of findVitals(data)) {
            const key = `${type} → ${hit.path}`;
            const series = vitals.get(key) || [];
            if (series.length < 40) series.push(hit.value);
            vitals.set(key, series);
        }
    };

    webSocketHook.on('*', handler);
    const timer = setTimeout(() => stopCapture(), window_ * 1000);
    active = { handler, timer, counts, samples, vitals, startedAt, window: window_ };

    console.log(
        `[Toolasha] Capturing WebSocket traffic for ${window_}s. Enter a labyrinth combat room now.\n` +
            'Toolasha.Debug.stopCapture() ends it early.'
    );
    return `Capturing for ${window_}s…`;
}

/**
 * Stop recording and print the digest. The full result is also parked on
 * window.__toolashaCapture for copying out.
 * @returns {Object|string} The capture result
 */
export function stopCapture() {
    if (!active) return 'Not capturing.';
    const { handler, timer, counts, samples, vitals, startedAt } = active;
    clearTimeout(timer);
    webSocketHook.off('*', handler);
    active = null;

    const elapsed = (Date.now() - startedAt) / 1000;
    const byFrequency = [...counts.entries()].sort((a, b) => b[1] - a[1]);

    // A field that never changes is a constant, not a reading — only moving
    // ones can drive a live estimate
    const moving = [...vitals.entries()]
        .map(([key, series]) => ({
            field: key,
            samples: series.length,
            distinct: new Set(series).size,
            first: series[0],
            last: series[series.length - 1],
        }))
        .filter((row) => row.distinct > 1)
        .sort((a, b) => b.distinct - a.distinct);

    const result = {
        seconds: Math.round(elapsed),
        messageTypes: byFrequency.map(([type, count]) => ({ type, count, perSecond: +(count / elapsed).toFixed(2) })),
        movingFields: moving,
        samples: Object.fromEntries(samples),
    };

    console.log(`[Toolasha] Capture done — ${Math.round(elapsed)}s, ${byFrequency.length} message types.`);
    console.table(result.messageTypes);
    if (moving.length) {
        console.log('[Toolasha] Fields that changed during the capture:');
        console.table(moving);
    } else {
        console.log(
            '[Toolasha] No hitpoint-like field changed — either no fight ran, or the server does not push one.'
        );
    }
    console.log('[Toolasha] Full result on window.__toolashaCapture — copy(__toolashaCapture) to the clipboard.');
    window.__toolashaCapture = result;
    if (typeof unsafeWindow !== 'undefined') unsafeWindow.__toolashaCapture = result;
    return result;
}

export default { captureLab, stopCapture };
