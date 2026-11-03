/** @vitest-environment happy-dom */

/**
 * An ended trial's measurement, kept until somebody opens Stats.
 *
 * The game sends `guild_trial_stats_updated` only on that click, and one fight is
 * held at a time: a later fight, a character switch or a reload could take the
 * measurement with it. These run the real store over a fake IndexedDB, so the
 * pairing is shown to survive everything between the fight and the click, and to
 * stay out of `trials` until the game's figures are there beside it.
 *
 * Shapes are the capture's (`src/__fixtures__/wire/guild-trial.js`), test server only.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    clientData: {},
    wsHandlers: {},
    ownId: 900001,
    guildName: 'SuperMoo',
    members: {},
    settings: {},
    disk: new Map(),
    unreadable: false,
    testServer: false,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.clientData,
        getCurrentCharacterName: () => null,
        getCurrentCharacterId: () => game.ownId,
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, storeName, fallback) => {
            const id = `${storeName}:${key}`;
            // What the read found is decided first, as a transaction's would be, then held open
            const found = game.disk.has(id) ? structuredClone(game.disk.get(id)) : fallback;
            if (game.readGate) {
                await game.readGate;
                return found;
            }
            return game.disk.has(id) ? structuredClone(game.disk.get(id)) : fallback;
        },
        tryGet: async (key, storeName) => {
            if (game.unreadable) return null;
            const id = `${storeName}:${key}`;
            return game.disk.has(id)
                ? { found: true, value: structuredClone(game.disk.get(id)) }
                : { found: false, value: null };
        },
        // As the real one: a folding write is folded again against what is stored as it lands
        set: async (key, value, storeName, _immediate, options) => {
            const id = `${storeName}:${key}`;
            const stored = game.disk.has(id) ? structuredClone(game.disk.get(id)) : undefined;
            game.disk.set(id, structuredClone(options?.fold ? (options.fold(stored, value) ?? value) : value));
            return true;
        },
        delete: async (key, storeName) => game.disk.delete(`${storeName}:${key}`),
        getAllKeys: async () => [],
        tryGetAllKeys: async () => [],
        onBeforeTeardown: () => () => {},
    },
}));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback) => (key in game.settings ? game.settings[key] : (fallback ?? true)),
        onSettingChange: () => () => {},
    },
}));
vi.mock('../../utils/game-server.js', () => ({
    isTestServer: () => game.testServer,
    gameOrigin: () => 'https://www.milkywayidle.com',
    liveGameOrigin: (origin) => origin,
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, handler) => {
            game.wsHandlers[type] = handler;
        },
        off: (type) => delete game.wsHandlers[type],
    },
}));
vi.mock('./guild-loadout-capture.js', () => ({
    guildLoadoutCapture: { seen: () => [], forPlayer: () => null },
    default: { seen: () => [], forPlayer: () => null },
}));
vi.mock('./guild-trial-abilities.js', () => ({ default: { noteAbilityCast: () => true } }));
vi.mock('./guild-xp-tracker.js', () => ({
    guildXPTracker: {
        getMemberMeta: (id) => (game.members[id] ? { name: game.members[id] } : null),
        getOwnGuildName: () => game.guildName,
        getOwnGuildID: () => game.trackerGuildId,
        getCurrentWeekStartAt: () => game.gameWeek,
    },
}));

const { guildTrialDamage, GUILD_BATTLE_MESSAGE } = await import('./guild-trial-damage.js');
const { waitingFightsNote } = await import('./guild-trial-scoreboard.js');
const { loadTrialStats, saveTrialStats, trialStatsStorageKey } = await import('./guild-trials-store.js');
const { trialWeekStart } = await import('./guild-trials-math.js');
const { buildEndGuildBattle, buildGuildBattleUpdated, buildGuildTrialStatsUpdated, buildNewGuildBattle } =
    await import('../../__fixtures__/wire/guild-trial.js');

const at = Date.parse('2026-11-02T22:00:08Z');
const SWARM = '/guild_combat/swarm';
const JELLYFISH = '/guild_combat/jellyfish';
const GUILD_ID = buildGuildTrialStatsUpdated().guildId;

const stored = (guildName = 'SuperMoo', characterId = game.ownId) =>
    game.disk.get(`guildHistory:${trialStatsStorageKey(guildName, characterId)}`);
const settle = () => vi.advanceTimersByTimeAsync(0);

/** Swings by slots 0 and 1 on the real tick shape, so both are measured */
function swing(tier, atk, hp, dmg, battleId = 1) {
    const late = buildGuildBattleUpdated('late');
    const unit = late.pMap['37'];
    const boss = late.mMap['3'];
    game.wsHandlers[GUILD_BATTLE_MESSAGE](
        buildGuildBattleUpdated('late', {
            battleId,
            tier,
            pMap: { 0: { ...unit, atkCounter: atk }, 1: { ...unit, atkCounter: atk } },
            mMap: { 0: { ...boss, cHP: hp, dmgCounter: dmg } },
        })
    );
}

