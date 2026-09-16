/**
 * What's New renders the pricingSide rows (`profitCalc_pricingSideBuy` /
 * `profitCalc_pricingSideSell`) inline, the same live dropdown the Settings
 * panel, skill toolbar and alchemy Best Items build with
 * `createPricingSideSelect`.
 *
 * Before this row type was taught to `_settingRow`, a pricingSide definition
 * fell into the unknown-type branch: a heading, the help text, and an "Open
 * in Settings" link with no control. These tests drive `_settingRow` on the
 * real schema definitions and the real `pricing-side-select.js` /
 * `iron-cow-mode.js` modules — only `config.js`, `storage.js` and
 * `data-manager.js` are mocked — so a real select is what proves the fix,
 * and a real write through `applyPricingSideChoice` is what proves the row
 * shares its path with Settings rather than reimplementing it.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { Window } from 'happy-dom';

// Same trick whats-new.test.js uses: register the DOM as globals rather than
// a file-level `@vitest-environment happy-dom` directive, so the
// virtual:fork-changelog / virtual:fork-overview modules still resolve.
const domWindow = new Window();
globalThis.window = domWindow;
globalThis.document = domWindow.document;

/** `settingId` -> stored value. What both config accessors read and write. */
const store = vi.hoisted(() => ({}));
/** Every `[id, value]` pair written through `setSetting`/`setSettingValue`, in order. */
const written = vi.hoisted(() => []);

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback = null) => (key in store ? store[key] : fallback),
        getSettingValue: (key, fallback = null) => (key in store ? store[key] : fallback),
        setSetting: (key, value) => {
            store[key] = value;
            written.push([key, value]);
        },
        setSettingValue: (key, value) => {
            store[key] = value;
            written.push([key, value]);
        },
        Z_FLOATING_PANEL: 1000,
    },
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async () => null,
        setJSON: async () => {},
        delete: async () => true,
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'char-1',
    },
}));

vi.mock('virtual:fork-changelog', () => ({ default: '' }));
vi.mock('virtual:fork-overview', () => ({ default: '' }));

vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: () => {},
    unregisterFloatingPanel: () => {},
    bringPanelToFront: () => {},
}));

const openSettingsCalls = vi.hoisted(() => []);
vi.mock('../ui/command-palette.js', () => ({
    openSettings: async (...args) => {
        openSettingsCalls.push(args);
    },
}));

// The settings-schema and iron-cow-mode modules are real: the schema shape of
// the two pricingSide rows, and whether Iron Cow mode locks them, are exactly
// what this row has to get right.
const { default: whatsNew } = await import('./whats-new.js');

beforeEach(() => {
    for (const key of Object.keys(store)) delete store[key];
    written.length = 0;
    openSettingsCalls.length = 0;
});

describe('a pricingSide row (Buy)', () => {
    test('renders a real select, not the link-only fallback', () => {
        const row = whatsNew._settingRow('profitCalc_pricingSideBuy', false);
        const select = row.querySelector('select');
        expect(select).not.toBeNull();
        expect(row.querySelector('button')).toBeNull();
        expect(select.dataset.mwiPricingSide).toBe('buy');
    });

    test("choosing an option writes both the pricing mode and that side's tick", () => {
        const row = whatsNew._settingRow('profitCalc_pricingSideBuy', false);
        const select = row.querySelector('select');

        select.value = 'patientTick';
        select.dispatchEvent(new domWindow.Event('change'));

        // Unset reads as 'hybrid' (buy: ask, sell: ask); pricing the buy side
        // patiently moves buy to bid, which is the 'optimistic' mode (bid, ask)
        expect(store.profitCalc_pricingMode).toBe('optimistic');
        expect(store.profitCalc_patientTickBuy).toBe(true);
        expect(written).toContainEqual(['profitCalc_pricingMode', 'optimistic']);
        expect(written).toContainEqual(['profitCalc_patientTickBuy', true]);
    });

    test('writes through the same path Settings uses: applyPricingSideChoice', async () => {
        const { applyPricingSideChoice } = await import('../../utils/pricing-side-select.js');
        const row = whatsNew._settingRow('profitCalc_pricingSideBuy', false);
        const select = row.querySelector('select');

        select.value = 'patient';
        select.dispatchEvent(new domWindow.Event('change'));
        const fromRow = { ...store };

        for (const key of Object.keys(store)) delete store[key];
        applyPricingSideChoice('buy', 'patient');

        expect(store).toEqual(fromRow);
    });
});

