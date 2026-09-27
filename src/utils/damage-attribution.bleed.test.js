/**
 * Attribution against a bleed build.
 *
 * `labyrinth-pyre-hunter-bleed.json` is a real labyrinth tick capture — five
 * Pyre Hunter fights in two rooms (the monster's maximum health differs), a
 * melee character running Maim — trimmed to the fields attribution reads, with
 * the name replaced.
 *
 * ## What it caught
 *
 * A Maim bleed tick raises the monster's `dmgCounter` exactly as a swing does,
 * and the attribution filed a tick as damage-over-time only when that counter
 * stood still. So every bleed tick in a solo fight was a landed non-crit hit:
 * `dotTicks` read zero, the hit rate was inflated and crit rate and damage per
 * hit diluted. A tick is now a counter rise no swing paid for, on a tick the
 * monster did not attack.
 *
 * The same capture shows why "the monster did not attack" is part of it: the
 * character has Parry, and a parry's counter-attack also rings the monster's
 * counter with no swing of the player's behind it. Those arrive on the tick the
 * monster attacked, roll hits, misses and crits like any swing, and the sim
 * counts them as swings — so they stay hits.
 */

import { describe, test, expect } from 'vitest';
import {
    newAttributionState,
    noteActions,
    attributeTick,
    foldEvents,
    seedMonsterAttacks,
    DOT_ACTION,
} from './damage-attribution.js';
import capture from './__fixtures__/labyrinth-pyre-hunter-bleed.json';
import party from './__fixtures__/combat-party.json';
import dungeon from './__fixtures__/combat-dungeon.json';

/**
 * The capture, fight by fight, as the labyrinth room log tallies it: a fresh
 * state per `new_battle`, seeded from its statement.
 *
 * @returns {Array<{maxHP: number, tally: Object, events: Array<Object>}>}
 */
function replay(ticks = capture.ticks) {
    const fights = [];
    let fight = null;
    for (const tick of ticks) {
        if (tick.type === 'new_battle') {
            const state = newAttributionState();
            noteActions(state, tick.payload.players);
            tick.payload.monsters.forEach((monster, index) => {
                state.monstersHP[index] = monster.currentHitpoints;
                state.monstersMaxHP[index] = monster.maxHitpoints;
                state.dmgCounter[index] = monster.damageSplatCounter;
                state.critCounter[index] = monster.criticalDamageSplatCounter;
                seedMonsterAttacks(state, index, monster);
            });
            tick.payload.players.forEach((player, index) => {
                state.playersAtk[index] = player.attackAttemptCounter;
                state.playersMP[index] = player.currentManapoints;
            });
            fight = { maxHP: tick.payload.monsters[0].maxHitpoints, state, tally: {}, events: [] };
            fights.push(fight);
            continue;
        }
        if (!fight) continue;
        const events = attributeTick(tick.payload, fight.state);
        fight.events.push(...events);
        foldEvents(fight.tally, events, { filterNonDamaging: false });
        noteActions(fight.state, tick.payload.pMap);
    }
    return fights;
}

/** Every fight's player row summed */
function total(fights) {
    const sum = { hits: 0, misses: 0, crits: 0, damage: 0, dotTicks: 0, dotDamage: 0 };
    for (const fight of fights) {
        for (const key of Object.keys(sum)) sum[key] += fight.tally['0']?.[key] || 0;
    }
    return sum;
}

