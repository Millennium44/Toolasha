/**
 * Per-player damage in a guild combat trial.
 *
 * The arithmetic is `utils/damage-attribution.js`' and is tested there. What is
 * worth asserting here is the thing this module actually adds: the gate. A
 * feature that credits the wrong fights is worse than one that credits none, so
 * most of this file is about battles that must *not* count.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    clientData: {},
    wsHandlers: {},
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.clientData,
    },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, handler) => {
            game.wsHandlers[type] = handler;
        },
        off: (type) => delete game.wsHandlers[type],
    },
}));

const { battleMonsterNames, encounterOf, guildTrialDamage, isTrialBattle, summariseTrialDamage } =
    await import('./guild-trial-damage.js');

/**
 * One player in a tick, with the counters attribution reads.
 * @param {number} atk - Attack counter
 * @param {number} hp - Current health
 * @returns {Object} A `pMap` entry
 */
function player(atk, hp = 100) {
    // Auto-attacking rather than idle: a hit credited while nothing is being
    // prepared is a lingering effect, and `foldEvents` drops it by default
    return { atkCounter: atk, cHP: hp, isAutoAtk: true };
}

/**
 * One monster in a tick.
 * @param {number} hp - Current health
 * @param {number} damageCount - Damage counter
 * @returns {Object} An `mMap` entry
 */
function monster(hp, damageCount) {
    return { cHP: hp, dmgCounter: damageCount, critCounter: 0 };
}

describe('encounterOf', () => {
    test('finds the encounter in a card name', () => {
        expect(encounterOf('Trial Chameleon')).toBe('chameleon');
        expect(encounterOf('Jellyfish Lv.170')).toBe('jellyfish');
    });

    test('is null for anything else', () => {
        expect(encounterOf('Milking')).toBeNull();
        expect(encounterOf('')).toBeNull();
        expect(encounterOf(null)).toBeNull();
    });
});

describe('isTrialBattle', () => {
    test('a monster that says it is a trial arms the tally on its own', () => {
        const verdict = isTrialBattle({ monsterNames: ['Trial Hedgehog'], trialNames: [] });
        expect(verdict.isTrial).toBe(true);
        expect(verdict.encounter).toBe('hedgehog');
    });

    test('this week’s encounter counts', () => {
        const verdict = isTrialBattle({ monsterNames: ['Chameleon'], trialNames: ['Trial Chameleon'] });
        expect(verdict.isTrial).toBe(true);
        expect(verdict.encounter).toBe('chameleon');
    });

    test('a different encounter does not', () => {
        const verdict = isTrialBattle({ monsterNames: ['Badger'], trialNames: ['Trial Chameleon'] });
        expect(verdict.isTrial).toBe(false);
    });

    test('an ordinary zone does not, and says why', () => {
        const verdict = isTrialBattle({ monsterNames: ['Chimerical Beast'], trialNames: ['Trial Chameleon'] });
        expect(verdict.isTrial).toBe(false);
        expect(verdict.reason).toMatch(/not this week/i);
    });

    test('with no combat trial on record nothing but a named trial counts', () => {
        expect(isTrialBattle({ monsterNames: ['Chameleon'], trialNames: [] }).isTrial).toBe(false);
        expect(isTrialBattle({ monsterNames: ['Chameleon'], trialNames: ['Milking'] }).isTrial).toBe(false);
    });
});

describe('battleMonsterNames', () => {
    test('reads the name the payload carries', () => {
        expect(battleMonsterNames({ monsters: [{ name: 'Trial Swarm' }] })).toEqual(['Trial Swarm']);
    });

    test('falls back to the hrid, through client data where it has it', () => {
        game.clientData = { combatMonsterDetailMap: { '/monsters/trial_badger': { name: 'Trial Badger' } } };
        expect(battleMonsterNames({ monsters: { 0: { combatMonsterHrid: '/monsters/trial_badger' } } })).toEqual([
            'Trial Badger',
        ]);

        game.clientData = {};
        expect(battleMonsterNames({ monsters: { 0: { hrid: '/monsters/trial_badger' } } })).toEqual(['trial badger']);
    });
});

describe('summariseTrialDamage', () => {
    test('shares are of the party’s attributed damage', () => {
        const summary = summariseTrialDamage({
            tally: {
                0: { damage: 750, hits: 10, crits: 2, misses: 0 },
                1: { damage: 250, hits: 5, crits: 0, misses: 5 },
            },
            names: { 0: 'Tib', 1: 'Moo' },
            deaths: { 1: 2 },
            seconds: 100,
        });

        expect(summary.players.map((entry) => entry.name)).toEqual(['Tib', 'Moo']);
        expect(summary.players[0].share).toBeCloseTo(75);
        expect(summary.players[0].dps).toBeCloseTo(7.5);
        expect(summary.players[1].deaths).toBe(2);
        expect(summary.players[1].accuracy).toBeCloseTo(0.5);
        expect(summary.totalDamage).toBe(1000);
    });

    test('a rate needs enough of a fight to divide by', () => {
        const summary = summariseTrialDamage({
            tally: { 0: { damage: 10, hits: 1, crits: 0, misses: 0 } },
            seconds: 1,
        });
        expect(summary.players[0].dps).toBeNull();
        expect(summary.partyDps).toBeNull();
        // The share is still real — it needs no clock
        expect(summary.players[0].share).toBeCloseTo(100);
    });

    test('no swings is not a nought per cent hit rate', () => {
        const summary = summariseTrialDamage({ tally: { 0: { damage: 0, hits: 0, crits: 0, misses: 0 } } });
        expect(summary.players[0].accuracy).toBeNull();
        expect(summary.players[0].critRate).toBeNull();
    });
});

