/**
 * The expected-tier forecast.
 *
 * The load-bearing test in this file is the first one: the tier health rule is
 * checked against the two tiers actually recorded off a live trial, to the
 * digit. Everything else is the walk around it.
 */

import { describe, test, expect } from 'vitest';

import {
    ENRAGE_MS,
    estimatePartyDamage,
    forecastCombatTier,
    forecastSkillingTier,
    forecastTrial,
    tierMonsterHp,
    trialWave,
} from './guild-trial-forecast.js';

/** The game's own data, in the shape the user extracted it from `initClientData` */
const clientData = {
    guildTrialDetailMap: {
        '/guild_combat/chameleon': { name: 'Trial Chameleon', monsterHrids: ['/monsters/trial_chameleon'] },
        '/guild_combat/badger': {
            name: 'Trial Badger',
            monsterHrids: ['/monsters/trial_badger', '/monsters/trial_badger'],
        },
        '/guild_combat/swarm': {
            name: 'Trial Swarm',
            monsterHrids: [
                '/monsters/trial_beetle',
                '/monsters/trial_dragonfly',
                '/monsters/trial_wasp',
                '/monsters/trial_firefly',
            ],
        },
        '/guild_skilling/alchemy': { name: 'Alchemy', skillHrid: '/skills/alchemy' },
    },
    combatMonsterDetailMap: {
        '/monsters/trial_chameleon': {
            name: 'Trial Chameleon',
            isGuildMonster: true,
            combatDetails: { maxHitpoints: 550_000 },
        },
        '/monsters/trial_badger': { name: 'Trial Badger', combatDetails: { maxHitpoints: 330_000 } },
        '/monsters/trial_beetle': { name: 'Trial Beetle', combatDetails: { maxHitpoints: 220_000 } },
        '/monsters/trial_dragonfly': { name: 'Trial Dragonfly', combatDetails: { maxHitpoints: 220_000 } },
        '/monsters/trial_wasp': { name: 'Trial Wasp', combatDetails: { maxHitpoints: 220_000 } },
        '/monsters/trial_firefly': { name: 'Trial Firefly', combatDetails: { maxHitpoints: 220_000 } },
    },
};

describe('the tier health rule', () => {
    test('reproduces the recorded trial exactly, on both tiers', () => {
        // Trial Chameleon's own sheet is 550,000 at Lv.100 — which is the game's
        // `10 × (10 + level)` health formula times 500 — and the run that was
        // recorded had three members signed up ("Signed Up 3/56" in the same
        // export). This is the whole reason the combat ladder is derived rather
        // than fitted.
        expect(tierMonsterHp({ baseHp: 550_000, tier: 2, participants: 3 })).toBeCloseTo(618_000, 6);
        expect(tierMonsterHp({ baseHp: 550_000, tier: 3, participants: 3 })).toBeCloseTo(669_500, 6);
    });

    test('tier one is the sheet itself, before anybody signs up', () => {
        expect(tierMonsterHp({ baseHp: 550_000, tier: 1, participants: 0 })).toBe(550_000);
    });

    test('each participant adds one per cent', () => {
        const alone = tierMonsterHp({ baseHp: 550_000, tier: 1, participants: 0 });
        const crowd = tierMonsterHp({ baseHp: 550_000, tier: 1, participants: 20 });
        expect(crowd / alone).toBeCloseTo(1.2, 10);
    });

    test('a tier off the ladder has no health', () => {
        expect(tierMonsterHp({ baseHp: 550_000, tier: 0 })).toBeNull();
        expect(tierMonsterHp({ baseHp: 550_000, tier: 99 })).toBeNull();
        expect(tierMonsterHp({ baseHp: 0, tier: 2 })).toBeNull();
    });
});

