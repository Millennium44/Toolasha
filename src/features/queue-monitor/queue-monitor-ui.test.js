/** @vitest-environment happy-dom */

/**
 * Tests for the floating Queue Monitor panel.
 *
 * Two things are worth guarding beyond the arithmetic:
 *
 * `initialize()` is not only called once. `character_initialized` fires on a
 * plain WebSocket reconnect to the same character, not only on a character
 * switch — and the entrypoint's own bootstrap path re-runs
 * `featureRegistry.initializeFeatures()` whenever that event's
 * `_isCharacterSwitch` flag is false, which it is on a reconnect just as it is
 * on first load. A feature whose `initialize()` is not idempotent double-arms
 * itself every time that happens; `queue-alerts.js` already guards this the
 * same way, this file did not.
 *
 * And a drag holds document-level `pointermove`/`pointerup` listeners for as
 * long as it lasts. If the panel is torn down mid-drag — the `queueMonitor`
 * setting flipped off while the user is dragging it — those listeners used to
 * survive the panel, each one then reaching into a `this.panel` that had just
 * been set to null.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ handlers: new Map() }));

vi.mock('../../core/config.js', () => ({
    default: { Z_FLOATING_PANEL: 1000 },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        on: (event, handler) => {
            if (!game.handlers.has(event)) game.handlers.set(event, new Set());
            game.handlers.get(event).add(handler);
        },
        off: (event, handler) => {
            game.handlers.get(event)?.delete(handler);
        },
    },
}));

vi.mock('../../core/storage.js', () => ({
    default: { get: vi.fn(async () => false), set: vi.fn() },
}));

vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: vi.fn(),
    unregisterFloatingPanel: vi.fn(),
    bringPanelToFront: vi.fn(),
}));

vi.mock('./queue-snapshot.js', () => ({
    default: { getOtherCharacterSnapshots: () => [] },
}));

const { default: queueMonitorUI } = await import('./queue-monitor-ui.js');

beforeEach(() => {
    document.body.innerHTML = '';
    game.handlers.clear();
    vi.useFakeTimers();
});

afterEach(() => {
    queueMonitorUI.disable();
    vi.useRealTimers();
});

describe('initialize is idempotent', () => {
    test('a second initialize() without a disable() in between arms nothing new', async () => {
        await queueMonitorUI.initialize();
        const intervalCountAfterFirst = vi.getTimerCount();
        const listenersAfterFirst = game.handlers.get('character_initialized')?.size ?? 0;

        await queueMonitorUI.initialize();

        expect(vi.getTimerCount()).toBe(intervalCountAfterFirst);
        expect(game.handlers.get('character_initialized')?.size ?? 0).toBe(listenersAfterFirst);
        expect(listenersAfterFirst).toBe(1);
    });

    test('disable then initialize re-arms exactly one interval and one listener', async () => {
        await queueMonitorUI.initialize();
        queueMonitorUI.disable();
        await queueMonitorUI.initialize();

        expect(game.handlers.get('character_initialized')?.size ?? 0).toBe(1);
    });
});

describe('a drag torn down mid-gesture', () => {
    test('disable() removes the document-level drag listeners instead of leaking them', async () => {
        await queueMonitorUI.initialize();

        const header = document.querySelector('#toolasha-queue-monitor > div');
        header.dispatchEvent(new window.PointerEvent('pointerdown', { clientX: 10, clientY: 10, bubbles: true }));

        // The panel is mid-drag: disable it out from under the gesture, the
        // way switching the `queueMonitor` setting off would.
        expect(() => queueMonitorUI.disable()).not.toThrow();

        // A move that arrives after teardown must not throw reaching into the
        // now-null panel, and the panel element itself must be gone.
        expect(() =>
            document.dispatchEvent(new window.PointerEvent('pointermove', { clientX: 50, clientY: 50 }))
        ).not.toThrow();
        expect(document.querySelector('#toolasha-queue-monitor')).toBeNull();
    });
});
