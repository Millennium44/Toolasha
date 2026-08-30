/**
 * What gets written down about the character you are leaving.
 *
 * Two things are worth asserting and the rest is plumbing: that a subject with
 * no honest answer is *absent* rather than defaulted (the engine turns an absent
 * fact into no line, which is the whole contract), and that the record lands
 * under the departing character's id — the bug family this codebase has fixed
 * more times than any other.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const stores = vi.hoisted(() => ({
    writes: [],
    data: new Map(),
    currentId: 'arriving',
    currentName: 'Arriving',
    listeners: new Map(),
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: vi.fn(async (key, store, fallback) => (stores.data.has(key) ? stores.data.get(key) : fallback)),
        set: vi.fn(async (key, value) => {
            stores.writes.push({ key, value });
            stores.data.set(key, value);
            return true;
        }),
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        // Deliberately the ARRIVING character: nothing in the writer may consult
        // this, and a test that let it agree with the event would not notice
        getCurrentCharacterId: () => stores.currentId,
        getCurrentCharacterName: () => stores.currentName,
        get characterData() {
            return { characterInfo: stores.characterInfo };
        },
        get characterQuests() {
            return stores.quests;
        },
        on: vi.fn((event, handler) => stores.listeners.set(event, handler)),
    },
}));

vi.mock('../enhancement/enhancement-tracker.js', () => ({
    default: { getCurrentSession: () => stores.session },
}));

vi.mock('./session-briefing.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, undercutCount: () => stores.undercut, readGuildTrial: () => stores.guild };
});

const {
    gatherSnapshotFacts,
    capFacts,
    recordSwitchSnapshot,
    initializeBriefingSnapshots,
    _resetBriefingSnapshotListener,
    MAX_SNAPSHOT_CHARS,
    snapshotNow,
} = await import('./briefing-snapshot.js');

const { readSnapshotsFromKeys, SNAPSHOT_FACT_KEYS } = await import('./briefing-snapshot-store.js');

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

/** A character info that produces a task forecast. */
const boardInfo = (overrides = {}) => ({
    taskSlotCap: 10,
    taskCooldownHours: 6,
    lastTaskTimestamp: new Date(NOW - HOUR).toISOString(),
    unreadTaskCount: 0,
    ...overrides,
});

beforeEach(() => {
    stores.writes = [];
    stores.data = new Map();
    stores.listeners = new Map();
    stores.currentId = 'arriving';
    stores.currentName = 'Arriving';
    stores.characterInfo = null;
    stores.quests = [];
    stores.session = null;
    stores.undercut = null;
    stores.guild = null;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    _resetBriefingSnapshotListener();
});

