/** @vitest-environment happy-dom
 *
 * What the settings page is *for*, tested at the level somebody opening it sees.
 *
 * Three things here are not arithmetic and cannot be checked any other way:
 *
 * **What leads the page.** Presets are the answer to "make this script do the
 * thing I play", and they used to sit below several hundred switches with a
 * dedicated Iron Cow card in the slot a first-time reader looks at.
 *
 * **That a mode is not a preset.** Essentials and Combat are one-shots: they
 * flip switches and are then over. Iron Cow stays on, owns its settings while
 * it does, and composes with the one-shots — so its chip is pressed in, the
 * others never are, and no bulk write may move it.
 *
 * **Who a copy goes to.** "Copy Settings to IC Characters" writes a whole
 * settings map into other characters' storage. Sending it to the wrong slot is
 * silent and unrecoverable, so the target list is worth pinning.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    settingsMap: {},
    written: [],
    store: new Map(),
    characterId: 'char-1',
    characterName: 'Main',
    gameMode: 'standard',
    knownCharacters: [],
    synced: [],
    syncResult: { success: true, count: 0 },
}));

/** The smallest schema that still has an Iron Cow, a market pair and a non-market pair. */
const schema = {
    ironCow: {
        title: 'Iron Cow Mode',
        icon: '🐄',
        settings: {
            ironCow_enabled: {
                id: 'ironCow_enabled',
                label: 'Iron Cow Mode',
                type: 'checkbox',
                default: false,
                hidden: true,
                help: 'Disable all market and profit features for a no-marketplace playthrough.',
            },
        },
    },
    general: {
        title: 'General',
        icon: '⚙️',
        settings: {
            actionBar_enabled: { id: 'actionBar_enabled', label: 'Action bar', type: 'checkbox', default: true },
            combatSim: { id: 'combatSim', label: 'Combat simulator', type: 'checkbox', default: true },
        },
    },
    market: {
        title: 'Market',
        icon: '💰',
        settings: {
            itemTooltip_profit: {
                id: 'itemTooltip_profit',
                label: 'Profit in tooltips',
                type: 'checkbox',
                default: true,
            },
            networth: { id: 'networth', label: 'Net worth', type: 'checkbox', default: true },
        },
    },
};

vi.mock('../../core/settings-schema.js', () => ({
    settingsGroups: schema,
    getSettingDefinition: (id) => {
        for (const group of Object.values(schema)) {
            if (group.settings[id]) return group.settings[id];
        }
        return null;
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        get settingsMap() {
            return mocks.settingsMap;
        },
        getSetting: (id) => mocks.settingsMap[id]?.isTrue ?? false,
        getSettingValue: (id, fallback = null) => mocks.settingsMap[id]?.value ?? fallback,
        setSetting: (id, value) => {
            mocks.written.push([id, value]);
            if (mocks.settingsMap[id]) mocks.settingsMap[id].isTrue = value;
        },
        setSettingValue: (id, value) => {
            mocks.written.push([id, value]);
            if (mocks.settingsMap[id]) mocks.settingsMap[id].value = value;
        },
        clearSettingsCache: () => {},
        getKnownCharacters: async () => mocks.knownCharacters,
        syncSettingsToAllCharacters: async (ids) => {
            mocks.synced.push(ids);
            return { ...mocks.syncResult, count: mocks.syncResult.count || ids.length };
        },
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => mocks.characterId,
        getCurrentCharacterName: () => mocks.characterName,
        getCurrentCharacterGameMode: () => mocks.gameMode,
        on: () => {},
        off: () => {},
    },
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback = null) => (mocks.store.has(key) ? mocks.store.get(key) : fallback),
        set: async (key, value) => {
            mocks.store.set(key, value);
            return true;
        },
        getJSON: async (key, _store, fallback = null) => (mocks.store.has(key) ? mocks.store.get(key) : fallback),
        setJSON: async (key, value) => {
            mocks.store.set(key, value);
            return true;
        },
        delete: async (key) => {
            mocks.store.delete(key);
            return true;
        },
    },
}));

vi.mock('../../core/settings-storage.js', () => ({
    default: {
        loadSettings: async () => mocks.settingsMap,
        setSetting: async () => {},
        exportSettings: async () => '{}',
        importSettings: async () => null,
        resetToDefaults: async () => {},
    },
}));

