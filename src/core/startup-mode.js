/* global GM_registerMenuCommand */

/**
 * Startup mode - a one-shot request to load Toolasha differently on the NEXT page load.
 *
 * Two modes, both reached from the userscript manager's menu:
 *
 * - `safe`: every Toolasha feature is skipped (see entrypoint.js). Settings and data are
 *   never touched, so "Start normally" brings everything back exactly as it was.
 * - `debug`: a normal start that also keeps a startup log (init phases, per-feature init
 *   time, errors, main-thread stalls) the player can download as JSON.
 *
 * The request lives in sessionStorage and is removed the moment the entrypoint reads it, so
 * an ordinary reload afterwards is an ordinary start.
 *
 * The log carries names, timings and error messages only. It never reads game payloads,
 * character data or settings, and nothing here makes a network call.
 */

/** sessionStorage key holding the pending mode request */
export const MODE_FLAG_KEY = 'toolasha_startup_mode';

export const MODES = Object.freeze({ SAFE: 'safe', DEBUG: 'debug' });

export const MENU_LABELS = Object.freeze({
    safe: 'Toolasha: Safe start',
    debug: 'Toolasha: Reload with startup log',
    download: 'Toolasha: Download startup log',
});

const NOTICE_ID = 'toolasha-startup-mode-notice';
const MAX_ERROR_MESSAGE = 300;

/**
 * Error text with every dynamic value taken out, so a log a player shares carries no game or
 * player data: quoted strings, hrids and paths, numbers, and anything after the first colon of
 * a "label: value" message are replaced. What is left is the fixed wording of the message.
 * @param {*} text - Raw message
 * @returns {string}
 */
export function redactMessage(text) {
    return String(text ?? '')
        .slice(0, MAX_ERROR_MESSAGE)
        .replace(/(["'`]).*?\1/g, '"…"')
        .replace(/\/[\w/.-]+/g, '/…')
        .replace(/\{.*\}|\[.*\]/g, '…')
        .replace(/\d+(\.\d+)?/g, '#')
        .replace(/:\s.*$/, ': …');
}
const MAX_ENTRIES = 200;

/** Failures reported by the feature registry for this load: { key, reason } only */
let initFailures = [];

/**
 * Resolve the browser objects this module touches. Tests hand in their own.
 * @param {Object} [env] - Overrides
 * @returns {Object} Resolved environment
 */
function resolveEnv(env = {}) {
    const hasWindow = typeof window !== 'undefined';
    let storage = env.storage;
    if (storage === undefined) {
        try {
            storage = hasWindow ? window.sessionStorage : null;
        } catch {
            storage = null;
        }
    }
    return {
        storage,
        reload: env.reload || (() => window.location.reload()),
        document: env.document || (typeof document !== 'undefined' ? document : null),
        registerMenuCommand:
            env.registerMenuCommand !== undefined
                ? env.registerMenuCommand
                : typeof GM_registerMenuCommand === 'function'
                  ? GM_registerMenuCommand
                  : null,
    };
}

/**
 * Ask for the next load to start in a mode, then reload.
 * @param {string} mode - 'safe' or 'debug'
 * @param {Object} [env] - Overrides for tests
 * @returns {boolean} True if the request was stored and the reload issued
 */
export function requestMode(mode, env) {
    if (mode !== MODES.SAFE && mode !== MODES.DEBUG) return false;
    const resolved = resolveEnv(env);
    try {
        resolved.storage.setItem(MODE_FLAG_KEY, mode);
    } catch (error) {
        console.error('[StartupMode] Could not store the startup request:', error);
        return false;
    }
    resolved.reload();
    return true;
}

/**
 * Read and clear the pending request. One-shot: a second call returns null.
 * @param {Object} [env] - Overrides for tests
 * @returns {'safe'|'debug'|null} The requested mode, if any
 */
export function consumeMode(env) {
    const { storage } = resolveEnv(env);
    if (!storage) return null;
    try {
        const value = storage.getItem(MODE_FLAG_KEY);
        if (value === null) return null;
        storage.removeItem(MODE_FLAG_KEY);
        return value === MODES.SAFE || value === MODES.DEBUG ? value : null;
    } catch {
        return null;
    }
}

/**
 * Remember what the feature registry reported failing, by key and reason.
 * @param {Array<{key: string, reason: string}>} failures - The registry's failure list
 */
export function recordInitFailures(failures) {
    if (!Array.isArray(failures)) return;
    initFailures = failures.slice(0, MAX_ENTRIES).map((f) => ({
        key: String(f?.key ?? ''),
        reason: redactMessage(f?.reason),
    }));
}

/** Test seam: forget recorded failures */
export function resetInitFailures() {
    initFailures = [];
}

/** Keep only plain numbers and booleans from a mark's detail, so no payload can ride along. */
function scalarDetail(detail) {
    if (!detail || typeof detail !== 'object') return null;
    const out = {};
    for (const [key, value] of Object.entries(detail)) {
        if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) out[key] = value;
    }
    return Object.keys(out).length ? out : null;
}

const round = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 10) / 10 : null);

/**
 * Build the startup log from the performance monitor and the error log.
 * Names, timings and error messages only.
 *
 * @param {Object} sources
 * @param {string} sources.mode - The mode this load ran in
 * @param {Object} sources.performanceMonitor - Provides getMarks / getSnapshots / getStalls
 * @param {Object} [sources.errorLog] - Provides getEntries
 * @param {string} [sources.version] - Script version
 * @returns {Object} JSON-serializable log
 */
