/**
 * Setting presets — a whole configuration in one button.
 *
 * Toolasha ships several hundred switches. Somebody who has just installed it,
 * or who plays one part of the game and not the others, does not want to make
 * several hundred decisions before the script is useful; they want to say
 * "I fight things" and have the market machinery stay out of their way. A
 * preset is that sentence, written as data.
 *
 * ## Why only checkboxes
 *
 * A preset says which *features* are on. It deliberately does not touch
 * numbers, dropdowns, colours or the enhancement-simulator gear table: those
 * are tunings a person arrived at deliberately, and a bundle that reset a
 * carefully entered enhancing level because you clicked "Combat" would be a
 * trap. This is the same set of settings `All Off` writes, and the snapshot the
 * two share means `Restore` undoes either one.
 *
 * ## Why "Defaults" is the schema defaults, not every switch true
 *
 * Several switches are hides and warnings that start off on purpose, and
 * turning them all on would be a configuration nobody has ever run. "Defaults"
 * means the way the script behaves out of the box, which is what a person
 * dismissing the first-run question is asking to keep.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import { settingsGroups } from '../../core/settings-schema.js';

const SNAPSHOT_KEY_PREFIX = 'toolasha_allOffSnapshot';

/**
 * Settings a bulk write must never touch.
 *
 * Iron Cow mode is a mode, not a feature: it owns its own snapshot of every
 * market setting, and a preset flipping it would either strand that snapshot or
 * force-disable half of what the preset just enabled.
 */
export const PRESET_EXCLUDED_IDS = new Set(['ironCow_enabled']);

/**
 * Core quality-of-life: the things that make the game easier to read without
 * calculating a price, simulating a fight or tracking a history.
 */
const ESSENTIALS = [
    // General
    'whatsNew_showPopup',
    'chatCommands',
    'chat_mentionTracker',
    'chat_profileLink',
    'chatHistoryExtender',
    'altClickNavigation',
    'collectionNavigation',
    // Action bar
    'actionBar_enabled',
    'actionBar_showQueueCount',
    'actionBar_showActionDuration',
    'actionBar_showTimeRemaining',
    'actionBar_showRecycleTime',
    // Skill page & tiles
    'actionPanel_showFilter',
    'actionPanel_showSort',
    'actionPanel_showExpPerHour_gathering',
    'actionPanel_showExpPerHour_production',
    'inventoryCountDisplay',
    'actions_pinnedPage',
    // Action panel
    'actionPanel_totalTime_quickInputs',
    'actionPanel_outputTotals',
    'actionPanel_maxProduceable',
    'actionPanel_showLevelProgress',
    'actionPanel_showSpeedTime',
    'requiredMaterials',
    'actionPanel_enhanceMatLimitProtections',
    'actionQueue',
    // Tooltips that describe the item rather than price it
    'showConsumTips',
    'itemTooltip_gathering',
    'itemTooltip_gatheringRareDrops',
    'itemTooltip_abilityStatus',
    // Inventory
    'invSort',
    'autoAllButton',
    'autoAllButton_excludeSeals',
    'inventoryTabs',
    'inventoryTabs_showUnorganized',
    'inventoryTabs_topTabPriority',
    // Skills
    'xpTracker',
    'xpTracker_timeTillLevel',
    'skillRemainingXP',
    'skillRemainingXP_blackBorder',
    'skillbook',
    'drinkTimer',
    'skillingOptimizer',
    // UI
    'overlayPanel',
    'overlayTabButton',
    'draggableModals',
    'ui_externalLinks',
    'panelSizeMemory',
    'tabReorder',
    'expPercentage',
    'itemIconLevel',
    'showsKeyInfoInIcon',
    'mapIndex',
    'loadoutEnhancementDisplay',
    // Tasks — reading the board, not valuing it
    'taskMapIndex',
    'taskIcons',
    'taskQueuedIndicator',
    'taskMaterialsIndicator',
    'taskGoMerge',
    // Collections
    'collectionFilters',
    'collectionFavorites',
    'collectionFavoritesSection',
    'collectionFilters_skillingBadges',
    // House
    'houseUpgradeCosts',
];