/** The swarm fight, watched from tier 1, then ended by the game */
function watchSwarm({ end = true } = {}) {
    game.wsHandlers.new_guild_battle(buildNewGuildBattle());
    swing(1, 1, 300_000, 0);
    vi.setSystemTime(Date.now() + 500);
    swing(1, 2, 290_000, 1);
    if (end) game.wsHandlers.end_guild_battle(buildEndGuildBattle());
}

/** The ids the capture's rows give a trial, in order */
const idsOf = (hrid) => [
    ...new Set(
        buildGuildTrialStatsUpdated()
            .guildTrialStatList.filter((row) => row.trialHrid === hrid)
            .map((row) => row.characterId)
    ),
];

/** A second fight, of the other combat party */
function watchJellyfish() {
    const base = buildNewGuildBattle();
    const ids = idsOf(JELLYFISH).slice(0, 3);
    for (const id of ids) game.members[id] = `Jelly${id}`;
    game.wsHandlers.new_guild_battle(
        buildNewGuildBattle({
            battleId: 2,
            combatStartTime: new Date(Date.now()).toISOString(),
            players: ids.map((id) => ({
                ...structuredClone(base.players[0]),
                character: { ...base.players[0].character, id, name: `Jelly${id}` },
                name: `Jelly${id}`,
            })),
            monsters: [{ ...base.monsters[0], hrid: '/monsters/trial_jellyfish', name: 'Trial Jellyfish' }],
        })
    );
    swing(1, 1, 300_000, 0, 2);
}

/** A page reload: what is on disk is all that is left */
async function reload({ restore = true } = {}) {
    game.settings.combatSessionRestore = restore;
    guildTrialDamage.cleanup();
    guildTrialDamage.initialize();
    guildTrialDamage.setGuildName(game.guildName, game.ownId);
    await settle();
}

beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(at);
    game.disk.clear();
    game.wsHandlers = {};
    game.ownId = 900001;
    game.guildName = 'SuperMoo';
    game.settings = {};
    game.unreadable = false;
    game.testServer = false;
    game.gameWeek = '2026-11-02T00:00:00Z';
    game.trackerGuildId = null;
    game.readGate = null;
    game.members = {};
    guildTrialDamage.cleanup();
    guildTrialDamage.statsScope = { guildName: null, characterId: null };
    guildTrialDamage.initialize();
    guildTrialDamage.setGuildName('SuperMoo', 900001);
    await settle();
    vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
    guildTrialDamage.cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('an ended fight’s measurement is written down when the game ends it', () => {
    test('beside the week’s trials, so no reader takes it for the game’s figures', async () => {
        watchSwarm();
        await settle();
        const blob = stored();
        expect(blob.trials).toEqual({});
        expect(Object.keys(blob.unreconciled)).toEqual(['swarm']);
        expect(blob.unreconciled.swarm.measured.FixtureCharacter).toBeDefined();
        expect(blob.unreconciled.swarm.endedAt).toBe(Date.now());
    });

    test.each([
        [
            'a quiet stream, which may be a fight still running with the view shut',
            () => {
                watchSwarm({ end: false });
                vi.setSystemTime(Date.now() + 10 * 60_000);
                guildTrialDamage.breakdown();
            },
        ],
        ['a fight nobody watched', () => game.wsHandlers.end_guild_battle(buildEndGuildBattle())],
    ])('not for %s', async (_label, run) => {
        run();
        await settle();
        expect(stored()?.unreconciled).toBeUndefined();
    });

    test('an ending that names no encounter waits for one that does', async () => {
        game.wsHandlers.new_guild_battle(buildNewGuildBattle({ monsters: [] }));
        swing(1, 1, 300_000, 0);
        swing(1, 2, 290_000, 1);
        guildTrialDamage._endByGame('guild_updated', Date.now());
        await settle();
        expect(stored()?.unreconciled).toBeUndefined();
        game.wsHandlers.end_guild_battle(buildEndGuildBattle());
        await settle();
        expect(Object.keys(stored().unreconciled)).toEqual(['swarm']);
    });

    test('totals already in hand leave nothing to wait for', async () => {
        watchSwarm();
        game.wsHandlers.guild_trial_stats_updated(buildGuildTrialStatsUpdated());
        await settle();
        const before = stored();
        expect(before.unreconciled).toBeUndefined();
        game.wsHandlers.end_guild_battle(buildEndGuildBattle());
        await settle();
        expect(stored().unreconciled).toBeUndefined();
    });

    test('a fight the game ended that then goes on takes it back, and ending again saves it again', async () => {
        watchSwarm();
        await settle();
        expect(stored().unreconciled).toBeDefined();
        vi.setSystemTime(Date.now() + 1_000);
        game.wsHandlers.new_guild_battle(buildNewGuildBattle({ tier: 2 }));
        swing(2, 3, 280_000, 2);
        await settle();
        expect(stored().unreconciled).toBeUndefined();
        expect(guildTrialDamage.breakdown().waitingFights).toEqual([]);

        game.wsHandlers.end_guild_battle(buildEndGuildBattle());
        await settle();
        expect(stored().unreconciled.swarm.endedAt).toBe(Date.now());
    });
});

