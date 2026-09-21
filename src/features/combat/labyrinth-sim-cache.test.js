/**
 * The sim-config accessors are what exports quote as the conditions a sim ran
 * under, so these pin their defaults, their clamping, and that loading the sim
 * module wires them into the accuracy export.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

/** Backing store for the mocked config's settings */
const settings = vi.hoisted(() => ({ map: new Map() }));
/** Every write the mocked storage was handed, as `[key, value]` */
const storageWrites = vi.hoisted(() => ({ list: [] }));
/** What the mocked storage holds, so a scoped read can find a stored value */
const storageRecords = vi.hoisted(() => ({ map: new Map() }));

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
        get: async (key) => (storageRecords.map.has(key) ? storageRecords.map.get(key) : null),
        getJSON: async () => null,
        set: async (key, value) => {
            storageWrites.list.push([key, value]);
            storageRecords.map.set(key, value);
            return true;
        },
        setJSON: async () => true,
        delete: async (key) => {
            storageRecords.map.delete(key);
            return true;
        },
    },
}));
/** What the mocked adapter hands back as the game data payload — null before the
 *  client's data sheet has arrived, which is a state the sim must not run in */
const adapter = vi.hoisted(() => ({ gameData: {}, playerDTO: { hrid: 'player1' } }));
/** Every call the mocked runner received, so "never asked the worker" is testable */
const simRuns = vi.hoisted(() => ({ list: [], result: {} }));

vi.mock('../combat-sim/combat-sim-adapter.js', () => ({
    buildGameDataPayload: () => adapter.gameData,
    buildPlayerDTO: () => adapter.playerDTO,
    getCommunityBuffs: () => ({}),
}));
vi.mock('../combat-sim/combat-sim-runner.js', () => ({
    runLabyrinthSimulation: async (options) => {
        simRuns.list.push(options);
        return simRuns.result;
    },
    runBlindBuffProbe: async () => [],
    runPlayerStatProbe: async () => null,
    cancelSimulation: () => {},
}));

