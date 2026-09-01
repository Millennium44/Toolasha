/**
 * @vitest-environment happy-dom
 *
 * The dungeon tracker's run lifecycle.
 *
 * A run is assembled from two independent streams: the websocket
 * (`new_battle` → `action_completed`), which knows about waves, and party chat
 * ("Key counts:"), which carries the server's own timestamps and is therefore
 * the authoritative duration. Almost every interesting behaviour here is about
 * what happens when those two disagree — a refresh mid-dungeon, a completion
 * seen by one stream and not the other, a character switch between them.
 *
 * The game is mocked, not the tracker: websocket handlers are captured so
 * messages can be fed in the order the server would send them, and storage is
 * an in-memory map so the persistence guards (battleId, staleness, recent
 * completion, per-character scoping) can be exercised for real through
 * character-key.js rather than stubbed away.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    characterId: 'market123',
    gameMode: 'standard',
    actions: [],
    actionDetails: {},
    dungeonInfo: {},
    wsHandlers: {},
    dmHandlers: {},
    savedRuns: [],
}));

const mockStorage = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    return {
        stores,
        storeFor,
        reset: () => stores.clear(),
        get: vi.fn(async (key, storeName = 'settings', defaultValue = null) => {
            const store = storeFor(storeName);
            return store.has(key) && store.get(key) != null ? store.get(key) : defaultValue;
        }),
        set: vi.fn(async (key, value, storeName = 'settings') => {
            storeFor(storeName).set(key, value);
            return true;
        }),
        delete: vi.fn(async (key, storeName = 'settings') => {
            storeFor(storeName).delete(key);
            return true;
        }),
        getAllKeys: vi.fn(async (storeName = 'settings') => Array.from(storeFor(storeName).keys())),
    };
});

vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (event, handler) => {
            game.wsHandlers[event] = handler;
        },
        off: (event, handler) => {
            if (game.wsHandlers[event] === handler) delete game.wsHandlers[event];
        },
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentActions: () => game.actions,
        getActionDetails: (hrid) => game.actionDetails[hrid] ?? null,
        getCurrentCharacterId: () => game.characterId,
        getCurrentCharacterGameMode: () => game.gameMode,
        on: (event, handler) => {
            game.dmHandlers[event] = handler;
        },
        off: (event, handler) => {
            if (game.dmHandlers[event] === handler) delete game.dmHandlers[event];
        },
    },
}));

vi.mock('../../core/storage.js', () => ({ default: mockStorage }));

vi.mock('./dungeon-tracker-storage.js', () => ({
    default: {
        getDungeonInfo: (hrid) => game.dungeonInfo[hrid] ?? null,
        getTeamKey: (names) => [...names].sort().join(','),
        saveTeamRun: vi.fn(async (teamKey, run) => {
            game.savedRuns.push({ teamKey, run });
            return true;
        }),
    },
}));

const tracker = (await import('./dungeon-tracker.js')).default;
const { _resetAdoptionCache } = await import('../../utils/character-key.js');

const DEN = '/actions/combat/chimerical_den';
const LAIR = '/actions/combat/sinister_circus';
const FLY = '/actions/combat/fly';
const IN_PROGRESS = 'dungeonTracker_inProgressRun';

/** Storage settles in microtasks; the tracker fires several saves without awaiting them. */
async function flush() {
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

function stored(charId = game.characterId) {
    return mockStorage.storeFor('settings').get(`${IN_PROGRESS}_${charId}`);
}

function keyCountsData(isoTime, keyCountString) {
    return {
        message: {
            chan: '/chat_channel_types/party',
            isSystemMessage: true,
            m: 'systemChatMessage.partyKeyCount',
            t: isoTime,
            systemMetadata: JSON.stringify({ keyCountString }),
        },
    };
}

/** Put the tracker into the middle of a run without replaying every message. */
function beTracking({
    dungeonHrid = DEN,
    tier = 0,
    startTime = Date.parse('2026-08-04T10:00:00.000Z'),
    currentWave = 3,
    maxWaves = 10,
    wavesCompleted = 2,
    battleId = 42,
    waveTimes = [],
    keyCountsMap = {},
    anchoredAt = null,
    restored = false,
} = {}) {
    tracker.isTracking = true;
    // A run picked back up from storage never saw its own start message; one started
    // here has it still to come, and the two read an unanchored key count differently.
    tracker.restoredMidRun = restored;
    tracker.currentBattleId = battleId;
    tracker.waveStartTime = new Date(startTime);
    tracker.waveTimes = waveTimes;
    tracker.currentRun = { dungeonHrid, tier, startTime, currentWave, maxWaves, wavesCompleted, keyCountsMap };
    if (anchoredAt !== null) {
        // What the post-start chat scan leaves behind: the run's own start
        // message, seen and recorded, so the next one is the completion.
        const anchor = Date.parse(anchoredAt);
        tracker.firstKeyCountTimestamp = anchor;
        tracker.lastKeyCountTimestamp = anchor;
        tracker.keyCountMessages = [{ timestamp: anchor, keyCountsMap, text: 'Key counts (start)' }];
    }
}

function resetTracker() {
    tracker.isTracking = false;
    tracker.isInitialized = false;
    tracker.currentRun = null;
    tracker.waveStartTime = null;
    tracker.waveTimes = [];
    tracker.updateCallbacks = [];
    tracker.pendingDungeonInfo = null;
    tracker.currentBattleId = null;
    tracker.firstKeyCountTimestamp = null;
    tracker.lastKeyCountTimestamp = null;
    tracker.keyCountMessages = [];
    tracker.pendingNextRunFirstKeyCount = null;
    tracker.battleStartedTimestamp = null;
    tracker.restoredMidRun = false;
    tracker.characterId = null;
    tracker.recentChatMessages = [];
    tracker._lastCompletionTime = 0;
    tracker.hibernationDetected = false;
    tracker.timerRegistry.clearAll();
    if (tracker.visibilityHandler) {
        document.removeEventListener('visibilitychange', tracker.visibilityHandler);
        tracker.visibilityHandler = null;
    }
}

beforeEach(() => {
    mockStorage.reset();
    _resetAdoptionCache();
    game.characterId = 'market123';
    game.gameMode = 'standard';
    game.actions = [];
    game.actionDetails = {
        [DEN]: { name: 'Chimerical Den', combatZoneInfo: { isDungeon: true } },
        [LAIR]: { name: 'Sinister Circus', combatZoneInfo: { isDungeon: true } },
        [FLY]: { name: 'Fly', combatZoneInfo: { isDungeon: false } },
        '/actions/cheesesmithing/cheese_gauntlets': { name: 'Cheese Gauntlets' },
    };
    game.dungeonInfo = {
        [DEN]: { name: 'Chimerical Den', maxWaves: 10 },
        [LAIR]: { name: 'Sinister Circus', maxWaves: 12 },
    };
    game.wsHandlers = {};
    game.dmHandlers = {};
    game.savedRuns = [];
    resetTracker();
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('recognising a dungeon', () => {
    test('a combat action flagged isDungeon is one', () => {
        expect(tracker.isDungeonAction(DEN)).toBe(true);
    });

    test('an ordinary combat zone is not', () => {
        expect(tracker.isDungeonAction(FLY)).toBe(false);
    });

    test('a skilling action is not, without ever asking for its details', () => {
        expect(tracker.isDungeonAction('/actions/cheesesmithing/cheese_gauntlets')).toBe(false);
    });

    test('nothing at all is not', () => {
        expect(tracker.isDungeonAction(null)).toBe(false);
        expect(tracker.isDungeonAction(undefined)).toBe(false);
        expect(tracker.isDungeonAction('')).toBe(false);
    });

    test('an unknown combat action is not', () => {
        expect(tracker.isDungeonAction('/actions/combat/nothing_here')).toBe(false);
    });
});

describe('starting a run', () => {
    test('wave 0 starts a run from the queued dungeon action', async () => {
        tracker.onActionsUpdated({ endCharacterActions: [{ actionHrid: DEN, difficultyTier: 2, isDone: false }] });
        expect(tracker.pendingDungeonInfo).toEqual({ dungeonHrid: DEN, tier: 2 });

        await tracker.onNewBattle({ wave: 0, battleId: 42, combatStartTime: '2026-08-04T10:00:00.000Z' });
        await flush();

        expect(tracker.isTracking).toBe(true);
        expect(tracker.currentBattleId).toBe(42);
        expect(tracker.currentRun).toMatchObject({
            dungeonHrid: DEN,
            tier: 2,
            startTime: Date.parse('2026-08-04T10:00:00.000Z'),
            currentWave: 0,
            maxWaves: 10,
            wavesCompleted: 0,
            hibernationDetected: false,
        });
        expect(tracker.pendingDungeonInfo).toBeNull();
    });

    test('with no pending info it falls back to the active action list', async () => {
        game.actions = [{ actionHrid: DEN, difficultyTier: 1, isDone: false }];

        await tracker.onNewBattle({ wave: 0, battleId: 7, combatStartTime: '2026-08-04T10:00:00.000Z' });
        await flush();

        expect(tracker.currentRun.dungeonHrid).toBe(DEN);
        expect(tracker.currentRun.tier).toBe(1);
        expect(tracker.currentRun.maxWaves).toBe(10);
    });

    test('a non-dungeon pending action never starts tracking', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        tracker.pendingDungeonInfo = { dungeonHrid: FLY, tier: 0 };

        await tracker.onNewBattle({ wave: 0, battleId: 3, combatStartTime: '2026-08-04T10:00:00.000Z' });
        await flush();

        expect(tracker.isTracking).toBe(false);
        expect(tracker.currentRun).toBeNull();
        expect(tracker.pendingDungeonInfo).toBeNull();
        expect(warn).toHaveBeenCalled();
    });

    test('no dungeon anywhere means no run', async () => {
        game.actions = [{ actionHrid: FLY, isDone: false }];
        await tracker.onNewBattle({ wave: 0, battleId: 3, combatStartTime: '2026-08-04T10:00:00.000Z' });
        await flush();
        expect(tracker.isTracking).toBe(false);
    });

    test('a message without a wave field is not a dungeon battle', async () => {
        game.actions = [{ actionHrid: DEN, isDone: false }];
        await tracker.onNewBattle({ battleId: 3, combatStartTime: '2026-08-04T10:00:00.000Z' });
        expect(tracker.isTracking).toBe(false);
    });

    test('a later wave while already tracking only moves the wave along', async () => {
        beTracking({ currentWave: 3, battleId: 42 });

        await tracker.onNewBattle({ wave: 4, battleId: 99, combatStartTime: '2026-08-04T10:05:00.000Z' });
        await flush();

        expect(tracker.currentRun.currentWave).toBe(4);
        // The battleId is refreshed so a re-login mid-dungeon still persists
        expect(tracker.currentBattleId).toBe(99);
        expect(tracker.waveStartTime.getTime()).toBe(Date.parse('2026-08-04T10:05:00.000Z'));
    });

    test('a resent wave 0 while still on wave 0 only refreshes the battle, not the run', async () => {
        // `new_battle` has no reconnect dedupe (see websocket.js), so a drop and
        // reconnect that catches the run still on its own first wave resends
        // this same wave 0 rather than a real dungeon start. Restarting the run
        // here used to wipe wavesCompleted, waveTimes and the party-message
        // timestamps the run had already collected, and moved its recorded
        // start time to whenever the reconnect happened.
        beTracking({
            currentWave: 0,
            wavesCompleted: 0,
            battleId: 42,
            waveTimes: [1000],
            anchoredAt: '2026-08-04T10:00:05.000Z',
        });
        const keptStartTime = tracker.currentRun.startTime;

        await tracker.onNewBattle({ wave: 0, battleId: 99, combatStartTime: '2026-08-04T10:05:00.000Z' });
        await flush();

        expect(tracker.isTracking).toBe(true);
        expect(tracker.currentRun.startTime).toBe(keptStartTime);
        expect(tracker.currentRun.currentWave).toBe(0);
        expect(tracker.waveTimes).toEqual([1000]);
        expect(tracker.firstKeyCountTimestamp).toBe(Date.parse('2026-08-04T10:00:05.000Z'));
        // The battleId still refreshes, same as any other reconnect mid-run
        expect(tracker.currentBattleId).toBe(99);
    });

    test('but a genuinely new dungeon queued while wave 0 is still open starts fresh', async () => {
        // The one case a resent wave 0 must NOT be swallowed: actions_updated
        // queued a real new dungeon action before this new_battle arrived
        beTracking({ currentWave: 0, wavesCompleted: 0, battleId: 42 });
        tracker.onActionsUpdated({ endCharacterActions: [{ actionHrid: LAIR, difficultyTier: 1, isDone: false }] });

        await tracker.onNewBattle({ wave: 0, battleId: 100, combatStartTime: '2026-08-04T11:00:00.000Z' });
        await flush();

        expect(tracker.currentRun.dungeonHrid).toBe(LAIR);
        expect(tracker.currentRun.startTime).toBe(Date.parse('2026-08-04T11:00:00.000Z'));
    });
});

describe('the in-progress record', () => {
    test('a run in flight is written under this character', async () => {
        beTracking({ waveTimes: [3000, 5000], keyCountsMap: { Alice: 12 } });
        tracker.firstKeyCountTimestamp = 1000;
        tracker.lastKeyCountTimestamp = 1000;

        expect(await tracker.saveInProgressRun()).toBe(true);
        expect(stored()).toMatchObject({
            battleId: 42,
            dungeonHrid: DEN,
            currentWave: 3,
            maxWaves: 10,
            wavesCompleted: 2,
            waveTimes: [3000, 5000],
            keyCountsMap: { Alice: 12 },
            firstKeyCountTimestamp: 1000,
        });
    });

    test('the saved wave times are a copy, not the live array', async () => {
        beTracking({ waveTimes: [3000] });
        await tracker.saveInProgressRun();
        tracker.waveTimes.push(9999);
        expect(stored().waveTimes).toEqual([3000]);
    });

    test('nothing is written when there is no run, or no battle to tie it to', async () => {
        expect(await tracker.saveInProgressRun()).toBe(false);

        beTracking({ battleId: null });
        tracker.currentBattleId = null;
        expect(await tracker.saveInProgressRun()).toBe(false);
        expect(stored()).toBeUndefined();
    });

    test('a matching battle restores the run', async () => {
        game.actions = [{ actionHrid: DEN, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            tier: 1,
            startTime: 1000,
            currentWave: 5,
            maxWaves: 10,
            wavesCompleted: 4,
            waveTimes: [3000, 5000],
            waveStartTime: 7000,
            keyCountsMap: { Alice: 12, Bob: 8 },
            lastUpdateTime: Date.now(),
            firstKeyCountTimestamp: 500,
            lastKeyCountTimestamp: 500,
            hibernationDetected: true,
        });

        expect(await tracker.restoreInProgressRun(42)).toBe(true);
        expect(tracker.isTracking).toBe(true);
        expect(tracker.currentRun).toMatchObject({ dungeonHrid: DEN, currentWave: 5, wavesCompleted: 4 });
        expect(tracker.waveTimes).toEqual([3000, 5000]);
        expect(tracker.waveStartTime.getTime()).toBe(7000);
        expect(tracker.firstKeyCountTimestamp).toBe(500);
        expect(tracker.hibernationDetected).toBe(true);
    });

    test('a record for a different battle is thrown away', async () => {
        game.actions = [{ actionHrid: DEN, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            lastUpdateTime: Date.now(),
        });

        expect(await tracker.restoreInProgressRun(43)).toBe(false);
        expect(tracker.isTracking).toBe(false);
        expect(stored()).toBeUndefined();
    });

    test('a record older than ten minutes is thrown away', async () => {
        game.actions = [{ actionHrid: DEN, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            lastUpdateTime: Date.now() - (10 * 60 * 1000 + 1),
        });

        expect(await tracker.restoreInProgressRun(42)).toBe(false);
        expect(stored()).toBeUndefined();
    });

    test('a record just inside ten minutes still restores', async () => {
        game.actions = [{ actionHrid: DEN, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            lastUpdateTime: Date.now() - (10 * 60 * 1000 - 1000),
            waveTimes: [],
        });

        expect(await tracker.restoreInProgressRun(42)).toBe(true);
    });

    test('a completion seconds ago blocks a restore, however well the record matches', async () => {
        game.actions = [{ actionHrid: DEN, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            lastUpdateTime: Date.now(),
        });
        tracker._lastCompletionTime = Date.now() - 1000;

        expect(await tracker.restoreInProgressRun(42)).toBe(false);
        expect(stored()).toBeUndefined();
    });

    test('the completion block lifts after five seconds', async () => {
        game.actions = [{ actionHrid: DEN, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            lastUpdateTime: Date.now(),
            waveTimes: [],
        });
        tracker._lastCompletionTime = Date.now() - 5001;

        expect(await tracker.restoreInProgressRun(42)).toBe(true);
    });

    test('a record for a dungeon that is no longer running is thrown away', async () => {
        game.actions = [{ actionHrid: LAIR, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            lastUpdateTime: Date.now(),
        });

        expect(await tracker.restoreInProgressRun(42)).toBe(false);
        expect(stored()).toBeUndefined();
    });

    test('a finished dungeon action does not count as still running', async () => {
        game.actions = [{ actionHrid: DEN, isDone: true }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            lastUpdateTime: Date.now(),
        });

        expect(await tracker.restoreInProgressRun(42)).toBe(false);
    });

    test('the other character does not inherit a half-finished den', async () => {
        beTracking();
        await tracker.saveInProgressRun();
        expect(stored('market123')).toBeDefined();

        game.characterId = 'iron456';
        resetTracker();
        game.actions = [{ actionHrid: DEN, isDone: false }];

        expect(await tracker.restoreInProgressRun(42)).toBe(false);
        expect(tracker.isTracking).toBe(false);
        // and the market cow's record is left where it was
        expect(stored('market123')).toBeDefined();
    });

    test('a mid-dungeon new_battle restores rather than inventing a fresh run', async () => {
        game.actions = [{ actionHrid: DEN, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            tier: 0,
            startTime: 1000,
            currentWave: 5,
            maxWaves: 10,
            wavesCompleted: 4,
            waveTimes: [3000],
            lastUpdateTime: Date.now(),
        });

        await tracker.onNewBattle({ wave: 6, battleId: 42, combatStartTime: '2026-08-04T10:00:00.000Z' });
        await flush();

        expect(tracker.isTracking).toBe(true);
        expect(tracker.currentRun.wavesCompleted).toBe(4);
        expect(tracker.currentRun.startTime).toBe(1000);
    });

    test('a mid-dungeon new_battle with nothing to restore starts a run anyway', async () => {
        game.actions = [{ actionHrid: DEN, difficultyTier: 0, isDone: false }];

        await tracker.onNewBattle({ wave: 6, battleId: 42, combatStartTime: '2026-08-04T10:00:00.000Z' });
        await flush();

        expect(tracker.isTracking).toBe(true);
        expect(tracker.currentRun.currentWave).toBe(6);
        expect(tracker.currentRun.wavesCompleted).toBe(0);
    });
});

describe('reading key counts out of party chat', () => {
    test('names and counts, commas and all', () => {
        expect(tracker.parseKeyCountsFromMessage('Key counts: [Alice - 12], [Bob - 1,234]')).toEqual({
            Alice: 12,
            Bob: 1234,
        });
    });

    test('surrounding whitespace in a name is dropped', () => {
        expect(tracker.parseKeyCountsFromMessage('[ Alice  -  3 ]')).toEqual({});
        expect(tracker.parseKeyCountsFromMessage('[ Alice - 3]')).toEqual({ Alice: 3 });
    });

    test('a dash in the name is part of the name, not the separator', () => {
        expect(tracker.parseKeyCountsFromMessage('Key counts: [Moo-Deng - 12], [Alice - 3]')).toEqual({
            'Moo-Deng': 12,
            Alice: 3,
        });
        expect(tracker.parseKeyCountsFromMessage('[a-b-c - 7]')).toEqual({ 'a-b-c': 7 });
    });

    test('a dashed display timestamp is still not a player', () => {
        expect(tracker.parseKeyCountsFromMessage('[16-07 10:00:00] Key counts: [Moo-Deng - 12]')).toEqual({
            'Moo-Deng': 12,
        });
    });

    test('a display timestamp is not mistaken for a player', () => {
        expect(tracker.parseKeyCountsFromMessage('[08/04 10:00:00 AM] Key counts: [Alice - 12]')).toEqual({
            Alice: 12,
        });
    });

    test('nothing parseable yields nothing', () => {
        expect(tracker.parseKeyCountsFromMessage('')).toEqual({});
        expect(tracker.parseKeyCountsFromMessage('Key counts:')).toEqual({});
        expect(tracker.parseKeyCountsFromMessage('[Alice - many]')).toEqual({});
    });

    test('zero is a count like any other', () => {
        expect(tracker.parseKeyCountsFromMessage('[Alice - 0]')).toEqual({ Alice: 0 });
    });
});

describe('routing chat messages', () => {
    test('another channel is ignored entirely', () => {
        tracker.onChatMessage({
            message: {
                chan: '/chat_channel_types/general',
                isSystemMessage: true,
                m: 'systemChatMessage.partyKeyCount',
            },
        });
        expect(tracker.recentChatMessages).toHaveLength(0);
    });

    test('a party message with no message object is ignored', () => {
        expect(() => tracker.onChatMessage({})).not.toThrow();
        expect(tracker.recentChatMessages).toHaveLength(0);
    });

    test('a player message is remembered but changes nothing', () => {
        beTracking();
        tracker.onChatMessage({
            message: { chan: '/chat_channel_types/party', isSystemMessage: false, message: 'gg' },
        });
        expect(tracker.recentChatMessages).toHaveLength(1);
        expect(tracker.firstKeyCountTimestamp).toBeNull();
    });

    test('the message buffer keeps the last hundred', () => {
        for (let i = 0; i < 105; i++) {
            tracker.onChatMessage({
                message: { chan: '/chat_channel_types/party', isSystemMessage: false, message: `m${i}` },
            });
        }
        expect(tracker.recentChatMessages).toHaveLength(100);
        expect(tracker.recentChatMessages[0].message).toBe('m5');
    });

    test('key counts arriving while not tracking are somebody else’s dungeon', () => {
        tracker.onChatMessage(keyCountsData('2026-08-04T10:00:00.000Z', 'Key counts: [Alice - 12]'));
        expect(tracker.firstKeyCountTimestamp).toBeNull();
        expect(tracker.keyCountMessages).toHaveLength(0);
    });

    test('unparseable metadata is reported and dropped', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        beTracking();
        tracker.onChatMessage({
            message: {
                chan: '/chat_channel_types/party',
                isSystemMessage: true,
                m: 'systemChatMessage.partyKeyCount',
                t: '2026-08-04T10:00:00.000Z',
                systemMetadata: '{not json',
            },
        });
        expect(error).toHaveBeenCalled();
        expect(tracker.firstKeyCountTimestamp).toBeNull();
    });

    test('the first key count anchors the run at the server’s clock', async () => {
        // The live path: the run-start message is captured by the post-start
        // scan, which is what leaves firstKeyCountTimestamp set.
        beTracking();
        tracker.recentChatMessages = [
            {
                m: 'systemChatMessage.partyKeyCount',
                t: '2026-08-04T10:00:00.000Z',
                systemMetadata: JSON.stringify({ keyCountString: 'Key counts: [Alice - 12], [Bob - 8]' }),
            },
        ];
        tracker.scanExistingChatMessages();
        await flush();

        const t0 = Date.parse('2026-08-04T10:00:00.000Z');
        expect(tracker.firstKeyCountTimestamp).toBe(t0);
        expect(tracker.lastKeyCountTimestamp).toBe(t0);
        expect(tracker.currentRun.keyCountsMap).toEqual({ Alice: 12, Bob: 8 });
        expect(tracker.keyCountMessages).toHaveLength(1);
        expect(tracker.getPartyMessageDuration()).toBe(0);
    });

    test('a key count on a fresh un-progressed run is the start anchor, not a completion', async () => {
        // The live race the tracker has to survive: a run started here, no wave
        // finished yet, and the run's own "Key counts" message arriving before
        // the 100 ms chat scan gets to it. Reading that as the completion would
        // end the run it was supposed to begin and bank a two-second run.
        const start = Date.parse('2026-08-04T10:00:00.000Z');
        beTracking({ startTime: start, wavesCompleted: 0, currentWave: 0 });
        const completions = [];
        tracker.onUpdate((run, completed) => {
            if (completed) completions.push(completed);
        });

        tracker.onChatMessage(keyCountsData('2026-08-04T10:00:02.000Z', 'Key counts: [Alice - 12]'));
        await flush();

        const anchor = Date.parse('2026-08-04T10:00:02.000Z');
        expect(completions).toHaveLength(0);
        expect(tracker.isTracking).toBe(true);
        expect(tracker.firstKeyCountTimestamp).toBe(anchor);
        expect(tracker.lastKeyCountTimestamp).toBe(anchor);
        expect(tracker.currentRun.keyCountsMap).toEqual({ Alice: 12 });
        expect(game.savedRuns).toHaveLength(0);
    });

    test('the real completion still ends that run, measured from the anchor', async () => {
        const start = Date.parse('2026-08-04T10:00:00.000Z');
        beTracking({ startTime: start, wavesCompleted: 0, currentWave: 0, maxWaves: 10 });
        const completions = [];
        tracker.onUpdate((run, completed) => {
            if (completed) completions.push(completed);
        });

        tracker.onChatMessage(keyCountsData('2026-08-04T10:00:02.000Z', 'Key counts: [Alice - 12]'));
        await flush();
        tracker.onChatMessage(keyCountsData('2026-08-04T10:04:34.000Z', 'Key counts: [Alice - 11]'));
        await flush();

        expect(completions).toHaveLength(1);
        expect(completions[0].validated).toBe(true);
        expect(completions[0].partyMessageDuration).toBe(272_000); // 10:00:02 → 10:04:34
    });

    test('a party failure ends the run', async () => {
        beTracking();
        tracker.onChatMessage({
            message: {
                chan: '/chat_channel_types/party',
                isSystemMessage: true,
                m: 'systemChatMessage.partyFailed',
                t: '2026-08-04T10:04:00.000Z',
            },
        });
        await flush();

        expect(tracker.isTracking).toBe(false);
        expect(tracker.currentRun).toBeNull();
        expect(game.savedRuns).toHaveLength(0);
    });

    test('a battle started for another dungeon ends the run', async () => {
        beTracking({ dungeonHrid: DEN });
        tracker.onChatMessage({
            message: {
                chan: '/chat_channel_types/party',
                isSystemMessage: true,
                m: 'systemChatMessage.partyBattleStarted',
                t: '2026-08-04T10:04:00.000Z',
                systemMetadata: JSON.stringify({ name: 'Sinister Circus' }),
            },
        });
        await flush();

        expect(tracker.isTracking).toBe(false);
    });

    test('a battle started for the same dungeon leaves the run alone', async () => {
        beTracking({ dungeonHrid: DEN });
        tracker.onChatMessage({
            message: {
                chan: '/chat_channel_types/party',
                isSystemMessage: true,
                m: 'systemChatMessage.partyBattleStarted',
                t: '2026-08-04T10:04:00.000Z',
                systemMetadata: JSON.stringify({ name: 'Chimerical Den' }),
            },
        });
        await flush();

        expect(tracker.isTracking).toBe(true);
        expect(tracker.battleStartedTimestamp).toBe(Date.parse('2026-08-04T10:04:00.000Z'));
    });
});

