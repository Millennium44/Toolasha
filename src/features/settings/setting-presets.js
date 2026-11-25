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
 * numbers, dropdowns, colors or the enhancement-simulator gear table: those
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

/** @param {string[]} ids
 * @returns {string[]} */
function unique(ids) {
    return [...new Set(ids)];
}

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
    'profileGuildBackButton',
    'chatHistoryExtender',
    'altClickNavigation',
    'collectionNavigation',
    // Action bar
    'actionBar_enabled',
    'actionBar_showQueueCount',
    'actionBar_showActionDuration',
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
    // UI
    'overlayPanel',
    'overlayTabButton',
    'draggableModals',
    'ui_externalLinks',
    'panelSizeMemory',
    'tabReorder',
    'expPercentage',
    'combatLevelProgress',
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
    // Things that read the game rather than price it
    'chat_popOut',
    'tokenShopShortcuts',
    'characterSelect_activityStatus',
    'actionBar_showActionsPerHour',
    'shop_maxBuyButton',
    'invSort_collapseAll',
    'inventoryTabs_iconRowTab',
    'inventoryTooltipBeside',
    'itemTooltip_wheelScroll',
    'itemTooltip_loadoutMarks',
    'abilityTooltip_effectiveTiming',
    'enhancementItemPins',
    'actionPanelLayout',
    'alchemyItemPins',
    'alchemyItemSort',
    'alchemyCatalystMark',
    'alchemyItemDimming',
    'simulateScrollEffects',
    // Tasks
    'taskSpeedBreakdown',
    'taskSorter',
    'taskInventoryHighlighter',
    'taskStatistics',
    'taskClaimCollector',
    'taskRerollProtection',
    // Highlights tasks you marked for reroll; it never rerolls anything itself
    'taskAutoReroll',
    // Account-wide helpers
    'equipmentMismatchWarning',
    'accountView',
    'sessionBriefing',
    'commandPalette',
    'commandPaletteNavEntry',
    'commandPaletteSettingsButton',
    'leaderboardXPTracker',
    'leaderboardXPDisplay',
];

