/**
 * Tests for storage-persistence.js — the navigator.storage.persist() request.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const stored = new Map();

vi.mock('./storage.js', () => ({
    default: {
        get: vi.fn(async (key, _area, defaultValue) => (stored.has(key) ? stored.get(key) : defaultValue)),
        set: vi.fn(async (key, value) => {
            stored.set(key, value);
        }),
        delete: vi.fn(async (key) => {
            stored.delete(key);
        }),
    },
}));

const { default: storagePersistence } = await import('./storage-persistence.js');

let originalNavigatorDescriptor;

beforeEach(() => {
    stored.clear();
    originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
});

afterEach(() => {
    if (originalNavigatorDescriptor) {
        Object.defineProperty(globalThis, 'navigator', originalNavigatorDescriptor);
    }
    vi.restoreAllMocks();
});

function setNavigatorStorage(storageApi) {
    Object.defineProperty(globalThis, 'navigator', {
        value: storageApi === undefined ? {} : { storage: storageApi },
        configurable: true,
        writable: true,
    });
}

describe('requestPersistence', () => {
    test('does nothing when navigator.storage is entirely absent — never throws', async () => {
        setNavigatorStorage(undefined);
        await expect(storagePersistence.requestPersistence()).resolves.toBeUndefined();
    });

    test('does nothing when persist/persisted are missing from navigator.storage', async () => {
        setNavigatorStorage({});
        await expect(storagePersistence.requestPersistence()).resolves.toBeUndefined();
    });

    test('does not call persist() when already persisted', async () => {
        const persist = vi.fn();
        setNavigatorStorage({ persisted: vi.fn(async () => true), persist });
        await storagePersistence.requestPersistence();
        expect(persist).not.toHaveBeenCalled();
    });

    test('calls persist() and records the attempt when not persisted and never asked before', async () => {
        const persist = vi.fn(async () => true);
        setNavigatorStorage({ persisted: vi.fn(async () => false), persist });
        await storagePersistence.requestPersistence();
        expect(persist).toHaveBeenCalledTimes(1);
        expect(stored.get('toolasha_local_persistStorageAttemptedAt')).toBeGreaterThan(0);
    });

    test('does not re-ask within the retry interval after a refusal', async () => {
        const persist = vi.fn(async () => false);
        setNavigatorStorage({ persisted: vi.fn(async () => false), persist });

        await storagePersistence.requestPersistence();
        expect(persist).toHaveBeenCalledTimes(1);

        await storagePersistence.requestPersistence();
        expect(persist).toHaveBeenCalledTimes(1); // Still 1 — not re-asked
    });

    test('does re-ask once the retry interval has elapsed', async () => {
        const persist = vi.fn(async () => false);
        setNavigatorStorage({ persisted: vi.fn(async () => false), persist });

        await storagePersistence.requestPersistence();
        expect(persist).toHaveBeenCalledTimes(1);

        // Simulate the attempt flag being a day old
        stored.set('toolasha_local_persistStorageAttemptedAt', Date.now() - 25 * 60 * 60 * 1000);

        await storagePersistence.requestPersistence();
        expect(persist).toHaveBeenCalledTimes(2);
    });

    test('honours an existing pre-rename stamp instead of re-asking on upgrade', async () => {
        const persist = vi.fn(async () => false);
        setNavigatorStorage({ persisted: vi.fn(async () => false), persist });

        // A device from before the rename: only the legacy key has ever been
        // written, and it is recent.
        stored.set('toolasha_persistStorageAttemptedAt', Date.now());

        await storagePersistence.requestPersistence();

        // Honoured, not ignored: the recent legacy stamp still suppresses the ask.
        expect(persist).not.toHaveBeenCalled();
    });

    test('migrates a pre-rename stamp onto the renamed key and removes the old one', async () => {
        const persist = vi.fn(async () => false);
        setNavigatorStorage({ persisted: vi.fn(async () => false), persist });

        const legacyTimestamp = Date.now() - 25 * 60 * 60 * 1000; // stale, so this also re-asks
        stored.set('toolasha_persistStorageAttemptedAt', legacyTimestamp);

        await storagePersistence.requestPersistence();

        expect(persist).toHaveBeenCalledTimes(1);
        expect(stored.has('toolasha_persistStorageAttemptedAt')).toBe(false);
        expect(stored.get('toolasha_local_persistStorageAttemptedAt')).toBeGreaterThan(legacyTimestamp);
    });

    test('a thrown error from persist() is swallowed, not propagated', async () => {
        setNavigatorStorage({
            persisted: vi.fn(async () => false),
            persist: vi.fn(async () => {
                throw new Error('boom');
            }),
        });
        await expect(storagePersistence.requestPersistence()).resolves.toBeUndefined();
    });

    test('a thrown error from persisted() is swallowed, not propagated', async () => {
        setNavigatorStorage({
            persisted: vi.fn(async () => {
                throw new Error('boom');
            }),
            persist: vi.fn(),
        });
        await expect(storagePersistence.requestPersistence()).resolves.toBeUndefined();
    });
});
