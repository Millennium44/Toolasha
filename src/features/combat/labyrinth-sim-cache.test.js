/**
 * The sim-config accessors are what exports quote as the conditions a sim ran
 * under, so these pin their defaults, their clamping, and that loading the sim
 * module wires them into the accuracy export.
 */

import { describe, test, expect, afterEach, vi } from 'vitest';

/** Backing store for the mocked config's settings */
const settings = vi.hoisted(() => ({ map: new Map() }));
/** Every write the mocked storage was handed, as `[key, value]` */
const storageWrites = vi.hoisted(() => ({ list: [] }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => false,
        getSettingValue: (key, fallback) => (settings.map.has(key) ? settings.map.get(key) : fallback),
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getSkills: () => null,
        characterData: null,
        getInitClientData: () => null,
        getCurrentCharacterId: () => 'me',
    },
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {}, onSocketEvent: () => {} } }));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async () => null,
        getJSON: async () => null,
        set: async (key, value) => {
            storageWrites.list.push([key, value]);
            return true;
        },
        setJSON: async () => true,
    },
}));
/** What the mocked adapter hands back as the game data payload — null before the
 *  client's data sheet has arrived, which is a state the sim must not run in */
const adapter = vi.hoisted(() => ({ gameData: {} }));
/** Every call the mocked runner received, so "never asked the worker" is testable */
const simRuns = vi.hoisted(() => ({ list: [] }));

vi.mock('../combat-sim/combat-sim-adapter.js', () => ({
    buildGameDataPayload: () => adapter.gameData,
    buildPlayerDTO: () => ({ hrid: 'player1' }),
    getCommunityBuffs: () => ({}),
}));
vi.mock('../combat-sim/combat-sim-runner.js', () => ({
    runLabyrinthSimulation: async (options) => {
        simRuns.list.push(options);
        return {};
    },
    runBlindBuffProbe: async () => [],
    runPlayerStatProbe: async () => null,
    cancelSimulation: () => {},
}));

const {
    getSimStopRule,
    getSimHours,
    getSimPrecisionPct,
    simCacheMethods,
    resolveSimStopRule,
    resolveDecisionStopRule,
    resolveSimHours,
    getAutomationSimPrecisionPct,
    getAutomationUncapped,
    automationSimOptions,
    UNCAPPED_MAX_SIM_TRIALS,
    gearChangedSince,
    GEAR_CHANGED_MARK,
    GEAR_CHANGED_DETAIL,
} = await import('./labyrinth-sim-cache.js');
const { buildAccuracyExport } = await import('./labyrinth-accuracy-export.js');
const { default: loadoutSnapshot } = await import('./loadout-snapshot.js');

afterEach(() => {
    settings.map.clear();
    storageWrites.list = [];
    simRuns.list = [];
    adapter.gameData = {};
});

