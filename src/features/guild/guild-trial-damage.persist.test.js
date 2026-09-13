/** @vitest-environment happy-dom */

/**
 * The live trial tally through a page refresh, and through a reconnect.
 *
 * A refresh is `cleanup` (what the page left on disk is what it wrote), the
 * clock moving while it is shut, then `initialize`. The saved tally may only be
 * taken back for the same character in the same guild, and only once the
 * stream shows the same fight — `battleId` is 1 for every tier of every trial,
 * so the tier, the fight's start and the encounter are what decide. A trial the
 * game already ended has no stream left to show, and comes back on its own.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    clientData: {},
    wsHandlers: {},
    ownId: 900001,
    guildName: null,
    storedRoster: null,
    settings: {},
    disk: new Map(),
    deletes: [],
    gate: null,
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
            if (game.gate) await game.gate;
            const id = `${storeName}:${key}`;
            return game.disk.has(id) ? structuredClone(game.disk.get(id)) : fallback;
        },
        set: (key, value, storeName) => {
            game.disk.set(`${storeName}:${key}`, structuredClone(value));
            return Promise.resolve(true);
        },
        delete: async (key, storeName) => {
            game.deletes.push(key);
            game.disk.delete(`${storeName}:${key}`);
            return true;
        },
    },
}));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: (key, fallback) => (key in game.settings ? game.settings[key] : fallback) },
}));
vi.mock('./guild-trials-store.js', () => ({
    loadTrialRoster: async () => game.storedRoster,
    saveTrialRoster: async (entry) => {
        game.storedRoster = entry;
        return true;
    },
    loadTrialStats: async () => ({ weekStart: 0, trials: {} }),
    saveTrialStats: async () => true,
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
    guildXPTracker: { getMemberMeta: () => null, getOwnGuildName: () => game.guildName },
}));

const { guildTrialDamage, GUILD_BATTLE_MESSAGE } = await import('./guild-trial-damage.js');
const { LIVE_SESSION_PERSIST_MS } = await import('../../utils/live-session-persist.js');

const T0 = Date.parse('2026-09-12T12:00:00Z');
const KEY = 'guildHistory:toolasha_local_liveTrial_900001';

/** A tier opening, with two named slots */
const opening = (tier, combatStartTime = '2026-09-12T11:55:00Z', boss = 'Trial Badger') => ({
    type: 'new_guild_battle',
    battleId: 1,
    tier,
    wave: 1,
    combatStartTime,
    players: [{ character: { id: 900001, name: 'Alpha' } }, { character: { id: 900002, name: 'Bravo' } }],
    monsters: [{ name: boss, hrid: `/monsters/${boss.toLowerCase().replace(/ /g, '_')}` }],
});

/** Slot 0 swinging at the boss */
const swing = (tier, atk, hp, dmg) =>
    game.wsHandlers[GUILD_BATTLE_MESSAGE]({
        battleId: 1,
        tier,
        pMap: { 0: { atkCounter: atk, cHP: 1000, isAutoAtk: true } },
        mMap: { 0: { cHP: hp, dmgCounter: dmg, critCounter: 0 } },
    });

async function settle() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** @param {string} name */
const damageOf = (name) => guildTrialDamage.breakdown().players.find((row) => row.name === name)?.damage ?? 0;

function open(guild = 'Guild A') {
    guildTrialDamage.initialize();
    if (guild) guildTrialDamage.setGuildName(guild, game.ownId);
}

/**
 * Close the page, keep it shut, open it again.
 * @param {Object} [options]
 * @param {number} [options.shutMs]
 * @param {string|null} [options.guild] - The guild known once it is open; null for not yet
 */
async function reload({ shutMs = 60_000, guild = 'Guild A' } = {}) {
    guildTrialDamage.cleanup();
    vi.advanceTimersByTime(shutMs);
    // A new page knows no guild and no roster until something tells it
    guildTrialDamage.statsScope = { guildName: null, characterId: null };
    guildTrialDamage.storedRoster = null;
    open(guild);
    await settle();
}

/** Tier 1: Alpha deals 1,000 over one measured second, and it is written down */
function tierOneAndSave() {
    game.wsHandlers.new_guild_battle(opening(1));
    swing(1, 1, 1_000_000, 0);
    vi.advanceTimersByTime(1000);
    swing(1, 2, 999_000, 1);
    vi.advanceTimersByTime(LIVE_SESSION_PERSIST_MS);
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    game.ownId = 900001;
    game.guildName = null;
    game.storedRoster = null;
    game.settings = {};
    game.disk.clear();
    game.deletes.length = 0;
    game.gate = null;
    guildTrialDamage.storedRoster = null;
    open();
});

