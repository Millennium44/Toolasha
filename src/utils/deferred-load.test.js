/**
 * Tests for deferred load — reading storage that is not open yet.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('../core/storage.js', () => ({
    default: {
        ready: Promise.resolve(),
        getJSON: vi.fn(),
    },
}));

import storage from '../core/storage.js';
import { loadWhenReady } from './deferred-load.js';

describe('loadWhenReady', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        storage.ready = Promise.resolve();
    });

    test('waits on storage.ready before reading', async () => {
        let resolveReady;
        storage.ready = new Promise((resolve) => {
            resolveReady = resolve;
        });
        storage.getJSON.mockResolvedValue({ foo: 'bar' });

        const onLoaded = vi.fn();
        const promise = loadWhenReady('key', 'store', onLoaded);

        // Not yet resolved: onLoaded must not have fired
        await Promise.resolve();
        expect(onLoaded).not.toHaveBeenCalled();

        resolveReady();
        await promise;
        expect(onLoaded).toHaveBeenCalledWith({ foo: 'bar' });
    });

    test('calls onLoaded when a value is found', async () => {
        storage.getJSON.mockResolvedValue({ value: 42 });
        const onLoaded = vi.fn();

        await loadWhenReady('key', 'store', onLoaded);

        expect(storage.getJSON).toHaveBeenCalledWith('key', 'store', null);
        expect(onLoaded).toHaveBeenCalledWith({ value: 42 });
    });

    test('does not call onLoaded when nothing was saved (null)', async () => {
        storage.getJSON.mockResolvedValue(null);
        const onLoaded = vi.fn();

        await loadWhenReady('key', 'store', onLoaded);

        expect(onLoaded).not.toHaveBeenCalled();
    });

    test('does not call onLoaded when the saved value is undefined', async () => {
        storage.getJSON.mockResolvedValue(undefined);
        const onLoaded = vi.fn();

        await loadWhenReady('key', 'store', onLoaded);

        expect(onLoaded).not.toHaveBeenCalled();
    });

    test('calls onLoaded for a falsy-but-present value like 0 or empty string', async () => {
        storage.getJSON.mockResolvedValue(0);
        const onLoaded = vi.fn();
        await loadWhenReady('key', 'store', onLoaded);
        expect(onLoaded).toHaveBeenCalledWith(0);
    });

    test('swallows storage errors and does not throw', async () => {
        storage.getJSON.mockRejectedValue(new Error('db closed'));
        const onLoaded = vi.fn();

        await expect(loadWhenReady('key', 'store', onLoaded)).resolves.toBeUndefined();
        expect(onLoaded).not.toHaveBeenCalled();
    });
});
