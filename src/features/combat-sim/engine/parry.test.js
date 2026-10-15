import { afterEach, describe, expect, test } from 'vitest';
import CombatSimulator from './combat-simulator.js';
import { seedSimRng, clearSimRng } from './rng.js';

const unit = (parry, hp = 100) => ({ combatDetails: { currentHitpoints: hp, combatStats: { parry } } });
const check = (targets) => CombatSimulator.prototype.checkParry.call({}, targets);
const parryRate = (targets, trials = 40000) => {
    let hits = 0;
    for (let i = 0; i < trials; i++) {
        if (check(targets)) hits++;
    }
    return hits / trials;
};

describe('CombatSimulator.checkParry stacking', () => {
    afterEach(() => clearSimRng());

    test('two holders stack: 1 - 0.92^2', () => {
        seedSimRng(12345);
        expect(Math.abs(parryRate([unit(0.08), unit(0.08)]) - (1 - 0.92 ** 2))).toBeLessThan(0.01);
    });

    test('a single holder parries at its own rate', () => {
        seedSimRng(777);
        expect(Math.abs(parryRate([unit(0.08)]) - 0.08)).toBeLessThan(0.01);
    });

    test('a holder with a non-holder still parries at 8%', () => {
        seedSimRng(99);
        expect(Math.abs(parryRate([unit(0.08), unit(0)]) - 0.08)).toBeLessThan(0.01);
    });

    test('a downed unit does not roll', () => {
        seedSimRng(5);
        expect(parryRate([unit(0.08), unit(0.5, 0)])).toBeLessThan(0.1);
        expect(check([unit(1, 0)])).toBeUndefined();
    });

    test('the returned unit is the one that parried', () => {
        const a = unit(1);
        expect(check([a, unit(0)])).toBe(a);
    });
});