describe('a later Stats click reconciles it', () => {
    /** Asserts the swarm rows met the swarm measurement and the jellyfish rows met nothing */
    const expectSwarmPaired = () => {
        const blob = stored();
        expect(blob.unreconciled).toBeUndefined();
        expect(blob.trials.swarm.measured.FixtureCharacter).toBeDefined();
        expect(blob.trials.swarm.reported.FixtureCharacter.damage).toBeGreaterThan(0);
        expect(guildTrialDamage.breakdown().storedStats.swarm.measured).toEqual(blob.trials.swarm.measured);
        expect(guildTrialDamage.breakdown().waitingFights).toEqual([]);
    };

    test('after a later fight has replaced it, leaving that fight’s own figures alone', async () => {
        watchSwarm();
        await settle();
        const measured = stored().unreconciled.swarm.measured;
        vi.setSystemTime(Date.now() + 5 * 60_000);
        watchJellyfish();
        await settle();
        expect(guildTrialDamage.breakdown().encounter).toBe('jellyfish');
        expect(guildTrialDamage.breakdown().waitingFights.map((fight) => fight.encounter)).toEqual(['swarm']);

        vi.setSystemTime(Date.now() + 20 * 60_000);
        game.wsHandlers.guild_trial_stats_updated(buildGuildTrialStatsUpdated());
        await settle();

        expectSwarmPaired();
        expect(stored().trials.swarm.measured).toEqual(measured);
        // The held fight is still running: its rows are a roster and its board has no game totals
        expect(guildTrialDamage.breakdown().reported).toBe(null);
        expect(stored().trials.jellyfish.measured).toBe(null);
    });

    test('after a reload with restoring off, when no fight is held at all', async () => {
        watchSwarm();
        await settle();
        await reload({ restore: false });
        expect(guildTrialDamage.breakdown().source).toBe(null);
        expect(guildTrialDamage.breakdown().waitingFights.map((fight) => fight.encounter)).toEqual(['swarm']);

        // Nothing in this page has named anybody: the guild's own roster does
        game.members = { 900001: 'FixtureCharacter', 900002: 'Player02', 900003: 'Player03' };
        vi.setSystemTime(Date.now() + 3 * 60 * 60_000);
        game.wsHandlers.guild_trial_stats_updated(buildGuildTrialStatsUpdated());
        await settle();
        expectSwarmPaired();
    });

    test('after a reload that restores it, through the held-fight path, with nothing left waiting', async () => {
        watchSwarm();
        await settle();
        await vi.advanceTimersByTimeAsync(10_000);
        await reload();
        expect(guildTrialDamage.breakdown().encounter).toBe('swarm');
        game.wsHandlers.guild_trial_stats_updated(buildGuildTrialStatsUpdated());
        await settle();
        expect(guildTrialDamage.breakdown().reported).not.toBe(null);
        expectSwarmPaired();
    });

    test('after a character switch to an alt and back', async () => {
        watchSwarm();
        await settle();
        game.ownId = 900002;
        guildTrialDamage.setGuildName(null, 900002);
        guildTrialDamage.reset();
        guildTrialDamage.setGuildName('SuperMoo', 900002);
        await settle();
        game.ownId = 900001;
        guildTrialDamage.setGuildName(null, 900001);
        guildTrialDamage.setGuildName('SuperMoo', 900001);
        await settle();

        game.members = { 900001: 'FixtureCharacter', 900002: 'Player02', 900003: 'Player03' };
        game.wsHandlers.guild_trial_stats_updated(buildGuildTrialStatsUpdated());
        await settle();
        expectSwarmPaired();
    });

    test('a repeat of the message refreshes the figures and keeps the pair', async () => {
        watchSwarm();
        await settle();
        vi.setSystemTime(Date.now() + 5 * 60_000);
        watchJellyfish();
        game.wsHandlers.guild_trial_stats_updated(buildGuildTrialStatsUpdated());
        await settle();
        const measured = stored().trials.swarm.measured;

        const later = buildGuildTrialStatsUpdated();
        later.guildTrialStatList.find((row) => row.characterId === 900001 && row.trialHrid === SWARM).damageDealt = 7;
        game.wsHandlers.guild_trial_stats_updated(later);
        await settle();
        expect(stored().trials.swarm.reported.FixtureCharacter.damage).toBe(7);
        expect(stored().trials.swarm.measured).toEqual(measured);
    });

    test('a pair another tab or device already made is not undone by the copy in memory', async () => {
        watchSwarm();
        await settle();
        const blob = stored();
        blob.trials.swarm = { reported: { FixtureCharacter: { damage: 1 } }, measured: {}, at: Date.now() + 1 };
        delete blob.unreconciled;
        game.disk.set(`guildHistory:${trialStatsStorageKey('SuperMoo', 900001)}`, blob);
        vi.setSystemTime(Date.now() + 5 * 60_000);
        watchJellyfish();
        await settle();
        expect(stored().unreconciled).toBeUndefined();
    });
});

