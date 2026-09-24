const DEFAULT_MAX_EVENTS = 200;
const HARD_MAX_EVENTS = 2000;
const MAX_QUEUE_ENTRIES = 200;
const MAX_ATTACKS_PER_EVENT = 200;

/**
 * Run an opt-in diagnostic without changing RNG or combat event ordering.
 * The caller seeds the engine normally; seed here is replay metadata only.
 * Capture stops at maxEvents, but the simulation continues to completion.
 * @param {Object} simulator - CombatSimulator instance
 * @param {number} timeLimit - Simulation limit in nanoseconds
 * @param {Object|null} stopRule - Normal simulation stopping rule
 * @param {Object} [options] - Seed metadata and maxEvents (1–2000)
 * @returns {Object} Normal result with a structured-clone-safe combatTrace
 */
export function runTracedSimulation(simulator, timeLimit, stopRule, options = {}) {
    const requested = options.maxEvents;
    const maxEvents = Number.isFinite(requested)
        ? Math.max(1, Math.min(HARD_MAX_EVENTS, Math.floor(requested)))
        : DEFAULT_MAX_EVENTS;
    const trace = {
        version: 1,
        timeUnit: 'nanoseconds',
        seed: Number.isFinite(options.seed) || typeof options.seed === 'string' ? options.seed : null,
        maxEvents,
        truncated: false,
        events: [],
    };
    const ids = new WeakMap();
    let nextId = 1;
    const identify = (unit) => {
        if (!unit || typeof unit !== 'object') return null;
        if (!ids.has(unit)) ids.set(unit, nextId++);
        return { id: ids.get(unit), hrid: unit.hrid ?? null };
    };
    const snapshot = (unit) => ({
        ...identify(unit),
        hp: unit.combatDetails?.currentHitpoints ?? null,
        mp: unit.combatDetails?.currentManapoints ?? null,
        stunned: !!unit.isStunned,
        blinded: !!unit.isBlinded,
        silenced: !!unit.isSilenced,
        outOfMana: !!unit.isOutOfMana,
    });
    const describeEvent = (event) => ({
        type: event.type,
        time: event.time,
        source: identify(event.source ?? event.sourceRef),
        target: identify(event.target),
        ability: event.ability?.hrid ?? null,
        consumable: event.consumable?.hrid ?? null,
        hrid: event.hrid ?? null,
    });
    const descriptor = Object.getOwnPropertyDescriptor(simulator, 'processEvent');
    const originalProcess = simulator.processEvent;
    simulator.processEvent = function (event) {
        if (trace.events.length >= maxEvents) {
            trace.truncated = true;
            return originalProcess.call(this, event);
        }
        const units = new Set(
            [...(this.players || []), ...(this.enemies || []), event.source, event.sourceRef, event.target].filter(
                (unit) => unit && typeof unit === 'object'
            )
        );
        const row = { ...describeEvent(event), before: [...units].map(snapshot), attacks: [], attacksTruncated: false };
        trace.events.push(row);
        // simulate() resets SimResult before its first event. Wrap this run's
        // result only, and restore it even when processing throws.
        const result = this.simResult;
        const attackDescriptor = Object.getOwnPropertyDescriptor(result, 'addAttack');
        const originalAttack = result.addAttack;
        result.addAttack = function (source, target, ability, hit, isCrit = false) {
            if (row.attacks.length < MAX_ATTACKS_PER_EVENT) {
                row.attacks.push({ source: identify(source), target: identify(target), ability, hit, isCrit });
            } else {
                row.attacksTruncated = true;
            }
            return originalAttack.call(this, source, target, ability, hit, isCrit);
        };
        try {
            return originalProcess.call(this, event);
        } finally {
            if (attackDescriptor) Object.defineProperty(result, 'addAttack', attackDescriptor);
            else delete result.addAttack;
            for (const unit of [...(this.players || []), ...(this.enemies || [])]) {
                if (unit) units.add(unit);
            }
            row.after = [...units].map(snapshot);
            // The heap array is NOT chronological. Sort a copy, never the queue.
            const queued = this.eventQueue.minHeap.data;
            row.queueTruncated = queued.length > MAX_QUEUE_ENTRIES;
            row.queued = queued
                .map((queuedEvent, index) => ({ event: queuedEvent, index }))
                .sort((a, b) => a.event.time - b.event.time || a.index - b.index)
                .slice(0, MAX_QUEUE_ENTRIES)
                .map(({ event: queuedEvent }) => describeEvent(queuedEvent));
        }
    };
    try {
        const result = simulator.simulate(timeLimit, stopRule);
        result.combatTrace = trace;
        return result;
    } finally {
        if (descriptor) Object.defineProperty(simulator, 'processEvent', descriptor);
        else delete simulator.processEvent;
    }
}
