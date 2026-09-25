/**
 * Pricing quick settings
 *
 * A compact Buy / Sell / Key pricing control any panel can drop in near the
 * figures it prices, so changing how something is priced does not require a
 * trip to the settings panel. It owns no state of its own — same rule as
 * {@link createPricingSideSelect} — it reads `config` to show the current
 * choice and writes `config` when one is picked, through the exact helpers
 * the settings panel itself uses, so a change here shows up there and
 * everywhere else that reads the same settings.
 *
 * The Buy and Sell dropdowns are `createPricingSideSelect` unchanged — this
 * module does not reimplement that control, only adds the Key pricing
 * dropdown beside it and a `sync()` a host can call from its own settings
 * subscription. `profitCalc_keyPricingMode`'s options come from the schema
 * (`getSettingDefinition`) rather than a second hard-coded copy of them, so a
 * wording change to the setting does not have to be made twice.
 */

import config from '../../core/config.js';
import { getSettingDefinition } from '../../core/settings-schema.js';
import {
    applyPricingSideChoice,
    createPricingSideSelect,
    PRICING_SELECT_BACKGROUND,
    PRICING_SIDE_SETTING_KEYS,
    PRICING_SIDE_TOOLTIP_SETTING_KEYS,
    syncPricingSideSelect,
} from '../../utils/pricing-side-select.js';

/** The stored setting the Key dropdown is a view over */
export const KEY_PRICING_SETTING = 'profitCalc_keyPricingMode';

/**
 * Every setting a full quick-settings control shows. A host listens on all of
 * these (plus {@link PRICING_QUICK_SETTINGS_TOOLTIP_KEYS} and the settings-loaded
 * channel) to stay in sync with changes made elsewhere — the main settings
 * panel, or another copy of this same control on another panel.
 */
export const PRICING_QUICK_SETTINGS_KEYS = Object.freeze([...PRICING_SIDE_SETTING_KEYS, KEY_PRICING_SETTING]);

/** Settings that move only a dropdown's tooltip, not what it shows selected */
export const PRICING_QUICK_SETTINGS_TOOLTIP_KEYS = PRICING_SIDE_TOOLTIP_SETTING_KEYS;

/**
 * Build the Key pricing dropdown, synced to the current setting.
 * @param {string} [cssText] - Inline style, to match the host's other selects
 * @returns {HTMLSelectElement}
 */
function createKeyPricingSelect(cssText) {
    const def = getSettingDefinition(KEY_PRICING_SETTING);
    const options = def?.options || [];

    const select = document.createElement('select');
    select.dataset.mwiKeyPricing = 'true';
    select.setAttribute('aria-label', 'Key pricing mode');
    select.style.cssText = cssText;
    for (const option of options) {
        const optionEl = document.createElement('option');
        optionEl.value = option.value;
        // Prefixed like the Buy:/Sell: selects beside it; bare, "Ask (instant buy)"
        // reads as a third copy of the buy side
        optionEl.textContent = `Keys: ${option.label}`;
        optionEl.style.backgroundColor = PRICING_SELECT_BACKGROUND;
        optionEl.style.color = '#fff';
        select.appendChild(optionEl);
    }
    if (def?.help) select.title = def.help;
    syncKeyPricingSelect(select);
    return select;
}

/**
 * Bring the Key dropdown's selection up to date with the setting.
 * @param {HTMLSelectElement} select
 * @returns {void}
 */
function syncKeyPricingSelect(select) {
    if (!select) return;
    select.value = config.getSettingValue(KEY_PRICING_SETTING, 'ask');
}

/**
 * Build the compact Buy / Sell / Key pricing row.
 *
 * Nothing here re-renders the host on its own: every write goes through
 * `config`, which is exactly what {@link PRICING_QUICK_SETTINGS_KEYS} lets a
 * host's own `config.onSettingChange` subscription pick up — one re-render
 * path for a change made in this control, in the main settings panel, or in
 * another copy of this control on a different panel. `onChange` below is only
 * a convenience for a host that does not already have such a subscription.
 *
 * @param {Object} [options]
 * @param {string} [options.selectCssText] - Inline style shared by all three selects
 * @param {Function} [options.onChange] - Called after any of the three settings is
 *   written from this control
 * @returns {{element: HTMLElement, sync: Function}} `element` to mount, and `sync()`
 *   to bring all three dropdowns up to date after an external change
 */
export function createPricingQuickSettings({ selectCssText = '', onChange } = {}) {
    const wrap = document.createElement('div');
    Object.assign(wrap.style, { display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' });

    const notify = () => {
        if (typeof onChange === 'function') onChange();
    };

    const buySelect = createPricingSideSelect('buy', {
        cssText: selectCssText,
        onChoose: (choice) => {
            applyPricingSideChoice('buy', choice);
            sync();
            notify();
        },
    });
    const sellSelect = createPricingSideSelect('sell', {
        cssText: selectCssText,
        onChoose: (choice) => {
            applyPricingSideChoice('sell', choice);
            sync();
            notify();
        },
    });
    const keySelect = createKeyPricingSelect(selectCssText);
    keySelect.addEventListener('change', () => {
        config.setSettingValue(KEY_PRICING_SETTING, keySelect.value);
        notify();
    });

    /** Resync all three dropdowns to the current settings. */
    function sync() {
        syncPricingSideSelect(buySelect);
        syncPricingSideSelect(sellSelect);
        syncKeyPricingSelect(keySelect);
    }

    wrap.append(buySelect, sellSelect, keySelect);

    return { element: wrap, sync };
}