describe('a canceled battle start', () => {
    test('the ended message disarms a run no wave of which ever completed', async () => {
        // The phantom 15:47 "run": a failed ready-check posts Key counts and
        // then Battle ended a second later. The canceled start must not stay
        // armed as a run's beginning, or the next key count — minutes of
        // party-forming later — reads as its completion.
        tracker.onActionsUpdated({ endCharacterActions: [{ actionHrid: DEN, difficultyTier: 0, isDone: false }] });
        await tracker.onNewBattle({ wave: 0, battleId: 9, combatStartTime: '2026-08-04T10:26:30.000Z' });
        tracker.onChatMessage(keyCountsData('2026-08-04T10:26:30.000Z', '[Aster - 95] [Briar - 42]'));
        await flush();
        expect(tracker.isTracking).toBe(true);

        tracker.onChatMessage({
            message: {
                chan: '/chat_channel_types/party',
                isSystemMessage: true,
                m: 'systemChatMessage.partyBattleEnded',
                t: '2026-08-04T10:26:31.000Z',
            },
        });
        await flush();

        expect(tracker.isTracking).toBe(false);
        expect(tracker.firstKeyCountTimestamp).toBeNull();

        // The next key count, however much later, completes nothing
        tracker.onChatMessage(keyCountsData('2026-08-04T10:42:17.000Z', '[Aster - 95] [cove - 42]'));
        await flush();
        expect(mockStorage.storeFor('settings').get(`dungeonTracker_teamRuns_${game.characterId}`)).toBeUndefined();
    });

    test('a fight with waves already banked is left to the action feed', async () => {
        await beTracking({ wavesCompleted: 3 });

        tracker.onChatMessage({
            message: {
                chan: '/chat_channel_types/party',
                isSystemMessage: true,
                m: 'systemChatMessage.partyBattleEnded',
                t: '2026-08-04T10:26:31.000Z',
            },
        });
        await flush();

        expect(tracker.isTracking).toBe(true);
    });
});