describe('a message that cannot describe the fight leaves it waiting', () => {
    const replaced = async () => {
        watchSwarm();
        await settle();
        vi.setSystemTime(Date.now() + 5 * 60_000);
        watchJellyfish();
        await settle();
    };

    test('rows naming other people', async () => {
        await replaced();
        const others = idsOf(SWARM).filter((id) => id > 900006);
        for (const id of others) game.members[id] = `Other${id}`;
        game.wsHandlers.guild_trial_stats_updated(
            buildGuildTrialStatsUpdated({ keep: (row) => row.trialHrid === SWARM && others.includes(row.characterId) })
        );
        await settle();
        expect(stored().trials.swarm.measured).toBe(null);
        expect(stored().unreconciled.swarm).toBeDefined();
        expect(guildTrialDamage.breakdown().waitingFights).toHaveLength(1);
    });

    test('another guild’s frame, by the guild the fight was saved under', async () => {
        game.wsHandlers.guild_updated({ guild: { id: GUILD_ID } });
        await replaced();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        game.wsHandlers.guild_trial_stats_updated(buildGuildTrialStatsUpdated({ guildId: GUILD_ID + 1 }));
        await settle();
        expect(warn).toHaveBeenCalled();
        expect(stored().trials.swarm).toBeUndefined();
        expect(stored().unreconciled.swarm).toBeDefined();
    });

    test('a guild of the same name whose id differs from the one the fight was measured in', async () => {
        game.wsHandlers.guild_updated({ guild: { id: GUILD_ID } });
        await replaced();
        guildTrialDamage.ownGuildId = GUILD_ID + 1;
        game.wsHandlers.guild_trial_stats_updated(buildGuildTrialStatsUpdated({ guildId: GUILD_ID + 1 }));
        await settle();
        expect(stored().trials.swarm.measured).toBe(null);
        expect(stored().unreconciled.swarm).toBeDefined();
    });

    test('a frame with no combat rows, and an empty one', async () => {
        await replaced();
        game.wsHandlers.guild_trial_stats_updated(buildGuildTrialStatsUpdated({ keep: () => false }));
        game.wsHandlers.guild_trial_stats_updated(
            buildGuildTrialStatsUpdated({ keep: (row) => row.trialHrid.startsWith('/guild_skilling/') })
        );
        await settle();
        expect(stored().unreconciled.swarm).toBeDefined();
    });

    test('a later trial week: the week’s blob goes, and the fight with it', async () => {
        await replaced();
        vi.setSystemTime(at + 8 * 24 * 60 * 60_000);
        expect(guildTrialDamage.breakdown().waitingFights).toEqual([]);
        game.wsHandlers.guild_trial_stats_updated(buildGuildTrialStatsUpdated());
        await settle();
        expect(stored().unreconciled).toBeUndefined();
        expect(stored().trials.swarm.measured).toBe(null);
    });

    test('a test-server fight of another cycle stays out, in memory as on disk', async () => {
        game.testServer = true;
        watchSwarm();
        await settle();
        vi.setSystemTime(at + 24 * 60 * 60_000);
        const base = buildNewGuildBattle();
        game.wsHandlers.new_guild_battle(
            buildNewGuildBattle({ battleId: 2, combatStartTime: new Date(Date.now()).toISOString() })
        );
        swing(base.tier, 1, 300_000, 0, 2);
        await settle();
        expect(guildTrialDamage.breakdown().waitingFights).toEqual([]);
        game.wsHandlers.guild_trial_stats_updated(buildGuildTrialStatsUpdated());
        await settle();
        expect(stored().trials.swarm.measured).toBe(null);
        expect(stored().unreconciled).toBeUndefined();
    });
});

describe('on the test server, with no fight held when Stats is opened hours later', () => {
    const afterASwitch = async () => {
        game.testServer = true;
        watchSwarm();
        await settle();
        // A character switch away and back: the held fight and its live save are gone
        guildTrialDamage.setGuildName(null, 900002);
        guildTrialDamage.reset();
        guildTrialDamage.setGuildName('SuperMoo', 900002);
        guildTrialDamage.setGuildName(null, 900001);
        guildTrialDamage.setGuildName('SuperMoo', 900001);
        await settle();
        game.members = { 900001: 'FixtureCharacter', 900002: 'Player02', 900003: 'Player03' };
        vi.setSystemTime(Date.now() + 3 * 60 * 60_000);
    };

    test('the game’s cycle is still the fight’s, so they pair under the fight’s own cycle', async () => {
        await afterASwitch();
        game.wsHandlers.guild_trial_stats_updated(buildGuildTrialStatsUpdated());
        await settle();
        const blob = stored();
        expect(blob.unreconciled).toBeUndefined();
        expect(blob.trials.swarm.measured.FixtureCharacter).toBeDefined();
        expect(blob.earlierCycles).toBeUndefined();
    });

    test('the game has moved to the next cycle, so the message is that cycle’s and the fight is left behind', async () => {
        await afterASwitch();
        game.gameWeek = '2026-11-03T00:00:00Z';
        game.wsHandlers.guild_trial_stats_updated(buildGuildTrialStatsUpdated());
        await settle();
        expect(stored().trials.swarm.measured).toBe(null);
        expect(stored().unreconciled).toBeUndefined();
    });
});

