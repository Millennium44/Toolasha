import { defineConfig } from 'vitest/config';

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

export default defineConfig({
    plugins: [forkVirtualsStub()],
    test: {
        globals: true,
        environment: 'node',
        setupFiles: ['./vitest.setup.js'],
        // Agent worktrees live under .claude/worktrees and carry a full copy of src/, so
        // without this the suite runs every test twice and the mathjs-heavy ones time out.
        exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'],
        // Half the cores, not all of them: the suite is often run while the
        // game (and sometimes several concurrent agent suites) share the same
        // machine, and a full-width worker pool starves the foreground tab.
        maxWorkers: '50%',
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            exclude: ['node_modules/**', 'dist/**', '*.config.js', 'scripts/**', '**/*.test.js'],
        },
    },
});
