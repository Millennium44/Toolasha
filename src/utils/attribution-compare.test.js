import { describe, it, expect } from 'vitest';
import { compareRecording, newPresenceState, presenceNewBattle, presenceTick } from './attribution-compare.js';

/**
 * A three-player party against one monster, stated the way `new_battle` states
 * it: names, opening health and mana, counters at zero.
 */
function newBattle() {
    return {
        type: 'new_battle',
        payload: {
            players: [
                { name: 'Archer', currentHitpoints: 1000, currentManapoints: 500 },
                { name: 'Mage', currentHitpoints: 900, currentManapoints: 800 },
                { name: 'Tank', currentHitpoints: 1500, currentManapoints: 300 },
            ],
            monsters: [{ name: 'Rat', currentHitpoints: 10000, combatDetails: { dmgCounter: 0, critCounter: 0 } }],
        },
    };
}

/** @param {Object} pMap - This tick's players @param {Object} mMap - This tick's monsters */
function tick(pMap, mMap) {
    return { type: 'battle_updated', payload: { pMap, mMap } };
}

/**
 * A full-state opening tick, as recordings begin with.
 *
 * Both engines and the referee learn counter baselines from sightings, so a
 * swing on a player's very first appearance is invisible to all of them. Real
 * feeds state everyone within the first tick; this is that tick.
 */
function warmup() {
    return tick(
        {
            0: { cHP: 1000, cMP: 500, atkCounter: 0 },
            1: { cHP: 900, cMP: 800, atkCounter: 0 },
            2: { cHP: 1500, cMP: 300, atkCounter: 0 },
        },
        {}
    );
}

describe('presenceTick', () => {
    it('credits the lone present player with every monster health fall', () => {
        const state = newPresenceState();
        presenceNewBattle(state, newBattle().payload);

        const result = presenceTick({ pMap: { 1: { cHP: 900, cMP: 800 } }, mMap: { 0: { cHP: 9600 } } }, state);
        expect(result).toEqual({ damage: 400, credited: { 1: 400 }, mode: 'solo' });
    });

    it('picks the unique mana-spender out of a crowd', () => {
        const state = newPresenceState();
        presenceNewBattle(state, newBattle().payload);

        const result = presenceTick(
            { pMap: { 0: { cHP: 1000, cMP: 500 }, 1: { cHP: 900, cMP: 700 } }, mMap: { 0: { cHP: 9700 } } },
            state
        );
        expect(result.mode).toBe('cast');
        expect(result.credited).toEqual({ 1: 300 });
    });

    it('splits equally when nobody or everybody spent mana', () => {
        const state = newPresenceState();
        presenceNewBattle(state, newBattle().payload);

        const result = presenceTick(
            { pMap: { 0: { cHP: 1000, cMP: 500 }, 1: { cHP: 900, cMP: 800 } }, mMap: { 0: { cHP: 9800 } } },
            state
        );
        expect(result.mode).toBe('split');
        expect(result.credited).toEqual({ 0: 100, 1: 100 });
    });

    it('counts nothing before a battle has been stated', () => {
        const state = newPresenceState();
        const result = presenceTick({ pMap: { 0: {} }, mMap: { 0: { cHP: 5 } } }, state);
        expect(result.damage).toBe(0);
    });
});

