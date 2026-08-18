import { describe, test, expect } from 'vitest';
import {
    nonDamagingByHrid,
    waveHridsOf,
    extractWaveIncoming,
    mergeWaveIncoming,
    compareZoneIncoming,
    zoneUptimeMismatches,
} from './zone-uptime-harness.js';

const A = '/monsters/aquahorse';
const B = '/monsters/butterjerry';

/** A `new_battle` monster unit, counters in combatDetails as the game sends them. */
function monsterUnit(hrid, { hp = 100, atk = 0, preparing = null, preparingAuto = true } = {}) {
    return {
        hrid,
        combatDetails: {
            currentHitpoints: hp,
            attackAttemptCounter: atk,
            preparingAbilityHrid: preparing,
            isPreparingAutoAttack: preparingAuto,
        },
    };
}

function playerUnit({ hp = 1000, dmg = 0 } = {}) {
    return { combatDetails: { currentHitpoints: hp, damageSplatCounter: dmg } };
}

function nb(at, monsters, players = [playerUnit()]) {
    return { at, type: 'new_battle', payload: { monsters, players } };
}

function bu(at, mMap = {}, pMap = {}) {
    return { at, type: 'battle_updated', payload: { mMap, pMap } };
}

describe('extractWaveIncoming', () => {
    test('a recording without attack counters is refused, not guessed at', () => {
        const ticks = [
            nb(0, [monsterUnit(A)]),
            // The legacy compact shape: health only, no counters
            { at: 1000, type: 'battle_updated', payload: { mMap: { 0: { cHP: 90 } }, pMap: { 0: { cHP: 980 } } } },
        ];
        const real = extractWaveIncoming(ticks);
        expect(real.usable).toBe(false);
        expect(real.reason).toMatch(/counter/);
    });

    test('two monsters interleaved: FIFO pays the earlier swing first, casts stay per-monster', () => {
        const ticks = [
            nb(0, [monsterUnit(A), monsterUnit(B)]),
            // A swings first...
            bu(1000, { 0: { atkCounter: 1, isAutoAtk: true } }),
            // ...B swings while A's hit resolves for 10
            bu(2000, { 1: { atkCounter: 1, isAutoAtk: true } }, { 0: { cHP: 990, dmgCounter: 1 } }),
            // B's hit resolves for 15
            bu(3000, {}, { 0: { cHP: 975, dmgCounter: 2 } }),
        ];
        const real = extractWaveIncoming(ticks);
        expect(real.usable).toBe(true);
        expect(real.byMonster[A].byAbility.autoAttack).toMatchObject({ casts: 1, hits: 1, damage: 10 });
        expect(real.byMonster[B].byAbility.autoAttack).toMatchObject({ casts: 1, hits: 1, damage: 15 });
    });

    test('the opening swing is counted, thanks to new_battle seeding the counters', () => {
        const ticks = [
            nb(0, [monsterUnit(A, { atk: 7 })]),
            // First compact tick already shows the 8th swing — one swing since the start
            bu(1000, { 0: { atkCounter: 8, isAutoAtk: true } }, { 0: { cHP: 990, dmgCounter: 1 } }),
        ];
        const real = extractWaveIncoming(ticks);
        expect(real.byMonster[A].byAbility.autoAttack).toMatchObject({ casts: 1, hits: 1, damage: 10 });
    });

    test('a same-monster pair aggregates under one hrid', () => {
        const ticks = [
            nb(0, [monsterUnit(A), monsterUnit(A)]),
            bu(1000, { 0: { atkCounter: 1, isAutoAtk: true }, 1: { atkCounter: 1, isAutoAtk: true } }),
            bu(2000, {}, { 0: { cHP: 980, dmgCounter: 2 } }),
        ];
        const real = extractWaveIncoming(ticks);
        expect(Object.keys(real.byMonster)).toEqual([A]);
        expect(real.byMonster[A].byAbility.autoAttack).toMatchObject({ casts: 2, hits: 2, damage: 20 });
    });

    test('a merged tick splits the health drop evenly across its resolutions', () => {
        const ticks = [
            nb(0, [monsterUnit(A)]),
            bu(1000, { 0: { atkCounter: 2, isAutoAtk: true } }),
            bu(2000, {}, { 0: { cHP: 970, dmgCounter: 2 } }),
        ];
        const real = extractWaveIncoming(ticks);
        expect(real.byMonster[A].byAbility.autoAttack.samples).toEqual([15, 15]);
    });

    test('a counter rise with health flat is a miss under the paying swing', () => {
        const ticks = [
            nb(0, [monsterUnit(A)]),
            bu(1000, { 0: { atkCounter: 1, isAutoAtk: true } }),
            bu(2000, {}, { 0: { cHP: 1000, dmgCounter: 1 } }),
        ];
        const real = extractWaveIncoming(ticks);
        expect(real.byMonster[A].byAbility.autoAttack).toMatchObject({ casts: 1, hits: 0, misses: 1, damage: 0 });
    });

    test('a resolution with no swing waiting is a wave-level DoT tick, credited to no monster', () => {
        const ticks = [
            nb(0, [monsterUnit(A)]),
            // The monster reports (counter unchanged — no swing) while the
            // player's counter rises: nothing queued, so it is a DoT tick
            bu(1000, { 0: { atkCounter: 0 } }, { 0: { cHP: 950, dmgCounter: 1 } }),
        ];
        const real = extractWaveIncoming(ticks);
        expect(real.dot).toMatchObject({ hits: 1, damage: 50 });
        expect(real.byMonster[A]).toBeUndefined();
    });

    test('a non-damaging buff casts but never queues, so the next hit is not swallowed', () => {
        const buff = '/abilities/toughness';
        const nonDamaging = new Map([[A, new Set([buff])]]);
        const ticks = [
            nb(0, [monsterUnit(A, { preparing: buff, preparingAuto: false }), monsterUnit(B)]),
            // A casts its buff...
            bu(1000, { 0: { atkCounter: 1, abilityHrid: buff } }),
            // ...B swings, and B's hit must not pay off the buff's slot
            bu(2000, { 1: { atkCounter: 1, isAutoAtk: true } }, { 0: { cHP: 988, dmgCounter: 1 } }),
        ];
        const real = extractWaveIncoming(ticks, { nonDamaging });
        expect(real.byMonster[A].byAbility[buff]).toMatchObject({ casts: 1, hits: 0, damage: 0 });
        expect(real.byMonster[B].byAbility.autoAttack).toMatchObject({ casts: 1, hits: 1, damage: 12 });
    });

    test('an index reused across battles does not bleed one fight into the next', () => {
        const ticks = [
            nb(0, [monsterUnit(A)]),
            bu(1000, { 0: { atkCounter: 1, isAutoAtk: true } }, { 0: { cHP: 990, dmgCounter: 1 } }),
            // New wave: index 0 is now a different monster with a fresh counter
            nb(2000, [monsterUnit(B)]),
            bu(3000, { 0: { atkCounter: 1, isAutoAtk: true } }, { 0: { cHP: 985, dmgCounter: 1 } }),
        ];
        const real = extractWaveIncoming(ticks);
        expect(real.byMonster[A].byAbility.autoAttack).toMatchObject({ casts: 1, damage: 10 });
        expect(real.byMonster[B].byAbility.autoAttack).toMatchObject({ casts: 1, damage: 15 });
        expect(real.byMonster[A].fights).toBe(1);
        expect(real.byMonster[B].fights).toBe(1);
        expect(real.fights).toBe(2);
    });

    test('an auto-attack tick resets the label — a special does not stick to following autos', () => {
        const smash = '/abilities/smash';
        const ticks = [
            nb(0, [monsterUnit(A)]),
            // Swing 1 was prepared as an auto; this tick casts the special
            bu(1000, { 0: { atkCounter: 1, abilityHrid: smash } }, { 0: { cHP: 990, dmgCounter: 1 } }),
            // Swing 2 is the special; this tick is an ordinary auto again
            bu(2000, { 0: { atkCounter: 2, isAutoAtk: true } }, { 0: { cHP: 960, dmgCounter: 2 } }),
            // Swing 3 must be labelled autoAttack, not smash
            bu(3000, { 0: { atkCounter: 3, isAutoAtk: true } }, { 0: { cHP: 950, dmgCounter: 3 } }),
        ];
        const real = extractWaveIncoming(ticks);
        expect(real.byMonster[A].byAbility.autoAttack.casts).toBe(2);
        expect(real.byMonster[A].byAbility[smash].casts).toBe(1);
    });

    test('ticks before the first new_battle are a partial attempt, excluded from the aggregate', () => {
        const ticks = [
            // A fight already in progress when the segment began
            bu(0, { 0: { atkCounter: 4, isAutoAtk: true } }, { 0: { cHP: 900, dmgCounter: 4 } }),
            bu(1000, { 0: { atkCounter: 5, isAutoAtk: true } }, { 0: { cHP: 880, dmgCounter: 5 } }),
            nb(2000, [monsterUnit(A)]),
            bu(3000, { 0: { atkCounter: 1, isAutoAtk: true } }, { 0: { cHP: 990, dmgCounter: 1 } }),
        ];
        const real = extractWaveIncoming(ticks);
        expect(real.captureStartedMidFight).toBe(true);
        expect(real.partialFights).toBe(1);
        expect(real.fights).toBe(1);
        expect(real.byMonster[A].byAbility.autoAttack.casts).toBe(1);
    });

    test('a party recording reports its size', () => {
        const ticks = [
            nb(0, [monsterUnit(A)], [playerUnit(), playerUnit()]),
            bu(1000, { 0: { atkCounter: 1, isAutoAtk: true } }, { 0: { cHP: 990, dmgCounter: 1 } }),
        ];
        expect(extractWaveIncoming(ticks).partySize).toBe(2);
    });
});

