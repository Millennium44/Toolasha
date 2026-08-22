/** @vitest-environment happy-dom
 *
 * What `initialize()` is allowed to wait for.
 *
 * Reading the remembered panel size took a third of a second, and it was read
 * before a single listener was attached — so the watchers this feature exists
 * for were not watching yet, and (features being awaited one after another)
 * neither was anything registered behind it. The read stays; waiting for it
 * does not. `restore()` is a no-op until the value lands, and replays it when
 * it does.
 *
 * The mocked read never resolves on its own, so an `initialize()` that still
 * waits for it fails here rather than merely being slow.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({ release: null }));

vi.mock('../../core/config.js', () => ({ default: { getSetting: vi.fn(() => true) } }));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: vi.fn(
            () =>
                new Promise((resolve) => {
                    state.release = resolve;
                })
        ),
        set: vi.fn(),
    },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { register: vi.fn(() => () => {}) } }));

/** A stored entry pointing at the single div under #root in the fixture below */
const SAVED = { path: 'div:nth-of-type(1)', signature: 'div|Panel', styles: { width: '420px' } };

const domObserver = (await import('../../core/dom-observer.js')).default;
const panelSizeMemoryModule = await import('./panel-size-memory.js');
const panelSizeMemory = panelSizeMemoryModule.default;
const instance = panelSizeMemoryModule._instance;

beforeEach(() => {
    state.release = null;
    vi.clearAllMocks();
    document.body.innerHTML = '<div id="root"><div class="Panel"></div></div>';
});

afterEach(() => {
    panelSizeMemory.cleanup();
});

describe('initialize does not wait on storage', () => {
    test('the watchers are in place while the read is still in flight', () => {
        const returned = panelSizeMemory.initialize();

        expect(returned).toBeUndefined();
        expect(domObserver.register).toHaveBeenCalledTimes(1);
        expect(state.release).toBeTypeOf('function');
    });

    test('the remembered size is replayed when the read lands', async () => {
        const panel = document.querySelector('.Panel');
        panelSizeMemory.initialize();
        expect(panel.style.width).toBe('');

        state.release(SAVED);
        await vi.waitFor(() => expect(panel.style.width).toBe('420px'));
    });

    test('a teardown while the read is in flight restores nothing', async () => {
        const panel = document.querySelector('.Panel');
        panelSizeMemory.initialize();
        panelSizeMemory.cleanup();

        state.release(SAVED);
        await Promise.resolve();
        await Promise.resolve();
        expect(panel.style.width).toBe('');
    });
});

describe('the inline-style observer only runs during a drag', () => {
    test('no observer is attached before pointerdown, and it is released on pointerup', () => {
        panelSizeMemory.initialize();
        expect(instance.observer).toBeNull();

        document.dispatchEvent(new Event('pointerdown'));
        expect(instance.observer).toBeInstanceOf(MutationObserver);

        document.dispatchEvent(new Event('pointerup'));
        expect(instance.observer).toBeNull();
    });
});