/** Everything the combat side of the game wants, on top of the essentials. */
const COMBAT_EXTRAS = [
    'damageTracker',
    'damageTakenTracker',
    'combatScore',
    'combatStats',
    'combatBattleCounter',
    'combatSummary',
    'combatDropLuck',
    'combatDps',
    'abilitiesTriggers',
    'abilities_dictionaryButton',
    'characterCard',
    'loadoutSnapshot',
    'manaTracker',
    'lootLogStats',
    'lootLogHistory',
    'treasureTracker',
    'treasureTracker_popup',
    'watchlist',
    'watchlist_inventoryDots',
    'dungeonTracker',
    'dungeonTrackerUI',
    'dungeonTrackerChatAnnotations',
    'labyrinthTracker',
    'labyrinthClearRate',
    'labyrinthLiveProgress',
    'labyrinthLiveCombatSim',
    'labyrinthRoomLogs',
    // Simulators
    'combatSim',
    'labSim',
    'combatSim_sharedSeed',
    'labSim_keepReplacedGear',
];

/** Everything that needs a price to be worth anything. */
const MARKET_EXTRAS = [
    // Marketplace screen
    'sellQueue',
    'networkAlert',
    'marketFilter',
    'marketSort',
    'fillMarketOrderPrice',
    'market_autoClickMax',
    'market_quickInputButtons',
    'market_multiplierButtons',
    'market_showOwnedInBuyModal',
    'market_marketplaceShortcuts',
    'market_visibleItemCount',
    'market_visibleItemCountIncludeEquipped',
    'market_showListingPrices',
    'market_listingRefreshNavigator',
    'market_tradeHistory',
    'market_showEstimatedListingAge',
    'market_showOrderTotals',
    'market_showHistoryViewer',
    'market_showPhiloCalculator',
    'market_showQueueLength',
    'market_milkywayMarketLink',
    // Pricing & profit
    'profitCalc_craftUpgradeItems',
    'actionPanel_showPricingMode',
    'actionPanel_showCraftToggle',
    'actionPanel_showProfitPerHour_gathering',
    'actionPanel_showProfitPerHour_production',
    'actionPanel_showProfitDetail',
    'actionPanel_foragingTotal',
    'actionQueue_showValue',
    // Priced tooltips
    'itemTooltip_prices',
    'itemTooltip_artisanPrices',
    'itemTooltip_profit',
    'itemTooltip_expectedValue',
    'expectedValue_respectPricingMode',
    'expectedValue_includeCowbells',
    'itemTooltip_enhancementPath',
    'dungeonTokenTooltips',
    'itemDictionary_transmuteRates',
    'itemDictionary_transmuteIncludeBaseRate',
    // Inventory value & net worth
    'networth',
    'networth_highEnhancementUseCost',
    'networth_includeTaskTokens',
    'networth_historyChart',
    'invWorth',
    'invSort_showBadges',
    'invBadgePrices',
    'invCategoryTotals',
    // Alchemy & crafting economics
    'alchemy_profitDisplay',
    'alchemy_bestItems',
    'alchemyItemPins',
    'alchemyItemDimming',
    'alchemy_transmuteHistory',
    'alchemy_coinifyHistory',
    'alchemy_decomposeHistory',
    'alchemy_actionProtection',
    'actionPanelLayout',
    'actions_missingMaterialsButton',
    'actions_budgetCalculator',
    'actions_costSummary',
    'actionPanel_bestCraftingPlan',
    // Tasks, valued
    'taskProfitCalculator',
    'taskEfficiencyRating',
    // Guild economy
    'guildCreditValue',
    'guildCreditExchangeAdvisor',
];

/** The preset picked when somebody dismisses the question rather than answering it. */
export const DEFAULT_PRESET_ID = 'everything';

/**
 * The bundles, in the order they are offered.
 *
 * A preset either lists the settings it wants on — everything else goes off —
 * or sets `useDefaults`, meaning every switch returns to what the schema ships.
 *
 * @type {Array<{id: string, label: string, description: string, settings?: string[], useDefaults?: boolean}>}
 */