describe('mergeWaveIncoming', () => {
    const segment = (hp) => [
        nb(0, [monsterUnit(A)]),
        bu(1000, { 0: { atkCounter: 1, isAutoAtk: true } }, { 0: { cHP: hp, dmgCounter: 1 } }),
    ];

    test('segments sum: casts, damage, fights add; samples concatenate', () => {
        const merged = mergeWaveIncoming([extractWaveIncoming(segment(990)), extractWaveIncoming(segment(980))]);
        expect(merged.usable).toBe(true);
        expect(merged.fights).toBe(2);
        expect(merged.byMonster[A].fights).toBe(2);
        expect(merged.byMonster[A].byAbility.autoAttack).toMatchObject({ casts: 2, hits: 2, damage: 30 });
        expect(merged.byMonster[A].byAbility.autoAttack.samples).toEqual([10, 20]);
    });

    test('no usable segment carries the reason through', () => {
        const merged = mergeWaveIncoming([{ usable: false, reason: 'no attack counters (old recording)' }]);
        expect(merged.usable).toBe(false);
        expect(merged.reason).toMatch(/counter/);
    });
});

describe('compareZoneIncoming', () => {
    const real = {
        usable: true,
        partySize: 1,
        waveHrids: [A],
        byMonster: {
            [A]: {
                fights: 3,
                byAbility: { autoAttack: { casts: 10, hits: 9, misses: 1, damage: 900, samples: [100] } },
            },
        },
        dot: { casts: 0, hits: 5, misses: 0, damage: 250, samples: [50, 50, 50, 50, 50] },
    };
    const simResult = {
        attacks: {
            [A]: { player1: { autoAttack: { 100: 9, miss: 1 }, damageOverTime: { 50: 5 } } },
            '/monsters/boss': { player1: { autoAttack: { 200: 3 } } },
        },
    };

    test('one section per real monster; the sim-only boss is a footnote, not a finding', () => {
        const result = compareZoneIncoming(real, simResult);
        expect(result.sections.map((s) => s.monsterHrid)).toEqual([A]);
        expect(result.simOnlyHrids).toEqual(['/monsters/boss']);
    });

    test("the sim's per-monster DoT is pulled out of the section and into the wave row", () => {
        const result = compareZoneIncoming(real, simResult);
        const abilities = result.sections[0].rows.map((row) => row.ability);
        expect(abilities).not.toContain('damageOverTime');
        expect(result.dotRow.real).toMatchObject({ ticks: 5, damage: 250 });
        expect(result.dotRow.sim).toMatchObject({ ticks: 5, damage: 250 });
        expect(result.dotRow.verdict).toBe('ok');
    });

    test('a matching decomposition grades ok', () => {
        const result = compareZoneIncoming(real, simResult);
        const auto = result.sections[0].rows.find((row) => row.ability === 'autoAttack');
        expect(auto.verdict).toBe('ok');
    });
});

