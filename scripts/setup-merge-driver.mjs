#!/usr/bin/env node
/**
 * Registers the CHANGELOG.md merge driver in this clone's git config (run by `npm install` via `prepare`).
 * Without it git falls back to a plain text merge for CHANGELOG.md, which conflicts instead of joining entries.
 */
import { execFileSync } from 'node:child_process';

try {
    execFileSync('git', ['config', 'merge.changelog.name', 'CHANGELOG union merge, then Prettier']);
    execFileSync('git', ['config', 'merge.changelog.driver', 'node scripts/changelog-merge-driver.mjs %O %A %B %P']);
} catch (error) {
    // Not a git checkout (a tarball install): nothing to register
    console.warn('[setup-merge-driver] skipped:', error.message);
}