afterEach(() => {
    guildTrialDamage.cleanup();
    guildTrialDamage.reset();
    vi.useRealTimers();
});

describe('a refresh mid-trial', () => {
    test('the same tier on the stream takes the tally back, and the shut minute is not fighting', async () => {
        tierOneAndSave();
        expect(damageOf('Alpha')).toBe(1000);
        expect(game.disk.has(KEY)).toBe(true);

        await reload();
        // Nothing is adopted until the stream shows the fight
        expect(guildTrialDamage.breakdown().restored).toBeNull();

        // A baseline tick: the counters moved while the page was shut, and none of it is anybody's
        swing(1, 10, 900_000, 10);
        expect(damageOf('Alpha')).toBe(1000);
        vi.advanceTimersByTime(1000);
        swing(1, 11, 899_000, 11);

        const breakdown = guildTrialDamage.breakdown();
        expect(damageOf('Alpha')).toBe(2000);
        expect(breakdown.seconds).toBeCloseTo(2);
        expect(breakdown.active).toBe(true);
        expect(breakdown.tier).toBe(1);
        expect(breakdown.restored).toMatchObject({ savedAt: T0 + LIVE_SESSION_PERSIST_MS });
        expect(breakdown.reconnects).toBe(0);
    });

    test('a later tier of the same fight banks the restored wave under its names', async () => {
        tierOneAndSave();
        await reload();

        game.wsHandlers.new_guild_battle(opening(2, '2026-09-12T12:02:00Z'));
        swing(2, 1, 1_200_000, 0);
        vi.advanceTimersByTime(1000);
        swing(2, 2, 1_199_000, 1);

        expect(guildTrialDamage.breakdown().tier).toBe(2);
        expect(damageOf('Alpha')).toBe(2000);
        expect(guildTrialDamage.bankedTally.Alpha.damage).toBe(1000);
    });

    test('a tier opening hours from the saved fight is another trial', async () => {
        tierOneAndSave();
        await reload();

        game.wsHandlers.new_guild_battle(opening(1, '2026-09-12T15:00:00Z'));
        swing(1, 1, 1_000_000, 0);
        vi.advanceTimersByTime(1000);
        swing(1, 2, 999_000, 1);

        expect(damageOf('Alpha')).toBe(1000);
        expect(guildTrialDamage.breakdown().restored).toBeNull();
    });

    test('a different encounter is another trial', async () => {
        game.wsHandlers.new_guild_battle(opening(1));
        guildTrialDamage.encounter = 'badger';
        swing(1, 1, 1_000_000, 0);
        vi.advanceTimersByTime(1000);
        swing(1, 2, 999_000, 1);
        vi.advanceTimersByTime(LIVE_SESSION_PERSIST_MS);

        await reload();
        game.wsHandlers.new_guild_battle(opening(1, '2026-09-12T11:55:00Z', 'Trial Chameleon'));
        expect(guildTrialDamage.breakdown().restored).toBeNull();
    });

    test('a lower tier is not the saved fight', async () => {
        game.wsHandlers.new_guild_battle(opening(3));
        swing(3, 1, 1_000_000, 0);
        vi.advanceTimersByTime(1000);
        swing(3, 2, 999_000, 1);
        vi.advanceTimersByTime(LIVE_SESSION_PERSIST_MS);

        await reload();
        swing(1, 1, 1_000_000, 0);
        expect(guildTrialDamage.breakdown().restored).toBeNull();
    });
});

