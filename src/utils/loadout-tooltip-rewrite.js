/**
 * Rewrite the game's own lines in a Loadouts-panel item tooltip to the level the loadout wears.
 *
 * With "Use highest enhancement level" on, the game draws the tooltip of the plain item: the name has no
 * "+N", the stat lines are the +0 values and the Market Price line is the +0 price. Toolasha knows the level
 * (`info.levelSource === 'loadout'`), so for that case only it sets those lines to the +N figures and marks each
 * with a hover title. Nothing is added to or removed from the game's tree: text nodes are edited in place and a
 * price with no figure is hidden, because React owns the nodes and would throw on removing one it does not find.
 *
 * Rows are matched to stats by data, not by label (a client may run in Chinese): a row's number and its unit
 * (a "%" or none) must equal a stat of the item's `equipmentDetail` at +0. A row that matches no stat, or
 * stats that would scale to different figures, is left as the game drew it. The Market Price row is the one whose label says so, or whose number
 * is Toolasha's +0 price for the item.
 *
 * Every edit remembers the text it replaced, so a second pass, or a popper the game reuses, starts from the
 * original and never appends "+N" twice or rescales a rescaled figure.
 */

import dataManager from '../core/data-manager.js';
import { getItemPrices } from './market-data.js';
import { enhancementSteps } from './enhancement-steps.js';
import { edits, restoreLoadoutTooltip, setText } from './loadout-tooltip-edits.js';

export { restoreLoadoutTooltip };

const NUMBER_AT_END = /^(.*?)([+-]?)(\d[\d,]*(?:\.\d+)?)(%?)(\s*)$/s;
const INJECTED = '[class*="-injected"], [class*="mwi-"]';
const MARKET_PRICE_LABEL = /market\s*price|市场价|市价/i;

/**
 * The text nodes of a subtree, minus Toolasha's own injected sections.
 * @param {Element} root
 * @param {Element|null} skip - A subtree to leave out (the name)
 * @returns {Text[]}
 */
function textNodes(root, skip) {
    const out = [];
    const walker = root.ownerDocument.createTreeWalker(root, 4);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const host = node.parentElement;
        if (!host || (skip && skip.contains(node)) || host.closest(INJECTED)) continue;
        out.push(node);
    }
    return out;
}

/**
 * Format a number like the text it replaces.
 * @param {number} value
 * @param {string} sample - Digits of the original (keeps separators and decimals)
 * @returns {string}
 */
function formatLike(value, sample) {
    let decimals = (sample.split('.')[1] || '').length;
    while (decimals < 4 && Math.abs(Number(value.toFixed(decimals)) - value) > 1e-9) decimals++;
    const fixed = Math.abs(value).toFixed(decimals);
    if (!sample.includes(',')) return fixed;
    const [whole, frac] = fixed.split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return frac ? `${grouped}.${frac}` : grouped;
}

/**
 * Every numeric stat of the item at +0 and at the level.
 * Scaling is the game's: `base + steps * bonus`, steps from `enhancementSteps` (the 2% steps table).
 * @param {Object} equipmentDetail
 * @param {number} steps
 * @returns {Array<{base: number, scaled: number, hasBonus: boolean}>}
 */
function statsAt(equipmentDetail, steps) {
    const out = [];
    for (const [stats, bonuses] of [
        [equipmentDetail.noncombatStats, equipmentDetail.noncombatEnhancementBonuses],
        [equipmentDetail.combatStats, equipmentDetail.combatEnhancementBonuses],
    ]) {
        for (const [key, base] of Object.entries(stats || {})) {
            if (typeof base !== 'number' || !Number.isFinite(base)) continue;
            const bonus = bonuses?.[key] || 0;
            out.push({ base, scaled: base + steps * bonus, hasBonus: bonus !== 0 });
        }
    }
    return out;
}

/**
 * The row a value node belongs to, as text (the label may sit in a sibling element).
 * @param {Text} node
 * @returns {string}
 */
function rowText(node) {
    const host = node.parentElement;
    const row = host.childNodes.length === 1 && host.parentElement ? host.parentElement : host;
    return row.textContent;
}

/**
 * Rewrite the stat lines.
 * @returns {Set<Text>} The nodes taken as stat rows (matched to a stat, rewritten or not)
 */