describe('finishing a run', () => {
    test('a second key count completes it, and the server’s clock is the duration', async () => {
        beTracking({
            waveTimes: [3000, 5000, 4000],
            maxWaves: 10,
            wavesCompleted: 10,
            keyCountsMap: { Alice: 12, Bob: 8 },
            anchoredAt: '2026-08-04T10:00:00.000Z',
        });
        const completions = [];
        tracker.onUpdate((run, completed) => {
            if (completed) completions.push(completed);
        });

        tracker.onChatMessage(keyCountsData('2026-08-04T10:04:32.000Z', 'Key counts: [Alice - 11], [Bob - 7]'));
        await flush();

        expect(tracker.isTracking).toBe(false);
        expect(tracker.currentRun).toBeNull();
        expect(completions).toHaveLength(1);

        const run = completions[0];
        expect(run.validated).toBe(true);
        expect(run.partyMessageDuration).toBe(272_000); // 4m32s between the two messages
        expect(run.totalTime).toBe(272_000);
        expect(run.avgWaveTime).toBe(4000); // (3000 + 5000 + 4000) / 3
        expect(run.fastestWave).toBe(3000);
        expect(run.slowestWave).toBe(5000);
        expect(run.wavesCompleted).toBe(10);
        expect(run.keyCountsMap).toEqual({ Alice: 11, Bob: 7 });
        expect(run.keyCountMessages).toHaveLength(2);
    });

    test('the completed run reaches history under the sorted team key', async () => {
        beTracking({ keyCountsMap: { Bob: 8, Alice: 12 }, anchoredAt: '2026-08-04T10:00:00.000Z' });
        tracker.onChatMessage(keyCountsData('2026-08-04T10:04:32.000Z', 'Key counts: [Bob - 7], [Alice - 11]'));
        await flush();

        expect(game.savedRuns).toHaveLength(1);
        expect(game.savedRuns[0].teamKey).toBe('Alice,Bob');
        expect(game.savedRuns[0].run).toEqual({
            timestamp: '2026-08-04T10:00:00.000Z',
            duration: 272_000,
            dungeonName: 'Chimerical Den',
            dungeonHrid: '/actions/combat/chimerical_den',
            tier: 0,
            keyCountsMap: { Alice: 11, Bob: 7 },
        });
    });

    test('the in-progress record is cleared when the run ends', async () => {
        beTracking({ keyCountsMap: { Alice: 12 }, anchoredAt: '2026-08-04T10:00:00.000Z' });
        await tracker.saveInProgressRun();
        expect(stored()).toBeDefined();

        tracker.onChatMessage(keyCountsData('2026-08-04T10:04:32.000Z', 'Key counts: [Alice - 11]'));
        await flush();

        expect(stored()).toBeUndefined();
        expect(tracker._lastCompletionTime).toBeGreaterThan(0);
    });

    test('a run with only a start message is not server-validated and is not saved', async () => {
        vi.useFakeTimers();
        const start = Date.parse('2026-08-04T10:00:00.000Z');
        vi.setSystemTime(start + 300_000);
        beTracking({ startTime: start, maxWaves: 10, wavesCompleted: 10, waveTimes: [] });
        tracker.firstKeyCountTimestamp = start;
        tracker.lastKeyCountTimestamp = start;

        const completions = [];
        tracker.onUpdate((run, completed) => {
            if (completed) completions.push(completed);
        });

        await tracker.completeDungeon();

        expect(completions[0].validated).toBe(false);
        expect(completions[0].partyMessageDuration).toBeNull();
        expect(completions[0].totalTime).toBe(300_000); // falls back to the tracked wall clock
        expect(completions[0].avgWaveTime).toBe(0);
        expect(game.savedRuns).toHaveLength(0);
    });

    test('the completion timestamp becomes the next run’s start anchor', async () => {
        beTracking({ keyCountsMap: { Alice: 12 }, anchoredAt: '2026-08-04T10:00:00.000Z' });
        tracker.onChatMessage(keyCountsData('2026-08-04T10:04:32.000Z', 'Key counts: [Alice - 11]'));
        await flush();

        const completion = Date.parse('2026-08-04T10:04:32.000Z');
        expect(tracker.pendingNextRunFirstKeyCount).toBe(completion);

        game.actions = [{ actionHrid: DEN, difficultyTier: 0, isDone: false }];
        await tracker.onNewBattle({ wave: 0, battleId: 43, combatStartTime: '2026-08-04T10:04:33.000Z' });
        await flush();

        expect(tracker.firstKeyCountTimestamp).toBe(completion);
        expect(tracker.lastKeyCountTimestamp).toBe(completion);
        expect(tracker.pendingNextRunFirstKeyCount).toBeNull();
    });

    test('a run part way through its waves treats an unanchored key count as the completion', async () => {
        // Not restored, but four waves deep: the start message must have been
        // missed, because the run has plainly been going for a while.
        beTracking({ startTime: Date.parse('2026-08-04T10:00:00.000Z'), maxWaves: 10, wavesCompleted: 4 });
        tracker.firstKeyCountTimestamp = null;
        tracker.lastKeyCountTimestamp = null;

        const completions = [];
        tracker.onUpdate((run, completed) => {
            if (completed) completions.push(completed);
        });

        tracker.onChatMessage(keyCountsData('2026-08-04T10:04:32.000Z', 'Key counts: [Alice - 11]'));
        await flush();

        expect(completions).toHaveLength(1);
        expect(completions[0].partyMessageDuration).toBe(272_000);
    });

    test('a websocket completion does not hand its start anchor to the next run', async () => {
        // The run ended on action_completed, so lastKeyCountTimestamp is still
        // this run's START. Carrying it forward would make the next run measure
        // both runs as one.
        const firstStart = Date.parse('2026-08-04T10:00:00.000Z');
        beTracking({
            currentWave: 10,
            wavesCompleted: 9,
            maxWaves: 10,
            keyCountsMap: { Alice: 12 },
            anchoredAt: '2026-08-04T10:00:00.000Z',
        });
        const completions = [];
        tracker.onUpdate((run, completed) => {
            if (completed) completions.push(completed);
        });

        tracker.onActionCompleted({ endCharacterAction: { actionHrid: DEN, wave: 0, isDone: true } });
        await flush();

        expect(completions).toHaveLength(1);
        expect(tracker.pendingNextRunFirstKeyCount).toBeNull();

        // The next run anchors on its own key count, and is measured on its own
        game.actions = [{ actionHrid: DEN, difficultyTier: 0, isDone: false }];
        await tracker.onNewBattle({ wave: 0, battleId: 43, combatStartTime: '2026-08-04T10:05:00.000Z' });
        await flush();

        expect(tracker.firstKeyCountTimestamp).toBeNull();

        tracker.onChatMessage(keyCountsData('2026-08-04T10:05:01.000Z', 'Key counts: [Alice - 11]'));
        await flush();
        tracker.onChatMessage(keyCountsData('2026-08-04T10:09:33.000Z', 'Key counts: [Alice - 10]'));
        await flush();

        expect(completions).toHaveLength(2);
        expect(completions[1].partyMessageDuration).toBe(272_000); // this run alone
        expect(completions[1].partyMessageDuration).toBeLessThan(Date.now() - firstStart);
    });

    test('a restored run treats its first key count as the completion', async () => {
        // Restored mid-run: the start message was never seen, so the run's own
        // startTime stands in for it and this message ends the run.
        beTracking({
            startTime: Date.parse('2026-08-04T10:00:00.000Z'),
            maxWaves: 10,
            wavesCompleted: 10,
            restored: true,
        });
        tracker.firstKeyCountTimestamp = null;
        tracker.lastKeyCountTimestamp = null;

        const completions = [];
        tracker.onUpdate((run, completed) => {
            if (completed) completions.push(completed);
        });

        tracker.onChatMessage(keyCountsData('2026-08-04T10:04:32.000Z', 'Key counts: [Alice - 11]'));
        await flush();

        expect(completions).toHaveLength(1);
        expect(completions[0].validated).toBe(true);
        expect(completions[0].partyMessageDuration).toBe(272_000);
    });

    test('completing twice does nothing the second time', async () => {
        beTracking();
        tracker.firstKeyCountTimestamp = 1000;
        tracker.lastKeyCountTimestamp = 2000;
        const completions = [];
        tracker.onUpdate((run, completed) => {
            if (completed) completions.push(completed);
        });

        await tracker.completeDungeon();
        await tracker.completeDungeon();

        expect(completions).toHaveLength(1);
    });

    test('a callback that throws does not stop the others', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        beTracking();
        const seen = [];
        tracker.onUpdate(() => {
            throw new Error('boom');
        });
        tracker.onUpdate((run, completed) => seen.push(completed ?? 'update'));

        await tracker.completeDungeon();

        expect(seen.length).toBeGreaterThan(0);
        expect(error).toHaveBeenCalled();
    });

    test('a removed callback stops hearing about updates', () => {
        const calls = [];
        const cb = () => calls.push(1);
        tracker.onUpdate(cb);
        tracker.notifyUpdate();
        tracker.offUpdate(cb);
        tracker.notifyUpdate();
        expect(calls).toHaveLength(1);
    });
});