describe('gatherSnapshotFacts', () => {
    test('a character it can learn nothing about produces no facts at all', () => {
        expect(gatherSnapshotFacts('leaving', NOW)).toEqual({});
    });

    test('zero is not a fact — an empty board and no beaten listings are absent', () => {
        stores.characterInfo = boardInfo({ unreadTaskCount: 0 });
        stores.undercut = 0;
        const facts = gatherSnapshotFacts('leaving', NOW, { labyrinth: () => null });
        expect(facts.tasksReady).toBeUndefined();
        expect(facts.listings).toBeUndefined();
    });

    test('the facts it does gather are trimmed to what the lines read', () => {
        stores.characterInfo = boardInfo({ unreadTaskCount: 3 });
        stores.undercut = 2;
        stores.session = { state: 'tracking', lastUpdateTime: NOW, itemName: 'Sword', currentLevel: 3, targetLevel: 8 };
        stores.guild = { signedUp: true, trialName: 'chimerical' };

        const facts = gatherSnapshotFacts('leaving', NOW, {
            consumable: () => ({ name: 'Ale', secondsLeft: 4200, extra: 'dropped' }),
            labyrinth: () => ({ ok: true, entries: 3, isFull: true, cooldownMs: 1, lastEntryAt: 2 }),
        });

        expect(Object.keys(facts).sort()).toEqual([...SNAPSHOT_FACT_KEYS].sort());
        expect(facts.tasksReady).toBe(3);
        expect(facts.consumable).toEqual({ name: 'Ale', secondsLeft: 4200 });
        expect(facts.labyrinth).toEqual({ ok: true, available: 3, isFull: true });
        expect(facts.listings).toEqual({ filled: 0, undercut: 2 });
        expect(Object.keys(facts.taskSlots).sort()).toEqual(['isFull', 'msUntilFull', 'msUntilWaste', 'ok']);
    });

    test('a stopped enhancement run is not a live one', () => {
        stores.session = { state: 'tracking', lastUpdateTime: NOW - 3 * HOUR, itemName: 'Sword' };
        expect(gatherSnapshotFacts('leaving', NOW, { labyrinth: () => null }).enhancement).toBeUndefined();
    });

    test('a guild tracker that cannot say is not read as "not signed up"', () => {
        stores.guild = { signedUp: null };
        expect(gatherSnapshotFacts('leaving', NOW, { labyrinth: () => null }).guild).toBeUndefined();
    });

    test('one reader throwing costs its own fact and no other', () => {
        stores.characterInfo = boardInfo({ unreadTaskCount: 5 });
        const facts = gatherSnapshotFacts('leaving', NOW, {
            consumable: () => {
                throw new Error('the collector is disabled');
            },
            labyrinth: () => null,
        });
        expect(facts.tasksReady).toBe(5);
        expect(facts.consumable).toBeUndefined();
        expect(facts.taskSlots.ok).toBe(true);
    });

    test('the departing id is what the guild reader is asked about', () => {
        let asked = null;
        gatherSnapshotFacts('leaving', NOW, {
            guild: (id) => {
                asked = id;
                return null;
            },
            labyrinth: () => null,
        });
        expect(asked).toBe('leaving');
    });
});

describe('capFacts', () => {
    test('a fact that is not a declared subject cannot reach storage', () => {
        expect(capFacts({ tasksReady: 1, queue: { queued: 0 }, notices: 5 })).toEqual({ tasksReady: 1 });
    });

    test('an ordinary record passes through untouched', () => {
        const facts = { tasksReady: 3, consumable: { name: 'Ale', secondsLeft: 10 } };
        expect(capFacts(facts)).toEqual(facts);
    });

    test('an implausibly large record keeps only the small facts', () => {
        const facts = {
            tasksReady: 3,
            taskSlots: { ok: true, isFull: false, msUntilFull: 1, msUntilWaste: 2 },
            consumable: { name: 'x'.repeat(MAX_SNAPSHOT_CHARS + 100), secondsLeft: 10 },
        };
        expect(capFacts(facts)).toEqual({ tasksReady: 3, taskSlots: facts.taskSlots });
    });
});

describe('recordSwitchSnapshot', () => {
    test('files the record under the departing character, never the arriving one', async () => {
        stores.characterInfo = boardInfo({ unreadTaskCount: 2 });
        await recordSwitchSnapshot({ oldId: 'leaving', oldName: 'Alpha', newId: 'arriving' });

        expect(stores.writes.map((write) => write.key)).toEqual(['briefingSnapshot_leaving']);
        const record = stores.writes[0].value;
        expect(record.characterId).toBe('leaving');
        expect(record.characterName).toBe('Alpha');
        expect(record.facts.tasksReady).toBe(2);
        expect(Number.isFinite(record.at)).toBe(true);
    });

    test('a switch with nothing to report still writes, so the stale record is replaced', async () => {
        await recordSwitchSnapshot({ oldId: 'leaving', oldName: 'Alpha' });
        expect(stores.writes).toHaveLength(1);
        expect(stores.writes[0].value.facts).toEqual({});
    });

    test('the first login, which has no departing character, writes nothing', async () => {
        await recordSwitchSnapshot({ oldId: null, newId: 'arriving' });
        expect(stores.writes).toEqual([]);
    });
});