function rewriteStats(popper, nodes, equipmentDetail, level, title) {
    const table = dataManager.getInitClientData?.()?.enhancementLevelTotalBonusMultiplierTable;
    const stats = statsAt(equipmentDetail, enhancementSteps(level, table));
    const claimed = new Set();
    for (const node of nodes) {
        const m = node.data.match(NUMBER_AT_END);
        if (!m) continue;
        const [, prefix, sign, digits, percent, tail] = m;
        const shown = Number(digits.replace(/,/g, '')) * (sign === '-' ? -1 : 1);
        const tolerance = 0.5 * 10 ** -(digits.split('.')[1] || '').length + 1e-9;
        const scale = percent ? 100 : 1;
        const hits = stats.filter((s) => Math.abs(s.base * scale - shown) <= tolerance);
        // Several stats can show the same number (Enchanted Gloves: two lines of 10%). That is no guess when they all
        // scale to the same figure; when they would differ the row is left as drawn
        const [hit] = hits;
        if (!hit || hits.some((s) => s.scaled !== hit.scaled || s.hasBonus !== hit.hasBonus)) continue;
        claimed.add(node);
        if (!hit.hasBonus) continue;
        const next = Math.round(hit.scaled * scale * 1e6) / 1e6;
        const signText = next < 0 ? '-' : sign === '+' ? '+' : '';
        setText(popper, node, `${prefix}${signText}${formatLike(next, digits)}${percent}${tail}`, title);
    }
    return claimed;
}

/**
 * Rewrite the Market Price line to the price at the level, or hide it when Toolasha has none.
 * The side (ask, bid, average) is the one that reproduces the game's +0 figure; ask when only the label matched.
 */
function rewriteMarketPrice(popper, nodes, skip, itemHrid, level, title) {
    const plain = getItemPrices(itemHrid, 0);
    for (const node of nodes) {
        if (skip.has(node)) continue;
        const m = node.data.match(NUMBER_AT_END);
        if (!m || m[4] || m[2] === '-') continue;
        const [, prefix, , digits, , tail] = m;
        const shown = Number(digits.replace(/,/g, ''));
        let side = null;
        for (const candidate of ['ask', 'bid', 'average']) {
            if (plain && plain[candidate] > 0 && Math.round(plain[candidate]) === shown) {
                side = candidate;
                break;
            }
        }
        if (!side && !MARKET_PRICE_LABEL.test(rowText(node))) continue;
        const value = getItemPrices(itemHrid, level)?.[side || 'ask'];
        if (value > 0) {
            setText(popper, node, `${prefix}${formatLike(Math.round(value), digits)}${tail}`, title);
        } else {
            const parent = node.parentElement;
            const wider = parent.childNodes.length === 1 ? parent.parentElement : null;
            const hide = wider && MARKET_PRICE_LABEL.test(wider.textContent) ? wider : parent;
            const list = edits.get(popper) || [];
            list.push({ node, orig: node.data, shown: node.data, hide, hideWas: hide.style.display });
            edits.set(popper, list);
            hide.style.display = 'none';
        }
        return;
    }
}

/**
 * Show a loadout slot's item at the level the loadout wears, in the game's own lines.
 * Always starts from the game's original text, so calling it again is safe.
 * @param {Element} popper - The tooltip popper
 * @param {{levelSource?: string, enhancementLevel: number, nameEl: Element|null}} info
 * @param {string} itemHrid
 */
export function applyLoadoutLevelToGameLines(popper, info, itemHrid) {
    restoreLoadoutTooltip(popper);
    if (info?.levelSource !== 'loadout' || !(info.enhancementLevel > 0) || !itemHrid) return;
    const level = info.enhancementLevel;
    try {
        const detail = dataManager.getItemDetails(itemHrid)?.equipmentDetail;
        const title = `Shown at +${level}: the loadout's level`;
        const tooltipText = popper.querySelector('[class*="ItemTooltipText_itemTooltipText"]');
        if (!tooltipText) return;

        if (info.nameEl) {
            const nameNodes = textNodes(info.nameEl, null);
            const last = nameNodes.filter((n) => n.data.trim()).pop();
            if (last) setText(popper, last, `${last.data.replace(/\s+$/, '')} +${level}`, title);
        }
        const nodes = textNodes(tooltipText, info.nameEl);
        const claimed = detail ? rewriteStats(popper, nodes, detail, level, title) : new Set();
        rewriteMarketPrice(popper, nodes, claimed, itemHrid, level, title);
    } catch (error) {
        console.error('[LoadoutTooltip] Could not set the loadout level on the game lines:', error);
        restoreLoadoutTooltip(popper);
    }
}
