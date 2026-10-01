/**
 * Text Appearance
 *
 * A text size and a font for Toolasha's own surfaces.
 *
 * Every panel here sizes its text in hard-coded pixels, so there is no single
 * font-size to turn up. CSS `zoom` is the one lever that scales all of them at
 * once, and it reflows rather than merely redrawing larger.
 *
 * The zoom goes on a surface's *children*, never on the surface root itself.
 * A zoomed element has its own `left`/`top` multiplied by the zoom while
 * `getBoundingClientRect` and pointer coordinates stay in viewport pixels, so
 * every drag handler in the script (about twenty of them, most hand-written)
 * would place a zoomed root somewhere other than under the pointer, and every
 * stored geometry would mean a different place at each scale. The roots stay
 * unzoomed, so their position, size, drag, resize, viewport clamp and saved
 * geometry are exactly what they were; what grows is the content inside them.
 * The cost is that a panel with a fixed width lays its content out in less
 * room at a larger scale, and scrolls or wraps rather than growing.
 *
 * Canvases are zoomed back to 1. Chart.js measures its container with
 * `getBoundingClientRect` (viewport pixels) and then writes that number as the
 * canvas's CSS width, which inside a zoom draws the chart wider than its box
 * and maps every hover to the wrong point. At an effective zoom of 1 both of
 * those are right again; chart text simply stays at its own size.
 *
 * The game's own text is a different problem with a cleaner lever. The game
 * sizes text through its own custom properties (`--font-size-xs` … `-2xl`, in
 * rem) and everything else — spacing, item tiles, buttons — through other rem
 * values, all against a root font-size its media queries move between 11.2 and
 * 16px. Changing the root size would therefore scale the whole layout, not the
 * text. Redefining the font-size properties on a container scales only the
 * text inside it, with no geometry touched, so the game toggle does that on an
 * allow-list of text-heavy areas and pins the item tiles inside them back to
 * the original sizes.
 */

import config from '../../core/config.js';
import { addStyles, removeStyles } from '../../utils/dom.js';

const STYLE_ID = 'toolasha-text-appearance';

/** Every setting that changes the sheet */
const WATCHED = ['ui_textScale', 'ui_fontFamily', 'ui_gameText', 'ui_gameTextScale'];

/** Offered text sizes, in percent */
export const TEXT_SCALES = [80, 90, 100, 110, 125, 150];

/**
 * Font stacks of fonts that ship with the operating system.
 *
 * Nothing here is fetched: a web font would be a request to a third-party host,
 * and those are opt-in only. Each stack falls back to a generic family, so a
 * machine without the named font still gets the same kind of face.
 */
export const FONT_STACKS = {
    default: '',
    system: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    verdana: 'Verdana, Geneva, "DejaVu Sans", sans-serif',
    tahoma: 'Tahoma, Verdana, "DejaVu Sans", sans-serif',
    arial: 'Arial, Helvetica, "Liberation Sans", sans-serif',
    georgia: 'Georgia, "Times New Roman", "DejaVu Serif", serif',
    mono: 'ui-monospace, Consolas, Menlo, "DejaVu Sans Mono", monospace',
};

/**
 * Roots of Toolasha surfaces whose direct children carry the scale.
 *
 * `data-toolasha-surface` is stamped by `registerFloatingPanel` (every floating
 * panel and the overlay) and by the choice dialog's backdrop. The toast stack
 * is a fixed container whose toasts are its children.
 */
const CHILD_SCALED_ROOTS = ['[data-toolasha-surface]', '#toolasha-toasts'];

/**
 * The command palette's box has its height cap and top margin in viewport
 * units, which `zoom` multiplies — a zoomed box would hang off the bottom of
 * the window. Its own children carry the scale instead.
 */
const GRANDCHILD_SCALED_ROOTS = ['#toolasha-command-palette'];

/** In-flow surfaces that are zoomed whole: no position of their own to break */
const SELF_SCALED = ['#toolasha-settings-content'];

