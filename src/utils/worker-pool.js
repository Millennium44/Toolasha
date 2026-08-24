/**
 * Worker Pool Manager
 * Manages a pool of Web Workers for parallel task execution
 */

/** How long a single task may run before the pool gives up on it. */
const DEFAULT_TASK_TIMEOUT_MS = 120000;

class WorkerPool {
    /**
     * @param {Blob} workerScript - Blob holding the worker source
     * @param {number|null} poolSize - Worker count, or null to auto-detect
     * @param {{taskTimeoutMs?: number}} [options] - Pool options
     */
    constructor(workerScript, poolSize = null, options = {}) {
        // Auto-detect optimal pool size (max 4 workers)
        this.poolSize = poolSize || Math.min(navigator.hardwareConcurrency || 2, 4);
        this.workerScript = workerScript;
        this.workers = [];
        this.taskQueue = [];
        this.activeWorkers = new Set();
        this.nextTaskId = 0;
        this.initialized = false;
        // A worker that dies without firing `error` — killed for memory, or
        // wedged in a loop — leaves its task's promise pending forever, and the
        // caller (a calculator awaiting a result to draw) waits with it. Every
        // assigned task gets a deadline instead.
        this.taskTimeoutMs = options.taskTimeoutMs ?? DEFAULT_TASK_TIMEOUT_MS;
    }

    /**
     * Initialize the worker pool
     */
    async initialize() {
        if (this.initialized) {
            return;
        }

        try {
            // Create workers
            for (let i = 0; i < this.poolSize; i++) {
                // The object URL keeps the blob alive for the life of the
                // document unless it is revoked; the worker holds its own
                // reference once constructed, so revoking immediately is safe
                // and stops one blob leaking per pool created.
                const objectUrl = URL.createObjectURL(this.workerScript);
                let worker;
                try {
                    worker = new Worker(objectUrl);
                } finally {
                    URL.revokeObjectURL(objectUrl);
                }
                this.workers.push({
                    id: i,
                    worker,
                    busy: false,
                    currentTask: null,
                });
            }

            this.initialized = true;
        } catch (error) {
            console.error('[WorkerPool] Failed to initialize:', error);
            throw error;
        }
    }

    /**
     * Execute a task in the worker pool
     * @param {Object} taskData - Data to send to worker
     * @returns {Promise} Promise that resolves with worker result
     */
    async execute(taskData) {
        if (!this.initialized) {
            await this.initialize();
        }

        // replaceWorker drops a slot it cannot rebuild, so a pool can end up empty even
        // though it initialized. Queueing here would wait forever: nothing arms a
        // deadline until assignTask, and no worker is left to pick the task up.
        if (this.workers.length === 0) {
            throw new Error('Worker pool has no workers available');
        }

        return new Promise((resolve, reject) => {
            const taskId = this.nextTaskId++;
            const task = {
                id: taskId,
                data: taskData,
                resolve,
                reject,
                timestamp: Date.now(),
            };

            // Try to assign to an available worker immediately
            const availableWorker = this.workers.find((w) => !w.busy);

            if (availableWorker) {
                this.assignTask(availableWorker, task);
            } else {
                // Queue the task if all workers are busy
                this.taskQueue.push(task);
            }
        });
    }

    /**
     * Execute multiple tasks in parallel
     * @param {Array} taskDataArray - Array of task data objects
     * @returns {Promise<Array>} Promise that resolves with array of results
     */
    async executeAll(taskDataArray) {
        if (!this.initialized) {
            await this.initialize();
        }

        const promises = taskDataArray.map((taskData) => this.execute(taskData));
        return Promise.all(promises);
    }

    /**
     * Assign a task to a worker
     * @private
     */
    assignTask(workerWrapper, task) {
        workerWrapper.busy = true;
        workerWrapper.currentTask = task;

        let settled = false;
        let timeoutId = null;

        /**
         * Detach handlers, cancel the deadline and free the worker slot.
         * Runs at most once, whichever of message/error/timeout arrives first.
         */
        const release = () => {
            if (settled) return false;
            settled = true;
            if (timeoutId !== null) clearTimeout(timeoutId);
            workerWrapper.worker.removeEventListener('message', messageHandler);
            workerWrapper.worker.removeEventListener('error', errorHandler);
            workerWrapper.busy = false;
            workerWrapper.currentTask = null;
            return true;
        };
        // So terminate() can cancel this task's deadline and detach its handlers
        task.release = release;

        // Set up message handler for this specific task
        const messageHandler = (e) => {
            const { taskId, result, error } = e.data;

            if (taskId === task.id) {
                if (!release()) return;

                // Resolve or reject the promise
                if (error) {
                    task.reject(new Error(error));
                } else {
                    task.resolve(result);
                }

                // Process next task in queue
                this.processQueue();
            }
        };

        const errorHandler = (error) => {
            console.error('[WorkerPool] Worker error:', error);
            if (!release()) return;

            task.reject(error);

            // Process next task in queue
            this.processQueue();
        };

        if (this.taskTimeoutMs > 0) {
            timeoutId = setTimeout(() => {
                if (!release()) return;
                console.error(`[WorkerPool] Task ${task.id} timed out after ${this.taskTimeoutMs}ms`);
                task.reject(new Error(`Worker task timed out after ${this.taskTimeoutMs}ms`));

                // The worker is presumed wedged or dead: replace it rather than
                // hand the next task to something that already stopped answering.
                this.replaceWorker(workerWrapper);
                this.processQueue();
            }, this.taskTimeoutMs);
        }

        workerWrapper.worker.addEventListener('message', messageHandler);
        workerWrapper.worker.addEventListener('error', errorHandler);

        // Send task to worker
        workerWrapper.worker.postMessage({
            taskId: task.id,
            data: task.data,
        });
    }