export const SETTING_PRESETS = [
    {
        id: 'essentials',
        label: 'Essentials',
        description:
            'Core quality of life only — action timers, XP rates, inventory sorting, tooltips that describe items. ' +
            'No prices, no simulators, no trackers.',
        settings: ESSENTIALS,
    },
    {
        id: 'combat',
        label: 'Combat',
        description:
            'The essentials plus the combat side: damage and drop tracking, dungeon and labyrinth tools, and the ' +
            'combat and labyrinth simulators. Marketplace extras stay off.',
        settings: [...ESSENTIALS, ...COMBAT_EXTRAS],
    },
    {
        id: 'market',
        label: 'Market & trading',
        description:
            'The essentials plus everything that needs a price: profit calculators, listing tools, net worth, ' +
            'inventory values and crafting economics.',
        settings: [...ESSENTIALS, ...MARKET_EXTRAS],
    },
    {
        id: DEFAULT_PRESET_ID,
        label: 'Defaults',
        description: 'Every feature reset to its shipped default — how Toolasha behaves out of the box.',
        useDefaults: true,
    },
];

/**
 * The modes offered alongside the presets — and why they are a separate list.
 *
 * A preset is a sentence in the past tense: it flips a few hundred switches once
 * and is then over, which is why `Restore` can undo it. Iron Cow is a sentence
 * in the present tense: it stays on, keeps its own snapshot of every market
 * setting, and force-disables them for as long as it is on. The two compose —
 * you can be an Iron Cow *and* want the Combat bundle — so they sit in the same
 * row of the settings panel, but a mode is drawn as a pressed-in chip rather
 * than a button, because "on" is a thing it can be and a preset never is.
 *
 * Their ids live in `PRESET_EXCLUDED_IDS` for exactly that reason: a one-shot
 * sweep must not flip a mode on its way past.
 *
 * @type {Array<{id: string, kind: string, settingId: string, label: string, icon: string,
 *   description: string, activeNote: string}>}
 */
export const MODE_PRESETS = [
    {
        id: 'ironCow',
        kind: 'mode',
        settingId: 'ironCow_enabled',
        label: 'Iron Cow Mode',
        icon: '🐄',
        description:
            'Disable all market & profit features for a no-marketplace playthrough. Unlike a preset this stays ' +
            'on until you turn it off, and the settings it owns stay locked while it is.',
        activeNote: 'ACTIVE — market features locked.',
    },
];

/**
 * Find a preset by id.
 * @param {string} presetId
 * @returns {Object|null}
 */
export function getPreset(presetId) {
    return SETTING_PRESETS.find((preset) => preset.id === presetId) || null;
}

/**
 * Find a mode by id.
 * @param {string} modeId
 * @returns {Object|null}
 */
export function getModePreset(modeId) {
    return MODE_PRESETS.find((mode) => mode.id === modeId) || null;
}

/**
 * Whether a schema type is one a bulk write is allowed to touch.
 * @param {string} [type]
 * @returns {boolean}
 */
function isBulkWritable(type) {
    const kind = type || 'checkbox';
    return kind === 'checkbox' || kind === 'checkboxWithButton';
}

/**
 * Every setting id a preset (or All Off) may write, in schema order.
 *
 * The single definition of "which settings does a bulk write own" — presets,
 * All Off, Restore and the checkbox re-sync all read it, so the three can never
 * disagree about what they are writing.
 *
 * @param {Object} [groups] - Schema groups, injectable for tests
 * @returns {string[]}
 */
export function presetTargetIds(groups = settingsGroups) {
    const ids = [];
    for (const group of Object.values(groups)) {
        for (const [id, definition] of Object.entries(group.settings)) {
            if (!isBulkWritable(definition.type)) continue;
            if (PRESET_EXCLUDED_IDS.has(id)) continue;
            ids.push(id);
        }
    }
    return ids;
}

/**
 * The schema defaults for every bulk-writable setting.
 * @param {Object} [groups] - Schema groups, injectable for tests
 * @returns {Object<string, boolean>}
 */