/** Everything the combat side of the game wants, on top of the essentials. */
const COMBAT_EXTRAS = [
    'damageTracker',
    'damageTakenTracker',
    'combatScore',
    'combatStats',
    'combatBattleCounter',
    'combatBossEta',
    'combatSummary',
    'combatDropLuck',
    'combatDps',
    'abilitiesTriggers',
    'abilities_dictionaryButton',
    'characterCard',
    'characterCard_extraAuras',
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
    // The queue's own simulator button: it needs combatSim, so it belongs with the simulators
    // rather than with the queue's reading settings in ESSENTIALS
    'actionQueue_zoneSimButton',
    'combatSim_sharedSeed',
    'labSim_keepReplacedGear',
    // Fight and party tools
    'combatSessionRestore',
    'partyLint_live',
    'replayCheck',
    'combatProfileButton',
    'combatDeathRecap',
    'combatPlayerColors',
    'combatDpsGraph',
    'combatMeterHistory',
    'combatClassOverride',
    'dungeonPace',
    'dungeonKeyRunway',
    'combatSim_partyFinder',
    'combatSim_bestiary',
    'eliteAchievementReminder',
    'taskCombatEstimate',
    // Labyrinth
    'labyrinthRunLedger',
    'labyrinthPathStepper',
    'labyrinthGridScaleControl',
    'labyrinthBeaconPathFirst',
    'labyrinthRoomDistribution',
    'labyrinthAutoPath',
    'labyrinthAutoPathOnReveal',
    'labyrinthBeaconDots',
    // Buttons that open the marketplace for a combat player's supplies (Market has them too)
    'combatBuySuppliesButton',
    'labyrinthMissingSuppliesButton',
    'chestKeyMarketButton',
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
    'market_instantOrderGap',
    'market_marketplaceShortcuts',
    'market_visibleItemCount',
    'market_visibleItemCountIncludeEquipped',
    'market_showListingPrices',
    'market_listingRefreshNavigator',
    'market_tradeHistory',
    'market_showOrderTotals',
    'market_showHistoryViewer',
    'market_showPhiloCalculator',
    'market_showQueueLength',
    // Pricing & profit
    'profitCalc_craftUpgradeItems',
    'actionPanel_showPricingMode',
    'actionPanel_showCraftToggle',
    'actionPanel_showSellTaxToggle',
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
    'dungeonShopPlanner',
    'itemDictionary_transmuteRates',
    'itemDictionary_transmuteIncludeBaseRate',
    // Inventory value & net worth
    'networth',
    'networth_highEnhancementUseCost',
    'networth_includeTaskTokens',
    'networth_includeLabyrinthTokens',
    'networth_includeGuildTokens',
    'networth_includeGuildCredits',
    'networth_historyChart',
    'invWorth',
    'invCategoryTotals',
    // Alchemy & crafting economics
    'alchemy_profitDisplay',
    'alchemy_bestItems',
    'alchemy_transmuteHistory',
    'alchemy_coinifyHistory',
    'alchemy_decomposeHistory',
    'alchemy_actionProtection',
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
    // Prices and values
    'houseUpgradeCosts',
    'skillingOptimizer',
    'chestKeyMarketButton',
    'combatBuySuppliesButton',
    'skillingBuySuppliesButton',
    'labyrinthMissingSuppliesButton',
    'labyrinthShopPrices',
    'market_raiseBuyPriceToCoverQuantity',
    'market_itemHop',
    'market_collectableListingsToTop',
    'market_tradeLedger',
    'market_staleCapital',
    'market_overbidPanel',
    'market_depthCapEnabled',
    'market_enhanceProfitPerHour',
    'profitCalc_liquidityCap',
    'offlineProgressEconomics',
    'networth_abilityBooksAsInventory',
    'networth_goldSources',
    'scrollPlanner',
    'skillTiles_simulatedScrolls',
    'consumables_idleLoadoutPlan',
    'market_consumableBuyOpenRecommended',
    'teaRecommendation_xpFloor',
    'alchemy_catalystWhatIf',
    'alchemy_bestItems_shopPrices',
    'actions_arbitrageBoard',
    'actions_craftEnhance',
    'itemTooltip_ownUseCompare',
    'itemTooltip_heldCraftCompare',
    'itemTooltip_multiActionProfit',
    'itemTooltip_alchemyInsteadOfSelling',
    'dungeonTokenTooltips_crafts',
    'shopTokenValues',
    'upgradeAdvisor_compareRoutes',
    'enhanceSim',
    'enhanceSim_baseItemCraftingCost',
    'enhanceSim_protectionMarketplaceButton',
    'enhanceSim_achievement',
    'enhanceSim_blessedTea',
    'enhancementXPH',
    'goalPlanner',
    'insights_calibration',
    'insights_calibrationBadges',
    'taskRerollTracker',
    'taskRerollSpendBadge',
    'achievementFinisher',
    'lootLogDropLuck',
    // Values shown by trackers that Combat also carries
    'lootLogStats',
    'treasureTracker',
    'treasureTracker_popup',
    'watchlist',
    'watchlist_inventoryDots',
];

/**
 * Guild play: the guild panels and trials. Priced guild items (credit value, exchange advisor) are here because
 * a guild player who spends credits needs the prices; Guild is meant to be combined with Market or Combat.
 */
const GUILD_EXTRAS = [
    'guildXPTracker',
    'guildXPDisplay',
    'guildIdleDisplay',
    'guildTrialSignupDisplay',
    'guildTrialsInfo',
    'guildTrialTracking',
    'guildTrialBossDebuffs',
    'guildTrialPackUnits',
    'guildTrialAutoRecord',
    'guildMembersShowGameMode',
    'guildMembersShowJoined',
    'guildMembersShowLastXPH',
    'guildMembersShowLastDayXPH',
    'guildShrineUpgradePlanner',
    'guildTrialLedger',
    'guildRoster',
    'guildCreditValue',
    'guildCreditExchangeAdvisor',
];

/**
 * Visible switches that ship on and are in no preset, each with the reason. A new default-on switch must go in a
 * preset list or here: `setting-presets.test.js` fails otherwise, because a preset switches off everything it does
 * not list. Default-off switches need no entry (a preset leaves them off, which is what they ship as).
 *
 * @type {Object<string, string>}
 */
