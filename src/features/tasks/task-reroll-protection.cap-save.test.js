/** @vitest-environment happy-dom */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const world = vi.hoisted(() => ({ characterId: 'alice', disk: new Map() }));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
vi.mock('../../core/data-manager.js', () => ({ default: { getCurrentCharacterId: () => world.characterId } }));
vi.mock('../../core/dom-observer.js', () => ({ default: {} }));
vi.mock('../../core/websocket.js', () => ({ default: {} }));
vi.mock('./task-card-state.js', () => ({
    isCardInConfirmState: () => false,
    armConfirmSettleWatch: () => {},
    onConfirmFlowSettled: () => () => {},
}));
vi.mock('./task-reroll-options.js', () => ({ findRerollOptions: () => [] }));
vi.mock('./task-card-quest.js', () => ({ questForTaskCard: () => null }));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => null,
    requestAdoptionConsent: () => {},
}));
import feature from './task-reroll-protection.js';
import storage from '../../core/storage.js';

const protection = feature.protection;
const originalDb = storage.db;
const oldValues = { capProtectionEnabled: true, coinThreshold: 40000, cowbellThreshold: 4 };
const newValues = { capProtectionEnabled: false, coinThreshold: 320000, cowbellThreshold: 32 };
const savedValues = (owner) => [
    world.disk.get(`taskCapProtection_${owner}`),
    world.disk.get(`taskCapCoinThreshold_${owner}`),
    world.disk.get(`taskCapCowbellThreshold_${owner}`),
];

beforeEach(() => {
    vi.useFakeTimers();
    world.characterId = 'alice';
    world.disk = new Map();
    Object.assign(protection, oldValues);
    // Exercise real storage.set, debounce and flushAll. Only the IDB boundary
    // is replaced, just as the storage suites replace the backing database.
    storage.db = {};
    vi.spyOn(storage, '_putAllWritten').mockImplementation(async (_store, entries) => {
        for (const [key, value] of Object.entries(entries)) world.disk.set(key, value);
        return Object.keys(entries);
    });
    vi.spyOn(storage, '_saveToIndexedDB').mockImplementation(async (key, value) => {
        world.disk.set(key, value);
        return true;
    });
});
afterEach(() => {
    feature.disable();
    for (const timer of storage.saveDebounceTimers.values()) clearTimeout(timer);
    storage.saveDebounceTimers.clear();
    storage.pendingWrites.clear();
    storage._writeGeneration.clear();
    storage._flushFailures.clear();
    storage.db = originalDb;
    vi.restoreAllMocks();
    vi.useRealTimers();
});

test.each(['switch', 'same-character reconnect'])(
    'an in-flight cap save retains its full values across a %s',
    async (change) => {
        const saving = protection._saveCapProtection();
        // Character switching flushes the current pending snapshot once. A
        // continuation can enqueue its next field after that snapshot.
        await storage.flushAll();
        feature.disable();
        if (change === 'switch') world.characterId = 'bob';
        Object.assign(protection, newValues);
        await vi.runAllTimersAsync();
        await saving;
        expect(savedValues('alice')).toEqual([true, 40000, 4]);
        expect(savedValues('bob')).toEqual([undefined, undefined, undefined]);
    }
);

test('normal saves retain the existing three keys and values', async () => {
    const saving = protection._saveCapProtection();
    await vi.runAllTimersAsync();
    await saving;
    expect(savedValues('alice')).toEqual([true, 40000, 4]);
});

test('successive same-character edits still persist the newest complete settings', async () => {
    const first = protection._saveCapProtection();
    Object.assign(protection, newValues);
    const second = protection._saveCapProtection();
    await vi.runAllTimersAsync();
    await Promise.all([first, second]);
    expect(savedValues('alice')).toEqual([false, 320000, 32]);
});
