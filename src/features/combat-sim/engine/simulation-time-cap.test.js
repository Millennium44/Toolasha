import { describe, expect, test } from 'vitest';
import CombatSimulator from './combat-simulator.js';
import AutoAttackEvent from './events/auto-attack-event.js';

/** Run the real event loop with a controlled first attack time. */
function harness(attackTime, converge = false) {
    const sim = new CombatSimulator([], { hrid: '/actions/test', monsterSpawnInfo: {} });
    const attacks = [];
    sim.processCombatStartEvent = () => {
        sim.eventQueue.addEvent(new AutoAttackEvent(attackTime, {}));
    };
    sim.processAutoAttackEvent = (event) => {
        attacks.push(event.time);
        sim.converged = converge;
        sim.eventQueue.addEvent(new AutoAttackEvent(event.time + 100, {}));
    };
    return { sim, attacks };
}

describe('simulation time cap', () => {
    test('does not execute an attack after the requested limit', () => {
        const { sim, attacks } = harness(11);
        const result = sim.simulate(10);

        expect(attacks).toEqual([]);
        expect(result.simulatedTime).toBe(10);
    });

    test('counts an event exactly on the boundary', () => {
        const { sim, attacks } = harness(10);
        const result = sim.simulate(10);

        expect(attacks).toEqual([10]);
        expect(result.simulatedTime).toBe(10);
    });

    test('includes quiet time up to the cap without processing the next event', () => {
        const { sim, attacks } = harness(9);
        const result = sim.simulate(10);

        expect(attacks).toEqual([9]);
        expect(result.simulatedTime).toBe(10);
    });

    test('does not stretch a converged run to the time cap', () => {
        const { sim, attacks } = harness(9, true);
        const result = sim.simulate(100);

        expect(attacks).toEqual([9]);
        expect(result.simulatedTime).toBe(9);
    });
});
