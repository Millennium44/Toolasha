import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const game = vi.hoisted(() => ({ characterId: 'first' }));
vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => game.characterId, on: vi.fn(), off: vi.fn() },
}));
vi.mock('../../core/storage.js', () => ({ default: { getJSON: vi.fn(), setJSON: vi.fn() } }));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
vi.mock('../../core/websocket.js', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../../utils/bundle-bridge.js', () => ({
    guildMemberSkills: () => null,
    marketUndercutAlerts: () => null,
    webSocketHook: () => null,
}));
import loadoutSnapshot from './loadout-snapshot.js';
import storage from '../../core/storage.js';
let instance;
beforeEach(() => {
    vi.useFakeTimers();
    game.characterId = 'first';
    storage.getJSON.mockReset().mockResolvedValue(null);
    instance = new loadoutSnapshot.constructor();
});
afterEach(() => {
    instance.disable();
    vi.useRealTimers();
});

describe('readiness deadlines stay with their character session', () => {
    test.each(['switch', 'reconnect'])(
        'a departing session timeout cannot release a new session after %s',
        async (kind) => {
            const oldWait = instance.whenReady(5000);
            await vi.advanceTimersByTimeAsync(4000);
            instance.disable();
            if (kind === 'switch') game.characterId = 'second';
            let ready = false;
            instance.whenReady(5000).then(() => {
                ready = true;
            });
            await vi.advanceTimersByTimeAsync(1000);

            expect(instance.snapshotsReady).toBe(false);
            expect(ready).toBe(false);
            await expect(oldWait).resolves.toBe(true);
            await vi.advanceTimersByTimeAsync(4000);
            expect(instance.snapshotsReady).toBe(true);
            expect(ready).toBe(true);
        }
    );

    test('a completed old wait leaves no timer that can mark a later session ready', async () => {
        const oldWait = instance.whenReady(5000);
        await instance.initialize();
        await expect(oldWait).resolves.toBe(true);
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(4000);
        instance.disable();
        game.characterId = 'second';
        let ready = false;
        instance.whenReady(5000).then(() => {
            ready = true;
        });
        await vi.advanceTimersByTimeAsync(1000);
        expect(instance.snapshotsReady).toBe(false);
        expect(ready).toBe(false);
    });

    test('an old timeout does not let a shopping wait read empty loadouts while new storage is pending', async () => {
        instance.whenReady(5000);
        await vi.advanceTimersByTimeAsync(4000);
        instance.disable();
        game.characterId = 'second';
        let finishRead;
        storage.getJSON.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finishRead = resolve;
                })
        );
        const initializing = instance.initialize();
        let heldNames = null;
        instance.whenReady(5000).then(() => {
            heldNames = instance.getAllSnapshots().map((s) => s.name);
        });
        await vi.advanceTimersByTimeAsync(1000);
        expect(heldNames).toBeNull();
        finishRead({ 42: { id: 42, name: 'Keep this gear', equipment: [] } });
        await initializing;
        await Promise.resolve();
        expect(heldNames).toEqual(['Keep this gear']);
        expect(vi.getTimerCount()).toBe(0);
    });

    test('new-session readiness still releases all waits and clears their deadlines', async () => {
        const first = instance.whenReady(5000);
        const second = instance.whenReady(8000);
        await instance.initialize();
        await expect(first).resolves.toBe(true);
        await expect(second).resolves.toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });
});
