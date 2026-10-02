/**
 * @vitest-environment happy-dom
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { settingsGroups } from '../../core/settings-schema.js';

const state = vi.hoisted(() => ({ values: {}, listeners: new Map(), refits: 0 }));

vi.mock('./overlay-panel.js', () => ({
    default: {
        refit: () => {
            state.refits += 1;
        },
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => state.values[key] === true,
        getSettingValue: (key, fallback) => (key in state.values ? state.values[key] : fallback),
        onSettingChange: (key, handler) => {
            if (!state.listeners.has(key)) state.listeners.set(key, new Set());
            state.listeners.get(key).add(handler);
        },
        offSettingChange: (key, handler) => state.listeners.get(key)?.delete(handler),
    },
}));

const {
    default: textAppearance,
    buildToolashaTextCSS,
    buildGameTextCSS,
    FONT_STACKS,
    TEXT_SCALES,
    GAME_TEXT_SCALES,
    GAME_FONT_TOKENS,
} = await import('./text-appearance.js');

/** Change a setting the way the settings page does, firing its listeners */
function change(key, value) {
    state.values[key] = value;
    for (const handler of state.listeners.get(key) || []) handler(value);
}

const sheet = () => document.getElementById('toolasha-text-appearance');

beforeEach(() => {
    state.refits = 0;
    for (const key of Object.keys(state.values)) delete state.values[key];
});

afterEach(() => {
    textAppearance.disable();
    state.listeners.clear();
});

describe('defaults', () => {
    test('the schema ships 100% and the unchanged font', () => {
        const ui = settingsGroups.ui.settings;
        expect(ui.ui_textScale.default).toBe('100');
        expect(ui.ui_fontFamily.default).toBe('default');
    });

    test('every offered option maps onto something the module knows', () => {
        const ui = settingsGroups.ui.settings;
        expect(ui.ui_textScale.options.map((option) => Number(option.value))).toEqual(TEXT_SCALES);
        expect(ui.ui_fontFamily.options.map((option) => option.value).sort()).toEqual(Object.keys(FONT_STACKS).sort());
    });

    test('at the defaults there is no stylesheet at all', () => {
        expect(buildToolashaTextCSS()).toBe('');
        state.values.ui_textScale = '100';
        state.values.ui_fontFamily = 'default';
        expect(buildToolashaTextCSS()).toBe('');

        textAppearance.initialize();
        expect(sheet()).toBeNull();
    });
});

