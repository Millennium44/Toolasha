import { describe, test, expect, vi, afterEach } from 'vitest';
import performanceMonitor from '../../utils/performance-monitor.js';
import { syncPhase } from './sync-phase.js';

describe('syncPhase', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        performanceMonitor.enabled = false;
        performanceMonitor.openRuns = new Set();
        performanceMonitor.finishedRuns = [];
    });

    test('runs the phase unchanged while the monitor is off', async () => {
        const spy = vi.spyOn(performanceMonitor, 'traceAsync');
        await expect(syncPhase('pull', 'parse', async () => 42)).resolves.toBe(42);
        expect(spy).toHaveBeenCalledWith('sync:pull:parse', expect.any(Function));
    });

    test('lists the phase as in flight, then finished, with the monitor on', async () => {
        performanceMonitor.enabled = true;
        let during = null;
        await syncPhase('pull', 'merge', async () => {
            during = [...performanceMonitor.openRuns].map((run) => run.name);
        });
        expect(during).toEqual(['sync:pull:merge']);
        expect(performanceMonitor.openRuns.size).toBe(0);
        expect(performanceMonitor.finishedRuns.map((run) => run.name)).toContain('sync:pull:merge');
    });

    test('a failing phase closes its span and rethrows the same error', async () => {
        performanceMonitor.enabled = true;
        const boom = new Error('boom');
        await expect(
            syncPhase('pull', 'write', async () => {
                throw boom;
            })
        ).rejects.toBe(boom);
        expect(performanceMonitor.openRuns.size).toBe(0);
        expect(performanceMonitor.finishedRuns.map((run) => run.name)).toContain('sync:pull:write');
    });
});
