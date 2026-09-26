/** @vitest-environment happy-dom */

/**
 * The shared Buy/Sell/Key pricing row: shows the schema options, reflects the
 * current settings, and writes through the same helpers the settings panel
 * and the pricing-side dropdowns use. Party Loot and the combat simulator
 * each mount one; their own suites cover where it sits and what re-renders.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

/** A small live config: values, and every write in order */
const live = vi.hoisted(() => ({ values: {}, writes: [] }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => live.values[key],
        getSettingValue: (key, fallback) => live.values[key] ?? fallback,
        setSetting: (key, value) => {
            live.values[key] = value;
            live.writes.push([key, value]);
        },
        setSettingValue: (key, value) => {
            live.values[key] = value;
            live.writes.push([key, value]);
        },
    },
}));

const { createPricingQuickSettings, KEY_PRICING_SETTING, PRICING_QUICK_SETTINGS_KEYS } =
    await import('./pricing-quick-settings.js');

beforeEach(() => {
    live.values = {
        profitCalc_pricingMode: 'hybrid',
        profitCalc_patientTickBuy: false,
        profitCalc_patientTickSell: false,
        profitCalc_pricingNaming: false,
        profitCalc_keyPricingMode: 'ask',
        ironCow_enabled: false,
    };
    live.writes = [];
});

/** The three selects, in the order the row appends them */
function selectsOf(element) {
    return Array.from(element.querySelectorAll('select'));
}

