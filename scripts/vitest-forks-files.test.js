import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import forksFiles from '../vitest.forks-files.js';

describe('vitest.forks-files.js', () => {
    it('lists every test file that sets process.env.TZ, since a worker thread ignores it', () => {
        const tracked = execFileSync('git', ['ls-files', '*.test.js'], { encoding: 'utf8' })
            .split('\n')
            .filter(Boolean);
        const setsTz = tracked.filter((file) =>
            /process\.env\.TZ\s*=|stubEnv\(\s*['"]TZ['"]/.test(readFileSync(file, 'utf8'))
        );
        expect(setsTz.filter((file) => !forksFiles.includes(file))).toEqual([]);
    });

    it('names only files that exist', () => {
        const tracked = new Set(execFileSync('git', ['ls-files', '*.test.js'], { encoding: 'utf8' }).split('\n'));
        expect(forksFiles.filter((file) => !tracked.has(file))).toEqual([]);
    });
});
