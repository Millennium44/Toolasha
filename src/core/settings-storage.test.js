/**
 * Tests for SettingsStorage import character matching
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const stored = new Map();
/** When set, every read answers "could not be made" and every write is refused */
const outage = { on: false };

vi.mock('./storage.js', () => ({
    default: {
        getJSON: vi.fn((key, _area, defaultValue) =>
            Promise.resolve(outage.on ? defaultValue : (stored.get(`json:${key}`) ?? defaultValue))
        ),
        parseJSON: vi.fn((raw, _key, defaultValue) => (raw == null ? defaultValue : raw)),
        setJSON: vi.fn((key, value) => {
            if (outage.on) return Promise.resolve(false);
            stored.set(`json:${key}`, value);
            return Promise.resolve();
        }),
        get: vi.fn((key, _area, defaultValue) =>
            Promise.resolve(outage.on ? defaultValue : (stored.get(key) ?? defaultValue))
        ),
        tryGet: vi.fn((key) => {
            if (outage.on) return Promise.resolve(null);
            const value = stored.get(`json:${key}`) ?? stored.get(key);
            return Promise.resolve(value != null ? { found: true, value } : { found: false, value: null });
        }),
        set: vi.fn((key, value) => {
            if (outage.on) return Promise.resolve(false);
            stored.set(key, value);
            return Promise.resolve();
        }),
        delete: vi.fn((key) => {
            if (outage.on) return Promise.resolve(false);
            stored.delete(`json:${key}`);
            stored.delete(key);
            return Promise.resolve(true);
        }),
        getAll: vi.fn(() => Promise.resolve({})),
        tryGetAllKeys: vi.fn(() =>
            Promise.resolve(
                outage.on ? null : [...stored.keys()].map((key) => (key.startsWith('json:') ? key.slice(5) : key))
            )
        ),
    },
}));

vi.mock('./data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'alice',
        getCurrentCharacterName: () => 'Alice',
    },
}));

const { default: settingsStorage } = await import('./settings-storage.js');
const { default: storage } = await import('./storage.js');
// The real config, over the real settings storage: the two-client regression
// below is only a regression end to end, where config decides what it changed
// and storage decides what it writes.
const { default: config } = await import('./config.js');

/**
 * Every key migration's `once` id, in schema order — what the per-character
 * record holds once a load has evaluated the whole batch.
 */
const ALL_MIGRATIONS = [
    'actionBarTimeDisplay',
    'queueCompletionTimeStyleRename',
    'patientTickSides',
    'labyrinthSimBudget',
    'marketListingAge',
    'inventoryValueBadges',
];

/**
 * Refuse the next write of a character's settings map, and only that.
 *
 * A load writes several things — the migration record, the rewrite flags — so
 * "refuse the first setJSON" no longer lands on the write a test means.
 *
 * @param {string} key - The character's settings key
 */
function refuseNextMapWrite(key) {
    const pass = storage.setJSON.getMockImplementation();
    let refused = false;
    storage.setJSON.mockImplementation((writeKey, ...rest) => {
        if (!refused && writeKey === key) {
            refused = true;
            return Promise.resolve(false);
        }
        return pass(writeKey, ...rest);
    });
}

/** The listing-age forcing (batch v3) already done, so a test can isolate the migration */
const listingAgeForced = (key) => stored.set(`settings_default_rewrites_v3_${key}`, true);

describe('SettingsStorage.importSettings known-character matching', () => {
    beforeEach(() => {
        stored.clear();
        settingsStorage.currentCharacterId = 'alice';
        settingsStorage.currentCharacterName = 'Alice';
    });

    test('skips keys suffixed with another known character id (new object format)', async () => {
        stored.set('json:known_character_ids', [
            { id: 'alice', name: 'Alice' },
            { id: 'bob', name: 'Bob' },
        ]);

        const result = await settingsStorage.importSettings(
            JSON.stringify({
                script_settingsMap_alice: { some: 'setting' },
                script_settingsMap_bob: { other: 'setting' },
                globalKey: { shared: true },
            })
        );

        expect(result).toEqual({ imported: 2, skipped: 1 });
        expect(stored.has('json:script_settingsMap_alice')).toBe(true);
        expect(stored.has('json:script_settingsMap_bob')).toBe(false);
        expect(stored.has('json:globalKey')).toBe(true);
    });

    test('recognises known characters listed in the imported payload itself', async () => {
        const result = await settingsStorage.importSettings(
            JSON.stringify({
                known_character_ids: [
                    { id: 'alice', name: 'Alice' },
                    { id: 'carol', name: 'Carol' },
                ],
                script_settingsMap_carol: { other: 'setting' },
            })
        );

        expect(result.skipped).toBe(1);
        expect(stored.has('json:script_settingsMap_carol')).toBe(false);
    });

    test('handles legacy plain-id known-character arrays in imported payloads', async () => {
        const result = await settingsStorage.importSettings(
            JSON.stringify({
                known_character_ids: ['alice', 'dave'],
                script_settingsMap_dave: { other: 'setting' },
            })
        );

        expect(result.skipped).toBe(1);
        expect(stored.has('json:script_settingsMap_dave')).toBe(false);
    });

    test('reports failure instead of counting a refused write as imported', async () => {
        outage.on = true;

        const result = await settingsStorage.importSettings(
            JSON.stringify({ script_settingsMap_alice: { some: 'setting' } })
        );

        expect(result).toBeNull();
        expect(stored.has('json:script_settingsMap_alice')).toBe(false);
        outage.on = false;
    });
});

describe('one-time rewrites of superseded schema defaults', () => {
    const KEY = 'script_settingsMap_alice';
    const FLAG = `settings_default_rewrites_v2_${KEY}`;

    /** A saved map holding the old defaults, as an existing user's would */
    const oldDefaults = () => ({
        labyrinthLiveCombatSim: { id: 'labyrinthLiveCombatSim', type: 'checkbox', isTrue: true },
        labyrinthPathUnknownMode: { id: 'labyrinthPathUnknownMode', type: 'select', value: 'clearable' },
    });

    beforeEach(() => {
        stored.clear();
        settingsStorage.currentCharacterId = 'alice';
        settingsStorage.currentCharacterName = 'Alice';
    });

    test('an existing user sitting on the old defaults is moved to the new ones', async () => {
        stored.set(`json:${KEY}`, oldDefaults());

        const settings = await settingsStorage.loadSettings();

        expect(settings.labyrinthLiveCombatSim.isTrue).toBe(false);
        expect(settings.labyrinthPathUnknownMode.value).toBe('shroud');
        // and it is persisted, not just applied in memory
        expect(stored.get(`json:${KEY}`).labyrinthLiveCombatSim.isTrue).toBe(false);
        expect(stored.get(`json:${KEY}`).labyrinthPathUnknownMode.value).toBe('shroud');
    });

    test('a value that was never the old default is left alone', async () => {
        stored.set(`json:${KEY}`, {
            labyrinthLiveCombatSim: { id: 'labyrinthLiveCombatSim', type: 'checkbox', isTrue: false },
            labyrinthPathUnknownMode: { id: 'labyrinthPathUnknownMode', type: 'select', value: 'avoid' },
        });

        const settings = await settingsStorage.loadSettings();

        expect(settings.labyrinthPathUnknownMode.value).toBe('avoid');
    });

    test('re-choosing the old value after the rewrite keeps it — this runs once', async () => {
        stored.set(`json:${KEY}`, oldDefaults());
        await settingsStorage.loadSettings();
        expect(stored.get(FLAG)).toBe(true);

        // The user goes back to the old values on purpose
        stored.set(`json:${KEY}`, oldDefaults());
        const settings = await settingsStorage.loadSettings();

        expect(settings.labyrinthLiveCombatSim.isTrue).toBe(true);
        expect(settings.labyrinthPathUnknownMode.value).toBe('clearable');
    });

    test('a fresh install gets the new defaults and is flagged, so it is never revisited', async () => {
        const settings = await settingsStorage.loadSettings();

        expect(settings.labyrinthLiveCombatSim.isTrue).toBe(false);
        expect(settings.labyrinthPathUnknownMode.value).toBe('shroud');
        expect(stored.get(FLAG)).toBe(true);
    });

    test('a rewrite that fails to save leaves the flag unset, so the next load tries again', async () => {
        stored.set(`json:${KEY}`, oldDefaults());
        // storage.setJSON answers a refused or failed write with false rather than throwing
        refuseNextMapWrite(KEY);

        const settings = await settingsStorage.loadSettings();

        // The in-memory settings are rewritten regardless...
        expect(settings.labyrinthLiveCombatSim.isTrue).toBe(false);
        expect(settings.labyrinthPathUnknownMode.value).toBe('shroud');
        // ...but the refused write never landed, and the flag was not set
        expect(stored.get(`json:${KEY}`).labyrinthLiveCombatSim.isTrue).toBe(true);
        expect(stored.get(`json:${KEY}`).labyrinthPathUnknownMode.value).toBe('clearable');
        expect(stored.get(FLAG)).toBeUndefined();

        const reloaded = await settingsStorage.loadSettings();

        expect(reloaded.labyrinthLiveCombatSim.isTrue).toBe(false);
        expect(reloaded.labyrinthPathUnknownMode.value).toBe('shroud');
        expect(stored.get(`json:${KEY}`).labyrinthLiveCombatSim.isTrue).toBe(false);
        expect(stored.get(`json:${KEY}`).labyrinthPathUnknownMode.value).toBe('shroud');
        expect(stored.get(FLAG)).toBe(true);
    });
});