/** The resize grip is sized and placed against the unzoomed root */
const NOT_SCALED = ':not(.toolasha-resize-grip)';

/** Text that is monospace on purpose keeps its face when a font is chosen */
const KEEP_FACE = ':not(code):not(pre):not(kbd):not(samp):not([style*="monospace"])';

/** Offered game text sizes, in percent. Never below 100: the game's own text is the floor */
export const GAME_TEXT_SCALES = [100, 110, 125, 150];

/**
 * The game's font-size custom properties and their values, in rem.
 *
 * Copied from the game's `:root` (main CSS chunk, 2026-10-01). Pinning a fixed
 * layout back means writing these values again, so a game patch that changes
 * one leaves a pinned tile at the old size until this is updated.
 */
export const GAME_FONT_TOKENS = {
    '--font-size-xs': 0.6875,
    '--font-size-sm': 0.8125,
    '--font-size-base': 0.875,
    '--font-size-md': 1,
    '--font-size-lg': 1.125,
    '--font-size-xl': 1.25,
    '--font-size-xl-plus': 1.375,
    '--font-size-2xl': 1.5,
};

/**
 * Match a CSS-module class by its prefix, as the first class or a later one.
 *
 * `[class*=…]` alone would also match a longer module name ending in the same
 * words (`GuildChat_chat__` for `Chat_chat__`).
 *
 * @param {string} prefix - Class prefix up to and including the `__`
 * @returns {string[]} Two selectors that together match the class anywhere
 */
function moduleClass(prefix) {
    return [`[class^="${prefix}"]`, `[class*=" ${prefix}"]`];
}

/**
 * Game areas whose text the game toggle scales. Text-heavy, flowing areas
 * whose containers grow or scroll with their content.
 */
const GAME_TEXT_SCOPES = [
    // Chat: pinned message, tips, warnings and the chat modals use the tokens
    ...moduleClass('Chat_chat__'),
    // Every game tooltip: item, ability, monster, queue, buff, guide
    '.MuiTooltip-popper',
    // The item dictionary
    ...moduleClass('ItemDictionary_modalContent__'),
    // Patch notes and news
    ...moduleClass('PatchNotesText_patchNotesText__'),
    ...moduleClass('NewsText_newsText__'),
];

/**
 * Game text with no font-size of its own, which therefore ignores the tokens:
 * chat messages inherit theirs. Scaled relative to what they inherit.
 */
const GAME_INHERITED_TEXT = moduleClass('Chat_chatChannel__');

/**
 * Fixed layouts inside the scopes, pinned back to the original sizes. An item
 * tile has a fixed size and the item links in chat a fixed line height.
 */
const GAME_FIXED_LAYOUTS = moduleClass('Item_itemContainer__');

/** Game text that is monospace on purpose */
const KEEP_GAME_FACE = `${KEEP_FACE}:not([class*="_itemKey__"])`;

/**
 * Read a percentage setting back as a multiplier.
 * @param {string} key - Setting key
 * @param {number} min - Smallest allowed percentage
 * @param {number} max - Largest allowed percentage
 * @returns {number} The multiplier, 1 when unset or unreadable
 */
function scaleOf(key, min, max) {
    const pct = Number(config.getSettingValue(key, 100));
    if (!Number.isFinite(pct) || pct <= 0) return 1;
    return Math.min(max, Math.max(min, pct)) / 100;
}

/**
 * Round a multiplier for a stylesheet.
 * @param {number} value - Multiplier
 * @returns {string} Up to four decimals, no trailing zeros
 */
function num(value) {
    return String(Number(value.toFixed(4)));
}

/**
 * The selectors that receive the zoom.
 * @returns {string[]} One selector per zoomed element kind
 */
function zoomTargets() {
    return [
        ...CHILD_SCALED_ROOTS.map((root) => `${root} > ${NOT_SCALED}`),
        ...GRANDCHILD_SCALED_ROOTS.map((root) => `${root} > * > *`),
        ...SELF_SCALED,
    ];
}