// Everything below is a neighbour the panel merely holds a button for
vi.mock('../../api/marketplace.js', () => ({ default: { clearCacheAndRefetch: async () => true } }));
vi.mock('../combat/scroll-simulator-ui.js', () => ({ default: { openDefaultsPopup: () => {} } }));
vi.mock('../dev/pformance-panel.js', () => ({ default: { show: () => {} } }));
vi.mock('../inventory/treasure-tracker.js', () => ({ default: { show: () => {} } }));
vi.mock('../ui/overlay-panel.js', () => ({ default: { toggle: () => {} } }));
vi.mock('../sync/sync-manager.js', () => ({
    default: { initialize: async () => {}, describeStatus: async () => 'Not linked.' },
}));
vi.mock('./custom-price-overrides.js', () => ({
    getCustomPriceOverrides: () => ({}),
    getCustomPriceOverridesAsync: async () => ({}),
    setCustomPriceOverride: async () => {},
    removeCustomPriceOverride: async () => {},
    initCustomPriceOverrides: async () => {},
}));
vi.mock('../../utils/enhancement-config.js', () => ({
    getDetectedGearSettings: () => ({}),
    getEnhancingParams: () => ({}),
}));
vi.mock('../../utils/full-backup.js', () => ({
    exportEverythingJSON: async () => '{}',
    importEverything: async () => ({ restored: {} }),
}));
vi.mock('../../utils/csv-export.js', () => ({ downloadFile: () => {} }));
vi.mock('../../utils/choice-dialog.js', () => ({ askChoice: async () => null }));

const { default: settingsUI } = await import('./settings-ui.js');
const { IRON_COW_SETTINGS } = await import('./iron-cow-mode.js');
const { CHARACTER_MODES_KEY } = await import('./character-modes.js');

/** The market settings this cut-down schema shares with the real Iron Cow list. */
const LOCKED_IDS = ['itemTooltip_profit', 'networth'].filter((id) => IRON_COW_SETTINGS.has(id));

/**
 * Draw the panel into the document, the way the tab injection does.
 * @returns {HTMLElement} The card holding everything
 */
function drawPanel() {
    const panel = settingsUI.createTabPanel();
    panel.style.display = 'block';
    document.body.appendChild(panel);
    settingsUI.applyDisabledByState();
    return panel.querySelector('#toolasha-settings-content');
}

/** @returns {HTMLElement|null} The Iron Cow chip */
function chip() {
    return document.querySelector('.toolasha-mode-chip[data-mode-id="ironCow"]');
}

/**
 * @param {string} id - A setting id
 * @returns {HTMLElement|null} Its row
 */
function row(id) {
    return document.querySelector(`.toolasha-setting[data-setting-id="${id}"]`);
}

/**
 * @param {string} presetId - An id from SETTING_PRESETS
 * @returns {HTMLElement|null} Its button
 */
function presetButton(presetId) {
    return document.querySelector(`[data-preset-id="${presetId}"]`);
}

/** Let the click handlers' promises settle. @returns {Promise<void>} */
async function settle() {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
    mocks.written = [];
    mocks.store = new Map();
    mocks.characterId = 'char-1';
    mocks.characterName = 'Main';
    mocks.gameMode = 'standard';
    mocks.knownCharacters = [];
    mocks.synced = [];
    mocks.syncResult = { success: true, count: 0 };
    mocks.settingsMap = {};
    for (const group of Object.values(schema)) {
        for (const [id, definition] of Object.entries(group.settings)) {
            mocks.settingsMap[id] = { id, type: 'checkbox', isTrue: definition.default ?? false };
        }
    }

    settingsUI.currentSettings = mocks.settingsMap;
    settingsUI.collapsedGroups = new Set();
    settingsUI.restoreButton = null;

    globalThis.alert = vi.fn();
    globalThis.confirm = vi.fn(() => true);
    document.body.replaceChildren();
});

afterEach(() => {
    document.body.replaceChildren();
});

describe('what leads the page', () => {
    test('the presets block sits above the first group of settings', () => {
        const card = drawPanel();
        const blocks = [...card.children];
        const presets = card.querySelector('.toolasha-preset-buttons');
        const firstGroup = card.querySelector('.toolasha-settings-group');

        expect(presets).not.toBe(null);
        expect(blocks.indexOf(presets)).toBeLessThan(blocks.indexOf(firstGroup));
        // Only the search box gets to come first
        expect(blocks[0].className).toContain('toolasha-search-container');
        expect(blocks[1]).toBe(presets);
    });

    test('the presets block still says what it is', () => {
        const presets = drawPanel().querySelector('.toolasha-preset-buttons');
        expect(presets.textContent).toContain('Presets');
        expect(presets.textContent).toContain('Restore undoes the last one');
        expect(presetButton('essentials')).not.toBe(null);
        expect(presetButton('everything')).not.toBe(null);
    });

    test('the dedicated Iron Cow card is gone', () => {
        drawPanel();
        expect(document.getElementById('toolasha-iron-cow-toggle')).toBe(null);
        expect(typeof settingsUI.addIronCowToggle).toBe('undefined');
    });
});

