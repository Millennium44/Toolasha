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
        // Names what it saw and what it wanted: the reason as it stood could not
        // be acted on from a bug report, which is how a broken gate survived
        expect(verdict.reason).toContain('Chimerical Beast');
        expect(verdict.reason).toContain('chameleon');
    });

    test('an hrid is as good as a name', () => {
        const verdict = isTrialBattle({
            monsterNames: ['/monsters/chameleon'],
            trialNames: ['Trial Chameleon'],
        });
        expect(verdict.isTrial).toBe(true);
        expect(verdict.encounter).toBe('chameleon');
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

    test('every spelling, not the first one that exists', () => {
        // The live payload carries both, and the display name is the one that a
        // localised client changes — taking it and stopping threw away the only
        // stable identifier the battle had
        game.clientData = { combatMonsterDetailMap: { '/monsters/chameleon': { name: 'Chameleon' } } };
        const names = battleMonsterNames({
            monsters: [{ hrid: '/monsters/chameleon', name: 'Chamäleon' }],
        });
        expect(names).toContain('/monsters/chameleon');
        expect(names).toContain('Chamäleon');
        expect(names).toContain('Chameleon');
    });

    test('falls back to the hrid, through client data where it has it', () => {
        game.clientData = { combatMonsterDetailMap: { '/monsters/trial_badger': { name: 'Trial Badger' } } };
        expect(battleMonsterNames({ monsters: { 0: { combatMonsterHrid: '/monsters/trial_badger' } } })).toEqual([
            '/monsters/trial_badger',
            'Trial Badger',
        ]);

        game.clientData = {};
        expect(battleMonsterNames({ monsters: { 0: { hrid: '/monsters/trial_badger' } } })).toEqual([
            '/monsters/trial_badger',
        ]);
    });

    test('a fight this client would otherwise not have recognised, from the live export', () => {
        // The reported case: the party was visibly fighting the week's combat
        // trial and the gate reported "the monsters are not this week's trial
        // encounter", with fights: 0. An hrid nobody looked at said otherwise.
        game.clientData = {};
        const names = battleMonsterNames({
            monsters: [{ hrid: '/monsters/trial_chameleon', isPlayer: false }],
        });
        expect(isTrialBattle({ monsterNames: names, trialNames: ['Trial Chameleon'] })).toMatchObject({
            isTrial: true,
            encounter: 'chameleon',
        });
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

    test('the week’s trial name arriving mid-fight arms the tally', () => {
        // The record learns this week's combat card when the guild panel is
        // first drawn, which is routinely after the party has started swinging.
        // Deciding only on `new_battle` left that whole fight unattributed.
        guildTrialDamage.setTrialNames([]);
        game.wsHandlers.new_battle({
            battleId: 11,
            monsters: [{ hrid: '/monsters/chameleon', name: 'Chameleon' }],
            players: [{ character: { name: 'Tib' }, isPreparingAutoAttack: true }],
        });
        expect(guildTrialDamage.breakdown().active).toBe(false);

        guildTrialDamage.setTrialNames(['Trial Chameleon']);

        const armed = guildTrialDamage.breakdown();
        expect(armed.active).toBe(true);
        expect(armed.encounter).toBe('chameleon');
        expect(armed.fights).toBe(1);

        game.wsHandlers.battle_updated({ battleId: 11, pMap: { 0: player(5) }, mMap: { 0: monster(900, 0) } });
        vi.advanceTimersByTime(1000);
        game.wsHandlers.battle_updated({ battleId: 11, pMap: { 0: player(6) }, mMap: { 0: monster(800, 1) } });
        expect(guildTrialDamage.breakdown().totalDamage).toBe(100);
    });

    test('what the fight was called is carried into the breakdown', () => {
        fight('Chimerical Beast');
        const breakdown = guildTrialDamage.breakdown();
        expect(breakdown.monsterNames).toContain('Chimerical Beast');
        expect(breakdown.trialNames).toEqual(['Trial Chameleon']);
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