export const LEFT_OUT = {
    ironCowFarm: 'a mode helper for Iron Cow; a preset must not decide it',
    notifications_communityBuff_experience: 'child of a default-off parent (community buff notices)',
    notifications_communityBuff_gatheringQuantity: 'child of a default-off parent (community buff notices)',
    notifications_communityBuff_productionEfficiency: 'child of a default-off parent (community buff notices)',
    notifications_communityBuff_enhancingSpeed: 'child of a default-off parent (community buff notices)',
    notifications_communityBuff_combatDropQuantity: 'child of a default-off parent (community buff notices)',
    market_historyBaseValue: 'child of the default-off price history panel (third-party opt-in)',
    market_volumeStats:
        'child of the default-off price history panel, which calls a third-party server and so needs its own opt-in',
    enhancementTracker_autoCombine: 'child of the default-off Enhancement Tracker',
    tasks_rerollWalkTrashAtLimit: 'child of the default-off reroll walk',
    combatDpsHitTape: 'child of the default-off per-player damage panel',
    itemTooltip_craftCostSubMaterials: 'child of the default-off detailed profit table',
    market_bulkSellVendorCheck: 'child of the default-off Bulk Sell Assistant',
    market_bulkSellHoldFavorites: 'child of the default-off Bulk Sell Assistant',
};

/** Presets that can be ticked together. Essentials is always the base of a combined apply. */
export const COMBINABLE_PRESET_IDS = ['combat', 'market', 'guild'];

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
            'No market prices or fight simulators. The base of every combination.',
        settings: ESSENTIALS,
    },
    {
        id: 'combat',
        label: 'Combat',
        description:
            'The essentials plus the combat side: damage and drop tracking, dungeon and labyrinth tools, and the ' +
            'simulators. Market, guild and everything else is switched off unless you tick it too.',
        settings: unique([...ESSENTIALS, ...COMBAT_EXTRAS]),
    },
    {
        id: 'market',
        label: 'Market & trading',
        description:
            'The essentials plus everything that needs a price: profit calculators, listing tools, net worth, ' +
            'crafting economics. Combat, guild and everything else is switched off unless you tick it too.',
        settings: unique([...ESSENTIALS, ...MARKET_EXTRAS]),
    },
    {
        id: 'guild',
        label: 'Guild',
        description:
            'The essentials plus guild panels, trials and rosters, with guild credit prices. Everything else is ' +
            'switched off unless you tick it too.',
        settings: unique([...ESSENTIALS, ...GUILD_EXTRAS]),
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
 * Switches on `LEFT_OUT` are not in the result of a combination: a preset leaves them as they are.
 *
 * Pure — no config, no storage — because "what does Combat mean" is the part
 * that has to stay right as the schema grows, and it is the part worth testing.
 *
 * @param {Object} preset - From `SETTING_PRESETS`
 * @param {Object} [groups] - Schema groups, injectable for tests
 * @returns {Object<string, boolean>} id → value
 */
export function resolvePresetValues(preset, groups = settingsGroups) {
    const presets = (Array.isArray(preset) ? preset : [preset]).filter(Boolean);
    if (presets.length === 0) return {};
    if (presets.length === 1 && presets[0].useDefaults) return defaultCheckboxValues(groups);

    // A union: listed by any chosen preset means on. A "defaults" preset has no list, so inside a combination it adds nothing.
    const wanted = new Set();
    for (const entry of presets) {
        for (const id of entry.settings || []) wanted.add(id);
    }
    const values = {};
    for (const id of presetTargetIds(groups)) {
        // A left-out switch is one no preset decides: it ships on as the opt-in child of a feature that ships off.
        // Writing it false here would silently drop it when the player later turns the parent on.
        if (Object.hasOwn(LEFT_OUT, id)) continue;
        values[id] = wanted.has(id);
    }
    return values;
}

/**
 * The presets a combined apply writes: Essentials as the base, then each chosen combinable preset once.
 * @param {string[]} presetIds
 * @returns {Object[]|null} Presets, or null when an id is unknown or Defaults is mixed with others
 */
export function presetsForSelection(presetIds) {
    const ids = [...new Set(presetIds || [])];
    if (ids.length === 0) return null;
    if (ids.includes(DEFAULT_PRESET_ID)) return ids.length === 1 ? [getPreset(DEFAULT_PRESET_ID)] : null;
    const chosen = ids.map((id) => getPreset(id));
    if (chosen.some((preset) => !preset || !preset.settings)) return null;
    return ids.includes('essentials') ? chosen : [getPreset('essentials'), ...chosen];
}

/**
 * The per-character key the bulk-write snapshot lives under.
 *
 * Shared with All Off deliberately: there is one "before the last bulk write"
 * state, and Restore should undo whichever bulk write happened last.
 *
 * @returns {string}
 */
export function bulkSnapshotKey(characterId = dataManager.getCurrentCharacterId?.()) {
    return characterId ? `${SNAPSHOT_KEY_PREFIX}_${characterId}` : SNAPSHOT_KEY_PREFIX;
}

/**
 * Who a bulk write belongs to, captured before its first await. Identity is
 * the character, not the settings map object: a reload or reset replaces the
 * map even for the same character, and writes go through the live
 * `config.settingsMap`, so continuing on the new map is correct there. An
 * A -> B -> A round trip is the same character again and may continue too.
 *
 * @returns {{characterId: (string|undefined), key: string}}
 */
export function captureBulkOwner() {
    const characterId = dataManager.getCurrentCharacterId?.();
    return { characterId, key: bulkSnapshotKey(characterId) };
}

/**
 * Whether the character a bulk write started on is still the live one. Check after every await, before touching config or a snapshot.
 *
 * @param {{characterId: (string|undefined)}} owner - From `captureBulkOwner`
 * @returns {boolean}
 */
export function isBulkOwnerCurrent(owner) {
    return dataManager.getCurrentCharacterId?.() === owner.characterId;
}

/**
 * Record every bulk-writable setting's current value, so Restore has something
 * to put back.
 * @param {{key: string}} [owner] - Captured owner; defaults to the current character
 * @returns {Promise<Object<string, boolean>>} The snapshot that was saved
 * @throws {Error} When storage refuses the write — the caller must not go on
 *   to change anything it could not then undo
 */
export async function saveBulkSnapshot(owner = captureBulkOwner()) {
    const snapshot = {};
    for (const id of presetTargetIds()) {
        const entry = config.getSettingEntry?.(id) ?? config.settingsMap[id];
        if (!entry) continue;
        snapshot[id] = entry.isTrue ?? false;
    }
    const saved = await storage.setJSON(bulkSnapshotKey(owner.characterId), snapshot, 'settings', true);
    if (saved === false) throw new Error('The undo snapshot could not be saved');
    return snapshot;
}

/**
 * The saved snapshot, or null when no bulk write has happened.
 * @param {{key: string}} [owner] - Captured owner; defaults to the current character
 * @returns {Promise<Object<string, boolean>|null>}
 */
export async function loadBulkSnapshot(owner = captureBulkOwner()) {
    return storage.getJSON(bulkSnapshotKey(owner.characterId), 'settings', null);
}

/**
 * Forget the snapshot — after Restore has used it.
 * @param {{key: string}} [owner] - Captured owner; defaults to the current character
 * @returns {Promise<void>}
 */
export async function clearBulkSnapshot(owner = captureBulkOwner()) {
    // null, not a delete: sync carries whole keys, so a deleted snapshot comes back from the gist on the next pull
    // and the Restore button with it. A null is a newer value the whole-key rule carries; readers treat it as absent.
    await storage.set(bulkSnapshotKey(owner.characterId), null, 'settings', true);
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
        const entry = config.getSettingEntry?.(id) ?? config.settingsMap[id];
        if (!entry) continue;
        if ((entry.isTrue ?? false) === value) continue;
        config.setSetting(id, value);
        written.push(id);
    }
    return written;
}