describe('trialWave', () => {
    test('finds a trial by the name the card shows', () => {
        const wave = trialWave('Trial Chameleon', clientData);
        expect(wave.baseHp).toBe(550_000);
        expect(wave.count).toBe(1);
    });

    test('a wave of several monsters is all of them together', () => {
        // Badger is the same monster twice; Swarm is four different ones
        expect(trialWave('Trial Badger', clientData).baseHp).toBe(660_000);
        expect(trialWave('Trial Swarm', clientData)).toMatchObject({ baseHp: 880_000, count: 4 });
    });

    test('a trial the client data does not describe is null, not a guess', () => {
        expect(trialWave('Trial Chameleon', {})).toBeNull();
        expect(trialWave('Milking', clientData)).toBeNull();
        expect(trialWave('', clientData)).toBeNull();
    });
});

describe('estimatePartyDamage', () => {
    test('adds up the sheets it has and says how many that was', () => {
        const estimate = estimatePartyDamage([
            { stats: { attackInterval: 3_000_000_000, autoAttackDamage: 0.39 } },
            { stats: { attackInterval: 2_000_000_000, autoAttackDamage: 0.5 } },
            { stats: {} },
        ]);

        expect(estimate.members).toBe(2);
        expect(estimate.dps).toBeGreaterThan(0);
    });

    test('no usable sheet is no estimate rather than nought', () => {
        expect(estimatePartyDamage([]).dps).toBeNull();
        expect(estimatePartyDamage([{ stats: { attackInterval: 0, autoAttackDamage: 1 } }]).dps).toBeNull();
    });
});

describe('forecastCombatTier', () => {
    const base = { baseHp: 550_000, participants: 3, timeLeftMs: 60 * 60_000 };

    test('walks the ladder at the measured rate', () => {
        // 2,000 dmg/s against 618,000 is a little over five minutes a tier
        const walk = forecastCombatTier({ ...base, tier: 2, dps: 2000 });

        expect(walk.tiersCleared).toBeGreaterThan(1);
        expect(walk.finalTier).toBeGreaterThan(2);
        expect(walk.limitedBy).toBe('time');
    });

    test('a tier that cannot be killed before the boss enrages is a wall', () => {
        // Ten minutes is the cap on one fight, so 618,000 needs 1,030 dmg/s to
        // land at all — this party is under it and clears nothing
        const walk = forecastCombatTier({ ...base, tier: 2, dps: 900 });

        expect(walk.tiersCleared).toBe(0);
        expect(walk.limitedBy).toBe('enrage');
        expect(ENRAGE_MS).toBe(600_000);
    });

    test('the health already off the current boss counts', () => {
        const fresh = forecastCombatTier({ ...base, tier: 2, dps: 2000 });
        const nearlyDead = forecastCombatTier({ ...base, tier: 2, dps: 2000, remainingInTier: 1000 });

        expect(nearlyDead.tiersCleared).toBeGreaterThanOrEqual(fresh.tiersCleared);
    });

    test('a tier that was actually read beats the derived one', () => {
        const walk = forecastCombatTier({
            ...base,
            tier: 2,
            dps: 100_000,
            timeLeftMs: 60_000,
            observedTotal: (tier) => (tier === 2 ? 10 : null),
        });
        // Ten health, so the first tier costs no time worth speaking of
        expect(walk.clears[0].health).toBe(10);
    });

    test('the top of the ladder stops the walk', () => {
        const walk = forecastCombatTier({ ...base, tier: 21, dps: 10_000_000 });
        expect(walk.limitedBy).toBe('ladder');
        expect(walk.finalTier).toBe(21);
    });

    test('no rate is no forecast', () => {
        expect(forecastCombatTier({ ...base, tier: 2, dps: 0 })).toBeNull();
        expect(forecastCombatTier({ ...base, tier: 2, dps: 2000, timeLeftMs: null })).toBeNull();
    });
});

