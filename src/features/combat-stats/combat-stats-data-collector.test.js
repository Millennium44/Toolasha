/**
 * What the collector has to hand the moment the page loads.
 *
 * A dungeon wave is tens of seconds long and `new_battle` fires once per wave,
 * so anything that waits for one shows nothing for that whole time after a
 * refresh. The run itself was being written to storage all along and only the
 * Combat Statistics popup ever read it back, which is why the popup survived a
 * reload and the overlay did not.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const store = vi.hoisted(() => ({ saved: null, tracking: null }));

vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../core/data-manager.js', () => ({ default: { getCurrentCharacterId: () => 'me' } }));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true, getSettingValue: () => 'ask' } }));
vi.mock('../../api/marketplace.js', () => ({ default: { getPrice: () => ({ ask: 1, bid: 1 }) } }));
vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async (key, _s, fallback) => (key === 'latestCombatRun' ? store.saved : store.tracking) ?? fallback,
        setJSON: async () => true,
    },
}));

const { default: collector } = await import('./combat-stats-data-collector.js');

beforeEach(() => {
    store.saved = null;
    store.tracking = null;
    collector.isInitialized = false;
    collector.latestCombatData = null;
});

describe('coming back to a run already in progress', () => {
    test('the last run is there before any battle starts', async () => {
        store.saved = {
            combatStartTime: '2026-08-03T01:00:00Z',
            players: [{ name: 'Millennium44', isCurrentPlayer: true, loot: {} }],
        };

        await collector.initialize();

        // The failure this catches is silent: nothing throws, the overlay simply
        // says "No loot tracked yet" for a whole wave
        expect(collector.getLatestData()?.players?.[0]?.name).toBe('Millennium44');
    });

    test('nothing stored is still nothing, rather than an empty run', async () => {
        // A row with zeroes behind it reads as a real measurement of a run going
        // badly, which is worse than a row that says it has nothing
        await collector.initialize();

        expect(collector.getLatestData()).toBeNull();
    });
});
