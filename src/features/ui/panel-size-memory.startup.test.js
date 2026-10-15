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
        expect(state.release).toBeTypeOf('function');
    });

    test('the remembered size is replayed when the read lands', async () => {
        const panel = document.querySelector('.Panel');
        panelSizeMemory.initialize();
        expect(panel.style.width).toBe('');

        state.release(SAVED);
        await vi.waitFor(() => expect(panel.style.width).toBe('420px'));
    });

    test('the unfiltered re-apply handler is registered only once there is a size to re-apply', async () => {
        // It has no class filter, so the shared observer runs it — and re-arms
        // its 250 ms debounce — for every element inserted anywhere on the page.
        // `restore()` returns on its first line while `saved` is null, so for
        // anyone who has never dragged a divider that was pure churn.
        panelSizeMemory.initialize();
        expect(domObserver.register).not.toHaveBeenCalled();

        state.release(SAVED);
        await vi.waitFor(() => expect(domObserver.register).toHaveBeenCalledTimes(1));
    });

    test('a stored null leaves the re-apply handler unregistered', async () => {
        panelSizeMemory.initialize();
        state.release(null);
        await Promise.resolve();
        await Promise.resolve();
        expect(domObserver.register).not.toHaveBeenCalled();
    });

    test('a drag registers the handler for a session that started with nothing stored', async () => {
        panelSizeMemory.initialize();
        state.release(null);
        await Promise.resolve();

        await instance.persist(SAVED);
        expect(domObserver.register).toHaveBeenCalledTimes(1);
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

describe('only a real divider drag is remembered, never a progress bar', () => {
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    const pointer = (type, x = 0, y = 0) => {
        const event = new Event(type);
        Object.assign(event, { clientX: x, clientY: y });
        document.dispatchEvent(event);
    };

    test('a click that never moves saves nothing, even when the page restyles meanwhile', async () => {
        panelSizeMemory.initialize();
        state.release(null);
        await Promise.resolve();
        pointer('pointerdown', 10, 10);
        document.querySelector('.Panel').style.width = '300px';
        await settle();
        pointer('pointerup', 10, 10);
        expect(instance.saved).toBeNull();
    });

    test('a progress bar filling during a drag is not taken for the dragged size', async () => {
        document.body.innerHTML =
            '<div id="root"><div class="ProgressBar_progressBar__x"><div class="ProgressBar_innerBar__y"></div></div></div>';
        panelSizeMemory.initialize();
        state.release(null);
        await Promise.resolve();
        pointer('pointerdown', 10, 10);
        pointer('pointermove', 40, 10);
        document.querySelector('.ProgressBar_innerBar__y').style.width = '31.7016%';
        await settle();
        pointer('pointerup', 40, 10);
        expect(instance.saved).toBeNull();
    });

    test('a real drag is still remembered', async () => {
        panelSizeMemory.initialize();
        state.release(null);
        await Promise.resolve();
        pointer('pointerdown', 10, 10);
        pointer('pointermove', 60, 10);
        document.querySelector('.Panel').style.width = '420px';
        await settle();
        pointer('pointerup', 60, 10);
        expect(instance.saved?.styles).toEqual({ width: '420px' });
    });

    test('a saved progress-bar entry from before the fix is dropped, not replayed', async () => {
        document.body.innerHTML =
            '<div id="root"><div class="ProgressBar_progressBar__x"><div class="ProgressBar_innerBar__y"></div></div></div>';
        panelSizeMemory.initialize();
        state.release({
            path: 'div:nth-of-type(1)>div:nth-of-type(1)',
            signature: 'div|ProgressBar_innerBar',
            styles: { width: '31.7016%' },
        });
        await settle();
        expect(document.querySelector('.ProgressBar_innerBar__y').style.width).toBe('');
        expect(instance.saved).toBeNull();
    });
});