export function defaultCheckboxValues(groups = settingsGroups) {
    const values = {};
    for (const group of Object.values(groups)) {
        for (const [id, definition] of Object.entries(group.settings)) {
            if (!isBulkWritable(definition.type)) continue;
            if (PRESET_EXCLUDED_IDS.has(id)) continue;
            values[id] = definition.default ?? false;
        }
    }
    return values;
}

/**
 * What a preset means, expressed as a value for every setting it owns.
 *
 * Pure — no config, no storage — because "what does Combat mean" is the part
 * that has to stay right as the schema grows, and it is the part worth testing.
 *
 * @param {Object} preset - From `SETTING_PRESETS`
 * @param {Object} [groups] - Schema groups, injectable for tests
 * @returns {Object<string, boolean>} id → value
 */
export function resolvePresetValues(preset, groups = settingsGroups) {
    if (!preset) return {};
    if (preset.useDefaults) return defaultCheckboxValues(groups);

    const wanted = new Set(preset.settings || []);
    const values = {};
    for (const id of presetTargetIds(groups)) {
        values[id] = wanted.has(id);
    }
    return values;
}

/**
 * The per-character key the bulk-write snapshot lives under.
 *
 * Shared with All Off deliberately: there is one "before the last bulk write"
 * state, and Restore should undo whichever bulk write happened last.
 *
 * @returns {string}
 */
export function bulkSnapshotKey() {
    const characterId = dataManager.getCurrentCharacterId?.();
    return characterId ? `${SNAPSHOT_KEY_PREFIX}_${characterId}` : SNAPSHOT_KEY_PREFIX;
}

/**
 * Record every bulk-writable setting's current value, so Restore has something
 * to put back.
 * @returns {Promise<Object<string, boolean>>} The snapshot that was saved
 */
export async function saveBulkSnapshot() {
    const snapshot = {};
    for (const id of presetTargetIds()) {
        const entry = config.settingsMap[id];
        if (!entry) continue;
        snapshot[id] = entry.isTrue ?? false;
    }
    await storage.setJSON(bulkSnapshotKey(), snapshot, 'settings', true);
    return snapshot;
}

/**
 * The saved snapshot, or null when no bulk write has happened.
 * @returns {Promise<Object<string, boolean>|null>}
 */
export async function loadBulkSnapshot() {
    return storage.getJSON(bulkSnapshotKey(), 'settings', null);
}

/**
 * Forget the snapshot — after Restore has used it.
 * @returns {Promise<void>}
 */
export async function clearBulkSnapshot() {
    await storage.delete(bulkSnapshotKey(), 'settings');
}

/**
 * Write a map of setting values through config, firing the usual change
 * callbacks so live features react without a reload.
 *
 * Settings already holding the wanted value are skipped: every `setSetting`
 * persists the entire settings map, so writing three hundred of them at boot to
 * change none of them is three hundred pointless round trips through IndexedDB
 * — and "Defaults" on a fresh install is exactly that case.
 *
 * @param {Object<string, boolean>} values - id → value
 * @returns {string[]} The ids that were actually written
 */
export function writeCheckboxValues(values) {
    const written = [];
    for (const [id, value] of Object.entries(values || {})) {
        if (PRESET_EXCLUDED_IDS.has(id)) continue;
        const entry = config.settingsMap[id];
        if (!entry) continue;
        if ((entry.isTrue ?? false) === value) continue;
        config.setSetting(id, value);
        written.push(id);
    }
    return written;
}

/**
 * Apply a named preset.
 *
 * Snapshots first, so the Restore button can undo it exactly the way it undoes
 * All Off — a preset is a large change, and a large change a person cannot walk
 * back is one they will not risk making.
 *
 * @param {string} presetId - An id from `SETTING_PRESETS`
 * @returns {Promise<Object<string, boolean>|null>} The values written, or null
 *   when the preset is unknown
 */
export async function applyPreset(presetId) {
    try {
        const preset = getPreset(presetId);
        if (!preset) {
            console.error(`[SettingPresets] Unknown preset: ${presetId}`);
            return null;
        }

        const values = resolvePresetValues(preset);
        await saveBulkSnapshot();
        writeCheckboxValues(values);
        return values;
    } catch (error) {
        console.error('[SettingPresets] Applying a preset failed:', error);
        return null;
    }
}
