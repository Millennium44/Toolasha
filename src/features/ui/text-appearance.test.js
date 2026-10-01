/**
 * @vitest-environment happy-dom
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { settingsGroups } from '../../core/settings-schema.js';

const state = vi.hoisted(() => ({ values: {}, listeners: new Map() }));

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
    FONT_STACKS,
    TEXT_SCALES,
} = await import('./text-appearance.js');

/** Change a setting the way the settings page does, firing its listeners */
function change(key, value) {
    state.values[key] = value;
    for (const handler of state.listeners.get(key) || []) handler(value);
}

const sheet = () => document.getElementById('toolasha-text-appearance');

beforeEach(() => {
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
        expect(css).toContain('[data-toolasha-surface] > :not(.toolasha-resize-grip)');
        expect(css).toContain('#toolasha-toasts > :not(.toolasha-resize-grip)');
        expect(css).not.toMatch(/\[data-toolasha-surface\]\s*[,{]/);
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
        expect(css).toMatch(/\[data-toolasha-surface\],/);
        expect(css).toContain('[data-toolasha-surface] *:not(code):not(pre)');
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