describe('text size', () => {
    test('zooms the children of each surface, never the surface root', () => {
        state.values.ui_textScale = '125';
        const css = buildToolashaTextCSS();

        // A zoomed root has its own left/top multiplied, which would put every
        // dragged panel somewhere other than under the pointer
        expect(css).toContain(
            '[data-toolasha-surface]:not([data-toolasha-surface="modal"]) > :not(.toolasha-resize-grip)'
        );
        expect(css).toContain('#toolasha-toasts > :not(.toolasha-resize-grip)');
        expect(css).not.toMatch(/\[data-toolasha-surface\]\s*[,{]/);
        expect(css).not.toMatch(/\[data-toolasha-surface\]:not\(\[data-toolasha-surface="modal"\]\)\s*[,{]/);
        expect(css).toContain('zoom: 1.25;');
    });

    test('the palette scales below its box, whose caps are in viewport units', () => {
        state.values.ui_textScale = '150';
        const css = buildToolashaTextCSS();
        expect(css).toContain('#toolasha-command-palette > * > *');
        expect(css).not.toMatch(/#toolasha-command-palette > \*\s*[,{]/);
    });

    test('the in-flow settings page is zoomed whole', () => {
        state.values.ui_textScale = '90';
        expect(buildToolashaTextCSS()).toContain('#toolasha-settings-content');
        expect(buildToolashaTextCSS()).toContain('zoom: 0.9;');
    });

    test('canvases are zoomed back to an effective 1', () => {
        state.values.ui_textScale = '125';
        expect(buildToolashaTextCSS()).toMatch(/canvas \{ zoom: 0\.8; \}/);
        state.values.ui_textScale = '150';
        expect(buildToolashaTextCSS()).toMatch(/canvas \{ zoom: 0\.6667; \}/);
    });

    test('a stored value outside the offered range is clamped, and nonsense is ignored', () => {
        state.values.ui_textScale = '400';
        expect(buildToolashaTextCSS()).toContain('zoom: 1.5;');
        state.values.ui_textScale = '10';
        expect(buildToolashaTextCSS()).toContain('zoom: 0.8;');
        state.values.ui_textScale = 'huge';
        expect(buildToolashaTextCSS()).toBe('');
    });
});

describe('font', () => {
    test('each choice writes its local stack and nothing else', () => {
        state.values.ui_fontFamily = 'verdana';
        const css = buildToolashaTextCSS();
        expect(css).toContain(`font-family: ${FONT_STACKS.verdana} !important;`);
        expect(css).not.toContain('zoom');
    });

    test('no stack reaches for a downloaded font', () => {
        for (const stack of Object.values(FONT_STACKS)) {
            expect(stack).not.toMatch(/url\(|@import|https?:/);
        }
        state.values.ui_fontFamily = 'system';
        expect(buildToolashaTextCSS()).not.toMatch(/@font-face|@import|url\(/);
    });

    test('covers the surface roots and their descendants, sparing monospace text', () => {
        state.values.ui_fontFamily = 'georgia';
        const css = buildToolashaTextCSS();
        expect(css).toContain('[data-toolasha-surface]:not([data-toolasha-surface="modal"]),');
        expect(css).toContain('[data-toolasha-surface]:not([data-toolasha-surface="modal"]) *:not(code):not(pre)');
        expect(css).toContain(':not([style*="monospace"])');
        expect(css).toContain('#toolasha-settings-content *');
    });

    test('an unknown stored choice falls back to unchanged', () => {
        state.values.ui_fontFamily = 'comic-sans';
        expect(buildToolashaTextCSS()).toBe('');
    });
});

describe('applying', () => {
    test('a change applies live and going back to the defaults removes the sheet', () => {
        textAppearance.initialize();
        expect(sheet()).toBeNull();

        change('ui_textScale', '125');
        expect(sheet().textContent).toContain('zoom: 1.25;');

        change('ui_fontFamily', 'tahoma');
        expect(sheet().textContent).toContain(FONT_STACKS.tahoma);
        expect(document.querySelectorAll('#toolasha-text-appearance')).toHaveLength(1);

        change('ui_textScale', '100');
        expect(sheet().textContent).not.toContain('zoom');

        change('ui_fontFamily', 'default');
        expect(sheet()).toBeNull();
    });

    test('initializing twice does not stack listeners', () => {
        textAppearance.initialize();
        textAppearance.initialize();
        expect(state.listeners.get('ui_textScale').size).toBe(1);
        expect(state.listeners.get('ui_fontFamily').size).toBe(1);
    });

    test('disable removes the sheet and stops listening', () => {
        state.values.ui_textScale = '150';
        textAppearance.initialize();
        expect(sheet()).not.toBeNull();

        textAppearance.disable();
        expect(sheet()).toBeNull();
        expect(state.listeners.get('ui_textScale').size).toBe(0);

        change('ui_textScale', '80');
        expect(sheet()).toBeNull();
    });
});

describe('game text', () => {
    test('ships off at 100%, and the offered sizes are the ones the module knows', () => {
        const ui = settingsGroups.ui.settings;
        expect(ui.ui_gameText.default).toBe(false);
        expect(ui.ui_gameTextScale.default).toBe('100');
        expect(ui.ui_gameTextScale.options.map((option) => Number(option.value))).toEqual(GAME_TEXT_SCALES);
    });

    test('while the toggle is off nothing touches the game, whatever else is set', () => {
        state.values.ui_gameTextScale = '150';
        state.values.ui_fontFamily = 'verdana';
        expect(buildGameTextCSS()).toBe('');
        expect(buildToolashaTextCSS()).not.toContain('body');
    });

    test('on at 100% with the default font it still writes nothing', () => {
        state.values.ui_gameText = true;
        expect(buildGameTextCSS()).toBe('');
    });

    test('scales the font-size properties on the text areas, never the root size or any geometry', () => {
        state.values.ui_gameText = true;
        state.values.ui_gameTextScale = '125';
        const css = buildGameTextCSS();

        // The game sizes its whole layout in rem, so a root font-size change
        // would resize item tiles and spacing along with the text
        expect(css).not.toMatch(/(^|[\s,])(html|:root)\s*[,{]/);
        expect(css).not.toContain('zoom');
        expect(css).toContain('.MuiTooltip-popper');
        expect(css).toContain('[class^="Chat_chat__"]');
        expect(css).toContain('--font-size-base: calc(0.875rem * 1.25);');
        expect(css).toContain('--font-size-xs: calc(0.6875rem * 1.25);');
    });

    test('chat messages, which inherit their size, scale relative to it', () => {
        state.values.ui_gameText = true;
        state.values.ui_gameTextScale = '150';
        expect(buildGameTextCSS()).toMatch(/\[class\*=" Chat_chatChannel__"\] \{ font-size: calc\(1em \* 1\.5\); \}/);
    });

    test('item tiles inside a scaled area are pinned back to the original sizes', () => {
        state.values.ui_gameText = true;
        state.values.ui_gameTextScale = '150';
        const css = buildGameTextCSS();
        const originals = Object.entries(GAME_FONT_TOKENS)
            .map(([name, rem]) => `${name}: ${rem}rem;`)
            .join(' ');
        expect(css).toContain(`.MuiTooltip-popper [class^="Item_itemContainer__"]`);
        expect(css).toContain(`{ ${originals} }`);
    });

    test('module classes are matched by prefix, never as a substring of a longer name', () => {
        state.values.ui_gameText = true;
        state.values.ui_gameTextScale = '110';
        const css = buildGameTextCSS();
        expect(css).not.toContain('[class*="Chat_chat__"]');
        expect(css).not.toMatch(/__[A-Za-z0-9]{5}/);
    });

    test('a size below 100 is not offered and not applied', () => {
        state.values.ui_gameText = true;
        state.values.ui_gameTextScale = '80';
        expect(buildGameTextCSS()).toBe('');
    });

    test('the chosen font reaches every game element, sparing monospace', () => {
        state.values.ui_gameText = true;
        state.values.ui_fontFamily = 'arial';
        const css = buildGameTextCSS();
        expect(css).toContain(`body *:not(code)`);
        expect(css).toContain(':not([class*="_itemKey__"])');
        expect(css).toContain(`font-family: ${FONT_STACKS.arial} !important;`);
    });

    test('turning the toggle on and off applies and removes it live', () => {
        state.values.ui_gameTextScale = '125';
        textAppearance.initialize();
        expect(sheet()).toBeNull();

        change('ui_gameText', true);
        expect(sheet().textContent).toContain('MuiTooltip-popper');

        change('ui_gameTextScale', '150');
        expect(sheet().textContent).toContain('calc(0.875rem * 1.5)');

        change('ui_gameText', false);
        expect(sheet()).toBeNull();
    });
});

describe('a text scale change while the overlay is docked', () => {
    test('refits the overlay after layout, once per change, and not on the initial apply', async () => {
        textAppearance.initialize();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        // Frames queued by earlier tests' changes may land here; only this test's count matters
        state.refits = 0;

        change('ui_textScale', 125);
        // The stylesheet is already there; the refit waits for the frame so it measures the new layout
        expect(sheet()).not.toBeNull();
        expect(state.refits).toBe(0);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        await new Promise((resolve) => requestAnimationFrame(resolve));
        expect(state.refits).toBe(1);
    });
});

describe('monospace subtrees keep their face', () => {
    test('the font rule excludes descendants of a monospace container, not only the container', () => {
        state.values.ui_fontFamily = 'verdana';
        const css = buildToolashaTextCSS();
        expect(css).toContain(':not(:is(code, pre, kbd, samp, [style*="monospace"]) *)');
    });

    test('a plain element takes the font and a monospace container does not', () => {
        state.values.ui_fontFamily = 'verdana';
        const css = buildToolashaTextCSS();
        document.body.innerHTML =
            '<div data-toolasha-surface="panel"><div id="plain">a</div>' +
            '<div style="font-family:monospace"><div id="row">b</div></div></div>';
        const rule = css
            .split('{')[0]
            .split(/,\s*(?=\[data|#)/)
            .map((selector) => selector.trim());
        const matches = (el) => rule.some((selector) => el.matches(selector));
        expect(matches(document.getElementById('plain'))).toBe(true);
        // happy-dom cannot evaluate `:not(:is(...) *)`, so a descendant row cannot be matched here; the
        // selector text is asserted above and the descendant case is covered by the engine's own support
        expect(matches(document.querySelector('[style*="monospace"]'))).toBe(false);
        document.body.innerHTML = '';
    });
});

describe('marked surfaces', () => {
    test('a marked element is matched by the zoom rule and an unmarked one is not', () => {
        state.values.ui_textScale = '150';
        const css = buildToolashaTextCSS();
        const zoomRule = css.slice(0, css.indexOf('{'));
        const selectors = zoomRule.split(',\n').map((selector) => selector.trim());
        document.body.innerHTML =
            '<div id="marked" data-toolasha-surface="popover"><p id="in">a</p></div><div id="bare"><p id="out">b</p></div>';
        const matches = (el) => selectors.some((selector) => el.matches(selector));
        expect(matches(document.getElementById('in'))).toBe(true);
        expect(matches(document.getElementById('marked'))).toBe(false);
        expect(matches(document.getElementById('out'))).toBe(false);
        document.body.innerHTML = '';
    });

    test('a modal backdrop zooms the children of the modal box, not the box, whose caps are in viewport units', () => {
        state.values.ui_textScale = '150';
        const css = buildToolashaTextCSS();
        expect(css).toContain('[data-toolasha-surface="modal"] > * > *');
        document.body.innerHTML = '<div data-toolasha-surface="modal"><div id="box"><p id="body">a</p></div></div>';
        const zoomRule = css
            .slice(0, css.indexOf('{'))
            .split(',\n')
            .map((selector) => selector.trim());
        const matches = (el) => zoomRule.some((selector) => el.matches(selector));
        expect(matches(document.getElementById('box'))).toBe(false);
        expect(matches(document.getElementById('body'))).toBe(true);
        document.body.innerHTML = '';
    });

    test('a modal box scrolls instead of clipping the grown content, and only when a size is applied', () => {
        state.values.ui_textScale = '150';
        expect(buildToolashaTextCSS()).toContain(
            '[data-toolasha-surface="modal"] > * { overflow-y: auto !important; }'
        );
        state.values.ui_textScale = '100';
        expect(buildToolashaTextCSS()).not.toContain('"modal"] > *');
    });

    test('the font reaches a modal and its descendants', () => {
        state.values.ui_fontFamily = 'verdana';
        const css = buildToolashaTextCSS();
        expect(css).toContain('[data-toolasha-surface="modal"],');
        expect(css).toContain('[data-toolasha-surface="modal"] *:not(code)');
    });
});

describe('the choice dialog at a zoomed scale', () => {
    test('is capped to its backdrop with a percentage, not a viewport unit', () => {
        state.values.ui_textScale = 150;
        const css = buildToolashaTextCSS();
        const rule = css.slice(css.indexOf('[data-toolasha-surface="dialog"] > * {'));
        expect(rule).toContain('max-width: min(494px, 100%) !important');
        expect(rule).toContain('min-width: min(354px, 100%) !important');
        expect(rule).not.toContain('vw');
    });

    test('adds nothing at 100%', () => {
        expect(buildToolashaTextCSS()).not.toContain('"dialog"] > *');
    });
});

describe('review round 3', () => {
    test('a canvas that is itself a zoom target is excluded from the zoom rule', () => {
        state.values.ui_textScale = '150';
        const css = buildToolashaTextCSS();
        const zoomRule = css.split('{')[0];
        expect(zoomRule).toContain(':not(canvas)');
        document.body.innerHTML = '<div data-toolasha-surface="panel"><canvas id="c"></canvas><div id="d"></div></div>';
        const selectors = zoomRule.split(/,\s*(?=\[data|#)/).map((selector) => selector.trim());
        const zoomed = (el) => selectors.some((selector) => el.matches(selector));
        expect(zoomed(document.getElementById('c'))).toBe(false);
        expect(zoomed(document.getElementById('d'))).toBe(true);
        document.body.innerHTML = '';
    });

    test('a canvas that is a grandchild of a modal keeps no zoom either', () => {
        state.values.ui_textScale = '150';
        const zoomRule = buildToolashaTextCSS().split('{')[0];
        document.body.innerHTML =
            '<div data-toolasha-surface="modal"><div><canvas id="c"></canvas><div id="d"></div></div></div>';
        const selectors = zoomRule.split(/,\s*(?=\[data|#)/).map((selector) => selector.trim());
        const zoomed = (el) => selectors.some((selector) => el.matches(selector));
        expect(zoomed(document.getElementById('c'))).toBe(false);
        expect(zoomed(document.getElementById('d'))).toBe(true);
        document.body.innerHTML = '';
    });

    test('publishes the zoom for vh caps inside zoomed children, and only while scaled', () => {
        state.values.ui_textScale = '150';
        expect(buildToolashaTextCSS()).toContain(':root { --toolasha-text-zoom: 1.5; }');
        state.values.ui_textScale = '100';
        expect(buildToolashaTextCSS()).not.toContain('--toolasha-text-zoom');
    });

    test('publishes the chosen font stack for item-tile badges, and only while a font is chosen', () => {
        state.values.ui_fontFamily = 'verdana';
        expect(buildToolashaTextCSS()).toContain(`:root { --toolasha-font-stack: ${FONT_STACKS.verdana}; }`);
        state.values.ui_fontFamily = 'default';
        expect(buildToolashaTextCSS()).not.toContain('--toolasha-font-stack');
    });

    test('the game font rule does not reach into Toolasha surfaces', () => {
        state.values.ui_gameText = true;
        state.values.ui_fontFamily = 'verdana';
        const css = buildGameTextCSS();
        expect(css).toContain(
            ':not(:is([data-toolasha-surface]:not([data-toolasha-surface="modal"]), #toolasha-toasts'
        );
        for (const root of ['#toolasha-command-palette', '#toolasha-settings-content']) expect(css).toContain(root);
        expect(css.trimEnd()).toMatch(/\) \*\) \{ font-family: [^}]+ !important; \}$/);
    });

    test('text set directly on a popover root is wrapped so the text zoom reaches it', async () => {
        const fs = await import('node:fs');
        const sources = [
            '../actions/tea-recommendation.js',
            '../combat/dungeon-tracker-ui-interactions.js',
            '../market/market-history-viewer.js',
        ];
        for (const rel of sources) {
            const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
            expect(src).not.toMatch(/(popup|notification|progressMsg)\.textContent\s*=/);
        }
    });
});
