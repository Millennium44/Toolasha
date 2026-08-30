/**
 * Which stats an enhancement prediction is quoting.
 *
 * The same "+0 → +N" table means two different things depending on whose bench it describes:
 * what this character would spend, or what a top-end enhancer would. Both are worth seeing —
 * one is the player's real cost, the other is roughly what the listing in front of them cost
 * whoever made it — but a number that does not say which one it is is worse than either.
 *
 * This module owns that choice: the persisted toggle, the params each side resolves to, and the
 * chip the tooltip prints so the answer is always on screen next to the numbers.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { isMobileMode } from '../../utils/mobile.js';
import {
    getEnhancingParams,
    getAutoDetectedParams,
    getProRatesParams,
    describeParamsSource,
} from '../../utils/enhancement-config.js';

/** Setting the toggle persists to. Mirrored in the settings panel under Item Tooltips. */
export const PRO_RATES_SETTING = 'itemTooltip_enhancementProRates';

/** Class the delegated click handler looks for, and the marker the chip is found by. */
export const SOURCE_CHIP_CLASS = 'toolasha-enh-source-chip';

/** Attribute naming a re-renderable enhancement section, so a toggle can redraw it in place. */
export const SECTION_ATTR = 'data-toolasha-enh-section';

/**
 * Whether enhancement predictions are currently quoting the pro kit rather than the player.
 * @returns {boolean} True when pro rates are active
 */
export function isProRatesActive() {
    return config.getSetting(PRO_RATES_SETTING) === true;
}

/**
 * Persist which stats predictions should use.
 * @param {boolean} active - True for pro rates, false for the player's own stats
 */
export function setProRatesActive(active) {
    config.setSetting(PRO_RATES_SETTING, !!active);
}

/**
 * Flip between the player's stats and the pro kit, persisting the new choice.
 * @returns {boolean} The choice now in effect
 */
export function toggleProRates() {
    const next = !isProRatesActive();
    setProRatesActive(next);
    return next;
}

/**
 * The surfaces that quote an enhancement price sweep, and the one axis on which they still
 * differ after unification.
 *
 * `ownBench` names the question "could anybody but this player hand over the finished piece?".
 * When the answer is no, the character's own detected bench is the only honest one: a bench the
 * player typed into the simulator describes a run nobody can make on their behalf, and the
 * figure would be a fiction. The values:
 *
 * - `'unbuyable'` — ask the item. An untradable piece has no seller, so it is costed at the
 *   player's bench. This is the tooltip's original rule (a tooltip on somebody's listing is
 *   quoting a piece they could buy; an untradable one is not a listing at all) and, once its
 *   premise is stated in terms of the item rather than the slot, the advisor's too.
 * - `'always'` — the surface only ever asks about pieces that cannot be bought finished, so the
 *   question is settled before it is asked. The savings card's enhancing path fires exactly
 *   when the target level has no ask at any price.
 * - `'never'` — the surface has no single item to ask about.
 *
 * Pro rates sit above all of it. One toggle, one meaning: when it is on, every surface here is
 * quoting the professional's bench and every chip says Pro, an untradable piece included — the
 * player asked what a top-end enhancer would spend, and that question has an answer whether or
 * not anybody can sell them the result.
 */
const SURFACE_RULES = {
    /** Item tooltips, on a listing or in the inventory. */
    tooltip: { ownBench: 'unbuyable' },
    /** Combat-sim upgrade advisor rows. */
    advisor: { ownBench: 'unbuyable' },
    /** Equipment savings card — see `equipment-savings-row.js`, `enhancementCost`. */
    savings: { ownBench: 'always' },
    /** Lab panel, single-item route. */
    'lab:route': { ownBench: 'unbuyable' },
    /** Lab panel, whole-game XP/hour ranking: one bench for every item in the sweep. */
    'lab:ranking': { ownBench: 'never' },
    /** Goal planner cost estimates. */
    planner: { ownBench: 'unbuyable' },
};

/**
 * Whether an item can be bought finished from somebody else.
 * @param {string} [itemHrid] - Item being costed
 * @returns {boolean} True when the market could supply it
 */
function isTradable(itemHrid) {
    const itemDetails = dataManager.getInitClientData()?.itemDetailMap?.[itemHrid];
    return itemDetails?.isTradable !== false;
}

/**
 * The enhancing parameters a price-sweeping surface should be computed with.
 *
 * One resolution for every surface, in one order: the Pro toggle wins if it is on, then the
 * own-bench rule for pieces nobody can sell finished, then the simulator's own answer —
 * detection when auto-detect is on, the manual panel when it is off.
 *
 * @param {string} surface - Key in {@link SURFACE_RULES}
 * @param {string} [itemHrid] - Item being costed, for the surfaces whose rule asks
 * @returns {Object} Enhancement parameters, tagged with `paramsSource`
 */
