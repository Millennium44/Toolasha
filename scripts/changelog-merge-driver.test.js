import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

const DRIVER = join(import.meta.dirname, 'changelog-merge-driver.mjs');

describe('CHANGELOG.md merge driver', () => {
    let dir;
    afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

    const run = (baseText, oursText, theirsText) => {
        dir = mkdtempSync(join(tmpdir(), 'cl-driver-'));
        const [base, ours, theirs] = ['base.md', 'ours.md', 'theirs.md'].map((n) => join(dir, n));
        writeFileSync(base, baseText);
        writeFileSync(ours, oursText);
        writeFileSync(theirs, theirsText);
        execFileSync('node', [DRIVER, base, ours, theirs, 'CHANGELOG.md'], { cwd: dir });
        return readFileSync(ours, 'utf8');
    };

    test('a changelog larger than 1 MiB is merged whole, not cut short', () => {
        const history = Array.from({ length: 40000 }, (_, i) => `### Entry ${i}\n\nBody of entry ${i}.\n`).join('\n');
        expect(history.length).toBeGreaterThan(2 * 1024 * 1024 * 0.5);
        const base = `# Changelog\n\n## Unreleased\n\n${history}`;
        const ours = `# Changelog\n\n## Unreleased\n\n### Ours\n\nOurs body.\n\n${history}`;
        const theirs = `# Changelog\n\n## Unreleased\n\n### Theirs\n\nTheirs body.\n\n${history}`;
        const merged = run(base, ours, theirs);
        expect(merged).toContain('### Entry 39999');
        expect(merged).toContain('### Ours');
        expect(merged).toContain('### Theirs');
        expect(merged.length).toBeGreaterThan(history.length);
    }, 60000);

    test('both sides keep their entries with a blank line between them', () => {
        const base = '# Changelog\n\n## Unreleased\n\n### Old\n\nOld body.\n';
        const merged = run(
            base,
            base.replace('## Unreleased\n', '## Unreleased\n\n### A\n\nA body.\n'),
            base.replace('## Unreleased\n', '## Unreleased\n\n### B\n\nB body.\n')
        );
        expect(merged).toMatch(/### A\n\nA body\.\n\n### B\n\nB body\.\n\n### Old/);
    }, 60000);
});
