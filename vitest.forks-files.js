/**
 * Test files that must run in a child process (Vitest's forks pool), not a worker thread.
 *
 * They set `process.env.TZ` to run a time-zone matrix. A worker thread shares its process's time
 * zone and never picks up a TZ change, so in a thread these tests silently run in the host's zone:
 * on a UTC machine (the CI runner) `day-row-retention.test.js` then fails, and the others prove
 * nothing. Everything else runs on threads, which is about 2.5x faster on Windows.
 *
 * The sync suites run here too. On threads they fail at random when several run together (59-148 of
 * their 1,005 tests per run, a different set each time, measured 2026-11-06), and pass every time in
 * child processes. A folder entry (a glob ending in .test.js) covers every test file under that folder.
 *
 * `combat-sim-ui.test.js` runs here for memory: it builds the Combat Sim panel hundreds of times and needs
 * more heap than a worker thread gets. On threads it ran out at random on the CI runner (2 of 3 runs,
 * 2026-11-08, on main as well as branches); the forks project gives its processes a larger heap.
 *
 * `scripts/vitest-forks-files.test.js` fails if a test file sets TZ without being covered here.
 */
export default [
    'src/features/combat-sim/combat-sim-ui.test.js',
    'src/features/sync/**/*.test.js',
    'src/features/networth/day-row-retention.test.js',
    'src/features/networth/gold-sources.test.js',
    'src/features/tasks/task-completion-tracker.test.js',
    'src/features/tasks/task-statistics.test.js',
    'src/utils/calendar-days.test.js',
];
