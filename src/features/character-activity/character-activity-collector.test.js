import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
    characterId: 'character-a',
    projection: null,
    listeners: new Map(),
    saveRecord: vi.fn(),
    savePreferences: vi.fn(),
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => state.characterId,
        getCurrentCharacterName: () => 'Bessie',
        getOfflineHourCap: () => 12,
        getMooPassExpireTime: () => null,
        on: (event, handler) => {
            if (!state.listeners.has(event)) state.listeners.set(event, new Set());
            state.listeners.get(event).add(handler);
        },
        off: (event, handler) => state.listeners.get(event)?.delete(handler),
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: (_key, fallback) => fallback,
    },
}));

vi.mock('./character-activity-projection.js', () => ({
    computeLiveProjection: () => state.projection,
}));

vi.mock('./character-activity-storage.js', () => ({
    saveCharacterActivity: state.saveRecord,
    saveAccountPreferences: state.savePreferences,
}));

const { default: collector } = await import('./character-activity-collector.js');

async function emit(event, payload) {
    await Promise.all([...(state.listeners.get(event) || [])].map((handler) => handler(payload)));
}

beforeEach(() => {
    state.characterId = 'character-a';
    state.projection = { segments: [], terminalCause: 'idle', terminalAt: 1000, certainty: 'trustworthy' };
    state.saveRecord.mockReset().mockResolvedValue(true);
    state.savePreferences.mockReset().mockResolvedValue(true);
    vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});

afterEach(() => {
    collector.cleanup();
    vi.unstubAllGlobals();
});

describe('character activity collector session lifecycle', () => {
    test('persists the refreshed queue when the same character reconnects without an action update', async () => {
        await collector.initialize();
        state.saveRecord.mockClear();
        state.projection = {
            segments: [{ actionName: 'Milking', startAt: 2000, endAt: 12000 }],
            terminalCause: 'action',
            terminalAt: 12000,
            certainty: 'trustworthy',
        };

        // DataManager replaces the init payload and emits character_initialized on reconnect.
        // Entrypoint intentionally does not reinitialize already-running features in this case.
        await emit('character_initialized', { character: { id: 'character-a' }, _isCharacterSwitch: false });

        expect(state.saveRecord).toHaveBeenCalledExactlyOnceWith(
            'character-a',
            expect.objectContaining({ characterId: 'character-a', projection: state.projection }),
            false
        );
    });

    test('does not copy another character queue into the collector owner while teardown is pending', async () => {
        await collector.initialize();
        state.saveRecord.mockClear();
        state.characterId = 'character-b';

        await emit('character_initialized', { character: { id: 'character-b' }, _isCharacterSwitch: true });

        expect(state.saveRecord).not.toHaveBeenCalled();
    });

    test('cleanup unregisters reconnect callbacks and invalidates one already queued for delivery', async () => {
        await collector.initialize();
        const queuedCallback = [...(state.listeners.get('character_initialized') || [])][0];
        collector.cleanup();
        state.characterId = 'character-b';
        await collector.initialize();
        state.saveRecord.mockClear();

        await queuedCallback();
        expect(state.listeners.get('character_initialized').size).toBe(1);
        expect(state.saveRecord).not.toHaveBeenCalled();

        await emit('character_initialized', { character: { id: 'character-b' }, _isCharacterSwitch: false });
        expect(state.saveRecord).toHaveBeenCalledExactlyOnceWith(
            'character-b',
            expect.objectContaining({ characterId: 'character-b' }),
            false
        );
    });
});
