/**
 * The tracker's websocket handlers: a run that is already going when the
 * script comes up (a page load mid-run) must still get a session — the
 * count-1 attempt was never seen, and nothing flagged a pending start.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({
    handlers: {},
    current: null,
    calls: [],
    costs: [],
    actions: [],
    characterData: null,
}));

const trackerMock = vi.hoisted(() => {
    const mock = {
        isInitialized: true,
        pendingSessionStart: false,
        getCurrentSession: () => state.current,
        findExtendableSession: () => null,
        startSession: vi.fn(async (itemHrid, startLevel, targetLevel, protectFrom) => {
            state.calls.push(['start', itemHrid, startLevel, targetLevel, protectFrom]);
            state.current = { id: 's1', itemHrid, startLevel, targetLevel, protectFrom, totalXP: 0, lastAttempt: null };
            return 's1';
        }),
        recordSuccess: vi.fn(async (...a) => state.calls.push(['success', ...a])),
        recordFailure: vi.fn(async (...a) => state.calls.push(['failure', ...a])),
        trackCoinCost: async (...a) => state.costs.push(['coin', ...a]),
        trackMaterialCost: async (...a) => state.costs.push(['mat', ...a]),
        saveSessions: async () => {},
        trackProtectionCost: vi.fn(async (...a) => state.calls.push(['prot', ...a])),
        extendSessionTarget: vi.fn(async (sessionId, newTarget) => {
            state.calls.push(['extend', sessionId, newTarget]);
            state.current = {
                id: sessionId,
                itemHrid: '/items/enchanted_cloak_refined',
                totalXP: 0,
                lastAttempt: null,
            };
            return true;
        }),
        finalizeCurrentSession: vi.fn(async (...a) => {
            state.calls.push(['finalize', ...a]);
            state.current = null;
        }),
        // Mirrors the real tracker: arms the same flag the handler itself checks/clears, so a
        // bootstrapped pending start actually drives the next action_completed in tests.
        setPendingStart: vi.fn(() => {
            state.calls.push(['pendingStart']);
            mock.pendingSessionStart = true;
        }),
    };
    return mock;
});

vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, fn) => {
            state.handlers[type] = fn;
        },
        off: () => {},
    },
}));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({
            itemDetailMap: {
                '/items/enchanted_cloak_refined': {
                    name: 'Enchanted Cloak ★',
                    sellPrice: 5000,
                    enhancementCosts: [
                        { itemHrid: '/items/holy_cheese', count: 2 },
                        { itemHrid: '/items/coin', count: 900 },
                    ],
                },
                '/items/mirror_of_protection': { name: 'Mirror of Protection', sellPrice: 1250 },
                // Shaped as the live itemDetailMap has it: every _refined item names its base
                '/items/kraken_chaps_refined': {
                    name: 'Kraken Chaps (R)',
                    baseItemHrids: ['/items/kraken_chaps'],
                    enhancementCosts: [{ itemHrid: '/items/holy_cheese', count: 3 }],
                },
                '/items/kraken_chaps': { name: 'Kraken Chaps', sellPrice: 7000 },
                '/items/philosophers_mirror': { name: "Philosopher's Mirror", sellPrice: 90000 },
            },
        }),
        getCurrentActions: () => state.actions,
        get characterData() {
            return state.characterData;
        },
        on: (type, fn) => {
            state.handlers[type] = fn;
        },
        off: (type, fn) => {
            if (state.handlers[type] === fn) delete state.handlers[type];
        },
    },
}));
vi.mock('../../api/marketplace.js', () => ({ default: { getPrice: () => null } }));
vi.mock('./enhancement-xp.js', () => ({
    calculateSuccessXP: () => 0,
    calculateFailureXP: () => 0,
    calculateAdjustedAttemptCount: () => 1,
}));
vi.mock('./tooltip-enhancement.js', () => ({ getEnhancementMaterialPrice: () => 0 }));
vi.mock('./enhancement-ui.js', () => ({ default: { switchToSession: () => {}, scheduleUpdate: () => {} } }));
vi.mock('./enhancement-tracker.js', () => ({ default: trackerMock }));

const { setupEnhancementHandlers, cleanupEnhancementHandlers } = await import('./enhancement-handlers.js');

const cachedEnhanceAction = (extra = {}) => ({
    actionHrid: '/actions/enhancing/enhance',
    isDone: false,
    ordinal: 3,
    currentCount: 2070,
    primaryItemHash: '30404::/item_locations/inventory::/items/enchanted_cloak_refined::5',
    enhancingMaxLevel: 15,
    enhancingProtectionMinLevel: 2,
    ...extra,
});

const attempt = (level, currentCount) => ({
    endCharacterAction: {
        actionHrid: '/actions/enhancing/enhance',
        currentCount,
        primaryItemHash: `30404::/item_locations/inventory::/items/enchanted_cloak_refined::${level}`,
        secondaryItemHash: '30404::/item_locations/inventory::/items/mirror_of_protection::0',
        enhancingMaxLevel: 15,
        enhancingProtectionMinLevel: 2,
    },
});

beforeEach(() => {
    state.handlers = {};
    state.current = null;
    state.calls = [];
    state.costs = [];
    state.actions = [];
    state.characterData = null;
    trackerMock.pendingSessionStart = false;
    setupEnhancementHandlers();
});

describe('a run already going when the script comes up', () => {
    test('gets a session from the attempt in hand, and records from the next one on', async () => {
        // Count 78 with no session and no pending start: the page loaded mid-run
        await state.handlers.action_completed(attempt(5, 78));
        // Started, and not charged a protection: level 5 → 5 on the first attempt is
        // only the baseline, not a protected failure
        expect(state.calls).toEqual([['start', '/items/enchanted_cloak_refined', 5, 15, 2]]);

        // The next attempt has a baseline and is recorded
        await state.handlers.action_completed(attempt(6, 79));
        expect(state.calls.at(-1)).toEqual(['success', 5, 6, false]);
    });

    test('below the protection threshold, the inferred start level is one below the result — matching the other two "first observed attempt" paths', async () => {
        // Picked up mid-run at a low level: the result (1) is below the +2
        // protection threshold, so it can only have come from a level-0 success.
        // The other two paths that create a session from a bare result (a fresh
        // rawCount === 1 attempt, and a pendingSessionStart) already make this
        // inference; this is the third one, "mid-run pickup" via
        // findExtendableSession returning null, doing the same thing.
        await state.handlers.action_completed(attempt(1, 42));
        expect(state.calls).toEqual([['start', '/items/enchanted_cloak_refined', 0, 15, 2]]);
    });
});

describe('the run ending in the queue', () => {
    const enhanceRow = (extra = {}) => ({
        actionHrid: '/actions/enhancing/enhance',
        enhancingMaxLevel: 15,
        enhancingProtectionMinLevel: 2,
        ...extra,
    });

    // dataManager merges endCharacterActions into the full queue before actions_updated fires
    // (see handleActionsUpdated's comment) and drops isDone rows entirely — state.actions is what
    // handleActionsUpdated actually reads, and must reflect that merged result, not the raw delta.

    test('an isDone row — cancelled, finished, or out of materials — finalizes the session', async () => {
        state.current = { id: 's1', targetLevel: 15, protectFrom: 2 };
        state.actions = []; // the merged queue: the isDone row is gone, nothing replaced it
        await state.handlers['actions_updated']({ endCharacterActions: [enhanceRow({ isDone: true })] });

        expect(state.calls).toContainEqual(['finalize']);
        expect(state.calls).not.toContainEqual(['pendingStart']);
    });

    test('an isDone row with no session does nothing', async () => {
        state.actions = [];
        await state.handlers['actions_updated']({ endCharacterActions: [enhanceRow({ isDone: true })] });

        expect(state.calls).toEqual([]);
    });

    test('an ended run alongside the next queued one is a start, not a stop', async () => {
        state.current = { id: 's1', targetLevel: 15, protectFrom: 2 };
        // The old row is gone post-merge; the next queued one (a different target) is now running.
        state.actions = [enhanceRow({ id: 'a2', isDone: false, enhancingMaxLevel: 18, ordinal: 1 })];
        await state.handlers['actions_updated']({
            endCharacterActions: [enhanceRow({ isDone: true }), enhanceRow({ id: 'a2', isDone: false })],
        });

        expect(state.calls).toContainEqual(['finalize']);
        expect(state.calls).toContainEqual(['pendingStart']);
    });

    test('a second enhance queued behind the running one leaves the running session alone', async () => {
        // TLA-audit: the running action (a1) keeps its lowest ordinal; the newly queued one (a2,
        // a different target) sits behind it. The delta carries only a2 — the row that changed —
        // but the merged queue still runs a1, so nothing about the live session should react.
        state.actions = [
            enhanceRow({ id: 'a1', isDone: false, ordinal: 0 }),
            enhanceRow({ id: 'a2', isDone: false, ordinal: 1, enhancingMaxLevel: 20 }),
        ];
        await state.handlers['actions_updated']({ endCharacterActions: [enhanceRow({ id: 'a1', isDone: false })] });
        state.current = { id: 's1', itemHrid: '/items/enchanted_cloak_refined', targetLevel: 15, protectFrom: 2 };
        state.calls = []; // discard the priming call's own pendingStart — it establishes a1 as tracked

        // The queue edit that queued a2 behind the running a1
        await state.handlers['actions_updated']({ endCharacterActions: [enhanceRow({ id: 'a2', isDone: false })] });

        expect(state.calls).not.toContainEqual(['finalize']);
        expect(state.calls).not.toContainEqual(['pendingStart']);
        expect(state.current).toEqual({
            id: 's1',
            itemHrid: '/items/enchanted_cloak_refined',
            targetLevel: 15,
            protectFrom: 2,
        });
    });

    test('a real switch to a different running target still finalizes and starts fresh', async () => {
        state.actions = [enhanceRow({ id: 'a1', isDone: false, ordinal: 0 })];
        await state.handlers['actions_updated']({ endCharacterActions: [enhanceRow({ id: 'a1', isDone: false })] });
        state.current = { id: 's1', targetLevel: 15, protectFrom: 2 };

        // a1 finished and a2 (a different target) is now the one actually running
        state.actions = [enhanceRow({ id: 'a2', isDone: false, ordinal: 1, enhancingMaxLevel: 20 })];
        await state.handlers['actions_updated']({
            endCharacterActions: [
                enhanceRow({ id: 'a1', isDone: true }),
                enhanceRow({ id: 'a2', isDone: false, enhancingMaxLevel: 20 }),
            ],
        });

        expect(state.calls).toContainEqual(['finalize']);
        expect(state.calls).toContainEqual(['pendingStart']);
    });
});

describe('two attempts landing before the first has finished writing', () => {
    // websocket.js calls handlers fire-and-forget — it never awaits the promise
    // an async handler returns — so a second action_completed starts running
    // while the first is still suspended on its cost writes. The level the
    // attempt started from and the level it ended at have to be claimed in one
    // synchronous step, or the second handler reads the first handler's
    // pre-attempt level as its own baseline.
    test('each attempt is scored against the level it actually started from', async () => {
        // Baseline: a mid-run pickup, so lastAttempt is level 5
        await state.handlers.action_completed(attempt(5, 78));
        expect(state.calls).toEqual([['start', '/items/enchanted_cloak_refined', 5, 15, 2]]);

        // A protected failure (5 → 4: protection drops exactly one level) and
        // the success after it (4 → 5), dispatched back to back the way the
        // socket does. The failure buys a protection, which is one more write to
        // suspend on than the success has.
        const failure = state.handlers.action_completed(attempt(4, 79));
        const success = state.handlers.action_completed(attempt(5, 80));
        await Promise.all([failure, success]);

        // The next attempt has to see level 5, not the level the slower handler
        // finished writing afterwards
        await state.handlers.action_completed(attempt(6, 81));

        // Order is not asserted: the failure buys a protection first, so it
        // finishes writing after the success it preceded. What each attempt was
        // scored against is the thing that has to survive the interleaving.
        const results = state.calls.filter(([kind]) => kind === 'success' || kind === 'failure');
        expect(results).toHaveLength(3);
        expect(results).toContainEqual(['failure', 5, 4]);
        expect(results).toContainEqual(['success', 4, 5, false]);
        expect(results).toContainEqual(['success', 5, 6, false]);
        // The failure mode this guards: 5 → 6 scored from a stale level 4,
        // reported as a Blessed double jump that never happened
        expect(results).not.toContainEqual(['success', 4, 6, true]);
    });
});

describe('a protected failure with no market quote for the protection', () => {
    // The market is empty in this file (getPrice returns null), so the charge
    // falls back to the item's vendor price. The game data names that field
    // sellPrice; reading a field that does not exist charged every such
    // protection 0 coins.
    test('is charged the protection item vendor price', async () => {
        await state.handlers.action_completed(attempt(5, 78));
        // Protected failure: 5 → 4
        await state.handlers.action_completed(attempt(4, 79));

        expect(state.calls).toContainEqual(['prot', '/items/mirror_of_protection', 1250]);
    });
});

describe('TLA-043: bootstrap from an already-cached current action', () => {
    // Before this fix, setupEnhancementHandlers() only ever installed the action_completed and
    // actions_updated listeners — it never looked at what DataManager already had cached. A
    // setting enabled, or a page reload, after the queue's own actions_updated had already fired
    // left pendingSessionStart false with nothing left to set it, other than the mid-run pickup
    // fallback in handleEnhancementResult reacting to the very next action_completed. This test
    // asserts the bootstrap fires synchronously at subscribe time, with no WebSocket message at
    // all — something pre-fix code cannot do, since it never reads getCurrentActions().
    test('an active cached Enhance action arms pendingSessionStart immediately, before any message', () => {
        state.actions = [cachedEnhanceAction()];

        setupEnhancementHandlers();

        expect(state.calls).toContainEqual(['pendingStart']);
        expect(trackerMock.pendingSessionStart).toBe(true);
    });

    test('the very next action_completed after that immediately produces a session', async () => {
        state.actions = [cachedEnhanceAction()];
        setupEnhancementHandlers();

        await state.handlers.action_completed(attempt(6, 2071));

        const session = state.current;
        expect(session).toBeTruthy();
        expect(session.itemHrid).toBe('/items/enchanted_cloak_refined');
    });

    test('a requeued repeat sitting first in the array with a higher ordinal is not read as the running action', () => {
        // Both entries are Enhance rows, so array position ([0]) would pick the ordinal-9 one —
        // the repeat requeued to the front of the queue — and read its level (8) as "current".
        // The real running action is the ordinal-2 one, sitting second, at level 5. Feeding
        // findExtendableSession the wrong (position-read) level would miss the extendable
        // session the correct (ordinal-read) level finds, letting the bootstrap wrongly fire.
        trackerMock.findExtendableSession = vi.fn((itemHrid, level) => level === 5);
        state.actions = [
            cachedEnhanceAction({
                ordinal: 9,
                primaryItemHash: '30404::/item_locations/inventory::/items/enchanted_cloak_refined::8',
            }),
            cachedEnhanceAction({ ordinal: 2 }), // level 5, from the shared fixture
        ];

        setupEnhancementHandlers();

        expect(trackerMock.findExtendableSession).toHaveBeenCalledWith('/items/enchanted_cloak_refined', 5);
        expect(state.calls).not.toContainEqual(['pendingStart']);
        trackerMock.findExtendableSession = () => null;
    });

    test('a non-enhancing cached action does not arm the bootstrap', () => {
        state.actions = [{ actionHrid: '/actions/milking/milk', isDone: false, ordinal: 1, currentCount: 40 }];

        setupEnhancementHandlers();

        expect(state.calls).not.toContainEqual(['pendingStart']);
        expect(trackerMock.pendingSessionStart).toBe(false);
    });

    test('an already-active session is left alone — bootstrap never resets or duplicates it', () => {
        state.current = { id: 's1', itemHrid: '/items/enchanted_cloak_refined', totalXP: 0, lastAttempt: null };
        state.actions = [cachedEnhanceAction()];

        setupEnhancementHandlers();

        expect(state.calls).not.toContainEqual(['pendingStart']);
    });

    test('a finished (isDone) cached row does not arm the bootstrap', () => {
        state.actions = [cachedEnhanceAction({ isDone: true })];

        setupEnhancementHandlers();

        expect(state.calls).not.toContainEqual(['pendingStart']);
    });

    test('an extendable completed session for the same item/level is extended instead of shadowed', () => {
        // Same guard enhancement-tracker.js's disable() documents for a character switch: forcing
        // shouldStartNew via pendingSessionStart would skip findExtendableSession entirely and
        // fragment a session that should have been picked back up.
        trackerMock.findExtendableSession = vi.fn((itemHrid, level) => {
            expect(itemHrid).toBe('/items/enchanted_cloak_refined');
            expect(level).toBe(5);
            return 'old_session';
        });
        state.actions = [cachedEnhanceAction()];

        setupEnhancementHandlers();

        expect(state.calls).not.toContainEqual(['pendingStart']);
        trackerMock.findExtendableSession = () => null;
    });

    test('backing off for an extendable session does not leave the tracker idle', async () => {
        // The follow-through the guard depends on: with pendingSessionStart deliberately
        // left unarmed, the next action_completed has to reach the !currentSession branch
        // and extend the completed session there. Were that path not to fire, the tracker
        // would sit idle for the rest of the run with nothing left to arm it.
        trackerMock.findExtendableSession = vi.fn(() => 'old_session');
        state.actions = [cachedEnhanceAction()];

        setupEnhancementHandlers();
        expect(state.calls).not.toContainEqual(['pendingStart']);

        await state.handlers.action_completed(attempt(6, 2071));

        expect(state.calls).toContainEqual(['extend', 'old_session', 15]);
        expect(state.calls.map((call) => call[0])).not.toContain('start');
        expect(state.current).toBeTruthy();
        trackerMock.findExtendableSession = () => null;
    });

    test('the setting disabled skips the bootstrap entirely', async () => {
        state.actions = [cachedEnhanceAction()];
        const configModule = await import('../../core/config.js');
        configModule.default.getSetting = () => false;

        setupEnhancementHandlers();

        expect(state.calls).not.toContainEqual(['pendingStart']);
        configModule.default.getSetting = () => true;
    });
});

describe('the first attempt of a run is scored from the level the queue row started at', () => {
    // An action_completed names only the level the attempt ended at. +6 is a success from
    // +5, a protected failure from +7, or a Blessed jump from +4; +0 is a failure from
    // anywhere. The queue row the game sends when the run starts carries the start level.
    const queued = (level, extra = {}) => ({
        id: 'a1',
        actionHrid: '/actions/enhancing/enhance',
        isDone: false,
        ordinal: 1,
        currentCount: 0,
        primaryItemHash: `30404::/item_locations/inventory::/items/enchanted_cloak_refined::${level}`,
        secondaryItemHash: '30404::/item_locations/inventory::/items/mirror_of_protection::0',
        enhancingMaxLevel: 15,
        enhancingProtectionMinLevel: 3,
        ...extra,
    });
    const completed = (level, currentCount, extra = {}) => ({
        endCharacterAction: { ...queued(level, extra), currentCount },
    });
    const queueRun = async (row) => {
        state.actions = [row];
        await state.handlers.actions_updated({ endCharacterActions: [row] });
    };

    test('a success from +5 with protection from +3 is a success, and buys no protection', async () => {
        await queueRun(queued(5));
        await state.handlers.action_completed(completed(6, 1));

        // Before: the start was inferred as +6, and 6 -> 6 read as a protected failure
        // that charged a protection the game never took
        expect(state.calls).toContainEqual(['start', '/items/enchanted_cloak_refined', 5, 15, 3]);
        expect(state.calls).toContainEqual(['success', 5, 6, false]);
        expect(state.calls.map(([kind]) => kind)).not.toContain('failure');
        expect(state.calls.map(([kind]) => kind)).not.toContain('prot');
    });

    test('an unprotected failure from +2 is a failure at +2, not at +0', async () => {
        await queueRun(queued(2));
        await state.handlers.action_completed(completed(0, 1));

        expect(state.calls).toContainEqual(['start', '/items/enchanted_cloak_refined', 2, 15, 3]);
        expect(state.calls).toContainEqual(['failure', 2, 0]);
    });

    test('a protected failure from +5 drops one level and buys one protection', async () => {
        await queueRun(queued(5));
        await state.handlers.action_completed(completed(4, 1));

        expect(state.calls).toContainEqual(['failure', 5, 4]);
        expect(state.calls).toContainEqual(['prot', '/items/mirror_of_protection', 1250]);
    });

    test('an enhance queued behind another action starts when that one finishes', async () => {
        // The delta that brings it to the front carries only the finished row ahead of it
        const milk = { id: 'm1', actionHrid: '/actions/milking/cow', isDone: false, ordinal: 0, currentCount: 3 };
        state.actions = [milk, queued(5, { ordinal: 1 })];
        await state.handlers.actions_updated({ endCharacterActions: [milk] });
        expect(state.calls).toEqual([]);

        state.actions = [queued(5, { ordinal: 1 })];
        await state.handlers.actions_updated({ endCharacterActions: [{ ...milk, isDone: true }] });
        await state.handlers.action_completed(completed(6, 1));

        expect(state.calls).toContainEqual(['start', '/items/enchanted_cloak_refined', 5, 15, 3]);
        expect(state.calls).toContainEqual(['success', 5, 6, false]);
    });

    test('a queue row from another action is not taken as the start of this attempt', async () => {
        await queueRun(queued(5));
        await state.handlers.action_completed(completed(6, 1, { id: 'a2' }));

        // Unknown start: a session, costed, not scored
        expect(state.calls.map(([kind]) => kind)).toEqual(['pendingStart', 'start']);
    });
});

describe('a page reload in the middle of a session', () => {
    // The game keeps enhancing while no page is connected. An attempt that completes in that
    // gap is never delivered; the login snapshot already includes it.
    const row = (level, currentCount) => ({
        id: 'a1',
        actionHrid: '/actions/enhancing/enhance',
        isDone: false,
        ordinal: 1,
        currentCount,
        primaryItemHash: `30404::/item_locations/inventory::/items/enchanted_cloak_refined::${level}`,
        secondaryItemHash: '30404::/item_locations/inventory::/items/mirror_of_protection::0',
        enhancingMaxLevel: 15,
        enhancingProtectionMinLevel: 3,
    });
    const storedSession = (level, currentCount) => ({
        id: 's1',
        itemHrid: '/items/enchanted_cloak_refined',
        targetLevel: 15,
        protectFrom: 3,
        totalXP: 0,
        lastAttempt: { attemptNumber: 10, level, timestamp: 0, actionId: 'a1', currentCount },
    });

    test('the one attempt that completed during the reload is scored, and the next live one from where it left the item', async () => {
        // Before the reload: +5 at count 10. During it: 5 -> 6 at count 11.
        state.current = storedSession(5, 10);
        state.actions = [row(6, 11)];
        setupEnhancementHandlers();
        await vi.waitFor(() => expect(state.calls).toContainEqual(['success', 5, 6, false]));

        // Live again: 6 -> 7. Before the fix this read 5 -> 7, a Blessed jump that never happened
        await state.handlers.action_completed({ endCharacterAction: row(7, 12) });
        const results = state.calls.filter(([kind]) => kind === 'success' || kind === 'failure');
        expect(results).toEqual([
            ['success', 5, 6, false],
            ['success', 6, 7, false],
        ]);
    });

    test('a longer gap is not guessed at, and the next live attempt is scored from the snapshot', async () => {
        // Count 10 at +5; two attempts during the reload leave the item at +0 (count 12)
        state.current = storedSession(5, 10);
        state.actions = [row(0, 12)];
        setupEnhancementHandlers();

        await state.handlers.action_completed({ endCharacterAction: row(1, 13) });
        const results = state.calls.filter(([kind]) => kind === 'success' || kind === 'failure');
        // Before the fix: a failure at +5 (5 -> 1)
        expect(results).toEqual([['success', 0, 1, false]]);
    });

    test('a count that skipped ahead with no snapshot seen is not scored from the stale level', async () => {
        state.current = storedSession(5, 10);
        await state.handlers.action_completed({ endCharacterAction: row(1, 13) });

        expect(state.calls.filter(([kind]) => kind === 'success' || kind === 'failure')).toEqual([]);
    });

    test('an unscored attempt still moves the level and the time the item was last seen', async () => {
        vi.setSystemTime(90_000);
        state.current = { ...storedSession(5, 10), currentLevel: 5, lastUpdateTime: 40_000 };
        await state.handlers.action_completed({ endCharacterAction: row(1, 13) });

        // Not tallied, but the tile, worth-it, gold sources and the extend guard read +1 now
        expect(state.calls.filter(([kind]) => kind === 'success' || kind === 'failure')).toEqual([]);
        expect(state.current.currentLevel).toBe(1);
        expect(state.current.lastUpdateTime).toBe(90_000);
        vi.useRealTimers();
    });
});

describe('a Philosopher’s Mirror attempt', () => {
    // Game client: a mirror attempt always succeeds, the mirror is consumed every attempt, and
    // the enhancement cost becomes one copy of the base item one level below the item.
    test('is charged the mirror and the copy, not the normal materials and coins', async () => {
        const mirrorRow = (level, currentCount) => ({
            id: 'a1',
            actionHrid: '/actions/enhancing/enhance',
            isDone: false,
            ordinal: 1,
            currentCount,
            primaryItemHash: `30404::/item_locations/inventory::/items/enchanted_cloak_refined::${level}`,
            secondaryItemHash: '30404::/item_locations/inventory::/items/philosophers_mirror::0',
            enhancingMaxLevel: 10,
            enhancingProtectionMinLevel: 0,
        });
        state.actions = [mirrorRow(8, 0)];
        await state.handlers.actions_updated({ endCharacterActions: [mirrorRow(8, 0)] });
        await state.handlers.action_completed({ endCharacterAction: mirrorRow(9, 1) });

        expect(state.calls).toContainEqual(['success', 8, 9, false]);
        expect(state.calls).toContainEqual(['prot', '/items/philosophers_mirror', 90000]);
        // The +7 copy, priced at the item's vendor price with the market empty in this file
        expect(state.costs).toEqual([['mat', '/items/enchanted_cloak_refined', 1, 5000]]);
    });
});

describe('a session whose run ended while no page was connected', () => {
    // Target reached, protection or materials run out, or stopped from another device while the
    // page was closed: no actions_updated will ever say so. Left open, the next run to start
    // finalized it with that later moment as its end — hours or days of idle time in its
    // duration and in the gold-sources day span.
    const stored = () => ({
        id: 's1',
        state: 'tracking',
        itemHrid: '/items/enchanted_cloak_refined',
        targetLevel: 15,
        protectFrom: 3,
        totalXP: 0,
        startTime: 1_000,
        lastUpdateTime: 50_000,
        lastAttempt: { attemptNumber: 10, level: 9, timestamp: 50_000, actionId: 'a1', currentCount: 10 },
    });

    test('is closed at its last recorded attempt when the snapshot has no enhance running', () => {
        state.characterData = {};
        state.current = stored();
        state.actions = [];
        setupEnhancementHandlers();

        expect(state.calls).toEqual([['finalize', 50_000]]);
    });

    test('is closed the same way when the snapshot is enhancing a different item', () => {
        state.characterData = {};
        state.current = stored();
        state.actions = [
            cachedEnhanceAction({ id: 'b1', primaryItemHash: '30404::/item_locations/inventory::/items/other::2' }),
        ];
        setupEnhancementHandlers();

        expect(state.calls).toEqual([['finalize', 50_000], ['pendingStart']]);
    });

    test('closes at the later of the last scored attempt and the last attempt seen at all', () => {
        // An unscored attempt (count skipped ahead) moves lastAttempt but not lastUpdateTime
        state.characterData = {};
        state.current = {
            ...stored(),
            lastAttempt: { attemptNumber: 11, level: 0, timestamp: 70_000, actionId: 'a1', currentCount: 13 },
        };
        state.actions = [];
        setupEnhancementHandlers();

        expect(state.calls).toEqual([['finalize', 70_000]]);
    });

    test('a new queue action for the same item is a new run: the stored one closes, and is not extended', async () => {
        // The stored run (a1, target 15) ended offline; the snapshot runs b1 on the same item
        // at +9 to +18. Before: same item read as same run, so b1 landed in the old session.
        state.characterData = {};
        state.current = stored();
        trackerMock.findExtendableSession = () => 's1';
        const b1 = (level, currentCount) =>
            cachedEnhanceAction({
                id: 'b1',
                currentCount,
                enhancingMaxLevel: 18,
                primaryItemHash: '30404::/item_locations/inventory::/items/enchanted_cloak_refined::' + level,
            });
        state.actions = [b1(9, 0)];
        setupEnhancementHandlers();

        expect(state.calls).toEqual([['finalize', 50_000], ['pendingStart']]);

        await state.handlers.action_completed({ endCharacterAction: b1(10, 1) });
        expect(state.calls).toContainEqual(['start', '/items/enchanted_cloak_refined', 9, 18, 2]);
        expect(state.calls).toContainEqual(['success', 9, 10, false]);
        expect(state.calls.map(([kind]) => kind)).not.toContain('extend');
        trackerMock.findExtendableSession = () => null;
    });

    test('the same queue action still running is the same run, and stays open', () => {
        state.characterData = {};
        state.current = stored();
        state.actions = [cachedEnhanceAction({ id: 'a1', currentCount: 10 })];
        setupEnhancementHandlers();

        expect(state.calls.map(([kind]) => kind)).not.toContain('finalize');
    });

    test('is left alone before the character snapshot has landed', () => {
        state.current = stored();
        state.actions = [];
        setupEnhancementHandlers();

        expect(state.calls).toEqual([]);
    });
});

describe('a mirror named only by the configured protection field', () => {
    test('is charged as a mirror attempt, not normal materials', async () => {
        const mirrorRow = (level, currentCount) => ({
            id: 'a1',
            actionHrid: '/actions/enhancing/enhance',
            isDone: false,
            ordinal: 1,
            currentCount,
            primaryItemHash: '30404::/item_locations/inventory::/items/enchanted_cloak_refined::' + level,
            enhancingProtectionItemHrid: '/items/philosophers_mirror',
            enhancingMaxLevel: 10,
            enhancingProtectionMinLevel: 0,
        });
        state.actions = [mirrorRow(8, 0)];
        await state.handlers.actions_updated({ endCharacterActions: [mirrorRow(8, 0)] });
        await state.handlers.action_completed({ endCharacterAction: mirrorRow(9, 1) });

        expect(state.calls).toContainEqual(['prot', '/items/philosophers_mirror', 90000]);
        expect(state.costs).toEqual([['mat', '/items/enchanted_cloak_refined', 1, 5000]]);
    });
});

describe('a mirror attempt with no known start', () => {
    // Blessed can make a mirror success +2, so a result N came from N-1 or N-2
    const row = (level, currentCount) => ({
        id: 'a1',
        actionHrid: '/actions/enhancing/enhance',
        isDone: false,
        ordinal: 1,
        currentCount,
        primaryItemHash: '30404::/item_locations/inventory::/items/enchanted_cloak_refined::' + level,
        secondaryItemHash: '30404::/item_locations/inventory::/items/philosophers_mirror::0',
        enhancingMaxLevel: 12,
        enhancingProtectionMinLevel: 0,
    });

    test('at +4 or above the mirror certainly applied and is charged', async () => {
        await state.handlers.action_completed({ endCharacterAction: row(9, 40) });

        expect(state.calls).toContainEqual(['prot', '/items/philosophers_mirror', 90000]);
        expect(state.costs).toEqual([['mat', '/items/enchanted_cloak_refined', 1, 5000]]);
    });

    test('at +3 a Blessed ordinary attempt from +1 fits too, so it is charged as ordinary', async () => {
        await state.handlers.action_completed({ endCharacterAction: row(3, 40) });

        expect(state.calls.map(([kind]) => kind)).not.toContain('prot');
        expect(state.costs).toEqual([
            ['mat', '/items/holy_cheese', 2],
            ['coin', 900],
        ]);
    });
});

describe('a character switch', () => {
    // The registry disables the feature on character_switching and initializes it again for
    // the arriving character; nothing read off the departing character's queue may survive.
    test('a start level read from the departing character is not used for the arriving one', async () => {
        const row = {
            id: 'a1',
            actionHrid: '/actions/enhancing/enhance',
            isDone: false,
            ordinal: 1,
            currentCount: 0,
            primaryItemHash: '30404::/item_locations/inventory::/items/enchanted_cloak_refined::5',
            secondaryItemHash: '',
            enhancingMaxLevel: 15,
            enhancingProtectionMinLevel: 0,
        };
        state.actions = [row];
        await state.handlers.actions_updated({ endCharacterActions: [row] });

        cleanupEnhancementHandlers();
        state.actions = [];
        state.calls = [];
        trackerMock.pendingSessionStart = false;
        setupEnhancementHandlers();

        await state.handlers.action_completed({
            endCharacterAction: { ...row, currentCount: 1, primaryItemHash: row.primaryItemHash.replace('::5', '::6') },
        });
        expect(state.calls.map(([kind]) => kind)).toEqual(['start']);
    });
});

describe('a mirror attempt on a refined item', () => {
    test('consumes a copy of the base item, one level below', async () => {
        const row = (level, currentCount) => ({
            id: 'r1',
            actionHrid: '/actions/enhancing/enhance',
            isDone: false,
            ordinal: 1,
            currentCount,
            primaryItemHash: '30404::/item_locations/inventory::/items/kraken_chaps_refined::' + level,
            secondaryItemHash: '30404::/item_locations/inventory::/items/philosophers_mirror::0',
            enhancingMaxLevel: 10,
            enhancingProtectionMinLevel: 0,
        });
        state.actions = [row(8, 0)];
        await state.handlers.actions_updated({ endCharacterActions: [row(8, 0)] });
        await state.handlers.action_completed({ endCharacterAction: row(9, 1) });

        expect(state.calls).toContainEqual(['success', 8, 9, false]);
        // A +7 Kraken Chaps, not a refined copy and not the refined item's materials
        expect(state.costs).toEqual([['mat', '/items/kraken_chaps', 1, 7000]]);
    });
});

describe('a session saved before attempts carried their action id', () => {
    // A missing id is unknown, not a match: the snapshot's other evidence decides
    const legacy = () => ({
        id: 'old',
        state: 'tracking',
        itemHrid: '/items/enchanted_cloak_refined',
        targetLevel: 15,
        protectFrom: 2,
        totalAttempts: 40,
        totalXP: 0,
        startTime: 1_000,
        lastUpdateTime: 50_000,
        lastAttempt: { attemptNumber: 41, level: 5, timestamp: 50_000 },
    });

    test('the same run still going (target, protect-from and count all agree) stays open', () => {
        state.characterData = {};
        state.current = legacy();
        state.actions = [cachedEnhanceAction({ id: 'a1' })]; // target 15, protect 2, count 2070
        setupEnhancementHandlers();

        expect(state.calls.map(([kind]) => kind)).not.toContain('finalize');
    });

    test('a same-item run with another target is a new run, and the stored one closes', () => {
        state.characterData = {};
        state.current = legacy();
        state.actions = [cachedEnhanceAction({ id: 'b1', enhancingMaxLevel: 18, currentCount: 0 })];
        setupEnhancementHandlers();

        expect(state.calls).toContainEqual(['finalize', 50_000]);
    });

    test('a same-item run whose count is below the attempts already recorded is a new action', () => {
        state.characterData = {};
        state.current = legacy();
        state.actions = [cachedEnhanceAction({ id: 'b1', currentCount: 3 })];
        setupEnhancementHandlers();

        expect(state.calls).toContainEqual(['finalize', 50_000]);
    });
});
