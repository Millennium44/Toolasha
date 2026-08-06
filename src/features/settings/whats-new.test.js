/**
 * The first-run dialogs, exercised where the wrong answer costs the most.
 *
 * Two people land in `applyPolicy`'s first-run branch: a fresh install, which
 * gets a preset picker with Defaults as its safe answer, and a returning user
 * whose settings arrived from another build, who gets a picker whose safe answer
 * is "change nothing". The failure that matters is the returning user's config
 * being rewritten when they asked for it to be left alone — including when they
 * dismiss the dialog unread — so that is what these tests pin down.
 *
 * The dialog itself is mocked: `askChoice` returns whatever the test decides,
 * and records the choice list it was handed, so the assertions are about which
 * settings got written and which options were offered, not about pixels.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    answer: null,
    lastChoiceOptions: null,
    written: [],
    appliedPresets: [],
    // Setting definitions the mocked schema knows about; only their shape
    // matters — conservativeOverrides forces off the checkboxes that ship on.
    definitions: {},
}));

vi.mock('../../utils/choice-dialog.js', () => ({
    askChoice: async (options) => {
        mocks.lastChoiceOptions = options;
        return mocks.answer;
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        setSetting: (id, value) => {
            mocks.written.push([id, value]);
        },
        getSetting: () => false,
        getSettingValue: () => 0,
        Z_FLOATING_PANEL: 1000,
    },
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async () => null,
        setJSON: async () => {},
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'char-1',
    },
}));

// The schema is reduced to the definitions a test sets: conservativeOverrides
// (real, pure) reads these to decide which new switches ship on.
vi.mock('../../core/settings-schema.js', () => ({
    getAllSettingIds: () => Object.keys(mocks.definitions),
    getSettingDefinition: (id) => mocks.definitions[id] || null,
}));

// setting-presets is used for real — the returning-user picker must offer the
// genuine SETTING_PRESETS — but applyPreset is spied so a test can see it was
// called (or not) without reaching config/storage.
vi.mock('./setting-presets.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        applyPreset: async (id) => {
            mocks.appliedPresets.push(id);
            return {};
        },
    };
});

// The fork changelog is a build-time virtual module; nothing in these tests
// renders the popup, so an empty string is enough to let the import resolve.
vi.mock('virtual:fork-changelog', () => ({ default: '' }));

const { default: whatsNew } = await import('./whats-new.js');
const { SETTING_PRESETS, DEFAULT_PRESET_ID } = await import('./setting-presets.js');
const { conservativeOverrides } = await import('./whats-new-core.js');

const CURRENT = { fork: 'Toolasha', version: '2.90.0' };

/**
 * A schema where `onById` are checkboxes shipping on (the conservative policy's
 * targets) and `offById` are checkboxes shipping off.
 */
function defineSchema(onIds = [], offIds = []) {
    mocks.definitions = {};
    for (const id of onIds) mocks.definitions[id] = { type: 'checkbox', default: true };
    for (const id of offIds) mocks.definitions[id] = { type: 'checkbox', default: false };
}

beforeEach(() => {
    mocks.answer = null;
    mocks.lastChoiceOptions = null;
    mocks.written = [];
    mocks.appliedPresets = [];
    whatsNew._pending = null;
    defineSchema();
});

describe('the returning-user picker', () => {
    test('keepCurrent applies no preset and holds the conservative policy', async () => {
        defineSchema(['newFeatureA', 'newFeatureB'], ['newTuning']);
        const inherited = ['newFeatureA', 'newFeatureB', 'newTuning'];
        const conservative = conservativeOverrides(inherited, (id) => mocks.definitions[id] || null);
        mocks.answer = 'keepCurrent';

        await whatsNew._offerFirstRunChoice(inherited, CURRENT);

        expect(mocks.appliedPresets).toEqual([]);
        const written = Object.fromEntries(mocks.written);
        expect(written.whatsNew_newDefaultsOff).toBe(true);
        for (const id of conservative) expect(written[id]).toBe(false);
        // Every conservative id was switched off, and nothing else was set true
        expect(mocks.written.filter(([, value]) => value === true).map(([id]) => id)).toEqual([
            'whatsNew_newDefaultsOff',
        ]);
        expect(whatsNew._pending.newIds).toEqual(inherited);
        expect(whatsNew._pending.turnedOff).toEqual(new Set(conservative));
    });

    test('dismissal (null) behaves exactly like keepCurrent', async () => {
        defineSchema(['newFeatureA'], ['newTuning']);
        const inherited = ['newFeatureA', 'newTuning'];
        const conservative = conservativeOverrides(inherited, (id) => mocks.definitions[id] || null);
        mocks.answer = null;

        await whatsNew._offerFirstRunChoice(inherited, CURRENT);

        expect(mocks.appliedPresets).toEqual([]);
        const written = Object.fromEntries(mocks.written);
        expect(written.whatsNew_newDefaultsOff).toBe(true);
        for (const id of conservative) expect(written[id]).toBe(false);
        expect(whatsNew._pending.turnedOff).toEqual(new Set(conservative));
    });

    test('a real preset is applied and the conservative policy is not', async () => {
        defineSchema(['newFeatureA', 'newFeatureB'], []);
        const inherited = ['newFeatureA', 'newFeatureB'];
        mocks.answer = 'combat';

        await whatsNew._offerFirstRunChoice(inherited, CURRENT);

        expect(mocks.appliedPresets).toEqual(['combat']);
        // The user asked for this configuration, so nothing is force-disabled
        // and whatsNew_newDefaultsOff is left untouched
        expect(mocks.written).toEqual([]);
        expect(whatsNew._pending.newIds).toEqual([]);
        expect(whatsNew._pending.turnedOff).toEqual(new Set());
    });

    test('keepCurrent is the first, primary option and every preset follows', async () => {
        mocks.answer = 'keepCurrent';
        await whatsNew._offerFirstRunChoice(['newFeatureA'], CURRENT);

        const choices = mocks.lastChoiceOptions.choices;
        expect(choices[0].value).toBe('keepCurrent');
        expect(choices[0].tone).toBe('primary');

        const values = choices.map((choice) => choice.value);
        for (const preset of SETTING_PRESETS) expect(values).toContain(preset.id);
        // keepCurrent plus every preset, and nothing else
        expect(values).toEqual(['keepCurrent', ...SETTING_PRESETS.map((preset) => preset.id)]);
        // Exactly one primary button, the safe one
        expect(choices.filter((choice) => choice.tone === 'primary').map((choice) => choice.value)).toEqual([
            'keepCurrent',
        ]);
    });
});

describe('the fresh-install picker is unchanged', () => {
    test('it offers only presets, Defaults is primary, and there is no keepCurrent', async () => {
        mocks.answer = DEFAULT_PRESET_ID;
        await whatsNew._offerFirstRunPreset(CURRENT);

        const choices = mocks.lastChoiceOptions.choices;
        const values = choices.map((choice) => choice.value);
        expect(values).toEqual(SETTING_PRESETS.map((preset) => preset.id));
        expect(values).not.toContain('keepCurrent');

        const primary = choices.filter((choice) => choice.tone === 'primary').map((choice) => choice.value);
        expect(primary).toEqual([DEFAULT_PRESET_ID]);

        // A fresh install has nothing to keep, so a preset is always applied
        expect(mocks.appliedPresets).toEqual([DEFAULT_PRESET_ID]);
    });
});
