/**
 * Labyrinth WebSocket Capture (debug tool)
 *
 * Records every WebSocket message for a window of time and prints a digest, so
 * the shape of messages nobody subscribes to yet can be read off a real fight.
 * Written for one question — what does the server tell us mid-combat, and where
 * do the hitpoints live — but it assumes nothing about field names.
 *
 * An earlier version looked for keys matching /hitpoint|health|hp/. It found
 * nothing on a live fight, which says more about the guess than the traffic:
 * a name-based search can only find fields you already know the name of. This
 * version diffs consecutive payloads of each message type instead and reports
 * every number that moved. Whatever the server calls it, if it changes during
 * a fight it shows up.
 *
 * Not a feature: nothing registers it and no setting turns it on. It is driven
 * from the console:
 *
 *     Toolasha.Debug.captureLab()        // 60s, then prints
 *     Toolasha.Debug.captureLab(20)      // shorter window
 *     Toolasha.Debug.stopCapture()       // print early
 *
 * Payloads are summarized rather than dumped: init_character_data alone would
 * bury the console. The raw last message of each type is kept on the result
 * for poking at by hand.
 */

import webSocketHook from '../../core/websocket.js';

/** Recursion limit. Generous, because the whole point is not knowing the shape */
const MAX_DEPTH = 9;
/** Array entries kept per level in the shape summary; the rest is a count */
const ARRAY_SAMPLE = 3;
/** Array entries walked when diffing — more than the summary, since a fight's
 *  units may sit several entries into a list */
const ARRAY_WALK = 12;
/** Distinct leaf paths recorded per message type before the inventory stops */
const MAX_PATHS = 400;

let active = null;

/**
 * Reduce a value to its shape: deep objects truncate, long arrays sample, long
 * strings clip.
 * @param {*} value - Anything off the wire
 * @param {number} [depth=0] - Current recursion depth
 * @returns {*} A structure safe to log and read
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
 * Every leaf in a payload, as dotted paths. This is the inventory a live
 * estimate gets to choose from, whatever the fields turn out to be called.
 * @param {*} value - Payload
 * @param {Map} into - path -> sample value
 * @param {string} [path=''] - Dotted path so far
 * @param {number} [depth=0] - Current recursion depth
 */
function collectPaths(value, into, path = '', depth = 0) {
    if (into.size >= MAX_PATHS || depth >= MAX_DEPTH) return;
    if (value === null || typeof value !== 'object') {
        if (path) into.set(path, value);
        return;
    }
    const entries = Array.isArray(value)
        ? value.slice(0, ARRAY_WALK).map((v, i) => [String(i), v])
        : Object.entries(value);
    for (const [key, entry] of entries) {
        collectPaths(entry, into, path ? `${path}.${key}` : key, depth + 1);
    }
}

/**
 * Numeric leaves that differ between two payloads of the same message type.
 * Only numbers, because only a number can be a rate; a changed string is a
 * status, not a reading.
 * @param {*} before - Previous payload
 * @param {*} after - Current payload
 * @param {Array} out - Accumulator of { path, from, to }
 * @param {string} [path=''] - Dotted path so far
 * @param {number} [depth=0] - Current recursion depth
 */
function diffNumbers(before, after, out, path = '', depth = 0) {
    if (depth >= MAX_DEPTH) return;

    if (typeof after === 'number') {
        if (typeof before === 'number' && before !== after && path) out.push({ path, from: before, to: after });
        return;
    }
    if (!after || typeof after !== 'object' || !before || typeof before !== 'object') return;

    const keys = Array.isArray(after)
        ? after.slice(0, ARRAY_WALK).map((_, i) => String(i))
        : Object.keys(after).slice(0, 200);
    for (const key of keys) {
        diffNumbers(before[key], after[key], out, path ? `${path}.${key}` : key, depth + 1);
    }
}

/**
 * Start recording. Prints automatically when the window closes.
 * @param {number} [seconds=60] - How long to record
 * @returns {string} Confirmation for the console
 */