const {
    getSimStopRule,
    getSimHours,
    getSimPrecisionPct,
    getSimCapsUncapped,
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
const { default: labFightRecorder } = await import('./labyrinth-fight-recorder.js');
const { FINGERPRINT_VERSION } = await import('./labyrinth-fingerprint.js');

test('fight-opening capture keeps the equipped build instead of the configured room loadout', () => {
    adapter.playerDTO = {
        hrid: 'player1',
        equipment: { '/equipment_types/main_hand': { hrid: '/items/sword', enhancementLevel: 7 } },
        abilities: [{ hrid: '/abilities/slash', level: 12, triggers: [{ value: 50 }] }],
    };
    const crates = ['/items/combat_crate'];
    const buffs = [{ typeHrid: '/buff_types/damage', ratioBoost: 0.05 }];
    const configured = { hrid: 'player1', equipment: {}, abilities: [] };
    const buildLabyrinthPlayerDTO = vi.fn(() => configured);
    const ctx = {
        getLabyrinthLoadoutId: () => 3,
        buildLabyrinthPlayerDTO,
        getCrateHrids: () => crates,
        getLabyrinthCombatBuffs: () => buffs,
        labyrinthFullAbilities: () => true,
    };
    const saved = simCacheMethods.captureReplayInputs.call(ctx);
    expect(saved.playerDTO).toEqual(adapter.playerDTO);
    expect(buildLabyrinthPlayerDTO).not.toHaveBeenCalled();

    // Neither later equipment/trigger changes nor mutable buff arrays rewrite history.
    adapter.playerDTO.equipment['/equipment_types/main_hand'].enhancementLevel = 9;
    adapter.playerDTO.abilities[0].triggers[0].value = 75;
    crates.push('/items/other_crate');
    buffs[0].ratioBoost = 0.1;
    expect(saved.playerDTO.equipment['/equipment_types/main_hand'].enhancementLevel).toBe(7);
    expect(saved.playerDTO.abilities[0].triggers[0].value).toBe(50);
    expect(saved.crates).toEqual(['/items/combat_crate']);
    expect(saved.labyrinthCombatBuffs[0].ratioBoost).toBe(0.05);

    // Legacy replay still reconstructs the configured room, as its fingerprint promises.
    expect(simCacheMethods.captureReplayInputs.call(ctx, '/monsters/fly').playerDTO).toEqual(configured);
    expect(buildLabyrinthPlayerDTO).toHaveBeenCalledWith(3);
});

test('fight-opening capture remains available while configured loadout snapshots are loading', () => {
    const saved = simCacheMethods.captureReplayInputs.call({
        getLabyrinthLoadoutId: () => 3,
        buildLabyrinthPlayerDTO: () => null,
        getCrateHrids: () => [],
        getLabyrinthCombatBuffs: () => [],
        labyrinthFullAbilities: () => true,
    });
    expect(saved?.playerDTO).toEqual(adapter.playerDTO);
});

test('replay uses historical room inputs after the current build changes and reports sim failures', async () => {
    const inputs = {
        version: 1,
        playerDTO: { hrid: 'player1', attackLevel: 12 },
        crates: ['/items/old_crate'],
        communityBuffs: { comExp: 2 },
        labyrinthCombatBuffs: [],
        fullAbilities: true,
    };
    // Three fights, because a cohort under MIN_REPLAY_FIGHTS is never simulated
    const spy = vi.spyOn(labFightRecorder, 'recordedAttempts').mockReturnValue(
        Array.from({ length: 3 }, () => ({
            monsterHrid: '/monsters/fly',
            seconds: 20,
            roomLevel: 10,
            outcome: 'clear',
            complete: true,
            cleared: true,
            playerMaxHp: 100,
            playerHpStart: 100,
            fingerprintVersion: FINGERPRINT_VERSION,
            fingerprint: 'old',
            replayInputs: inputs,
        }))
    );
    try {
        const captureReplayInputs = vi.fn(() => {
            throw new Error('must use saved inputs');
        });
        const result = await simCacheMethods.replayRecordedFights.call({
            _snapshotContentFingerprint: () => 'new',
            captureReplayInputs,
            getSimHours: () => 1,
            getSimStopRule: () => ({ maxTrials: 10 }),
        });
        expect(captureReplayInputs).not.toHaveBeenCalled();
        expect(simRuns.list).toHaveLength(1);
        expect(simRuns.list[0]).toMatchObject({
            playerDTOs: [inputs.playerDTO],
            crates: inputs.crates,
            communityBuffs: inputs.communityBuffs,
            fullAbilities: true,
        });
        // The mock runner returns {}, so failure must not be called insufficient data.
        expect(result.diagnostics.failedGroups).toBe(1);
        expect(result.diagnostics.excluded.build).toBe(0);
        expect(result.diagnostics.excluded.tooFew).toBe(0);
    } finally {
        spy.mockRestore();
    }
});

test('replay exports a distinct named build reference for each historical build', async () => {
    adapter.gameData = { itemDetailMap: { '/items/steel_sword': { name: 'Steel Sword' } } };
    simRuns.result = { simulatedTime: 20e9, labyAttemptCount: 1, encounters: 1 };
    const attempts = [7, 7, 7, 9, 9, 9].map((enhancementLevel) => ({
        monsterHrid: '/monsters/fly',
        seconds: 20,
        roomLevel: 10,
        outcome: 'clear',
        complete: true,
        cleared: true,
        playerMaxHp: 100,
        playerHpStart: 100,
        replayInputs: {
            version: 1,
            playerDTO: {
                hrid: 'player1',
                equipment: { '/equipment_types/main_hand': { hrid: '/items/steel_sword', enhancementLevel } },
            },
            crates: [],
            communityBuffs: {},
            labyrinthCombatBuffs: [],
            fullAbilities: true,
        },
    }));
    const spy = vi.spyOn(labFightRecorder, 'recordedAttempts').mockReturnValue(attempts);
    try {
        const result = await simCacheMethods.replayRecordedFights.call({
            _snapshotContentFingerprint: () => 'new',
            getSimHours: () => 1,
            getSimStopRule: () => ({ maxTrials: 10 }),
        });
        const builds = result.groups.map((group) => group.build);
        expect(builds).toHaveLength(2);
        expect(new Set(builds.map((build) => build.id)).size).toBe(2);
        expect(builds[0].label).toContain('Steel Sword +7');
        expect(builds[1].label).toContain('Steel Sword +9');
        expect(JSON.stringify(builds)).not.toContain('/items/');
    } finally {
        spy.mockRestore();
    }
});

test('task progress does not fragment a replay build or consume its three-group limit', async () => {
    simRuns.result = { simulatedTime: 20e9, labyAttemptCount: 1, encounters: 1 };
    // Six fights on one build and three on another, so both cohorts clear
    // MIN_REPLAY_FIGHTS; the task counters differ on every one of them
    const attempts = [9, 8, 7, 6, 5, 4, 3, 2, 1].map((remaining, index) => ({
        monsterHrid: '/monsters/fly',
        seconds: 20,
        roomLevel: 10,
        outcome: 'clear',
        complete: true,
        cleared: true,
        playerMaxHp: 100,
        playerHpStart: 100,
        replayInputs: {
            version: 1,
            playerDTO: {
                hrid: 'player1',
                attackLevel: index >= 6 ? 11 : 10,
                taskMonsterHrids: remaining ? ['/monsters/fly'] : [],
                taskMonsterRemaining: remaining ? { '/monsters/fly': remaining } : {},
            },
            crates: [],
            communityBuffs: {},
            labyrinthCombatBuffs: [],
            fullAbilities: true,
        },
    }));
    const spy = vi.spyOn(labFightRecorder, 'recordedAttempts').mockReturnValue(attempts);
    try {
        const result = await simCacheMethods.replayRecordedFights.call({
            _snapshotContentFingerprint: () => 'new',
            getSimHours: () => 1,
            getSimStopRule: () => ({ maxTrials: 10 }),
        });
        expect(result.diagnostics).toMatchObject({ eligibleGroups: 2, deferredGroups: 0, failedGroups: 0 });
        expect(result.groups.map((group) => group.fights)).toEqual([6, 3]);
        expect(simRuns.list).toHaveLength(2);
        // The replay runner defaults task damage off; retain the original saved
        // inputs for export while ignoring that inactive metadata in equality.
        expect(simRuns.list.every((run) => run.taskDamageMode === undefined)).toBe(true);
        expect(simRuns.list[0].playerDTOs[0].taskMonsterRemaining).toEqual({ '/monsters/fly': 9 });
    } finally {
        spy.mockRestore();
    }
});

afterEach(() => {
    settings.map.clear();
    storageRecords.map.clear();
    storageWrites.list = [];
    simRuns.list = [];
    simRuns.result = {};
    adapter.gameData = {};
    adapter.playerDTO = { hrid: 'player1' };
});

/**
 * Which cohorts a Replay press spends its three simulations on.
 *
 * The bar these are pinned against: with nothing chosen the behaviour must be
 * bit-for-bit the pre-picker one — the best-sampled cohorts run and the rest
 * are reported deferred — and a choice may only redirect those simulations,
 * never raise the cap, cross either fight-count bar, or run a partial version
 * of a choice that no longer fits the pool.
 */
describe('choosing which recorded cohorts a replay runs', () => {
    /** Four cohorts on one room, told apart by attack level, with 9/7/5/3 fights */
    const FIGHT_COUNTS = [9, 7, 5, 3];

    const attemptsForCohorts = () =>
        FIGHT_COUNTS.flatMap((fights, cohort) =>
            Array.from({ length: fights }, () => ({
                monsterHrid: '/monsters/fly',
                seconds: 20,
                roomLevel: 10,
                outcome: 'clear',
                complete: true,
                cleared: true,
                playerMaxHp: 100,
                playerHpStart: 100,
                replayInputs: {
                    version: 1,
                    playerDTO: { hrid: 'player1', attackLevel: 10 + cohort },
                    crates: [],
                    communityBuffs: {},
                    labyrinthCombatBuffs: [],
                    fullAbilities: true,
                },
            }))
        );

    const context = () => ({
        _snapshotContentFingerprint: () => 'new',
        getSimHours: () => 1,
        getSimStopRule: () => ({ maxTrials: 10 }),
        ...simCacheMethods,
    });

    /** The attack level identifies the cohort each simulation actually ran */
    const simmedLevels = () => simRuns.list.map((run) => run.playerDTOs[0].attackLevel);

    let spy;
    beforeEach(() => {
        simRuns.result = { simulatedTime: 20e9, labyAttemptCount: 1, encounters: 1 };
        spy = vi.spyOn(labFightRecorder, 'recordedAttempts').mockReturnValue(attemptsForCohorts());
    });
    afterEach(() => spy?.mockRestore());

    test('with nothing chosen, the three best-sampled cohorts run exactly as before', async () => {
        const result = await context().replayRecordedFights();

        expect(simmedLevels()).toEqual([10, 11, 12]);
        expect(result.diagnostics).toMatchObject({ eligibleGroups: 4, deferredGroups: 1, failedGroups: 0 });
        expect(result.diagnostics.selection).toMatchObject({ applied: false, reason: 'empty', requested: 0 });
        expect(result.groups.map((group) => group.fights)).toEqual([9, 7, 5]);
    });

    test('the cohorts on offer carry the build label and fight count, and stop at the lower bar', async () => {
        const options = await context().replayCohortOptions();

        expect(options.max).toBe(3);
        expect(options.selected).toEqual([]);
        expect(options.cohorts.map((cohort) => cohort.fights)).toEqual([9, 7, 5, 3]);
        expect(new Set(options.cohorts.map((cohort) => cohort.key)).size).toBe(4);
        for (const cohort of options.cohorts) expect(cohort.buildLabel).toMatch(/^Build [0-9a-f]{8} /);
        // The three-fight cohort is offered and flagged; nothing below the bar is
        expect(options.cohorts.map((cohort) => cohort.exploratory)).toEqual([false, false, false, true]);
    });

    test('a chosen cohort is the one replayed, however few fights it has', async () => {
        const ctx = context();
        const options = await ctx.replayCohortOptions();
        const newest = options.cohorts.find((cohort) => cohort.fights === 3);
        expect(await ctx.setReplayCohortSelection([newest.key])).toBe(true);

        const result = await ctx.replayRecordedFights();

        // The cohort that sorts last is the only one simulated
        expect(simmedLevels()).toEqual([13]);
        expect(result.groups).toHaveLength(1);
        expect(result.diagnostics.selection).toMatchObject({ applied: true, reason: null, requested: 1 });
        // Diagnostics still describe what happened: three eligible cohorts did not run
        expect(result.diagnostics).toMatchObject({ eligibleGroups: 4, deferredGroups: 3, failedGroups: 0 });
    });

    test('a chosen cohort still obeys both fight-count bars', async () => {
        const ctx = context();
        const options = await ctx.replayCohortOptions();
        const newest = options.cohorts.find((cohort) => cohort.fights === 3);
        await ctx.setReplayCohortSelection([newest.key]);

        const result = await ctx.replayRecordedFights();

        // Above MIN_REPLAY_FIGHTS and below the verdict bar: run, but flagged
        expect(result.groups[0]).toMatchObject({ fights: 3, exploratory: true });
        expect(result.diagnostics).toMatchObject({ minFights: 3, verdictMinFights: 5 });

        // A two-fight cohort is not on offer at all, so it cannot be chosen
        spy.mockReturnValue(attemptsForCohorts().slice(0, 2));
        expect(await ctx.replayCohortOptions()).toMatchObject({ cohorts: [] });
        simRuns.list = [];
        const tooFew = await ctx.replayRecordedFights();
        expect(simRuns.list).toHaveLength(0);
        expect(tooFew.diagnostics.excluded.tooFew).toBe(2);
    });

    test('choosing more cohorts than a replay can run is refused, not truncated', async () => {
        const ctx = context();
        const options = await ctx.replayCohortOptions();
        const all = options.cohorts.map((cohort) => cohort.key);

        // The write itself refuses, so an over-cap choice never becomes the state
        expect(await ctx.setReplayCohortSelection(all)).toBe(false);

        // And a stored one — written before the cap, or by an older version —
        // falls back to the default rather than running its first three
        storageRecords.map.set('labyrinthReplayCohorts_me', all);
        const result = await ctx.replayRecordedFights();
        expect(simmedLevels()).toEqual([10, 11, 12]);
        expect(result.diagnostics.selection).toMatchObject({ applied: false, reason: 'overCap', requested: 4 });
    });

    test('a selection that no longer matches the pool falls back to the default', async () => {
        const ctx = context();
        const options = await ctx.replayCohortOptions();
        const newest = options.cohorts.find((cohort) => cohort.fights === 3);
        await ctx.setReplayCohortSelection([newest.key]);

        // The build is evicted from the pool: its cohort no longer exists
        spy.mockReturnValue(attemptsForCohorts().filter((attempt) => attempt.replayInputs.playerDTO.attackLevel < 13));

        // The picker reports no choice in force, because none is
        expect((await ctx.replayCohortOptions()).selected).toEqual([]);

        const result = await ctx.replayRecordedFights();
        expect(simmedLevels()).toEqual([10, 11, 12]);
        expect(result.groups).toHaveLength(3);
        expect(result.diagnostics.selection).toMatchObject({ applied: false, reason: 'stale', requested: 1 });
    });

    test('the choice is stored per character', async () => {
        const ctx = context();
        const options = await ctx.replayCohortOptions();
        await ctx.setReplayCohortSelection([options.cohorts[0].key]);

        expect(storageWrites.list.map(([key]) => key)).toContain('labyrinthReplayCohorts_me');
        expect((await ctx.replayCohortOptions()).selected).toEqual([options.cohorts[0].key]);

        // Clearing it puts the default back
        await ctx.setReplayCohortSelection([]);
        expect((await ctx.replayCohortOptions()).selected).toEqual([]);
    });
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
        expect(getSimHours()).toBe(24);
        settings.map.set('labyrinthSimMaxHours', 500000);
        expect(getSimHours()).toBe(100000);
        settings.map.set('labyrinthSimMaxHours', 2.9);
        expect(getSimHours()).toBe(2);
        settings.map.set('labyrinthSimMaxHours', 0);
        expect(getSimHours()).toBe(24);
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
        settings.map.set('labyrinthSimMaxHours', 7);
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
        expect(resolveSimHours(false)).toBe(24);
        expect(resolveSimHours(true)).toBe(100000);
    });
});