describe('waves completing over the websocket', () => {
    test('a wave completion records its time and advances the count', async () => {
        vi.useFakeTimers();
        const start = Date.parse('2026-08-04T10:00:00.000Z');
        vi.setSystemTime(start + 4000);
        beTracking({ startTime: start, currentWave: 3, wavesCompleted: 2 });

        tracker.onActionCompleted({ endCharacterAction: { actionHrid: DEN, wave: 3, isDone: false } });
        await flush();

        expect(tracker.waveTimes).toEqual([4000]);
        expect(tracker.currentRun.wavesCompleted).toBe(3);
        expect(tracker.isTracking).toBe(true);
    });

    test('the last wave reports itself as wave 0, and the run still counts fifty', async () => {
        beTracking({ currentWave: 10, wavesCompleted: 9, maxWaves: 10 });
        const completions = [];
        tracker.onUpdate((run, completed) => {
            if (completed) completions.push(completed);
        });

        tracker.onActionCompleted({ endCharacterAction: { actionHrid: DEN, wave: 0, isDone: true } });
        await flush();

        expect(completions).toHaveLength(1);
        expect(completions[0].wavesCompleted).toBe(10);
    });

    test('finishing early is a reset, not a completion', async () => {
        beTracking({ currentWave: 4, wavesCompleted: 3, maxWaves: 10 });
        await tracker.saveInProgressRun();
        const completions = [];
        tracker.onUpdate((run, completed) => {
            if (completed) completions.push(completed);
        });

        tracker.onActionCompleted({ endCharacterAction: { actionHrid: DEN, wave: 4, isDone: true } });
        await flush();

        expect(completions).toHaveLength(0);
        expect(tracker.isTracking).toBe(false);
        expect(tracker.currentRun).toBeNull();
        expect(stored()).toBeUndefined();
    });

    test('a restored run with no wave start time records no wave time', async () => {
        beTracking({ currentWave: 5, wavesCompleted: 4 });
        tracker.waveStartTime = null;

        tracker.onActionCompleted({ endCharacterAction: { actionHrid: DEN, wave: 5, isDone: false } });
        await flush();

        expect(tracker.waveTimes).toEqual([]);
        expect(tracker.currentRun.wavesCompleted).toBe(5);
    });

    test('an ordinary combat zone completion is not a wave', () => {
        beTracking();
        tracker.onActionCompleted({ endCharacterAction: { actionHrid: FLY, wave: 3, isDone: true } });
        expect(tracker.isTracking).toBe(true);
        expect(tracker.waveTimes).toEqual([]);
    });

    test('a dungeon action with no wave field is not a wave either', () => {
        beTracking();
        tracker.onActionCompleted({ endCharacterAction: { actionHrid: DEN, isDone: true } });
        expect(tracker.isTracking).toBe(true);
        expect(tracker.waveTimes).toEqual([]);
    });

    test('nothing happens when not tracking', () => {
        tracker.onActionCompleted({ endCharacterAction: { actionHrid: DEN, wave: 3, isDone: true } });
        expect(tracker.isTracking).toBe(false);
    });
});

