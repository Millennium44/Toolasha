/**
 * The per-player markers on a ranked board, and the menu a click on one opens.
 *
 * Two boards draw players — the Per-player panel and the trial scoreboard — and
 * both rebuild their body from one HTML string every few seconds. So the
 * markers are strings (a colour dot, the class chip with any override applied),
 * the click is one delegated capture-phase listener on the board's container
 * that survives the rebuilds, and the menu itself lives on `document.body`,
 * outside anything a redraw replaces.
 *
 * Capture phase because the trial board's rows open their per-ability
 * breakdown on click: a click on a marker is a request for the menu and must
 * not also toggle the row it sits in.
 *
 * The click-to-change menu with an "automatic" entry, the swatch row and the
 * free colour input are KikiMeter's (ZhuLiMoon, MIT). The code is Toolasha's.
 */

import config from '../core/config.js';
import { CLASS_BUCKETS } from './class-inference.js';
import { applyClassOverride, classOverrideFor, setClassOverride } from './class-override.js';
import { classTagIconHTML } from './class-weapon.js';
import { BOARD_COLORS, escapeText } from './damage-board.js';
import { registerEscapeClose } from './panel-escape.js';
import { PLAYER_PALETTE, pickedColor, playerColor, setPlayerColor } from './player-colors.js';

/** Carried by every marker; its value is the player's name */
export const PLAYER_ATTR = 'data-toolasha-player';

/** The menu's class, so a test or a teardown can find it */
export const MENU_CLASS = 'toolasha-player-menu';

/**
 * Which of the two identity features are switched on.
 * @returns {{colors: boolean, classes: boolean}}
 */
export function playerIdentityOptions() {
    return {
        colors: config.getSetting('combatPlayerColors') === true,
        classes: config.getSetting('combatClassOverride') === true,
    };
}

/**
 * The colour a board row's bar should take: the player's own when colours are on.
 * @param {string} name - Player name
 * @param {string} fallback - What the board drew before
 * @returns {string}
 */
export function playerRowColor(name, fallback) {
    return playerIdentityOptions().colors && name ? playerColor(name) : fallback;
}

/**
 * The chip for a class the user set: the same weapon drawing, with a title that
 * says who decided, or a text chip underlined to tell it from an inferred one.
 * @param {Object} verdict - From `applyClassOverride`, with `manual`
 * @returns {string} HTML
 */
function manualTagHTML(verdict) {
    const label = String(verdict?.short || '').replace(/[^A-Z]/g, '');
    if (!label) return '';
    const title = `${label} — set by you. Click to change it, or to go back to the inferred class.`;
    const icon = classTagIconHTML(verdict, { title, size: 13 });
    if (icon) return icon;
    const { accent } = BOARD_COLORS;
    return (
        `<span title="${title}" style="color:${accent}; font-size:9px; letter-spacing:0.5px; ` +
        `border:1px solid ${accent}; border-radius:3px; padding:0 3px; text-decoration:underline;">${label}</span>`
    );
}

/**
 * A row's colour dot and class chip, ready to sit after the name.
 *
 * @param {string} name - Player name, off the wire (escaped here)
 * @param {Object|null} verdict - The inferred verdict
 * @param {Function} renderTag - The board's own chip renderer for an inferred verdict
 * @returns {string} HTML
 */
export function playerMarkersHTML(name, verdict, renderTag) {
    const { colors, classes } = playerIdentityOptions();
    const shown = classes ? applyClassOverride(name, verdict) : verdict;
    const tag = shown?.manual ? manualTagHTML(shown) : renderTag(shown);
    if (!name || (!colors && !classes)) return tag;

    const attr = `${PLAYER_ATTR}="${escapeText(name)}"`;
    const dot = colors
        ? `<span ${attr} title="Click to set this player’s colour or class." style="display:inline-block; ` +
          `width:8px; height:8px; border-radius:50%; flex:0 0 auto; align-self:center; cursor:pointer; ` +
          `background:${playerColor(name)};"></span>`
        : `<span ${attr} title="Click to set this player’s class." style="display:inline-block; width:7px; ` +
          `height:7px; border-radius:50%; flex:0 0 auto; align-self:center; cursor:pointer; ` +
          `border:1px solid ${BOARD_COLORS.dim};"></span>`;
    const chip = tag && classes ? `<span ${attr} style="display:inline-flex; cursor:pointer;">${tag}</span>` : tag;
    return dot + chip;
}

/** Board container → the options its delegated listener reads */
const wired = new WeakMap();

/**
 * Open the menu from any marker inside a board, once per container.
 *
 * Safe to call on every redraw: the listener is added the first time and only
 * its `onChange` is updated after that.
 *
 * @param {HTMLElement} root - The board's container, which outlives its innerHTML
 * @param {Function} onChange - Redraw after a choice
 */
export function wirePlayerMenu(root, onChange) {
    if (!root?.addEventListener) return;
    if (wired.has(root)) {
        wired.get(root).onChange = onChange;
        return;
    }
    const options = { onChange };
    wired.set(root, options);
    root.addEventListener(
        'click',
        (event) => {
            const marker = event.target?.closest?.(`[${PLAYER_ATTR}]`);
            if (!marker || !root.contains(marker)) return;
            event.stopPropagation();
            event.preventDefault();
            openPlayerMenu(marker, marker.getAttribute(PLAYER_ATTR), options.onChange);
        },
        true
    );
}

/** The open menu and how to close it */
let current = null;

