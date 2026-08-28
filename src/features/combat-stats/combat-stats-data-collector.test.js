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

const store = vi.hoisted(() => ({
    saved: null,
    tracking: null,
    actions: [],
    writes: [],
    probes: 0,
    unavailable: false,
}));

vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'me',
        getCurrentCharacterGameMode: () => 'standard',
        getCurrentActions: () => store.actions,
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true, getSettingValue: () => 'ask' } }));
vi.mock('../../api/marketplace.js', () => ({ default: { getPrice: () => ({ ask: 1, bid: 1 }) } }));
// Real sessionKey (pure), mocked archiveSession so the archiving decision can
// be asserted without a full storage round trip through persisted-record.js
vi.mock('./combat-session-history.js', async () => {
    const actual = await vi.importActual('./combat-session-history.js');
    return { ...actual, archiveSession: vi.fn(async () => []) };
});
// Keys are per character now, so the mock matches on the base rather than the
// whole key — the suffix is character-key.js's business and has its own tests
const read = async (key, _s, fallback = null) =>
    (key.startsWith('latestCombatRun') ? store.saved : store.tracking) ?? fallback;

vi.mock('../../core/storage.js', () => ({
    default: {
        get: read,
        getJSON: read,
        tryGet: async (key) => {
            store.probes++;
            if (store.unavailable) return null;
            const value = await read(key);
            return value == null ? { found: false, value: null } : { found: true, value };
        },
        set: async (key, value) => {
            store.writes.push([key, value]);
            return true;
        },
        setJSON: async () => true,
        delete: async () => true,
        getAllKeys: async () => [],
    },
}));

const { default: collector, _resetReadProbe } = await import('./combat-stats-data-collector.js');
const { archiveSession } = await import('./combat-session-history.js');

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
    store.writes = [];
    store.probes = 0;
    store.unavailable = false;
    _resetReadProbe();
    collector.isInitialized = false;
    collector.latestCombatData = null;
    collector.sessionKey = null;
    archiveSession.mockClear();
});

describe('the trackers are not written over on the strength of a failed read', () => {
    test('a load that cannot read storage keeps the counters in memory', async () => {
        collector.consumableTracker.actualConsumed = { '/items/tea': 3 };
        store.unavailable = true;

        await collector.loadConsumableTracking();

        expect(collector.consumableTracker.actualConsumed).toEqual({ '/items/tea': 3 });
    });

    test('a save while storage is unreadable is skipped, leaving the stored counts alone', async () => {
        collector.consumableTracker.actualConsumed = { '/items/tea': 3 };
        store.unavailable = true;

        expect(await collector.saveConsumableTracking()).toBe(false);

        expect(store.writes).toEqual([]);
    });

    test('a save that can read storage writes every tracker under the character key', async () => {
        collector.consumableTracker.actualConsumed = { '/items/tea': 3 };

        expect(await collector.saveConsumableTracking()).toBe(true);

        expect(store.writes.map(([key]) => key)).toEqual([
            'consumableTracker_me',
            'partyConsumableTrackers_me',
            'partyConsumableSnapshots_me',
        ]);
        expect(store.writes[0][1].actualConsumed).toEqual({ '/items/tea': 3 });
    });

    test('once storage reads again the next save lands', async () => {
        store.unavailable = true;
        collector.consumableTracker.actualConsumed = { '/items/tea': 3 };
        await collector.saveConsumableTracking();
        expect(store.writes).toEqual([]);

        store.unavailable = false;
        collector.consumableTracker.actualConsumed['/items/tea'] = 4;
        await collector.saveConsumableTracking();

        expect(store.writes[0][1].actualConsumed).toEqual({ '/items/tea': 4 });
    });

    test('a probe that succeeded stands in for the next few seconds of saves', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-08-03T01:00:00Z'));
            await collector.saveConsumableTracking();
            await collector.saveConsumableTracking();
            expect(store.probes).toBe(1);
            expect(store.writes).toHaveLength(6);

            vi.setSystemTime(new Date('2026-08-03T01:00:06Z'));
            await collector.saveConsumableTracking();
            expect(store.probes).toBe(2);
        } finally {
            vi.useRealTimers();
        }
    });

    test('a failed probe is not cached, so the very next save asks again', async () => {
        store.unavailable = true;
        await collector.saveConsumableTracking();
        await collector.saveConsumableTracking();
        expect(store.probes).toBe(2);
        expect(store.writes).toEqual([]);
    });

    test('a wave writes the trackers once, not once per tracker group', async () => {
        fighting(ZONE);
        await collector.onNewBattle({
            battleId: 1,
            combatStartTime: '2026-08-03T01:00:00Z',
            players: [{ character: { id: 'me', name: 'Millennium44' }, loot: {}, consumables: [] }],
        });

        const trackerWrites = store.writes.filter(([key]) => key.startsWith('consumableTracker_'));
        expect(trackerWrites).toHaveLength(1);
        expect(store.probes).toBe(1);
    });
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

    test('a run that finished while the tab was closed is archived, not dropped', async () => {
        // The restored run never sees another new_battle of its own — it ended
        // offline — so the only sign it ever happened is `this.sessionKey`
        // being set to it. Without that, the first new_battle after reload (a
        // different, already-running fight) would find `this.sessionKey` still
        // null and skip archiving the restored run entirely.
        store.saved = snapshot(30, ZONE);
        fighting(ZONE);
        await collector.initialize();

        await collector.onNewBattle({
            battleId: 1,
            combatStartTime: '2026-08-03T05:00:00Z', // a later run, different key
            players: [{ character: { id: 'me', name: 'Millennium44' }, loot: {}, consumables: [] }],
        });

        expect(archiveSession).toHaveBeenCalledTimes(1);
        expect(archiveSession.mock.calls[0][0].combatStartTime).toBe(snapshot(30, ZONE).combatStartTime);
    });

    test('new_battle for the same restored run does not archive it against itself', async () => {
        store.saved = snapshot(1, ZONE);
        fighting(ZONE);
        await collector.initialize();

        await collector.onNewBattle({
            battleId: 2,
            combatStartTime: store.saved.combatStartTime,
            players: [{ character: { id: 'me', name: 'Millennium44' }, loot: {}, consumables: [] }],
        });

        expect(archiveSession).not.toHaveBeenCalled();
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
