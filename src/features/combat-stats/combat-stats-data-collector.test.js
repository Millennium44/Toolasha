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

const store = vi.hoisted(() => ({ saved: null, tracking: null, actions: [] }));

vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => 'me', getCurrentActions: () => store.actions },
}));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true, getSettingValue: () => 'ask' } }));
vi.mock('../../api/marketplace.js', () => ({ default: { getPrice: () => ({ ask: 1, bid: 1 }) } }));
vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async (key, _s, fallback) => (key === 'latestCombatRun' ? store.saved : store.tracking) ?? fallback,
        setJSON: async () => true,
    },
}));

const { default: collector } = await import('./combat-stats-data-collector.js');

const ZONE = '/actions/combat/enchanted_fortress';
const MINUTES = 60 * 1000;

/**
 * A stored run.
 * @param {number} ageMinutes - How long ago it was written
 * @param {string|null} actionHrid - The zone it was fought in
 * @returns {Object}
 */
const snapshot = (ageMinutes, actionHrid = ZONE) => ({
    timestamp: Date.now() - ageMinutes * MINUTES,
    combatStartTime: '2026-08-03T01:00:00Z',
    actionHrid,
    players: [{ name: 'Millennium44', isCurrentPlayer: true, loot: {} }],
});

/** @param {string|null} actionHrid - What the character is doing now */
const fighting = (actionHrid) => {
    store.actions = actionHrid ? [{ actionHrid, isDone: false }] : [];
};

beforeEach(() => {
    store.saved = null;
    store.tracking = null;
    store.actions = [];
    collector.isInitialized = false;
    collector.latestCombatData = null;
});

describe('coming back to a run already in progress', () => {
    test('the last run is there before any battle starts', async () => {
        store.saved = snapshot(0);
        fighting(ZONE);

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

describe('deciding whether a stored run still describes anything', () => {
    test('a run still under way is shown however old the snapshot', async () => {
        // Left fighting overnight with the tab shut. The snapshot is hours stale
        // and it is still the right run — a little behind, and the next battle
        // corrects it. Blanking here is the gap this was meant to close.
        store.saved = snapshot(12 * 60);
        fighting(ZONE);

        await collector.initialize();

        expect(collector.getLatestData()).not.toBeNull();
    });

    test('a run that stopped hours ago is withheld', async () => {
        // Its per-day rates divide by a clock nobody stopped, so they decay
        // toward zero and read as a bad run rather than as no run
        store.saved = snapshot(12 * 60);
        fighting(null);

        await collector.initialize();

        expect(collector.getLatestData()).toBeNull();
    });

    test('the run you just finished stays up while you look at it', async () => {
        store.saved = snapshot(3);
        fighting(null);

        await collector.initialize();

        expect(collector.getLatestData()).not.toBeNull();
    });

    test('fighting somewhere else means this is not that run', async () => {
        // The clock would have called this fresh; the zone is what settles it
        store.saved = snapshot(1);
        fighting('/actions/combat/pirate_cove');

        await collector.initialize();

        expect(collector.getLatestData()).toBeNull();
    });

    test('live data is never withheld, whatever the clock says', async () => {
        await collector.initialize();
        collector.latestCombatData = { ...snapshot(12 * 60), restored: false };
        fighting(null);

        expect(collector.getLatestData()).not.toBeNull();
    });

    test('an old snapshot from before zones were recorded is judged on time alone', async () => {
        // Written by an earlier version, so there is no zone to compare — the
        // fallback has to be the clock rather than a crash or a silent yes
        store.saved = { ...snapshot(12 * 60), actionHrid: undefined };
        fighting(null);

        await collector.initialize();
        expect(collector.getLatestData()).toBeNull();

        collector.latestCombatData = { ...snapshot(1, undefined), restored: true };
        expect(collector.getLatestData()).not.toBeNull();
    });
});