describe('compareRecording', () => {
    it('agrees when the present player provably swung', () => {
        const report = compareRecording([
            newBattle(),
            warmup(),
            tick({ 0: { cHP: 1000, cMP: 500, atkCounter: 1 } }, { 0: { cHP: 9900, dmgCounter: 1 } }),
        ]);

        expect(report.damageTicks).toBe(1);
        expect(report.classes.agree).toEqual({ ticks: 1, damage: 100 });
        expect(report.players['0']).toEqual({ name: 'Archer', ours: 100, presence: 100 });
        expect(report.grouping).toMatchObject({ hitTicks: 1, swungNow: 1 });
    });

    it('agrees with presence on the reflect tick, which the hybrid rung adopted', () => {
        const report = compareRecording([
            newBattle(),
            warmup(),
            // The archer swings and lands
            tick({ 0: { cHP: 1000, cMP: 500, atkCounter: 1 } }, { 0: { cHP: 9900, dmgCounter: 1 } }),
            // Four ticks later the tank — alone in the payload, being hit —
            // coincides with a hit landing on the monster: thorns. Both engines
            // credit the tank now; the referee still records the tick's shape.
            tick({ 1: { cHP: 900, cMP: 800 } }, { 0: { cHP: 9900, dmgCounter: 1 } }),
            tick({ 1: { cHP: 900, cMP: 800 } }, { 0: { cHP: 9900, dmgCounter: 1 } }),
            tick({ 1: { cHP: 900, cMP: 800 } }, { 0: { cHP: 9900, dmgCounter: 1 } }),
            tick({ 2: { cHP: 1400, cMP: 300, dmgCounter: 1 } }, { 0: { cHP: 9750, dmgCounter: 2 } }),
        ]);

        expect(report.classes.agree).toEqual({ ticks: 2, damage: 250 });
        expect(report.players['0'].ours).toBe(100);
        expect(report.players['2'].ours).toBe(150);
        expect(report.players['2'].presence).toBe(150);
        expect(report.grouping.victimOnly).toBe(1);
    });

    it('scores a presence split against a counter-confirmed single swinger', () => {
        const report = compareRecording([
            newBattle(),
            warmup(),
            tick(
                { 0: { cHP: 1000, cMP: 500, atkCounter: 1 }, 1: { cHP: 900, cMP: 800 } },
                { 0: { cHP: 9800, dmgCounter: 1 } }
            ),
        ]);

        expect(report.classes['split-vs-single']).toEqual({ ticks: 1, damage: 200 });
        expect(report.adjudication.oursConfirmed).toEqual({ ticks: 1, damage: 200 });
        expect(report.players['0'].ours).toBe(200);
        expect(report.players['0'].presence).toBe(100);
        expect(report.players['1'].presence).toBe(100);
    });

    it('sets bleed ticks apart instead of scoring them for either side', () => {
        const report = compareRecording([
            newBattle(),
            // Health falls with no counter movement: ours refuses, presence credits
            tick({ 1: { cHP: 900, cMP: 800 } }, { 0: { cHP: 9950, dmgCounter: 0 } }),
        ]);

        expect(report.classes.bleed).toEqual({ ticks: 1, damage: 50 });
        expect(report.adjudication.bleed).toEqual({ ticks: 1, damage: 50 });
        expect(report.players['1'].presence).toBe(50);
        expect(report.players['1'].ours).toBe(0);
    });

    it('reports the tick ours cannot attribute at all', () => {
        const report = compareRecording([
            newBattle(),
            warmup(),
            // Two players present, a hit lands, nobody swung, nobody alone,
            // no mana moved: ours refuses; presence splits it evenly
            tick({ 0: { cHP: 1000, cMP: 500 }, 1: { cHP: 900, cMP: 800 } }, { 0: { cHP: 9900, dmgCounter: 1 } }),
        ]);

        expect(report.classes['ours-orphan']).toEqual({ ticks: 1, damage: 100 });
        expect(report.totals.oursUncredited).toBe(100);
        expect(report.totals.presenceUncredited).toBe(0);
    });

    it('accepts a swing one tick before its damage as confirmation', () => {
        const report = compareRecording([
            newBattle(),
            warmup(),
            // The mage swings — no damage lands yet
            tick({ 1: { cHP: 900, cMP: 800, atkCounter: 1 } }, {}),
            // The damage arrives one tick later with only the mage present
            tick({ 1: { cHP: 900, cMP: 800 } }, { 0: { cHP: 9700, dmgCounter: 1 } }),
        ]);

        expect(report.classes.agree).toEqual({ ticks: 1, damage: 300 });
        expect(report.grouping.recentSwing).toBe(1);
    });

    it('re-baselines every side at a new battle', () => {
        const report = compareRecording([
            newBattle(),
            warmup(),
            tick({ 0: { cHP: 1000, cMP: 500, atkCounter: 1 } }, { 0: { cHP: 9900, dmgCounter: 1 } }),
            newBattle(),
            // Fresh wave: the monster is back to 10,000 and nothing reads the
            // reset as a heal or a phantom hit. The player's counter carries
            // across the boundary, as the game's does
            tick({ 0: { cHP: 1000, cMP: 500, atkCounter: 2 } }, { 0: { cHP: 9500, dmgCounter: 1 } }),
        ]);

        expect(report.battles).toBe(2);
        expect(report.monsterHpLost).toBe(600);
        expect(report.players['0'].ours).toBe(600);
        expect(report.players['0'].presence).toBe(600);
    });

    it('counts a miss without inventing damage on either side', () => {
        const report = compareRecording([
            newBattle(),
            warmup(),
            // The counter rises, the health does not move: a miss
            tick({ 0: { cHP: 1000, cMP: 500, atkCounter: 1 } }, { 0: { cHP: 10000, dmgCounter: 1 } }),
        ]);

        expect(report.damageTicks).toBe(0);
        expect(report.missOnlyTicks).toBe(1);
        expect(report.totals.ours).toBe(0);
        expect(report.totals.presence).toBe(0);
    });
});