describe('one-time rewrite of the inert enhanceSim_baseItemCraftingCost default', () => {
    // Unlike the labyrinth entries above, this key's stored `false` was never
    // a real choice: its only reader used to ignore storage entirely (see
    // config.js's isFeatureEnabled and the comment beside this entry in
    // settings-storage.js), so a stored `false` — however it got there — was
    // inert. The maintainer explicitly overrode the "changed defaults are
    // new-installs-only" rule for this one key.
    const KEY = 'script_settingsMap_alice';
    const FLAG = `settings_default_rewrites_v2_${KEY}`;

    beforeEach(() => {
        stored.clear();
        settingsStorage.currentCharacterId = 'alice';
        settingsStorage.currentCharacterName = 'Alice';
    });

    test('an existing user sitting on the old inert false is moved to true', async () => {
        stored.set(`json:${KEY}`, {
            enhanceSim_baseItemCraftingCost: { id: 'enhanceSim_baseItemCraftingCost', type: 'checkbox', isTrue: false },
        });

        const settings = await settingsStorage.loadSettings();

        expect(settings.enhanceSim_baseItemCraftingCost.isTrue).toBe(true);
        // and it is persisted, not just applied in memory
        expect(stored.get(`json:${KEY}`).enhanceSim_baseItemCraftingCost.isTrue).toBe(true);
    });

    test('runs once: re-storing false after the rewrite is not touched again', async () => {
        stored.set(`json:${KEY}`, {
            enhanceSim_baseItemCraftingCost: { id: 'enhanceSim_baseItemCraftingCost', type: 'checkbox', isTrue: false },
        });
        await settingsStorage.loadSettings();
        expect(stored.get(FLAG)).toBe(true);

        // The user (or something else) sets it back to false after the flag is set
        stored.set(`json:${KEY}`, {
            enhanceSim_baseItemCraftingCost: { id: 'enhanceSim_baseItemCraftingCost', type: 'checkbox', isTrue: false },
        });
        const settings = await settingsStorage.loadSettings();

        expect(settings.enhanceSim_baseItemCraftingCost.isTrue).toBe(false);
    });

    test('a rewrite that fails to save leaves the flag unset, so the next load tries again', async () => {
        stored.set(`json:${KEY}`, {
            enhanceSim_baseItemCraftingCost: { id: 'enhanceSim_baseItemCraftingCost', type: 'checkbox', isTrue: false },
        });
        refuseNextMapWrite(KEY);

        const settings = await settingsStorage.loadSettings();

        expect(settings.enhanceSim_baseItemCraftingCost.isTrue).toBe(true);
        expect(stored.get(`json:${KEY}`).enhanceSim_baseItemCraftingCost.isTrue).toBe(false);
        expect(stored.get(FLAG)).toBeUndefined();

        const reloaded = await settingsStorage.loadSettings();

        expect(reloaded.enhanceSim_baseItemCraftingCost.isTrue).toBe(true);
        expect(stored.get(`json:${KEY}`).enhanceSim_baseItemCraftingCost.isTrue).toBe(true);
        expect(stored.get(FLAG)).toBe(true);
    });

    test('a fresh install is untouched (already at the new default)', async () => {
        const settings = await settingsStorage.loadSettings();

        expect(settings.enhanceSim_baseItemCraftingCost.isTrue).toBe(true);
        expect(stored.get(FLAG)).toBe(true);
    });
});

describe('one-time migration of action and queue time display choices', () => {
    const KEY = 'script_settingsMap_alice';
    const STATE = `json:settings_key_migrations_applied_${KEY}`;

    beforeEach(() => {
        stored.clear();
        settingsStorage.currentCharacterId = 'alice';
        settingsStorage.currentCharacterName = 'Alice';
    });

    test.each([
        [true, 'both'],
        [false, 'none'],
    ])('the old action-bar checkbox value %s becomes %s and is persisted as a select', async (isTrue, expected) => {
        stored.set(`json:${KEY}`, {
            actionBar_showTimeRemaining: {
                id: 'actionBar_showTimeRemaining',
                type: 'checkbox',
                isTrue,
            },
        });

        const settings = await settingsStorage.loadSettings();

        expect(settings.actionBar_showTimeRemaining.value).toBe(expected);
        expect(settings.actionBar_showTimeRemaining).not.toHaveProperty('isTrue');
        expect(stored.get(`json:${KEY}`).actionBar_showTimeRemaining).toEqual({
            id: 'actionBar_showTimeRemaining',
            type: 'select',
            value: expected,
        });
        expect(stored.get(STATE)).toEqual(ALL_MIGRATIONS);
    });

    test('a select value already chosen by a newer build is never overwritten', async () => {
        stored.set(`json:${KEY}`, {
            actionBar_showTimeRemaining: {
                id: 'actionBar_showTimeRemaining',
                type: 'select',
                value: 'absolute',
            },
        });

        const settings = await settingsStorage.loadSettings();

        expect(settings.actionBar_showTimeRemaining.value).toBe('absolute');
    });

    test.each([
        [false, 'none'],
        [true, 'both'],
    ])('an older build writing the checkbox %s after the migration ran is read as %s', async (isTrue, expected) => {
        // The migration record says this map was converted; an older build
        // loaded on the same profile (or synced from another device) then
        // wrote its own checkbox shape over the select
        stored.set(STATE, ALL_MIGRATIONS);
        stored.set(`json:${KEY}`, {
            actionBar_showTimeRemaining: { id: 'actionBar_showTimeRemaining', type: 'checkbox', isTrue },
        });

        const settings = await settingsStorage.loadSettings();

        expect(settings.actionBar_showTimeRemaining.value).toBe(expected);
        expect(settings.actionBar_showTimeRemaining).not.toHaveProperty('isTrue');
    });

    test('a choice made after an older build wrote the checkbox survives a reload', async () => {
        stored.set(STATE, ALL_MIGRATIONS);
        stored.set(`json:${KEY}`, {
            actionBar_showTimeRemaining: { id: 'actionBar_showTimeRemaining', type: 'checkbox', isTrue: false },
        });
        config.settingsMap = {};
        config._dirtyKeys = new Set();
        config.characterSettingsLoaded = false;
        await config.loadSettings();

        config.setSettingValue('actionBar_showTimeRemaining', 'relative');
        await new Promise((resolve) => setTimeout(resolve, 0));
        const reloaded = await settingsStorage.loadSettings();

        expect(reloaded.actionBar_showTimeRemaining.value).toBe('relative');
    });

    test('the short-lived upstream queue key is carried to the Action Queue key', async () => {
        stored.set(`json:${KEY}`, {
            actionBar_completionTimeStyle: {
                id: 'actionBar_completionTimeStyle',
                type: 'select',
                value: 'relative',
            },
        });

        const settings = await settingsStorage.loadSettings();

        expect(settings.actionQueue_completionTimeStyle.value).toBe('relative');
        expect(stored.get(`json:${KEY}`).actionQueue_completionTimeStyle.value).toBe('relative');
        expect(stored.get(`json:${KEY}`).actionBar_completionTimeStyle.value).toBe('relative');
    });

    test('the final Action Queue key wins over the short-lived upstream key', async () => {
        stored.set(`json:${KEY}`, {
            actionBar_completionTimeStyle: {
                id: 'actionBar_completionTimeStyle',
                type: 'select',
                value: 'relative',
            },
            actionQueue_completionTimeStyle: {
                id: 'actionQueue_completionTimeStyle',
                type: 'select',
                value: 'both',
            },
        });

        const settings = await settingsStorage.loadSettings();

        expect(settings.actionQueue_completionTimeStyle.value).toBe('both');
    });
});

