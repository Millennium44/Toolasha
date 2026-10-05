import { getMaxWorkers, runWorkerChunk } from './combat-sim-runner.js';
import { summarizeTrialRuns, validateTrialScenario } from './guild-trial-model.js';

/** Split independent attempts while preserving run order, seeds and exact summary statistics. */
export async function runGuildTrialSimulation(message, onProgress = () => {}, { signal } = {}) {
    // Validate the full workload before dividing it, including the aggregate skilling event limit.
    const scenario = validateTrialScenario(message.scenario);
    if (signal?.aborted) throw new Error('Simulation canceled.');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const workerCount = Math.max(1, Math.min(Math.floor(getMaxWorkers()), scenario.runs));
    const chunks = Array.from({ length: workerCount }, (_, index) => {
        const first = Math.floor((index * scenario.runs) / workerCount);
        const end = Math.floor(((index + 1) * scenario.runs) / workerCount);
        return { first, runs: end - first, progress: 0 };
    });
    let reported = -1;
    const report = (chunk, value) => {
        if (controller.signal.aborted) return;
        chunk.progress = Math.max(chunk.progress, Math.min(100, Math.max(0, value)));
        const progress = Math.floor(chunks.reduce((sum, part) => sum + part.progress * part.runs, 0) / scenario.runs);
        if (progress > reported) {
            reported = progress;
            onProgress(progress);
        }
    };
    try {
        const results = await Promise.all(
            chunks.map(async (chunk, index) => {
                const attempts = await runWorkerChunk(
                    {
                        ...message,
                        taskId: `${message.taskId}-${index}`,
                        returnAttempts: true,
                        scenario: {
                            ...scenario,
                            runs: chunk.runs,
                            seed: (scenario.seed + chunk.first * 0x9e3779b9) >>> 0,
                        },
                    },
                    (value) => report(chunk, value),
                    { signal: controller.signal }
                );
                if (controller.signal.aborted) throw new Error('Simulation canceled.');
                if (!Array.isArray(attempts) || attempts.length !== chunk.runs)
                    throw new Error('The trial worker returned an incomplete set of attempts.');
                report(chunk, 100);
                return attempts;
            })
        );
        // Promise.all retains chunk order even when later chunks finish first. Recompute
        // percentiles and means from every attempt, never from per-worker summaries.
        return summarizeTrialRuns(scenario, results.flat());
    } catch (error) {
        controller.abort(); // Also stop siblings when one worker fails.
        throw error;
    } finally {
        signal?.removeEventListener('abort', abort);
    }
}
