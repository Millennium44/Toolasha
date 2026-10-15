import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

// lab-sim-ui.js is inlined into a bundle that does not own the combat sim panel,
// where combat-sim-ui.js is replaced by Toolasha.Sim.combatSimUI — the default
// instance only. Every helper it reaches must be hung off that instance.
const read = (name) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');

describe('lab sim reaches combat-sim-ui through its default instance', () => {
    const labSource = read('./lab-sim-ui.js');
    const uiSource = read('./combat-sim-ui.js');

    it('takes no named imports from combat-sim-ui', () => {
        expect(labSource).not.toMatch(/import\s+combatSimUI\s*,\s*\{[^}]*\}\s*from\s+'\.\/combat-sim-ui\.js'/);
        expect(labSource).not.toMatch(/import\s*\{[^}]*\}\s*from\s+'\.\/combat-sim-ui\.js'/);
    });

    it('every combatSimUI.<helper> it uses is attached to the instance', () => {
        const assigned = uiSource.match(/Object\.assign\(combatSimUI, \{([^}]*)\}\)/)[1];
        const handles = new Set(
            assigned
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean)
        );
        const methods = new Set([...uiSource.matchAll(/^ {4}(?:async )?(\w+)\(/gm)].map((m) => m[1]));
        const used = new Set([...labSource.matchAll(/combatSimUI\.(\w+)/g)].map((m) => m[1]));
        const missing = [...used].filter((name) => !handles.has(name) && !methods.has(name));
        expect(missing).toEqual([]);
    });
});