describe('the Iron Cow chip', () => {
    test('it lives in the presets row, and one-shots have no pressed state', () => {
        drawPanel();
        const row = document.querySelector('.toolasha-preset-buttons .toolasha-utility-buttons');

        expect(row.contains(chip())).toBe(true);
        expect(chip().dataset.presetKind).toBe('mode');
        expect(chip().textContent).toContain('Iron Cow Mode');

        for (const button of row.querySelectorAll('[data-preset-id]')) {
            expect(button.dataset.presetKind).toBe('oneShot');
            expect(button.getAttribute('aria-pressed')).toBe(null);
        }
    });

    test('it carries the setting id, so the search and the palette can jump to it', () => {
        drawPanel();
        // The schema entry is hidden, so there is no row — the chip is the control
        expect(row('ironCow_enabled')).toBe(null);
        expect(chip().dataset.settingId).toBe('ironCow_enabled');
        expect(document.querySelector('[data-setting-id="ironCow_enabled"]')).toBe(chip());
    });

    test('searching for it points at the chip, since there is no row to find', () => {
        const card = drawPanel();
        const search = card.querySelector('.toolasha-search-input');

        search.value = 'iron cow';
        search.dispatchEvent(new Event('input', { bubbles: true }));

        expect(chip().dataset.searchMatch).toBe('true');
        expect(chip().style.outline).toContain('2px');
        // Every ordinary group has been filtered away — the chip is all there is
        for (const group of card.querySelectorAll('.toolasha-settings-group')) {
            expect(group.style.display).toBe('none');
        }

        search.value = 'action';
        search.dispatchEvent(new Event('input', { bubbles: true }));
        expect(chip().dataset.searchMatch).toBe('false');
        expect(chip().style.outline).toBe('');
    });

    test('it is drawn pressed when the mode is already on', () => {
        mocks.settingsMap.ironCow_enabled.isTrue = true;
        drawPanel();

        expect(chip().getAttribute('aria-pressed')).toBe('true');
        expect(chip().dataset.active).toBe('true');
    });

    test('clicking it turns the mode on and locks the settings it owns', async () => {
        drawPanel();
        expect(chip().dataset.active).toBe('false');

        chip().click();
        await settle();

        expect(mocks.settingsMap.ironCow_enabled.isTrue).toBe(true);
        expect(chip().getAttribute('aria-pressed')).toBe('true');
        for (const id of LOCKED_IDS) {
            expect(mocks.settingsMap[id].isTrue, id).toBe(false);
            expect(row(id).dataset.ironCowLocked, id).toBe('true');
            expect(row(id).style.pointerEvents, id).toBe('none');
        }
        // Nothing outside the mode's own list was touched
        expect(mocks.settingsMap.actionBar_enabled.isTrue).toBe(true);
    });

    test('clicking it again turns the mode off and gives the settings back', async () => {
        drawPanel();
        chip().click();
        await settle();
        chip().click();
        await settle();

        expect(mocks.settingsMap.ironCow_enabled.isTrue).toBe(false);
        expect(chip().dataset.active).toBe('false');
        for (const id of LOCKED_IDS) {
            expect(mocks.settingsMap[id].isTrue, id).toBe(true);
            expect(row(id).dataset.ironCowLocked, id).toBe(undefined);
        }
    });
});