describe('one-time migration of the patient tick to one switch per side', () => {
    const KEY = 'script_settingsMap_alice';
    const STATE = `json:settings_key_migrations_applied_${KEY}`;
    const SIDES = ['profitCalc_patientTickBuy', 'profitCalc_patientTickSell'];

    /** A saved map from before the split, as an existing user's would be */
    const oldTick = (entry) => ({
        profitCalc_patientTick: { id: 'profitCalc_patientTick', type: 'checkbox', ...entry },
    });

    beforeEach(() => {
        stored.clear();
        settingsStorage.currentCharacterId = 'alice';
        settingsStorage.currentCharacterName = 'Alice';
    });

    test('the old tick on turns both sides on, persisted, and leaves the old entry for older builds', async () => {
        stored.set(`json:${KEY}`, oldTick({ isTrue: true }));

        const settings = await settingsStorage.loadSettings();

        for (const key of SIDES) {
            expect(settings[key].isTrue).toBe(true);
            expect(stored.get(`json:${KEY}`)[key].isTrue).toBe(true);
        }
        expect(stored.get(`json:${KEY}`).profitCalc_patientTick.isTrue).toBe(true);
        expect(stored.get(STATE)).toEqual(ALL_MIGRATIONS);
    });

    test('the old checkbox shape that stored its state in .value counts as on', async () => {
        stored.set(`json:${KEY}`, oldTick({ value: true }));

        const settings = await settingsStorage.loadSettings();

        for (const key of SIDES) expect(settings[key].isTrue).toBe(true);
    });

    test('the old tick off leaves both sides off and writes nothing for them', async () => {
        stored.set(`json:${KEY}`, oldTick({ isTrue: false }));

        const settings = await settingsStorage.loadSettings();

        for (const key of SIDES) {
            expect(settings[key].isTrue).toBe(false);
            expect(stored.get(`json:${KEY}`)[key]).toBeUndefined();
        }
        expect(stored.get(STATE)).toEqual(ALL_MIGRATIONS);
    });

    test('no old tick at all (a fresh install) leaves both sides off, flagged', async () => {
        const settings = await settingsStorage.loadSettings();

        for (const key of SIDES) expect(settings[key].isTrue).toBe(false);
        expect(stored.get(STATE)).toEqual(ALL_MIGRATIONS);
    });

    test('runs once: after the flag is set, the old tick is not carried again', async () => {
        stored.set(`json:${KEY}`, oldTick({ isTrue: true }));
        await settingsStorage.loadSettings();

        // A map carrying the old tick on and no per-side values, after the flag
        stored.set(`json:${KEY}`, oldTick({ isTrue: true }));
        const settings = await settingsStorage.loadSettings();

        for (const key of SIDES) expect(settings[key].isTrue).toBe(false);
    });

    test('a migrated map that fails to save leaves the flag unset, so the next load carries it again', async () => {
        stored.set(`json:${KEY}`, oldTick({ isTrue: true }));
        // storage.setJSON answers a refused or failed write with false rather than throwing
        storage.setJSON.mockImplementationOnce(() => Promise.resolve(false));

        const settings = await settingsStorage.loadSettings();

        for (const key of SIDES) expect(settings[key].isTrue).toBe(true);
        expect(stored.get(`json:${KEY}`).profitCalc_patientTickBuy).toBeUndefined();
        expect(stored.get(STATE)).toBeUndefined();

        const reloaded = await settingsStorage.loadSettings();

        for (const key of SIDES) {
            expect(reloaded[key].isTrue).toBe(true);
            expect(stored.get(`json:${KEY}`)[key].isTrue).toBe(true);
        }
        expect(stored.get(STATE)).toEqual(ALL_MIGRATIONS);
    });

    test('a side that already has a stored value keeps it', async () => {
        stored.set(`json:${KEY}`, {
            ...oldTick({ isTrue: true }),
            profitCalc_patientTickSell: { id: 'profitCalc_patientTickSell', type: 'checkbox', isTrue: false },
        });

        const settings = await settingsStorage.loadSettings();

        expect(settings.profitCalc_patientTickBuy.isTrue).toBe(true);
        expect(settings.profitCalc_patientTickSell.isTrue).toBe(false);
    });
});

/**
 * Eleven settings describing how long a labyrinth sim may run became three, and
 * nobody has to re-pick anything. The four per-panel "Uncapped" checkboxes, the
 * two precisions with disagreeing defaults and the three hour ceilings are
 * reconciled on the first load that sees them — see deriveLabyrinthSimBudget
 * for why each rule is the one it is.
 */
describe('one-time merge of the labyrinth sim budget', () => {
    const KEY = 'script_settingsMap_alice';
    const STATE = `json:settings_key_migrations_applied_${KEY}`;

    /** A saved map as an existing user's would be, before the merge */
    const oldBudget = (overrides = {}) => {
        const entry = (id, value) =>
            typeof value === 'boolean' ? { id, type: 'checkbox', isTrue: value } : { id, type: 'number', value };
        const map = {};
        const base = {
            labyrinthTileUncapped: false,
            labyrinthAutomationUncapped: false,
            labyrinthSimUncapped: false,
            labyrinthUpgradeUncapped: false,
            labyrinthSimPrecision: 1,
            labyrinthAutomationSimPrecision: 0,
            labyrinthRecommendSimHours: 3,
            labyrinthSimMaxHours: 24,
            labyrinthUpgradeMaxHours: 24,
            ...overrides,
        };
        for (const [id, value] of Object.entries(base)) map[id] = entry(id, value);
        return map;
    };

    beforeEach(() => {
        stored.clear();
        settingsStorage.currentCharacterId = 'alice';
        settingsStorage.currentCharacterName = 'Alice';
    });

    test('all four uncaps off keeps the capped rule, which is today’s behaviour', async () => {
        stored.set(`json:${KEY}`, oldBudget());

        const settings = await settingsStorage.loadSettings();

        expect(settings.labyrinthSimCaps.value).toBe('capped');
        // Nothing was carried, so nothing was written: 'capped' is the schema
        // default the loader already supplies, and writing it over every
        // existing player's map on their first load would be churn for no
        // change in behaviour
        expect(stored.get(`json:${KEY}`).labyrinthSimCaps).toBeUndefined();
        expect(stored.get(STATE)).toEqual(ALL_MIGRATIONS);
    });

    test.each([
        'labyrinthTileUncapped',
        'labyrinthAutomationUncapped',
        'labyrinthSimUncapped',
        'labyrinthUpgradeUncapped',
    ])('%s on its own is enough to mean run-to-precision', async (id) => {
        stored.set(`json:${KEY}`, oldBudget({ [id]: true }));

        const settings = await settingsStorage.loadSettings();

        expect(settings.labyrinthSimCaps.value).toBe('precision');
    });

    test('several on, with ceilings that disagree, take the most generous ceiling', async () => {
        stored.set(
            `json:${KEY}`,
            oldBudget({
                labyrinthTileUncapped: true,
                labyrinthUpgradeUncapped: true,
                labyrinthRecommendSimHours: 12,
                labyrinthSimMaxHours: 24,
                labyrinthUpgradeMaxHours: 96,
            })
        );

        const settings = await settingsStorage.loadSettings();

        expect(settings.labyrinthSimCaps.value).toBe('precision');
        // A ceiling is a backstop rather than a target, so taking the largest
        // cannot turn an answer the user gets today into a "(capped)" one
        expect(settings.labyrinthSimMaxHours.value).toBe(96);
        expect(stored.get(`json:${KEY}`).labyrinthSimMaxHours.value).toBe(96);
    });

    test('a precision tuned only on the Automation tab is carried across', async () => {
        // Their one deliberate choice about precision, and the floor map's knob
        // still sitting on its default
        stored.set(`json:${KEY}`, oldBudget({ labyrinthAutomationSimPrecision: 0.5 }));

        const settings = await settingsStorage.loadSettings();

        expect(settings.labyrinthSimPrecision.value).toBe(0.5);
    });

    test('a precision tuned on both keeps the floor map’s, which governed more surfaces', async () => {
        stored.set(`json:${KEY}`, oldBudget({ labyrinthSimPrecision: 2, labyrinthAutomationSimPrecision: 0.5 }));

        const settings = await settingsStorage.loadSettings();

        expect(settings.labyrinthSimPrecision.value).toBe(2);
    });

    test('a fresh install gets the schema defaults, with nothing migrated', async () => {
        const settings = await settingsStorage.loadSettings();

        expect(settings.labyrinthSimCaps.value).toBe('capped');
        expect(settings.labyrinthSimPrecision.value).toBe(1);
        expect(settings.labyrinthSimMaxHours.value).toBe(24);
        // Nothing was written over the (absent) map, and the flag is set so the
        // merge is never revisited
        expect(stored.get(`json:${KEY}`)).toBeUndefined();
        expect(stored.get(STATE)).toEqual(ALL_MIGRATIONS);
    });

    test('runs once: a later change of mind is not undone by the retired keys', async () => {
        stored.set(`json:${KEY}`, oldBudget({ labyrinthTileUncapped: true }));
        await settingsStorage.loadSettings();

        // The user goes back to capped, while the retired uncap still says otherwise
        const map = stored.get(`json:${KEY}`);
        map.labyrinthSimCaps = { id: 'labyrinthSimCaps', type: 'select', value: 'capped' };
        stored.set(`json:${KEY}`, map);

        const settings = await settingsStorage.loadSettings();

        expect(settings.labyrinthSimCaps.value).toBe('capped');
    });

    test('a merge that fails to save leaves the flag unset, so the next load retries', async () => {
        stored.set(`json:${KEY}`, oldBudget({ labyrinthSimUncapped: true, labyrinthUpgradeMaxHours: 96 }));
        // storage.setJSON answers a refused or failed write with false rather than throwing
        storage.setJSON.mockImplementationOnce(() => Promise.resolve(false));

        const settings = await settingsStorage.loadSettings();

        // The in-memory settings are merged regardless...
        expect(settings.labyrinthSimCaps.value).toBe('precision');
        // ...but the refused write never landed, and the flag was not set
        expect(stored.get(`json:${KEY}`).labyrinthSimCaps).toBeUndefined();
        expect(stored.get(STATE)).toBeUndefined();

        const reloaded = await settingsStorage.loadSettings();

        expect(reloaded.labyrinthSimCaps.value).toBe('precision');
        expect(stored.get(`json:${KEY}`).labyrinthSimCaps.value).toBe('precision');
        expect(stored.get(`json:${KEY}`).labyrinthSimMaxHours.value).toBe(96);
        expect(stored.get(STATE)).toEqual(ALL_MIGRATIONS);
    });
});