/**
 * The selectors whose text takes the chosen font.
 * @returns {string[]} Selectors
 */
function fontTargets() {
    const roots = [...CHILD_SCALED_ROOTS, ...GRANDCHILD_SCALED_ROOTS, ...SELF_SCALED];
    return roots.flatMap((root) => [root, `${root} *${KEEP_FACE}`]);
}

/**
 * Build the sheet for Toolasha's own surfaces from the current settings.
 * @returns {string} CSS, empty when both settings are at their defaults
 */
export function buildToolashaTextCSS() {
    const parts = [];

    const scale = scaleOf('ui_textScale', TEXT_SCALES[0], TEXT_SCALES[TEXT_SCALES.length - 1]);
    if (scale !== 1) {
        const targets = zoomTargets();
        parts.push(`${targets.join(',\n')} { zoom: ${num(scale)}; }`);
        parts.push(`${targets.map((target) => `${target} canvas`).join(',\n')} { zoom: ${num(1 / scale)}; }`);
    }

    const stack = FONT_STACKS[config.getSettingValue('ui_fontFamily', 'default')];
    if (stack) {
        // !important because most panels write `font-family` inline
        parts.push(`${fontTargets().join(',\n')} { font-family: ${stack} !important; }`);
    }

    return parts.join('\n');
}

/**
 * The font-size custom properties scaled, or at their originals.
 * @param {number} scale - Multiplier
 * @returns {string} Declarations
 */
function tokenDeclarations(scale) {
    return Object.entries(GAME_FONT_TOKENS)
        .map(([name, rem]) => (scale === 1 ? `${name}: ${rem}rem;` : `${name}: calc(${rem}rem * ${num(scale)});`))
        .join(' ');
}

/**
 * Build the sheet for the game's own text from the current settings.
 * @returns {string} CSS, empty while the game toggle is off
 */
export function buildGameTextCSS() {
    if (!config.getSetting('ui_gameText')) return '';

    const parts = [];

    const scale = scaleOf('ui_gameTextScale', GAME_TEXT_SCALES[0], GAME_TEXT_SCALES[GAME_TEXT_SCALES.length - 1]);
    if (scale !== 1) {
        parts.push(`${GAME_TEXT_SCOPES.join(',\n')} { ${tokenDeclarations(scale)} }`);
        parts.push(`${GAME_INHERITED_TEXT.join(',\n')} { font-size: calc(1em * ${num(scale)}); }`);
        const pinned = GAME_TEXT_SCOPES.flatMap((scope) => GAME_FIXED_LAYOUTS.map((tile) => `${scope} ${tile}`));
        parts.push(`${pinned.join(',\n')} { ${tokenDeclarations(1)} }`);
    }

    const stack = FONT_STACKS[config.getSettingValue('ui_fontFamily', 'default')];
    if (stack) {
        // Universal, because the game's own components set `Roboto` on body,
        // buttons and inputs, and MUI's emotion styles set it on theirs
        parts.push(`body,\nbody *${KEEP_GAME_FACE} { font-family: ${stack} !important; }`);
    }

    return parts.join('\n');
}

const textAppearance = {
    watchers: null,

    apply() {
        const css = [buildToolashaTextCSS(), buildGameTextCSS()].filter(Boolean).join('\n');
        if (css) addStyles(css, STYLE_ID);
        else removeStyles(STYLE_ID);
    },

    initialize() {
        if (!this.watchers) {
            this.watchers = WATCHED.map((key) => {
                const handler = () => this.apply();
                config.onSettingChange(key, handler);
                return { key, handler };
            });
        }
        this.apply();
    },

    disable() {
        removeStyles(STYLE_ID);
        for (const { key, handler } of this.watchers || []) config.offSettingChange(key, handler);
        this.watchers = null;
    },
};

export default textAppearance;
