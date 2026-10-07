/**
 * Market Pricing Controls
 *
 * The Buy / Sell pricing dropdowns and the Craft toggle that skill pages carry in their toolbar,
 * repeated beside the Marketplace title. The marketplace item tooltips price profit, expected
 * value and craft cost from these same settings, and switching them used to mean a trip to a
 * skill page.
 *
 * The controls own no state: they read and write the settings the skill-page controls do, through
 * the same helpers, so a change here shows up there and in the settings panel (and the other way
 * round). Nothing needs redrawing on the market page itself, because the tooltips that depend on
 * these settings are built on hover.
 *
 * Default off (`market_showPricingControls`). Within it, the skill page's own visibility settings
 * (`actionPanel_showPricingMode`, `actionPanel_showCraftToggle`) still apply, so a player who hid a
 * control there does not get it back here.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import { IRON_COW_ENABLED_SETTING, pricingRowsLocked } from '../settings/iron-cow-mode.js';
import {
    applyPricingSideChoice,
    createPricingSideSelect,
    PRICING_SELECT_BACKGROUND,
    PRICING_SIDE_SETTING_KEYS,
    PRICING_SIDE_TOOLTIP_SETTING_KEYS,
    syncPricingSideSelect,
} from '../../utils/pricing-side-select.js';

const SETTING_KEY = 'market_showPricingControls';
const CRAFT_SETTING = 'profitCalc_craftUpgradeItems';
const SHOW_PRICING_SETTING = 'actionPanel_showPricingMode';
const SHOW_CRAFT_SETTING = 'actionPanel_showCraftToggle';

/** The panel's own title. `MarketplacePanel_header` is the buy/sell order modal's title, not this. */
const TITLE_CLASS = 'MarketplacePanel_title';
const WRAPPER_ID = 'mwi-market-pricing-controls';
const IRON_COW_LOCK_TITLE = 'Iron Cow mode sets pricing.';
const CRAFT_TITLE =
    'When on, uses crafting cost for upgrade items if cheaper than market, and includes crafting time in profit/hr';

/** Same look as the skill-page toolbar's controls; font reset because the title is a heading */
const CONTROL_CSS = `
    padding: 8px 12px;
    font-size: 14px;
    font-weight: normal;
    border: 1px solid rgba(255, 255, 255, 0.23);
    border-radius: 4px;
    color: inherit;
    cursor: pointer;
    font-family: inherit;
    flex-shrink: 0;
`;

class MarketPricingControls {
    constructor() {
        this.initialized = false;
        this.unregisterHandlers = [];
        this.titleElement = null;
        this.wrapper = null;
        this.buySelect = null;
        this.sellSelect = null;
        this.craftButton = null;
        // The title's own flex-wrap before this feature set it, so cleanup can put it back
        this._titleFlexWrap = null;
    }

    /**
     * Start watching for the Marketplace title.
     * @returns {void}
     */
    initialize() {
        if (this.initialized) return;
        if (!config.getSetting(SETTING_KEY)) return;
        this.initialized = true;

        this.unregisterHandlers.push(
            domObserver.onClass('MarketPricingControls', TITLE_CLASS, (titleElement) => this._inject(titleElement))
        );
        // @run-at document-start: a title rendered before the shared observer attached is invisible
        // to the class watcher, so catch it up once the observer is actually running
        this.unregisterHandlers.push(
            domObserver.onReady('MarketPricingControlsCatchUp', () => {
                const existing = document.querySelector(`[class*="${TITLE_CLASS}"]`);
                if (existing) this._inject(existing);
            })
        );

        // Wherever a pricing setting changes (settings panel, a skill page, this row) the controls resync.
        // A character switch reloads settings with an empty previous map, so per-key callbacks stay quiet
        // and the settings-loaded channel is what catches it.
        const sync = () => this._sync();
        const keys = [
            ...PRICING_SIDE_SETTING_KEYS,
            ...PRICING_SIDE_TOOLTIP_SETTING_KEYS,
            IRON_COW_ENABLED_SETTING,
            CRAFT_SETTING,
            SHOW_PRICING_SETTING,
            SHOW_CRAFT_SETTING,
        ];
        for (const key of new Set(keys)) {
            this.unregisterHandlers.push(config.onSettingChange(key, sync));
        }
        this.unregisterHandlers.push(config.onSettingsLoaded(sync));
    }