export function captureLab(seconds = 60) {
    if (active) return 'Already capturing — Toolasha.Debug.stopCapture() to finish.';

    const windowSeconds = Math.max(5, Math.min(600, Math.floor(Number(seconds) || 60)));
    const startedAt = Date.now();
    const counts = new Map();
    const shapes = new Map();
    const paths = new Map();
    const previous = new Map();
    const raw = {};
    const changed = new Map();

    const handler = (data) => {
        const type = String(data?.type || 'unknown');
        counts.set(type, (counts.get(type) || 0) + 1);
        raw[type] = data;

        if (!shapes.has(type)) shapes.set(type, summarize(data));
        if (!paths.has(type)) {
            const inventory = new Map();
            collectPaths(data, inventory);
            paths.set(type, inventory);
        }

        const before = previous.get(type);
        if (before) {
            const deltas = [];
            diffNumbers(before, data, deltas);
            for (const delta of deltas) {
                const key = `${type} → ${delta.path}`;
                const row = changed.get(key) || {
                    changes: 0,
                    first: delta.from,
                    last: delta.to,
                    min: delta.to,
                    max: delta.to,
                };
                row.changes++;
                row.last = delta.to;
                row.min = Math.min(row.min, delta.to);
                row.max = Math.max(row.max, delta.to);
                changed.set(key, row);
            }
        }
        // Structured clone so the next diff compares against a snapshot rather
        // than an object the game may have mutated underneath us
        try {
            previous.set(type, structuredClone(data));
        } catch {
            previous.set(type, JSON.parse(JSON.stringify(data)));
        }
    };

    webSocketHook.on('*', handler);
    const timer = setTimeout(() => stopCapture(), windowSeconds * 1000);
    active = { handler, timer, counts, shapes, paths, changed, raw, startedAt };

    console.log(
        `[Toolasha] Capturing WebSocket traffic for ${windowSeconds}s. Fight something now.\n` +
            'Toolasha.Debug.stopCapture() ends it early.'
    );
    return `Capturing for ${windowSeconds}s…`;
}

/**
 * Stop recording and print the digest. The full result is also parked on
 * window.__toolashaCapture for copying out.
 * @returns {Object|string} The capture result
 */
export function stopCapture() {
    if (!active) return 'Not capturing.';
    const { handler, timer, counts, shapes, paths, changed, raw, startedAt } = active;
    clearTimeout(timer);
    webSocketHook.off('*', handler);
    active = null;

    const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000);
    const messageTypes = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => ({ type, count, perSecond: +(count / elapsed).toFixed(2) }));

    const movingFields = [...changed.entries()]
        .map(([field, row]) => ({ field, ...row }))
        .sort((a, b) => b.changes - a.changes);

    const result = {
        seconds: Math.round(elapsed),
        messageTypes,
        movingFields,
        shapes: Object.fromEntries(shapes),
        paths: Object.fromEntries([...paths].map(([type, inv]) => [type, Object.fromEntries(inv)])),
        raw,
    };

    console.log(`[Toolasha] Capture done — ${Math.round(elapsed)}s, ${messageTypes.length} message types.`);
    console.table(messageTypes);

    if (movingFields.length) {
        console.log(`[Toolasha] ${movingFields.length} numeric fields changed between messages:`);
        console.table(movingFields.slice(0, 40));
    } else {
        console.log(
            '[Toolasha] Nothing numeric changed between consecutive messages. Either no fight ran, or every ' +
                'message was a fresh object with no comparable predecessor — check __toolashaCapture.paths.'
        );
    }

    console.log(
        '[Toolasha] Full result on window.__toolashaCapture.\n' +
            '  copy(__toolashaCapture.movingFields)   — the fields that moved\n' +
            "  copy(__toolashaCapture.paths['battle_updated'])  — every field in one message type\n" +
            "  __toolashaCapture.raw['battle_updated']          — the last raw payload"
    );
    window.__toolashaCapture = result;
    if (typeof unsafeWindow !== 'undefined') unsafeWindow.__toolashaCapture = result;
    return result;
}

export default { captureLab, stopCapture };
