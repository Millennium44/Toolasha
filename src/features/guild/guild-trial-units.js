/**
 * Putting names to the units in a spectated trial fight.
 *
 * `guild_battle_updated` — the stream that arrives while the In Progress fight
 * view is open — identifies its units by **index only**. `pMap` is `{"1": {…}}`
 * and nothing in the message says who "1" is. Every figure the per-player panel
 * draws is worthless attached to "Player 2", so this is the join, and it is
 * built out of three sources of decreasing trust.
 *
 * ## 1. The fight view's own portraits
 *
 * The trial fight view draws the same `CombatUnit` tiles the ordinary battle
 * panel does, names and all, in slot order. When the tiles cover the index being
 * asked about, their order *is* the slot order and the name is read straight
 * off. This is a fact on screen rather than an inference, so it wins.
 *
 * It is also the source that is not always there: the view has to be open, and
 * the class names carry a build hash, so the selector is a prefix match and the
 * resolver simply falls through when the game renames them.
 *
 * ## 2. The captured build's vitals
 *
 * A tick states `mHP` and `mMP` — the unit's *maximum* health and mana, which do
 * not move during a fight — and `guild-loadout-capture.js` has been recording
 * exactly those two numbers per guild member for weeks. In the capture that
 * proved this stream exists, `pMap["1"]` read `mHP: 2612, mMP: 2180` and exactly
 * one member's sheet said `Max HP 2,612, Max MP 2,180`. That is an identification.
 *
 * The pair is used rather than health alone because health alone collides: two
 * members in the same gear have the same health and the same mana, and a match
 * that fits two people identifies neither. **An ambiguous signature resolves to
 * nobody**, which is the whole discipline of this file — a wrong name on a
 * damage row is worse than no name, because a guild acts on it.
 *
 * ## 3. Nothing
 *
 * `Player 2`, and the caller says the name is a placeholder. Never a guess from
 * whoever happens to be online, or the roster in alphabetical order.
 *
 * ## A better source, when one appears
 *
 * The capture that found this stream never caught the message that opens a
 * spectated fight — a `guild_battle` with a roster on it very likely exists, and
 * would name every slot outright. {@link resolveUnitNames} takes its sources as
 * an argument list precisely so that one becomes a fourth entry at the top
 * rather than a rewrite.
 */

/** A party tile in the fight view; the class names carry a build hash */
const UNIT = '[class*="CombatUnit_combatUnit"]';

/** The name inside one */
const UNIT_NAME = '[class*="CombatUnit_name"]';

/** Where the party's tiles live, as opposed to the monsters' */
const PLAYERS_AREA = '[class*="BattlePanel_playersArea"]';

/**
 * The party names the fight view is showing, in slot order.
 *
 * Empty when the view is not open, which is most of the time — the caller must
 * treat that as "no answer" rather than as "nobody is there".
 *
 * @param {Document|Element} [root] - Where to look; the document by default
 * @returns {string[]} Names in DOM order, with gaps preserved as empty strings
 */
export function fightViewNames(root = typeof document === 'undefined' ? null : document) {
    if (!root || typeof root.querySelector !== 'function') return [];

    const area = root.querySelector(PLAYERS_AREA);
    if (!area) return [];

    return [...area.querySelectorAll(UNIT)].map((unit) => unit.querySelector(UNIT_NAME)?.textContent?.trim() || '');
}

/**
 * A number the game wrote for a human to read.
 * @param {string|number} value - e.g. `'2,612'`
 * @returns {number|null} The number, or null
 */
function readNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const digits = String(value ?? '').replace(/[^\d.-]/g, '');
    if (!digits) return null;
    const parsed = Number(digits);
    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The maximum health and mana a captured sheet states.
 *
 * From the sheet's *rows*, which are what the game displayed, and never from
 * `stats.maxHitpoints` — that field is a multiplier (0.932 for a character whose
 * health is 2,612) and matching a tick against it would find nobody, forever.
 *
 * @param {Object} loadout - A snapshot from `guild-loadout-capture.js`
 * @returns {{mHP: number|null, mMP: number|null}} The vitals
 */