describe('the persisted combat cache mirror', () => {
    /** A stand-in for the clear-rate module's state, the mixin's `this` */
    const context = () => ({
        combatCache: new Map(),
        _combatCacheMeta: new Map(),
        _snapshotContentFingerprint: () => 'fp',
        ...simCacheMethods,
    });

    test('a burst of sim results is written once, after the quiet window', () => {
        vi.useFakeTimers();
        try {
            const ctx = context();
            for (const key of ['a', 'b', 'c']) {
                ctx.combatCache.set(key, { clearChance: 0.5, computedAt: 1, fromPersistedCache: true });
                ctx._persistCombatCacheEntry(key, ctx.combatCache.get(key));
            }
            expect(storageWrites.list).toHaveLength(0);

            vi.advanceTimersByTime(999);
            expect(storageWrites.list).toHaveLength(0);
            vi.advanceTimersByTime(1);

            expect(storageWrites.list).toHaveLength(1);
            const [, stored] = storageWrites.list[0];
            expect(stored.entries.map((entry) => entry.key).sort()).toEqual(['a', 'b', 'c']);
            // Display-only fields are stripped before the record is written
            expect(stored.entries[0].result).toEqual({ clearChance: 0.5 });
            // The gear the entry was simmed under rides on the record, once
            expect(stored.entries[0].snapshotFingerprint).toBe('fp');
        } finally {
            vi.useRealTimers();
        }
    });

    test('a flush at the end of a search lands the results at once, and a clean flush writes nothing', () => {
        vi.useFakeTimers();
        try {
            const ctx = context();
            ctx.combatCache.set('a', { clearChance: 0.5 });
            ctx._persistCombatCacheEntry('a', ctx.combatCache.get('a'));

            expect(ctx._flushCombatCache()).toBe(true);
            expect(storageWrites.list).toHaveLength(1);

            // The pending timer was consumed by the flush; nothing is written twice
            vi.advanceTimersByTime(5000);
            expect(storageWrites.list).toHaveLength(1);
            expect(ctx._flushCombatCache()).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    test('clearing the mirror cancels a pending flush so it cannot overwrite the empty file', () => {
        vi.useFakeTimers();
        try {
            const ctx = context();
            ctx.combatCache.set('a', { clearChance: 0.5 });
            ctx._persistCombatCacheEntry('a', ctx.combatCache.get('a'));
            ctx._clearPersistedCombatCache();

            vi.advanceTimersByTime(5000);
            expect(storageWrites.list).toHaveLength(1);
            expect(storageWrites.list[0][1].entries).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('the gear fingerprint a cached result carries', () => {
    /** A stand-in for the clear-rate module's state, the mixin's `this` */
    const context = (fingerprint = 'fp') => ({
        combatCache: new Map(),
        _combatCacheMeta: new Map(),
        _snapshotContentFingerprint: () => fingerprint,
        ...simCacheMethods,
    });

    test('the result in the cache is stamped with the gear it was simmed under', () => {
        vi.useFakeTimers();
        try {
            const ctx = context('gear-a');
            ctx.combatCache.set('a', { clearChance: 0.5 });
            ctx._persistCombatCacheEntry('a', ctx.combatCache.get('a'));
            // On the result itself, not only in the meta map: the render path is
            // handed a result and has no key to look a meta record up by
            expect(ctx.combatCache.get('a').snapshotFingerprint).toBe('gear-a');
        } finally {
            vi.useRealTimers();
        }
    });

    test('the stamp is not written into the stored result, which has its own field', () => {
        vi.useFakeTimers();
        try {
            const ctx = context('gear-a');
            ctx.combatCache.set('a', { clearChance: 0.5 });
            ctx._persistCombatCacheEntry('a', ctx.combatCache.get('a'));
            ctx._flushCombatCache();
            const [, stored] = storageWrites.list[0];
            expect(stored.entries[0].result).toEqual({ clearChance: 0.5 });
            expect(stored.entries[0].snapshotFingerprint).toBe('gear-a');
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('gearChangedSince', () => {
    test('a fingerprint that no longer matches is a gear change', () => {
        expect(gearChangedSince('gear-a', 'gear-b', true)).toBe(true);
    });

    test('the same fingerprint is not', () => {
        expect(gearChangedSince('gear-a', 'gear-a', true)).toBe(false);
    });

    test('nothing is marked before the loadout snapshots have landed', () => {
        // The five-second whenReady deadline can pass with nothing loaded, and
        // a fingerprint over an empty snapshot set matches no stored one — so
        // without this guard a reload marks every tile on the floor at once
        expect(gearChangedSince('gear-a', 'gear-b', false)).toBe(false);
        expect(gearChangedSince('gear-a', '', false)).toBe(false);
    });

    test('an entry stored before the fingerprint existed shows its age only', () => {
        expect(gearChangedSince(undefined, 'gear-b', true)).toBe(false);
        expect(gearChangedSince(null, 'gear-b', true)).toBe(false);
        expect(gearChangedSince('', 'gear-b', true)).toBe(false);
    });

    test('no current fingerprint to compare against is silence, not a guess', () => {
        expect(gearChangedSince('gear-a', null, true)).toBe(false);
    });

    test('the marker claims only what the fingerprint actually covers', () => {
        // FINGERPRINT_SPEC hashes loadout snapshots plus worn item and
        // enhancement level, and explicitly excludes levels, abilities and
        // buffs. The wording must not imply otherwise.
        expect(GEAR_CHANGED_MARK).toBe('build changed since this was computed');
        // Still no claim about what it cannot see: buffs and consumables are
        // outside the fingerprint, so the marker may not imply it checked them
        expect(GEAR_CHANGED_MARK).not.toMatch(/buff|tea|drink|food/i);
        // The longer form is allowed to name them, but only to say they are NOT checked
        expect(GEAR_CHANGED_DETAIL).toContain('buffs and consumables are not');
    });
});

describe('the sim stop rule', () => {
    test('defaults to one percentage point either side, bounded in trials', () => {
        expect(getSimStopRule()).toEqual({ targetHalfWidth: 0.01, minTrials: 100, maxTrials: 20000 });
    });

    test('the precision setting is clamped before it becomes a half-width', () => {
        settings.map.set('labyrinthSimPrecision', 0.01);
        expect(getSimPrecisionPct()).toBe(0.1);
        expect(getSimStopRule().targetHalfWidth).toBeCloseTo(0.001, 10);
        settings.map.set('labyrinthSimPrecision', 50);
        expect(getSimStopRule().targetHalfWidth).toBeCloseTo(0.1, 10);
    });

    test('the hour ceiling is floored and clamped', () => {
        expect(getSimHours()).toBe(3);
        settings.map.set('labyrinthRecommendSimHours', 500);
        expect(getSimHours()).toBe(100);
        settings.map.set('labyrinthRecommendSimHours', 2.9);
        expect(getSimHours()).toBe(2);
        settings.map.set('labyrinthRecommendSimHours', 0);
        expect(getSimHours()).toBe(3);
    });

    test('the mixin methods are the same functions the exports quote', () => {
        // One implementation, two doors: a drift between what sims run under
        // and what exports claim would be worse than either being wrong
        expect(simCacheMethods.getSimStopRule).toBe(getSimStopRule);
        expect(simCacheMethods.getSimHours).toBe(getSimHours);
        expect(simCacheMethods.getSimPrecisionPct).toBe(getSimPrecisionPct);
    });
});

describe('wiring into the accuracy export', () => {
    test('loading the sim module registers the config the export stamps', () => {
        settings.map.set('labyrinthRecommendSimHours', 7);
        const file = buildAccuracyExport({});
        expect(file.simConfig).toEqual({ stopRule: getSimStopRule(), hours: 7 });
    });
});

/**
 * "Uncapped" is a promise about which stopping rule applies, and the one thing
 * it must not mean is "runs forever" — a tab that never answers is worse than a
 * wide answer. So both halves are pinned: the ordinary ceiling is genuinely
 * lifted, and the backstop it is lifted to is finite and far above anything the
 * tightest precision the input allows could need.
 */
describe('resolving the fight cap', () => {
    test('capped is the ordinary ceiling', () => {
        expect(resolveSimStopRule({ uncapped: false }).maxTrials).toBe(20000);
    });

    test('uncapped lifts it to the backstop, which is finite', () => {
        const rule = resolveSimStopRule({ uncapped: true });
        expect(rule.maxTrials).toBe(UNCAPPED_MAX_SIM_TRIALS);
        expect(rule.maxTrials).toBe(20000 * 100);
        expect(Number.isFinite(rule.maxTrials)).toBe(true);
    });

    test('the precision target is untouched by the cap, and the floor on trials stays', () => {
        settings.map.set('labyrinthSimPrecision', 2);
        const capped = resolveSimStopRule({ uncapped: false });
        const uncapped = resolveSimStopRule({ uncapped: true });
        expect(uncapped.targetHalfWidth).toBe(capped.targetHalfWidth);
        expect(uncapped.minTrials).toBe(capped.minTrials);
    });

    test('an explicit precision overrides the configured one, clamped the same way', () => {
        settings.map.set('labyrinthSimPrecision', 2);
        expect(resolveSimStopRule({ precisionPct: 0.5 }).targetHalfWidth).toBeCloseTo(0.005, 10);
        // Out of range and unusable values both fall back to the sane end
        expect(resolveSimStopRule({ precisionPct: 99 }).targetHalfWidth).toBeCloseTo(0.1, 10);
        expect(resolveSimStopRule({ precisionPct: 0 }).targetHalfWidth).toBeCloseTo(0.02, 10);
    });

    test('a decision run gives up later when uncapped, not never', () => {
        expect(resolveDecisionStopRule({ decideAgainst: 0.7 }).maxTrials).toBe(4000);
        expect(resolveDecisionStopRule({ decideAgainst: 0.7, uncapped: true }).maxTrials).toBe(400000);
        expect(resolveDecisionStopRule({ decideAgainst: 0.7, uncapped: true }).decideAgainst).toBe(0.7);
    });

    test('the clock is lifted too, so time never binds before the backstop does', () => {
        expect(resolveSimHours(false)).toBe(3);
        expect(resolveSimHours(true)).toBe(100000);
    });
});

/**
 * The Automation tab's precision is its own knob, but an untouched install must
 * keep following the map's — cached results are keyed on the precision they were
 * run at, so a default that differed would silently re-sim every room.
 */
describe('the Automation tab’s own sim settings', () => {
    test('unset, it follows the floor map’s precision', () => {
        settings.map.set('labyrinthSimPrecision', 2.5);
        expect(getAutomationSimPrecisionPct()).toBe(2.5);
    });

    test('set, it wins, clamped to the input’s range', () => {
        settings.map.set('labyrinthSimPrecision', 2.5);
        settings.map.set('labyrinthAutomationSimPrecision', 0.5);
        expect(getAutomationSimPrecisionPct()).toBe(0.5);
        settings.map.set('labyrinthAutomationSimPrecision', 40);
        expect(getAutomationSimPrecisionPct()).toBe(10);
    });

    test('the options handed to every automation sim carry both knobs', () => {
        settings.map.set('labyrinthAutomationSimPrecision', 3);
        expect(automationSimOptions()).toEqual({ precisionPct: 3, uncapped: false });
        expect(getAutomationUncapped()).toBe(false);
    });
});

/**
 * A failed sim is not a 0% clear.
 *
 * The queue behind the Automation table's badges drew whatever came back, and
 * a run whose inputs were not ready comes back as `{failed: true, clearChance:
 * 0}` — which rendered as a confident "0% 999s" on a room that clears fine.
 * The floor-map tile path has always skipped failed results and retried; this
 * pins the same discipline on the badge path.
 */
describe('a failed sim never reaches a badge', () => {
    /** A stand-in for the clear-rate module's state, the mixin's `this` */
    const queueContext = (results) => {
        const drawn = [];
        const attempts = [];
        return {
            ...simCacheMethods,
            drawn,
            attempts,
            simQueue: [],
            simRunning: false,
            combatCache: new Map(),
            _combatCacheMeta: new Map(),
            _snapshotContentFingerprint: () => 'fp',
            getLabyrinthLoadoutId: () => 0,
            // The sim itself is not what this suite is about — what the queue
            // does with each answer is
            computeCombatClear: async (monsterHrid, roomLevel) => {
                attempts.push([monsterHrid, roomLevel]);
                return results.shift() ?? { failed: true, clearChance: 0, expectedSeconds: Infinity };
            },
            updateBadge: (badge, result, roomLevel) => drawn.push([badge, result, roomLevel]),
        };
    };

    const badge = () => ({ isConnected: true, textContent: '...' });

    test('a failed result leaves the placeholder standing and is tried again', async () => {
        vi.useFakeTimers();
        try {
            // Fails once, then succeeds on the retry
            const ctx = queueContext([
                { failed: true, clearChance: 0 },
                { clearChance: 0.62, expectedSeconds: 40 },
            ]);
            const el = badge();
            ctx.queueCombatSim('/monsters/imp', 200, el);

            await ctx.processSimQueue();
            expect(ctx.drawn).toHaveLength(0);
            expect(el.textContent).toBe('...');

            await vi.advanceTimersByTimeAsync(2500);
            expect(ctx.drawn).toHaveLength(1);
            expect(ctx.drawn[0][1]).toMatchObject({ clearChance: 0.62 });
        } finally {
            vi.useRealTimers();
        }
    });

    test('the retries are bounded, and nothing is ever drawn from a failure', async () => {
        vi.useFakeTimers();
        try {
            const ctx = queueContext([]); // every run fails
            const el = badge();
            ctx.queueCombatSim('/monsters/imp', 200, el);

            await ctx.processSimQueue();
            await vi.advanceTimersByTimeAsync(2500 * 10);

            // The first run plus three retries, the floor map's own rule
            expect(ctx.attempts).toHaveLength(4);
            expect(ctx.drawn).toHaveLength(0);
        } finally {
            vi.useRealTimers();
        }
    });

    test('a badge the table has since discarded is not simulated again', async () => {
        vi.useFakeTimers();
        try {
            const ctx = queueContext([]);
            const el = badge();
            ctx.queueCombatSim('/monsters/imp', 200, el);

            await ctx.processSimQueue();
            el.isConnected = false;
            await vi.advanceTimersByTimeAsync(2500 * 10);

            expect(ctx.attempts).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });

    test('a Stop disarms a pending retry', async () => {
        vi.useFakeTimers();
        try {
            const ctx = queueContext([]);
            ctx.queueCombatSim('/monsters/imp', 200, badge());

            await ctx.processSimQueue();
            ctx.cancelRunningSims();
            await vi.advanceTimersByTimeAsync(2500 * 10);

            expect(ctx.attempts).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });

    test('a successful result is drawn as before', async () => {
        const ctx = queueContext([{ clearChance: 0.5, expectedSeconds: 12 }]);
        ctx.queueCombatSim('/monsters/imp', 200, badge());

        await ctx.processSimQueue();

        expect(ctx.drawn).toHaveLength(1);
        expect(ctx.drawn[0][2]).toBe(200);
    });
});

/**
 * The game data payload is null until the client's data sheet arrives. Handing
 * that to the worker throws inside it, and the throw comes back as a failed
 * run — which, on the badge path above, used to be drawn as 0%. Bailing before
 * the worker is asked keeps the failure honest and costs nothing.
 */
describe('a sim with no game data does not reach the worker', () => {
    const context = () => ({
        ...simCacheMethods,
        combatCache: new Map(),
        _combatCacheMeta: new Map(),
        _snapshotContentFingerprint: () => 'fp',
        getLabyrinthLoadoutId: () => 0,
        buildLabyrinthPlayerDTO: () => ({ hrid: 'player1' }),
        getLabyrinthCombatBuffs: () => [],
        getCombatExperienceBonus: () => 0,
    });

    afterEach(() => {
        adapter.gameData = {};
    });

    test('null game data is a failure, not a thrown error and not a 0% clear', async () => {
        adapter.gameData = null;
        const ctx = context();

        const result = await ctx.computeCombatClear('/monsters/imp', 200);

        expect(result).toMatchObject({ failed: true, clearChance: 0 });
        expect(simRuns.list).toHaveLength(0);
        // Nothing cached, so the room is re-tried once the data lands
        expect(ctx.combatCache.size).toBe(0);
    });
});

/**
 * The palette's "Recompute lab sims" needs a count before it recomputes,
 * because recomputing is what destroys the evidence — and it needs that count
 * in rooms, which is the unit on screen.
 */
describe('stale rooms', () => {
    /**
     * The mixin's `this`, with a cache already holding entries stamped with the
     * fingerprints the test names.
     * @param {Object<string, string>} stamped - cacheKey → the fingerprint it was computed under
     * @param {string} current - The fingerprint of the gear worn now
     * @returns {Object} A context
     */
    const context = (stamped, current = 'now') => {
        const ctx = {
            ...simCacheMethods,
            combatCache: new Map(),
            _combatCacheMeta: new Map(),
            _snapshotContentFingerprint: () => current,
            recomputeCombatSims: vi.fn(async () => {}),
        };
        for (const [key, snapshotFingerprint] of Object.entries(stamped)) {
            ctx.combatCache.set(key, { clearChance: 0.5 });
            ctx._combatCacheMeta.set(key, { computedAt: 1, snapshotFingerprint, scriptVersion: '1' });
        }
        return ctx;
    };

    const wasReady = loadoutSnapshot.snapshotsReady;
    afterEach(() => {
        loadoutSnapshot.snapshotsReady = wasReady;
    });

    test('entries stamped with the gear worn now are not stale', () => {
        loadoutSnapshot.snapshotsReady = true;
        const ctx = context({ '/monsters/imp:200:0:precision::': 'now' });
        expect(ctx.staleCombatCacheRooms()).toEqual([]);
    });

    test('an entry stamped with other gear is one stale room', () => {
        loadoutSnapshot.snapshotsReady = true;
        const ctx = context({ '/monsters/imp:200:0:precision::': 'before' });
        expect(ctx.staleCombatCacheRooms()).toEqual(['/monsters/imp:200']);
    });

    test('several entries for one room count once — the player sees rooms, not cache keys', () => {
        loadoutSnapshot.snapshotsReady = true;
        const ctx = context({
            '/monsters/imp:200:0:precision::': 'before',
            '/monsters/imp:200:0:dec50::': 'before',
            '/monsters/imp:200:1:precision::': 'before',
            '/monsters/rat:180:0:precision::': 'before',
        });
        // Three of the four keys are the same monster at the same room level
        expect(ctx.staleCombatCacheRooms().sort()).toEqual(['/monsters/imp:200', '/monsters/rat:180']);
    });

    test('nothing is stale until the snapshots have landed', () => {
        // Before they land the fingerprint is taken over an empty snapshot set
        // and matches nothing, so every room on the floor would read as stale
        loadoutSnapshot.snapshotsReady = false;
        const ctx = context({ '/monsters/imp:200:0:precision::': 'before' });
        expect(ctx.staleCombatCacheRooms()).toEqual([]);
    });

    test('an entry that predates the fingerprint is unknown, not different', () => {
        loadoutSnapshot.snapshotsReady = true;
        const ctx = context({ '/monsters/imp:200:0:precision::': undefined });
        expect(ctx.staleCombatCacheRooms()).toEqual([]);
    });

    test('recomputing stale sims runs the button’s path and answers with the count', async () => {
        loadoutSnapshot.snapshotsReady = true;
        const ctx = context({
            '/monsters/imp:200:0:precision::': 'before',
            '/monsters/rat:180:0:precision::': 'before',
        });

        expect(await ctx.recomputeStaleCombatSims(false)).toBe(2);
        expect(ctx.recomputeCombatSims).toHaveBeenCalledWith(false);
    });

    test('nothing stale recomputes nothing — the cache was already right', async () => {
        loadoutSnapshot.snapshotsReady = true;
        const ctx = context({ '/monsters/imp:200:0:precision::': 'now' });

        expect(await ctx.recomputeStaleCombatSims(false)).toBe(0);
        expect(ctx.recomputeCombatSims).not.toHaveBeenCalled();
    });
});

/**
 * `disable()` cancels the batch and then bumps the epoch. The loop still
 * unwinding belongs to the character that has gone: commit 0b014165 closed one
 * door into this (an untracked catch-up timer surviving teardown) and 844ae643
 * another (a flush timer writing `entries: []` over the arriving character's
 * cache). The queue's own `finally` re-armed both.
 */
describe('a sim queue torn down mid-flight', () => {
    /** The mixin's `this`, with the teardown a character switch performs */
    const teardownContext = () => {
        const flushes = [];
        const ctx = {
            ...simCacheMethods,
            flushes,
            attempts: [],
            drawn: [],
            simQueue: [],
            simRunning: false,
            combatCache: new Map(),
            _combatCacheMeta: new Map(),
            _snapshotContentFingerprint: () => 'fp',
            getLabyrinthLoadoutId: () => 0,
            _flushCombatCache: () => flushes.push(true),
            updateBadge: (badge, result) => ctx.drawn.push([badge, result]),
            computeCombatClear: async (monsterHrid) => {
                ctx.attempts.push(monsterHrid);
                // The character switch lands inside the first room's sim
                ctx.disable();
                return { failed: true, clearChance: 0, expectedSeconds: Infinity };
            },
            // Exactly what labyrinth-clear-rate's disable() does to this state
            disable() {
                ctx.cancelRunningSims();
                ctx.endSimEpoch();
                ctx.simQueue = [];
                ctx.simRunning = false;
                ctx.combatCache.clear();
                ctx._combatCacheMeta.clear();
            },
        };
        return ctx;
    };

    const badge = () => ({ isConnected: true, textContent: '...' });

    test('nothing is flushed, retried, or re-drawn after the switch', async () => {
        vi.useFakeTimers();
        try {
            const ctx = teardownContext();
            ctx.queueCombatSim('/monsters/imp', 200, badge());
            ctx.queueCombatSim('/monsters/imp', 220, badge());

            await ctx.processSimQueue();
            await vi.advanceTimersByTimeAsync(2500 * 10);

            // One room simulated, the rest of the batch dropped
            expect(ctx.attempts).toHaveLength(1);
            expect(ctx.drawn).toHaveLength(0);
            // The flush would rebuild the stored list from the map disable()
            // just emptied, over the arriving character's persisted entries
            expect(ctx.flushes).toHaveLength(0);
        } finally {
            vi.useRealTimers();
        }
    });

    test('the stale loop never clears the flag the next run owns', async () => {
        const ctx = teardownContext();
        const teardown = ctx.disable;
        ctx.disable = () => {
            teardown();
            // The arriving character's own queue starts up
            ctx.simRunning = true;
        };
        ctx.queueCombatSim('/monsters/imp', 200, badge());

        await ctx.processSimQueue();

        expect(ctx.simRunning).toBe(true);
    });
});