describe('forecastSkillingTier', () => {
    const observations = [
        { tier: 7, total: 60_000 },
        { tier: 8, total: 69_360 },
    ];

    test('walks the pool sizes that were actually seen', () => {
        const walk = forecastSkillingTier({ tier: 8, rate: 106, timeLeftMs: 30 * 60_000, observations });

        expect(walk.tiersCleared).toBeGreaterThan(0);
        expect(walk.finalTier).toBeGreaterThanOrEqual(8);
    });

    test('one tier seen is now enough to walk the whole ladder', () => {
        // The rule the live pools proved — 40,800 / 44,880 / 48,960 is the first
        // tier's work plus a tenth of it per tier, times the participant
        // multiplier — means a single observation gives every tier. This used to
        // stop dead at "needs a second tier to fit the curve".
        const walk = forecastSkillingTier({
            tier: 8,
            rate: 106,
            timeLeftMs: 60 * 60_000,
            observations: [{ tier: 8, total: 69_360 }],
            participants: 2,
        });

        expect(walk.tiersCleared).toBeGreaterThan(1);
        expect(walk.limitedBy).toBe('time');
    });

    test('the derived pools reproduce the live trial exactly', () => {
        const walk = forecastSkillingTier({
            tier: 1,
            rate: 1_000_000,
            timeLeftMs: 60 * 60_000,
            observations: [{ tier: 1, total: 40_800 }],
            participants: 2,
        });

        const sizes = walk.clears.slice(0, 3).map((clear) => Math.round(clear.work));
        expect(sizes).toEqual([40_800, 44_880, 48_960]);
    });

    test('no measured rate is no forecast at all', () => {
        expect(forecastSkillingTier({ tier: 8, rate: null, timeLeftMs: 1000, observations })).toBeNull();
    });
});

describe('forecastTrial', () => {
    const analysis = (extra = {}) => ({
        kind: 'combat',
        tier: 2,
        timeLeftMs: 40 * 60_000,
        rate: null,
        remaining: null,
        tiers: [],
        ...extra,
    });

    test('a measured party DPS is what it prefers', () => {
        const forecast = forecastTrial({
            analysis: analysis(),
            clientData,
            name: 'Trial Chameleon',
            participants: 3,
            measuredDps: 2000,
        });

        expect(forecast.source).toBe('measured');
        expect(forecast.tier).toBeGreaterThan(2);
    });

    test('without one it estimates from the loadouts, and says how many it had', () => {
        const forecast = forecastTrial({
            analysis: analysis(),
            clientData,
            name: 'Trial Chameleon',
            participants: 5,
            loadouts: [
                { stats: { attackInterval: 3_000_000_000, autoAttackDamage: 0.39 } },
                { stats: { attackInterval: 3_000_000_000, autoAttackDamage: 0.39 } },
            ],
        });

        expect(forecast.source).toBe('estimated');
        expect(forecast.coverage).toEqual({ known: 2, of: 5 });
    });

    test('a skilling trial is only projected from a measured fill rate', () => {
        const withoutRate = forecastTrial({ analysis: analysis({ kind: 'skilling', rate: null }) });
        expect(withoutRate.source).toBe('none');
        expect(withoutRate.reason).toContain('measured fill rate');

        const withRate = forecastTrial({
            analysis: analysis({
                kind: 'skilling',
                rate: 0.106,
                tiers: [
                    { tier: 7, total: 60_000 },
                    { tier: 8, total: 69_360 },
                ],
                tier: 8,
            }),
        });
        expect(withRate.source).toBe('measured');
    });

    test('every kind of not-knowing says which kind it is', () => {
        expect(forecastTrial({ analysis: analysis({ tier: null }) }).reason).toContain('tier is not known');
        expect(forecastTrial({ analysis: analysis({ timeLeftMs: null }) }).reason).toContain('no clock');
        expect(forecastTrial({ analysis: analysis(), clientData: {}, name: 'Trial Chameleon' }).reason).toContain(
            'not in the game data'
        );
        expect(forecastTrial({ analysis: analysis(), clientData, name: 'Trial Chameleon' }).reason).toContain(
            'no party damage measured'
        );
    });
});