/**
 * Apply one or several presets as a single write: one snapshot, one union of their lists (Essentials is always
 * the base), everything in none of them off. Restore undoes the whole combined apply.
 *
 * @param {string[]} presetIds - Ids from `SETTING_PRESETS`; Defaults only on its own
 * @returns {Promise<Object<string, boolean>|null>} The values written, or null when an id is unknown, Defaults was
 *   mixed with others, the undo snapshot could not be saved, or the character changed mid-write (nothing is written)
 */
export async function applyPresets(presetIds) {
    try {
        const presets = presetsForSelection(presetIds);
        if (!presets) {
            console.error(`[SettingPresets] Unknown or uncombinable presets: ${(presetIds || []).join(', ')}`);
            return null;
        }

        const owner = captureBulkOwner();
        const values = resolvePresetValues(presets);
        await saveBulkSnapshot(owner);
        if (!isBulkOwnerCurrent(owner)) {
            // The character changed while the snapshot was saving; these values were chosen for the old one
            console.warn('[SettingPresets] Character changed while applying a preset; nothing was written');
            return null;
        }
        writeCheckboxValues(values);
        return values;
    } catch (error) {
        console.error('[SettingPresets] Applying a preset failed:', error);
        return null;
    }
}

/**
 * Apply a named preset.
 *
 * Snapshots first, so the Restore button can undo it exactly the way it undoes
 * All Off — a preset is a large change, and a large change a person cannot walk
 * back is one they will not risk making.
 *
 * @param {string} presetId - An id from `SETTING_PRESETS`
 * @returns {Promise<Object<string, boolean>|null>} See `applyPresets`
 */
export async function applyPreset(presetId) {
    return applyPresets([presetId]);
}
