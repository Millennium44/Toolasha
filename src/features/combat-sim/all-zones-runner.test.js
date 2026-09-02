/**
 * The all-zones runner's lifecycle: every way a run ends must free the blob URL
 * the coordinator worker was built from, cancellation included.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./multi-worker-entry.js?worker', () => ({ default: '// coordinator' }));
vi.mock('./combat-sim-worker.js?worker', () => ({ default: '// sim' }));
// Revenue keyed off the requested player, read from a test-only `__profit` map on
// the sim result, so a test can prove the early-exit decision reads the right one.
vi.mock('./combat-sim-adapter.js', () => ({
    calculateSimRevenue: (simResult, _gameData, playerHrid) => ({ netPerHour: simResult?.__profit?.[playerHrid] ?? 0 }),
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