describe('a real bleed capture', () => {
    const fights = replay();

    test('files its bleed ticks as damage over time, not as landed hits', () => {
        const all = total(fights);

        // Every counter rise used to be a hit or a miss: 245 hits, 91 misses
        expect(all.hits + all.dotTicks).toBe(245);
        expect(all.dotTicks).toBe(47);
        expect(all.dotDamage).toBe(1_968);
        expect(all.hits).toBe(198);
        expect(all.misses).toBe(91);
        expect(all.crits).toBe(65);
    });

    test('keeps every point of damage where it was', () => {
        // Three losses and two kills: the last two fights took the whole bar
        expect(fights.map((fight) => fight.tally['0'].damage)).toEqual([6_631, 5_913, 7_402, 10_600, 10_080]);
    });

    test('never crits or misses a tick', () => {
        const ticks = fights.flatMap((fight) => fight.events).filter((event) => event.isDot);
        expect(ticks).toHaveLength(47);
        expect(ticks.every((event) => !event.isCrit && !event.isMiss && event.action === DOT_ACTION)).toBe(true);
        // Maim's ticks are small and regular — nothing a sword swing looks like
        expect(Math.max(...ticks.map((event) => event.amount))).toBeLessThan(100);
    });

    test('reads the corrected figures per room', () => {
        const rate = (rows) => {
            const sum = total(rows);
            const swings = sum.hits + sum.misses;
            return {
                hitRate: sum.hits / swings,
                critRate: sum.crits / sum.hits,
                damagePerHit: (sum.damage - sum.dotDamage) / sum.hits,
                dotPerSwing: sum.dotTicks / swings,
            };
        };

        const higher = rate(fights.filter((fight) => fight.maxHP === 10_600));
        expect(higher.hitRate).toBeCloseTo(151 / 217, 6);
        expect(higher.critRate).toBeCloseTo(51 / 151, 6);
        expect(higher.damagePerHit).toBeCloseTo((30_546 - 1_616) / 151, 6);
        expect(higher.dotPerSwing).toBeCloseTo(35 / 217, 6);

        const lower = rate(fights.filter((fight) => fight.maxHP === 10_080));
        expect(lower.hitRate).toBeCloseTo(47 / 72, 6);
        expect(lower.critRate).toBeCloseTo(14 / 47, 6);
        expect(lower.dotPerSwing).toBeCloseTo(12 / 72, 6);
    });

    test('without the Parry stat, those same counter-attacks would be bleed ticks', () => {
        // Proof the stat is what keeps them: the 15 parries on the monster's
        // attack ticks become ticks once the character cannot parry
        const withoutParry = capture.ticks.map((tick) =>
            tick.type === 'new_battle'
                ? {
                      ...tick,
                      payload: {
                          ...tick.payload,
                          players: tick.payload.players.map((unit) => ({
                              ...unit,
                              combatDetails: { combatStats: {} },
                          })),
                      },
                  }
                : tick
        );
        const all = total(replay(withoutParry));
        // 11 of them dealt damage and join the 47 ticks; the 4 that missed dealt
        // none, and a tick that deals nothing is not a tick
        expect(all.dotTicks).toBe(47 + 11);
        expect(all.misses).toBe(91 - 4);
        expect(all.hits + all.misses + all.dotTicks).toBe(245 + 91 - 4);
    });

    test('keeps a parry’s counter-attack as a swing', () => {
        // Fight one, @30710: the monster attacked, the character swung nothing
        // and was not hurt, and the monster lost 92 — a parry, not a bleed
        const [parry] = fights[0].events.filter((event) => !event.isKill && event.amount === 92);
        expect(parry).toMatchObject({ isDot: false, isMiss: false, playerIndex: '0' });
    });
});

/** A wire-shaped monster entry */
const monster = (cHP, dmgCounter, critCounter = 0, atkCounter = 1, mHP = 10_000) => ({
    cHP,
    mHP,
    atkCounter,
    dmgCounter,
    critCounter,
});

/** A wire-shaped player entry */
const player = (atkCounter, extra = {}) => ({
    cHP: 2_000,
    mHP: 2_000,
    cMP: 500,
    atkCounter,
    isAutoAtk: true,
    ...extra,
});

/** A state that has seen one baseline tick, as after a `new_battle` */
function started(players, monsters) {
    const state = newAttributionState();
    attributeTick({ pMap: players, mMap: monsters }, state);
    return state;
}