describe('a mode stacks with a preset', () => {
    test('applying a one-shot leaves the mode on and its chip pressed', async () => {
        drawPanel();
        chip().click();
        await settle();
        mocks.written = [];

        presetButton('essentials').click();
        await settle();

        expect(mocks.written.map(([id]) => id)).not.toContain('ironCow_enabled');
        expect(mocks.settingsMap.ironCow_enabled.isTrue).toBe(true);
        expect(chip().getAttribute('aria-pressed')).toBe('true');
        // And the settings the mode owns are still locked in the panel
        for (const id of LOCKED_IDS) {
            expect(row(id).dataset.ironCowLocked, id).toBe('true');
        }
    });

    test('the preset still does its own job while the mode is on', async () => {
        mocks.settingsMap.combatSim.isTrue = false;
        drawPanel();
        chip().click();
        await settle();

        presetButton('combat').click();
        await settle();

        expect(mocks.settingsMap.combatSim.isTrue).toBe(true);
        expect(document.getElementById('combatSim').checked).toBe(true);
    });

    // Pinning today's division of labour rather than wishing for another one:
    // a bulk write owns the *values*, the mode owns the *panel*. A preset that
    // lists a market setting does write it, and the row stays locked and greyed
    // until the mode is next applied, which forces it off again.
    test('a market preset writes market values; the mode keeps the rows locked', async () => {
        drawPanel();
        chip().click();
        await settle();

        presetButton('market').click();
        await settle();

        expect(mocks.settingsMap.itemTooltip_profit.isTrue).toBe(true);
        expect(row('itemTooltip_profit').dataset.ironCowLocked).toBe('true');
        expect(chip().getAttribute('aria-pressed')).toBe('true');
    });

    test('All Off and Restore both leave the mode where it was', async () => {
        drawPanel();
        chip().click();
        await settle();
        mocks.written = [];

        await settingsUI.handleAllOff();
        expect(mocks.written.map(([id]) => id)).not.toContain('ironCow_enabled');
        expect(mocks.settingsMap.ironCow_enabled.isTrue).toBe(true);
        expect(chip().getAttribute('aria-pressed')).toBe('true');

        await settingsUI.handleRestore();
        expect(mocks.written.map(([id]) => id)).not.toContain('ironCow_enabled');
        expect(mocks.settingsMap.ironCow_enabled.isTrue).toBe(true);
        expect(chip().dataset.active).toBe('true');
    });
});

describe('copying settings to the iron cows', () => {
    beforeEach(() => {
        mocks.knownCharacters = [
            { id: 'char-1', name: 'Main' },
            { id: 'char-2', name: 'Bessie' },
            { id: 'char-3', name: 'Daisy' },
            { id: 'char-4', name: 'Alt' },
        ];
    });

    /** @returns {HTMLElement} The copy dialog's confirm button */
    function copyButton() {
        const dialog = document.querySelector('.toolasha-copy-settings-dialog');
        return [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Copy Settings');
    }

    test('the button is offered beside the copy-to-everyone one', () => {
        const card = drawPanel();
        const buttons = [...card.querySelectorAll('.toolasha-utility-button')].map((b) => b.textContent);
        expect(buttons).toContain('Copy Settings to All Characters');
        expect(buttons).toContain('Copy Settings to IC Characters');
    });

    test('it offers only the characters recorded as iron cows', async () => {
        mocks.store.set(CHARACTER_MODES_KEY, {
            'char-1': 'standard',
            'char-2': 'ironcow',
            'char-3': 'legacy_ironcow',
            'char-4': 'standard',
        });
        drawPanel();

        await settingsUI.handleSyncIronCow();

        const names = [...document.querySelectorAll('.toolasha-copy-settings-dialog span')].map((s) => s.textContent);
        expect(names).toContain('Bessie');
        expect(names).toContain('Daisy');
        expect(names).not.toContain('Alt');
        expect(names).not.toContain('Main');

        copyButton().click();
        await settle();
        expect(mocks.synced).toEqual([['char-2', 'char-3']]);
    });

    test('a character whose mode was never recorded is skipped and named', async () => {
        mocks.store.set(CHARACTER_MODES_KEY, { 'char-2': 'ironcow' });
        drawPanel();

        await settingsUI.handleSyncIronCow();
        expect(document.querySelector('.toolasha-copy-settings-note').textContent).toContain('Daisy');

        copyButton().click();
        await settle();

        expect(mocks.synced).toEqual([['char-2']]);
        const said = globalThis.alert.mock.calls.at(-1)[0];
        expect(said).toContain('1 iron cow character');
        expect(said).toContain('Daisy');
        expect(said).toContain('Alt');
    });

    test('no known iron cow says so rather than copying to everyone', async () => {
        drawPanel();
        await settingsUI.handleSyncIronCow();

        expect(document.querySelector('.toolasha-copy-settings-dialog')).toBe(null);
        expect(mocks.synced).toEqual([]);
        expect(globalThis.alert.mock.calls.at(-1)[0]).toContain('No character is known to be an iron cow yet');
    });

    test('the copy-to-everyone button is unchanged: everyone but you, counted', async () => {
        drawPanel();
        await settingsUI.handleSync();

        copyButton().click();
        await settle();

        expect(mocks.synced).toEqual([['char-2', 'char-3', 'char-4']]);
        expect(globalThis.alert.mock.calls.at(-1)[0]).toBe('Settings copied to 3 characters!');
    });
});