export function enhancementParamsFor(surface, itemHrid) {
    const rule = SURFACE_RULES[surface];
    if (!rule) {
        console.error('[EnhancementParamsSource] Unknown surface:', surface);
    }

    if (isProRatesActive()) {
        return getProRatesParams();
    }

    const ownBench = rule?.ownBench ?? 'unbuyable';
    if (ownBench === 'always' || (ownBench === 'unbuyable' && !isTradable(itemHrid))) {
        return getAutoDetectedParams();
    }

    return getEnhancingParams();
}

/**
 * Name the source of a set of parameters, for display beside the numbers they produced.
 *
 * "Yours" means detected — everywhere, always. A manual bench is Manual even when every field in
 * it happens to match what detection would have found: that is the bench the player told it
 * about, not the bench it found, and the two are only the same by coincidence.
 *
 * @param {Object} params - Result of enhancementParamsFor() or getEnhancingParams()
 * @returns {{kind: 'pro'|'manual'|'yours', label: string, detail: string|null}} Chip content
 */
export function describeEnhancementSource(params) {
    if (params?.paramsSource === 'pro') {
        return {
            kind: 'pro',
            label: 'Pro',
            detail: 'Pro rates: enhancing 140, Observatory 8, ultra + blessed tea, +13 Celestial enhancer, +10 gear',
        };
    }

    if (params?.paramsSource === 'manual' || describeParamsSource(params)) {
        return { kind: 'manual', label: 'Manual', detail: describeParamsSource(params) };
    }

    return { kind: 'yours', label: 'Yours', detail: null };
}

/**
 * Escape a value for use inside a double-quoted HTML attribute.
 * @param {*} value - Value to escape
 * @returns {string} Escaped text
 */
function escapeAttr(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Build the clickable source chip shown on an enhancement section header.
 *
 * Pro rates get a filled, warning-coloured chip: the one mistake worth engineering against is
 * reading a professional's cost as your own, so that state has to be unmissable rather than
 * merely legible.
 *
 * @param {Object} params - Parameters the section was computed with
 * @returns {string} HTML for the chip
 */
export function buildSourceChipHTML(params) {
    const source = describeEnhancementSource(params);
    const isPro = source.kind === 'pro';
    const proColor = config.COLOR_TOOLTIP_WARNING || '#ffb020';
    // On a touch device there is no P key and hover tooltips never open, so the
    // chip carries its own visible affordance: a keycap "P" on desktop, the word
    // "tap" on a phone, and a finger-sized hit area there.
    const mobile = isMobileMode();
    const action = mobile ? 'Tap' : 'Click (or press P)';

    const title = isPro
        ? `${source.detail}. ${action} to switch back to your own stats.`
        : source.detail
          ? `${source.detail}. ${action} to compare against pro rates.`
          : `Computed from your own enhancing level, gear and teas. ${action} to compare against pro rates.`;

    const style = isPro
        ? `background: ${proColor}; color: #14181f; border: 1px solid ${proColor};`
        : 'background: rgba(255,255,255,0.10); color: inherit; border: 1px solid rgba(255,255,255,0.30);';
    const sizing = mobile ? 'padding: 3px 9px; font-size: 0.85em;' : 'padding: 0 5px; font-size: 0.75em;';
    const hint = mobile
        ? ' <span style="opacity: 0.7; font-weight: 600;">tap</span>'
        : ' <span style="border: 1px solid currentColor; border-radius: 3px; padding: 0 3px; margin-left: 1px;' +
          ' font-size: 0.85em; opacity: 0.75;">P</span>';

    return (
        `<span class="${SOURCE_CHIP_CLASS}" role="button" tabindex="0" title="${escapeAttr(title)}" ` +
        `style="pointer-events: auto; cursor: pointer; margin-left: 6px; border-radius: 8px; ${sizing} ` +
        `font-weight: 700; letter-spacing: 0.3px; white-space: nowrap; vertical-align: middle; ${style}">` +
        `${source.label} ⇄${hint}</span>`
    );
}

/**
 * Attributes that mark a built section as re-renderable in place after a toggle.
 * @param {'path'|'milestones'} kind - Which builder produced the section
 * @param {string} itemHrid - Item the section describes
 * @param {number} level - Target enhancement level (0 for milestone tables)
 * @returns {string} Attribute string to splice into the section's root element
 */
export function sectionAttributes(kind, itemHrid, level) {
    return (
        `${SECTION_ATTR}="${escapeAttr(kind)}" data-toolasha-enh-item="${escapeAttr(itemHrid)}" ` +
        `data-toolasha-enh-level="${escapeAttr(level)}"`
    );
}
