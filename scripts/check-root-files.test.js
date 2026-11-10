import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('./check-root-files.js', import.meta.url));
let root;

function git(...args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function stage(path, content = '# Fixture\n') {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
    git('add', '--', path);
}

function commit() {
    git(
        '-c',
        'user.name=Tooling Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '--no-verify',
        '--no-gpg-sign',
        '-m',
        'test: seed fixture'
    );
}

function check() {
    return spawnSync(process.execPath, [checker], { cwd: root, encoding: 'utf8' });
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'toolasha-root-files-'));
    git('init', '--quiet');
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe('root-file pre-commit check', () => {
    test('allows an empty index', () => {
        expect(check().status).toBe(0);
    });

    test.each(['README.md', 'AGENTS.md', 'OVERVIEW.md', 'userscript-header.txt'])(
        'allows adding the established root file %s',
        (path) => {
            stage(path);
            expect(check().status).toBe(0);
        }
    );

    test('allows editing the tracked overview', () => {
        stage('OVERVIEW.md');
        commit();
        stage('OVERVIEW.md', '# Updated overview\n');
        expect(check().status).toBe(0);
    });

    test.each(['scratch.md', 'notes.txt'])('rejects an unapproved root file %s without changing the index', (path) => {
        stage(path);
        const before = git('diff', '--cached', '--name-status');
        const result = check();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(`  - ${path}`);
        expect(git('diff', '--cached', '--name-status')).toBe(before);
    });

    test('rejects a modified unapproved root file', () => {
        stage('scratch.md');
        commit();
        stage('scratch.md', '# Changed scratch\n');
        expect(check().status).toBe(1);
    });

    test('allows nested documentation and other file types', () => {
        stage('docs/notes.md');
        stage('docs/planning/notes.txt');
        stage('package.json', '{}\n');
        expect(check().status).toBe(0);
    });

    test('allows removing an unapproved root file', () => {
        stage('scratch.md');
        commit();
        git('rm', '--', 'scratch.md');
        expect(check().status).toBe(0);
    });

    test('checks rename destinations rather than their approved source', () => {
        stage('README.md');
        commit();
        git('mv', 'README.md', 'scratch.md');
        expect(git('diff', '--cached', '--name-status')).toContain('R100');
        const result = check();
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('  - scratch.md');
    });

    test('allows renaming a root scratch file into docs', () => {
        stage('scratch.md');
        commit();
        mkdirSync(join(root, 'docs'));
        git('mv', 'scratch.md', 'docs/scratch.md');
        expect(check().status).toBe(0);
    });
});
