import { afterEach, describe, expect, test } from 'vitest';
import CombatSimulator from './combat-simulator.js';
import { runTracedSimulation } from './combat-trace.js';
import AutoAttackEvent from './events/auto-attack-event.js';
import { clearSimRng, random, seedSimRng } from './rng.js';

/** A real event loop and result, with a controlled random-damage attack. */
function harness() {
    const source = { hrid: '/monsters/twin', combatDetails: { currentHitpoints: 100, currentManapoints: 20 } };
    const target = { hrid: '/monsters/twin', combatDetails: { currentHitpoints: 100, currentManapoints: 20 } };
    const sim = new CombatSimulator([], { hrid: '/actions/test', monsterSpawnInfo: {} });
    sim.enemies = [source, target];
    sim.checkTriggers = () => {};
    sim.processCombatStartEvent = () => sim.eventQueue.addEvent(new AutoAttackEvent(1, source));
    sim.processAutoAttackEvent = (event) => {
        const damage = Math.floor(random() * 5) + 1;
        target.combatDetails.currentHitpoints -= damage;
        target.isStunned = true;
        sim.simResult.addAttack(source, target, 'autoAttack', damage);
        sim.eventQueue.addEvent(new AutoAttackEvent(event.time + 1, source));
    };
    return { sim, source, target };
}

afterEach(clearSimRng);

describe('bounded combat trace', () => {
    test('records state, attacks, and pending events without retaining unit objects', () => {
        const { sim, source, target } = harness();
        seedSimRng(42);
        const result = runTracedSimulation(sim, 2, null, { seed: 42 });
        const trace = result.combatTrace;
        const row = trace.events[1];

        expect(trace.seed).toBe(42);
        expect(trace.events.map((event) => event.time)).toEqual([0, 1, 2]);
        expect(row.attacks).toHaveLength(1);
        expect(row.attacks[0].source.id).not.toBe(row.attacks[0].target.id);
        expect(row.before[1].hp).toBe(100);
        expect(row.after[1].hp).toBe(100 - row.attacks[0].hit);
        expect(row.after[1].stunned).toBe(true);
        expect(row.queued[0].time).toBe(2);
        expect(structuredClone(trace)).toEqual(trace);
        source.hrid = 'changed';
        target.combatDetails.currentHitpoints = 0;
        expect(row.attacks[0].source.hrid).toBe('/monsters/twin');
        expect(row.after[1].hp).toBeGreaterThan(0);
    });

    test('does not change results or consume RNG draws', () => {
        const plain = harness();
        seedSimRng(17);
        const baseline = plain.sim.simulate(10);
        const nextPlainDraw = random();
        const traced = harness();
        seedSimRng(17);
        const { combatTrace, ...result } = runTracedSimulation(traced.sim, 10, null, { seed: 17 });

        expect(result).toEqual({ ...baseline });
        expect(random()).toBe(nextPlainDraw);
        expect(combatTrace.truncated).toBe(false);
    });

    test('stops capturing at the limit but lets the simulation finish', () => {
        const { sim } = harness();
        const result = runTracedSimulation(sim, 10, null, { maxEvents: 2 });

        expect(result.simulatedTime).toBe(10);
        expect(result.combatTrace.events).toHaveLength(2);
        expect(result.combatTrace.truncated).toBe(true);
        expect(
            Object.values(result.attacks['/monsters/twin']['/monsters/twin'].autoAttack).reduce(
                (sum, count) => sum + count,
                0
            )
        ).toBe(10);
    });

    test('clamps capture size and distinguishes exact capacity from truncation', () => {
        const { sim } = harness();
        expect(runTracedSimulation(sim, 0, null, { maxEvents: Infinity }).combatTrace.maxEvents).toBe(200);
        expect(runTracedSimulation(sim, 0, null, { maxEvents: 1e9 }).combatTrace.maxEvents).toBe(2000);
        const trace = runTracedSimulation(sim, 1, null, { maxEvents: 2 }).combatTrace;
        expect(trace.events).toHaveLength(2);
        expect(trace.truncated).toBe(false);
    });

    test('restores inherited methods after success and failure', () => {
        const { sim } = harness();
        const original = sim.processEvent;
        runTracedSimulation(sim, 1, null);
        expect(sim.processEvent).toBe(original);
        expect(Object.hasOwn(sim, 'processEvent')).toBe(false);
        expect(Object.hasOwn(sim.simResult, 'addAttack')).toBe(false);

        sim.processAutoAttackEvent = () => {
            throw new Error('test failure');
        };
        expect(() => runTracedSimulation(sim, 1, null)).toThrow('test failure');
        expect(sim.processEvent).toBe(original);
        expect(Object.hasOwn(sim, 'processEvent')).toBe(false);
        expect(Object.hasOwn(sim.simResult, 'addAttack')).toBe(false);
    });

    test('limits per-event attack and queue capture without dropping actual attacks', () => {
        const { sim, source, target } = harness();
        sim.processAutoAttackEvent = () => {
            for (let i = 0; i < 250; i++) {
                sim.simResult.addAttack(source, target, 'autoAttack', 1);
                sim.eventQueue.addEvent(new AutoAttackEvent(2 + i, source));
            }
        };
        const result = runTracedSimulation(sim, 1, null);
        const row = result.combatTrace.events[1];
        expect(row.attacks).toHaveLength(200);
        expect(row.attacksTruncated).toBe(true);
        expect(row.queued).toHaveLength(200);
        expect(row.queueTruncated).toBe(true);
        expect(result.totalDamageDealt[source.hrid]).toBe(250);
        expect(sim.eventQueue.minHeap.size).toBe(250);
    });

    test('repeats the trace for the same seed and restores an instance event handler', () => {
        const run = () => {
            const { sim } = harness();
            const ownHandler = sim.processEvent.bind(sim);
            sim.processEvent = ownHandler;
            seedSimRng(42);
            const result = runTracedSimulation(sim, 3, null, { seed: 42 });
            expect(sim.processEvent).toBe(ownHandler);
            return result.combatTrace;
        };
        expect(run()).toEqual(run());
    });
});