describe('when writing fails', () => {
    test('a refused save keeps the fight in memory, and the click still pairs it', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        game.unreadable = true;
        watchSwarm();
        await settle();
        expect(stored()).toBeUndefined();
        expect(warn).toHaveBeenCalled();

        game.unreadable = false;
        vi.setSystemTime(Date.now() + 5 * 60_000);
        watchJellyfish();
        game.wsHandlers.guild_trial_stats_updated(buildGuildTrialStatsUpdated());
        await settle();
        expect(stored().trials.swarm.measured.FixtureCharacter).toBeDefined();
    });

    test('a pair that cannot be written leaves the fight waiting on disk, and the next click pairs it', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        watchSwarm();
        await settle();
        vi.setSystemTime(Date.now() + 5 * 60_000);
        watchJellyfish();
        await settle();

        game.unreadable = true;
        game.wsHandlers.guild_trial_stats_updated(buildGuildTrialStatsUpdated());
        await settle();
        expect(stored().unreconciled.swarm).toBeDefined();
        expect(guildTrialDamage.breakdown().waitingFights).toHaveLength(1);

        game.unreadable = false;
        game.wsHandlers.guild_trial_stats_updated(buildGuildTrialStatsUpdated());
        await settle();
        expect(stored().unreconciled).toBeUndefined();
        expect(stored().trials.swarm.measured.FixtureCharacter).toBeDefined();
    });
});

describe('whose fight it is', () => {
    test('a guild change mid-read files the fight under the guild it was measured in', async () => {
        watchSwarm();
        guildTrialDamage.setGuildName('Other', 900001);
        await settle();
        expect(stored().unreconciled.swarm).toBeDefined();
        expect(stored('Other')?.unreconciled).toBeUndefined();
        expect(guildTrialDamage.breakdown().waitingFights).toEqual([]);
    });

    test('a fight saved before the guild was known moves onto the guild’s key', async () => {
        guildTrialDamage.setGuildName(null, 900001);
        await settle();
        watchSwarm();
        await settle();
        expect(stored(null).unreconciled.swarm).toBeDefined();

        guildTrialDamage.setGuildName('SuperMoo', 900001);
        await settle();
        expect(stored().unreconciled.swarm).toBeDefined();
    });
});

