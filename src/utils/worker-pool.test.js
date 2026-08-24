/**
 * Worker pool: the failure modes a pool has that a plain promise does not.
 *
 * A worker that dies without firing `error` is the interesting one — nothing
 * settles the task, nothing frees the slot, and the calculator awaiting a
 * result waits for the rest of the session. That is what the timeout is for,
 * and it needs a fake Worker to reproduce.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import WorkerPool, { createIdlePoolReaper } from './worker-pool.js';

/** Workers created by the fake constructor, newest last. */
let created = [];
/** Object URLs handed out and revoked, so the leak fix is observable. */
let urls = [];

/**
 * A Worker that does nothing at all unless a test tells it to answer.
 */
class SilentWorker {
    constructor(url) {
        this.url = url;
        this.terminated = false;
        this.posted = [];
        this._listeners = new Map();
        created.push(this);
    }

    addEventListener(type, fn) {
        if (!this._listeners.has(type)) this._listeners.set(type, new Set());
        this._listeners.get(type).add(fn);
    }

    removeEventListener(type, fn) {
        this._listeners.get(type)?.delete(fn);
    }

    postMessage(message) {
        this.posted.push(message);
    }

    terminate() {
        this.terminated = true;
    }

    /**
     * Deliver a message as the real worker would.
     * @param {Object} data - The message payload
     */
    reply(data) {
        for (const fn of this._listeners.get('message') || []) fn({ data });
    }

    /** How many listeners of a type are still attached. */
    listenerCount(type) {
        return this._listeners.get(type)?.size ?? 0;
    }
}