describe('one-time migration of the three listing-age switches to one choice', () => {
    const KEY = 'script_settingsMap_alice';
    const STATE = `json:settings_key_migrations_applied_${KEY}`;

    /**
     * A saved map from before the merge.
     * @param {boolean} listed - market_showListingAge
     * @param {boolean} topOrder - market_showTopOrderAge
     * @param {boolean} orderBook - market_showEstimatedListingAge
     * @returns {Object} The stored settings map
     */
    const oldAge = (listed, topOrder, orderBook) => ({
        market_showListingAge: { id: 'market_showListingAge', type: 'checkbox', isTrue: listed },
        market_showTopOrderAge: { id: 'market_showTopOrderAge', type: 'checkbox', isTrue: topOrder },
        market_showEstimatedListingAge: {
            id: 'market_showEstimatedListingAge',
            type: 'checkbox',
            isTrue: orderBook,
        },
    });

    beforeEach(() => {
        stored.clear();
        settingsStorage.currentCharacterId = 'alice';
        settingsStorage.currentCharacterName = 'Alice';
    });

    // The migration alone: the v3 rewrite that moves every existing character
    // to 'both' is recorded as done, so these measure what the switches derive
    beforeEach(() => listingAgeForced(KEY));

    test.each([
        [false, false, false, 'off'],
        [true, false, false, 'myListings'],
        [false, true, false, 'myListings'], // The top-order column is a My Listings age column
        [true, true, false, 'myListings'],
        [false, false, true, 'orderBook'],
        [true, false, true, 'both'],
        [false, true, true, 'both'],
        [true, true, true, 'both'],
    ])('listed=%s topOrder=%s orderBook=%s becomes %s', async (listed, topOrder, orderBook, expected) => {
        stored.set(`json:${KEY}`, oldAge(listed, topOrder, orderBook));

        const settings = await settingsStorage.loadSettings();

        expect(settings.market_listingAge.value).toBe(expected);
        expect(stored.get(`json:${KEY}`).market_listingAge.value).toBe(expected);
        expect(stored.get(STATE)).toEqual(ALL_MIGRATIONS);
    });

    test('the old entries are left where they are, for an older build on the same profile', async () => {
        stored.set(`json:${KEY}`, oldAge(true, false, false));

        await settingsStorage.loadSettings();

        expect(stored.get(`json:${KEY}`).market_showListingAge.isTrue).toBe(true);
    });

    test('a fresh install writes nothing and keeps the schema default', async () => {
        const settings = await settingsStorage.loadSettings();

        expect(settings.market_listingAge.value).toBe('both');
        expect(stored.get(`json:${KEY}`)?.market_listingAge).toBeUndefined();
        expect(stored.get(STATE)).toEqual(ALL_MIGRATIONS);
    });

    test('runs once: a later load does not overwrite a re-picked value', async () => {
        stored.set(`json:${KEY}`, oldAge(true, false, true));
        await settingsStorage.loadSettings();

        const map = stored.get(`json:${KEY}`);
        map.market_listingAge = { id: 'market_listingAge', type: 'select', value: 'off' };
        stored.set(`json:${KEY}`, map);

        const settings = await settingsStorage.loadSettings();
        expect(settings.market_listingAge.value).toBe('off');
    });

    test('a refused write leaves the flag unset, so the next load migrates again', async () => {
        stored.set(`json:${KEY}`, oldAge(true, false, true));
        refuseNextMapWrite(KEY);

        const settings = await settingsStorage.loadSettings();

        expect(settings.market_listingAge.value).toBe('both');
        expect(stored.get(`json:${KEY}`).market_listingAge).toBeUndefined();
        expect(stored.get(STATE)).toBeUndefined();

        const reloaded = await settingsStorage.loadSettings();

        expect(reloaded.market_listingAge.value).toBe('both');
        expect(stored.get(`json:${KEY}`).market_listingAge.value).toBe('both');
        expect(stored.get(STATE)).toEqual(ALL_MIGRATIONS);
    });
});

describe('one-time migration of the inventory badge switches to one choice', () => {
    const KEY = 'script_settingsMap_alice';
    const STATE = `json:settings_key_migrations_applied_${KEY}`;

    /**
     * A saved map from before the merge.
     * @param {boolean} whenSorting - invSort_showBadges
     * @param {string} onNone - invSort_badgesOnNone ('None' | 'Ask' | 'Bid')
     * @param {boolean} itemPrices - invBadgePrices
     * @returns {Object} The stored settings map
     */
    const oldBadges = (whenSorting, onNone, itemPrices) => ({
        invSort_showBadges: { id: 'invSort_showBadges', type: 'checkbox', isTrue: whenSorting },
        invSort_badgesOnNone: { id: 'invSort_badgesOnNone', type: 'select', value: onNone },
        invBadgePrices: { id: 'invBadgePrices', type: 'checkbox', isTrue: itemPrices },
    });

    beforeEach(() => {
        stored.clear();
        settingsStorage.currentCharacterId = 'alice';
        settingsStorage.currentCharacterName = 'Alice';
    });

    test.each([
        [false, 'None', false, 'off'], // 'None' doubled as the off switch
        [true, 'None', false, 'sorting'],
        [false, 'Ask', false, 'alwaysAsk'],
        [false, 'Bid', false, 'alwaysBid'],
        [true, 'Ask', false, 'alwaysAsk'],
        [false, 'None', true, 'prices'],
        // Both badge systems on: the stack value wins, because the category and
        // custom-tab totals add up exactly what it shows
        [true, 'None', true, 'sorting'],
        [false, 'Bid', true, 'alwaysBid'],
    ])('sorting=%s onNone=%s prices=%s becomes %s', async (whenSorting, onNone, itemPrices, expected) => {
        stored.set(`json:${KEY}`, oldBadges(whenSorting, onNone, itemPrices));

        const settings = await settingsStorage.loadSettings();

        expect(settings.inv_valueBadges.value).toBe(expected);
        expect(stored.get(`json:${KEY}`).inv_valueBadges.value).toBe(expected);
        expect(stored.get(STATE)).toEqual(ALL_MIGRATIONS);
    });

    test('a fresh install keeps the schema default and stores nothing', async () => {
        const settings = await settingsStorage.loadSettings();

        expect(settings.inv_valueBadges.value).toBe('sorting');
        expect(stored.get(`json:${KEY}`)?.inv_valueBadges).toBeUndefined();
    });

    test('a refused write leaves the flag unset, so the next load migrates again', async () => {
        stored.set(`json:${KEY}`, oldBadges(true, 'None', false));
        storage.setJSON.mockImplementationOnce(() => Promise.resolve(false));

        const settings = await settingsStorage.loadSettings();

        expect(settings.inv_valueBadges.value).toBe('sorting');
        expect(stored.get(STATE)).toBeUndefined();

        const reloaded = await settingsStorage.loadSettings();

        expect(reloaded.inv_valueBadges.value).toBe('sorting');
        expect(stored.get(STATE)).toEqual(ALL_MIGRATIONS);
    });
});

/**
 * What has already been carried is recorded per migration, not per batch.
 *
 * A single batch flag had to be bumped whenever an entry was added, and the bump
 * re-ran every older entry too. The seeding entries survive that — they stand
 * back from an id that already holds a value — but the reconciling one does not:
 * it overwrites ids that already hold stored values, which is the whole point
 * when several old settings merge into one of their own number, and replaying it
 * puts the retired keys back over a choice the user has since made by hand.
 */
