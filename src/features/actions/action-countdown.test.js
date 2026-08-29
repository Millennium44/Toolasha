/** @vitest-environment happy-dom
 *
 * The countdown's tick loop only runs while there is a progress bar to drive,
 * and it wakes on a tenth-of-a-second interval rather than on every frame.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const handlers = vi.hoisted(() => ({
    classCallback: null,
    readyCallback: null,
    domReady: true,
    actionCompleted: null,
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: vi.fn(() => true), onSettingChange: vi.fn() },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: vi.fn((_name, _cls, callback) => {
            handlers.classCallback = callback;
            return () => {};
        }),
        // Mirrors the real DOMObserver.onReady: immediate when already attached (the default),
        // deferred until the readiness-gap test fires it by hand otherwise.
        onReady: vi.fn((_name, callback) => {
            handlers.readyCallback = callback;
            if (handlers.domReady) callback();
            return () => {};
        }),
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        on: vi.fn((_event, handler) => {
            handlers.actionCompleted = handler;
        }),
        off: vi.fn(),
    },
}));

const actionCountdown = (await import('./action-countdown.js')).default;

/** @returns {HTMLElement} A progress-bar text element attached to the document */
function mountBar() {
    document.body.innerHTML =
        '<div class="ProgressBar_progressBar"><div class="ProgressBar_text"><span>5.0s</span></div></div>';
    return document.querySelector('.ProgressBar_text');
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', vi.fn());
    handlers.domReady = true;
    handlers.readyCallback = null;
});

afterEach(() => {
    actionCountdown.disable();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('tick loop lifetime', () => {
    test('the loop ends when the bar leaves the DOM and restarts when a new one is seen', () => {
        const bar = mountBar();
        actionCountdown.initialize();
        expect(actionCountdown.timerId).not.toBeNull();

        bar.remove();
        vi.advanceTimersByTime(200);
        expect(actionCountdown.timerId).toBeNull();

        const next = mountBar();
        handlers.classCallback(next);
        expect(actionCountdown.timerId).not.toBeNull();
    });

    test('the countdown never asks for an animation frame', () => {
        mountBar();
        actionCountdown.initialize();
        vi.advanceTimersByTime(1000);
        expect(requestAnimationFrame).not.toHaveBeenCalled();
    });

    test('a completed action drops the cached --duration', () => {
        mountBar();
        actionCountdown.initialize();
        actionCountdown.cachedDuration = 12;
        handlers.actionCompleted();
        expect(actionCountdown.cachedDuration).toBeNull();
    });

    test('a hidden tab is not repainted, and coming back is', () => {
        const bar = mountBar();
        actionCountdown.initialize();
        actionCountdown.totalTime = 5;
        actionCountdown.lastCompletedAt = Date.now();
        const span = bar.querySelector('span');
        span.textContent = 'untouched';

        const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
        vi.advanceTimersByTime(1000);
        expect(span.textContent).toBe('untouched');

        hidden.mockReturnValue(false);
        vi.advanceTimersByTime(200);
        expect(span.textContent).toMatch(/s \/ 5\.0s$/);
        hidden.mockRestore();
    });

    test('a bar mounted before the shared observer is ready is picked up at readiness', () => {
        handlers.domReady = false;
        mountBar();
        actionCountdown.initialize();
        expect(actionCountdown.timerId).toBeNull();

        handlers.readyCallback();
        expect(actionCountdown.timerId).not.toBeNull();
    });
});
