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
 * The enhancing parameters a tooltip for this item should be computed with.
 *
 * Untradeable items are never somebody else's listing — the player is the only one who can be
 * enhancing them — so they are always quoted from the character's own stats.
 *
 * @param {string} itemHrid - Item the tooltip is describing
 * @returns {Object} Enhancement parameters, tagged with `paramsSource`
 */
export function getTooltipEnhancementParams(itemHrid) {
    const itemDetails = dataManager.getInitClientData()?.itemDetailMap?.[itemHrid];
    const isTradeable = itemDetails?.isTradable !== false;

    if (!isTradeable) {
        return getAutoDetectedParams();
    }
    if (isProRatesActive()) {
        return getProRatesParams();
    }
    return getEnhancingParams();
}

/**
 * Name the source of a set of parameters, for display beside the numbers they produced.
 * @param {Object} params - Result of getTooltipEnhancementParams() or getEnhancingParams()
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

    const overrides = describeParamsSource(params);
    if (overrides) {
        return { kind: 'manual', label: 'Manual', detail: overrides };
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

    const title = isPro
        ? `${source.detail}. Click (or press P) to switch back to your own stats.`
        : source.detail
          ? `${source.detail}. Click (or press P) to compare against pro rates.`
          : 'Computed from your own enhancing level, gear and teas. Click (or press P) to compare against pro rates.';

    const style = isPro
        ? `background: ${proColor}; color: #14181f; border: 1px solid ${proColor};`
        : 'background: rgba(255,255,255,0.10); color: inherit; border: 1px solid rgba(255,255,255,0.30);';

    return (
        `<span class="${SOURCE_CHIP_CLASS}" role="button" tabindex="0" title="${escapeAttr(title)}" ` +
        'style="pointer-events: auto; cursor: pointer; margin-left: 6px; padding: 0 5px; border-radius: 8px; ' +
        `font-size: 0.75em; font-weight: 700; letter-spacing: 0.3px; white-space: nowrap; vertical-align: middle; ${style}">` +
        `${source.label} ⇄</span>`
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
