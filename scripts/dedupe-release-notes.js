#!/usr/bin/env node

/**
 * Drop repeated bullets from the release-please section of the version being released.
 *
 * A PR merged with a merge commit lists its change twice: release-please parses the branch commit
 * (`fix: merge duplicate tasks ...`) and the GitHub merge commit, whose message carries the same
 * Conventional PR title. 3.77.0 shipped four such pairs, and GreasyFork shows these notes as the
 * version's public changelog (release.yml cuts them out of this section).
 *
 * Within each `### ` subsection of the newest `## [x.y.z]` section, a bullet whose text (before the
 * commit link) matches an earlier bullet's is removed; the first is kept. Only the newest section is
 * touched: published releases are left as they shipped.
 *
 * Runs in `.github/workflows/format-release-please.yml`, after the stamp and before formatting.
 * Re-running is a no-op.
 *
 * Usage: node scripts/dedupe-release-notes.js
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const BULLET_RE = /^[*-] (.*)$/;

/**
 * A bullet's text without its commit link(s) and any trailing "closes #N", normalized for comparing.
 * @param {string} text - The bullet's text after the marker
 * @returns {string}
 */
export function bulletKey(text) {
    return String(text)
        .replace(/\s*\(\[[0-9a-f]{7,40}\]\([^)]*\)\)/gi, '')
        .replace(/,?\s*closes \[#\d+\]\([^)]*\)/gi, '')
        .trim()
        .toLowerCase();
}

/**
 * Remove repeated bullets from the newest release-please section.
 * @param {string} changelog - The whole CHANGELOG.md
 * @returns {{text: string, removed: number}}
 */
export function dedupeNewestRelease(changelog) {
    const lines = String(changelog ?? '').split('\n');
    const start = lines.findIndex((line) => /^## \[\d/.test(line));
    if (start === -1) return { text: changelog, removed: 0 };
    let end = lines.findIndex((line, i) => i > start && /^## /.test(line));
    if (end === -1) end = lines.length;

    const out = lines.slice(0, start + 1);
    let seen = new Set();
    let removed = 0;
    for (let i = start + 1; i < end; i++) {
        const line = lines[i];
        if (/^### /.test(line)) seen = new Set();
        const bullet = BULLET_RE.exec(line);
        if (bullet) {
            const key = bulletKey(bullet[1]);
            if (key && seen.has(key)) {
                removed++;
                continue;
            }
            seen.add(key);
        }
        out.push(line);
    }
    return { text: out.concat(lines.slice(end)).join('\n'), removed };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
    const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md');
    const { text, removed } = dedupeNewestRelease(readFileSync(path, 'utf8'));
    if (removed > 0) writeFileSync(path, text);
    console.log(removed > 0 ? `Removed ${removed} repeated release-note bullet(s).` : 'No repeated bullets.');
}
