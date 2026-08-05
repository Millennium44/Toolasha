/**
 * "Changed only" is worth nothing if it lies in either direction: a setting
 * shown as changed when it is at its default sends someone hunting for a
 * decision they never made, and one hidden when it is changed hides the
 * decision that is actually causing whatever they came to fix.
 *
 * The awkward case is types. A number typed into an input comes back as a
 * string, so `'24'` against a default of `24` must not read as a change.
 */

import { describe, test, expect } from 'vitest';
import { isSettingChanged, changedSettingIds, refreshRequiredIds } from './settings-inspection.js';
import { settingsGroups, getSettingDefinition } from '../../core/settings-schema.js';

describe('whether one setting differs from its default', () => {
    test('a checkbox at its default is unchanged', () => {
        expect(isSettingChanged({ type: 'checkbox', default: true }, { isTrue: true })).toBe(false);
        expect(isSettingChanged({ type: 'checkbox', default: false }, { isTrue: false })).toBe(false);
    });

    test('a flipped checkbox is changed, in both directions', () => {
        expect(isSettingChanged({ type: 'checkbox', default: true }, { isTrue: false })).toBe(true);
        expect(isSettingChanged({ type: 'checkbox', default: false }, { isTrue: true })).toBe(true);
    });

    test('checkboxWithButton counts as a checkbox', () => {
        expect(isSettingChanged({ type: 'checkboxWithButton', default: false }, { isTrue: true })).toBe(true);
    });

    test('a setting nobody has touched is at its default by definition', () => {
        expect(isSettingChanged({ type: 'checkbox', default: true }, undefined)).toBe(false);
        expect(isSettingChanged({ type: 'select', default: 'hybrid' }, null)).toBe(false);
    });

    test('a number stored as text still matches its numeric default', () => {
        // What an <input type="number"> hands back after a save round-trip
        expect(isSettingChanged({ type: 'number', default: 24 }, { value: '24' })).toBe(false);
        expect(isSettingChanged({ type: 'number', default: 24 }, { value: 12 })).toBe(true);
    });

    test('a dropdown is compared by value', () => {
        expect(isSettingChanged({ type: 'select', default: 'hybrid' }, { value: 'hybrid' })).toBe(false);
        expect(isSettingChanged({ type: 'select', default: 'hybrid' }, { value: 'optimistic' })).toBe(true);
    });

    test('a colour is compared by string', () => {
        expect(isSettingChanged({ type: 'color', default: '#047857' }, { value: '#047857' })).toBe(false);
        expect(isSettingChanged({ type: 'color', default: '#047857' }, { value: '#ff0000' })).toBe(true);
    });

    test('object-valued settings compare by structure, not identity', () => {
        const definition = { type: 'enhanceGear', default: { enabled: true, level: 10 } };
        expect(isSettingChanged(definition, { value: { enabled: true, level: 10 } })).toBe(false);
        expect(isSettingChanged(definition, { value: { enabled: true, level: 11 } })).toBe(true);
    });

    test('an empty text setting with no default is unchanged', () => {
        expect(isSettingChanged({ type: 'text', default: '' }, { value: '' })).toBe(false);
        expect(isSettingChanged({ type: 'text' }, { value: '' })).toBe(false);
        expect(isSettingChanged({ type: 'text', default: '' }, { value: 'x' })).toBe(true);
    });

    test('a setting the schema does not have cannot have changed', () => {
        expect(isSettingChanged(null, { isTrue: true })).toBe(false);
    });
});

describe('the changed list across a whole settings map', () => {
    const defaults = () => {
        const map = {};
        for (const group of Object.values(settingsGroups)) {
            for (const [id, definition] of Object.entries(group.settings)) {
                const type = definition.type || 'checkbox';
                map[id] =
                    type === 'checkbox' || type === 'checkboxWithButton'
                        ? { isTrue: definition.default ?? false }
                        : { value: definition.default ?? '' };
            }
        }
        return map;
    };

    test('a freshly defaulted map has nothing changed', () => {
        expect(changedSettingIds(defaults())).toEqual([]);
    });

    test('an empty map has nothing changed either', () => {
        expect(changedSettingIds({})).toEqual([]);
    });

    test('it names exactly the settings that were touched', () => {
        const map = defaults();
        map.actionBar_enabled.isTrue = !getSettingDefinition('actionBar_enabled').default;
        map.profitCalc_pricingMode.value = 'optimistic';
        expect(changedSettingIds(map).sort()).toEqual(['actionBar_enabled', 'profitCalc_pricingMode']);
    });

    test('it returns ids in schema order, so the panel filters in place', () => {
        const map = defaults();
        map.actionBar_enabled.isTrue = false;
        map.taskSorter.isTrue = false;
        const changed = changedSettingIds(map);
        const all = Object.values(settingsGroups).flatMap((group) => Object.keys(group.settings));
        expect(changed).toEqual(all.filter((id) => changed.includes(id)));
    });
});

describe('the settings that honestly need a reload', () => {
    test('the schema flags at least one, or the notice has nothing to point at', () => {
        expect(refreshRequiredIds().length).toBeGreaterThan(0);
    });

    test('every flagged setting really is in the schema and is a switch', () => {
        for (const id of refreshRequiredIds()) {
            const definition = getSettingDefinition(id);
            expect(definition, id).not.toBe(null);
            expect(definition.type || 'checkbox', id).toBe('checkbox');
        }
    });

    test('it is a short list — the point is that most settings are live', () => {
        const total = Object.values(settingsGroups).reduce((sum, group) => sum + Object.keys(group.settings).length, 0);
        expect(refreshRequiredIds().length).toBeLessThan(total / 10);
    });
});
