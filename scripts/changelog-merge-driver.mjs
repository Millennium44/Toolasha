#!/usr/bin/env node
/**
 * Git merge driver for CHANGELOG.md (`.gitattributes`: `CHANGELOG.md merge=changelog`).
 *
 * Every branch adds its entries at the top of the same section, so a plain merge always conflicts. A union
 * merge keeps both sides' entries but drops the blank line where they meet, which fails CI's Prettier: that
 * cost a hand-made "restore the blank line" commit on almost every merge of main into a PR branch. This does
 * the union merge, then formats the result with the repo's Prettier config, so the merge commit is already
 * clean. If Prettier fails, the plain union result is kept (the old behavior).
 *
 * Installed per clone by `npm install` (the `prepare` script runs `scripts/setup-merge-driver.mjs`).
 * Usage (from git): node scripts/changelog-merge-driver.mjs %O %A %B %P
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [, , base, ours, theirs, pathName = 'CHANGELOG.md'] = process.argv;

let merged;
try {
    merged = execFileSync('git', ['merge-file', '-p', '--union', ours, base, theirs], { encoding: 'utf8' });
} catch (error) {
    // merge-file exits with the conflict count; a union merge has none, but take its output either way
    if (typeof error.stdout !== 'string') {
        console.error('[changelog-merge-driver] union merge failed:', error.message);
        process.exit(1);
    }
    merged = error.stdout;
}

let output = merged;
try {
    const prettier = await import('prettier');
    const options = (await prettier.resolveConfig(pathName)) || {};
    output = await prettier.format(merged, { ...options, filepath: pathName });
} catch (error) {
    console.error('[changelog-merge-driver] Prettier failed, keeping the plain union merge:', error.message);
}

writeFileSync(ours, output);
process.exit(0);
