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
    settingChange: null,
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: vi.fn(() => true),
        onSettingChange: vi.fn((_key, callback) => {
            handlers.settingChange = callback;
        }),
    },
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
const { default: dataManager } = await import('../../core/data-manager.js');
const { default: domObserver } = await import('../../core/dom-observer.js');

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

    // config.js's setSetting() calls _notifySettingChange() unconditionally on every
    // call, whether or not the stored value actually changed (there is no
    // old-value-vs-new-value guard in setSetting/setSettingValue) — so a settings
    // resave, an import, or any code path that sets 'actionPanel_liveCountdown' to
    // true while it is already true delivers a second "enabled" notification with
    // no "disabled" in between.
    test('a redundant "enabled" notification does not double-register listeners', () => {
        mountBar();
        actionCountdown.initialize();

        const onCallsAfterInit = dataManager.on.mock.calls.length;
        const onClassCallsAfterInit = domObserver.onClass.mock.calls.length;
        const onReadyCallsAfterInit = domObserver.onReady.mock.calls.length;

        // The settings UI (or an import/reset flow) re-applies "enabled" without the
        // value having actually flipped through "disabled" first.
        handlers.settingChange(true);

        // The handler force-clears `this.initialized` before calling `initialize()`
        // again, bypassing initialize()'s own `if (this.isInitialized) return;`-style
        // guard (which action-time-display.js's equivalent handler relies on instead
        // of resetting the flag). That re-runs every registration a second time: a
        // second 'action_completed' listener that disable() can no longer remove
        // (this.actionCompletedHandler is overwritten, orphaning the first one), and
        // a leaked domObserver registration whose unregister handle is discarded.
        expect(dataManager.on.mock.calls.length).toBe(onCallsAfterInit);
        expect(domObserver.onClass.mock.calls.length).toBe(onClassCallsAfterInit);
        expect(domObserver.onReady.mock.calls.length).toBe(onReadyCallsAfterInit);
    });
});

/**
 * A bar with an animated inner bar, whose computed style reports whatever the
 * test wants `transform` and `--duration` to say. The real DOM shape is
 * progressBar > (innerBarContainer > innerBar, text), which is what
 * `_findFillBar` walks.
 *
 * @param {{text: string, scaleX: number, duration: string|number}} options - Bar state
 * @returns {HTMLElement} The progress-bar text element
 */
function mountAnimatedBar({ text, scaleX, duration }) {
    document.body.innerHTML =
        '<div class="ProgressBar_progressBar__abc">' +
        '<div class="ProgressBar_innerBarContainer__def"><div class="ProgressBar_innerBar__ghi"></div></div>' +
        `<div class="ProgressBar_text__jkl"><span>${text}</span></div>` +
        '</div>';

    vi.stubGlobal('getComputedStyle', (el) => ({
        transform: `matrix(${scaleX}, 0, 0, 1, 0, 0)`,
        getPropertyValue: () => (el.className.includes('progressBar') ? String(duration) : ''),
    }));

    return document.querySelector('[class*="ProgressBar_text"]');
}

describe('trusting the animation', () => {
    test("a --duration that agrees with the bar's text drives the readout", () => {
        mountAnimatedBar({ text: '8.5s', scaleX: 0.5, duration: 8.51764572272224 });
        actionCountdown.initialize();

        const span = document.querySelector('[class*="ProgressBar_text"] span');
        expect(span.textContent).toBe('4.3s / 8.5s');
        expect(actionCountdown.totalTime).toBeCloseTo(8.51764572272224, 6);
    });

    // The reported bug: the bar animates a three-second action, finishes, and
    // `fill: forwards` parks it at full for the twenty-five seconds the server
    // is still working. Believing `--duration` there printed "0.0s / 3.0s" for
    // the whole of it.
    test('a --duration that disagrees is refused, and the wall clock answers instead', () => {
        mountAnimatedBar({ text: '28.0s', scaleX: 1, duration: 3 });
        actionCountdown.initialize();

        actionCountdown.lastCompletedAt = Date.now() - 5000;
        actionCountdown._tick();

        const span = document.querySelector('[class*="ProgressBar_text"] span');
        expect(span.textContent).toBe('23.0s / 28.0s');
        expect(actionCountdown.totalTime).toBe(28);
    });

    test.each([['NaN'], ['0'], ['-4'], ['99999'], ['']])('a --duration of %s is rejected outright', (duration) => {
        mountAnimatedBar({ text: '28.0s', scaleX: 0.9, duration });
        actionCountdown.initialize();

        actionCountdown.lastCompletedAt = Date.now() - 5000;
        actionCountdown._tick();

        const span = document.querySelector('[class*="ProgressBar_text"] span');
        expect(span.textContent).toBe('23.0s / 28.0s');
        expect(actionCountdown.cachedDuration).toBeNull();
    });

    test('display rounding on its own is not a disagreement', () => {
        mountAnimatedBar({ text: '8.5s', scaleX: 0, duration: 8.549 });
        actionCountdown.initialize();
        expect(actionCountdown._durationTrusted(8.549)).toBe(true);
        expect(actionCountdown._durationTrusted(3)).toBe(false);
    });

    // Our own readout is "3.2s / 8.5s"; re-parsing it took the time REMAINING
    // for the total, and only `--duration` overwriting it hid the damage.
    test("our own composite readout is never mistaken for the game's total", () => {
        const textEl = mountAnimatedBar({ text: '28.0s', scaleX: 1, duration: 3 });
        actionCountdown.initialize();
        expect(actionCountdown.textTotalTime).toBe(28);

        textEl.querySelector('span').textContent = '4.0s / 28.0s';
        actionCountdown._parseTotalTime();
        expect(actionCountdown.textTotalTime).toBe(28);
    });
});
