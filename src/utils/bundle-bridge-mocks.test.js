/**
 * Every test that replaces utils/bundle-bridge.js with a literal factory stubs the
 * `guildMemberSkills` accessor, so a suite whose import graph later reaches the Trial Sim's
 * Assign view (which calls it at draw time) does not break on a missing export. A factory that
 * spreads `importOriginal()` inherits it.
 */
import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('..', import.meta.url));

function testFiles(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) out.push(...testFiles(path));
        else if (name.endsWith('.test.js')) out.push(path);
    }
    return out;
}

/** The text of each `vi.mock(<bundle-bridge>, factory)` call, up to its closing parenthesis */
function bridgeMocks(source) {
    const calls = [];
    const pattern = /vi\.mock\(\s*['"][^'"]*bundle-bridge\.js['"]\s*,/g;
    for (const match of source.matchAll(pattern)) {
        let depth = 1;
        let i = match.index + 'vi.mock('.length;
        for (; i < source.length && depth > 0; i++) {
            if (source[i] === '(') depth++;
            else if (source[i] === ')') depth--;
        }
        calls.push(source.slice(match.index, i));
    }
    return calls;
}

describe('bundle-bridge mock factories', () => {
    test('stub guildMemberSkills or inherit it', () => {
        const missing = [];
        for (const file of testFiles(SRC)) {
            for (const call of bridgeMocks(readFileSync(file, 'utf8'))) {
                if (!/guildMemberSkills|importOriginal|importActual/.test(call))
                    missing.push(relative(SRC, file).split(sep).join('/'));
            }
        }
        expect(missing).toEqual([]);
    });
});
