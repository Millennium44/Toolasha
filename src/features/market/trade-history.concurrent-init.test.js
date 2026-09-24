/**
 * Two initialize() calls landing in the same tick.
 *
 * `isInitialized` was only set after the storage read
 * (`initialize()` -> `loadHistory()` -> ... -> `isInitialized = true`), so a
 * second call arriving before the first one's read resolved sailed past the
 * `isInitialized` guard too and registered its own `market_listings_updated`
 * handler. The module-scope `onSettingChange('market_tradeHistory', ...)`
 * listener calls `initialize()` on every switch-on, so an on -> off -> on
 * flip during an in-flight init produced exactly this: two listeners, one of
 * which could never be removed.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const storageMock = vi.hoisted(() => ({
    // Set to a promise to hold the history read open
    gate: null,
    stored: {},
}));

const dataManagerMock = vi.hoisted(() => ({
    characterId: 'char1',
    listeners: new Map(),
    getCurrentCharacterId: () => dataManagerMock.characterId,
    on: (event, handler) => {
        if (!dataManagerMock.listeners.has(event)) dataManagerMock.listeners.set(event, []);
        dataManagerMock.listeners.get(event).push(handler);
    },
    off: (event, handler) => {
        const list = dataManagerMock.listeners.get(event) || [];
        const at = list.indexOf(handler);
        if (at !== -1) list.splice(at, 1);
    },
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, onSettingChange: () => {}, onSettingsLoaded: () => {} },
}));
vi.mock('../../core/data-manager.js', () => ({ default: dataManagerMock }));
vi.mock('../../core/storage.js', () => ({
    default: {
        tryGet: async (key) => {
            if (storageMock.gate) await storageMock.gate;
            return { found: key in storageMock.stored, value: storageMock.stored[key] };
        },
        get: async (key) => storageMock.stored[key] ?? null,
        set: async (key, value) => {
            storageMock.stored[key] = value;
            return true;
        },
    },
}));
vi.mock('../../utils/sync-merge-registry.js', () => ({ registerSyncMerge: () => {} }));

const { default: tradeHistory } = await import('./trade-history.js');

/** @returns {Array<Function>} The live `market_listings_updated` listeners */
function marketListeners() {
    return dataManagerMock.listeners.get('market_listings_updated') || [];
}

describe('concurrent initialize() calls', () => {
    beforeEach(() => {
        storageMock.gate = null;
        storageMock.stored = {};
        dataManagerMock.characterId = 'char1';
        tradeHistory.disable();
        dataManagerMock.listeners.clear();
        tradeHistory.history = {};
        tradeHistory.isLoaded = false;
    });

    test('two initialize() calls in the same tick register the listener once', async () => {
        let release;
        storageMock.gate = new Promise((resolve) => {
            release = resolve;
        });

        const first = tradeHistory.initialize();
        const second = tradeHistory.initialize();

        release();
        storageMock.gate = null;
        await Promise.all([first, second]);

        expect(marketListeners().length).toBe(1);
        expect(tradeHistory.isInitialized).toBe(true);
    });

    test('disable() during an in-flight initialize() ends disabled', async () => {
        let release;
        storageMock.gate = new Promise((resolve) => {
            release = resolve;
        });

        const pending = tradeHistory.initialize();
        tradeHistory.disable();
        release();
        storageMock.gate = null;
        await pending;

        expect(marketListeners().length).toBe(0);
        expect(tradeHistory.isInitialized).toBe(false);

        // And a fresh initialize() afterward still works normally
        const after = tradeHistory.initialize();
        await after;
        expect(marketListeners().length).toBe(1);
        expect(tradeHistory.isInitialized).toBe(true);
    });
});