describe('whose tally it is', () => {
    test('another guild’s trial is never restored', async () => {
        tierOneAndSave();
        await reload({ guild: 'Guild B' });

        swing(1, 10, 900_000, 10);
        expect(guildTrialDamage.breakdown().restored).toBeNull();
        expect(game.disk.has(KEY)).toBe(true);
    });

    test('a guild not known yet waits, and the ticks meanwhile are added in', async () => {
        tierOneAndSave();
        await reload({ guild: null });

        swing(1, 10, 900_000, 10);
        vi.advanceTimersByTime(1000);
        swing(1, 11, 899_000, 11);
        expect(guildTrialDamage.breakdown().restored).toBeNull();
        expect(damageOf('Alpha')).toBe(1000);

        // While it waits, the fraction measured since the reload is not written over the saved tally
        vi.advanceTimersByTime(LIVE_SESSION_PERSIST_MS);
        expect(game.disk.get(KEY).savedAt).toBe(T0 + LIVE_SESSION_PERSIST_MS);

        guildTrialDamage.setGuildName('Guild A', game.ownId);
        vi.advanceTimersByTime(1000);
        swing(1, 12, 898_000, 12);

        // 1,000 saved, 1,000 while waiting, 1,000 since
        expect(damageOf('Alpha')).toBe(3000);
        expect(guildTrialDamage.breakdown().restored).not.toBeNull();
        // One saved, one while waiting; the tick after the four-second wait bridges nothing
        expect(guildTrialDamage.breakdown().seconds).toBeCloseTo(2);
    });

    test('another character never reads it', async () => {
        tierOneAndSave();
        guildTrialDamage.cleanup();
        game.ownId = 900002;
        open();
        await settle();

        swing(1, 10, 900_000, 10);
        expect(guildTrialDamage.breakdown().restored).toBeNull();
    });

    test('a character switch while the read is out drops what it read', async () => {
        tierOneAndSave();
        guildTrialDamage.cleanup();
        let release;
        game.gate = new Promise((resolve) => {
            release = resolve;
        });
        open();
        game.ownId = 900002;
        release();
        await settle();
        game.ownId = 900001;

        swing(1, 10, 900_000, 10);
        expect(guildTrialDamage.breakdown().restored).toBeNull();
    });
});

describe('an ended trial', () => {
    test('comes back without a stream, still ended, so nothing re-arms on it', async () => {
        tierOneAndSave();
        game.wsHandlers.end_guild_battle({ battleId: 1, trialHrid: '/guild_trials/badger' });
        vi.advanceTimersByTime(LIVE_SESSION_PERSIST_MS);

        await reload();

        const breakdown = guildTrialDamage.breakdown();
        expect(damageOf('Alpha')).toBe(1000);
        expect(breakdown.endedByGame).toBe(true);
        expect(breakdown.active).toBe(false);
        // What the recorder's auto-start gate reads: a restored ended trial arms no session
        expect(breakdown.endedAt).toBe(T0 + 1000 + LIVE_SESSION_PERSIST_MS);
        expect(breakdown.frozen).toBe(true);
    });

    test('an ending that arrives after the refresh takes the running tally back first', async () => {
        tierOneAndSave();
        await reload();

        game.wsHandlers.end_guild_battle({ battleId: 1, trialHrid: '/guild_trials/badger' });
        const breakdown = guildTrialDamage.breakdown();
        expect(damageOf('Alpha')).toBe(1000);
        expect(breakdown.endedByGame).toBe(true);
        expect(breakdown.restored).not.toBeNull();
    });

    test('a save the game ended 43 minutes ago, same trial week, is restored anyway', async () => {
        tierOneAndSave();
        game.wsHandlers.end_guild_battle({ battleId: 1, trialHrid: '/guild_trials/badger' });
        vi.advanceTimersByTime(LIVE_SESSION_PERSIST_MS);

        await reload({ shutMs: 43 * 60_000 });

        const breakdown = guildTrialDamage.breakdown();
        expect(damageOf('Alpha')).toBe(1000);
        expect(breakdown.endedByGame).toBe(true);
        expect(breakdown.active).toBe(false);
        expect(breakdown.frozen).toBe(true);
        expect(breakdown.restored).not.toBeNull();
    });

    test('a save the game ended in the previous trial week is not restored', async () => {
        tierOneAndSave();
        game.wsHandlers.end_guild_battle({ battleId: 1, trialHrid: '/guild_trials/badger' });
        vi.advanceTimersByTime(LIVE_SESSION_PERSIST_MS);

        // Eight days on: the weekly Friday 00:00 UTC reset has rolled over at least once
        await reload({ shutMs: 8 * 24 * 60 * 60 * 1000 });

        swing(1, 10, 900_000, 10);
        const breakdown = guildTrialDamage.breakdown();
        expect(damageOf('Alpha')).toBe(0);
        expect(breakdown.endedByGame).toBe(false);
        expect(breakdown.restored).toBeNull();
    });

    test('a still-running save 21 minutes old keeps the ordinary window', async () => {
        tierOneAndSave();

        // Not ended by the game: the ordinary twenty-minute limit still applies
        await reload({ shutMs: 21 * 60_000 });

        swing(1, 10, 900_000, 10);
        const breakdown = guildTrialDamage.breakdown();
        expect(damageOf('Alpha')).toBe(0);
        expect(breakdown.restored).toBeNull();
    });

    test('a new trial fight replaces a restored ended trial the normal way', async () => {
        tierOneAndSave();
        game.wsHandlers.end_guild_battle({ battleId: 1, trialHrid: '/guild_trials/badger' });
        vi.advanceTimersByTime(LIVE_SESSION_PERSIST_MS);

        await reload({ shutMs: 43 * 60_000 });
        expect(guildTrialDamage.breakdown().endedByGame).toBe(true);
        expect(damageOf('Alpha')).toBe(1000);

        // A genuinely different fight: another encounter than the restored trial's
        game.wsHandlers.new_guild_battle(opening(1, '2026-09-12T13:00:00Z', 'Trial Chameleon'));
        swing(1, 1, 1_000_000, 0);
        vi.advanceTimersByTime(1000);
        swing(1, 2, 999_000, 1);

        const breakdown = guildTrialDamage.breakdown();
        expect(breakdown.endedByGame).toBe(false);
        expect(breakdown.active).toBe(true);
        expect(damageOf('Alpha')).toBe(1000);
    });
});