    /**
     * Mount the controls into the Marketplace title.
     * @param {HTMLElement} titleElement - The panel's h1
     * @returns {void}
     */
    _inject(titleElement) {
        if (!titleElement || titleElement.querySelector(`#${WRAPPER_ID}`)) return;
        // A new title (the panel was rebuilt): drop references to the old one
        this._removeControls();
        this.titleElement = titleElement;

        // Wrap below the title rather than push the panel wider when there is no room
        this._titleFlexWrap = titleElement.style.flexWrap;
        titleElement.style.flexWrap = 'wrap';

        const wrapper = document.createElement('span');
        wrapper.id = WRAPPER_ID;
        Object.assign(wrapper.style, {
            display: 'inline-flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: '8px',
            marginLeft: '12px',
            maxWidth: '100%',
            verticalAlign: 'middle',
        });

        const selectCss = `${CONTROL_CSS} background-color: ${PRICING_SELECT_BACKGROUND};`;
        const chooser = (side) => (choice) => {
            // Iron Cow owns pricing: reachable by keyboard or script even though the select is disabled
            if (pricingRowsLocked()) {
                this._sync();
                return;
            }
            applyPricingSideChoice(side, choice);
            this._sync();
        };
        const buySelect = createPricingSideSelect('buy', { cssText: selectCss, onChoose: chooser('buy') });
        buySelect.id = 'mwi-market-pricing-buy';
        const sellSelect = createPricingSideSelect('sell', { cssText: selectCss, onChoose: chooser('sell') });
        sellSelect.id = 'mwi-market-pricing-sell';

        const craftButton = document.createElement('button');
        craftButton.id = 'mwi-market-craft-toggle';
        craftButton.type = 'button';
        craftButton.title = CRAFT_TITLE;
        craftButton.style.cssText = `${CONTROL_CSS} background: transparent;`;
        craftButton.addEventListener('click', () => {
            config.setSetting(CRAFT_SETTING, !config.getSetting(CRAFT_SETTING));
            this._sync();
        });

        wrapper.append(buySelect, sellSelect, craftButton);
        titleElement.appendChild(wrapper);

        this.wrapper = wrapper;
        this.buySelect = buySelect;
        this.sellSelect = sellSelect;
        this.craftButton = craftButton;
        this._sync();
    }

    /**
     * Bring the controls up to date with the settings, the Iron Cow lock and the visibility settings.
     * @returns {void}
     */
    _sync() {
        if (!this.wrapper) return;
        const locked = pricingRowsLocked();
        for (const select of [this.buySelect, this.sellSelect]) {
            syncPricingSideSelect(select);
            select.disabled = locked;
            if (locked) select.title = IRON_COW_LOCK_TITLE;
        }
        this.craftButton.textContent = config.getSetting(CRAFT_SETTING) ? 'Craft: On' : 'Craft: Off';

        const showPricing = Boolean(config.getSetting(SHOW_PRICING_SETTING));
        const showCraft = Boolean(config.getSetting(SHOW_CRAFT_SETTING));
        this.buySelect.style.display = showPricing ? '' : 'none';
        this.sellSelect.style.display = showPricing ? '' : 'none';
        this.craftButton.style.display = showCraft ? '' : 'none';
        this.wrapper.style.display = showPricing || showCraft ? 'inline-flex' : 'none';
    }

    /**
     * Remove the controls and restore the title's own style.
     * @returns {void}
     */
    _removeControls() {
        this.wrapper?.remove();
        if (this.titleElement && this._titleFlexWrap !== null) {
            this.titleElement.style.flexWrap = this._titleFlexWrap;
        }
        this.wrapper = null;
        this.buySelect = null;
        this.sellSelect = null;
        this.craftButton = null;
        this.titleElement = null;
        this._titleFlexWrap = null;
    }

    /**
     * Stop watching and remove everything this feature added.
     * @returns {void}
     */
    cleanup() {
        for (const unregister of this.unregisterHandlers) unregister();
        this.unregisterHandlers = [];
        this._removeControls();
        this.initialized = false;
    }

    /**
     * Registry hook: turn the feature off without a reload.
     * @returns {void}
     */
    disable() {
        this.cleanup();
    }
}

const marketPricingControls = new MarketPricingControls();
export default marketPricingControls;
