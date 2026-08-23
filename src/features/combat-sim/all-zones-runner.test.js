/**
 * The all-zones runner's lifecycle: every way a run ends must free the blob URL
 * the coordinator worker was built from, cancellation included.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./multi-worker-entry.js?worker', () => ({ default: '// coordinator' }));
vi.mock('./combat-sim-worker.js?worker', () => ({ default: '// sim' }));
vi.mock('./combat-sim-adapter.js', () => ({ calculateSimRevenue: () => ({ netPerHour: 0 }) }));

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
