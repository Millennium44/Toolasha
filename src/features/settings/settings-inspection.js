/**
 * Questions you can ask about the settings schema and the values against it.
 *
 * Two of them, both used by the settings panel and both pure so they can be
 * tested without a DOM:
 *
 * - **What have I changed?** Several hundred switches is too many to scan for
 *   the four you touched. The schema knows what it ships with, so the panel can
 *   simply show the difference.
 * - **What needs a reload?** Most settings apply the moment they change, but a
 *   handful gate a feature at startup and genuinely do not. Those carry
 *   `requiresRefresh: true` in the schema, which lets the panel say which ones
 *   rather than warning about all of them.
 */

import { settingsGroups } from '../../core/settings-schema.js';
import { getCustomPriceOverrides } from './custom-price-overrides.js';
import { isPricingSideChanged } from '../../utils/pricing-side-select.js';

/**
 * Whether a schema type stores its value in `isTrue` rather than `value`.
 * @param {string} [type]
 * @returns {boolean}
 */
function isBooleanType(type) {
    const kind = type || 'checkbox';
    return kind === 'checkbox' || kind === 'checkboxWithButton';
}

/**
 * JSON text with every object's keys in sorted order, arrays left in theirs.
 * @param {*} value
 * @returns {string}
 */
function stableStringify(value) {
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        const body = Object.keys(value)
            .sort()
            .filter((key) => value[key] !== undefined)
            .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
            .join(',');
        return `{${body}}`;
    }
    return JSON.stringify(value) ?? 'undefined';
}

/**
 * Whether two setting values are the same.
 *
 * Compared as text for scalars, because a number typed into an input comes back
 * as `'24'` and the schema default is `24` — treating those as different would
 * flag half the panel as "changed" the first time anybody saved.
 *
 * @param {*} a
 * @param {*} b
 * @returns {boolean}
 */
function valuesMatch(a, b) {
    if (a === b) return true;
    if (a === null || a === undefined || b === null || b === undefined) {
        return (a ?? '') === (b ?? '');
    }
    if (typeof a === 'object' || typeof b === 'object') {
        try {
            // Key order is a construction detail, not a difference: the stored
            // copy of a compound value and its schema default are built by
            // different code paths, and `{enabled, level}` must not read as
            // changed against `{level, enabled}`
            return stableStringify(a) === stableStringify(b);
        } catch {
            return false;
        }
    }
    return String(a) === String(b);
}

/**
 * Whether a setting's current value differs from what the schema ships.
 *
 * A missing entry is not a change: a setting nobody has touched has no stored
 * value, and it is sitting at its default by definition.
 *
 * @param {Object|null} definition - Schema entry ({type, default, ...})
 * @param {Object|null} entry - Live value from `config.settingsMap`
 * @returns {boolean}
 */
export function isSettingChanged(definition, entry) {
    if (!definition) return false;

    if (isBooleanType(definition.type)) {
        const fallback = definition.default ?? false;
        return Boolean(entry?.isTrue ?? fallback) !== Boolean(fallback);
    }

    const fallback = definition.default ?? '';
    return !valuesMatch(entry?.value ?? fallback, fallback);
}

/**
 * Row types whose real value does not live at `settingsMap[definition.id]`,
 * so `isSettingChanged`'s plain "compare the entry to the default" cannot
 * answer for them.
 *
 * A `pricingSide` row stores nothing of its own — it is a view over
 * `profitCalc_pricingMode` plus one of the two patient-tick checkboxes
 * (see `createPricingSideRowControl` in settings-ui.js), and all three are
 * `hidden: true` in the schema so they never become rows the filter can see
 * either. `customPriceOverrides` goes further: its state lives in its own
 * IndexedDB-backed cache (custom-price-overrides.js), never in
 * `config.settingsMap` at all. Both left "Changed only" reporting these rows
 * as unchanged no matter what the player had actually picked.
 *
 * Each entry takes the row's definition and the full settingsMap (not just
 * its own entry) so it can look at whatever keys actually hold its state.
 */
const DERIVED_CHANGE_CHECKS = {
    pricingSide: (definition, settingsMap) => isPricingSideChanged(definition.side, settingsMap),
    // Overrides are asynchronously loaded and cached in their own module
    // rather than kept in settingsMap, so the map handed in has nothing to
    // say here — the live cache is the only place to look.
    customPriceOverrides: () => Object.keys(getCustomPriceOverrides()).length > 0,
};

/**
 * Whether a settings-panel row differs from its default, however its type
 * actually stores that value. Plain types are compared at
 * `settingsMap[definition.id]` via {@link isSettingChanged}; a row type in
 * {@link DERIVED_CHANGE_CHECKS} is asked directly, since its value lives
 * elsewhere.
 * @param {Object|null} definition - Schema entry ({id, type, ...})
 * @param {Object} settingsMap - Usually `config.settingsMap`
 * @returns {boolean}
 */
export function isSettingRowChanged(definition, settingsMap) {
    if (!definition) return false;
    const derived = DERIVED_CHANGE_CHECKS[definition.type];
    if (derived) return derived(definition, settingsMap);
    return isSettingChanged(definition, settingsMap?.[definition.id]);
}

/**
 * Every setting whose current value differs from its schema default.
 * @param {Object} settingsMap - Usually `config.settingsMap`
 * @param {Object} [groups] - Schema groups, injectable for tests
 * @returns {string[]} Ids, in schema order
 */
export function changedSettingIds(settingsMap = {}, groups = settingsGroups) {
    const changed = [];
    for (const group of Object.values(groups)) {
        for (const [id, definition] of Object.entries(group.settings)) {
            if (isSettingRowChanged(definition, settingsMap)) changed.push(id);
        }
    }
    return changed;
}

/**
 * Every setting the schema marks as taking effect only after a page refresh.
 * @param {Object} [groups] - Schema groups, injectable for tests
 * @returns {string[]} Ids, in schema order
 */
export function refreshRequiredIds(groups = settingsGroups) {
    const ids = [];
    for (const group of Object.values(groups)) {
        for (const [id, definition] of Object.entries(group.settings)) {
            if (definition.requiresRefresh) ids.push(id);
        }
    }
    return ids;
}