describe('a swing, a counter-attack and a tick', () => {
    test('a solo run of swings and bleed ticks keeps them apart', () => {
        const state = started({ 0: player(10) }, { 0: monster(10_000, 5) });
        const events = [
            // The swing that applies the bleed
            ...attributeTick({ pMap: { 0: player(11) }, mMap: { 0: monster(9_700, 6) } }, state),
            // Three ticks: the counter rises, the player's does not, the monster did not attack
            ...attributeTick({ pMap: { 0: player(11) }, mMap: { 0: monster(9_640, 7) } }, state),
            ...attributeTick({ pMap: {}, mMap: { 0: monster(9_580, 8) } }, state),
            ...attributeTick({ pMap: { 0: player(12) }, mMap: { 0: monster(9_380, 9) } }, state),
            ...attributeTick({ pMap: { 0: player(12) }, mMap: { 0: monster(9_320, 10) } }, state),
        ];
        const tally = foldEvents({}, events, { filterNonDamaging: false });

        expect(tally['0']).toMatchObject({ hits: 2, misses: 0, dotTicks: 3, damage: 680, dotDamage: 180 });
    });

    test('a crit swing is a crit, marked by the crit counter catching up', () => {
        // The game sets the crit counter to the splat that crit, so it jumps
        const state = started({ 0: player(10) }, { 0: monster(10_000, 5, 2) });
        const [hit] = attributeTick({ pMap: { 0: player(11) }, mMap: { 0: monster(9_690, 6, 6) } }, state);

        expect(hit).toMatchObject({ amount: 310, isCrit: true, isDot: false, isMiss: false });
    });

    test('a swing that deals nothing is a miss', () => {
        const state = started({ 0: player(10) }, { 0: monster(10_000, 5) });
        const [miss] = attributeTick({ pMap: { 0: player(11) }, mMap: { 0: monster(10_000, 6) } }, state);

        expect(miss).toMatchObject({ amount: 0, isMiss: true, isDot: false });
    });

    test('a parry on the monster’s attack is a counted swing, and can miss', () => {
        const state = started({ 0: player(10) }, { 0: monster(10_000, 5, 0, 3) });
        const [counter] = attributeTick({ pMap: { 0: player(10) }, mMap: { 0: monster(9_753, 6, 6, 4) } }, state);
        const [whiff] = attributeTick({ pMap: { 0: player(10) }, mMap: { 0: monster(9_753, 7, 6, 5) } }, state);

        expect(counter).toMatchObject({ amount: 247, isCrit: true, isDot: false, isMiss: false });
        expect(whiff).toMatchObject({ amount: 0, isMiss: true, isDot: false });
    });

    test('a rise nothing paid for and the monster did not make, with no health lost, is nothing', () => {
        const state = started({ 0: player(10) }, { 0: monster(10_000, 5) });
        expect(attributeTick({ pMap: { 0: player(10) }, mMap: { 0: monster(10_000, 6) } }, state)).toEqual([]);
    });

    test('the phantom swing a respawn gap coalesces into the next battle is not left pending', () => {
        // The first message after `new_battle`: a swing that touched no monster
        const state = newAttributionState();
        state.playersAtk['0'] = 1;
        state.monstersHP['0'] = 10_000;
        state.monstersMaxHP['0'] = 10_000;
        state.dmgCounter['0'] = 0;
        state.critCounter['0'] = 0;
        seedMonsterAttacks(state, '0', { attackAttemptCounter: 1 });
        expect(attributeTick({ pMap: { 0: player(2) }, mMap: {} }, state)).toEqual([]);

        // A later bleed tick must not pay that swing off as a hit
        const [event] = attributeTick({ pMap: { 0: player(2) }, mMap: { 0: monster(9_940, 1) } }, state);
        expect(event).toMatchObject({ amount: 60, isDot: true });
    });

    test('a payload without attack counters keeps the old reading', () => {
        const state = started({ 0: { cMP: 100 } }, { 0: monster(10_000, 5) });
        const [hit] = attributeTick({ pMap: { 0: { cMP: 100 } }, mMap: { 0: monster(9_940, 6) } }, state);

        expect(hit).toMatchObject({ amount: 60, isDot: false, isMiss: false });
    });

    test('a monster whose attacks were never seeded keeps the old reading for that tick', () => {
        const state = newAttributionState();
        state.playersAtk['0'] = 10;
        state.monstersHP['0'] = 10_000;
        state.dmgCounter['0'] = 5;
        state.critCounter['0'] = 0;
        const [event] = attributeTick({ pMap: { 0: player(10) }, mMap: { 0: monster(9_753, 6) } }, state);

        expect(event).toMatchObject({ amount: 247, isDot: false });
    });
});

