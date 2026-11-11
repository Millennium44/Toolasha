/**
 * Combat Sim "Copy for chat": short per-player messages for the game's chat box.
 *
 * The game caps a chat message at 400 UTF-8 bytes (`CHAT_MAX_BYTES`), so a long result is split into
 * numbered parts at item boundaries and an item that cannot fit alone is cut with an ellipsis. Everything
 * here is pure: text in, text out. The panel decides where the clipboard and the buttons are.
 */

import { CHAT_MAX_BYTES, utf8Length, truncateToUtf8Bytes, trimToFit } from '../../utils/chat-fill.js';
import { describeRow } from './trigger-tuning.js';
import { describeTriggerRows } from './lab-condition-search.js';

/** Between two items of one message */
const ITEM_SEPARATOR = '; ';

/** A player's name never needs more than this many bytes in a label; it keeps a pathological one from eating the message */
const MAX_NAME_BYTES = 48;

/** Upgrades named per player */
export const TOP_UPGRADES = 3;

const escapeHtml = (text) =>
    String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

/**
 * One threshold change as a chat item: `Quick Aid → Allies: Lowest HP % <= 50 (was 350)`.
 * @param {Object} change - A change from the trigger optimizer result
 * @param {Object} gameData - Game data payload (display names)
 * @returns {string}
 */
export function thresholdChangeText(change, gameData) {
    return `${change.itemName} → ${describeRow(change, gameData, change.to)} (was ${change.from})`;
}

/**
 * One condition-search change as a chat item.
 * @param {Object} change - A change from `result.conditions.changes`
 * @param {Object} gameData - Game data payload (display names)
 * @returns {string}
 */
export function conditionChangeText(change, gameData) {
    const bare = (rows) => describeTriggerRows(rows, gameData).replace(/^Activate when: /, '');
    return `${change.itemName} → ${bare(change.toRows)} (was ${bare(change.fromRows)})`;
}

/**
 * The players a trigger result has recommendations for, one entry each, in order of first appearance.
 * Threshold changes carry their own player; the condition search is for one player (the simulated one), so
 * its changes go to `selected`.
 *
 * Nothing is listed when the result is not a recommendation (`reliable === false`), the same rule the
 * results box applies to its headline.
 *
 * @param {Object|null} result - From `runTriggerOptimization`
 * @param {Object} gameData - Game data payload
 * @param {Object} [selected] - `{ hrid, name }` of the player the condition search ran for
 * @returns {Array<{key: string, name: string, changes: string[], upgrades: string[]}>}
 */
export function triggerChatPlayers(result, gameData, selected = {}) {
    const players = new Map();
    const entry = (key, name) => {
        if (!players.has(key)) players.set(key, { key, name: name || 'Player', changes: [], upgrades: [] });
        return players.get(key);
    };
    if (!result) return [];
    if (result.reliable !== false) {
        for (const change of result.changes || []) {
            entry(change.playerHrid || change.playerName, change.playerName).changes.push(
                thresholdChangeText(change, gameData)
            );
        }
    }
    const conditions = result.conditions;
    if (conditions && conditions.reliable !== false && (conditions.changes || []).length > 0) {
        const target = entry(selected.hrid || selected.name || 'selected', selected.name);
        for (const change of conditions.changes) target.changes.push(conditionChangeText(change, gameData));
    }
    return [...players.values()];
}

/**
 * Whether a trigger result has anything to put in a chat message.
 * @param {Object|null} result
 * @returns {boolean}
 */
export function triggerHasChatContent(result) {
    if (!result) return false;
    if (result.reliable !== false && (result.changes || []).length > 0) return true;
    return Boolean(result.conditions && result.conditions.reliable !== false && result.conditions.changes?.length);
}

/**
 * The top upgrades of an Upgrade analysis as chat items, ranked the way the gold table ranks them (Score,
 * highest first) and showing the figures that row shows: the Score and the DPS change. Rows with no price,
 * combat-level rows and ability-order rows are left out: their Score is on another scale.
 *
 * @param {Object|null} results - An upgrade analysis (`{ results: Array }`)
 * @param {number} [max] - How many to name
 * @returns {string[]} The first is labelled "Top upgrade:", the rest "Also:"
 */
export function topUpgradeTexts(results, max = TOP_UPGRADES) {
    const rows = (results?.results || []).filter(
        (r) =>
            r?.candidate?.description &&
            r.candidate.type !== 'combat_level' &&
            !r.candidate.abilityOrder &&
            r.cost != null &&
            Number.isFinite(r.score) &&
            r.score > 0
    );
    rows.sort((a, b) => b.score - a.score);
    // A run stopped before every candidate was measured ranks only what it got to: say so. (`foodStopped` is not
    // partial: every upgrade was measured, only the food search was cut.)
    const partial = Boolean(results?.stopped);
    return rows.slice(0, Math.max(0, max)).map((r, i) => {
        const figures = [`score ${Math.round(r.score)}`];
        const dps = r.deltas?.dps;
        if (Number.isFinite(dps) && Math.abs(dps) >= 0.05)
            figures.push(`${dps > 0 ? '+' : '−'}${Math.abs(dps).toFixed(1)}% DPS`);
        return `${i === 0 ? (partial ? 'Top upgrade (partial run)' : 'Top upgrade') : 'Also'}: ${r.candidate.description} (${figures.join(', ')})`;
    });
}

/**
 * Attach upgrade items to the player they belong to, adding the player when the trigger result has none.
 * The player is matched by `key` (the sim's player slot) and, when the upgrade run has none (a remembered
 * run), by name. A slot whose player's name differs from the one the upgrade run captured gets nothing.
 * @param {Array<Object>} players - From {@link triggerChatPlayers}
 * @param {{key: string|null, name: string|null, upgrades: string[]}} owner - Whose upgrades these are
 * @returns {Array<Object>} A new array; the input is not changed
 */