    /**
     * Process the next task in the queue
     * @private
     */
    processQueue() {
        if (this.taskQueue.length === 0) {
            return;
        }

        const availableWorker = this.workers.find((w) => !w.busy);
        if (availableWorker) {
            const task = this.taskQueue.shift();
            this.assignTask(availableWorker, task);
        }
    }

    /**
     * Replace a worker that stopped answering with a fresh one.
     * @param {Object} workerWrapper - The pool entry to rebuild in place
     * @private
     */
    replaceWorker(workerWrapper) {
        try {
            workerWrapper.worker.terminate();
        } catch (error) {
            console.error('[WorkerPool] Failed to terminate unresponsive worker:', error);
        }

        try {
            const objectUrl = URL.createObjectURL(this.workerScript);
            try {
                workerWrapper.worker = new Worker(objectUrl);
            } finally {
                URL.revokeObjectURL(objectUrl);
            }
            workerWrapper.busy = false;
            workerWrapper.currentTask = null;
        } catch (error) {
            console.error('[WorkerPool] Failed to replace unresponsive worker:', error);
            // Drop the dead slot rather than keep a pool entry with no worker
            const index = this.workers.indexOf(workerWrapper);
            if (index !== -1) this.workers.splice(index, 1);

            // Losing the last slot leaves anything already queued unreachable: no worker
            // will pick it up, and a queued task has no deadline armed yet (deadlines
            // start in assignTask), so its caller would await for the life of the page.
            // Fail those callers and mark the pool uninitialized so the next execute()
            // rebuilds it instead of early-returning from initialize() forever.
            if (this.workers.length === 0) {
                const abandoned = this.taskQueue;
                this.taskQueue = [];
                this.initialized = false;
                for (const task of abandoned) {
                    if (task.release && !task.release()) continue;
                    task.reject(new Error('Worker pool has no workers available'));
                }
            }
        }
    }

    /**
     * Get pool statistics
     */
    getStats() {
        return {
            poolSize: this.poolSize,
            busyWorkers: this.workers.filter((w) => w.busy).length,
            queuedTasks: this.taskQueue.length,
            totalWorkers: this.workers.length,
        };
    }

    /**
     * Terminate all workers and clean up
     */
    terminate() {
        // Nothing will ever answer these once the workers are gone: an in-flight task
        // whose worker is terminated gets no message and no error, and a queued task has
        // no deadline armed yet (deadlines start in assignTask), so both would leave
        // their callers awaiting for the life of the page.
        const abandoned = [...this.workers.map((w) => w.currentTask), ...this.taskQueue];

        for (const workerWrapper of this.workers) {
            workerWrapper.worker.terminate();
        }

        this.workers = [];
        this.taskQueue = [];
        this.initialized = false;

        for (const task of abandoned) {
            if (!task) continue;
            // Cancels the deadline and detaches the handlers for an in-flight task;
            // returns false if it already settled, in which case leave it alone.
            if (task.release && !task.release()) continue;
            task.reject(new Error('Worker pool terminated'));
        }
    }
}

/** Default idle window before an unused pool is torn down. */
export const DEFAULT_POOL_IDLE_MS = 5 * 60 * 1000;

/**
 * Build an idle reaper for a lazily-created worker pool.
 *
 * A pool is a handful of OS threads plus, for the enhancement and networth
 * workers, a parsed copy of a maths library apiece. Created on the first
 * calculation and never torn down, they sit there for the rest of a session
 * that may only ever open the calculator once. The reaper terminates the pool
 * after an idle window; the manager's `getWorkerPool` recreates it on the next
 * call, which is a few milliseconds against hours of idle threads.
 * @param {Function} terminate - Called when the idle window elapses
 * @param {number} [idleMs] - Idle window in milliseconds
 * @param {Function} [isBusy] - Returns true while work is still in flight
 * @returns {{touch: Function, cancel: Function}} Reaper handle
 */
export function createIdlePoolReaper(terminate, idleMs = DEFAULT_POOL_IDLE_MS, isBusy = null) {
    let timer = null;

    const schedule = () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            try {
                // A batch still running is not idle; wait out another window
                // rather than terminate a worker mid-task.
                if (isBusy && isBusy()) {
                    schedule();
                    return;
                }
                terminate();
            } catch (error) {
                console.error('[WorkerPool] Idle teardown failed:', error);
            }
        }, idleMs);
        // Never hold a test runner or a node process open on our account
        if (typeof timer === 'object' && timer && typeof timer.unref === 'function') timer.unref();
    };

    return {
        /** Restart the idle countdown — call whenever the pool is used. */
        touch() {
            schedule();
        },

        /** Stop the countdown — call when the pool has been torn down already. */
        cancel() {
            if (timer) clearTimeout(timer);
            timer = null;
        },
    };
}

export default WorkerPool;