describe('the action queue changing under the run', () => {
    test('a dungeon marked done before the waves ran out ends the run', async () => {
        beTracking({ wavesCompleted: 4, maxWaves: 10 });
        tracker.onActionsUpdated({ endCharacterActions: [{ actionHrid: DEN, isDone: true }] });
        await flush();
        expect(tracker.isTracking).toBe(false);
    });

    test('a dungeon marked done with every wave finished is left for action_completed', async () => {
        beTracking({ wavesCompleted: 10, maxWaves: 10 });
        tracker.onActionsUpdated({ endCharacterActions: [{ actionHrid: DEN, isDone: true }] });
        await flush();
        expect(tracker.isTracking).toBe(true);
    });

    test('a non-dungeon action in the queue is ignored', () => {
        tracker.onActionsUpdated({ endCharacterActions: [{ actionHrid: FLY, isDone: false }] });
        expect(tracker.pendingDungeonInfo).toBeNull();
    });

    test('a message with no actions is harmless', () => {
        expect(() => tracker.onActionsUpdated({})).not.toThrow();
    });
});

describe('what the panel is shown', () => {
    test('nothing while there is no run', () => {
        expect(tracker.getCurrentRun()).toBeNull();
    });

    test('elapsed time is measured from the server’s start, not the local one', () => {
        vi.useFakeTimers();
        const serverStart = Date.parse('2026-08-04T10:00:00.000Z');
        vi.setSystemTime(serverStart + 120_000);
        beTracking({ startTime: serverStart + 30_000, waveTimes: [4000, 6000], wavesCompleted: 2, maxWaves: 10 });
        tracker.waveStartTime = new Date(serverStart + 100_000);
        tracker.firstKeyCountTimestamp = serverStart;

        const run = tracker.getCurrentRun();

        expect(run.totalElapsed).toBe(120_000);
        expect(run.currentWaveElapsed).toBe(20_000);
        expect(run.avgWaveTime).toBe(5000);
        expect(run.fastestWave).toBe(4000);
        expect(run.slowestWave).toBe(6000);
        expect(run.estimatedTimeRemaining).toBe(40_000); // 8 waves left at 5s each
        expect(run.dungeonName).toBe('Chimerical Den');
    });

    test('without a server timestamp the tracked start is used', () => {
        vi.useFakeTimers();
        const start = Date.parse('2026-08-04T10:00:00.000Z');
        vi.setSystemTime(start + 60_000);
        beTracking({ startTime: start, waveTimes: [] });

        const run = tracker.getCurrentRun();
        expect(run.totalElapsed).toBe(60_000);
        expect(run.estimatedTimeRemaining).toBe(0);
        expect(run.avgWaveTime).toBe(0);
    });
});

