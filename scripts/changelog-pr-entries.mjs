#!/usr/bin/env node
/**
 * Rebuild CHANGELOG.md as a base's file plus the entries a PR added.
 *
 *   node scripts/changelog-pr-entries.mjs --pr <ref> [--base origin/main] [--write | --into-worktree]
 *
 * Why: CHANGELOG.md is merged with the `union` driver, which keeps both sides of a conflict but drops the
 * blank line between entries, and twice attached one entry's body to another's heading. Every Auto-fix
 * "merge conflict" on a PR was this file alone. Instead of repairing a merged file, take the base's file as it
 * is and add the PR's own entries to it.
 *
 * The PR's entries are the `### Title` + body blocks in the Unreleased section of `<ref>` that its merge-base
 * with `--base` does not have. A PR that merged main therefore does not claim the entries main added. They go at
 * the top of the base's `## Unreleased` section, in the PR's order, one blank line apart. A title the base
 * already has is not added twice, and a heading with no body (a stale one a union merge left behind) is never
 * copied.
 *
 * Without `--write` it only prints what it would add. `--write` (alias `--into-worktree`) writes CHANGELOG.md in
 * the current directory. Each added entry is printed as `added: <title>`, which land-stack.sh counts.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MARKER_RE = /^<!--\s*shipped in\s+(\d+(?:\.\d+)*)\s*-->\s*$/;

/** @param {string} title @returns {string} Key titles are compared by (the format test ignores case too) */
function titleKey(title) {
    return title.trim().toLowerCase();
}

/**
 * Find the Unreleased section.
 * @param {Array<string>} lines - File lines
 * @returns {{start: number, end: number}|null} Heading line index and the index of the next `## ` heading
 */
function unreleasedRange(lines) {
    const start = lines.findIndex((line) => /^## Unreleased/.test(line));
    if (start === -1) return null;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
        if (/^## (?!#)/.test(lines[i])) {
            end = i;
            break;
        }
    }
    return { start, end };
}

/**
 * The `### ` entries of the Unreleased section, in file order. Release markers end an entry and are not part of one.
 * @param {string} text - A whole CHANGELOG.md
 * @returns {Array<{title: string, key: string, block: string, hasBody: boolean}>} Entries; block is the title line plus body
 */
export function parseUnreleasedEntries(text) {
    const lines = String(text ?? '').split('\n');
    const range = unreleasedRange(lines);
    if (!range) return [];
    const entries = [];
    let current = null;
    const close = () => {
        if (!current) return;
        while (current.lines.length && current.lines[current.lines.length - 1].trim() === '') current.lines.pop();
        const body = current.lines.slice(1).join('\n');
        entries.push({
            title: current.title,
            key: titleKey(current.title),
            block: current.lines.join('\n'),
            hasBody: body.trim() !== '',
        });
        current = null;
    };
    for (let i = range.start + 1; i < range.end; i++) {
        const line = lines[i];
        const heading = /^### (.*)$/.exec(line);
        if (heading) {
            close();
            current = { title: heading[1], lines: [line] };
        } else if (MARKER_RE.test(line)) {
            close();
        } else if (current) {
            current.lines.push(line);
        }
    }
    close();
    return entries;
}

/**
 * The entries a PR adds: in its head, with a body, and in neither the merge-base nor the base.
 * @param {string} headText - CHANGELOG.md at the PR head
 * @param {string} mergeBaseText - CHANGELOG.md at the merge-base of the PR and the base
 * @param {string} baseText - CHANGELOG.md at the base
 * @returns {Array<{title: string, key: string, block: string, hasBody: boolean}>} Entries in the PR's order
 */
export function addedEntries(headText, mergeBaseText, baseText) {
    const known = new Set(
        [...parseUnreleasedEntries(mergeBaseText), ...parseUnreleasedEntries(baseText)].map((e) => e.key)
    );
    const out = [];
    for (const entry of parseUnreleasedEntries(headText)) {
        if (!entry.hasBody || known.has(entry.key)) continue;
        known.add(entry.key);
        out.push(entry);
    }
    return out;
}

/**
 * Put entries at the top of the base's Unreleased section, one blank line apart.
 * @param {string} baseText - The base's CHANGELOG.md
 * @param {Array<{block: string}>} entries - Entries to add, in order
 * @returns {string} The new file
 */
export function insertEntries(baseText, entries) {
    if (entries.length === 0) return baseText;
    const lines = baseText.split('\n');
    const range = unreleasedRange(lines);
    if (!range) throw new Error('the base CHANGELOG.md has no "## Unreleased" heading');
    const added = [];
    for (const entry of entries) added.push('', ...entry.block.split('\n'));
    // After the heading: blank, entry, blank, entry ... and the base's own blank line (or end) follows
    lines.splice(range.start + 1, 0, ...added);
    const after = lines[range.start + 1 + added.length];
    if (after !== undefined && after.trim() !== '') lines.splice(range.start + 1 + added.length, 0, '');
    return lines.join('\n');
}

function git(args) {
    return execFileSync('git', args, {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

/**
 * Compute the new file for a PR ref against a base ref, from the current directory's repository.
 * @param {string} pr - PR branch or ref
 * @param {string} base - Base ref
 * @returns {{text: string, added: Array<{title: string}>}} The base's file plus the PR's entries
 */
export function buildChangelog(pr, base) {
    const mergeBase = git(['merge-base', base, pr]).trim();
    const head = git(['show', `${pr}:CHANGELOG.md`]);
    const old = git(['show', `${mergeBase}:CHANGELOG.md`]);
    const baseText = git(['show', `${base}:CHANGELOG.md`]);
    const added = addedEntries(head, old, baseText);
    return { text: insertEntries(baseText, added), added };
}

function main(argv) {
    let pr = null;
    let base = 'origin/main';
    let write = false;
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--pr') pr = argv[++i];
        else if (arg === '--base') base = argv[++i];
        else if (arg === '--write' || arg === '--into-worktree') write = true;
        else {
            console.error(`Unknown argument: ${arg}`);
            return 2;
        }
    }
    if (!pr || !base) {
        console.error(
            'Usage: node scripts/changelog-pr-entries.mjs --pr <ref> [--base origin/main] [--write|--into-worktree]'
        );
        return 2;
    }
    let result;
    try {
        result = buildChangelog(pr, base);
    } catch (error) {
        console.error(`[changelog-pr-entries] ${error.message}`);
        return 1;
    }
    for (const entry of result.added) console.log(`added: ${entry.title}`);
    if (result.added.length === 0) console.log('no new entries');
    if (write) {
        writeFileSync('CHANGELOG.md', result.text);
        console.log('wrote CHANGELOG.md');
    } else if (result.added.length > 0) {
        console.log('(dry run; pass --write to write CHANGELOG.md)');
    }
    return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    process.exitCode = main(process.argv.slice(2));
}
