import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAME_COLORS } from './game-look.js';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..');

/** Every non-test .js under src/, so a color cannot move somewhere unscanned */
function sources(directory = srcRoot, found = []) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            if (entry.name !== '__fixtures__') sources(path, found);
        } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) found.push(path);
    }
    return found;
}

describe('the palette Toolasha panels draw with', () => {
    /**
     * Before the game restyle its panels were a navy; they are now a plain near-black with a quieter
     * divider. Controls and boxes that kept the old hard-coded navy read as a grey-and-blue mix against the
     * new fill, so the two old navies are not written out any more. Use GAME_COLORS (utils/game-look.js):
     * inputBackground and inputBorder for a field, box for a section box (the panel's own fill, so only its
     * border marks it), raised and raisedMore for a track, tag, button or stripe that has to sit off the
     * panel, border for its edge, textDim for faint text.
     */
    test('no file hard-codes the old navy fills', () => {
        const old = /#1a1a2e|#2a2a4a|#1b2030|#101420|#1e1e2e|#495268/i;
        const offenders = sources()
            .map((path) => ({ path, lines: readFileSync(path, 'utf8').split('\n') }))
            .flatMap(({ path, lines }) =>
                lines.flatMap((line, index) =>
                    old.test(line) ? [`${relative(srcRoot, path).replaceAll('\\', '/')}:${index + 1}`] : []
                )
            );
        expect(offenders, 'use GAME_COLORS from utils/game-look.js instead of the old navy').toEqual([]);
    });

    test('a field has the panel fill, set off by the game input border', () => {
        expect(GAME_COLORS.inputBackground).toBe(GAME_COLORS.background);
        expect(GAME_COLORS.inputBorder).toBe('#454771');
    });

    test('the raised steps are the game midnight variables with measured fallbacks', () => {
        expect(GAME_COLORS.raised).toBe('var(--color-midnight-800, #191a24)');
        expect(GAME_COLORS.raisedMore).toBe('var(--color-midnight-700, #20212f)');
    });

    test('a section box has the panel fill, not a step lighter', () => {
        expect(GAME_COLORS.box).toBe(GAME_COLORS.background);
        expect(GAME_COLORS.box).not.toBe(GAME_COLORS.raised);
    });

    test('faint text is the game neutral-400, not a grey that falls below readable on the panel', () => {
        expect(GAME_COLORS.textDim).toBe('var(--color-neutral-400, #a1a1a1)');
    });
});