describe('a party', () => {
    // Both auto-attacking, as `new_battle` would say
    const party = () => {
        const state = started({ 0: player(10), 1: player(20) }, { 0: monster(10_000, 5), 1: monster(10_000, 3) });
        noteActions(state, { 0: player(10), 1: player(20) });
        return state;
    };

    test('two players striking one monster on one tick get a swing each', () => {
        const state = party();
        const events = attributeTick({ pMap: { 0: player(11), 1: player(21) }, mMap: { 0: monster(9_400, 7) } }, state);
        const tally = foldEvents({}, events, { filterNonDamaging: false });

        expect(tally['0']).toMatchObject({ hits: 1, damage: 300, dotTicks: 0 });
        expect(tally['1']).toMatchObject({ hits: 1, damage: 300, dotTicks: 0 });
    });

    test('one swinging while the other’s bleed ticks on another monster', () => {
        const state = party();
        const events = attributeTick(
            {
                pMap: { 0: player(11), 1: player(20) },
                mMap: { 0: monster(9_700, 6), 1: monster(9_940, 4) },
            },
            state
        );
        const tally = foldEvents({}, events, { filterNonDamaging: false });

        expect(tally['0']).toMatchObject({ hits: 1, damage: 300, dotTicks: 0 });
        expect(tally['1']).toMatchObject({ hits: 0, damage: 60, dotTicks: 1, dotDamage: 60 });
    });

    test('one swinging while the other’s bleed ticks on the same monster', () => {
        // Two splats on one monster, one swing: the health lost splits evenly
        const state = party();
        const events = attributeTick({ pMap: { 0: player(11), 1: player(20) }, mMap: { 0: monster(9_640, 7) } }, state);
        const tally = foldEvents({}, events, { filterNonDamaging: false });

        expect(tally['0']).toMatchObject({ hits: 1, damage: 180, dotTicks: 0 });
        expect(tally['1']).toMatchObject({ hits: 0, damage: 180, dotTicks: 1 });
    });

    test('keeps the tick’s total whatever the split', () => {
        const state = party();
        const events = attributeTick({ pMap: { 0: player(11), 1: player(20) }, mMap: { 0: monster(9_640, 7) } }, state);
        const dealt = events.filter((event) => !event.isKill).reduce((sum, event) => sum + event.amount, 0);

        expect(dealt).toBe(360);
    });
});

describe('an area swing', () => {
    const SURGE = '/abilities/frost_surge';
    const SLASH = '/abilities/crippling_slash';
    const abilityDetailMap = {
        [SURGE]: { abilityEffects: [{ effectType: '/ability_effect_types/damage', targetType: 'allEnemies' }] },
        [SLASH]: { abilityEffects: [{ effectType: '/ability_effect_types/damage', targetType: 'enemy' }] },
    };
    const three = () =>
        started({ 0: player(10) }, { 0: monster(10_000, 5), 1: monster(10_000, 3), 2: monster(10_000, 8) });

    test('one cast ringing three monsters is a hit on each, not a hit and two ticks', () => {
        // The wire: the caster's counter rises once, every monster's once
        const state = three();
        noteActions(state, { 0: { abilityHrid: SURGE } });
        const events = attributeTick(
            {
                pMap: { 0: player(11) },
                mMap: { 0: monster(9_800, 6), 1: monster(9_750, 4), 2: monster(10_000, 9) },
            },
            state,
            { abilityDetailMap }
        );
        const tally = foldEvents({}, events, { filterNonDamaging: false });

        expect(tally['0']).toMatchObject({ hits: 2, misses: 1, dotTicks: 0, damage: 450 });
    });

    test('a cast the game data cannot place is read as one that may have struck them all', () => {
        const state = three();
        noteActions(state, { 0: { abilityHrid: '/abilities/unknown' } });
        const events = attributeTick(
            { pMap: { 0: player(11) }, mMap: { 0: monster(9_800, 6), 1: monster(9_750, 4) } },
            state
        );

        expect(events.filter((event) => event.isDot)).toEqual([]);
        expect(events).toHaveLength(2);
    });

    test('pays off at most one rise per monster', () => {
        // One cast, a monster rung twice: the second splat is not the cast's
        const state = three();
        noteActions(state, { 0: { abilityHrid: SURGE } });
        const events = attributeTick(
            { pMap: { 0: player(11) }, mMap: { 0: monster(9_700, 7), 1: monster(9_900, 4) } },
            state,
            { abilityDetailMap }
        );
        const tally = foldEvents({}, events, { filterNonDamaging: false });

        expect(tally['0']).toMatchObject({ hits: 2, dotTicks: 1, damage: 400, dotDamage: 150 });
    });

    test('a single-target swing beside a bleed on a second monster leaves the bleed a tick', () => {
        for (const [label, options] of [
            ['auto', undefined],
            [SLASH, { abilityDetailMap }],
        ]) {
            const state = three();
            noteActions(state, { 0: label === 'auto' ? { isAutoAtk: true } : { abilityHrid: label } });
            const events = attributeTick(
                { pMap: { 0: player(11) }, mMap: { 0: monster(9_700, 6), 1: monster(9_940, 4) } },
                state,
                options
            );
            const tally = foldEvents({}, events, { filterNonDamaging: false });

            expect(tally['0']).toMatchObject({ hits: 1, dotTicks: 1, damage: 360, dotDamage: 60 });
        }
    });

    test('a piercing single-enemy strike that carries on to a second monster is a hit on both', () => {
        // Penetrating Strike targets one enemy but pierces on to the next
        const PIERCE = '/abilities/penetrating_strike';
        const withPierce = {
            ...abilityDetailMap,
            [PIERCE]: {
                abilityEffects: [
                    { effectType: '/ability_effect_types/damage', targetType: 'enemy', pierceChance: 0.3 },
                ],
            },
        };
        const state = three();
        noteActions(state, { 0: { abilityHrid: PIERCE } });
        const events = attributeTick(
            { pMap: { 0: player(11) }, mMap: { 0: monster(9_700, 6), 1: monster(9_800, 4) } },
            state,
            { abilityDetailMap: withPierce }
        );
        const tally = foldEvents({}, events, { filterNonDamaging: false });

        expect(tally['0']).toMatchObject({ hits: 2, dotTicks: 0, damage: 500 });
    });

    test('in a party, each caster’s area swing pays its own hits', () => {
        const state = started({ 0: player(10), 1: player(20) }, { 0: monster(10_000, 5), 1: monster(10_000, 3) });
        noteActions(state, { 0: { abilityHrid: SURGE }, 1: { abilityHrid: SURGE } });
        const events = attributeTick(
            { pMap: { 0: player(11), 1: player(21) }, mMap: { 0: monster(9_600, 7), 1: monster(9_600, 5) } },
            state,
            { abilityDetailMap }
        );
        const tally = foldEvents({}, events, { filterNonDamaging: false });

        expect(tally['0']).toMatchObject({ hits: 2, dotTicks: 0, damage: 400 });
        expect(tally['1']).toMatchObject({ hits: 2, dotTicks: 0, damage: 400 });
    });
});

