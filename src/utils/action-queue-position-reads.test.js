/**
 * Guard: nothing in src/ reads "the running action" off the action queue by
 * position.
 *
 * The queue reached `actions[0]` / `actions.find(a => !a.isDone)` in reader
 * after reader, and every one of them eventually reported a queued action as
 * the running one — most recently a labyrinth "stopped" toast fired because a
 * craft had been reordered into slot two. `dataManager` now keeps its copy in
 * ordinal order, which makes `[0]` right more often, but it still does not skip
 * a finished entry and the login snapshot (`characterData.characterActions`) is
 * not sorted at all. `runningAction()` / `runningCombatAction()` in
 * `src/utils/combat-actions.js` is the one documented entry point.
 */

import { describe, test, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..');

const FIX = 'use runningAction() / runningCombatAction() from src/utils/combat-actions.js';

/**
 * The position reads refused. Each names what it catches; the `find` rule only
 * applies to files that read the queue at all, since `isDone` exists elsewhere.
 */
const RULES = [
    {
        id: 'getCurrentActions-index-0',
        // getCurrentActions()[0], getCurrentActions?.()?.[0], (getCurrentActions?.() || [])[0]
        pattern: /getCurrentActions\s*(?:\?\.)?\(\s*\)\s*(?:(?:\|\||\?\?)\s*\[\s*\]\s*\)\s*)?(?:\?\.)?\[\s*0\s*\]/g,
        queueFilesOnly: false,
    },
    {
        id: 'characterActions-index-0',
        // characterActions[0], characterActions?.[0]
        pattern: /characterActions\s*(?:\?\.)?\[\s*0\s*\]/g,
        queueFilesOnly: false,
    },
    {
        id: 'find-first-unfinished',
        // .find((a) => ... !a.isDone ...) — the first unfinished entry by position
        pattern: /\.find\(\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>[^;]*?!\s*\1\s*(?:\?\.|\.)isDone\b/g,
        queueFilesOnly: true,
    },
];

/**
 * Deliberate exceptions, by file and rule. Each must say why it is not asking
 * "which action is running".
 */
const ALLOWLIST = [
    {
        file: 'src/features/ui/consumables-panel.js',
        rule: 'find-first-unfinished',
        // _dungeonContext wants the dungeon the character is *about to* run —
        // a dungeon queued behind a running craft counts — so it takes the first
        // unfinished combat action in execution order (the queue is kept sorted),
        // which is not runningCombatAction's question.
        reason: 'next combat action in execution order, running or queued',
    },
];

/** Every non-test .js under src/, so a read cannot move somewhere unscanned */
function sources(directory = srcRoot, found = []) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) sources(path, found);
        else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) found.push(path);
    }
    return found;
}

/**
 * Blank out comments, keeping every newline so match offsets still map to the
 * right line. Doc comments describing the bug would otherwise trip the guard.
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
    const blank = (text) => text.replace(/[^\n]/g, ' ');
    return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[\s;{}(),])\/\/[^\n]*/g, blank);
}

/**
 * Position reads of the queue in one source text.
 * @param {string} source
 * @returns {Array<{rule: string, line: number, text: string}>}
 */
function positionReads(source) {
    const code = stripComments(source);
    const readsQueue = /getCurrentActions|characterActions/.test(code);
    const hits = [];
    for (const rule of RULES) {
        if (rule.queueFilesOnly && !readsQueue) continue;
        for (const match of code.matchAll(rule.pattern)) {
            const line = code.slice(0, match.index).split('\n').length;
            hits.push({ rule: rule.id, line, text: match[0].split('\n')[0].trim() });
        }
    }
    return hits;
}

describe('the patterns', () => {
    const bad = [
        'const a = dm.getCurrentActions?.()?.[0];',
        'const a = dataManager.getCurrentActions()[0];',
        'const a = (dataManager.getCurrentActions?.() || [])[0];',
        'const a = (dataManager.getCurrentActions() ?? [])[0];',
        'const a = characterData.characterActions[0];',
        'const a = data?.characterActions?.[0];',
        'const q = dataManager.getCurrentActions(); const a = q.find((x) => !x.isDone);',
        [
            'const actions = dataManager.getCurrentActions?.();',
            'const combat = actions.find(',
            "    (action) => action?.actionHrid?.startsWith('/actions/combat/') && !action.isDone",
            ');',
        ].join('\n'),
    ];
    const fine = [
        'const a = runningAction(dataManager.getCurrentActions?.() ?? []);',
        'const live = dataManager.getCurrentActions().find((a) => a.actionHrid === hrid);',
        'const open = dataManager.getCurrentActions().filter((a) => !a.isDone);',
        'const t = tasks.find((task) => !task.isDone);',
        '// the bug was getCurrentActions()[0] and actions.find(a => !a.isDone)',
        '/* characterActions[0] */ const n = dataManager.getCurrentActions().length;',
    ];

    test.each(bad)('catches %s', (source) => {
        expect(positionReads(source)).not.toEqual([]);
    });

    test.each(fine)('leaves %s alone', (source) => {
        expect(positionReads(source)).toEqual([]);
    });

    test('names the line the read is on', () => {
        const source = 'const x = 1;\n\nconst a = dataManager.getCurrentActions()[0];\n';
        expect(positionReads(source)).toEqual([
            { rule: 'getCurrentActions-index-0', line: 3, text: 'getCurrentActions()[0]' },
        ]);
    });
});

describe('src/', () => {
    test('reads the running action through runningAction(), never by queue position', () => {
        const repoRoot = join(srcRoot, '..');
        const offenders = [];
        const allowlistUsed = new Set();

        for (const path of sources()) {
            const file = relative(repoRoot, path).split('\\').join('/');
            for (const hit of positionReads(readFileSync(path, 'utf8'))) {
                const allowed = ALLOWLIST.find((entry) => entry.file === file && entry.rule === hit.rule);
                if (allowed) {
                    allowlistUsed.add(allowed);
                    continue;
                }
                offenders.push(`${file}:${hit.line} [${hit.rule}] ${hit.text} — ${FIX}`);
            }
        }

        expect(offenders, `Action queue read by position:\n${offenders.join('\n')}`).toEqual([]);
        // An exception whose read has gone is a hole for the next one to walk through
        const stale = ALLOWLIST.filter((entry) => !allowlistUsed.has(entry)).map(
            (entry) => `${entry.file} [${entry.rule}]`
        );
        expect(stale, 'Allowlist entries that no longer match anything').toEqual([]);
    });
});