describe('each key migration runs once, however many are added later', () => {
    const KEY = 'script_settingsMap_alice';
    const STATE = `json:settings_key_migrations_applied_${KEY}`;

    const hours = (id, value) => ({ id, type: 'number', value });
    const check = (id, isTrue) => ({ id, type: 'checkbox', isTrue });

    beforeEach(() => {
        stored.clear();
        outage.on = false;
        settingsStorage.currentCharacterId = 'alice';
        settingsStorage.currentCharacterName = 'Alice';
    });

    test('an entry already applied is not replayed while the rest of the batch runs', async () => {
        // The labyrinth budget was reconciled on an earlier load, and the user
        // has since put the Lab Sim panel's ceiling back to 6 by hand. The
        // retired per-panel ceiling is still in the map — the save paths keep ids
        // the schema no longer names — so replaying the reconcile would take the
        // largest of them and hand back 96.
        stored.set(STATE, ['labyrinthSimBudget']);
        listingAgeForced(KEY); // Measuring the migration, not the v3 forcing over it
        stored.set(`json:${KEY}`, {
            labyrinthSimMaxHours: hours('labyrinthSimMaxHours', 6),
            labyrinthUpgradeMaxHours: hours('labyrinthUpgradeMaxHours', 96),
            market_showListingAge: check('market_showListingAge', true),
        });

        const settings = await settingsStorage.loadSettings();

        expect(settings.labyrinthSimMaxHours.value).toBe(6);
        expect(stored.get(`json:${KEY}`).labyrinthSimMaxHours.value).toBe(6);
        // ...and an entry that has not run still does
        expect(settings.market_listingAge.value).toBe('myListings');
        // The record is the union of what had run and what has now, in whatever
        // order the two lists meet
        expect(stored.get(STATE)).toEqual(expect.arrayContaining(ALL_MIGRATIONS));
    });

    test('a batch flag from an earlier build counts as that batch having run', async () => {
        stored.set(`settings_key_migrations_v2_${KEY}`, true);
        stored.set(`json:${KEY}`, {
            labyrinthSimMaxHours: hours('labyrinthSimMaxHours', 6),
            labyrinthUpgradeMaxHours: hours('labyrinthUpgradeMaxHours', 96),
        });

        const settings = await settingsStorage.loadSettings();

        expect(settings.labyrinthSimMaxHours.value).toBe(6);
    });

    test('the first batch flag counts only for the entry that batch had', async () => {
        stored.set(`settings_key_migrations_v1_${KEY}`, true);
        listingAgeForced(KEY); // Measuring the migration, not the v3 forcing over it
        stored.set(`json:${KEY}`, {
            profitCalc_patientTick: check('profitCalc_patientTick', true),
            // Carried under that flag, and switched off by hand afterwards
            profitCalc_patientTickBuy: check('profitCalc_patientTickBuy', false),
            market_showEstimatedListingAge: check('market_showEstimatedListingAge', true),
        });

        const settings = await settingsStorage.loadSettings();

        expect(settings.profitCalc_patientTickBuy.isTrue).toBe(false);
        // The entries that batch did not have are carried now
        expect(settings.market_listingAge.value).toBe('orderBook');
    });
});

/**
 * A settings map that arrives wholesale from somewhere else brings its own
 * history with it. The record left behind describes a map that is no longer
 * here, and a map written by a build older than a merge carries the retired ids
 * and none of the ids that replaced them — so without forgetting the record, the
 * settings the user chose read as never chosen.
 */
describe('a settings map arriving from elsewhere is still reconciled', () => {
    const KEY = 'script_settingsMap_alice';
    /**
     * A character whose settings have already been carried across — recorded
     * both the way this build records it and the way the builds before it did,
     * since either is what a real profile is holding.
     */
    const migrated = () => {
        stored.set(`json:settings_key_migrations_applied_${KEY}`, ALL_MIGRATIONS);
        stored.set(`settings_key_migrations_v2_${KEY}`, true);
    };
    const oldMap = () => ({
        market_showEstimatedListingAge: {
            id: 'market_showEstimatedListingAge',
            type: 'checkbox',
            isTrue: true,
        },
    });

    beforeEach(() => {
        stored.clear();
        outage.on = false;
        settingsStorage.currentCharacterId = 'alice';
        settingsStorage.currentCharacterName = 'Alice';
        // These measure the merge carrying a choice across, not the v3 rewrite
        // that afterwards moves every existing character to 'both'
        listingAgeForced(KEY);
    });

    test('copying another character’s map forgets this character’s record', async () => {
        migrated();
        stored.set('json:script_settingsMap_bob', oldMap());

        expect(await settingsStorage.copySettingsFromCharacter('bob')).toBe(true);
        const settings = await settingsStorage.loadSettings();

        expect(settings.market_listingAge.value).toBe('orderBook');
    });

    test('a settings file written before the merge is reconciled on the next load', async () => {
        migrated();

        await settingsStorage.importSettings(JSON.stringify({ [KEY]: oldMap() }));
        const settings = await settingsStorage.loadSettings();

        expect(settings.market_listingAge.value).toBe('orderBook');
    });

    test('a file that brings its own record is left to it', async () => {
        await settingsStorage.importSettings(
            JSON.stringify({
                [KEY]: {
                    labyrinthSimMaxHours: { id: 'labyrinthSimMaxHours', type: 'number', value: 6 },
                    labyrinthUpgradeMaxHours: { id: 'labyrinthUpgradeMaxHours', type: 'number', value: 96 },
                },
                [`settings_key_migrations_applied_${KEY}`]: ALL_MIGRATIONS,
            })
        );
        const settings = await settingsStorage.loadSettings();

        expect(settings.labyrinthSimMaxHours.value).toBe(6);
    });

    // reconcileKeyMigrationState is the shared piece importSettings' loop above
    // uses, and what sync's applyPayload (src/features/sync/sync-payload.js)
    // calls directly with the settings-store keys a downloaded payload just
    // wrote — a payload is the same "map landed wholesale from elsewhere" case
    // as an imported file, just without going through importSettings' own
    // key-matching loop.
    test('reconcileKeyMigrationState forgets the record for a map landed without one — a payload written before the merge', async () => {
        migrated();
        stored.set(`json:${KEY}`, oldMap());

        // What applyPayload does after importEverything writes the map: hand it
        // the settings-store keys the payload just landed
        await settingsStorage.reconcileKeyMigrationState([KEY]);
        const settings = await settingsStorage.loadSettings();

        // The user's choice (market_showEstimatedListingAge: true, folded into
        // market_listingAge) survives instead of falling back to the schema
        // default of 'off'
        expect(settings.market_listingAge.value).toBe('orderBook');
    });

    test('reconcileKeyMigrationState leaves the record alone when the same batch of keys brings its own', async () => {
        migrated();
        stored.set(`json:${KEY}`, {
            labyrinthSimMaxHours: { id: 'labyrinthSimMaxHours', type: 'number', value: 6 },
            labyrinthUpgradeMaxHours: { id: 'labyrinthUpgradeMaxHours', type: 'number', value: 96 },
        });
        // A payload that also carried its own migration record for this map,
        // still saying the merge is done
        stored.set(`json:settings_key_migrations_applied_${KEY}`, ALL_MIGRATIONS);

        await settingsStorage.reconcileKeyMigrationState([KEY, `settings_key_migrations_applied_${KEY}`]);
        const settings = await settingsStorage.loadSettings();

        // Not reconciled: the hand-set ceiling of 6 is respected rather than
        // replaced by the largest of the (nonexistent) retired ids
        expect(settings.labyrinthSimMaxHours.value).toBe(6);
    });
});

describe('the marketplace buy-strategy default change is new-installs-only, by design', () => {
    // market_autoFillBuyStrategy's schema default moved from 'outbid' to
    // 'match', but — unlike the labyrinth defaults above — it has no
    // DEFAULT_REWRITES entry, deliberately: an existing user's stored
    // 'outbid' is their chosen strategy, not a stale default to be nudged off.
    // Only a fresh install (nothing stored at all) ever sees 'match'.
    const KEY = 'script_settingsMap_alice';

    beforeEach(() => {
        stored.clear();
        settingsStorage.currentCharacterId = 'alice';
        settingsStorage.currentCharacterName = 'Alice';
    });

    test('an existing user with outbid stored keeps outbid after load', async () => {
        stored.set(`json:${KEY}`, {
            market_autoFillBuyStrategy: { id: 'market_autoFillBuyStrategy', type: 'select', value: 'outbid' },
        });

        const settings = await settingsStorage.loadSettings();

        expect(settings.market_autoFillBuyStrategy.value).toBe('outbid');
        // and nothing rewrote the stored value either
        expect(stored.get(`json:${KEY}`).market_autoFillBuyStrategy.value).toBe('outbid');
    });
});

