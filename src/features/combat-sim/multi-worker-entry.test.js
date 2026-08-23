/**
 * The all-zones coordinator worker, driven in-process: the module installs a
 * global `onmessage`, spawns `Worker`s for each zone/tier and answers with
 * `postMessage`. Fake both globals and the script is an ordinary function.
 *
 * What matters here is that the sweep always ends: every tier of every zone is
 * run when the main thread keeps saying "go" (slots must not retire while
 * chains can still add work), a zone whose tier failed is written off rather
 * than left dangling, and a child that never answers is given up on.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const harness = vi.hoisted(() => ({
    sent: [],
    workers: [],
    /** How a fake child behaves: 'reply' | 'silent' | 'error' per zone hrid */
    behaviour: {},
}));

class FakeWorker {
    constructor() {
        this.terminated = false;
        harness.workers.push(this);
    }
    postMessage(msg) {
        const mode = harness.behaviour[msg.zoneHrid] || 'reply';
        if (mode === 'silent') return;
        setTimeout(() => {
            if (this.terminated) return;
            if (mode === 'error') {
                this.onmessage?.({ data: { taskId: msg.taskId, type: 'error', error: 'boom' } });
                return;
            }
            this.onmessage?.({ data: { taskId: msg.taskId, type: 'progress', progress: 50 } });
            this.onmessage?.({
                data: {
                    taskId: msg.taskId,
                    type: 'result',
                    simResult: { zone: msg.zoneHrid, tier: msg.difficultyTier },
                },
            });
        }, 5);
    }
    terminate() {
        this.terminated = true;
    }
}

beforeEach(async () => {
    vi.useFakeTimers();
    harness.sent = [];
    harness.workers = [];
    harness.behaviour = {};
    globalThis.Worker = FakeWorker;
    // A worker global has `onmessage` as a property; the module assigns to it bare
    globalThis.onmessage = null;
    globalThis.postMessage = (msg) => harness.sent.push(msg);
    globalThis.URL.createObjectURL = () => 'blob:fake';
    globalThis.URL.revokeObjectURL = () => {};
    vi.resetModules();
    await import('./multi-worker-entry.js');
});

afterEach(() => {
    vi.useRealTimers();
});

/**
 * Drive the coordinator: start, answer every tier result with `decide`, return
 * the final results. `decide: null` answers nothing, standing in for a main
 * thread that went away mid-sweep.
 */
async function sweep(zones, { useEarlyExit, decide = () => false, maxWorkers = 4, ticks = 400, step = 5 } = {}) {
    globalThis.onmessage({
        data: {
            type: 'start_all_zones',
            workerScript: '',
            gameData: {},
            playerDTOs: [],
            zones,
            simulationTimeLimit: 1,
            extraBuffs: {},
            maxWorkers,
            useEarlyExit,
        },
    });
    let answered = 0;
    for (let i = 0; i < ticks; i++) {
        await vi.advanceTimersByTimeAsync(step);
        // Answer tier results the way the main thread would
        while (answered < harness.sent.length) {
            const msg = harness.sent[answered++];
            if (msg.type === 'zone_tier_result' && decide !== null) {
                globalThis.onmessage({
                    data: { type: 'zone_tier_decision', zoneHrid: msg.zoneHrid, skip: decide(msg) },
                });
            }
        }
        const done = harness.sent.find((m) => m.type === 'all_zones_result' || m.type === 'error');
        if (done) return done;
    }
    return null;
}

const tiers = (hrid, count) => Array.from({ length: count }, (_, tier) => ({ zoneHrid: hrid, difficultyTier: tier }));

describe('the all-zones coordinator', () => {
    test('with early exit and "go" every time, every tier of every zone is simulated and the sweep ends', async () => {
        // Six zones, six tiers each, four slots: only six T0 tasks are seeded, so
        // slots used to retire while the chains were still waiting on go/skip
        const zones = [
            ...tiers('a', 6),
            ...tiers('b', 6),
            ...tiers('c', 6),
            ...tiers('d', 6),
            ...tiers('e', 6),
            ...tiers('f', 6),
        ];
        const done = await sweep(zones, { useEarlyExit: true });
        expect(done?.type).toBe('all_zones_result');
        expect(done.results).toHaveLength(36);
        expect(done.results.every((r) => r && typeof r.tier === 'number')).toBe(true);
        // 36 sims ran, not just the six seeded ones
        expect(harness.workers.length).toBe(36);
        const last = [...harness.sent].reverse().find((m) => m.type === 'progress');
        expect(last.progress).toBe(100);
    });

    test('"skip" writes the zone\'s higher tiers off as null and the bar still reaches 100', async () => {
        const zones = [...tiers('a', 4), ...tiers('b', 2)];
        const done = await sweep(zones, { useEarlyExit: true, decide: (m) => m.zoneHrid === 'a' });
        expect(done?.type).toBe('all_zones_result');
        // a: T0 ran, T1–T3 skipped; b: both tiers ran
        expect(done.results.slice(0, 4).map((r) => (r ? r.tier : null))).toEqual([0, null, null, null]);
        expect(done.results.slice(4).map((r) => r.tier)).toEqual([0, 1]);
        const last = [...harness.sent].reverse().find((m) => m.type === 'progress');
        expect(last.progress).toBe(100);
    });

    test('a tier that fails ends its zone under early exit instead of leaving later tiers undefined', async () => {
        harness.behaviour.a = 'error';
        const zones = [...tiers('a', 3), ...tiers('b', 1)];
        const done = await sweep(zones, { useEarlyExit: true });
        expect(done?.type).toBe('all_zones_result');
        expect(done.results.slice(0, 3)).toEqual([null, null, null]);
        expect(done.results[3].tier).toBe(0);
        const last = [...harness.sent].reverse().find((m) => m.type === 'progress');
        expect(last.progress).toBe(100);
    });

    test('a child that never answers is given up on after the stall window and the sweep still completes', async () => {
        harness.behaviour.a = 'silent';
        const zones = [...tiers('a', 1), ...tiers('b', 1)];
        const done = await sweep(zones, { useEarlyExit: false, ticks: 30_000 });
        expect(done?.type).toBe('all_zones_result');
        expect(done.results[0]).toBeNull();
        expect(done.results[1].tier).toBe(0);
        const silent = harness.workers.find((w) => w.terminated && harness.behaviour.a === 'silent');
        expect(silent).toBeTruthy();
    });

    test('a tier decision that never comes back does not wedge the sweep', async () => {
        // With a worker pool, one chain still waiting on go/skip keeps
        // `inFlight` above zero, so an unanswered decision used to mean the
        // sweep never finished and the panel span for ever
        const zones = [...tiers('a', 2), ...tiers('b', 2)];

        const done = await sweep(zones, { useEarlyExit: true, decide: null, ticks: 400, step: 1000 });

        expect(done?.type).toBe('all_zones_result');
        // Treated as "go": every tier ran, none was written off as skipped
        expect(done.results.map((r) => r?.tier)).toEqual([0, 1, 0, 1]);
    });

    test('without early exit every zone runs exactly once', async () => {
        const zones = [...tiers('a', 3), ...tiers('b', 3)];
        const done = await sweep(zones, { useEarlyExit: false });
        expect(done?.type).toBe('all_zones_result');
        expect(harness.workers.length).toBe(6);
        expect(done.results.map((r) => r.tier)).toEqual([0, 1, 2, 0, 1, 2]);
    });
});
