import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { settingsGroups } from '../../core/settings-schema.js';

/**
 * The settings panel's phone-width rules (issue #731). The panel's CSS lives in one file, so these read the
 * `@media (max-width: 480px)` block as text: a rule that goes missing, or a selector that stops matching a
 * real setting type, fails here rather than on a phone.
 */
const css = readFileSync(fileURLToPath(new URL('./settings-styles.css', import.meta.url)), 'utf8');

/** The body of the phone media block (balanced braces) */
function phoneBlock() {
    const start = css.indexOf('@media (max-width: 480px)');
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = css.indexOf('{', start); i < css.length; i++) {
        if (css[i] === '{') depth++;
        if (css[i] === '}' && --depth === 0) {
            // Comments carry prose with commas and colons that would read as selectors
            return css.slice(css.indexOf('{', start) + 1, i).replace(/\/\*[\s\S]*?\*\//g, '');
        }
    }
    throw new Error('unbalanced phone block');
}

/** The declarations of the first rule in `block` whose selector list contains `selector` */
function declarationsFor(block, selector) {
    for (const match of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selectors = match[1].split(',').map((s) => s.trim());
        if (selectors.includes(selector)) return match[2];
    }
    return null;
}

describe('settings panel at phone width', () => {
    const block = phoneBlock();

    it('puts the search box on its own line so the buttons beside it cannot squeeze it', () => {
        expect(declarationsFor(block, '.toolasha-search-container')).toMatch(/flex-wrap:\s*wrap/);
        const input = declarationsFor(block, '.toolasha-search-container .toolasha-search-input');
        // The input carries an inline `flex: 1`, which only !important overrides
        expect(input).toMatch(/flex:\s*1 1 100%\s*!important/);
        expect(input).toMatch(/font-size:\s*16px\s*!important/);
    });

    it('leaves a long group open all the way down instead of clipping it at 5000px', () => {
        expect(
            declarationsFor(block, '.toolasha-settings-group:not(.collapsed) > .toolasha-settings-group-content')
        ).toMatch(/max-height:\s*none/);
        // A collapsed group must still fold to nothing
        expect(css).toMatch(
            /\.toolasha-settings-group\.collapsed \.toolasha-settings-group-content\s*\{\s*max-height:\s*0/
        );
    });

    it('grows the 16px inline checkbox to a tap target', () => {
        const rule = declarationsFor(block, ".toolasha-setting-input input[type='checkbox']");
        expect(rule).toMatch(/width:\s*24px\s*!important/);
        expect(rule).toMatch(/height:\s*24px\s*!important/);
    });

    it('stacks the label over the control only for rows that hold a field, and those types exist', () => {
        const stackRule = [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find(
            (m) => /flex-direction:\s*column/.test(m[2]) && m[1].includes("data-type='text'")
        );
        expect(stackRule).toBeTruthy();
        const stacked = stackRule[1]
            .split(',')
            .map((s) => /^\.toolasha-setting\[data-type='([A-Za-z]+)'\]$/.exec(s.trim())?.[1])
            .filter(Boolean);
        expect([...stacked].sort()).toEqual(['number', 'password', 'pricingSide', 'select', 'slider', 'text']);

        // Every stacked type is one the schema really renders, so a renamed type cannot silently drop out
        const schemaTypes = new Set(
            Object.values(settingsGroups).flatMap((group) => Object.values(group.settings).map((s) => s.type))
        );
        for (const type of stacked) expect(schemaTypes.has(type)).toBe(true);

        // Switch rows (no type) and button rows stay on one line
        expect(stacked).not.toContain('checkbox');
        expect(stacked).not.toContain('button');
    });

    it('raises help text above the 10px it had', () => {
        expect(declarationsFor(block, '.toolasha-setting-help')).toMatch(/font-size:\s*11px/);
    });
});