describe('waking the computer back up', () => {
    test('a run that spanned a hidden tab is flagged as possibly wrong', async () => {
        tracker.setupHibernationDetection();
        beTracking();

        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        document.dispatchEvent(new Event('visibilitychange'));
        await flush();

        expect(tracker.hibernationDetected).toBe(true);
        expect(tracker.getCurrentRun().hibernationDetected).toBe(true);
        expect(stored().hibernationDetected).toBe(true);
    });

    test('a hidden tab outside a run flags nothing', () => {
        tracker.setupHibernationDetection();

        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        document.dispatchEvent(new Event('visibilitychange'));

        expect(tracker.hibernationDetected).toBe(false);
    });

    test('a new run starts unflagged', async () => {
        tracker.hibernationDetected = true;
        game.actions = [{ actionHrid: DEN, difficultyTier: 0, isDone: false }];

        await tracker.onNewBattle({ wave: 0, battleId: 5, combatStartTime: '2026-08-04T10:00:00.000Z' });
        await flush();

        expect(tracker.hibernationDetected).toBe(false);
        expect(tracker.currentRun.hibernationDetected).toBe(false);
    });
});

describe('picking the run back up on page load', () => {
    test('a saved record for the running dungeon is restored without a battle message', async () => {
        game.actions = [{ actionHrid: DEN, difficultyTier: 0, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            tier: 0,
            startTime: 1000,
            currentWave: 5,
            maxWaves: 10,
            wavesCompleted: 4,
            waveTimes: [3000],
            lastUpdateTime: Date.now(),
        });

        await tracker.checkForActiveDungeon();

        expect(tracker.isTracking).toBe(true);
        expect(tracker.currentRun.wavesCompleted).toBe(4);
    });

    test('a stale record is dropped and the dungeon merely noted as pending', async () => {
        game.actions = [{ actionHrid: DEN, difficultyTier: 1, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            lastUpdateTime: Date.now() - 11 * 60 * 1000,
        });

        await tracker.checkForActiveDungeon();

        expect(tracker.isTracking).toBe(false);
        expect(stored()).toBeUndefined();
        expect(tracker.pendingDungeonInfo).toEqual({ dungeonHrid: DEN, tier: 1 });
    });

    test('no dungeon running means nothing to pick up', async () => {
        game.actions = [{ actionHrid: FLY, isDone: false }];
        await tracker.checkForActiveDungeon();
        expect(tracker.isTracking).toBe(false);
        expect(tracker.pendingDungeonInfo).toBeNull();
    });

    test('a completion seconds ago blocks the page-load pickup too', async () => {
        // The same guard restoreInProgressRun applies: the record belongs to the
        // run that just ended, and its clear may still be in flight.
        game.actions = [{ actionHrid: DEN, difficultyTier: 1, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            wavesCompleted: 4,
            lastUpdateTime: Date.now(),
        });
        tracker._lastCompletionTime = Date.now() - 1000;

        await tracker.checkForActiveDungeon();

        expect(tracker.isTracking).toBe(false);
        expect(stored()).toBeUndefined();
        expect(tracker.pendingDungeonInfo).toEqual({ dungeonHrid: DEN, tier: 1 });
    });

    test('a record with no battle to tie it to is not picked up', async () => {
        game.actions = [{ actionHrid: DEN, difficultyTier: 1, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            dungeonHrid: DEN,
            wavesCompleted: 4,
            lastUpdateTime: Date.now(),
        });

        await tracker.checkForActiveDungeon();

        expect(tracker.isTracking).toBe(false);
        expect(stored()).toBeUndefined();
        expect(tracker.pendingDungeonInfo).toEqual({ dungeonHrid: DEN, tier: 1 });
    });

    test('a picked-up run keeps the hibernation flag it was saved with', async () => {
        game.actions = [{ actionHrid: DEN, difficultyTier: 0, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            tier: 0,
            startTime: 1000,
            currentWave: 5,
            maxWaves: 10,
            wavesCompleted: 4,
            waveTimes: [3000],
            lastUpdateTime: Date.now(),
            hibernationDetected: true,
        });

        await tracker.checkForActiveDungeon();

        expect(tracker.hibernationDetected).toBe(true);
        expect(tracker.currentRun.hibernationDetected).toBe(true);
        expect(tracker.getCurrentRun().hibernationDetected).toBe(true);
    });

    test('a picked-up run reads its next key count as the completion', async () => {
        // Restored, so its own start message was never seen — even at wave 0.
        game.actions = [{ actionHrid: DEN, difficultyTier: 0, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            tier: 0,
            startTime: Date.parse('2026-08-04T10:00:00.000Z'),
            currentWave: 1,
            maxWaves: 10,
            wavesCompleted: 0,
            lastUpdateTime: Date.now(),
        });

        await tracker.checkForActiveDungeon();
        expect(tracker.restoredMidRun).toBe(true);

        const completions = [];
        tracker.onUpdate((run, completed) => {
            if (completed) completions.push(completed);
        });

        tracker.onChatMessage(keyCountsData('2026-08-04T10:04:32.000Z', 'Key counts: [Alice - 11]'));
        await flush();

        expect(completions).toHaveLength(1);
        expect(completions[0].partyMessageDuration).toBe(272_000);
    });

    test('a record for a different dungeon only leaves pending info', async () => {
        game.actions = [{ actionHrid: LAIR, difficultyTier: 0, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            lastUpdateTime: Date.now(),
        });

        await tracker.checkForActiveDungeon();

        expect(tracker.isTracking).toBe(false);
        expect(tracker.pendingDungeonInfo).toEqual({ dungeonHrid: LAIR, tier: 0 });
    });
});