describe('the live tracker', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-04T12:00:00Z'));
        game.clientData = {};
        guildTrialDamage.initialize();
        guildTrialDamage.reset();
        guildTrialDamage.setTrialNames(['Trial Chameleon']);
    });

    afterEach(() => {
        guildTrialDamage.cleanup();
        vi.useRealTimers();
    });

    /**
     * Drive one trial fight: two players, one of whom does all the swinging.
     * @param {string} monsterName - What is being fought
     */
    function fight(monsterName) {
        game.wsHandlers.new_battle({
            battleId: 7,
            monsters: [{ name: monsterName }],
            players: [
                { character: { name: 'Tib' }, isPreparingAutoAttack: true },
                { character: { name: 'Moo' }, isPreparingAutoAttack: true },
            ],
        });

        game.wsHandlers.battle_updated({
            battleId: 7,
            pMap: { 0: player(1), 1: player(1) },
            mMap: { 0: monster(1000, 0) },
        });
        vi.advanceTimersByTime(1000);
        game.wsHandlers.battle_updated({
            battleId: 7,
            pMap: { 0: player(2) },
            mMap: { 0: monster(600, 1) },
        });
        vi.advanceTimersByTime(1000);
        game.wsHandlers.battle_updated({
            battleId: 7,
            pMap: { 1: player(2) },
            mMap: { 0: monster(400, 2) },
        });
    }

    test('splits a trial fight per player', () => {
        fight('Trial Chameleon');

        const breakdown = guildTrialDamage.breakdown();
        expect(breakdown.active).toBe(true);
        expect(breakdown.encounter).toBe('chameleon');
        expect(breakdown.totalDamage).toBe(600);

        const byName = Object.fromEntries(breakdown.players.map((entry) => [entry.name, entry.damage]));
        expect(byName).toEqual({ Tib: 400, Moo: 200 });
    });

    test('an ordinary zone is not attributed at all', () => {
        fight('Chimerical Beast');

        const breakdown = guildTrialDamage.breakdown();
        expect(breakdown.active).toBe(false);
        expect(breakdown.measured).toBe(false);
        expect(breakdown.totalDamage).toBe(0);
    });

    test('the zone after a trial does not inherit the trial’s tally', () => {
        fight('Trial Chameleon');
        const before = guildTrialDamage.breakdown().totalDamage;

        game.wsHandlers.new_battle({
            battleId: 8,
            monsters: [{ name: 'Chimerical Beast' }],
            players: [{ character: { name: 'Tib' }, isPreparingAutoAttack: true }],
        });
        game.wsHandlers.battle_updated({
            battleId: 8,
            pMap: { 0: player(9) },
            mMap: { 0: monster(1_000_000, 0) },
        });
        vi.advanceTimersByTime(1000);
        game.wsHandlers.battle_updated({
            battleId: 8,
            pMap: { 0: player(10) },
            mMap: { 0: monster(1, 1) },
        });

        expect(guildTrialDamage.breakdown().totalDamage).toBe(before);
    });

    test('a fight already under way when the page loaded counts for nothing', () => {
        game.wsHandlers.battle_updated({
            battleId: 42,
            pMap: { 0: player(1) },
            mMap: { 0: monster(500, 1) },
        });
        vi.advanceTimersByTime(1000);
        game.wsHandlers.battle_updated({
            battleId: 42,
            pMap: { 0: player(2) },
            mMap: { 0: monster(100, 2) },
        });

        const breakdown = guildTrialDamage.breakdown();
        expect(breakdown.totalDamage).toBe(0);
        expect(breakdown.reason).toMatch(/already under way/i);
    });

    test('deaths come off the same feed', () => {
        fight('Trial Chameleon');
        game.wsHandlers.battle_updated({ battleId: 7, pMap: { 1: player(2, 0) }, mMap: {} });

        const moo = guildTrialDamage.breakdown().players.find((entry) => entry.name === 'Moo');
        expect(moo.deaths).toBe(1);
    });

    test('a tier is a new fight and adds to the same trial', () => {
        fight('Trial Chameleon');
        const first = guildTrialDamage.breakdown().totalDamage;

        game.wsHandlers.new_battle({
            battleId: 9,
            monsters: [{ name: 'Trial Chameleon' }],
            players: [
                { character: { name: 'Tib' }, isPreparingAutoAttack: true },
                { character: { name: 'Moo' }, isPreparingAutoAttack: true },
            ],
        });
        game.wsHandlers.battle_updated({ battleId: 9, pMap: { 0: player(5) }, mMap: { 0: monster(900, 0) } });
        vi.advanceTimersByTime(1000);
        game.wsHandlers.battle_updated({ battleId: 9, pMap: { 0: player(6) }, mMap: { 0: monster(800, 1) } });

        const breakdown = guildTrialDamage.breakdown();
        expect(breakdown.totalDamage).toBe(first + 100);
        expect(breakdown.fights).toBe(2);
    });

    test('a reading older than the hour a trial runs for is withdrawn', () => {
        fight('Trial Chameleon');
        expect(guildTrialDamage.breakdown().measured).toBe(true);

        vi.advanceTimersByTime(2 * 60 * 60 * 1000);
        const breakdown = guildTrialDamage.breakdown();
        expect(breakdown.stale).toBe(true);
        expect(breakdown.measured).toBe(false);
    });
});