describe('createPricingQuickSettings', () => {
    test('renders three selects: buy, sell, key', () => {
        const { element } = createPricingQuickSettings();
        const selects = selectsOf(element);
        expect(selects).toHaveLength(3);
        expect(selects[0].dataset.mwiPricingSide).toBe('buy');
        expect(selects[1].dataset.mwiPricingSide).toBe('sell');
        expect(selects[2].dataset.mwiKeyPricing).toBe('true');
    });

    test('the key select carries the schema options and labels, in order', () => {
        const { element } = createPricingQuickSettings();
        const keySelect = selectsOf(element)[2];
        const options = Array.from(keySelect.options).map((option) => ({
            value: option.value,
            label: option.textContent,
        }));
        expect(options).toEqual([
            { value: 'ask', label: 'Keys: Ask (instant buy)' },
            { value: 'bid', label: 'Keys: Bid (patient buy)' },
            { value: 'synced', label: 'Keys: Same as the profit calculation pricing mode' },
            { value: 'craft', label: 'Keys: What it costs you to craft one' },
        ]);
    });

    test('every select reflects the current settings on build', () => {
        live.values.profitCalc_pricingMode = 'optimistic';
        live.values.profitCalc_keyPricingMode = 'craft';
        const { element } = createPricingQuickSettings();
        const [buySelect, sellSelect, keySelect] = selectsOf(element);
        expect(buySelect.value).toBe('patient');
        expect(sellSelect.value).toBe('patient');
        expect(keySelect.value).toBe('craft');
    });

    test('choosing a buy/sell option writes through applyPricingSideChoice and calls onChange', () => {
        const onChange = vi.fn();
        const { element } = createPricingQuickSettings({ onChange });
        const [buySelect] = selectsOf(element);

        buySelect.value = 'patient';
        buySelect.dispatchEvent(new Event('change'));

        // hybrid (buy:ask, sell:ask) with buy switched to patient (bid) is optimistic (buy:bid, sell:ask)
        expect(live.values.profitCalc_pricingMode).toBe('optimistic');
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    test('choosing a key pricing option writes profitCalc_keyPricingMode and calls onChange', () => {
        const onChange = vi.fn();
        const { element } = createPricingQuickSettings({ onChange });
        const keySelect = selectsOf(element)[2];

        keySelect.value = 'synced';
        keySelect.dispatchEvent(new Event('change'));

        expect(live.values[KEY_PRICING_SETTING]).toBe('synced');
        expect(live.writes).toContainEqual([KEY_PRICING_SETTING, 'synced']);
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    test('sync() picks up a change made elsewhere, without needing a rebuild', () => {
        const { element, sync } = createPricingQuickSettings();
        const [buySelect, , keySelect] = selectsOf(element);

        live.values.profitCalc_pricingMode = 'patientBuy';
        live.values.profitCalc_keyPricingMode = 'bid';
        sync();

        expect(buySelect.value).toBe('patient');
        expect(keySelect.value).toBe('bid');
    });

    test('lists every setting the row shows, for a host to subscribe to', () => {
        expect([...PRICING_QUICK_SETTINGS_KEYS].sort()).toEqual(
            [
                'profitCalc_patientTickBuy',
                'profitCalc_patientTickSell',
                'profitCalc_pricingMode',
                'profitCalc_pricingNaming',
                'profitCalc_keyPricingMode',
            ].sort()
        );
    });

    test('carries the given style on all three selects', () => {
        const { element } = createPricingQuickSettings({ selectCssText: 'max-width: 90px;' });
        for (const select of selectsOf(element)) {
            expect(select.style.maxWidth).toBe('90px');
        }
    });
});

describe('under Iron Cow mode', () => {
    // Iron Cow mode owns pricing outright (`pricingRowsLocked()` for Buy/Sell,
    // `profitCalc_keyPricingMode` is itself in IRON_COW_SETTINGS for Keys) — a
    // quick-settings row must not let a click, a keyboard change, or a script
    // write around that lock, and must look locked so a click is not the
    // first the maintainer hears of it.

    test('all three selects render disabled, with a title naming Iron Cow mode', () => {
        live.values.ironCow_enabled = true;
        const { element } = createPricingQuickSettings();

        for (const select of selectsOf(element)) {
            expect(select.disabled).toBe(true);
            expect(select.title).toMatch(/Iron Cow/i);
        }
    });

    test('a change event on any of the three selects writes nothing', () => {
        live.values.ironCow_enabled = true;
        const onChange = vi.fn();
        const { element } = createPricingQuickSettings({ onChange });
        const [buySelect, sellSelect, keySelect] = selectsOf(element);

        // A disabled select does not fire a user click in a real browser, but a
        // script (or a stray keyboard event) can still dispatch one — the
        // handlers themselves have to refuse the write, not just the UI
        buySelect.value = 'patient';
        buySelect.dispatchEvent(new Event('change'));
        sellSelect.value = 'patient';
        sellSelect.dispatchEvent(new Event('change'));
        keySelect.value = 'craft';
        keySelect.dispatchEvent(new Event('change'));

        expect(live.writes).toEqual([]);
        expect(live.values.profitCalc_pricingMode).toBe('hybrid');
        expect(live.values.profitCalc_keyPricingMode).toBe('ask');
        expect(onChange).not.toHaveBeenCalled();
    });

    test('sync() re-locks the selects when the mode turns on after the row was built', () => {
        const { element, sync } = createPricingQuickSettings();
        const [buySelect, sellSelect, keySelect] = selectsOf(element);
        expect(buySelect.disabled).toBe(false);

        live.values.ironCow_enabled = true;
        sync();

        expect(buySelect.disabled).toBe(true);
        expect(sellSelect.disabled).toBe(true);
        expect(keySelect.disabled).toBe(true);
    });

    test('sync() unlocks the selects again once the mode turns back off', () => {
        live.values.ironCow_enabled = true;
        const { element, sync } = createPricingQuickSettings();
        const [buySelect] = selectsOf(element);
        expect(buySelect.disabled).toBe(true);

        live.values.ironCow_enabled = false;
        sync();

        expect(buySelect.disabled).toBe(false);
        expect(buySelect.title).not.toMatch(/Iron Cow/i);
    });

    test('IRON_COW_ENABLED_SETTING is in the tooltip-only key list, so a host resyncs on the toggle', async () => {
        const { PRICING_QUICK_SETTINGS_TOOLTIP_KEYS } = await import('./pricing-quick-settings.js');
        const { IRON_COW_ENABLED_SETTING } = await import('../settings/iron-cow-mode.js');
        expect(PRICING_QUICK_SETTINGS_TOOLTIP_KEYS).toContain(IRON_COW_ENABLED_SETTING);
    });
});