export function loadoutVitals(loadout) {
    const rows = Array.isArray(loadout?.rows) ? loadout.rows : [];
    const find = (label) => rows.find((row) => String(row?.label || '').toLowerCase() === label)?.value;

    return { mHP: readNumber(find('max hp')), mMP: readNumber(find('max mp')) };
}

/**
 * Which member's sheet matches a unit's maximum health and mana.
 *
 * Both must be known and both must match. A signature that fits more than one
 * member returns null: see the module note for why a near-miss is worse here
 * than a blank.
 *
 * @param {Object} unit - A `pMap` entry, or anything with `mHP`/`mMP`
 * @param {Array<Object>} loadouts - Snapshots from `guild-loadout-capture.js`
 * @returns {{name: string, at: number|null}|null} The member, or null
 */
export function matchByVitals(unit, loadouts) {
    const health = readNumber(unit?.mHP);
    const mana = readNumber(unit?.mMP);
    if (!Number.isFinite(health) || !Number.isFinite(mana)) return null;

    const hits = [];
    const seen = new Set();

    for (const loadout of loadouts || []) {
        const name = String(loadout?.name || '').trim();
        if (!name) continue;

        // One member, one sheet: `seen()` is most-recent-first, so a member
        // whose build was captured twice must not count as two candidates and
        // make their own signature look ambiguous
        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        const vitals = loadoutVitals(loadout);
        if (vitals.mHP !== health || vitals.mMP !== mana) continue;
        hits.push({ name, at: Number.isFinite(loadout?.at) ? loadout.at : null });
    }

    return hits.length === 1 ? hits[0] : null;
}

/**
 * Name every unit in a tick, and say how each name was arrived at.
 *
 * @param {Object} input - Inputs
 * @param {Object} input.pMap - The tick's players
 * @param {string[]} [input.portraits] - From {@link fightViewNames}
 * @param {Array<Object>} [input.loadouts] - Snapshots from `guild-loadout-capture.js`
 * @param {Object} [input.known] - Names already resolved, index → `{name, source}`
 * @returns {Object<string, {name: string, source: 'portrait'|'vitals'|'placeholder'}>} Per index
 */
export function resolveUnitNames({ pMap = {}, portraits = [], loadouts = [], known = {} } = {}) {
    const resolved = {};

    for (const [index, unit] of Object.entries(pMap || {})) {
        // A name already read off a portrait is not re-derived every tick; the
        // fight view closes and the identification must not close with it
        const held = known[index];
        if (held && held.source !== 'placeholder') {
            resolved[index] = held;
            continue;
        }

        const slot = Number(index);
        const portrait = Number.isInteger(slot) && slot >= 0 && slot < portraits.length ? portraits[slot] : '';
        if (portrait) {
            resolved[index] = { name: portrait, source: 'portrait' };
            continue;
        }

        const matched = matchByVitals(unit, loadouts);
        if (matched) {
            resolved[index] = { name: matched.name, source: 'vitals' };
            continue;
        }

        resolved[index] = { name: `Player ${Number.isInteger(slot) ? slot + 1 : index}`, source: 'placeholder' };
    }

    return resolved;
}

/**
 * What the resolver managed, in a form a caption can use.
 * @param {Object} names - From {@link resolveUnitNames}
 * @returns {{named: number, of: number, placeholders: string[], bySource: Object}} The tally
 */
export function nameCoverage(names) {
    const entries = Object.values(names || {});
    const bySource = {};
    const placeholders = [];

    for (const entry of entries) {
        bySource[entry.source] = (bySource[entry.source] || 0) + 1;
        if (entry.source === 'placeholder') placeholders.push(entry.name);
    }

    return {
        named: entries.length - placeholders.length,
        of: entries.length,
        placeholders,
        bySource,
    };
}
