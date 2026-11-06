import { defineConfig } from 'vitest/config';
import forksFiles from './vitest.forks-files.js';

// The production build injects the fork changelog and overview as virtual
// modules (see changelogPlugin/overviewPlugin in rollup.config.js). Tests have
// no such plugin, so any file that imports whats-new — directly or transitively
// — would fail to resolve them. Stub both to an empty string here so resolution
// works everywhere; the whats-new tests still override the content per-file.
const forkVirtualsStub = () => ({
    name: 'fork-virtuals-test-stub',
    resolveId(id) {
        if (id === 'virtual:fork-changelog' || id === 'virtual:fork-overview') return '\0' + id;
        return null;
    },
    load(id) {
        if (id === '\0virtual:fork-changelog' || id === '\0virtual:fork-overview') return 'export default "";';
        return null;
    },
});

// Agent worktrees live under .claude/worktrees and carry a full copy of src/, so
// without the .claude exclusion the suite runs every test twice and the mathjs-heavy ones time out.
const EXCLUDE = ['**/node_modules/**', '**/dist/**', '.claude/**'];

export default defineConfig({
    plugins: [forkVirtualsStub()],
    test: {
        globals: true,
        environment: 'node',
        setupFiles: ['./vitest.setup.js'],
        exclude: EXCLUDE,
        // Half the cores, not all of them: the suite is often run while the
        // game (and sometimes several concurrent agent suites) share the same
        // machine, and a full-width worker pool starves the foreground tab.
        maxWorkers: '50%',
        // Worker threads, not child processes: starting a process per test file is what the suite
        // spent its time on under Windows. Measured 2026-11-06 on 16 cores at 8 workers: forks 5m36s,
        // threads 2m12s (three full runs, all passing). More fork workers barely helped (16: 5m19s).
        // Each file still gets a fresh module graph (isolate stays on); only the worker is reused.
        // The files that change process.env.TZ stay on forks: a thread never picks up a TZ change
        // (see vitest.forks-files.js).
        projects: [
            {
                extends: true,
                test: { name: 'threads', pool: 'threads', exclude: [...EXCLUDE, ...forksFiles] },
            },
            {
                extends: true,
                test: { name: 'forks', pool: 'forks', include: forksFiles },
            },
        ],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            exclude: ['node_modules/**', 'dist/**', '*.config.js', 'scripts/**', '**/*.test.js'],
        },
    },
});
