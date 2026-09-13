/**
 * Saving a finished guild trial.
 *
 * The trial is saved once: when the game's own totals land, or two minutes
 * after the end without them — and a stats message the game repeats every time
 * its Stats panel is opened must not save it again. A trial cut short is saved
 * too, under the character that watched it.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const opts = vi.hoisted(() => ({
    settings: {},
    characterId: 'A',
    breakdown: null,
    classes: {},
    session: null,
    stored: new Map(),
    sets: [],
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback = false) => opts.settings[key] ?? fallback,
        getSettingValue: (_key, fallback) => fallback,
    },
}));
vi.mock('../../core/data-manager.js', () => ({ default: { getCurrentCharacterId: () => opts.characterId } }));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) => (opts.stored.has(key) ? opts.stored.get(key) : fallback),
        set: async (key, value) => {
            opts.sets.push(key);
            opts.stored.set(key, value);
            return true;
        },
        delete: async (key) => opts.stored.delete(key),
    },
}));
vi.mock('./guild-trial-damage.js', () => ({ default: { breakdown: () => opts.breakdown } }));
vi.mock('./guild-trial-abilities.js', () => ({ default: { classes: () => opts.classes } }));
vi.mock('./guild-trial-recorder.js', () => ({
    guildTrialRecorder: {
        get session() {
            return opts.session;
        },
    },
    SNAPSHOT_MS: 15_000,
    RECONCILE_WAIT_MS: 120_000,
}));

const { buildTrialEntry, flushTrialHistory, sampleTrialHistory, thinTrialBreakdown, _resetTrialHistory } =
    await import('./trial-history.js');
const { getHistoryEntry, loadHistoryIndex, _resetMeterHistory } = await import('../combat/meter-history.js');

const T0 = 1_700_000_000_000;

/** A watched trial as the damage module reports one */
const trial = (overrides = {}) => ({
    measured: true,
    source: 'spectated',
    encounter: '/monsters/badger',
    bossName: 'Badger',
    seconds: 600,
    fights: 3,
    tier: 3,
    tierStarts: { 1: T0, 2: T0 + 100_000, 3: T0 + 200_000 },
    endedAt: null,
    endedByGame: false,
    reported: null,
    totalDamage: 5000,
    partyDps: 8.3,
    team: { damage: 5200, unattributed: 200, kills: 3, unownedKills: 0 },
    players: [
        { index: '0', name: 'Tib', damage: 3000, kills: 2, abilities: [{ action: 'auto', damage: 3000 }] },
        { index: '1', name: 'Moo', damage: 2000, kills: 1, abilities: [] },
    ],
    support: {
        players: [{ index: '2', name: 'Ada', healingDone: 900, healingByCaster: 800, damageTaken: 0, outOfMana: true }],
        regenHealing: 50,
        unattributedHealing: 10,
    },
    storedStats: { '/monsters/other': { reported: {} } },
    bossSheets: { 1: { hp: 1 } },
    spectator: { lastAt: 1 },
    roster: { 0: { name: 'Tib' }, 1: 'Moo' },
    ...overrides,
});

const ended = (overrides = {}) => trial({ endedAt: T0 + 600_000, endedByGame: true, ...overrides });
const reported = { Tib: { damage: 3100, healing: 0, taken: 10 }, Moo: { damage: 2100, healing: 0, taken: 5 } };
const bodyWrites = (characterId = 'A') =>
    opts.sets.filter((key) => key.startsWith(`meterHistory_${characterId}_trial_`)).length;

beforeEach(() => {
    opts.settings = {};
    opts.characterId = 'A';
    opts.breakdown = null;
    opts.classes = {};
    opts.session = null;
    opts.stored = new Map();
    opts.sets = [];
    _resetTrialHistory();
    _resetMeterHistory();
});

describe('archived once', () => {
    test('saved when the game’s totals arrive, and a repeated stats message saves nothing more', async () => {
        const at = T0 + 600_000;
        await Promise.all(sampleTrialHistory(at, { breakdown: trial() }));
        await Promise.all(sampleTrialHistory(at + 15_000, { breakdown: ended() }));
        expect(bodyWrites()).toBe(0);

        await Promise.all(sampleTrialHistory(at + 30_000, { breakdown: ended({ reported }) }));
        const index = await loadHistoryIndex('trial', 'A');
        expect(index).toHaveLength(1);
        expect(index[0]).toMatchObject({ basis: 'game', total: 5200, label: 'Badger T1–T3', finished: true });

        // The game re-sends its stats whenever its own Stats panel is opened
        await Promise.all(sampleTrialHistory(at + 45_000, { breakdown: ended({ reported }) }));
        await Promise.all(sampleTrialHistory(at + 60_000, { breakdown: ended({ reported }) }));
        expect(bodyWrites()).toBe(1);
    });

    test('without totals it is saved two minutes after the end, and totals arriving later replace it', async () => {
        await Promise.all(sampleTrialHistory(T0 + 700_000, { breakdown: ended() }));
        expect(bodyWrites()).toBe(0);
        await Promise.all(sampleTrialHistory(T0 + 730_000, { breakdown: ended() }));
        expect((await loadHistoryIndex('trial', 'A'))[0].basis).toBe('stream');

        await Promise.all(sampleTrialHistory(T0 + 745_000, { breakdown: ended({ reported }) }));
        const index = await loadHistoryIndex('trial', 'A');
        expect(index).toHaveLength(1);
        expect(index[0].basis).toBe('game');
    });

    test('a trial too slight to keep is not saved', async () => {
        await Promise.all(sampleTrialHistory(T0 + 900_000, { breakdown: ended({ seconds: 10 }) }));
        expect(await loadHistoryIndex('trial', 'A')).toEqual([]);
    });

    test('with the setting off nothing is saved', async () => {
        opts.settings.combatMeterHistory = false;
        await Promise.all(sampleTrialHistory(T0 + 700_000, { breakdown: ended({ reported }) }));
        expect(bodyWrites()).toBe(0);
    });
});