describe('the time-format default change to "auto" is new-installs-only, by design', () => {
    // market_listingTimeFormat's schema default moved from '24hour' to 'auto',
    // and — like the buy-strategy default above — it has no DEFAULT_REWRITES
    // entry. An existing user's stored '24hour' or '12hour' is a choice they
    // made, not a stale default to be nudged onto the device clock.
    const KEY = 'script_settingsMap_alice';

    beforeEach(() => {
        stored.clear();
        settingsStorage.currentCharacterId = 'alice';
        settingsStorage.currentCharacterName = 'Alice';
    });

    test('an existing user with 24hour stored keeps 24hour after load', async () => {
        stored.set(`json:${KEY}`, {
            market_listingTimeFormat: { id: 'market_listingTimeFormat', type: 'select', value: '24hour' },
        });

        const settings = await settingsStorage.loadSettings();

        expect(settings.market_listingTimeFormat.value).toBe('24hour');
        expect(stored.get(`json:${KEY}`).market_listingTimeFormat.value).toBe('24hour');
    });

    test('a fresh install with nothing stored gets auto', async () => {
        const settings = await settingsStorage.loadSettings();

        expect(settings.market_listingTimeFormat.value).toBe('auto');
    });
});

describe('the value-badge default change is new-installs-only, by design', () => {
    // inv_valueBadges's schema default moved from 'off' to 'sorting', to match
    // what the maintainer actually runs. It has no DEFAULT_REWRITES entry: an
    // existing user's stored value is a choice they made, not a stale default
    // to be nudged onto the new one. market_listingAge started the same way and
    // is now the exception — see the forcing below, which the maintainer asked
    // for because its stored value is derived rather than chosen.
    const KEY = 'script_settingsMap_alice';

    beforeEach(() => {
        stored.clear();
        settingsStorage.currentCharacterId = 'alice';
        settingsStorage.currentCharacterName = 'Alice';
    });

    test('an existing user with off stored keeps it after load', async () => {
        stored.set(`json:${KEY}`, {
            inv_valueBadges: { id: 'inv_valueBadges', type: 'select', value: 'off' },
        });

        const settings = await settingsStorage.loadSettings();

        expect(settings.inv_valueBadges.value).toBe('off');
        expect(stored.get(`json:${KEY}`).inv_valueBadges.value).toBe('off');
    });

    test('a fresh install with nothing stored gets both and sorting', async () => {
        const settings = await settingsStorage.loadSettings();

        expect(settings.market_listingAge.value).toBe('both');
        expect(settings.inv_valueBadges.value).toBe('sorting');
        // and nothing was written for either — the default is read from the schema, not stored
        expect(stored.get(`json:${KEY}`)?.market_listingAge).toBeUndefined();
        expect(stored.get(`json:${KEY}`)?.inv_valueBadges).toBeUndefined();
    });
});

describe('every existing character is moved to listing age "both", once', () => {
    // The dropdown's default is 'both', but an existing character's stored
    // value came from KEY_MIGRATIONS deriving the three switches it replaced,
    // so a character whose old switches were off or partly on never saw the new
    // default. The maintainer asked for all of them to be moved across once.
    const KEY = 'script_settingsMap_alice';
    const FLAG = `settings_default_rewrites_v3_${KEY}`;

    beforeEach(() => {
        stored.clear();
        settingsStorage.currentCharacterId = 'alice';
        settingsStorage.currentCharacterName = 'Alice';
    });

    test.each(['off', 'myListings', 'orderBook'])('a stored %s becomes both, and is saved', async (value) => {
        stored.set(`json:${KEY}`, { market_listingAge: { id: 'market_listingAge', type: 'select', value } });

        const settings = await settingsStorage.loadSettings();

        expect(settings.market_listingAge.value).toBe('both');
        expect(stored.get(`json:${KEY}`).market_listingAge.value).toBe('both');
        expect(stored.get(FLAG)).toBe(true);
    });

    test('a character still on the three old switches is migrated and then moved across', async () => {
        stored.set(`json:${KEY}`, {
            market_showEstimatedListingAge: { id: 'market_showEstimatedListingAge', type: 'checkbox', isTrue: true },
        });

        const settings = await settingsStorage.loadSettings();

        // The migration alone would have derived 'orderBook'
        expect(settings.market_listingAge.value).toBe('both');
    });

    test('runs once: a narrower value re-picked afterwards is left alone', async () => {
        stored.set(`json:${KEY}`, { market_listingAge: { id: 'market_listingAge', type: 'select', value: 'off' } });
        await settingsStorage.loadSettings();

        const map = stored.get(`json:${KEY}`);
        map.market_listingAge = { id: 'market_listingAge', type: 'select', value: 'myListings' };
        stored.set(`json:${KEY}`, map);

        const settings = await settingsStorage.loadSettings();

        expect(settings.market_listingAge.value).toBe('myListings');
    });

    test('the older rewrite batch is not replayed by this one', async () => {
        // v2 is recorded as done and the user has since turned the live combat
        // sim back on by hand; adding a batch must not undo that
        stored.set(`settings_default_rewrites_v2_${KEY}`, true);
        stored.set(`json:${KEY}`, {
            labyrinthLiveCombatSim: { id: 'labyrinthLiveCombatSim', type: 'checkbox', isTrue: true },
            market_listingAge: { id: 'market_listingAge', type: 'select', value: 'off' },
        });

        const settings = await settingsStorage.loadSettings();

        expect(settings.labyrinthLiveCombatSim.isTrue).toBe(true);
        expect(settings.market_listingAge.value).toBe('both');
    });

    test('a fresh install writes nothing and keeps the schema default', async () => {
        const settings = await settingsStorage.loadSettings();

        expect(settings.market_listingAge.value).toBe('both');
        expect(stored.get(`json:${KEY}`)?.market_listingAge).toBeUndefined();
        expect(stored.get(FLAG)).toBe(true);
    });
});

describe('SettingsStorage copy-from-character', () => {
    beforeEach(() => {
        stored.clear();
        settingsStorage.currentCharacterId = 'alice';
        settingsStorage.currentCharacterName = 'Alice';
    });

    test('syncing to other characters carries the per-character task lists along', async () => {
        stored.set('json:known_character_ids', [
            { id: 'alice', name: 'Alice' },
            { id: 'bob', name: 'Bob' },
        ]);
        stored.set('json:taskProtectedHrids_alice', ['/actions/a']);
        // No auto-reroll list for alice: bob's stays untouched

        const count = await settingsStorage.syncSettingsToAllCharacters({ featureX: { isTrue: true } });

        expect(count).toBe(1);
        expect(stored.get('json:script_settingsMap_bob')).toEqual({ featureX: { isTrue: true } });
        expect(stored.get('json:taskProtectedHrids_bob')).toEqual(['/actions/a']);
        expect(stored.has('json:taskAutoRerollHrids_bob')).toBe(false);
    });

    test('does not count a character whose settings copy was refused', async () => {
        stored.set('json:known_character_ids', [
            { id: 'alice', name: 'Alice' },
            { id: 'bob', name: 'Bob' },
        ]);
        refuseNextMapWrite('script_settingsMap_bob');

        const count = await settingsStorage.syncSettingsToAllCharacters({ featureX: { isTrue: true } });

        expect(count).toBe(0);
        expect(stored.has('json:script_settingsMap_bob')).toBe(false);
    });

    test('copies a source character map onto the current character', async () => {
        const bobMap = { featureX: { isTrue: true }, mode: { value: 'fast' } };
        stored.set('json:script_settingsMap_bob', bobMap);

        const ok = await settingsStorage.copySettingsFromCharacter('bob');

        expect(ok).toBe(true);
        expect(stored.get('json:script_settingsMap_alice')).toEqual(bobMap);
    });

    test('does not report a copy whose destination write was refused', async () => {
        stored.set('json:script_settingsMap_bob', { featureX: { isTrue: true } });
        refuseNextMapWrite('script_settingsMap_alice');

        expect(await settingsStorage.copySettingsFromCharacter('bob')).toBe(false);
        expect(stored.has('json:script_settingsMap_alice')).toBe(false);
    });

    test('refuses to copy from self, an unknown id, or an empty map', async () => {
        stored.set('json:script_settingsMap_empty', {});

        expect(await settingsStorage.copySettingsFromCharacter('alice')).toBe(false);
        expect(await settingsStorage.copySettingsFromCharacter('ghost')).toBe(false);
        expect(await settingsStorage.copySettingsFromCharacter('empty')).toBe(false);
        expect(await settingsStorage.copySettingsFromCharacter(null)).toBe(false);
        expect(stored.get('json:script_settingsMap_alice')).toBeUndefined();
    });

    test('a character switch mid-copy does not land the source map on the arriving character', async () => {
        // The destination key used to be asked for after the source read came
        // back, so the map went to whoever was current *then* — the arriving
        // character's settings replaced by a map they never asked for.
        stored.set('json:script_settingsMap_bob', { featureX: { isTrue: true } });
        storage.getJSON.mockImplementationOnce(async (key, _area, defaultValue) => {
            settingsStorage.setCharacterId('carol', 'Carol');
            return stored.get(`json:${key}`) ?? defaultValue;
        });

        expect(await settingsStorage.copySettingsFromCharacter('bob')).toBe(false);
        expect(stored.has('json:script_settingsMap_carol')).toBe(false);
        expect(stored.has('json:script_settingsMap_alice')).toBe(false);
        settingsStorage.setCharacterId('alice', 'Alice');
    });

    test('lists only other characters that actually have settings', async () => {
        stored.set('json:known_character_ids', [
            { id: 'alice', name: 'Alice' },
            { id: 'bob', name: 'Bob' },
            { id: 'carol', name: 'Carol' },
        ]);
        stored.set('json:script_settingsMap_bob', { x: { isTrue: true } });
        // carol is known but has no settings map; alice is the current character

        const candidates = await settingsStorage.charactersWithSettings();

        expect(candidates).toEqual([{ id: 'bob', name: 'Bob' }]);
    });
});

