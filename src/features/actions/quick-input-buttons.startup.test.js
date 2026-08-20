/** @vitest-environment happy-dom
 *
 * What `initialize()` is allowed to wait for.
 *
 * This feature was the most expensive thing in the whole of feature startup —
 * a second of wall clock, a tenth of a millisecond of it running our code —
 * and all of it was one `await storage.get('quickInput_addMode')` before the
 * observer was even registered. Features are started together now, so that read
 * no longer holds the ones behind it up, but it should not hold *this* one up
 * either: the buttons work without it and the remembered value is applied when
 * it arrives.
 *
 * The read here never resolves on its own, so anything that still awaits it
 * fails this test rather than merely being slow in it.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({
    /** Resolve the pending `storage.get` by hand */
    release: null,
    reads: 0,
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: vi.fn(() => {
            state.reads++;
            return new Promise((resolve) => {
                state.release = resolve;
            });
        }),
        set: vi.fn(),
    },
}));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: vi.fn(() => false), getSettingValue: vi.fn((_key, fallback) => fallback) },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: vi.fn(() => () => {}) } }));
vi.mock('../../core/data-manager.js', () => ({
    default: { getGameData: () => null, getCharacterData: () => null, on: vi.fn(), off: vi.fn() },
}));
vi.mock(import('../../utils/bundle-bridge.js'), async (importOriginal) => ({
    ...(await importOriginal()),
    scrollSimulator: null,
}));

const domObserver = (await import('../../core/dom-observer.js')).default;
const quickInputButtons = (await import('./quick-input-buttons.js')).default;

beforeEach(() => {
    state.release = null;
    state.reads = 0;
    vi.clearAllMocks();
    // The feature is a singleton and remembers add mode between openings, which
    // is right for a panel and wrong for a test.
    quickInputButtons.addMode = false;
    quickInputButtons._addModeTouched = false;
    quickInputButtons._addToggles.clear();
    document.body.innerHTML = '';
});

afterEach(() => {
    quickInputButtons.disable();
});

describe('initialize does not wait on storage', () => {
    test('returns with the observer already registered while the read is still in flight', async () => {
        const returned = quickInputButtons.initialize();

        expect(returned).toBeUndefined();
        expect(domObserver.onClass).toHaveBeenCalledTimes(1);
        expect(quickInputButtons.isInitialized).toBe(true);
        expect(state.reads).toBe(1);
        expect(state.release).toBeTypeOf('function');
    });

    test('add mode defaults to off until the read lands, then takes the stored value', async () => {
        quickInputButtons.initialize();
        expect(quickInputButtons.addMode).toBe(false);

        state.release(true);
        await vi.waitFor(() => expect(quickInputButtons.addMode).toBe(true));
    });

    test('a toggle drawn before the read lands is repainted when it does', async () => {
        quickInputButtons.initialize();
        const toggle = document.createElement('button');
        document.body.appendChild(toggle);
        quickInputButtons._addToggles.add(toggle);

        state.release(true);
        await vi.waitFor(() => expect(toggle.style.color).toBe('#d7b7ff'));
    });

    test('a click made before the read lands is not overwritten by it', async () => {
        // The player toggling add mode on and the stored "off" arriving a second
        // later must not fight; the click is the newer intent and wins.
        quickInputButtons.initialize();
        quickInputButtons._addModeTouched = true;
        quickInputButtons.addMode = true;

        state.release(false);
        await Promise.resolve();
        await Promise.resolve();
        expect(quickInputButtons.addMode).toBe(true);
    });

    test('a teardown while the read is in flight leaves the value alone', async () => {
        quickInputButtons.initialize();
        quickInputButtons.disable();

        state.release(true);
        await Promise.resolve();
        await Promise.resolve();
        expect(quickInputButtons.addMode).toBe(false);
    });
});