describe('readSnapshotsFromKeys', () => {
    test('picks its own keys out of the settings store and ignores the rest', async () => {
        stores.data.set('briefingSnapshot_a', { characterId: 'a', at: NOW, facts: {} });
        stores.data.set('briefingSnapshot_b', { characterId: 'b', at: NOW, facts: {} });
        stores.data.set('sessionBriefingListings_a', { at: NOW });

        const byId = await readSnapshotsFromKeys([
            'briefingSnapshot_a',
            'briefingSnapshot_b',
            'sessionBriefingListings_a',
            'somethingElse',
        ]);
        expect(Object.keys(byId).sort()).toEqual(['a', 'b']);
    });

    test('a record with no timestamp is not a snapshot', async () => {
        stores.data.set('briefingSnapshot_a', { characterId: 'a', facts: {} });
        expect(await readSnapshotsFromKeys(['briefingSnapshot_a'])).toEqual({});
    });

    test('no keys is not an error', async () => {
        expect(await readSnapshotsFromKeys(undefined)).toEqual({});
    });
});

describe('initializeBriefingSnapshots', () => {
    test('registers the switching listener exactly once', async () => {
        const dataManager = (await import('../../core/data-manager.js')).default;
        // The modules imported alongside this one register their own listeners
        // on the shared mock at import time; only ours is under test here
        dataManager.on.mockClear();
        initializeBriefingSnapshots();
        initializeBriefingSnapshots();
        expect(dataManager.on).toHaveBeenCalledTimes(1);
        expect(stores.listeners.get('character_switching')).toBe(recordSwitchSnapshot);
    });
});

/**
 * Until now a snapshot could only be written by leaving a character, which
 * makes the feature impossible to check and useless as a mark taken before
 * something you are about to change.
 *
 * The id rule inverts here, and that is the point: on `character_switching` the
 * data-manager pointer is mid-move and reading it files the departing
 * character's facts under the arriving character's key. On demand there is no
 * switch in progress and the current character *is* the subject.
 */
describe('snapshotNow', () => {
    test('it writes the character you are on, under that character’s key', async () => {
        stores.currentId = 'here';
        stores.currentName = 'Here';
        stores.characterInfo = boardInfo();

        expect(await snapshotNow()).toBe(true);
        expect(stores.writes).toHaveLength(1);
        expect(stores.writes[0].key).toBe('briefingSnapshot_here');
        expect(stores.writes[0].value).toMatchObject({ characterId: 'here', characterName: 'Here' });
    });

    test('the record carries a real clock, which is what the readers require', async () => {
        stores.currentId = 'here';
        vi.setSystemTime(NOW);

        await snapshotNow();
        expect(stores.writes[0].value.at).toBe(NOW);
        vi.useRealTimers();
    });

    test('an empty gather is still written — "nothing to report" is an answer', async () => {
        stores.currentId = 'here';
        stores.characterInfo = null;

        expect(await snapshotNow()).toBe(true);
        expect(stores.writes[0].value.facts).toEqual({});
    });

    test('no character is nothing to snapshot, and nothing is written', async () => {
        stores.currentId = null;

        expect(await snapshotNow()).toBe(false);
        expect(stores.writes).toEqual([]);
    });

    test('a write that fails is reported as a failure, not swallowed as success', async () => {
        stores.currentId = 'here';
        const storage = (await import('../../core/storage.js')).default;
        storage.set.mockRejectedValueOnce(new Error('the store would not open'));

        expect(await snapshotNow()).toBe(false);
    });

    test('it files under the current character, where the switch path must not', async () => {
        // Same module, opposite rule. `recordSwitchSnapshot` takes the id off
        // the event because the pointer has already moved; this one has no
        // event and no switch in progress, so the pointer is the subject
        stores.currentId = 'arriving';
        await snapshotNow();
        await recordSwitchSnapshot({ oldId: 'leaving', oldName: 'Leaving' });

        expect(stores.writes.map((write) => write.key)).toEqual([
            'briefingSnapshot_arriving',
            'briefingSnapshot_leaving',
        ]);
    });
});
