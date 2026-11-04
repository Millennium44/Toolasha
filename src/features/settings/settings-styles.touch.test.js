import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The settings panel's touch rules (issue #731): on `(pointer: coarse)` every control is at least 32px tall, at
 * any width. The panel's CSS lives in one file, so these read the media block as text; the rules cannot be
 * measured here, and a rule that goes missing, or a class the panel stopped rendering, fails here instead of on
 * a phone.
 */
const css = readFileSync(fileURLToPath(new URL('./settings-styles.css', import.meta.url)), 'utf8');
const ui = readFileSync(fileURLToPath(new URL('./settings-ui.js', import.meta.url)), 'utf8');

/**
 * The body of the media block that opens with `header` (balanced braces), comments removed
 * @param {string} header - The at-rule prelude, e.g. `@media (pointer: coarse)`
 * @returns {{ body: string, rest: string }} The block's body, and the stylesheet without it
 */
function mediaBlock(header) {
    const start = css.indexOf(header);
    expect(start).toBeGreaterThan(-1);
    const open = css.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
        if (css[i] === '{') depth++;
        if (css[i] === '}' && --depth === 0) {
            return {
                body: css.slice(open + 1, i).replace(/\/\*[\s\S]*?\*\//g, ''),
                rest: (css.slice(0, start) + css.slice(i + 1)).replace(/\/\*[\s\S]*?\*\//g, ''),
            };
        }
    }
    throw new Error('unbalanced media block');
}

/**
 * The declarations of the first rule in `block` whose selector list contains `selector`
 * @param {string} block - CSS text
 * @param {string} selector - One selector from the list
 * @returns {string|null} The declarations, or null when no rule names it
 */
function declarationsFor(block, selector) {
    for (const match of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selectors = match[1].split(',').map((s) => s.trim());
        if (selectors.includes(selector)) return match[2];
    }
    return null;
}

describe('settings panel on a touch screen', () => {
    const { body: coarse, rest: unconditional } = mediaBlock('@media (pointer: coarse)');

    it('grows the switch to 32px past the inline 16px, and leaves no baseline gap under it', () => {
        const rule = declarationsFor(coarse, ".toolasha-setting-input input[type='checkbox']");
        expect(rule).toMatch(/width:\s*32px\s*!important/);
        expect(rule).toMatch(/height:\s*32px\s*!important/);
        expect(rule).toMatch(/display:\s*block/);
    });

    it('gives the row, its input cell and every field type a 32px floor', () => {
        expect(declarationsFor(coarse, '.toolasha-setting')).toMatch(/min-height:\s*34px/);
        expect(declarationsFor(coarse, '.toolasha-setting-input')).toMatch(/min-height:\s*32px/);
        // The inline-styled pricing and tier selects have no class, so they are reached through the cell
        expect(declarationsFor(coarse, '.toolasha-setting-input select')).toMatch(/min-height:\s*32px/);
        expect(declarationsFor(coarse, '.toolasha-select-input')).toMatch(/min-height:\s*32px/);
        expect(declarationsFor(coarse, '.toolasha-text-input')).toMatch(/min-height:\s*32px/);
        expect(declarationsFor(coarse, '.toolasha-number-input')).toMatch(/min-height:\s*32px/);
        expect(declarationsFor(coarse, ".toolasha-setting-input input[type='number']")).toMatch(/min-height:\s*32px/);
        expect(declarationsFor(coarse, '.toolasha-color-text-input')).toMatch(/min-height:\s*32px/);
        expect(declarationsFor(coarse, '.toolasha-color-input')).toMatch(/height:\s*32px/);
    });

    it('overrides the inline sizes of the color text box and the gear level box', () => {
        // Both carry `style="..."` (width 80px / font-size 12px), which only !important beats
        const colorText = [...coarse.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
            .filter((m) => m[1].split(',').some((s) => s.trim() === '.toolasha-color-text-input'))
            .map((m) => m[2])
            .join('\n');
        expect(colorText).toMatch(/font-size:\s*16px\s*!important/);
        expect(colorText).toMatch(/width:\s*[0-9]+px\s*!important/);
        expect(declarationsFor(coarse, ".toolasha-setting-input input[type='number']")).toMatch(
            /font-size:\s*16px\s*!important/
        );
    });

    it('keeps the action buttons and the range slider at 32px too', () => {
        for (const selector of [
            '.toolasha-slider-input',
            '.toolasha-setting-action-btn',
            '.toolasha-template-edit-btn',
            '.toolasha-custom-price-edit-btn',
            '.toolasha-scroll-defaults-btn',
            '.toolasha-text-vars-btn',
        ]) {
            expect(declarationsFor(coarse, selector), selector).toMatch(/min-height:\s*32px/);
        }
    });

    it("keeps the phone block's 34px on a touch phone, since the touch floor comes after it", () => {
        const last = css.lastIndexOf('@media (pointer: coarse) and (max-width: 480px)');
        expect(last).toBeGreaterThan(css.lastIndexOf('@media (pointer: coarse) {'));
        expect(css.slice(last)).toMatch(/\.toolasha-setting-input select[\s\S]*min-height:\s*34px/);
    });

    it('changes nothing for a fine pointer: none of the 32px rules sit outside a media query', () => {
        // The phone-width block is its own query (and was there before); take it out too
        const { rest } = (() => {
            const start = unconditional.indexOf('@media (max-width: 480px)');
            return { rest: start === -1 ? unconditional : unconditional.slice(0, start) };
        })();
        expect(rest).not.toMatch(/32px\s*!important/);
        expect(rest).not.toMatch(/min-height:\s*32px/);
        expect(rest).not.toMatch(/font-size:\s*16px\s*!important/);
    });

    it('names classes the panel really renders', () => {
        for (const cls of [
            'toolasha-color-input',
            'toolasha-color-text-input',
            'toolasha-number-input',
            'toolasha-select-input',
            'toolasha-text-input',
            'toolasha-slider-input',
            'toolasha-setting-action-btn',
            'toolasha-template-edit-btn',
            'toolasha-custom-price-edit-btn',
            'toolasha-scroll-defaults-btn',
            'toolasha-text-vars-btn',
            'toolasha-setting-input',
        ]) {
            expect(ui, cls).toContain(cls);
        }
    });
});
