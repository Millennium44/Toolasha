/**
 * The all-zones runner's lifecycle: every way a run ends must free the blob URL
 * the coordinator worker was built from, cancellation included.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./multi-worker-entry.js?worker', () => ({ default: '// coordinator' }));
vi.mock('./combat-sim-worker.js?worker', () => ({ default: '// sim' }));
// Revenue keyed off the requested player, read from a test-only `__profit` map on
// the sim result, so a test can prove the early-exit decision reads the right one.
const revenueCalls = vi.hoisted(() => []);
vi.mock('./combat-sim-adapter.js', () => ({
    seedSimPriceCache: (cache) => cache,

    calculateSimRevenue: (simResult, _gameData, playerHrid, _hours, options) => {
        revenueCalls.push(options);
        return { netPerHour: simResult?.__profit?.[playerHrid] ?? 0 };
    },
}));

const { runAllZonesSimulation, cancelAllZonesSimulation } = await import('./all-zones-runner.js');

const urls = { created: [], revoked: [] };
let workers = [];

class FakeWorker {
    constructor() {
        this.terminated = false;
        workers.push(this);
    }
    postMessage() {}
    terminate() {
        this.terminated = true;
    }
}

beforeEach(() => {
    urls.created = [];
    urls.revoked = [];
    workers = [];
    globalThis.Worker = FakeWorker;
    globalThis.Blob = class {};
    let next = 0;
    globalThis.URL.createObjectURL = () => {
        const url = `blob:fake-${next++}`;
        urls.created.push(url);
        return url;
    };
    globalThis.URL.revokeObjectURL = (url) => urls.revoked.push(url);
});

afterEach(() => {
    delete globalThis.Worker;
});

describe('cancelAllZonesSimulation', () => {
    test('terminates the coordinator, rejects the run and revokes its blob URL', async () => {
        const run = runAllZonesSimulation({
            gameData: {},
            playerDTOs: [],
            zones: [{ zoneHrid: '/actions/combat/a', difficultyTier: 0 }],
            hours: 1,
        });
        expect(urls.created).toHaveLength(1);
        expect(urls.revoked).toEqual([]);

        cancelAllZonesSimulation();

        await expect(run).rejects.toThrow('Cancelled');
        expect(workers[0].terminated).toBe(true);
        expect(urls.revoked).toEqual(urls.created);
    });

    test('a second cancel with nothing running revokes nothing again', async () => {
        const run = runAllZonesSimulation({
            gameData: {},
            playerDTOs: [],
            zones: [{ zoneHrid: '/actions/combat/a', difficultyTier: 0 }],
            hours: 1,
        });
        cancelAllZonesSimulation();
        await expect(run).rejects.toThrow('Cancelled');

        cancelAllZonesSimulation();

        expect(urls.revoked).toHaveLength(1);
    });
});

describe('early-exit decision keys on the reported player', () => {
    // decideSkip runs inside the coordinator's onmessage handler and answers each
    // zone_tier_result synchronously. Drive that handler directly and capture the
    // zone_tier_decision it posts back.
    const driveTierResults = (playerHrid, tiers) => {
        const run = runAllZonesSimulation({
            gameData: {},
            playerDTOs: [],
            zones: [
                { zoneHrid: '/actions/combat/a', difficultyTier: 0 },
                { zoneHrid: '/actions/combat/a', difficultyTier: 1 },
            ],
            hours: 1,
            useEarlyExit: true,
            ...(playerHrid ? { playerHrid } : {}),
        });
        run.catch(() => {});

        const worker = workers[0];
        const decisions = [];
        worker.postMessage = (msg) => {
            if (msg.type === 'zone_tier_decision') decisions.push(msg.skip);
        };
        for (const simResult of tiers) {
            worker.onmessage({ data: { type: 'zone_tier_result', zoneHrid: '/actions/combat/a', simResult } });
        }
        return { run, decisions };
    };

    // Self is player2. From T0→T1 player2 climbs on both XP and profit, while
    // player1 and the party total both fall. Read player1/total, this skips T1;
    // read self, it must not — the tier is improving for the ranked player.
    const HOUR = 3600 * 1e9;
    const t0 = {
        simulatedTime: HOUR,
        experienceGained: { player1: { a: 100 }, player2: { a: 1 } },
        __profit: { player1: 100, player2: 1 },
    };
    const t1 = {
        simulatedTime: HOUR,
        experienceGained: { player1: { a: 10 }, player2: { a: 2 } },
        __profit: { player1: 10, player2: 2 },
    };

    test('a party sim reads the self player, not player1 or the party total', async () => {
        const { run, decisions } = driveTierResults('player2', [t0, t1]);

        // T0 has no predecessor (never skips); T1 improves for self, so no skip
        expect(decisions).toEqual([false, false]);

        cancelAllZonesSimulation();
        await expect(run).rejects.toThrow();
    });

    test('the early-exit profit is taxed at the analyzed rate; self passes none', async () => {
        revenueCalls.length = 0;
        const other = runAllZonesSimulation({
            gameData: {},
            playerDTOs: [],
            zones: [{ zoneHrid: '/actions/combat/a', difficultyTier: 0 }],
            hours: 1,
            useEarlyExit: true,
            saleTaxRate: 0,
        });
        other.catch(() => {});
        workers[0].postMessage = () => {};
        workers[0].onmessage({
            data: { type: 'zone_tier_result', zoneHrid: '/actions/combat/a', simResult: { simulatedTime: HOUR } },
        });
        cancelAllZonesSimulation();
        expect(revenueCalls).toEqual([{ saleTaxRate: 0 }]);

        revenueCalls.length = 0;
        const self = runAllZonesSimulation({
            gameData: {},
            playerDTOs: [],
            zones: [{ zoneHrid: '/actions/combat/a', difficultyTier: 0 }],
            hours: 1,
            useEarlyExit: true,
        });
        self.catch(() => {});
        workers[1].postMessage = () => {};
        workers[1].onmessage({
            data: { type: 'zone_tier_result', zoneHrid: '/actions/combat/a', simResult: { simulatedTime: HOUR } },
        });
        cancelAllZonesSimulation();
        expect(revenueCalls).toEqual([{}]);
    });

    test('the solo path still defaults to player1', async () => {
        // Only player1 exists; T1 falls on both metrics, so the next tier is skipped
        const solo0 = { simulatedTime: HOUR, experienceGained: { player1: { a: 100 } }, __profit: { player1: 100 } };
        const solo1 = { simulatedTime: HOUR, experienceGained: { player1: { a: 10 } }, __profit: { player1: 10 } };
        const { run, decisions } = driveTierResults(undefined, [solo0, solo1]);

        expect(decisions).toEqual([false, true]);

        cancelAllZonesSimulation();
        await expect(run).rejects.toThrow();
    });
});

describe('per-zone parties and streamed results', () => {
    test('relays each task_result to onResult and still resolves with the full array', async () => {
        const seen = [];
        const run = runAllZonesSimulation({
            gameData: {},
            playerDTOs: [],
            zones: [
                { zoneHrid: '/actions/combat/a', difficultyTier: 0, playerDTOs: [{ hrid: 'player1' }] },
                {
                    zoneHrid: '/actions/combat/a',
                    difficultyTier: 0,
                    playerDTOs: [{ hrid: 'player1' }, { hrid: 'player2' }],
                },
            ],
            hours: 1,
            onResult: (index, simResult) => seen.push([index, simResult]),
        });
        const worker = workers[0];
        worker.onmessage({ data: { type: 'task_result', index: 1, simResult: { x: 1 } } });
        worker.onmessage({ data: { type: 'task_result', index: 0, simResult: null } });
        worker.onmessage({ data: { type: 'all_zones_result', results: [null, { x: 1 }] } });
        await expect(run).resolves.toEqual([null, { x: 1 }]);
        expect(seen).toEqual([
            [1, { x: 1 }],
            [0, null],
        ]);
    });

    test('a streamed run whose final message carries no results resolves with an empty array', async () => {
        const run = runAllZonesSimulation({
            gameData: {},
            playerDTOs: [],
            zones: [{ zoneHrid: '/actions/combat/a', difficultyTier: 0 }],
            hours: 1,
            onResult: () => {},
        });
        workers[0].onmessage({ data: { type: 'all_zones_result', results: null } });
        await expect(run).resolves.toEqual([]);
    });

    test('results streamed before a cancel stay with the caller', async () => {
        const seen = [];
        const run = runAllZonesSimulation({
            gameData: {},
            playerDTOs: [],
            zones: [
                { zoneHrid: '/actions/combat/a', difficultyTier: 0 },
                { zoneHrid: '/actions/combat/b', difficultyTier: 0 },
            ],
            hours: 1,
            onResult: (index) => seen.push(index),
        });
        workers[0].onmessage({ data: { type: 'task_result', index: 0, simResult: { ok: true } } });
        cancelAllZonesSimulation();
        await expect(run).rejects.toThrow('Cancelled');
        expect(seen).toEqual([0]);
    });

    test('a sweep with per-zone parties runs without early exit and asks for streamed results', () => {
        let start = null;
        globalThis.Worker = class extends FakeWorker {
            postMessage(msg) {
                if (msg.type === 'start_all_zones') start = msg;
            }
        };
        const run = runAllZonesSimulation({
            gameData: {},
            playerDTOs: [],
            zones: [{ zoneHrid: '/actions/combat/a', difficultyTier: 0, playerDTOs: [{ hrid: 'player1' }] }],
            hours: 1,
            useEarlyExit: true,
            onResult: () => {},
        });
        run.catch(() => {});
        expect(start.useEarlyExit).toBe(false);
        expect(start.streamResults).toBe(true);
        cancelAllZonesSimulation();
    });
});