describe('the recorded parties', () => {
    // Frost Surge, Crippling Slash and Penetrating Shot/Strike each raise the
    // caster's counter once and ring several monsters on the same tick
    test.each([
        ['combat-party', party],
        ['combat-dungeon', dungeon],
    ])('%s files no damage-over-time: its only multi-monster rises are area casts', (_, recording) => {
        const state = newAttributionState();
        const ticks = [];
        for (const tick of recording.ticks) {
            if (tick.type === 'new_battle') {
                noteActions(state, tick.payload.players);
                state.monstersHP = {};
                state.dmgCounter = {};
                state.critCounter = {};
                continue;
            }
            ticks.push(...attributeTick(tick.payload, state).filter((event) => event.isDot));
            noteActions(state, tick.payload.pMap);
        }
        expect(ticks).toEqual([]);
    });
});

describe('a rise on a tick the monster attacked', () => {
    const stated = (combatStats) => {
        const state = started({ 0: player(10, { dmgCounter: 4 }) }, { 0: monster(10_000, 5, 0, 3) });
        noteActions(state, { 0: { isPreparingAutoAttack: true, combatDetails: { combatStats } } });
        return state;
    };
    // The monster attacks (its counter 3 → 4) and loses 60 with no swing behind it
    const tickWith = (playerSplats) => ({
        pMap: { 0: player(10, { dmgCounter: playerSplats }) },
        mMap: { 0: monster(9_940, 6, 0, 4) },
    });

    test('is a bleed for a player who cannot counter', () => {
        const state = stated({});
        const [event] = attributeTick(tickWith(5), state);
        expect(event).toMatchObject({ amount: 60, isDot: true });
    });

    test('is a bleed for a player who cannot counter, even when the attack missed them', () => {
        const state = stated({ criticalRate: 0.3 });
        const [event] = attributeTick(tickWith(4), state);
        expect(event).toMatchObject({ amount: 60, isDot: true });
    });

    test('is a bleed when a parry-capable player was struck: the attack was not parried', () => {
        const state = stated({ parry: 0.08 });
        const [event] = attributeTick(tickWith(5), state);
        expect(event).toMatchObject({ amount: 60, isDot: true });
    });

    test('is the parry’s counter-hit when the attack did not land on them', () => {
        const state = stated({ parry: 0.08 });
        const [event] = attributeTick(tickWith(4), state);
        expect(event).toMatchObject({ amount: 60, isDot: false, isMiss: false });
    });

    test('is thorns or retaliation when the wearer was struck', () => {
        for (const stat of ['retaliation', 'physicalThorns', 'elementalThorns']) {
            const state = stated({ [stat]: 0.2 });
            const [event] = attributeTick(tickWith(5), state);
            expect(event).toMatchObject({ amount: 60, isDot: false });
        }
    });

    test('is a hit, as it always was, when no `new_battle` stated the stats', () => {
        const state = started({ 0: player(10, { dmgCounter: 4 }) }, { 0: monster(10_000, 5, 0, 3) });
        const [event] = attributeTick(tickWith(5), state);
        expect(event).toMatchObject({ amount: 60, isDot: false });
    });
});
