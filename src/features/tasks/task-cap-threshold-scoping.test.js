/**
 * @vitest-environment happy-dom
 *
 * Who the shield popup's cap thresholds belong to.
 *
 * The three cap settings are written per character, but they were once written
 * bare, and the bare key used to be a permanent fallback that was never
 * deleted. On an account that predates scoping, that meant every alt which
 * never opened the shield config silently ran on the main's thresholds — a
 * 40k-coin cap set on the market character quietly blocking rerolls on a
 * character that never asked for it.
 *
 * They now read through the same adopt-once migration as the rest of the
 * pre-scoping data: the character the user confirmed claims the bare value and
 * the bare key goes; everyone else falls to the defaults and leaves it alone.
 * The read is still one batched transaction, so these tests also pin that the
 * batch is what the values come from.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const settings = vi.hoisted(() => ({ values: {} }));
const stored = vi.hoisted(() => ({ values: {} }));
const batches = vi.hoisted(() => ({ calls: [] }));
const consent = vi.hoisted(() => ({ target: null }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => settings.values[key] ?? false,
        getSettingValue: (key, fallback) => settings.values[key] ?? fallback,
        isFeatureEnabled: (key) => settings.values[key] ?? false,
        onSettingChange: () => {},
        COLOR_TEXT_SECONDARY: '#888',
        COLOR_ACCENT: '#0f0',
    },
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback = null) => stored.values[key] ?? fallback,
        set: async (key, value) => {
            stored.values[key] = value;
            return true;
        },
        getJSON: async (key, _store, fallback) => stored.values[key] ?? fallback,
        setJSON: async () => {},
        delete: async (key) => {
            delete stored.values[key];
            return true;
        },
        getMany: async (keys) => {
            batches.calls.push(keys);
            return new Map(keys.map((key) => [key, stored.values[key] ?? null]));
        },
        getAllKeys: async () => Object.keys(stored.values),
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'alt99',
        getCurrentCharacterGameMode: () => 'standard',
        getCurrentCharacterName: () => 'Alt',
        characterData: null,
        getInitClientData: () => null,
        on: () => {},
        off: () => {},
    },
}));

vi.mock('../../core/websocket.js', () => ({
    default: { on: () => {}, off: () => {}, onSocketEvent: () => {}, offSocketEvent: () => {} },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: () => () => {},
        onReady: () => () => {},
    },
}));

// The dialog is the consent module's business; here the answer is just set.
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => consent.target,
    requestAdoptionConsent: async () => null,
}));

const { default: taskRerollProtectionFeature } = await import('./task-reroll-protection.js');
const protection = taskRerollProtectionFeature.protection;

beforeEach(() => {
    settings.values = { taskRerollProtection: true };
    stored.values = {};
    batches.calls = [];
    consent.target = null;
    protection.isInitialized = false;
});

afterEach(() => {
    taskRerollProtectionFeature.cleanup();
    protection.isInitialized = false;
});

describe('cap thresholds are per character', () => {
    test('an alt gets the defaults and leaves the pre-scoping values for the main', async () => {
        consent.target = 'main01';
        stored.values.taskCapProtection = true;
        stored.values.taskCapCoinThreshold = 40000;
        stored.values.taskCapCowbellThreshold = 4;

        await taskRerollProtectionFeature.initialize();

        expect(protection.capProtectionEnabled).toBe(false);
        expect(protection.coinThreshold).toBe(320000);
        expect(protection.cowbellThreshold).toBe(32);
        expect(stored.values.taskCapCoinThreshold).toBe(40000);
        expect(stored.values.taskCapCowbellThreshold).toBe(4);
        expect(stored.values.taskCapProtection).toBe(true);
    });

    test('the chosen character adopts them once and the bare keys are gone', async () => {
        consent.target = 'alt99';
        stored.values.taskCapProtection = true;
        stored.values.taskCapCoinThreshold = 40000;
        stored.values.taskCapCowbellThreshold = 4;

        await taskRerollProtectionFeature.initialize();

        expect(protection.capProtectionEnabled).toBe(true);
        expect(protection.coinThreshold).toBe(40000);
        expect(protection.cowbellThreshold).toBe(4);
        expect(stored.values.taskCapCoinThreshold_alt99).toBe(40000);
        expect('taskCapProtection' in stored.values).toBe(false);
        expect('taskCapCoinThreshold' in stored.values).toBe(false);
        expect('taskCapCowbellThreshold' in stored.values).toBe(false);
    });

    test('a scoped value wins over a leftover bare one, which is left where it is', async () => {
        consent.target = 'alt99';
        stored.values.taskCapCoinThreshold_alt99 = 80000;
        stored.values.taskCapCoinThreshold = 40000;

        await taskRerollProtectionFeature.initialize();

        expect(protection.coinThreshold).toBe(80000);
        expect(stored.values.taskCapCoinThreshold).toBe(40000);
    });

    test('the six cap records still come from one batched read', async () => {
        await taskRerollProtectionFeature.initialize();

        expect(batches.calls).toHaveLength(1);
        expect(batches.calls[0]).toEqual([
            'taskCapProtection_alt99',
            'taskCapProtection',
            'taskCapCoinThreshold_alt99',
            'taskCapCoinThreshold',
            'taskCapCowbellThreshold_alt99',
            'taskCapCowbellThreshold',
        ]);
    });
});