describe('a trial that never ended', () => {
    test('a breakdown that starts over saves the one before as cut short', async () => {
        sampleTrialHistory(T0, { breakdown: trial() });
        await Promise.all(sampleTrialHistory(T0 + 15_000, { breakdown: trial({ seconds: 4, tierStarts: {} }) }));
        const [summary] = await loadHistoryIndex('trial', 'A');
        expect(summary).toMatchObject({ finished: false, basis: 'stream', seconds: 600 });
    });

    test('a flush files it under the character that watched it, after the id has moved on', async () => {
        opts.breakdown = trial();
        sampleTrialHistory(T0, { breakdown: trial() });
        opts.characterId = 'B';
        await flushTrialHistory();
        expect(await loadHistoryIndex('trial', 'A')).toHaveLength(1);
        expect(await loadHistoryIndex('trial', 'B')).toEqual([]);
    });

    test('a flush over a breakdown already reset saves the reading in hand, not the empty one', async () => {
        sampleTrialHistory(T0, { breakdown: trial() });
        opts.breakdown = { players: [], support: { players: [] }, seconds: 0 };
        await flushTrialHistory();
        const index = await loadHistoryIndex('trial', 'A');
        expect(index).toHaveLength(1);
        expect(index[0].seconds).toBe(600);
    });
});

describe('what a saved trial holds', () => {
    test('the board’s figures, without the export-only parts or the live mana state', () => {
        const thin = thinTrialBreakdown(trial());
        expect(thin.storedStats).toBeUndefined();
        expect(thin.bossSheets).toBeUndefined();
        expect(thin.spectator).toBeUndefined();
        expect(thin.roster).toEqual({ 0: 'Tib', 1: 'Moo' });
        expect(thin.support.players[0]).toMatchObject({ name: 'Ada', healingDone: 900, healingByCaster: 800 });
        expect(thin.support.players[0].outOfMana).toBeUndefined();
        expect(thin.support.regenHealing).toBe(50);
        expect(thin.players[0].abilities).toEqual([{ action: 'auto', damage: 3000 }]);
        expect(thin.active).toBe(false);
    });

    test('the graph keeps the leading players, how many there were, and every tier change', async () => {
        const names = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'];
        const snap = (seconds, tier) => ({
            seconds,
            fights: tier,
            tier,
            players: names.map((name, i) => ({ name, damage: seconds * (i + 1) })),
        });
        opts.session = { snapshots: [snap(0, 1), snap(15, 1), snap(30, 2), snap(45, 3)] };
        opts.classes = { tib: { key: 'tank', short: 'TANK' } };

        // At the last reading's clock, so the live breakdown adds no reading of its own
        const saves = sampleTrialHistory(T0 + 700_000, {
            breakdown: ended({ reported, seconds: 45, players: trial().players }),
        });
        await Promise.all(saves);
        const [summary] = await loadHistoryIndex('trial', 'A');
        const body = await getHistoryEntry('trial', summary.id, 'A');

        expect(Object.keys(body.graph.rates.players)).toHaveLength(5);
        expect(body.graph.rates.playerCount).toBe(7);
        expect(body.graph.marks).toEqual([
            { seconds: 30, tier: 2 },
            { seconds: 45, tier: 3 },
        ]);
        expect(body.classes.tib.key).toBe('tank');
        expect(body.breakdown.reported.Tib.damage).toBe(3100);
    });

    test('an entry is identified by its encounter and when its first tier began', () => {
        const entry = buildTrialEntry({ at: T0, firstSeenAt: T0, breakdown: thinTrialBreakdown(trial()) }, true);
        expect(entry.id).toBe(`trial__monsters_badger_${T0}`);
        expect(entry.summary.detail).toBe('3 players');
    });

    test('the unnamed row is kept in the body but is not counted as a player', () => {
        // The live trial read "91 players" for a party of 46: every slot of the
        // stretch watched before names were known counted as one more player
        const unnamed = 'Unnamed — before names were known (45 players)';
        const breakdown = trial({
            players: [...trial().players, { index: unnamed, name: unnamed, damage: 311, unnamed: true }],
            support: { players: [...trial().support.players, { index: unnamed, name: unnamed, damageTaken: 9 }] },
        });
        const entry = buildTrialEntry({ at: T0, firstSeenAt: T0, breakdown: thinTrialBreakdown(breakdown) }, true);
        expect(entry.summary.detail).toBe('3 players');
        expect(entry.breakdown.players.map((row) => row.name)).toContain(unnamed);
    });
});
