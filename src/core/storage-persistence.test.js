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

    test('a stamp from the future does not suppress the ask forever', async () => {
        const persist = vi.fn(async () => false);
        setNavigatorStorage({ persisted: vi.fn(async () => false), persist });

        // The pre-rename key synced between devices, so the stamp on hand can
        // carry another machine's clock — a year ahead here.
        stored.set('toolasha_persistStorageAttemptedAt', Date.now() + 365 * 24 * 60 * 60 * 1000);

        await storagePersistence.requestPersistence();

        expect(persist).toHaveBeenCalledTimes(1);
        expect(stored.get('toolasha_local_persistStorageAttemptedAt')).toBeLessThanOrEqual(Date.now());
    });

    test('a stamp that is not a number at all is treated as never asked', async () => {
        const persist = vi.fn(async () => false);
        setNavigatorStorage({ persisted: vi.fn(async () => false), persist });

        stored.set('toolasha_local_persistStorageAttemptedAt', 'not a timestamp');

        await storagePersistence.requestPersistence();

        expect(persist).toHaveBeenCalledTimes(1);
        expect(stored.get('toolasha_local_persistStorageAttemptedAt')).toBeGreaterThan(0);
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

describe('hasPersistenceApi', () => {
    test('true when both persist and persisted are callable', () => {
        setNavigatorStorage({ persisted: vi.fn(), persist: vi.fn() });
        expect(storagePersistence.hasPersistenceApi()).toBe(true);
    });

    test('false when navigator.storage is entirely absent', () => {
        setNavigatorStorage(undefined);
        expect(storagePersistence.hasPersistenceApi()).toBe(false);
    });

    test('false when only one of persist/persisted exists', () => {
        setNavigatorStorage({ persist: vi.fn() });
        expect(storagePersistence.hasPersistenceApi()).toBe(false);
    });
});

describe('isPersisted', () => {
    test('reflects navigator.storage.persisted()', async () => {
        setNavigatorStorage({ persisted: vi.fn(async () => true), persist: vi.fn() });
        await expect(storagePersistence.isPersisted()).resolves.toBe(true);
    });

    test('false when the API is absent, never throws', async () => {
        setNavigatorStorage(undefined);
        await expect(storagePersistence.isPersisted()).resolves.toBe(false);
    });

    test('false when persisted() throws, never propagates', async () => {
        setNavigatorStorage({
            persisted: vi.fn(async () => {
                throw new Error('boom');
            }),
            persist: vi.fn(),
        });
        await expect(storagePersistence.isPersisted()).resolves.toBe(false);
    });
});

describe('the settings-notice dismissal flag', () => {
    test('isNoticeDismissed is false until recorded', async () => {
        await expect(storagePersistence.isNoticeDismissed()).resolves.toBe(false);
    });

    test('dismissNotice records it under the device-local key, and it reads back true', async () => {
        await storagePersistence.dismissNotice();
        expect(stored.get('toolasha_local_persistStorageNoticeDismissed')).toBe(true);
        await expect(storagePersistence.isNoticeDismissed()).resolves.toBe(true);
    });

    test('a storage failure while recording is swallowed, not propagated', async () => {
        const { default: storage } = await import('./storage.js');
        storage.set.mockImplementationOnce(async () => {
            throw new Error('boom');
        });
        await expect(storagePersistence.dismissNotice()).resolves.toBeUndefined();
    });
});
