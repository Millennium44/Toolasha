/**
 * Error log — a ring buffer of what went wrong in this script, for the
 * Diagnostics section of the settings panel.
 *
 * Every module here reports failure the same way: `console.error('[Module] …')`.
 * That is the right place for the detail, and the wrong place for a player to
 * find it — nobody opens devtools to learn whether a panel stopped drawing.
 * This module listens in and keeps the last couple of hundred of them, so the
 * settings panel can show "3 errors, the newest from [MarketTooltips]" without
 * anybody hunting through the console.
 *
 * Three sources, one filter: only what is ours.
 *
 * - `console.error` calls whose first argument starts with a `[Module]` prefix.
 *   The game and the browser log plenty of their own errors; the prefix is the
 *   convention that separates ours from theirs.
 * - `window` `error` events whose filename or stack points at this script's
 *   code — the dev loader serves `Toolasha-dev.user.js` from a localhost port,
 *   the production `@require` bundles are `toolasha-*.js`; either way the path
 *   names the script.
 * - `unhandledrejection` events whose reason's stack points at the script, or
 *   whose message carries a `[Module]` prefix.
 *
 * Everything else is ignored, including the game's own errors and the Chrome
 * extension "message channel closed" noise that every page on the internet
 * sees. Consecutive identical messages collapse into one entry with a count,
 * so a feature failing on every mutation does not flush the rest of the log
 * out of the buffer.
 *
 * Never throws and never recurses: a logging hook that can itself fail is a
 * second bug on top of the first, so every path here is wrapped and the
 * wrapper refuses to re-enter itself.
 */

/** How many entries the buffer keeps before the oldest falls off */
export const ERROR_LOG_CAP = 200;

const MAX_MESSAGE_LENGTH = 500;
const MAX_STACK_LINES = 12;
const MAX_STACK_LENGTH = 2000;

/** `[ModuleName] …` — the convention every module's error logs follow */
const MODULE_PREFIX = /^\[([^\]\n]{1,60})\]/;

/** Something in a filename or stack that names this script's code */
const OUR_CODE = /toolasha/i;

/** @type {Array<{ts: number, kind: string, module: string|null, message: string, stack: string, count: number}>} */
const entries = [];

/** @type {Set<Function>} */
const listeners = new Set();

let installed = false;
let originalConsoleError = null;
let wrappedConsole = null;
let wrappedTarget = null;
let inCapture = false;

/**
 * The `[Module]` prefix of a message, or null when it has none.
 * @param {string} message - The text to look at
 * @returns {string|null} The module name
 */
export function moduleFromMessage(message) {
    const match = MODULE_PREFIX.exec(typeof message === 'string' ? message : '');
    return match ? match[1].trim() : null;
}

/**
 * One console argument as text.
 * @param {*} value - The argument
 * @returns {string} Its text
 */
function textOf(value) {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return String(value);
    try {
        return typeof value === 'object' ? JSON.stringify(value) : String(value);
    } catch {
        return Object.prototype.toString.call(value);
    }
}

/**
 * A stack worth keeping: the first dozen lines, trimmed, and no longer than
 * a couple of thousand characters.
 * @param {*} stack - Whatever the error carried
 * @returns {string} The trimmed stack, or ''
 */
function trimStack(stack) {
    if (typeof stack !== 'string' || !stack) return '';
    const lines = stack
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(0, MAX_STACK_LINES);
    return lines.join('\n').slice(0, MAX_STACK_LENGTH);
}

/**
 * Tell the subscribers something changed. A listener that throws is dropped
 * from the notification, not allowed to break the capture.
 */
function notify() {
    for (const listener of [...listeners]) {
        try {
            listener(getEntries());
        } catch {
            /* a listener's failure is its own business */
        }
    }
}

/**
 * Record one failure, collapsing it into the newest entry when it repeats.
 * @param {'console'|'error'|'rejection'} kind - Where it came from
 * @param {string|null} module - The `[Module]` prefix, if any
 * @param {string} message - What happened
 * @param {string} stack - Where, if known
 */
function record(kind, module, message, stack) {
    const text = String(message || '(no message)').slice(0, MAX_MESSAGE_LENGTH);
    const newest = entries[entries.length - 1];
    if (newest && newest.kind === kind && newest.module === module && newest.message === text) {
        newest.count += 1;
        newest.ts = Date.now();
        if (!newest.stack && stack) newest.stack = stack;
    } else {
        entries.push({ ts: Date.now(), kind, module, message: text, stack: stack || '', count: 1 });
        while (entries.length > ERROR_LOG_CAP) entries.shift();
    }
    notify();
}

/**
 * Run a capture path under the re-entrancy guard. Anything the capture does
 * that itself logs an error (or throws) lands here again and is turned away.
 * @param {Function} fn - The capture
 */
