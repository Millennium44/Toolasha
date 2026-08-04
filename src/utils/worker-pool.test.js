/**
 * Tests for Worker Pool Manager
 *
 * Uses a fake Worker that lets the test control when/what each worker "replies"
 * with, so the queueing and task-routing logic can be pinned without a real
 * worker thread.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import WorkerPool from './worker-pool.js';

class FakeWorker {
    constructor() {
        this.listeners = {};
        FakeWorker.instances.push(this);
    }
    addEventListener(type, handler) {
        this.listeners[type] = this.listeners[type] || [];
        this.listeners[type].push(handler);
    }
    removeEventListener(type, handler) {
        if (!this.listeners[type]) return;
        this.listeners[type] = this.listeners[type].filter((h) => h !== handler);
    }
    postMessage(data) {
        this.lastMessage = data;
    }
    terminate() {
        this.terminated = true;
    }
    // Test helper: simulate the worker replying to the given task
    reply(taskId, result, error) {
        const handlers = this.listeners['message'] || [];
        for (const h of handlers) h({ data: { taskId, result, error } });
    }
}
FakeWorker.instances = [];

beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('navigator', { hardwareConcurrency: 4 });
    globalThis.URL.createObjectURL = vi.fn(() => 'blob:fake');
});

describe('WorkerPool', () => {
    test('initialize() creates poolSize workers, capped at 4 by default', async () => {
        const pool = new WorkerPool('script', null);
        await pool.initialize();
        expect(pool.workers).toHaveLength(4);
        expect(pool.getStats().poolSize).toBe(4);
    });

    test('initialize() is idempotent', async () => {
        const pool = new WorkerPool('script', 2);
        await pool.initialize();
        await pool.initialize();
        expect(pool.workers).toHaveLength(2);
    });

    test('execute() assigns to an available worker immediately when the pool has capacity', async () => {
        const pool = new WorkerPool('script', 2);
        await pool.initialize();
        const promise = pool.execute({ action: 'foo' });

        expect(pool.getStats().busyWorkers).toBe(1);
        FakeWorker.instances[0].reply(0, { ok: true });

        await expect(promise).resolves.toEqual({ ok: true });
        expect(pool.getStats().busyWorkers).toBe(0);
    });

    test('execute() queues tasks once every worker is busy, and drains the queue as workers free up', async () => {
        const pool = new WorkerPool('script', 1);
        await pool.initialize();
        const p1 = pool.execute({ action: 'first' });
        const p2 = pool.execute({ action: 'second' });

        expect(pool.getStats().queuedTasks).toBe(1);

        FakeWorker.instances[0].reply(0, 'first-result');
        await p1;
        expect(pool.getStats().queuedTasks).toBe(0);

        FakeWorker.instances[0].reply(1, 'second-result');
        await expect(p2).resolves.toBe('second-result');
    });

    test('a worker error rejects the pending task and frees the worker for the queue', async () => {
        const pool = new WorkerPool('script', 1);
        await pool.initialize();
        const p1 = pool.execute({ action: 'boom' });

        const handlers = FakeWorker.instances[0].listeners['error'];
        handlers[0](new Error('worker crashed'));

        await expect(p1).rejects.toBeTruthy();
        expect(pool.getStats().busyWorkers).toBe(0);
    });

    test('executeAll() resolves with results in the same order as the input tasks', async () => {
        const pool = new WorkerPool('script', 2);
        await pool.initialize();
        const promise = pool.executeAll([{ action: 'a' }, { action: 'b' }]);

        // Two workers pick up both tasks immediately
        FakeWorker.instances[0].reply(0, 'A');
        FakeWorker.instances[1].reply(1, 'B');

        await expect(promise).resolves.toEqual(['A', 'B']);
    });

    test('execute() auto-initializes the pool if not already initialized', async () => {
        const pool = new WorkerPool('script', 1);
        expect(pool.initialized).toBe(false);
        const promise = pool.execute({ action: 'x' });

        // initialize() runs synchronously up to its own await-free body, but execute()
        // yields once on `await this.initialize()` before assigning the task — flush that.
        await Promise.resolve();
        await Promise.resolve();

        expect(pool.initialized).toBe(true);
        FakeWorker.instances[0].reply(0, 'done');
        await promise;
    });

    test('an error result (task.reject via error field) rejects with that message', async () => {
        const pool = new WorkerPool('script', 1);
        await pool.initialize();
        const promise = pool.execute({ action: 'fails' });
        FakeWorker.instances[0].reply(0, null, 'something went wrong');
        await expect(promise).rejects.toThrow('something went wrong');
    });

    test('terminate() terminates every worker and resets pool state', async () => {
        const pool = new WorkerPool('script', 2);
        await pool.initialize();
        pool.terminate();

        expect(FakeWorker.instances.every((w) => w.terminated)).toBe(true);
        expect(pool.workers).toHaveLength(0);
        expect(pool.initialized).toBe(false);
    });
});
