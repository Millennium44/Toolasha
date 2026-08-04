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
            return JSON.stringify(a) === JSON.stringify(b);
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
 * Every setting whose current value differs from its schema default.
 * @param {Object} settingsMap - Usually `config.settingsMap`
 * @param {Object} [groups] - Schema groups, injectable for tests
 * @returns {string[]} Ids, in schema order
 */
export function changedSettingIds(settingsMap = {}, groups = settingsGroups) {
    const changed = [];
    for (const group of Object.values(groups)) {
        for (const [id, definition] of Object.entries(group.settings)) {
            if (isSettingChanged(definition, settingsMap[id])) changed.push(id);
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
