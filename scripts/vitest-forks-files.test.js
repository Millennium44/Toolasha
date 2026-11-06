import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import forksFiles from '../vitest.forks-files.js';

// A glob entry covers every test file under its folder; any other entry names one file
const covers = (entry, file) =>
    entry.includes('*') ? file.startsWith(entry.split('*')[0]) && file.endsWith('.test.js') : entry === file;
const tracked = () => execFileSync('git', ['ls-files', '*.test.js'], { encoding: 'utf8' }).split('\n').filter(Boolean);

describe('vitest.forks-files.js', () => {
    it('lists every test file that sets process.env.TZ, since a worker thread ignores it', () => {
        const setsTz = tracked().filter((file) =>
            /process\.env\.TZ\s*=|stubEnv\(\s*['"]TZ['"]/.test(readFileSync(file, 'utf8'))
        );
        expect(setsTz.filter((file) => !forksFiles.some((entry) => covers(entry, file)))).toEqual([]);
    });

    it('names only files that exist, and every folder entry covers at least one', () => {
        const files = tracked();
        expect(forksFiles.filter((entry) => !files.some((file) => covers(entry, file)))).toEqual([]);
    });
});