function guarded(fn) {
    if (inCapture) return;
    inCapture = true;
    try {
        fn();
    } catch {
        /* never let the log be a second failure */
    } finally {
        inCapture = false;
    }
}

/**
 * Inspect one `console.error` call.
 * @param {Array} args - The call's arguments
 */
function captureConsole(args) {
    const first = args[0];
    const module = moduleFromMessage(first);
    if (!module) return;
    const parts = [];
    let stack = '';
    for (const arg of args) {
        parts.push(textOf(arg));
        if (!stack && arg instanceof Error) stack = trimStack(arg.stack);
    }
    record('console', module, parts.join(' '), stack);
}

/**
 * Inspect one window `error` event.
 * @param {ErrorEvent} event - The event
 */
function captureErrorEvent(event) {
    const error = event?.error;
    const message = (error && error.message) || event?.message || '';
    const stack = trimStack(error?.stack);
    const filename = event?.filename || '';
    const module = moduleFromMessage(message);
    if (!module && !OUR_CODE.test(filename) && !OUR_CODE.test(stack)) return;
    const text = error ? `${error.name || 'Error'}: ${message}` : message;
    record('error', module, text, stack);
}

/**
 * Inspect one `unhandledrejection` event.
 * @param {PromiseRejectionEvent} event - The event
 */
function captureRejection(event) {
    const reason = event?.reason;
    const message = reason instanceof Error ? reason.message : textOf(reason);
    const stack = trimStack(reason?.stack);
    const module = moduleFromMessage(message);
    if (!module && !OUR_CODE.test(stack)) return;
    const text = reason instanceof Error ? `${reason.name || 'Error'}: ${message}` : message;
    record('rejection', module, text, stack);
}

const onError = (event) => guarded(() => captureErrorEvent(event));
const onRejection = (event) => guarded(() => captureRejection(event));

/**
 * Start listening. Wraps `console.error` once (the original is always called
 * through, first, so nothing changes for the console) and attaches the two
 * window listeners. Calling it twice is a no-op.
 *
 * @param {Object} [options] - For tests
 * @param {Object} [options.console] - The console to wrap (default: the global)
 * @param {EventTarget} [options.target] - Where error events fire (default: window)
 * @returns {boolean} True if it installed now, false if it already was
 */
export function install({ console: con, target } = {}) {
    if (installed) return false;
    try {
        const consoleObject = con || (typeof console !== 'undefined' ? console : null);
        const eventTarget = target || (typeof window !== 'undefined' ? window : null);

        if (consoleObject && typeof consoleObject.error === 'function') {
            originalConsoleError = consoleObject.error;
            wrappedConsole = consoleObject;
            const original = originalConsoleError;
            consoleObject.error = function toolashaConsoleError(...args) {
                try {
                    original.apply(this, args);
                } finally {
                    guarded(() => captureConsole(args));
                }
            };
        }

        if (eventTarget && typeof eventTarget.addEventListener === 'function') {
            wrappedTarget = eventTarget;
            eventTarget.addEventListener('error', onError);
            eventTarget.addEventListener('unhandledrejection', onRejection);
        }

        installed = true;
        return true;
    } catch {
        return false;
    }
}

/**
 * Stop listening and put `console.error` back. Entries already captured stay.
 * @returns {void}
 */
export function uninstall() {
    if (!installed) return;
    try {
        if (wrappedConsole && originalConsoleError) wrappedConsole.error = originalConsoleError;
        if (wrappedTarget) {
            wrappedTarget.removeEventListener('error', onError);
            wrappedTarget.removeEventListener('unhandledrejection', onRejection);
        }
    } catch {
        /* best effort */
    } finally {
        originalConsoleError = null;
        wrappedConsole = null;
        wrappedTarget = null;
        installed = false;
    }
}

/**
 * Whether the hooks are in place.
 * @returns {boolean} True while installed
 */
export function isInstalled() {
    return installed;
}

/**
 * The captured entries, newest first. Copies — callers may not reach in.
 * @returns {Array<{ts: number, kind: string, module: string|null, message: string, stack: string, count: number}>}
 */
export function getEntries() {
    return entries.map((entry) => ({ ...entry })).reverse();
}

/**
 * Forget everything captured so far.
 * @returns {void}
 */
export function clear() {
    entries.length = 0;
    notify();
}

/**
 * Be told whenever the log changes. The listener gets the entries, newest
 * first.
 * @param {Function} fn - The listener
 * @returns {Function} Unsubscribe
 */
export function subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
}

export default { install, uninstall, isInstalled, getEntries, clear, subscribe, moduleFromMessage, ERROR_LOG_CAP };