describe('ending it on purpose', () => {
    test('End & start new throws the saved tally away', async () => {
        tierOneAndSave();
        guildTrialDamage.reset();
        expect(game.deletes).toContain('toolasha_local_liveTrial_900001');

        await reload();
        swing(1, 10, 900_000, 10);
        expect(guildTrialDamage.breakdown().restored).toBeNull();
    });

    test('switching trial tracking off throws it away too', async () => {
        tierOneAndSave();
        game.settings.guildTrialTracking = false;
        guildTrialDamage.cleanup();
        game.settings.guildTrialTracking = true;
        expect(game.disk.has(KEY)).toBe(false);

        open();
        await settle();
        swing(1, 10, 900_000, 10);
        expect(guildTrialDamage.breakdown().restored).toBeNull();
    });

    test('with the setting off nothing is saved', async () => {
        game.settings.combatSessionRestore = false;
        tierOneAndSave();
        expect(game.disk.has(KEY)).toBe(false);
    });
});

describe('a reconnect mid-trial', () => {
    test('keeps the tally, drops the baselines and is counted', () => {
        tierOneAndSave();
        game.wsHandlers.init_character_data({ character: { id: 900001 } });

        const breakdown = guildTrialDamage.breakdown();
        expect(breakdown.reconnects).toBe(1);
        expect(damageOf('Alpha')).toBe(1000);

        // Every counter moved while the socket was down; the first tick back owns none of it
        vi.advanceTimersByTime(5000);
        swing(1, 40, 600_000, 40);
        expect(damageOf('Alpha')).toBe(1000);
        vi.advanceTimersByTime(1000);
        swing(1, 41, 599_000, 41);
        expect(damageOf('Alpha')).toBe(2000);
        // The gap is not fighting
        expect(guildTrialDamage.breakdown().seconds).toBeCloseTo(2);
    });

    test('is written at once, and survives a refresh after it', async () => {
        tierOneAndSave();
        game.wsHandlers.init_character_data({ character: { id: 900001 } });
        expect(game.disk.get(KEY).reconnects).toBe(1);

        await reload();
        swing(1, 10, 900_000, 10);
        expect(guildTrialDamage.breakdown().reconnects).toBe(1);
    });

    test('a different character arriving is a switch, not a reconnect', () => {
        tierOneAndSave();
        game.wsHandlers.init_character_data({ character: { id: 900002 } });
        expect(guildTrialDamage.breakdown().reconnects).toBe(0);
    });

    test('nothing is counted once the trial is over, or before one is watched', () => {
        game.wsHandlers.init_character_data({ character: { id: 900001 } });
        expect(guildTrialDamage.breakdown().reconnects).toBe(0);

        tierOneAndSave();
        game.wsHandlers.end_guild_battle({ battleId: 1, trialHrid: '/guild_trials/badger' });
        game.wsHandlers.init_character_data({ character: { id: 900001 } });
        expect(guildTrialDamage.breakdown().reconnects).toBe(0);
    });
});
