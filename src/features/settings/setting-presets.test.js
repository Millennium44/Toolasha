/**
 * Presets are a hand-written table pointing at a schema that keeps growing, and
 * the failure mode is silent: a setting gets renamed, the preset keeps naming
 * the old id, and "Combat" quietly stops turning the tracker on. Nothing in the
 * running script notices — `writeCheckboxValues` skips ids config has never
 * heard of — so the test that every id still exists is the whole reason this
 * file is here.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    settingsMap: {},
    written: [],
    storageWrites: [],
    characterId: 'char-1',
}));

vi.mock('../../core/config.js', () => ({
    default: {
        get settingsMap() {
            return mocks.settingsMap;
        },
        setSetting: (id, value) => {
            mocks.written.push([id, value]);
            if (mocks.settingsMap[id]) mocks.settingsMap[id].isTrue = value;
        },
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => mocks.characterId,
    },
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        setJSON: async (key, value) => {
            mocks.storageWrites.push([key, value]);
        },
        getJSON: async () => null,
        delete: async () => {},
    },
}));

const { settingsGroups, getSettingDefinition } = await import('../../core/settings-schema.js');
const {
    SETTING_PRESETS,
    MODE_PRESETS,
    DEFAULT_PRESET_ID,
    PRESET_EXCLUDED_IDS,
    getPreset,
    getModePreset,
    presetTargetIds,
    defaultCheckboxValues,
    resolvePresetValues,
    applyPreset,
    writeCheckboxValues,
    bulkSnapshotKey,
} = await import('./setting-presets.js');

const BOOLEAN_TYPES = new Set(['checkbox', 'checkboxWithButton']);

describe('the preset table matches the schema', () => {
    test('every preset has an id, a label and a description', () => {
        for (const preset of SETTING_PRESETS) {
            expect(preset.id, JSON.stringify(preset)).toBeTruthy();
            expect(preset.label, preset.id).toBeTruthy();
            expect(preset.description, preset.id).toBeTruthy();
        }
    });

    test('preset ids are unique', () => {
        const ids = SETTING_PRESETS.map((preset) => preset.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    // The one that stops presets rotting: a renamed or deleted setting makes
    // the preset silently weaker, and nothing at runtime complains
    test('every id in every preset exists in the schema', () => {
        for (const preset of SETTING_PRESETS) {
            for (const id of preset.settings || []) {
                expect(
                    getSettingDefinition(id),
                    `${preset.id} names a setting the schema does not have: ${id}`
                ).not.toBe(null);
            }
        }
    });

    test('every id in every preset is a switch a bulk write can set', () => {
        for (const preset of SETTING_PRESETS) {
            for (const id of preset.settings || []) {
                const type = getSettingDefinition(id)?.type || 'checkbox';
                expect(BOOLEAN_TYPES.has(type), `${preset.id} lists ${id}, which is a ${type}`).toBe(true);
            }
        }
    });

    test('no preset lists the same setting twice', () => {
        for (const preset of SETTING_PRESETS) {
            const ids = preset.settings || [];
            expect(new Set(ids).size, `${preset.id} has duplicates`).toBe(ids.length);
        }
    });

    test('no preset touches an excluded setting', () => {
        for (const preset of SETTING_PRESETS) {
            for (const id of preset.settings || []) {
                expect(PRESET_EXCLUDED_IDS.has(id), `${preset.id} lists excluded ${id}`).toBe(false);
            }
        }
    });

    test('the dismissal default is a real preset', () => {
        expect(getPreset(DEFAULT_PRESET_ID)).not.toBe(null);
    });

    test('the curated presets are actually different from each other', () => {
        const curated = SETTING_PRESETS.filter((preset) => preset.settings);
        expect(curated.length).toBeGreaterThan(1);
        const shapes = curated.map((preset) => [...preset.settings].sort().join(','));
        expect(new Set(shapes).size).toBe(shapes.length);
    });

    test('Combat and Market are both supersets of Essentials', () => {
        const essentials = new Set(getPreset('essentials').settings);
        for (const id of getPreset('combat').settings) essentials.delete(id);
        expect([...essentials]).toEqual([]);

        const again = new Set(getPreset('essentials').settings);
        for (const id of getPreset('market').settings) again.delete(id);
        expect([...again]).toEqual([]);
    });
});

describe('modes sit beside the presets without being one', () => {
    test('every mode names a label, an icon, a description and the setting it owns', () => {
        expect(MODE_PRESETS.length).toBeGreaterThan(0);
        for (const mode of MODE_PRESETS) {
            expect(mode.id, JSON.stringify(mode)).toBeTruthy();
            expect(mode.label, mode.id).toBeTruthy();
            expect(mode.icon, mode.id).toBeTruthy();
            expect(mode.description, mode.id).toBeTruthy();
            expect(mode.settingId, mode.id).toBeTruthy();
            expect(mode.kind, mode.id).toBe('mode');
        }
    });

    test('Iron Cow is one of them, and is found by id', () => {
        expect(getModePreset('ironCow')?.settingId).toBe('ironCow_enabled');
        expect(getModePreset('essentials')).toBe(null);
        expect(getPreset('ironCow')).toBe(null);
    });

    test('mode ids never collide with preset ids', () => {
        const presetIds = new Set(SETTING_PRESETS.map((preset) => preset.id));
        for (const mode of MODE_PRESETS) {
            expect(presetIds.has(mode.id), `${mode.id} is both a mode and a preset`).toBe(false);
        }
    });

    // The whole reason a mode is a separate list: a one-shot sweep that flipped
    // it would strand the mode's own snapshot of everything it force-disables
    test('every mode setting is real, excluded, and outside every bulk write', () => {
        const targets = new Set(presetTargetIds());
        for (const mode of MODE_PRESETS) {
            expect(getSettingDefinition(mode.settingId), mode.settingId).not.toBe(null);
            expect(PRESET_EXCLUDED_IDS.has(mode.settingId), mode.settingId).toBe(true);
            expect(targets.has(mode.settingId), mode.settingId).toBe(false);
        }
        for (const preset of SETTING_PRESETS) {
            const values = resolvePresetValues(preset);
            for (const mode of MODE_PRESETS) {
                expect(mode.settingId in values, `${preset.id} decides ${mode.settingId}`).toBe(false);
            }
        }
    });

    test('a bulk write refuses a mode even when handed one directly', () => {
        mocks.written = [];
        mocks.settingsMap = { ironCow_enabled: { id: 'ironCow_enabled', type: 'checkbox', isTrue: true } };

        expect(writeCheckboxValues({ ironCow_enabled: false })).toEqual([]);
        expect(mocks.written).toEqual([]);
        expect(mocks.settingsMap.ironCow_enabled.isTrue).toBe(true);
    });
});

describe('which settings a bulk write owns', () => {
    test('only boolean settings, and never the excluded ones', () => {
        const targets = presetTargetIds();
        expect(targets.length).toBeGreaterThan(100);
        for (const id of targets) {
            expect(BOOLEAN_TYPES.has(getSettingDefinition(id).type || 'checkbox')).toBe(true);
            expect(PRESET_EXCLUDED_IDS.has(id)).toBe(false);
        }
    });

    test('Iron Cow mode is not something a preset can flip', () => {
        expect(presetTargetIds()).not.toContain('ironCow_enabled');
    });

    test('numbers, dropdowns and colours are left alone', () => {
        const targets = new Set(presetTargetIds());
        expect(targets.has('profitCalc_pricingMode')).toBe(false);
        expect(targets.has('color_profit')).toBe(false);
        expect(targets.has('enhanceSim_enhancingLevel')).toBe(false);
    });

    test('compound gear rows and action buttons are not switches, and are never written', () => {
        // A bulk write putting a boolean where {enabled, tier, level} lives —
        // or "storing" a button — would corrupt the setting for every reader
        const targets = new Set(presetTargetIds());
        expect(getSettingDefinition('enhanceSim_gear_enhancer').type).toBe('enhanceGear');
        expect(targets.has('enhanceSim_gear_enhancer')).toBe(false);
        expect(getSettingDefinition('enhanceSim_resetProDefaults').type).toBe('button');
        expect(targets.has('enhanceSim_resetProDefaults')).toBe(false);
        expect(defaultCheckboxValues()).not.toHaveProperty('enhanceSim_resetProDefaults');
        expect(defaultCheckboxValues()).not.toHaveProperty('enhanceSim_gear_enhancer');
    });
});

describe('what a preset resolves to', () => {
    test('a listed setting is on and an unlisted one is off', () => {
        const values = resolvePresetValues(getPreset('essentials'));
        expect(values.actionBar_enabled).toBe(true);
        // Essentials is deliberately market-free
        expect(values.itemTooltip_prices).toBe(false);
        expect(values.networth).toBe(false);
    });

    test('Combat turns the simulators on and leaves the market off', () => {
        const values = resolvePresetValues(getPreset('combat'));
        expect(values.combatSim).toBe(true);
        expect(values.labSim).toBe(true);
        expect(values.damageTracker).toBe(true);
        expect(values.market_showListingPrices).toBe(false);
        expect(values.itemTooltip_profit).toBe(false);
    });

    test('Market turns pricing on and leaves the simulators off', () => {
        const values = resolvePresetValues(getPreset('market'));
        expect(values.itemTooltip_profit).toBe(true);
        expect(values.networth).toBe(true);
        expect(values.market_showListingPrices).toBe(true);
        expect(values.combatSim).toBe(false);
    });

    test('"Defaults" is the shipped defaults, not every switch true', () => {
        const values = resolvePresetValues(getPreset(DEFAULT_PRESET_ID));
        expect(values).toEqual(defaultCheckboxValues());
        // hideGuildBadge ships off; "Defaults" must not mean hiding things
        expect(values.hideGuildBadge).toBe(false);
        expect(values.actionBar_enabled).toBe(true);
    });

    test('it covers every setting a bulk write owns, and nothing else', () => {
        for (const preset of SETTING_PRESETS) {
            expect(Object.keys(resolvePresetValues(preset)).sort()).toEqual([...presetTargetIds()].sort());
        }
    });

    test('an unknown preset resolves to nothing rather than throwing', () => {
        expect(resolvePresetValues(null)).toEqual({});
    });
});

describe('applying a preset', () => {
    beforeEach(() => {
        mocks.written = [];
        mocks.storageWrites = [];
        mocks.characterId = 'char-1';
        mocks.settingsMap = {};
        for (const group of Object.values(settingsGroups)) {
            for (const [id, definition] of Object.entries(group.settings)) {
                const type = definition.type || 'checkbox';
                mocks.settingsMap[id] = BOOLEAN_TYPES.has(type)
                    ? { id, type, isTrue: definition.default ?? false }
                    : { id, type, value: definition.default ?? '' };
            }
        }
    });

    test('it decides a value for every setting it owns', async () => {
        const applied = await applyPreset('essentials');
        expect(Object.keys(applied).sort()).toEqual([...presetTargetIds()].sort());
        // Every setting either already held its wanted value or was written to it
        for (const [id, value] of Object.entries(applied)) {
            expect(mocks.settingsMap[id].isTrue, id).toBe(value);
        }
    });

    test('it leaves settings that already hold the wanted value alone', async () => {
        // Every setSetting persists the whole map; on a fresh install
        // "Defaults" is already true and should cost nothing
        await applyPreset(DEFAULT_PRESET_ID);
        expect(mocks.written).toEqual([]);
    });

    test('it writes the resolved values through config', async () => {
        mocks.settingsMap.combatSim.isTrue = false;
        await applyPreset('combat');

        const written = Object.fromEntries(mocks.written);
        expect(written.combatSim).toBe(true);
        expect(written.market_showListingPrices).toBe(false);
        expect(mocks.settingsMap.combatSim.isTrue).toBe(true);
        expect(mocks.settingsMap.market_showListingPrices.isTrue).toBe(false);
    });

    test('it snapshots first, so Restore can undo it', async () => {
        mocks.settingsMap.combatSim.isTrue = false;
        await applyPreset('combat');

        expect(mocks.storageWrites.length).toBe(1);
        const [key, snapshot] = mocks.storageWrites[0];
        expect(key).toBe(bulkSnapshotKey());
        // Snapshot is the state from before the write, not after it
        expect(snapshot.combatSim).toBe(false);
        expect(mocks.settingsMap.combatSim.isTrue).toBe(true);
    });

    test('it never writes an excluded setting', async () => {
        await applyPreset('essentials');
        expect(mocks.written.map(([id]) => id)).not.toContain('ironCow_enabled');
    });

    test('an unknown preset changes nothing', async () => {
        expect(await applyPreset('nope')).toBe(null);
        expect(mocks.written).toEqual([]);
        expect(mocks.storageWrites).toEqual([]);
    });

    test('the snapshot key is per character, because settings are', () => {
        mocks.characterId = 'char-2';
        const second = bulkSnapshotKey();
        mocks.characterId = 'char-1';
        expect(bulkSnapshotKey()).not.toBe(second);
    });
});