beforeEach(() => {
    created = [];
    urls = [];
    vi.stubGlobal('Worker', SilentWorker);
    vi.stubGlobal('URL', {
        createObjectURL: vi.fn(() => {
            const url = `blob:fake/${urls.length}`;
            urls.push({ url, revoked: false });
            return url;
        }),
        revokeObjectURL: vi.fn((url) => {
            const entry = urls.find((u) => u.url === url);
            if (entry) entry.revoked = true;
        }),
    });
    vi.stubGlobal('navigator', { hardwareConcurrency: 2 });
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('WorkerPool task timeouts', () => {
    test('a worker that never answers rejects its task instead of hanging forever', async () => {
        vi.useFakeTimers();
        const pool = new WorkerPool({}, 1, { taskTimeoutMs: 1000 });
        await pool.initialize();
        const promise = pool.execute({ work: 1 });
        const assertion = expect(promise).rejects.toThrow(/timed out after 1000ms/);

        await vi.advanceTimersByTimeAsync(1001);
        await assertion;
    });

    test('the timed-out worker is replaced and the slot freed for the next task', async () => {
        vi.useFakeTimers();
        const pool = new WorkerPool({}, 1, { taskTimeoutMs: 1000 });
        await pool.initialize();

        const first = pool.execute({ work: 1 });
        const firstRejects = expect(first).rejects.toThrow(/timed out/);
        await vi.advanceTimersByTimeAsync(1001);
        await firstRejects;

        expect(created[0].terminated).toBe(true);
        expect(pool.getStats().busyWorkers).toBe(0);

        // A second task goes to the replacement worker and completes normally
        const second = pool.execute({ work: 2 });
        await vi.advanceTimersByTimeAsync(0);
        const replacement = created[created.length - 1];
        replacement.reply({ taskId: replacement.posted[0].taskId, result: 'ok' });
        await expect(second).resolves.toBe('ok');
    });

    test('a queued task is started once the timed-out slot frees up', async () => {
        vi.useFakeTimers();
        const pool = new WorkerPool({}, 1, { taskTimeoutMs: 1000 });
        // Initialized up front so the two executes queue in call order: the
        // first execute on an uninitialized pool awaits initialize(), which
        // lets a second call overtake it and take the only worker.
        await pool.initialize();

        const first = pool.execute({ work: 1 });
        const queued = pool.execute({ work: 2 });
        // Captured rather than asserted with `.rejects`, which does not settle
        // cleanly once the fake clock has been advanced more than once
        const firstError = first.catch((error) => error);

        expect(pool.taskQueue).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(1001);
        expect((await firstError).message).toMatch(/timed out/);

        const replacement = created[created.length - 1];
        expect(replacement.posted).toHaveLength(1);
        replacement.reply({ taskId: replacement.posted[0].taskId, result: 'queued-ran' });
        await expect(queued).resolves.toBe('queued-ran');
    });

    test('a normal answer cancels the deadline and detaches its listeners', async () => {
        vi.useFakeTimers();
        const pool = new WorkerPool({}, 1, { taskTimeoutMs: 1000 });
        await pool.initialize();

        const promise = pool.execute({ work: 1 });
        await vi.advanceTimersByTimeAsync(0);
        const worker = created[0];
        worker.reply({ taskId: worker.posted[0].taskId, result: 42 });

        await expect(promise).resolves.toBe(42);
        expect(worker.listenerCount('message')).toBe(0);
        expect(worker.listenerCount('error')).toBe(0);

        // The deadline must not fire after the task already settled
        await vi.advanceTimersByTimeAsync(5000);
        expect(worker.terminated).toBe(false);
    });

    test('a timeout of 0 disables the deadline entirely', async () => {
        vi.useFakeTimers();
        const pool = new WorkerPool({}, 1, { taskTimeoutMs: 0 });
        await pool.initialize();
        const promise = pool.execute({ work: 1 });

        await vi.advanceTimersByTimeAsync(600000);
        expect(created[0].terminated).toBe(false);

        const worker = created[0];
        worker.reply({ taskId: worker.posted[0].taskId, result: 'late but fine' });
        await expect(promise).resolves.toBe('late but fine');
    });
});

describe('WorkerPool.terminate', () => {
    test('rejects the in-flight and the queued tasks instead of leaving them awaited forever', async () => {
        vi.useFakeTimers();
        const pool = new WorkerPool({}, 1, { taskTimeoutMs: 1000 });
        await pool.initialize();

        const inFlight = pool.execute({ work: 1 });
        const queued = pool.execute({ work: 2 });
        const inFlightError = inFlight.catch((error) => error);
        const queuedError = queued.catch((error) => error);

        pool.terminate();

        expect((await inFlightError).message).toMatch(/pool terminated/i);
        expect((await queuedError).message).toMatch(/pool terminated/i);

        // The in-flight task's deadline went with it; nothing is left to fire
        await vi.advanceTimersByTimeAsync(5000);
        expect(created[0].listenerCount('message')).toBe(0);
    });

    test('a task that already answered is not rejected a second time', async () => {
        vi.useFakeTimers();
        const pool = new WorkerPool({}, 1, { taskTimeoutMs: 1000 });
        await pool.initialize();

        const promise = pool.execute({ work: 1 });
        await vi.advanceTimersByTimeAsync(0);
        const worker = created[0];
        worker.reply({ taskId: worker.posted[0].taskId, result: 7 });
        await expect(promise).resolves.toBe(7);

        expect(() => pool.terminate()).not.toThrow();
    });
});

describe('WorkerPool with no workers left', () => {
    test('execute refuses rather than queueing a task nothing can pick up', async () => {
        const pool = new WorkerPool({}, 1, { taskTimeoutMs: 0 });
        await pool.initialize();

        // What replaceWorker's failure path leaves behind: an initialized pool with
        // an empty worker list, where a queued task would wait for the whole session
        pool.workers.length = 0;

        await expect(pool.execute({ work: 1 })).rejects.toThrow(/no workers/i);
        expect(pool.taskQueue).toHaveLength(0);
    });
});

describe('WorkerPool object URLs', () => {
    test('every object URL is revoked as soon as its worker holds it', async () => {
        const pool = new WorkerPool({}, 3, { taskTimeoutMs: 0 });
        await pool.initialize();

        expect(urls).toHaveLength(3);
        expect(urls.every((entry) => entry.revoked)).toBe(true);
    });
});

describe('createIdlePoolReaper', () => {
    test('terminates after the idle window and not before', () => {
        vi.useFakeTimers();
        const terminate = vi.fn();
        const reaper = createIdlePoolReaper(terminate, 1000);

        reaper.touch();
        vi.advanceTimersByTime(999);
        expect(terminate).not.toHaveBeenCalled();

        vi.advanceTimersByTime(2);
        expect(terminate).toHaveBeenCalledTimes(1);
    });

    test('each use restarts the countdown', () => {
        vi.useFakeTimers();
        const terminate = vi.fn();
        const reaper = createIdlePoolReaper(terminate, 1000);

        reaper.touch();
        vi.advanceTimersByTime(800);
        reaper.touch();
        vi.advanceTimersByTime(800);
        expect(terminate).not.toHaveBeenCalled();

        vi.advanceTimersByTime(300);
        expect(terminate).toHaveBeenCalledTimes(1);
    });

    test('a busy pool is not torn down mid-batch', () => {
        vi.useFakeTimers();
        const terminate = vi.fn();
        let busy = true;
        const reaper = createIdlePoolReaper(terminate, 1000, () => busy);

        reaper.touch();
        vi.advanceTimersByTime(1001);
        expect(terminate).not.toHaveBeenCalled();

        busy = false;
        vi.advanceTimersByTime(1001);
        expect(terminate).toHaveBeenCalledTimes(1);
    });

    test('cancel stops a pending teardown', () => {
        vi.useFakeTimers();
        const terminate = vi.fn();
        const reaper = createIdlePoolReaper(terminate, 1000);

        reaper.touch();
        reaper.cancel();
        vi.advanceTimersByTime(5000);
        expect(terminate).not.toHaveBeenCalled();
    });
});