export function buildStartupLog({ mode, performanceMonitor, errorLog, version }) {
    const phases = (performanceMonitor?.getMarks?.() || []).map((m) => ({
        name: String(m.name),
        atMs: round(m.at),
        detail: scalarDetail(m.detail),
    }));

    const features = new Map();
    const timings = [];
    for (const [name, snap] of performanceMonitor?.getSnapshots?.() || []) {
        const match = /^init:(.+?)(:own)?$/.exec(name);
        if (match) {
            const entry = features.get(match[1]) || { key: match[1] };
            if (match[2]) {
                entry.ownMs = round(snap.duration);
            } else {
                entry.totalMs = round(snap.duration);
                entry.startedAtMs = round(snap.startedAt);
            }
            features.set(match[1], entry);
        } else {
            timings.push({ name, durationMs: round(snap.duration), startedAtMs: round(snap.startedAt) });
        }
    }

    const errors = (errorLog?.getEntries?.() || []).slice(0, MAX_ENTRIES).map((e) => ({
        time: e.ts ?? null,
        kind: e.kind ?? null,
        module: e.module ?? null,
        message: redactMessage(e.message),
        count: e.count ?? 1,
    }));

    const stalls = (performanceMonitor?.getStalls?.() || []).slice(-MAX_ENTRIES).map((s) => ({
        atMs: s.sinceBoot ?? null,
        durationMs: s.duration ?? null,
        suspects: (s.suspects || []).map((x) => ({ name: String(x.name), ms: x.ms })),
        recentEvents: (s.recentEvents || []).map(String),
    }));

    return {
        schema: 1,
        tool: 'Toolasha startup log',
        mode: mode || 'normal',
        scriptVersion: version || null,
        generatedAt: new Date().toISOString(),
        sinceBootMs: round(performanceMonitor?.sinceBoot?.()),
        phases,
        features: [...features.values()],
        timings,
        initFailures,
        errors,
        stalls,
    };
}

/**
 * Hand the log to the player as a JSON file download. No network involved.
 * @param {Object} log - From {@link buildStartupLog}
 * @param {Object} [env] - Overrides for tests
 * @returns {boolean} Whether a download was started
 */
export function downloadStartupLog(log, env) {
    const { document: doc } = resolveEnv(env);
    if (!doc || typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) return false;
    try {
        const url = URL.createObjectURL(new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' }));
        const a = doc.createElement('a');
        a.href = url;
        a.download = 'toolasha-startup-log.json';
        (doc.body || doc.documentElement).appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        return true;
    } catch (error) {
        console.error('[StartupMode] Could not download the startup log:', error);
        return false;
    }
}

/**
 * Register the Tampermonkey menu commands. A manager without GM_registerMenuCommand is left alone.
 * @param {Object} options
 * @param {string|null} options.mode - The mode this load is in
 * @param {Function} [options.onDownload] - Called by the download command (debug mode)
 * @param {Object} [options.env] - Overrides for tests
 * @returns {string[]} Labels registered
 */
export function registerMenuCommands({ mode, onDownload, env } = {}) {
    const resolved = resolveEnv(env);
    if (typeof resolved.registerMenuCommand !== 'function') return [];
    const registered = [];
    const add = (label, fn) => {
        try {
            resolved.registerMenuCommand(label, fn);
            registered.push(label);
        } catch (error) {
            console.error('[StartupMode] Could not register menu command:', error);
        }
    };
    add(MENU_LABELS.safe, () => requestMode(MODES.SAFE, env));
    add(MENU_LABELS.debug, () => requestMode(MODES.DEBUG, env));
    if (mode === MODES.DEBUG && onDownload) add(MENU_LABELS.download, onDownload);
    return registered;
}

/**
 * Show the small on-page notice for a non-normal mode.
 * @param {Object} options
 * @param {string} options.mode - 'safe' or 'debug'
 * @param {Function} [options.onDownload] - Download handler (debug mode)
 * @param {Object} [options.env] - Overrides for tests
 * @returns {HTMLElement|null} The notice element
 */
export function showModeNotice({ mode, onDownload, env }) {
    const { document: doc, reload } = resolveEnv(env);
    if (!doc?.documentElement || doc.getElementById(NOTICE_ID)) return null;
    const el = doc.createElement('div');
    el.id = NOTICE_ID;
    el.style.cssText =
        'position:fixed; bottom:12px; left:12px; z-index:2147483647; max-width:min(92vw,360px); padding:10px 14px; ' +
        'border-radius:8px; background:#1a1a2e; border:1px solid #4a4a6a; color:#e0e0e0; ' +
        'font:13px/1.5 system-ui,sans-serif; box-shadow:0 6px 24px rgba(0,0,0,0.5);';
    const text = doc.createElement('div');
    text.textContent =
        mode === MODES.SAFE
            ? 'Toolasha is in safe mode: all features are off. Your settings and data are untouched.'
            : 'Toolasha is recording a startup log (phases, timings, errors with their details removed). No game data is recorded.';
    el.appendChild(text);

    const button = (label, handler) => {
        const b = doc.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.style.cssText = 'margin:6px 8px 0 0; padding:3px 10px; cursor:pointer;';
        b.addEventListener('click', handler);
        el.appendChild(b);
    };
    if (mode === MODES.DEBUG && onDownload) button('Download startup log', onDownload);
    button('Start normally', () => reload());
    doc.documentElement.appendChild(el);
    return el;
}
