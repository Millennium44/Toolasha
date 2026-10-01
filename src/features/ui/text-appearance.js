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
 */

import config from '../../core/config.js';
import { addStyles, removeStyles } from '../../utils/dom.js';

const STYLE_ID = 'toolasha-text-appearance';

/** Every setting that changes the sheet */
const WATCHED = ['ui_textScale', 'ui_fontFamily'];

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

const textAppearance = {
    watchers: null,

    apply() {
        const css = buildToolashaTextCSS();
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