describe('zoneUptimeMismatches', () => {
    const gameData = {
        actionDetailMap: {
            '/actions/combat/swamp': {
                combatZoneInfo: {
                    fightInfo: {
                        randomSpawnInfo: { spawns: [{ combatMonsterHrid: A }] },
                        bossSpawns: [{ combatMonsterHrid: B }],
                    },
                },
            },
        },
    };

    test('a clean solo recording of the simmed zone passes', () => {
        const real = { partySize: 1, waveHrids: [A, B] };
        expect(zoneUptimeMismatches(real, { zoneHrid: '/actions/combat/swamp', gameData })).toEqual([]);
    });

    test('a party recording is refused', () => {
        const real = { partySize: 2, waveHrids: [A] };
        expect(zoneUptimeMismatches(real, { zoneHrid: '/actions/combat/swamp', gameData })).toContain('party');
    });

    test('no zone to sim against is named', () => {
        expect(zoneUptimeMismatches({ partySize: 1, waveHrids: [] }, { gameData })).toContain('zone');
    });

    test('a monster foreign to the zone spawn table is named', () => {
        const real = { partySize: 1, waveHrids: [A, '/monsters/stranger'] };
        expect(zoneUptimeMismatches(real, { zoneHrid: '/actions/combat/swamp', gameData })).toContain('wave');
    });

    test('an absent spawn table proves nothing and does not refuse', () => {
        const real = { partySize: 1, waveHrids: [A] };
        expect(zoneUptimeMismatches(real, { zoneHrid: '/actions/combat/dungeon', gameData })).toEqual([]);
    });

    test('mixed loadouts across segments are refused; when-it-was-taken is not a difference', () => {
        const real = { partySize: 1, waveHrids: [A] };
        const context = { zoneHrid: '/actions/combat/swamp', gameData };
        const sameKit = [
            { capturedAt: 1, levels: { attackLevel: 90 } },
            { capturedAt: 99, levels: { attackLevel: 90 } },
        ];
        expect(zoneUptimeMismatches(real, { ...context, segmentLoadouts: sameKit })).toEqual([]);
        const changedKit = [{ levels: { attackLevel: 90 } }, { levels: { attackLevel: 91 } }];
        expect(zoneUptimeMismatches(real, { ...context, segmentLoadouts: changedKit })).toContain('build');
    });
});

describe('nonDamagingByHrid and waveHridsOf', () => {
    test('a buff with no damage effect is mapped; a damaging ability is not', () => {
        const gameData = {
            combatMonsterDetailMap: {
                [A]: { abilities: [{ abilityHrid: '/abilities/toughness' }, { abilityHrid: '/abilities/smash' }] },
            },
            abilityDetailMap: {
                '/abilities/toughness': { abilityEffects: [{ effectType: '/ability_effect_types/buff' }] },
                '/abilities/smash': { abilityEffects: [{ effectType: '/ability_effect_types/damage' }] },
            },
        };
        const map = nonDamagingByHrid(gameData, [A]);
        expect(map.get(A).has('/abilities/toughness')).toBe(true);
        expect(map.get(A).has('/abilities/smash')).toBe(false);
    });

    test('waveHridsOf names every monster the segment saw start a fight', () => {
        const ticks = [nb(0, [monsterUnit(A)]), bu(1000, {}), nb(2000, [monsterUnit(B), monsterUnit(A)])];
        expect([...waveHridsOf(ticks)].sort()).toEqual([A, B]);
    });
});
