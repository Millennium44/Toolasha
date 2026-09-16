/**
 * Iron Cow Mode
 * Force-disables and locks all market/profit-related settings for players
 * who have no marketplace access.
 */

import config from '../../core/config.js';
import storage from '../../core/storage.js';
import { settingsGroups } from '../../core/settings-schema.js';
import dataManager from '../../core/data-manager.js';
import { PRICING_MODE_SETTING } from '../../utils/pricing-side-select.js';

/**
 * The complete set of setting IDs that are force-disabled in Iron Cow mode.
 */
export const IRON_COW_SETTINGS = new Set([
    // Market UI (all market_* keys + related)
    'networkAlert',
    'marketFilter',
    'marketSort',
    'fillMarketOrderPrice',
    'market_autoFillSellStrategy',
    'market_autoFillBuyStrategy',
    'market_autoClickMax',
    'market_quickInputButtons',
    'market_marketplaceShortcuts',
    'market_visibleItemCount',
    'market_visibleItemCountOpacity',
    'market_visibleItemCountIncludeEquipped',
    'market_showListingPrices',
    'market_tradeHistory',
    'market_tradeHistoryComparisonMode',
    'market_listingPricePrecision',
    'market_listingAge',
    'market_listingAgeFormat',
    // market_listingTimeFormat / market_listingDateFormat are deliberately absent: the
    // market_ prefix is legacy naming, and they are general date/time display preferences
    // read by formatters.js's formatDateTime, the Character Activity collector and Pop-out
    // Chat — none of which an Iron Cow character loses access to. Leaving them out also
    // means disable() skips them in any snapshot an older build already wrote.
    'market_showOrderTotals',
    'market_showHistoryViewer',
    'market_showPhiloCalculator',
    'market_showQueueLength',
    // Profit / pricing calculations
    'profitCalc_pricingMode',
    'profitCalc_patientTickBuy',
    'profitCalc_patientTickSell',
    'profitCalc_pricingNaming',
    'actionPanel_showProfitPerHour_gathering',
    'actionPanel_showProfitPerHour_production',
    'actionPanel_showProfitDetail',
    'actionPanel_foragingTotal',
    'actionPanel_hideNegativeProfit',
    'actionQueue_showValue',
    'actionQueue_valueMode',
    'alchemy_profitDisplay',
    'itemTooltip_profit',
    'itemTooltip_detailedProfit',
    'itemTooltip_multiActionProfit',
    'taskProfitCalculator',
    'profitCalc_keyPricingMode', // Prices in tooltips / UI
    'itemTooltip_prices',
    'itemTooltip_expectedValue',
    'expectedValue_showDrops',
    'expectedValue_respectPricingMode',
    'labyrinthShopPrices',
    // Inventory value display
    'invWorth',
    'invCategoryTotals',
    'inv_valueBadges',
    'invSort_netOfTax',
    // Net worth
    'networth',
    'networth_highEnhancementUseCost',
    'networth_highEnhancementMinLevel',
    'networth_historyChart',
    'networth_includeCowbells',
    'networth_includeTaskTokens',
    'networth_abilityBooksAsInventory',
    // Missing materials marketplace button
    'actions_missingMaterialsButton',
    'actions_missingMaterialsButton_ignoreQueue',
    // Color settings for market-only UI elements
    'color_invBadge_ask',
    'color_invBadge_bid',
    'color_queueLength_known',
    'color_queueLength_estimated',
]);

/**
 * Returns the forced-off value for a setting when Iron Cow mode is enabled.
 * Checkboxes → false, sliders → 0, everything else → schema default.
 * @param {string} settingId
 * @returns {*}
 */
function getIronCowDisabledValue(settingId) {
    for (const group of Object.values(settingsGroups)) {
        const def = group.settings[settingId];
        if (!def) continue;
        const type = def.type || 'checkbox';
        if (type === 'checkbox') return false;
        if (type === 'slider') return 0;
        // A select whose default is not its off value has to say which value is
        // off, or Iron Cow would "disable" it into a display that is still on —
        // the merged listing-age row defaults to showing the order book
        if (def.offValue !== undefined) return def.offValue;
        return def.default ?? ''; // select / number / color → schema default
    }
    return false;
}

