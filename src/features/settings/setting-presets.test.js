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
    stored: new Map(),
    characterId: 'char-1',
    snapshotWrite: true,
    snapshotGate: null,
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
            if (mocks.snapshotGate) await mocks.snapshotGate;
            if (mocks.snapshotWrite === 'throw') throw new Error('disk full');
            if (mocks.snapshotWrite === false) return false;
            mocks.storageWrites.push([key, value]);
            return true;
        },
        getJSON: async (key) => mocks.stored.get(key) ?? null,
        set: async (key, value) => {
            mocks.stored.set(key, value);
        },
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
    applyPresets,
    presetsForSelection,
    LEFT_OUT,
    writeCheckboxValues,
    bulkSnapshotKey,
    loadBulkSnapshot,
    clearBulkSnapshot,
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

    test('numbers, dropdowns and colors are left alone', () => {
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
        expect(values.characterCard_extraAuras).toBe(true);
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
        // ...except the LEFT_OUT switches, which no preset decides (the "Defaults" preset resets them like the rest)
        const decided = presetTargetIds().filter((id) => !(id in LEFT_OUT));
        for (const preset of SETTING_PRESETS) {
            const expected = preset.useDefaults ? presetTargetIds() : decided;
            expect(Object.keys(resolvePresetValues(preset)).sort(), preset.id).toEqual([...expected].sort());
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
        mocks.snapshotWrite = true;
        mocks.snapshotGate = null;
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
        expect(Object.keys(applied).sort()).toEqual(
            presetTargetIds()
                .filter((id) => !(id in LEFT_OUT))
                .sort()
        );
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

    test('it writes nothing when the undo snapshot reports failure', async () => {
        mocks.settingsMap.combatSim.isTrue = false;
        mocks.snapshotWrite = false;
        expect(await applyPreset('combat')).toBe(null);
        expect(mocks.written).toEqual([]);
        expect(mocks.settingsMap.combatSim.isTrue).toBe(false);
    });

    test('it writes nothing when the undo snapshot throws', async () => {
        mocks.settingsMap.combatSim.isTrue = false;
        mocks.snapshotWrite = 'throw';
        expect(await applyPreset('combat')).toBe(null);
        expect(mocks.written).toEqual([]);
    });

    test('it writes nothing to a character that arrived while the snapshot saved', async () => {
        let release;
        mocks.snapshotGate = new Promise((resolve) => (release = resolve));
        mocks.settingsMap.combatSim.isTrue = false;
        const pending = applyPreset('combat');
        // Character B loads: a fresh map and a new id
        mocks.characterId = 'char-2';
        mocks.settingsMap = { ...mocks.settingsMap, combatSim: { id: 'combatSim', type: 'checkbox', isTrue: false } };
        release();
        expect(await pending).toBe(null);
        expect(mocks.written).toEqual([]);
        expect(mocks.settingsMap.combatSim.isTrue).toBe(false);
        // A's undo copy went to A's key, not B's
        expect(mocks.storageWrites.map(([key]) => key)).toEqual([bulkSnapshotKey('char-1')]);
    });

    test('a settings reload for the same character during the snapshot save still applies, to the reloaded map', async () => {
        let release;
        mocks.snapshotGate = new Promise((resolve) => (release = resolve));
        mocks.settingsMap.combatSim.isTrue = false;
        const pending = applyPreset('combat');
        // loadSettings/resetToDefaults replace the map object; the character is unchanged
        const reloaded = {};
        for (const [id, entry] of Object.entries(mocks.settingsMap)) reloaded[id] = { ...entry };
        mocks.settingsMap = reloaded;
        release();
        expect(await pending).not.toBe(null);
        expect(mocks.settingsMap.combatSim.isTrue).toBe(true);
        expect(mocks.written.length).toBeGreaterThan(0);
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

    test('Restore clears the snapshot to null, not a delete, so a pull of the gist copy cannot bring Restore back', async () => {
        mocks.stored.set(bulkSnapshotKey(), { combatSim: false });
        expect(await loadBulkSnapshot()).toEqual({ combatSim: false });

        await clearBulkSnapshot();

        expect(mocks.stored.get(bulkSnapshotKey())).toBeNull();
        expect(await loadBulkSnapshot()).toBeNull();
    });

    test('the snapshot key is per character, because settings are', () => {
        mocks.characterId = 'char-2';
        const second = bulkSnapshotKey();
        mocks.characterId = 'char-1';
        expect(bulkSnapshotKey()).not.toBe(second);
    });
});

describe('combining presets', () => {
    beforeEach(() => {
        mocks.written = [];
        mocks.storageWrites = [];
        mocks.characterId = 'char-1';
        mocks.snapshotWrite = true;
        mocks.snapshotGate = null;
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

    test('the union is Essentials plus each ticked preset, and the rest is off', async () => {
        const applied = await applyPresets(['combat', 'market']);
        const combat = new Set(getPreset('combat').settings);
        const market = new Set(getPreset('market').settings);
        for (const [id, value] of Object.entries(applied)) {
            expect(value, id).toBe(combat.has(id) || market.has(id));
        }
        expect(applied.combatSim).toBe(true);
        expect(applied.itemTooltip_profit).toBe(true);
        // Guild was not ticked
        expect(applied.guildRoster).toBe(false);
    });

    test('ticking one preset alone matches applying it by name', async () => {
        const single = resolvePresetValues(getPreset('guild'));
        expect(await applyPresets(['guild'])).toEqual(single);
    });

    test('Essentials is the base even when it is not named', () => {
        const values = resolvePresetValues(presetsForSelection(['guild']));
        for (const id of getPreset('essentials').settings) expect(values[id], id).toBe(true);
    });

    test('Defaults is a single choice and cannot be combined', async () => {
        expect(presetsForSelection([DEFAULT_PRESET_ID, 'combat'])).toBe(null);
        expect(await applyPresets([DEFAULT_PRESET_ID, 'combat'])).toBe(null);
        expect(mocks.written).toEqual([]);
        expect(await applyPresets([DEFAULT_PRESET_ID])).toEqual(defaultCheckboxValues());
    });

    test('an unknown or empty selection changes nothing', async () => {
        expect(await applyPresets(['combat', 'nope'])).toBe(null);
        expect(await applyPresets([])).toBe(null);
        expect(mocks.written).toEqual([]);
        expect(mocks.storageWrites).toEqual([]);
    });

    test('one snapshot is taken for the whole combined apply, and Restore puts every switch back', async () => {
        mocks.settingsMap.combatSim.isTrue = false;
        mocks.settingsMap.guildRoster.isTrue = true;
        const before = Object.fromEntries(presetTargetIds().map((id) => [id, mocks.settingsMap[id].isTrue]));

        await applyPresets(['combat', 'market']);
        expect(mocks.storageWrites.length).toBe(1);
        const [, snapshot] = mocks.storageWrites[0];
        expect(snapshot).toEqual(before);
        expect(mocks.settingsMap.guildRoster.isTrue).toBe(false);

        // Restore writes the snapshot back through the same path
        writeCheckboxValues(snapshot);
        const after = Object.fromEntries(presetTargetIds().map((id) => [id, mocks.settingsMap[id].isTrue]));
        expect(after).toEqual(before);
    });

    test('a LEFT_OUT switch keeps its value through a combined apply and through Restore', async () => {
        // Ships on as the child of a default-off feature; the player may have turned it off on purpose
        mocks.settingsMap.market_bulkSellHoldFavorites.isTrue = true;
        mocks.settingsMap.market_bulkSellVendorCheck.isTrue = false;

        const applied = await applyPresets(['combat', 'market']);
        expect(applied).not.toHaveProperty('market_bulkSellHoldFavorites');
        expect(applied).not.toHaveProperty('market_bulkSellVendorCheck');
        expect(mocks.written.map(([id]) => id)).not.toContain('market_bulkSellHoldFavorites');
        expect(mocks.settingsMap.market_bulkSellHoldFavorites.isTrue).toBe(true);
        expect(mocks.settingsMap.market_bulkSellVendorCheck.isTrue).toBe(false);

        const [, snapshot] = mocks.storageWrites[0];
        writeCheckboxValues(snapshot);
        expect(mocks.settingsMap.market_bulkSellHoldFavorites.isTrue).toBe(true);
        expect(mocks.settingsMap.market_bulkSellVendorCheck.isTrue).toBe(false);
    });

    test('a character who arrived while the snapshot saved gets nothing from a combined apply', async () => {
        let release;
        mocks.snapshotGate = new Promise((resolve) => (release = resolve));
        const pending = applyPresets(['combat', 'market']);
        mocks.characterId = 'char-2';
        release();
        expect(await pending).toBe(null);
        expect(mocks.written).toEqual([]);
        expect(mocks.storageWrites.map(([key]) => key)).toEqual([bulkSnapshotKey('char-1')]);
    });

    test('applyPreset is a wrapper over a one-preset combination', async () => {
        const viaWrapper = await applyPreset('combat');
        expect(viaWrapper).toEqual(resolvePresetValues(presetsForSelection(['combat'])));
    });
});

describe('every default-on switch belongs to a preset', () => {
    const visibleCheckboxes = [];
    for (const group of Object.values(settingsGroups)) {
        for (const [id, definition] of Object.entries(group.settings)) {
            if (definition.hidden) continue;
            if (!BOOLEAN_TYPES.has(definition.type || 'checkbox')) continue;
            if (PRESET_EXCLUDED_IDS.has(id)) continue;
            visibleCheckboxes.push([id, definition]);
        }
    }
    const listed = new Set(SETTING_PRESETS.flatMap((preset) => preset.settings || []));

    test('a visible switch that ships on is in a preset or on the LEFT_OUT list', () => {
        const missing = visibleCheckboxes
            .filter(([id, definition]) => (definition.default ?? false) && !listed.has(id) && !(id in LEFT_OUT))
            .map(([id]) => id);
        expect(
            missing,
            `New default-on switch(es) in no preset: ${missing.join(', ')}. A preset switches off everything it ` +
                'does not list, so add each to ESSENTIALS (reads the game, no prices), COMBAT_EXTRAS, MARKET_EXTRAS ' +
                '(needs a price) or GUILD_EXTRAS in setting-presets.js, in every preset whose players would use it. ' +
                'If it belongs in none, add it to LEFT_OUT with a reason.'
        ).toEqual([]);
    });

    test('LEFT_OUT names real switches, with a reason, that are in no preset', () => {
        for (const [id, reason] of Object.entries(LEFT_OUT)) {
            expect(getSettingDefinition(id), `${id} is not in the schema`).not.toBe(null);
            expect(reason.length, id).toBeGreaterThan(5);
            expect(listed.has(id), `${id} is both listed in a preset and left out`).toBe(false);
        }
    });

    test('a listed child comes with its parent in the same preset', () => {
        for (const preset of SETTING_PRESETS) {
            const ids = new Set(preset.settings || []);
            for (const id of ids) {
                const parent = getSettingDefinition(id)?.requires;
                if (!parent) continue;
                expect(ids.has(parent), `${preset.id} lists ${id} but not its parent ${parent}`).toBe(true);
            }
        }
    });

    test('Essentials is the base of every combination, so it holds nothing priced or simulated', () => {
        const essentials = new Set(getPreset('essentials').settings);
        for (const id of ['combatSim', 'labSim']) {
            expect(essentials.has(id), id).toBe(false);
        }
        const priced = [...essentials].filter((id) => getSettingDefinition(id)?.needsPrices);
        expect(
            priced,
            `ESSENTIALS holds priced setting(s): ${priced.join(', ')}. Essentials is the base of every combination, ` +
                'so it must hold nothing that needs a price feed: move them to MARKET_EXTRAS in setting-presets.js, ' +
                'or drop `needsPrices` from the schema if the setting does not show market prices.'
        ).toEqual([]);
    });

    test('a priced default-on switch is in the Market preset, and the Market preset holds only priced extras', () => {
        const essentials = new Set(getPreset('essentials').settings);
        const market = new Set(getPreset('market').settings);
        const missing = visibleCheckboxes
            .filter(([, definition]) => definition.needsPrices && (definition.default ?? false))
            .map(([id]) => id)
            .filter((id) => !market.has(id) && !(id in LEFT_OUT));
        expect(
            missing,
            `Priced default-on switch(es) not in the Market preset: ${missing.join(', ')}. Add each to ` +
                'MARKET_EXTRAS in setting-presets.js, or to LEFT_OUT with a reason.'
        ).toEqual([]);
        const unflagged = [...market].filter((id) => !essentials.has(id) && !getSettingDefinition(id)?.needsPrices);
        expect(
            unflagged,
            `MARKET_EXTRAS lists ${unflagged.join(', ')} but the schema does not declare \`needsPrices: true\` for ` +
                'it. Add the flag next to the setting (it shows market prices) or move it to another preset.'
        ).toEqual([]);
    });

    test('Guild is Essentials plus guild switches', () => {
        const guild = new Set(getPreset('guild').settings);
        expect(guild.has('guildRoster')).toBe(true);
        expect(guild.has('combatSim')).toBe(false);
    });
});
