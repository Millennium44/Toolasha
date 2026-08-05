/**
 * An ability effect the engine has never seen, and what the run does about it.
 *
 * The failure this replaces is specific: one game update adds one effect type,
 * a monster somewhere uses it, and the thrown error takes down a simulation
 * that was otherwise ninety-nine percent understood. The abilities around it
 * still resolve, the fight still finishes, and the result says which mechanic
 * went unmodelled.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import CombatSimulator from './combat-simulator.js';
import EventQueue from './events/event-queue.js';
import SimResult from './sim-result.js';
import { getSimWarnings, resetSimWarnings, resetWarnedTypes } from './sim-warnings.js';

/** Enough simulator to run tryUseAbility, with no game data behind it */
function harness() {
    const sim = Object.create(CombatSimulator.prototype);
    sim.eventQueue = new EventQueue();
    sim.simulationTime = 0;
    sim.simResult = new SimResult({ hrid: '/actions/test', difficultyTier: 0 }, 1);
    sim.addNextAttackEvent = vi.fn();
    sim.checkEncounterEnd = vi.fn();

    const source = {
        hrid: 'player1',
        isPlayer: true,
        abilityManaCosts: new Map(),
        abilities: [],
        combatDetails: {
            currentHitpoints: 100,
            currentManapoints: 100,
            combatStats: { abilityHaste: 0, blaze: 0, bloom: 0, ripple: 0 },
        },
        addBuff: vi.fn(),
    };

    sim.players = [source];
    sim.enemies = [];
    return { sim, source };
}

function ability(effectType) {
    return {
        hrid: '/abilities/tomorrows_ability',
        manaCost: 0,
        cooldownDuration: 1e9,
        lastUsed: 0,
        abilityEffects: [{ effectType }],
    };
}

describe('an unknown ability effect', () => {
    beforeEach(() => {
        resetSimWarnings();
        resetWarnedTypes();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('does not stop the ability, or the fight', () => {
        const { sim, source } = harness();

        expect(() => sim.tryUseAbility(source, ability('/ability_effect_types/tesseract'))).not.toThrow();
        expect(sim.addNextAttackEvent).toHaveBeenCalledWith(source);
        expect(sim.checkEncounterEnd).toHaveBeenCalled();
    });

    test('and the result carries the warning', () => {
        const { sim, source } = harness();

        sim.tryUseAbility(source, ability('/ability_effect_types/tesseract'));
        sim._collectWarnings();

        expect(sim.simResult.warnings).toHaveLength(1);
        expect(sim.simResult.warnings[0]).toContain('tesseract');
        expect(sim.simResult.warnings[0]).toContain('understate');
        // The ability that used it is named, so the warning points somewhere
        expect(sim.simResult.warnings[0]).toContain('/abilities/tomorrows_ability');
    });

    test('known effects alongside it still resolve', () => {
        const { sim, source } = harness();
        const mixed = ability('/ability_effect_types/tesseract');
        mixed.abilityEffects.push({
            effectType: '/ability_effect_types/buff',
            targetType: 'self',
            buffs: [{ duration: 1e9 }],
        });

        sim.tryUseAbility(source, mixed);

        expect(source.addBuff).toHaveBeenCalledTimes(1);
        expect(getSimWarnings()).toHaveLength(1);
    });

    test('a result with nothing unknown carries no warnings', () => {
        const { sim, source } = harness();
        const known = ability('/ability_effect_types/buff');
        known.abilityEffects[0].targetType = 'self';
        known.abilityEffects[0].buffs = [];

        sim.tryUseAbility(source, known);
        sim._collectWarnings();

        expect(sim.simResult.warnings).toEqual([]);
    });
});

describe('unsupported target types', () => {
    beforeEach(() => {
        resetSimWarnings();
        resetWarnedTypes();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('a buff aimed somewhere the engine cannot aim is skipped, not thrown', () => {
        const { sim, source } = harness();

        expect(() =>
            sim.processAbilityBuffEffect(
                source,
                { hrid: '/abilities/x' },
                { targetType: 'nearestSpectator', buffs: [] }
            )
        ).not.toThrow();
        expect(source.addBuff).not.toHaveBeenCalled();
        expect(getSimWarnings()).toEqual([expect.stringContaining('nearestSpectator')]);
    });

    test('a revive on an unsupported combat style leaves the respawn event alone', () => {
        const { sim, source } = harness();
        sim.eventQueue.clearByTypeAndHrid = vi.fn();

        sim.processAbilityReviveEffect(
            source,
            { hrid: '/abilities/x' },
            { targetType: 'deadAlly', combatStyleHrid: '/combat_styles/necromancy' }
        );

        // Bailing out after the clear would strand the corpse with nothing
        // scheduled to bring it back
        expect(sim.eventQueue.clearByTypeAndHrid).not.toHaveBeenCalled();
        expect(getSimWarnings()).toEqual([expect.stringContaining('necromancy')]);
    });
});
