/**
 * One colour per player, the same on every surface that names them.
 *
 * The Per-player panel, the trial scoreboard, the DPS graph and the portrait
 * badges all show the same people. A colour that follows a player across them
 * is what lets a graph line be read against a row without a legend — the idea,
 * the palette-plus-picker and the colour on the badge are KikiMeter's by
 * ZhuLiMoon (MIT, `colorFor` and the swatch row); the assignment rule is this
 * file's own.
 *
 * ## How a colour is chosen
 *
 * 1. **Picked.** A colour the user chose for that name, stored account-wide
 *    (`name-keyed-store.js`).
 * 2. **Already held.** The colour the name was given earlier this page session,
 *    so a row does not change colour because somebody joined.
 * 3. **Hashed.** The name's hash picks a palette slot; when another player in
 *    the same roster already holds that slot, the next free one is taken.
 *
 * KikiMeter hands out colours in order of first appearance, which is collision
 * free and different every session. A bare hash is stable and collides in most
 * five-player parties (twelve colours, five names: a clash about 60% of the
 * time). Hash-then-probe over the roster keeps the hash's stability and the
 * order-of-appearance's distinctness, up to twelve players; past that some
 * colours repeat, which a forty-player trial cannot avoid with any palette a
 * person can tell apart.
 *
 * ## Legible on the game's dark ground
 *
 * Every palette entry clears 4.5:1 contrast against the panels' background
 * (tested), and a picked colour that does not is lifted toward white until it
 * does — a black swatch chosen by mistake would otherwise make a name vanish.
 */

import { createNameKeyedStore, nameKey } from './name-keyed-store.js';

/** Twelve colours, each at least 4.5:1 against {@link PANEL_GROUND} */
export const PLAYER_PALETTE = [
    '#ef5350',
    '#42a5f5',
    '#ffa726',
    '#ce93d8',
    '#26c6da',
    '#ffee58',
    '#f06292',
    '#66bb6a',
    '#bcaaa4',
    '#4db6ac',
    '#d4e157',
    '#9fa8da',
];

/** The panels' background, which every colour here has to read against */
export const PANEL_GROUND = '#0e1016';

/** WCAG AA for normal text */
export const MIN_CONTRAST = 4.5;

/** Names remembered for the page session; a bound, not a feature */
const MAX_HELD = 2000;

const picked = createNameKeyedStore({
    key: 'playerColors',
    isValid: (value) => normalizeHex(value) !== null,
});

/** nameKey → the colour it was last resolved to this page session */
const held = new Map();

/**
 * A `#rrggbb` string, or null.
 * @param {string} value - `#rgb` or `#rrggbb`
 * @returns {string|null}
 */
export function normalizeHex(value) {
    const raw = String(value ?? '')
        .trim()
        .toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(raw)) return raw;
    if (/^#[0-9a-f]{3}$/.test(raw)) return `#${raw[1]}${raw[1]}${raw[2]}${raw[2]}${raw[3]}${raw[3]}`;
    return null;
}

/**
 * WCAG relative luminance.
 * @param {string} hex - `#rrggbb`
 * @returns {number}
 */
function luminance(hex) {
    const channel = (offset) => {
        const c = parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/**
 * WCAG contrast ratio between two colours.
 * @param {string} a - `#rrggbb`
 * @param {string} b - `#rrggbb`
 * @returns {number} 1 to 21
 */
export function contrastRatio(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

/**
 * A colour that reads on the dark ground: the colour itself when it already
 * does, otherwise mixed toward white in small steps until it does.
 * @param {string} value - Any hex colour
 * @param {string} [ground] - The background it sits on
 * @returns {string|null} `#rrggbb`, or null for an unusable value
 */
export function legibleColor(value, ground = PANEL_GROUND) {
    const hex = normalizeHex(value);
    if (!hex) return null;

    const rgb = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
    for (let step = 0; step <= 20; step++) {
        const mix = step / 20;
        const candidate = `#${rgb
            .map((c) =>
                Math.round(c + (255 - c) * mix)
                    .toString(16)
                    .padStart(2, '0')
            )
            .join('')}`;
        if (contrastRatio(candidate, ground) >= MIN_CONTRAST) return candidate;
    }
    return '#ffffff';
}

/**
 * FNV-1a over the name key: cheap, and the same slot for the same name forever.
 * @param {string} name - Player name
 * @returns {number} Unsigned 32-bit hash
 */
export function hashName(name) {
    let hash = 0x811c9dc5;
    for (const char of nameKey(name)) {
        hash ^= char.codePointAt(0);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

/**
 * The colour the user picked for a player, made legible, or null.
 * @param {string} name - Player name
 * @returns {string|null}
 */
export function pickedColor(name) {
    const value = picked.get(name);
    return value ? legibleColor(value) : null;
}

/**
 * Give every player in a roster a colour, distinct where the palette allows.
 *
 * Every surface should call this over the whole list it is about to draw, so
 * the probe sees the same party the others do. The result is remembered per
 * name, which is what {@link playerColor} reads.
 *
 * @param {Array<string>} names - The players on screen
 * @returns {Map<string, string>} nameKey → `#rrggbb`
 */
export function resolveRosterColors(names) {
    const keys = [...new Set((names || []).map(nameKey).filter(Boolean))].sort();
    const out = new Map();
    const taken = new Set();

    for (const key of keys) {
        const color = pickedColor(key);
        if (!color) continue;
        out.set(key, color);
        taken.add(color);
    }
    for (const key of keys) {
        if (out.has(key)) continue;
        const color = held.get(key);
        if (color && !taken.has(color)) {
            out.set(key, color);
            taken.add(color);
        }
    }
    for (const key of keys) {
        if (out.has(key)) continue;
        const start = hashName(key) % PLAYER_PALETTE.length;
        let color = PLAYER_PALETTE[start];
        for (let step = 0; step < PLAYER_PALETTE.length; step++) {
            const candidate = PLAYER_PALETTE[(start + step) % PLAYER_PALETTE.length];
            if (!taken.has(candidate)) {
                color = candidate;
                break;
            }
        }
        out.set(key, color);
        taken.add(color);
    }

    for (const [key, color] of out) {
        if (pickedColor(key)) continue;
        held.delete(key);
        held.set(key, color);
    }
    while (held.size > MAX_HELD) held.delete(held.keys().next().value);
    return out;
}

/**
 * One player's colour: picked, else the one resolved for them this session,
 * else their hash slot.
 * @param {string} name - Player name
 * @returns {string} `#rrggbb`
 */
export function playerColor(name) {
    return pickedColor(name) || held.get(nameKey(name)) || PLAYER_PALETTE[hashName(name) % PLAYER_PALETTE.length];
}

/**
 * Pick a colour for a player, or clear the pick with null.
 * @param {string} name - Player name
 * @param {string|null} color - Any hex colour, or null
 * @returns {Promise<void>}
 */
export async function setPlayerColor(name, color) {
    if (color === null) held.delete(nameKey(name));
    await picked.set(name, color === null ? null : normalizeHex(color));
}

/** @returns {Promise<void>} The stored picks, read once */
export function loadPlayerColors() {
    return picked.load();
}

/** Forget picks and held colours in memory — for tests */
export function _resetPlayerColors() {
    picked.reset();
    held.clear();
}