describe('a pricingSide row (Sell)', () => {
    test('renders a real select for the sell side', () => {
        const row = whatsNew._settingRow('profitCalc_pricingSideSell', false);
        const select = row.querySelector('select');
        expect(select).not.toBeNull();
        expect(select.dataset.mwiPricingSide).toBe('sell');
    });

    test('choosing "Patient -1" writes the sell tick', () => {
        const row = whatsNew._settingRow('profitCalc_pricingSideSell', false);
        const select = row.querySelector('select');

        select.value = 'patientTick';
        select.dispatchEvent(new domWindow.Event('change'));

        // Unset reads as 'hybrid' (sell already priced at ask, the patient
        // basis) — the tick sits on top without moving the mode
        expect(store.profitCalc_pricingMode).toBeUndefined();
        expect(store.profitCalc_patientTickSell).toBe(true);
    });

    test('the other pricingSide row in the same popup resyncs', () => {
        const buyRow = whatsNew._settingRow('profitCalc_pricingSideBuy', false);
        const sellRow = whatsNew._settingRow('profitCalc_pricingSideSell', false);
        document.body.appendChild(buyRow);
        document.body.appendChild(sellRow);

        const buySelect = buyRow.querySelector('select');
        const sellSelect = sellRow.querySelector('select');

        // Instant/Patient naming off by default: the sell option reads "Ask (patient)"
        expect(sellSelect.options[1].textContent).toBe('Sell: Ask (patient)');

        // Something else (the Settings panel's naming checkbox, say) flips the
        // naming setting directly, then the buy row's own change fires
        store.profitCalc_pricingNaming = true;
        buySelect.dispatchEvent(new domWindow.Event('change'));

        // The sell row was never touched directly, but the buy row's handler
        // resyncs every pricingSide select on the page, not just its own
        expect(sellSelect.options[1].textContent).toBe('Sell: Patient (ask)');

        buyRow.remove();
        sellRow.remove();
    });
});

describe('Iron Cow mode locks the pricingSide rows', () => {
    beforeEach(() => {
        store.ironCow_enabled = true;
    });

    test('the row renders disabled', () => {
        const row = whatsNew._settingRow('profitCalc_pricingSideBuy', false);
        const select = row.querySelector('select');
        expect(select.disabled).toBe(true);
    });

    test('choosing an option while locked writes nothing', () => {
        const row = whatsNew._settingRow('profitCalc_pricingSideBuy', false);
        const select = row.querySelector('select');

        select.value = 'patient';
        select.disabled = false; // a script bypassing the disabled attribute, as the guard comment notes
        select.dispatchEvent(new domWindow.Event('change'));

        expect(written).toEqual([]);
        expect(store.profitCalc_pricingMode).toBeUndefined();
    });
});

describe("other What's New row types are unchanged", () => {
    test('a checkbox row still renders a checkbox and writes with setSetting', () => {
        const row = whatsNew._settingRow('whatsNew_newDefaultsOff', false);
        const input = row.querySelector('input[type="checkbox"]');
        expect(input).not.toBeNull();

        input.checked = true;
        input.dispatchEvent(new domWindow.Event('change'));

        expect(written).toContainEqual(['whatsNew_newDefaultsOff', true]);
    });

    test('a select row still renders every option and writes the chosen value', () => {
        const row = whatsNew._settingRow('market_listingAge', false);
        const select = row.querySelector('select');
        expect(select).not.toBeNull();
        const values = [...select.options].map((option) => option.value);
        expect(values).toEqual(['off', 'myListings', 'orderBook', 'both']);

        select.value = 'myListings';
        select.dispatchEvent(new domWindow.Event('change'));

        expect(written).toContainEqual(['market_listingAge', 'myListings']);
    });

    test('an unknown-type row still falls back to the "Open in Settings" link', () => {
        const row = whatsNew._settingRow('enhanceSim_resetProDefaults', false);
        const button = row.querySelector('button');
        expect(button).not.toBeNull();
        expect(button.textContent).toBe('Open in Settings');
        expect(row.querySelector('select')).toBeNull();

        button.dispatchEvent(new domWindow.Event('click'));
        expect(openSettingsCalls).toEqual([['', 'enhanceSim_resetProDefaults']]);
    });
});
