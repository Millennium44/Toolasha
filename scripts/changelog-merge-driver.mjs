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
import { readFileSync, writeFileSync } from 'node:fs';

const [, , base, ours, theirs, pathName = 'CHANGELOG.md'] = process.argv;

// merge-file writes the merged result into `ours` itself: no stdout buffer to overflow (the changelog is over
// 2 MB, past execFileSync's default 1 MiB, which would have cut the file short). Any error fails the merge
// rather than accepting a partial result, and git then reports the file as conflicted.
try {
    execFileSync('git', ['merge-file', '--union', ours, base, theirs], { stdio: ['ignore', 'ignore', 'inherit'] });
} catch (error) {
    console.error('[changelog-merge-driver] union merge failed:', error.message);
    process.exit(1);
}

let merged;
try {
    merged = readFileSync(ours, 'utf8');
} catch (error) {
    console.error('[changelog-merge-driver] could not read the merged file:', error.message);
    process.exit(1);
}

try {
    const prettier = await import('prettier');
    const options = (await prettier.resolveConfig(pathName)) || {};
    writeFileSync(ours, await prettier.format(merged, { ...options, filepath: pathName }));
} catch (error) {
    // The plain union result is already in place
    console.error('[changelog-merge-driver] Prettier failed, keeping the plain union merge:', error.message);
}

process.exit(0);