describe('memory and disk while a read is out', () => {
    /** Holds every stats read open until the returned function is called */
    const holdReads = () => {
        let release;
        game.readGate = new Promise((resolve) => {
            release = resolve;
        });
        return () => {
            game.readGate = null;
            release();
        };
    };

    const fightOf = (damage, endedAt) => ({
        measured: { FixtureCharacter: { damage, healing: 0, taken: 0 } },
        endedAt,
        cycleAt: null,
        weekStartAt: null,
        guildId: null,
    });

    test('a fight saved during the read is neither dropped from memory nor from disk', async () => {
        watchSwarm();
        await settle();
        const release = holdReads();
        const frame = buildGuildTrialStatsUpdated({ keep: (row) => row.trialHrid === JELLYFISH });
        for (const id of idsOf(JELLYFISH).slice(0, 3)) game.members[id] = `Jelly${id}`;
        game.wsHandlers.guild_trial_stats_updated(frame);
        await settle();
        // Saved while that read is held open
        guildTrialDamage.savedFights = { ...guildTrialDamage.savedFights, badger: fightOf(5, Date.now()) };
        release();
        await settle();
        expect(Object.keys(guildTrialDamage.savedFights).sort()).toEqual(['badger', 'swarm']);
        expect(Object.keys(stored().unreconciled).sort()).toEqual(['badger', 'swarm']);
    });

    test('a fight withdrawn during the read does not come back from what that read found', async () => {
        watchSwarm();
        await settle();
        expect(stored().unreconciled.swarm).toBeDefined();
        const release = holdReads();
        for (const id of idsOf(JELLYFISH).slice(0, 3)) game.members[id] = `Jelly${id}`;
        game.wsHandlers.guild_trial_stats_updated(
            buildGuildTrialStatsUpdated({ keep: (row) => row.trialHrid === JELLYFISH })
        );
        await settle();
        // The fight goes on: its end is taken back, and that write finishes, while the read above is out
        game.readGate = null;
        vi.setSystemTime(Date.now() + 1_000);
        game.wsHandlers.new_guild_battle(buildNewGuildBattle({ tier: 2 }));
        await settle();
        expect(stored().unreconciled).toBeUndefined();
        release();
        await settle();
        expect(guildTrialDamage.savedFights.swarm).toBeUndefined();
        expect(stored().unreconciled).toBeUndefined();
    });

    test('newer memory beats the older copy on disk, and the fuller of two wins either way round', async () => {
        const at0 = Date.now();
        const key = `guildHistory:${trialStatsStorageKey('SuperMoo', 900001)}`;
        const weekStart = trialWeekStart(at0);
        // Disk: a partial watch of the fight, from another alt or device
        game.disk.set(key, { weekStart, trials: {}, unreconciled: { swarm: fightOf(100, at0 - 1) } });
        watchSwarm();
        await settle();
        // This client measured the whole of it; a later write of something else must not lose that to the disk copy
        game.disk.set(key, { weekStart, trials: {}, unreconciled: { swarm: fightOf(100, at0 + 5) } });
        guildTrialDamage._persistStats({}, { fights: { badger: fightOf(1, at0) } });
        await settle();
        expect(stored().unreconciled.swarm.measured.FixtureCharacter.damage).toBeGreaterThan(100);
        expect(guildTrialDamage.savedFights.swarm.measured.FixtureCharacter.damage).toBeGreaterThan(100);

        // …and the fuller copy on disk is not replaced by a partial one arriving here
        game.disk.set(key, { weekStart, trials: {}, unreconciled: { swarm: fightOf(5000, at0 - 1) } });
        await saveTrialStats(
            { weekStart, trials: {}, unreconciled: { swarm: fightOf(100, at0 + 5) } },
            { guildName: 'SuperMoo', characterId: 900001 }
        );
        await settle();
        expect(stored().unreconciled.swarm.measured.FixtureCharacter.damage).toBe(5000);

        // On equal totals, the later
        await saveTrialStats(
            { weekStart, trials: {}, unreconciled: { swarm: { ...fightOf(5000, at0 + 9), guildId: 'later' } } },
            { guildName: 'SuperMoo', characterId: 900001 }
        );
        await settle();
        expect(stored().unreconciled.swarm.guildId).toBe('later');
    });

    test.each([
        ['a stats frame', () => game.wsHandlers.guild_trial_stats_updated(buildGuildTrialStatsUpdated())],
        ['a restore', () => guildTrialDamage._restoreStats()],
    ])('%s still reading at cleanup leaves the stopped module empty', async (_label, start) => {
        watchSwarm();
        await settle();
        game.members = { 900001: 'FixtureCharacter', 900002: 'Player02' };
        const release = holdReads();
        start();
        await settle();
        guildTrialDamage.cleanup();
        const before = guildTrialDamage.storedStats;
        release();
        await settle();
        expect(guildTrialDamage.savedFights).toEqual({});
        // The read's merged copy does not land in memory
        expect(guildTrialDamage.storedStats).toBe(before);
    });
});