describe('scanning chat already on screen', () => {
    test('the newest key counts in memory become the run’s counts', async () => {
        beTracking();
        tracker.recentChatMessages = [
            {
                m: 'systemChatMessage.partyBattleStarted',
                t: '2026-08-04T09:59:00.000Z',
            },
            {
                m: 'systemChatMessage.partyKeyCount',
                t: '2026-08-04T10:00:00.000Z',
                systemMetadata: JSON.stringify({ keyCountString: 'Key counts: [Alice - 12], [Bob - 8]' }),
            },
        ];

        tracker.scanExistingChatMessages();
        await flush();

        expect(tracker.currentRun.keyCountsMap).toEqual({ Alice: 12, Bob: 8 });
        expect(tracker.firstKeyCountTimestamp).toBe(Date.parse('2026-08-04T10:00:00.000Z'));
        expect(tracker.lastKeyCountTimestamp).toBe(tracker.firstKeyCountTimestamp);
        expect(tracker.battleStartedTimestamp).toBe(Date.parse('2026-08-04T09:59:00.000Z'));
        expect(tracker.keyCountMessages).toHaveLength(1);
    });

    test('an anchor already carried forward is not overwritten by the scan', async () => {
        beTracking();
        tracker.firstKeyCountTimestamp = 1234;
        tracker.lastKeyCountTimestamp = 1234;
        tracker.recentChatMessages = [
            {
                m: 'systemChatMessage.partyKeyCount',
                t: '2026-08-04T10:00:00.000Z',
                systemMetadata: JSON.stringify({ keyCountString: 'Key counts: [Alice - 12]' }),
            },
        ];

        tracker.scanExistingChatMessages();
        await flush();

        expect(tracker.firstKeyCountTimestamp).toBe(1234);
        expect(tracker.currentRun.keyCountsMap).toEqual({ Alice: 12 });
    });

    test('scanning while not tracking does nothing', () => {
        tracker.recentChatMessages = [
            {
                m: 'systemChatMessage.partyKeyCount',
                t: '2026-08-04T10:00:00.000Z',
                systemMetadata: JSON.stringify({ keyCountString: 'Key counts: [Alice - 12]' }),
            },
        ];
        tracker.scanExistingChatMessages();
        expect(tracker.firstKeyCountTimestamp).toBeNull();
    });
});