/**
 * The Automation tab briefly had a precision and an uncapped flag of its own.
 * Both are gone: cached results are keyed on the precision they were run at, so
 * two settings that could differ meant every lookup missed and every redraw
 * re-simmed the room. One budget now answers for every labyrinth sim.
 */
describe('the Automation tab follows the one labyrinth sim budget', () => {
    test('its precision is the floor map’s, not a second knob', () => {
        settings.map.set('labyrinthSimPrecision', 2.5);
        expect(getAutomationSimPrecisionPct()).toBe(2.5);
        expect(getAutomationSimPrecisionPct()).toBe(getSimPrecisionPct());
    });

    test('a value left in the retired automation key cannot resurrect itself', () => {
        // The old knob is folded into labyrinthSimPrecision once, at load; the
        // stored key stays behind for older builds and must not be read here
        settings.map.set('labyrinthSimPrecision', 2.5);
        settings.map.set('labyrinthAutomationSimPrecision', 0.5);
        expect(getAutomationSimPrecisionPct()).toBe(2.5);
    });

    test('the caps choice is what every tab’s uncapped flag reads', () => {
        settings.map.set('labyrinthSimPrecision', 3);
        expect(automationSimOptions()).toEqual({ precisionPct: 3, uncapped: false });
        expect(getAutomationUncapped()).toBe(false);
        expect(getSimCapsUncapped()).toBe(false);

        settings.map.set('labyrinthSimCaps', 'precision');
        expect(getSimCapsUncapped()).toBe(true);
        expect(getAutomationUncapped()).toBe(true);
        expect(automationSimOptions()).toEqual({ precisionPct: 3, uncapped: true });
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
