import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseUnreleasedEntries, addedEntries, insertEntries } from './changelog-pr-entries.mjs';
import { checkChangelogFormat, GRANDFATHERED_FROM_RELEASE } from './changelog-format.js';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'changelog-pr-entries.mjs');
const MARKER = `<!-- shipped in ${GRANDFATHERED_FROM_RELEASE} -->`;

/** A changelog shaped like the real file; each entry is [title, body]. */
function changelog(entries) {
    const body = entries.map(([title, text]) => `### ${title}\n\n${text}`).join('\n\n');
    return `# Changelog\n\n## Unreleased — branch \`main\`\n\n${body}\n\n${MARKER}\n\n- Old flat line, grandfathered.\n`;
}

describe('parsing and inserting', () => {
    it('reads entries, stopping at release markers', () => {
        const text = changelog([
            ['One', 'Body one.'],
            ['Two', 'Body two.'],
        ]);
        const entries = parseUnreleasedEntries(text);
        expect(entries.map((e) => e.title)).toEqual(['One', 'Two']);
        expect(entries[1].block).toBe('### Two\n\nBody two.');
    });

    it('adds an entry the PR added, on top, with one blank line between', () => {
        const base = changelog([['Old', 'Old body.']]);
        const head = changelog([
            ['New', 'New body.'],
            ['Old', 'Old body.'],
        ]);
        const added = addedEntries(head, base, base);
        expect(added.map((e) => e.title)).toEqual(['New']);
        expect(insertEntries(base, added)).toBe(
            changelog([
                ['New', 'New body.'],
                ['Old', 'Old body.'],
            ])
        );
    });

    it('adds several entries in the PR order', () => {
        const base = changelog([['Old', 'Old body.']]);
        const head = changelog([
            ['A', 'a.'],
            ['B', 'b.'],
            ['Old', 'Old body.'],
        ]);
        const out = insertEntries(base, addedEntries(head, base, base));
        expect(out).toBe(
            changelog([
                ['A', 'a.'],
                ['B', 'b.'],
                ['Old', 'Old body.'],
            ])
        );
        expect(checkChangelogFormat(out)).toEqual([]);
    });

    it('does not count what main added since as the PR own entries', () => {
        // The PR merged main (which had M); the merge-base therefore already has M, and main moved on to N since
        const mergeBase = changelog([
            ['M', 'm.'],
            ['Old', 'o.'],
        ]);
        const head = changelog([
            ['P', 'p.'],
            ['M', 'm.'],
            ['Old', 'o.'],
        ]);
        const base = changelog([
            ['N', 'n.'],
            ['M', 'm.'],
            ['Old', 'o.'],
        ]);
        const out = insertEntries(base, addedEntries(head, mergeBase, base));
        expect(parseUnreleasedEntries(out).map((e) => e.title)).toEqual(['P', 'N', 'M', 'Old']);
    });

    it('never copies a stale heading with no body', () => {
        const base = changelog([['Old', 'o.']]);
        const head = changelog([['Old', 'o.']]).replace('### Old', '### Stale\n\n### Old');
        expect(addedEntries(head, base, base)).toEqual([]);
    });

    it('does not add a title the base already has', () => {
        const base = changelog([['Same', 'from main.']]);
        const head = changelog([
            ['same', 'from the PR.'],
            ['New', 'n.'],
        ]);
        const added = addedEntries(head, changelog([]), base);
        expect(added.map((e) => e.title)).toEqual(['New']);
    });
});

describe('the command, in a real repository', () => {
    let dir;
    const run = (...args) =>
        execFileSync(
            'git',
            [
                '-c',
                'user.name=t',
                '-c',
                'user.email=t@t',
                '-c',
                'commit.gpgsign=false',
                '-c',
                'core.autocrlf=false',
                ...args,
            ],
            { cwd: dir, encoding: 'utf8' }
        );
    const commitChangelog = (entries, message) => {
        writeFileSync(join(dir, 'CHANGELOG.md'), changelog(entries));
        run('add', '.');
        run('commit', '-q', '-m', message);
    };

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cl-pr-'));
        run('init', '-q', '-b', 'main');
        commitChangelog([['Old', 'o.']], 'chore: base');
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('after the PR merged main, writes main plus only the PR entries', () => {
        run('checkout', '-q', '-b', 'pr');
        commitChangelog(
            [
                ['P1', 'p1.'],
                ['P2', 'p2.'],
                ['Old', 'o.'],
            ],
            'feat: pr'
        );
        run('checkout', '-q', 'main');
        commitChangelog(
            [
                ['M', 'm.'],
                ['Old', 'o.'],
            ],
            'feat: main entry'
        );
        // Auto-fix style: merge main into the PR, keeping both sides
        run('checkout', '-q', 'pr');
        run('merge', '-q', '--no-commit', '--no-ff', '-s', 'ours', 'main');
        writeFileSync(
            join(dir, 'CHANGELOG.md'),
            changelog([
                ['P1', 'p1.'],
                ['P2', 'p2.'],
                ['M', 'm.'],
                ['Old', 'o.'],
            ])
        );
        run('add', '.');
        run('commit', '-q', '-m', 'Merge main');
        // main moves on again
        run('checkout', '-q', 'main');
        commitChangelog(
            [
                ['N', 'n.'],
                ['M', 'm.'],
                ['Old', 'o.'],
            ],
            'feat: more main'
        );

        const out = execFileSync(process.execPath, [SCRIPT, '--pr', 'pr', '--base', 'main', '--into-worktree'], {
            cwd: dir,
            encoding: 'utf8',
        });
        expect(out).toContain('added: P1');
        expect(out).toContain('added: P2');
        expect(out).not.toContain('added: M');
        const written = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
        expect(parseUnreleasedEntries(written).map((e) => e.title)).toEqual(['P1', 'P2', 'N', 'M', 'Old']);
        expect(checkChangelogFormat(written)).toEqual([]);
    });

    it('prints and leaves the file alone without --write', () => {
        run('checkout', '-q', '-b', 'pr');
        commitChangelog(
            [
                ['P', 'p.'],
                ['Old', 'o.'],
            ],
            'feat: pr'
        );
        run('checkout', '-q', 'main');
        const before = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
        const out = execFileSync(process.execPath, [SCRIPT, '--pr', 'pr', '--base', 'main'], {
            cwd: dir,
            encoding: 'utf8',
        });
        expect(out).toContain('added: P');
        expect(readFileSync(join(dir, 'CHANGELOG.md'), 'utf8')).toBe(before);
    });
});