describe('rebuilding history from the chat log', () => {
    function chatLog(entries) {
        document.body.innerHTML = '';
        for (const entry of entries) {
            const node = document.createElement('div');
            node.className = 'ChatMessage_chatMessage__abc';
            if (entry.username) {
                const name = document.createElement('span');
                name.className = 'ChatMessage_username__x';
                name.textContent = entry.username;
                node.appendChild(name);
            }
            const body = document.createElement('span');
            body.textContent = entry.text;
            node.appendChild(body);
            document.body.appendChild(node);
        }
    }

    const year = new Date().getFullYear();
    const at = (h, m, s) => new Date(year, 7, 4, h, m, s, 0);

    test('a key-to-key pair becomes a run, dated and named', async () => {
        chatLog([
            { text: '[08/04 10:00:00 AM] Battle started: Chimerical Den' },
            { text: '[08/04 10:00:05 AM] Key counts: [Alice - 12], [Bob - 8]' },
            { text: '[08/04 10:04:37 AM] Key counts: [Alice - 11], [Bob - 7]' },
        ]);

        const result = await tracker.backfillFromChatHistory();

        expect(result.runsAdded).toBe(1);
        expect(result.teams).toEqual(['Alice,Bob']);
        expect(game.savedRuns).toHaveLength(1);
        expect(game.savedRuns[0].run).toEqual({
            timestamp: at(10, 0, 5).toISOString(),
            duration: 272_000,
            dungeonName: 'Chimerical Den',
        });
    });

    test('a failed run is not a run', async () => {
        chatLog([
            { text: '[08/04 10:00:00 AM] Battle started: Chimerical Den' },
            { text: '[08/04 10:00:05 AM] Key counts: [Alice - 12]' },
            { text: '[08/04 10:02:00 AM] Party failed on wave 7' },
        ]);

        const result = await tracker.backfillFromChatHistory();

        expect(result.runsAdded).toBe(0);
        expect(game.savedRuns).toHaveLength(0);
    });

    test('a canceled run is not a run either', async () => {
        chatLog([
            { text: '[08/04 10:00:00 AM] Battle started: Chimerical Den' },
            { text: '[08/04 10:00:05 AM] Key counts: [Alice - 12]' },
            { text: '[08/04 10:02:00 AM] Battle ended: Chimerical Den' },
        ]);

        expect((await tracker.backfillFromChatHistory()).runsAdded).toBe(0);
    });

    test('player chatter is skipped, however much it looks like a key count', async () => {
        chatLog([
            { text: '[08/04 10:00:00 AM] Battle started: Chimerical Den' },
            { username: 'Alice', text: 'Alice: Key counts: [Alice - 99]' },
            { text: 'Someone: Key counts: [Bob - 99]' },
            { text: '[08/04 10:00:05 AM] Key counts: [Alice - 12]' },
            { text: '[08/04 10:04:37 AM] Key counts: [Alice - 11]' },
        ]);

        const result = await tracker.backfillFromChatHistory();

        expect(result.runsAdded).toBe(1);
        expect(result.teams).toEqual(['Alice']);
    });

    test("player chatter under the game's current markup is skipped too", async () => {
        // The game renamed ChatMessage_username to ChatMessage_name with a
        // CharacterName element inside, and player messages open with a
        // [timestamp] — which also defeats the text fallback. Only the class
        // check can catch these; live DOM verified 2026-08-17.
        chatLog([
            { text: '[08/04 10:00:00 AM] Battle started: Chimerical Den' },
            { text: '[08/04 10:00:05 AM] Key counts: [Alice - 12]' },
            { text: '[08/04 10:04:37 AM] Key counts: [Alice - 11]' },
        ]);
        const chatter = document.createElement('div');
        chatter.className = 'ChatMessage_chatMessage__abc';
        const name = document.createElement('span');
        name.className = 'ChatMessage_name__1UZ8t';
        const inner = document.createElement('span');
        inner.className = 'CharacterName_name__1amXp';
        inner.textContent = 'Mallory';
        name.appendChild(inner);
        chatter.appendChild(name);
        const body = document.createElement('span');
        body.textContent = '[08/04 10:02:00 AM] Mallory: Key counts: [Mallory - 99]';
        chatter.appendChild(body);
        document.body.insertBefore(chatter, document.body.children[2]);

        const result = await tracker.backfillFromChatHistory();

        expect(result.runsAdded).toBe(1);
        expect(result.teams).toEqual(['Alice']);
    });

    test('three key counts in a row are two runs', async () => {
        chatLog([
            { text: '[08/04 10:00:00 AM] Battle started: Chimerical Den' },
            { text: '[08/04 10:00:00 AM] Key counts: [Alice - 12]' },
            { text: '[08/04 10:05:00 AM] Key counts: [Alice - 11]' },
            { text: '[08/04 10:10:00 AM] Key counts: [Alice - 10]' },
        ]);

        const result = await tracker.backfillFromChatHistory();

        expect(result.runsAdded).toBe(2);
        expect(game.savedRuns.map((r) => r.run.duration)).toEqual([300_000, 300_000]);
    });

    test('an empty chat is not an error', async () => {
        chatLog([]);
        expect(await tracker.backfillFromChatHistory()).toEqual({ runsAdded: 0, teams: [] });
    });

    test('messages without a parseable timestamp are skipped', async () => {
        chatLog([{ text: 'Key counts: [Alice - 12]' }, { text: 'Key counts: [Alice - 11]' }]);
        expect((await tracker.backfillFromChatHistory()).runsAdded).toBe(0);
    });
});

describe('switching characters', () => {
    test('cleanup unhooks everything and forgets the run', async () => {
        await tracker.initialize();
        expect(Object.keys(game.wsHandlers).sort()).toEqual([
            'action_completed',
            'actions_updated',
            'chat_message_received',
            'new_battle',
        ]);

        beTracking();
        await tracker.saveInProgressRun();

        await tracker.cleanup();

        expect(Object.keys(game.wsHandlers)).toHaveLength(0);
        expect(tracker.isTracking).toBe(false);
        expect(tracker.currentRun).toBeNull();
        expect(tracker.recentChatMessages).toEqual([]);
        expect(tracker.isInitialized).toBe(false);
        expect(stored()).toBeUndefined();
    });

    test('a record read that lands after the switch is not restored', async () => {
        game.actions = [{ actionHrid: DEN, difficultyTier: 0, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            tier: 0,
            startTime: 1000,
            currentWave: 5,
            maxWaves: 10,
            wavesCompleted: 4,
            waveTimes: [3000],
            lastUpdateTime: Date.now(),
        });

        // The read was issued for market123; the player is on the alt by the
        // time it lands. Restoring now would leave the alt tracking the main's
        // run — and the run that eventually completes is written into the alt's
        // history with the main's start time and wave times.
        mockStorage.get.mockImplementationOnce(async (key, storeName = 'settings', fallback = null) => {
            game.characterId = 'alt456';
            const store = mockStorage.storeFor(storeName);
            return store.has(key) && store.get(key) != null ? store.get(key) : fallback;
        });

        await tracker.checkForActiveDungeon();

        expect(tracker.isTracking).toBe(false);
        expect(tracker.currentRun).toBeNull();
    });

    test('a mid-run restore that lands after the switch is refused', async () => {
        game.actions = [{ actionHrid: DEN, difficultyTier: 0, isDone: false }];
        mockStorage.storeFor('settings').set(`${IN_PROGRESS}_market123`, {
            battleId: 42,
            dungeonHrid: DEN,
            tier: 0,
            startTime: 1000,
            currentWave: 5,
            maxWaves: 10,
            wavesCompleted: 4,
            waveTimes: [3000],
            lastUpdateTime: Date.now(),
        });

        mockStorage.get.mockImplementationOnce(async (key, storeName = 'settings', fallback = null) => {
            game.characterId = 'alt456';
            const store = mockStorage.storeFor(storeName);
            return store.has(key) && store.get(key) != null ? store.get(key) : fallback;
        });

        expect(await tracker.restoreInProgressRun(42)).toBe(false);
        expect(tracker.isTracking).toBe(false);
        // Refused, not cleared: the record still belongs to the character who
        // is mid-run in it
        expect(mockStorage.storeFor('settings').has(`${IN_PROGRESS}_market123`)).toBe(true);
    });

    test('initialising twice hooks the websocket once', async () => {
        await tracker.initialize();
        const first = game.wsHandlers.new_battle;
        await tracker.initialize();
        expect(game.wsHandlers.new_battle).toBe(first);
        await tracker.cleanup();
    });
});