class IronCowMode {
    /**
     * Per-character snapshot storage key.
     * @returns {string}
     */
    _snapshotKey() {
        const cid = dataManager.getCurrentCharacterId?.();
        return cid ? `toolasha_ironCowSnapshot_${cid}` : 'toolasha_ironCowSnapshot';
    }

    /**
     * Whether Iron Cow mode is currently enabled.
     * @returns {boolean}
     */
    isEnabled() {
        return config.getSetting('ironCow_enabled');
    }

    /**
     * Enable Iron Cow mode.
     * Saves a snapshot of current values then force-disables every affected setting.
     * @returns {Promise<void>}
     */
    async enable() {
        // 1. Save snapshot of current values before forcing them off
        const snapshot = {};
        for (const id of IRON_COW_SETTINGS) {
            const entry = config.settingsMap[id];
            if (!entry) continue;
            snapshot[id] =
                entry.type === 'checkbox'
                    ? { type: 'checkbox', value: entry.isTrue ?? false }
                    : { type: entry.type, value: entry.value };
        }
        await storage.setJSON(this._snapshotKey(), snapshot, 'settings', true);

        // 2. Force-disable each setting (fires onSettingChange callbacks automatically)
        for (const id of IRON_COW_SETTINGS) {
            const entry = config.settingsMap[id];
            if (!entry) continue;
            const val = getIronCowDisabledValue(id);
            if (entry.type === 'checkbox') {
                config.setSetting(id, val);
            } else {
                config.setSettingValue(id, val);
            }
        }
    }

    /**
     * Re-force every managed setting without touching the snapshot.
     *
     * For after a preset/All Off/Restore writes stored values while the mode
     * is on. Calling {@link enable} here instead would re-snapshot the
     * already-forced values and lose the user's real pre-Iron-Cow settings.
     */
    reapply() {
        if (!this.isEnabled()) return;
        for (const id of IRON_COW_SETTINGS) {
            const entry = config.settingsMap[id];
            if (!entry) continue;
            const val = getIronCowDisabledValue(id);
            if (entry.type === 'checkbox') {
                config.setSetting(id, val);
            } else {
                config.setSettingValue(id, val);
            }
        }
    }

    /**
     * Disable Iron Cow mode.
     * Restores each setting to its pre-Iron-Cow value from the snapshot.
     * @returns {Promise<void>}
     */
    async disable() {
        // The key is decided once, synchronously, before the first await.
        // `_snapshotKey()` reads the *current* character, and this method spans
        // two storage round-trips — a character switch landing between them (the
        // player toggles the mode off just as the switch goes through) would
        // otherwise have the delete below aimed at the arriving character's
        // snapshot while the departing character's is left orphaned. Same
        // capture-before-await discipline as `dungeon-tracker.js`'s scoped
        // writes.
        const key = this._snapshotKey();
        const snapshot = await storage.getJSON(key, 'settings', null);
        if (snapshot) {
            for (const [id, entry] of Object.entries(snapshot)) {
                if (!IRON_COW_SETTINGS.has(id)) continue;
                const configEntry = config.settingsMap[id];
                if (!configEntry) continue;
                if (entry.type === 'checkbox') {
                    config.setSetting(id, entry.value);
                } else {
                    config.setSettingValue(id, entry.value);
                }
            }
        }
        await storage.delete(key, 'settings');
    }
}

const ironCowMode = new IronCowMode();
export default ironCowMode;

/**
 * Whether Iron Cow mode currently owns the pricing settings, so a `pricingSide`
 * dropdown (Settings, What's New, or anywhere else one is built with
 * {@link createPricingSideSelect}) must neither respond nor write. The mode
 * locks the keys behind the rows — `profitCalc_pricingMode` and the per-side
 * patient ticks — which is where the question has to be asked: a `pricingSide`
 * row has an id of its own that is never in {@link IRON_COW_SETTINGS}.
 *
 * Exposed here, the module that owns both the lock state and the set it is
 * keyed against, so every surface that builds a pricing dropdown asks the same
 * question instead of each re-deriving it.
 * @returns {boolean} True while the mode holds the pricing settings
 */
export function pricingRowsLocked() {
    return ironCowMode.isEnabled() && IRON_COW_SETTINGS.has(PRICING_MODE_SETTING);
}