describe('a fight saved with a real guild id, from the tracker', () => {
    const replaced = async () => {
        watchSwarm();
        await settle();
        vi.setSystemTime(Date.now() + 5 * 60_000);
        watchJellyfish();
        await settle();
    };

    test('carries the id and pairs with its own guild’s frame, whatever type the id arrived as', async () => {
        game.trackerGuildId = String(GUILD_ID);
        await replaced();
        expect(stored().unreconciled.swarm.guildId).toBe(String(GUILD_ID));
        game.wsHandlers.guild_trial_stats_updated(buildGuildTrialStatsUpdated({ guildId: GUILD_ID }));
        await settle();
        expect(stored().unreconciled).toBeUndefined();
        expect(stored().trials.swarm.measured.FixtureCharacter).toBeDefined();
    });

    test('does not pair with another guild’s frame, and stays waiting', async () => {
        game.trackerGuildId = String(GUILD_ID);
        await replaced();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        game.wsHandlers.guild_trial_stats_updated(buildGuildTrialStatsUpdated({ guildId: GUILD_ID + 1 }));
        await settle();
        expect(warn).toHaveBeenCalled();
        expect(stored().trials.swarm).toBeUndefined();
        expect(stored().unreconciled.swarm).toBeDefined();
    });

    test('nor, once this client is in another guild of the same name, with that guild’s frame', async () => {
        game.trackerGuildId = String(GUILD_ID);
        await replaced();
        game.trackerGuildId = String(GUILD_ID + 1);
        game.wsHandlers.guild_trial_stats_updated(buildGuildTrialStatsUpdated({ guildId: GUILD_ID + 1 }));
        await settle();
        expect(stored().trials.swarm.measured).toBe(null);
        expect(stored().unreconciled.swarm).toBeDefined();
    });
});

describe('the blob, for an older build and a rollback', () => {
    const scope = { guildName: 'SuperMoo', characterId: 900001 };

    test('with nothing waiting it has exactly the shape it always had', async () => {
        const weekStart = trialWeekStart(Date.now());
        await saveTrialStats({ weekStart, trials: { swarm: { reported: {}, measured: null, at: 1 } } }, scope);
        expect(Object.keys(stored()).sort()).toEqual(['trials', 'weekStart']);
        await expect(loadTrialStats(Date.now(), scope)).resolves.toEqual({
            weekStart,
            trials: { swarm: { reported: {}, measured: null, at: 1 } },
        });
    });

    test('an older build’s save, which knows nothing of the field, leaves it for this build to find', async () => {
        watchSwarm();
        await settle();
        const weekStart = trialWeekStart(Date.now());
        await saveTrialStats({ weekStart, trials: { badger: { reported: {}, measured: null, at: 1 } } }, scope);
        expect(stored().unreconciled.swarm).toBeDefined();
        expect(Object.keys(stored().trials)).toEqual(['badger']);
    });

    test('an older build’s reader finds no entry in trials for a fight that is only waiting', async () => {
        watchSwarm();
        await settle();
        expect(stored().trials.swarm).toBeUndefined();
    });

    test('two fights saved close together both stand, and withdrawing one leaves the other', async () => {
        const weekStart = trialWeekStart(Date.now());
        const fight = { measured: { A: {} }, endedAt: Date.now(), cycleAt: null, guildId: null };
        await saveTrialStats({ weekStart, trials: {}, unreconciled: { swarm: fight } }, scope);
        await saveTrialStats({ weekStart, trials: {}, unreconciled: { badger: fight } }, scope);
        expect(Object.keys(stored().unreconciled).sort()).toEqual(['badger', 'swarm']);
        await saveTrialStats({ weekStart, trials: {}, unreconciled: { swarm: null } }, scope);
        expect(Object.keys(stored().unreconciled)).toEqual(['badger']);
    });
});

describe('the board’s line', () => {
    test('says nothing with nothing waiting', () => {
        expect(waitingFightsNote({ waitingFights: [] })).toBe('');
        expect(waitingFightsNote({})).toBe('');
    });

    test('names one fight, and several', () => {
        expect(waitingFightsNote({ waitingFights: [{ encounter: 'swarm' }] })).toContain(
            'Swarm: not compared with the game’s totals yet. Open Stats in the game to compare it.'
        );
        expect(
            waitingFightsNote({
                waitingFights: [{ encounter: 'swarm' }, { encounter: 'jellyfish' }, { encounter: 'badger' }],
            })
        ).toContain('Swarm, Jellyfish and Badger: not compared');
    });

    test('never for the held fight, which has its own', async () => {
        watchSwarm();
        await settle();
        expect(guildTrialDamage.breakdown().waitingFights).toEqual([]);
    });
});
