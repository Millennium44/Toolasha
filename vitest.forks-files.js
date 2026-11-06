/**
 * Test files that must run in a child process (Vitest's forks pool), not a worker thread.
 *
 * They set `process.env.TZ` to run a time-zone matrix. A worker thread shares its process's time
 * zone and never picks up a TZ change, so in a thread these tests silently run in the host's zone:
 * on a UTC machine (the CI runner) `day-row-retention.test.js` then fails, and the others prove
 * nothing. Everything else runs on threads, which is about 2.5x faster on Windows.
 *
 * `scripts/vitest-forks-files.test.js` fails if a test file sets TZ without being listed here.
 */
export default [
    'src/features/networth/day-row-retention.test.js',
    'src/features/networth/gold-sources.test.js',
    'src/features/tasks/task-completion-tracker.test.js',
    'src/features/tasks/task-statistics.test.js',
    'src/utils/calendar-days.test.js',
];