describe('a settings store that cannot be read', () => {
    const KEY = 'script_settingsMap_alice';
    /** A saved map with one choice made off the defaults */
    const saved = () => ({
        whatsNew_showPopup: { id: 'whatsNew_showPopup', type: 'checkbox', isTrue: false },
        ironCow_enabled: { id: 'ironCow_enabled', type: 'checkbox', isTrue: true },
    });

    beforeEach(() => {
        stored.clear();
        outage.on = false;
        settingsStorage.currentCharacterId = 'alice';
        settingsStorage.currentCharacterName = 'Alice';
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    test("a readable load is reported as one, and reads the user's values", async () => {
        stored.set(`json:${KEY}`, saved());
        const map = await settingsStorage.loadSettings();
        expect(settingsStorage.lastLoadReadable).toBe(true);
        expect(map.whatsNew_showPopup.isTrue).toBe(false);
        expect(map.ironCow_enabled.isTrue).toBe(true);
    });

    test('reads the character key once, not once for the probe and again to parse it', async () => {
        // loadSettings() used to follow tryGet() (a probe, to tell "absent"
        // from "could not be read") with a second getJSON() of the exact same
        // key just to get it parsed — a redundant IndexedDB round trip on
        // every settings load, on the hot startup path. It now parses the
        // value the probe already read.
        stored.set(`json:${KEY}`, saved());
        storage.getJSON.mockClear();
        storage.tryGet.mockClear();

        const map = await settingsStorage.loadSettings();

        expect(map.ironCow_enabled.isTrue).toBe(true);
        expect(storage.tryGet).toHaveBeenCalledTimes(1);
        expect(storage.getJSON).not.toHaveBeenCalledWith(KEY, expect.anything(), expect.anything());
    });

    test('a load that cannot be made says so, answers defaults, and runs no migration', async () => {
        stored.set(`json:${KEY}`, saved());
        stored.set('json:known_character_ids', [{ id: 'bob', name: 'Bob' }]);
        outage.on = true;

        const map = await settingsStorage.loadSettings();
        expect(settingsStorage.lastLoadReadable).toBe(false);
        expect(map.whatsNew_showPopup.isTrue).toBe(true);
        expect(map.ironCow_enabled.isTrue).toBe(false);

        outage.on = false;
        // Neither the map nor the known-characters list was touched
        expect(stored.get(`json:${KEY}`)).toEqual(saved());
        expect(stored.get('json:known_character_ids')).toEqual([{ id: 'bob', name: 'Bob' }]);
    });

    test('setSetting does not write a map it could not read', async () => {
        stored.set(`json:${KEY}`, saved());
        outage.on = true;
        await settingsStorage.setSetting('whatsNew_newDefaultsOff', true);
        outage.on = false;
        expect(stored.get(`json:${KEY}`)).toEqual(saved());

        // And writes once it can
        await settingsStorage.setSetting('whatsNew_newDefaultsOff', true);
        expect(stored.get(`json:${KEY}`).whatsNew_newDefaultsOff.isTrue).toBe(true);
        expect(stored.get(`json:${KEY}`).ironCow_enabled.isTrue).toBe(true);
    });

    test('setSetting does not file one character’s map under another’s key', async () => {
        // `loadSettings()` reads the key that was current when it started;
        // `saveSettings()` used to ask for the key that is current when it
        // runs. A character switch in that gap wrote the departing character's
        // whole settings map, plus this edit, over the arriving character's.
        stored.set(`json:${KEY}`, saved());
        storage.tryGet.mockImplementationOnce(async (key) => {
            settingsStorage.setCharacterId('carol', 'Carol');
            const value = stored.get(`json:${key}`) ?? stored.get(key);
            return value != null ? { found: true, value } : { found: false, value: null };
        });

        await settingsStorage.setSetting('whatsNew_newDefaultsOff', true);

        expect(stored.has('json:script_settingsMap_carol')).toBe(false);
        expect(stored.get(`json:${KEY}`)).toEqual(saved());
        settingsStorage.setCharacterId('alice', 'Alice');
    });

    describe('saveSettingsKeepingStored', () => {
        test('refuses when the store cannot be read', async () => {
            stored.set(`json:${KEY}`, saved());
            outage.on = true;
            const map = settingsStorage.buildDefaults();
            expect(await settingsStorage.saveSettingsKeepingStored(map)).toBe(false);
            outage.on = false;
            expect(stored.get(`json:${KEY}`)).toEqual(saved());
        });

        test('keeps every stored entry the session left at its default, and writes the ones it changed', async () => {
            stored.set(`json:${KEY}`, saved());
            const map = settingsStorage.buildDefaults();
            map.whatsNew_newDefaultsOff.isTrue = !map.whatsNew_newDefaultsOff.isTrue;

            expect(await settingsStorage.saveSettingsKeepingStored(map)).toBe(true);
            const after = stored.get(`json:${KEY}`);
            // The user's choices, which the session never saw, stand
            expect(after.whatsNew_showPopup.isTrue).toBe(false);
            expect(after.ironCow_enabled.isTrue).toBe(true);
            // The session's own change lands
            expect(after.whatsNew_newDefaultsOff.isTrue).toBe(map.whatsNew_newDefaultsOff.isTrue);
            // And the rest of the schema is filled in as a whole-map write would
            expect(Object.keys(after).length).toBe(Object.keys(map).length);
        });

        test('a store with nothing under the key is written whole', async () => {
            const map = settingsStorage.buildDefaults();
            expect(await settingsStorage.saveSettingsKeepingStored(map)).toBe(true);
            expect(stored.get(`json:${KEY}`)).toEqual(map);
        });

        test('reports false when the final settings write is refused', async () => {
            const map = settingsStorage.buildDefaults();
            refuseNextMapWrite(KEY);

            expect(await settingsStorage.saveSettingsKeepingStored(map)).toBe(false);
            expect(stored.has(`json:${KEY}`)).toBe(false);
        });
    });
});

describe('the known-characters roster holds one entry per character', () => {
    beforeEach(() => {
        stored.clear();
        outage.on = false;
    });

    test('a numeric game id matches the stored string entry instead of duplicating it', async () => {
        stored.set('json:known_character_ids', [{ id: '30404', name: 'MillenniumTest' }]);

        // The game sends the id as a number; before the type fix this pushed a duplicate
        await settingsStorage.addToKnownCharacters(30404, 'MillenniumTest');

        const list = await settingsStorage.getKnownCharacters();
        expect(list).toEqual([{ id: '30404', name: 'MillenniumTest' }]);
    });

    test('a roster the duplicate bug inflated heals itself on read', async () => {
        stored.set('json:known_character_ids', [
            { id: '30404', name: '30404' },
            ...Array.from({ length: 150 }, () => ({ id: 30404, name: 'MillenniumTest' })),
            ...Array.from({ length: 7 }, () => ({ id: '32030', name: 'MillenniumTestIC' })),
        ]);

        const list = await settingsStorage.getKnownCharacters();

        expect(list).toEqual([
            { id: '30404', name: 'MillenniumTest' },
            { id: '32030', name: 'MillenniumTestIC' },
        ]);
        // Healed roster is written back, so the collapse happens once
        expect(stored.get('json:known_character_ids')).toHaveLength(2);
    });

    test('a real name is never replaced by an id echoed as one', async () => {
        stored.set('json:known_character_ids', [
            { id: '30404', name: 'MillenniumTest' },
            { id: '30404', name: '30404' },
        ]);

        expect(await settingsStorage.getKnownCharacters()).toEqual([{ id: '30404', name: 'MillenniumTest' }]);
    });

    test('a genuinely new character is still added, id stored as a string', async () => {
        await settingsStorage.addToKnownCharacters(99999, 'NewAlt');

        expect(await settingsStorage.getKnownCharacters()).toEqual([{ id: '99999', name: 'NewAlt' }]);
    });
});

describe('a save keeps setting ids this build does not know about', () => {
    beforeEach(() => {
        stored.clear();
        outage.on = false;
        settingsStorage.currentCharacterId = 'alice';
        settingsStorage.currentCharacterName = 'Alice';
    });

    test('an id absent from the schema survives a whole-map write', async () => {
        // What a sync pull leaves behind: the newer build's id is on disk, and
        // this build's `loadSettings()` has no entry for it, so it is simply
        // not in the map handed to `saveSettings`
        stored.set('json:script_settingsMap_alice', {
            chatCommands: { isTrue: true },
            futureFeature_enabled: { isTrue: false },
        });

        await settingsStorage.saveSettings({ chatCommands: { isTrue: false } });

        const written = stored.get('json:script_settingsMap_alice');
        expect(written.chatCommands).toEqual({ isTrue: false });
        // Dropping this is how an old build strips settings the player chose on
        // a newer one, and they come back as defaults on the next upgrade
        expect(written.futureFeature_enabled).toEqual({ isTrue: false });
    });

    test('the caller wins for every id it does mention', async () => {
        stored.set('json:script_settingsMap_alice', { chatCommands: { isTrue: true } });

        await settingsStorage.saveSettings({ chatCommands: { isTrue: false } });

        expect(stored.get('json:script_settingsMap_alice').chatCommands).toEqual({ isTrue: false });
    });

    test('a store that cannot be read still takes the write', async () => {
        // Refusing here would lose the change the player just made, which is
        // worse than losing ids this build cannot show them anyway
        outage.on = true;
        await settingsStorage.saveSettings({ chatCommands: { isTrue: false } });
        outage.on = false;

        expect(storage.setJSON).toHaveBeenCalledWith(
            'script_settingsMap_alice',
            { chatCommands: { isTrue: false } },
            expect.anything(),
            true
        );
    });
});

describe('a saved boolean entry that carries both fields', () => {
    const KEY = 'script_settingsMap_alice';

    beforeEach(() => {
        stored.clear();
        outage.on = false;
        settingsStorage.currentCharacterId = 'alice';
        settingsStorage.currentCharacterName = 'Alice';
    });

    test('loads the value the user set, not the stale isTrue beside it', async () => {
        // The shape the old setter wrote when a ticked box was unticked: the new
        // answer went into `.value` and the stale `.isTrue` was left standing.
        stored.set(`json:${KEY}`, {
            whatsNew_showPopup: { id: 'whatsNew_showPopup', type: 'checkbox', isTrue: true, value: false },
        });

        const map = await settingsStorage.loadSettings();

        expect(map.whatsNew_showPopup.isTrue).toBe(false);
        // And the stray does not come back with it, so nothing reads it again
        expect(Object.hasOwn(map.whatsNew_showPopup, 'value')).toBe(false);
    });

    test('the same heal runs the other way round', async () => {
        stored.set(`json:${KEY}`, {
            whatsNew_showPopup: { id: 'whatsNew_showPopup', type: 'checkbox', isTrue: false, value: true },
        });

        const map = await settingsStorage.loadSettings();

        expect(map.whatsNew_showPopup.isTrue).toBe(true);
    });

    test('the checkboxWithButton value-only migration still works', async () => {
        stored.set(`json:${KEY}`, {
            simulateScrollEffects: { id: 'simulateScrollEffects', type: 'checkboxWithButton', value: true },
        });

        const map = await settingsStorage.loadSettings();

        expect(map.simulateScrollEffects.isTrue).toBe(true);
        expect(Object.hasOwn(map.simulateScrollEffects, 'value')).toBe(false);
    });

    test('a boolean entry with only isTrue is left alone', async () => {
        stored.set(`json:${KEY}`, {
            whatsNew_showPopup: { id: 'whatsNew_showPopup', type: 'checkbox', isTrue: false },
        });

        const map = await settingsStorage.loadSettings();

        expect(map.whatsNew_showPopup.isTrue).toBe(false);
    });

    test('a non-boolean setting carrying both fields is untouched by the rule', async () => {
        stored.set(`json:${KEY}`, {
            actionQueue_valueMode: {
                id: 'actionQueue_valueMode',
                type: 'select',
                value: 'estimated_value',
                isTrue: true,
            },
        });

        const map = await settingsStorage.loadSettings();

        expect(map.actionQueue_valueMode.value).toBe('estimated_value');
        // The stray boolean is dropped: config's setters write whichever field
        // an entry has, so it would take the next choice in place of `.value`
        expect(Object.hasOwn(map.actionQueue_valueMode, 'isTrue')).toBe(false);
    });
});

describe('a save carries only what this client changed', () => {
    const KEY = 'script_settingsMap_alice';

    beforeEach(() => {
        stored.clear();
        outage.on = false;
        settingsStorage.currentCharacterId = 'alice';
        settingsStorage.currentCharacterName = 'Alice';
    });

    test("another client's change to an untouched id survives", async () => {
        stored.set(`json:${KEY}`, {
            chatCommands: { isTrue: true },
            xpTracker: { isTrue: true },
        });

        // A stale map: loaded before the other client wrote xpTracker
        const stale = { chatCommands: { isTrue: false }, xpTracker: { isTrue: false } };
        await settingsStorage.saveSettings(stale, ['chatCommands']);

        const written = stored.get(`json:${KEY}`);
        expect(written.chatCommands).toEqual({ isTrue: false });
        expect(written.xpTracker).toEqual({ isTrue: true });
    });

    test('an id the store does not have at all still lands', async () => {
        stored.set(`json:${KEY}`, { chatCommands: { isTrue: true } });

        await settingsStorage.saveSettings({ chatCommands: { isTrue: true }, brandNewSetting: { isTrue: true } }, [
            'chatCommands',
        ]);

        expect(stored.get(`json:${KEY}`).brandNewSetting).toEqual({ isTrue: true });
    });

    test('SAVE_ALL_KEYS writes every setting, as the reset to defaults needs', async () => {
        stored.set(`json:${KEY}`, { chatCommands: { isTrue: true }, xpTracker: { isTrue: true } });

        const defaults = { chatCommands: { isTrue: false }, xpTracker: { isTrue: false } };
        await settingsStorage.saveSettings(defaults, settingsStorage.SAVE_ALL_KEYS);

        expect(stored.get(`json:${KEY}`)).toEqual(defaults);
    });

    test('a scoped save still keeps ids this build does not know', async () => {
        stored.set(`json:${KEY}`, {
            chatCommands: { isTrue: true },
            futureFeature_enabled: { isTrue: false },
        });

        await settingsStorage.saveSettings({ chatCommands: { isTrue: false } }, ['chatCommands']);

        expect(stored.get(`json:${KEY}`).futureFeature_enabled).toEqual({ isTrue: false });
    });

    test('a store that cannot be read still takes a scoped write', async () => {
        outage.on = true;
        await settingsStorage.saveSettings({ chatCommands: { isTrue: false } }, ['chatCommands']);
        outage.on = false;

        expect(storage.setJSON).toHaveBeenCalledWith(
            'script_settingsMap_alice',
            { chatCommands: { isTrue: false } },
            expect.anything(),
            true
        );
    });
});

describe('two clients on one character', () => {
    const KEY = 'script_settingsMap_alice';
    /** Let the setters' fire-and-forget save reach storage */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    beforeEach(() => {
        stored.clear();
        outage.on = false;
        settingsStorage.currentCharacterId = 'alice';
        settingsStorage.currentCharacterName = 'Alice';
        config._dirtyKeys = new Set();
        config.settingsMap = {};
        config.characterSettingsLoaded = false;
        config.settingChangeCallbacks = {};
        config.settingsLoadedCallbacks = [];
    });

    /**
     * One config singleton stands in for two clients: each "client" is the map
     * and dirty set it loaded, swapped in around its own writes. That is exactly
     * what a second tab holds — its own snapshot of the same store.
     */
    const asClient = (client) => {
        config.settingsMap = client.map;
        config._dirtyKeys = client.dirty;
        config.characterSettingsLoaded = true;
    };
    const loadClient = async () => {
        config.settingsMap = {};
        config._dirtyKeys = new Set();
        config.characterSettingsLoaded = false;
        await config.loadSettings();
        return { map: config.settingsMap, dirty: config._dirtyKeys };
    };

    test("a stale client's save does not revert the setting the other client changed", async () => {
        const a = await loadClient();
        const b = await loadClient();

        asClient(a);
        const xWanted = !config.getSetting('chatCommands');
        config.setSetting('chatCommands', xWanted);
        await settle();

        // B has been holding its map since before A's write, and knows nothing
        // about it — the whole-map save used to put B's stale copy of X back
        asClient(b);
        const yWanted = !config.getSetting('xpTracker');
        config.setSetting('xpTracker', yWanted);
        await settle();

        const written = stored.get(`json:${KEY}`);
        expect(written.chatCommands.isTrue).toBe(xWanted);
        expect(written.xpTracker.isTrue).toBe(yWanted);
    });

    test('a reset to defaults still writes every setting', async () => {
        const a = await loadClient();
        asClient(a);
        config.setSetting('chatCommands', !config.getSetting('chatCommands'));
        await settle();

        await config.resetToDefaults();

        const written = stored.get(`json:${KEY}`);
        const defaults = settingsStorage.buildDefaults();
        expect(Object.keys(written).length).toBe(Object.keys(defaults).length);
        expect(written.chatCommands.isTrue).toBe(defaults.chatCommands.isTrue);
    });
});