export function withUpgrades(players, { key = null, name = null, upgrades = [] } = {}) {
    const copy = players.map((p) => ({ ...p, upgrades: [...p.upgrades] }));
    if (!upgrades.length || (!key && !name)) return copy;
    let target;
    if (key) {
        target = copy.find((p) => p.key === key);
        // A sim hrid is a slot (`player2`), kept when the player in it is replaced: a slot match whose captured
        // name differs is someone else, and their upgrades go to nobody rather than under the wrong name
        if (target && name && target.name && target.name !== name) return copy;
    } else {
        // Name only: two players sharing it cannot be told apart, so neither gets these
        const same = copy.filter((p) => p.name === name);
        if (same.length > 1) return copy;
        target = same[0];
    }
    if (target) target.upgrades.push(...upgrades);
    else copy.push({ key: key || name, name: name || 'Player', changes: [], upgrades: [...upgrades] });
    return copy;
}

/**
 * Display names for a list of players: two players that share a name get " (2)", " (3)" so the lines
 * pasted into chat do not read as one person.
 * @param {Array<{name: string}>} players
 * @returns {string[]}
 */
function labelNames(players) {
    const seen = new Map();
    return players.map((p) => {
        const base = truncateToUtf8Bytes(String(p.name || 'Player').trim() || 'Player', MAX_NAME_BYTES);
        const count = (seen.get(base) || 0) + 1;
        seen.set(base, count);
        return count === 1 ? base : `${base} (${count})`;
    });
}

/**
 * Pack items into messages of at most {@link CHAT_MAX_BYTES} bytes, each starting with a prefix that carries
 * the name and, when there is more than one message, "(i/n) ".
 * @param {string} name
 * @param {string[]} items
 * @param {number} total - The number of parts the labels will claim
 * @returns {string[]}
 */
function pack(name, items, total) {
    const prefixOf = (index) => (total === 1 ? `${name}: ` : `(${index}/${total}) ${name}: `);
    const parts = [];
    let current = [];
    const flush = () => {
        if (current.length) parts.push(prefixOf(parts.length + 1) + current.join(ITEM_SEPARATOR));
        current = [];
    };
    for (const item of items) {
        if (current.length) {
            const budget = CHAT_MAX_BYTES - utf8Length(prefixOf(parts.length + 1));
            if (utf8Length(current.join(ITEM_SEPARATOR) + ITEM_SEPARATOR + item) <= budget) {
                current.push(item);
                continue;
            }
            flush();
        }
        const budget = CHAT_MAX_BYTES - utf8Length(prefixOf(parts.length + 1));
        current = [utf8Length(item) <= budget ? item : trimToFit(item, budget)];
    }
    flush();
    return parts;
}

/**
 * One player's messages: a single line when it fits, else numbered parts split between items.
 * @param {string} name - The label to open each message with
 * @param {string[]} items - The changes, then the upgrades
 * @returns {string[]}
 */
export function playerMessages(name, items) {
    if (items.length === 0) return [`${name}: no changes`];
    let parts = pack(name, items, 1);
    if (parts.length === 1) return parts;
    // Labels count toward the cap and their width depends on the part count, so pack until the count settles
    let total = parts.length;
    for (let guard = 0; guard < items.length + 4; guard++) {
        parts = pack(name, items, total);
        if (parts.length === total) return parts;
        if (parts.length === 1) return pack(name, items, 1);
        total = parts.length;
    }
    return parts;
}

/**
 * Every message to paste, player after player.
 * @param {Array<{key: string, name: string, changes: string[], upgrades: string[]}>} players
 * @param {Object} [options]
 * @param {boolean} [options.includeUpgrades] - Name each player's top upgrades after their changes
 * @returns {string[]} One entry per chat message, each at most {@link CHAT_MAX_BYTES} UTF-8 bytes
 */
export function buildChatMessages(players, { includeUpgrades = false } = {}) {
    const names = labelNames(players);
    const out = [];
    players.forEach((player, i) => {
        const items = [...player.changes, ...(includeUpgrades ? player.upgrades : [])];
        out.push(...playerMessages(names[i], items));
    });
    return out;
}

/**
 * The Copy for chat control: a button, and the Include upgrades toggle where an upgrade run exists too.
 * @param {Object} options
 * @param {string} options.buttonId - DOM id of the button
 * @param {string} [options.toggleId] - DOM id of the checkbox; omitted when there are no upgrades to include
 * @param {boolean} [options.includeUpgrades] - The checkbox's state
 * @param {string} [options.style] - Inline style of the button
 * @returns {string} HTML
 */
export function chatCopyBarHtml({
    buttonId,
    toggleId = null,
    includeUpgrades = false,
    toggleDisabled = false,
    style = '',
}) {
    const toggle = toggleId
        ? `<label style="font-size:11px; color:#aaa; display:flex; align-items:center; gap:4px; cursor:pointer;" ` +
          `title="Adds each player's top upgrades from the Upgrade tab to their message">` +
          `<input type="checkbox" id="${escapeHtml(toggleId)}"${includeUpgrades ? ' checked' : ''}${toggleDisabled ? ' disabled' : ''}>Include upgrades</label>`
        : '';
    return (
        `<div style="display:flex; gap:8px; align-items:center; margin-top:8px; flex-wrap:wrap;">` +
        `<button id="${escapeHtml(buttonId)}" style="${style}" ` +
        `title="Copies one short message per player (400 bytes each, split into numbered parts when longer), ` +
        `one per line, to paste into game chat">Copy for chat</button>${toggle}</div>`
    );
}
