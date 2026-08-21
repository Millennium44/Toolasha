/**
 * @vitest-environment happy-dom
 *
 * The helper frame the websocket hook borrows a native MessageEvent getter
 * from when a foreign hook breaks. Its one job is to exist for a moment and
 * lend a pristine getter; it must not become a second document that other
 * scripts get loaded into.
 */

import { describe, test, expect, vi } from 'vitest';

vi.mock('./profile-manager.js', () => ({ setCurrentProfile: vi.fn() }));
vi.mock('./storage.js', () => ({
    default: { getJSON: vi.fn(async () => []), setJSON: vi.fn(async () => {}) },
}));

const { default: webSocketHook } = await import('./websocket.js');

describe('the helper frame that lends a native getter', () => {
    test('is sandboxed scriptless and removed again whether or not the read worked', () => {
        webSocketHook.nativeDataGet = undefined;
        webSocketHook.notedForeignHookFailure = false;
        const created = [];
        const realCreate = document.createElement.bind(document);
        const spy = vi.spyOn(document, 'createElement').mockImplementation((tag) => {
            const el = realCreate(tag);
            if (tag === 'iframe') created.push(el);
            return el;
        });
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});

        webSocketHook.readDataBypassingForeignHooks({}, new Error('x'));

        expect(created).toHaveLength(1);
        // Same-origin for the cross-realm read, but no scripts: a frame that
        // runs scripts is one a userscript manager may inject into
        expect(created[0].getAttribute('sandbox')).toBe('allow-same-origin');
        expect(created[0].isConnected).toBe(false);

        spy.mockRestore();
        error.mockRestore();
        webSocketHook.nativeDataGet = undefined;
    });
});
