/**
 * Every source file is UTF-8.
 *
 * The build reads sources as UTF-8, so a byte saved in a Windows code page (an
 * em dash as 0x97) reaches the shipped bundle as U+FFFD. Prettier and ESLint
 * both pass such a file.
 */

import { describe, test, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Text sources the build or the tests read as UTF-8 (CSS is embedded by rollup.config.js) */
const TEXT_EXTENSIONS = ['.js', '.mjs', '.css', '.json', '.md', '.txt', '.html'];

/** Every text source file under a directory */
function allTextFiles(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) out.push(...allTextFiles(path));
        else if (TEXT_EXTENSIONS.some((ext) => name.endsWith(ext))) out.push(path);
    }
    return out;
}

describe('source encoding', () => {
    test('every file under src/ decodes as UTF-8', () => {
        const decoder = new TextDecoder('utf-8', { fatal: true });
        const offenders = allTextFiles('src').filter((file) => {
            try {
                decoder.decode(readFileSync(file));
                return false;
            } catch {
                return true;
            }
        });
        expect(offenders).toEqual([]);
    });
});
