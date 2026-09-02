// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
/**
 * A self-targeted special ability whose buff carries skill scaling must apply
 * that scaling, exactly as the allAllies branch does. Both branches route the
 * buff through scaledBuff() so an ordinary buff is added unchanged and a scaling
 * buff is scaled identically no matter which branch delivers it.
 */

import { describe, test, expect, vi } from 'vitest';

import CombatSimulator from './combat-simulator.js';

/** A minimal `this` for the branches under test: simulationTime, the event queue,
 *  and the real scaledBuff helper the branches delegate to. */
function fakeSim() {
    return {
        simulationTime: 0,
        eventQueue: { addEvent: vi.fn() },
        scaledBuff: CombatSimulator.prototype.scaledBuff,
    };
}

/** A caster stub: staminaLevel feeds the multiplier; addBuff records the buff. */
function caster() {
    return { isPlayer: true, combatDetails: { staminaLevel: 10, currentHitpoints: 100 }, addBuff: vi.fn() };
}

describe('a self-targeted special ability buff', () => {
    test('gets its skill multiplier applied to a scaling buff', () => {
        const source = caster();
        const ability = { isSpecialAbility: true, hrid: '/abilities/test' };
        const buff = {
            uniqueHrid: '/buffs/test',
            flatBoost: 5,
            ratioBoost: 0.2,
            duration: 1000,
            multiplierForSkillHrid: '/skills/stamina',
            multiplierPerSkillLevel: 0.1,
        };
        const abilityEffect = { targetType: 'self', buffs: [buff] };

        CombatSimulator.prototype.processAbilityBuffEffect.call(fakeSim(), source, ability, abilityEffect);

        // multiplier = 1 + 10 * 0.1 = 2.0; the pre-fix self branch added `buff`
        // untouched, so flatBoost would be 5 and ratioBoost 0.2 (this fails pre-fix).
        expect(source.addBuff).toHaveBeenCalledTimes(1);
        const applied = source.addBuff.mock.calls[0][0];
        expect(applied.flatBoost).toBe(10);
        expect(applied.ratioBoost).toBeCloseTo(0.4, 10);
        // A scaled clone, never a mutation of the shared definition.
        expect(applied).not.toBe(buff);
        expect(buff.flatBoost).toBe(5);
    });

    test('matches the allAllies branch for the same scaling buff', () => {
        const buff = {
            uniqueHrid: '/buffs/test',
            flatBoost: 5,
            ratioBoost: 0.2,
            duration: 1000,
            multiplierForSkillHrid: '/skills/stamina',
            multiplierPerSkillLevel: 0.1,
        };
        const ability = { isSpecialAbility: true, hrid: '/abilities/test' };

        const selfSource = caster();
        CombatSimulator.prototype.processAbilityBuffEffect.call(fakeSim(), selfSource, ability, {
            targetType: 'self',
            buffs: [buff],
        });

        const allySource = caster();
        const allyThis = fakeSim();
        allyThis.players = [allySource];
        CombatSimulator.prototype.processAbilityBuffEffect.call(allyThis, allySource, ability, {
            targetType: 'allAllies',
            buffs: [buff],
        });

        const selfBuff = selfSource.addBuff.mock.calls[0][0];
        const allyBuff = allySource.addBuff.mock.calls[0][0];
        expect(selfBuff.flatBoost).toBe(allyBuff.flatBoost);
        expect(selfBuff.ratioBoost).toBe(allyBuff.ratioBoost);
    });

    test('leaves an ordinary self-buff untouched: the same object is added', () => {
        const source = caster();
        const ability = { isSpecialAbility: true, hrid: '/abilities/test' };
        // No multiplierForSkillHrid, so no scaling applies.
        const buff = { uniqueHrid: '/buffs/plain', flatBoost: 5, ratioBoost: 0.2, duration: 1000 };
        const abilityEffect = { targetType: 'self', buffs: [buff] };

        CombatSimulator.prototype.processAbilityBuffEffect.call(fakeSim(), source, ability, abilityEffect);

        expect(source.addBuff).toHaveBeenCalledTimes(1);
        // Byte-identical behaviour: the exact same object, not a clone.
        expect(source.addBuff.mock.calls[0][0]).toBe(buff);
    });

    test('leaves a non-special ability self-buff untouched even with a skill field', () => {
        const source = caster();
        const ability = { isSpecialAbility: false, hrid: '/abilities/normal' };
        const buff = {
            uniqueHrid: '/buffs/test',
            flatBoost: 5,
            ratioBoost: 0.2,
            duration: 1000,
            multiplierForSkillHrid: '/skills/stamina',
            multiplierPerSkillLevel: 0.1,
        };
        const abilityEffect = { targetType: 'self', buffs: [buff] };

        CombatSimulator.prototype.processAbilityBuffEffect.call(fakeSim(), source, ability, abilityEffect);

        expect(source.addBuff.mock.calls[0][0]).toBe(buff);
    });
});