/** Close the menu, if one is open */
export function closePlayerMenu() {
    if (!current) return;
    const { element, escape, outside } = current;
    current = null;
    escape?.release();
    document.removeEventListener('mousedown', outside, true);
    element.remove();
}

/**
 * A small button for the menu.
 * @param {string} label - Text
 * @param {boolean} on - Whether it is the current choice
 * @returns {HTMLButtonElement}
 */
function menuButton(label, on) {
    const button = document.createElement('button');
    button.textContent = label;
    const color = on ? BOARD_COLORS.accent : BOARD_COLORS.dim;
    button.style.cssText =
        `cursor:pointer; padding:2px 5px; border-radius:3px; font-size:10px; color:${color};` +
        `border:1px solid ${on ? color : 'rgba(255,255,255,0.15)'}; background:${on ? `${color}22` : 'transparent'};`;
    return button;
}

/**
 * Open the class and colour menu for one player, beside the marker clicked.
 *
 * @param {HTMLElement} anchor - The marker
 * @param {string} name - Player name
 * @param {Function} [onChange] - Redraw after a choice
 * @returns {HTMLElement|null} The menu
 */
export function openPlayerMenu(anchor, name, onChange = () => {}) {
    closePlayerMenu();
    if (!name) return null;
    const { colors, classes } = playerIdentityOptions();
    if (!colors && !classes) return null;

    const changed = () => {
        try {
            onChange?.();
        } catch (error) {
            console.error('[PlayerMenu] Redraw after a choice failed:', error);
        }
    };

    const menu = document.createElement('div');
    menu.className = MENU_CLASS;
    menu.style.cssText =
        `position:fixed; z-index:${config.Z_POPUP + 1}; width:196px; padding:7px 8px; border-radius:6px;` +
        'background:rgba(18,20,28,0.98); border:1px solid rgba(255,255,255,0.18); color:#e8ecf5;' +
        'box-shadow:0 6px 20px rgba(0,0,0,0.5); font-size:11px; display:flex; flex-direction:column; gap:6px;';

    const title = document.createElement('div');
    title.textContent = name;
    title.style.cssText = `font-weight:700; color:${playerColor(name)}; overflow:hidden; text-overflow:ellipsis;`;
    menu.appendChild(title);

    if (classes) {
        const set = classOverrideFor(name);
        const heading = document.createElement('div');
        heading.textContent = 'Class';
        heading.style.color = BOARD_COLORS.dim;
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; flex-wrap:wrap; gap:3px;';

        const auto = menuButton('Automatic', !set);
        auto.dataset.class = '';
        auto.title = 'Go back to the class inferred from what this player casts.';
        row.appendChild(auto);
        for (const bucket of Object.values(CLASS_BUCKETS)) {
            const button = menuButton(bucket.label, set === bucket.key);
            button.dataset.class = bucket.key;
            row.appendChild(button);
        }
        row.addEventListener('click', (event) => {
            const button = event.target.closest('button');
            if (!button || button.dataset.class === undefined) return;
            setClassOverride(name, button.dataset.class || null);
            closePlayerMenu();
            changed();
        });
        menu.append(heading, row);
    }

    if (colors) {
        const set = pickedColor(name);
        const heading = document.createElement('div');
        heading.textContent = 'Colour';
        heading.style.color = BOARD_COLORS.dim;
        const row = document.createElement('div');
        row.style.cssText = 'display:flex; flex-wrap:wrap; gap:3px; align-items:center;';

        for (const color of PLAYER_PALETTE) {
            const swatch = document.createElement('button');
            swatch.dataset.color = color;
            swatch.title = color;
            swatch.style.cssText =
                `width:14px; height:14px; padding:0; border-radius:3px; cursor:pointer; background:${color};` +
                `border:${set === color ? '2px solid #fff' : '1px solid rgba(255,255,255,0.2)'};`;
            row.appendChild(swatch);
        }
        const custom = document.createElement('input');
        custom.type = 'color';
        custom.value = set || playerColor(name);
        custom.title = 'Any colour. One too dark to read is lightened.';
        custom.style.cssText = 'width:20px; height:16px; padding:0; border:none; background:none; cursor:pointer;';
        custom.addEventListener('input', () => {
            setPlayerColor(name, custom.value);
            changed();
        });
        row.appendChild(custom);

        const auto = menuButton('Automatic', !set);
        auto.dataset.color = '';
        auto.title = 'Go back to a colour picked from the palette.';
        row.appendChild(auto);

        row.addEventListener('click', (event) => {
            const button = event.target.closest('button');
            if (!button || button.dataset.color === undefined) return;
            setPlayerColor(name, button.dataset.color || null);
            closePlayerMenu();
            changed();
        });
        menu.append(heading, row);
    }

    document.body.appendChild(menu);

    // Beside the marker, kept on screen
    const box = anchor?.getBoundingClientRect?.() || { left: 0, bottom: 0, top: 0 };
    const width = 196;
    const height = menu.offsetHeight || 160;
    const viewportWidth = window.innerWidth || 1024;
    const viewportHeight = window.innerHeight || 768;
    const left = Math.max(4, Math.min(box.left, viewportWidth - width - 4));
    const below = box.bottom + 4;
    const top = below + height > viewportHeight ? Math.max(4, box.top - height - 4) : below;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;

    const outside = (event) => {
        if (!menu.contains(event.target)) closePlayerMenu();
    };
    document.addEventListener('mousedown', outside, true);
    current = { element: menu, escape: registerEscapeClose(closePlayerMenu), outside };
    return menu;
}
