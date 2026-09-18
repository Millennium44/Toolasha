/**
 * What in the database is Toolasha's, and therefore what the sync may carry.
 *
 * The IndexedDB this script uses is shared. Other userscripts open the same
 * database, create their own object stores in it, and write their own keys into
 * `settings` beside ours. That was invisible for as long as the payload was
 * built by walking `listStores()` and uploading whatever came back: a full-scope
 * push carried every store in the database and every key in it, ours or not.
 * Measured on a real account, two foreign keys in `settings` came to roughly
 * 600 KB — about a fifth of every payload, uploaded and downloaded forever, for
 * data this script cannot read and must not restore.
 *
 * So the payload is built from a declared list instead: {@link SYNCED_STORES}
 * says which stores travel, and {@link OWNED_KEY_PREFIXES} says which keys
 * travel out of the stores that are shared key-by-key. Anything else is left
 * where it is — not uploaded, and (this is the half that matters) not written
 * back on a pull, so the local value simply stays.
 *
 * ## This is NOT the local-only list
 *
 * `LOCAL_ONLY_KEY_PREFIXES` and `LOCAL_ONLY_SETTING_IDS` in `sync-payload.js`
 * name things Toolasha *owns* and deliberately keeps on one machine — a token, a
 * core count, a cache. This file names what Toolasha owns at all. A key can be
 * ours and local (a sync cursor); a key can be neither ours nor local (another
 * script's). The two lists answer different questions and both are needed.
 *
 * ## Getting this wrong in the unsafe direction
 *
 * A Toolasha key missing from the registry stops syncing, and stops *quietly*.
 * Nothing fails; the key simply never appears on the other device, and the loss
 * looks like a bug in whatever feature owns it, years later. That is worse than
 * the waste this file exists to cut, so the rule is: when in doubt, register it.
 * An over-inclusive registry syncs a few keys it need not. An under-inclusive
 * one loses history.
 *
 * `sync-ownership-coverage.test.js` is what keeps this list honest — it parses
 * `src/` for the keys the script writes and fails when one is not covered here.
 */

/**
 * Object stores whose contents the sync carries.
 *
 * Every store this script creates in `core/storage.js` except the ones another
 * script owns — see {@link FOREIGN_STORES}. A store missing from both lists
 * fails `sync-ownership.test.js`, so adding an object store forces a decision
 * about whether it syncs rather than defaulting into the payload unnoticed.
 */
export const SYNCED_STORES = [
    'settings',
    'rerollSpending',
    'dungeonRuns',
    'teamRuns',
    'combatExport',
    'unifiedRuns',
    'marketListings',
    'combatStats',
    'xpHistory',
    'alchemyHistory',
    'labyrinth',
    'guildHistory',
    'networthHistory',
    'collections',
    'queueSnapshots',
    'lootLogHistory',
    'leaderboardHistory',
    // Created for the upstream script this database is shared with, and since
    // written by this one too (`core/data-manager.js`,
    // `features/character-activity/character-activity-storage.js`), so they are
    // ours to carry.
    'actionProgress',
    'characterActivityStatus',
];

/**
 * Object stores this script creates but does not own.
 *
 * `openableAnalytics` exists only because the database version is shared: the
 * upstream script expects it at its schema version, so `core/storage.js` creates
 * it to keep upstream's transactions from failing. Nothing in `src/` reads or
 * writes it. Uploading it put another script's whole analytics record in every
 * payload, and `importEverything` wrote it back on every pull.
 */
export const FOREIGN_STORES = ['openableAnalytics'];

/**
 * Stores shared with another script at the key level, filtered key by key.
 *
 * `settings` is the one: it is where every script that uses this database puts
 * its odds and ends, and where the foreign weight was measured. The rest of
 * {@link SYNCED_STORES} are this script's own object stores, created by it for
 * one feature each, and travel whole — filtering them by prefix would buy
 * nothing and would be one more list to keep in step.
 */
export const KEY_FILTERED_STORES = ['settings'];

/**
 * Key prefixes Toolasha claims in a key-filtered store.
 *
 * A prefix, not a key: nearly every record here is written per character as
 * `<base>_<characterId>`, so registering the base covers every scoped form. The
 * bare base is covered too, because it is what pre-scoping builds wrote and what
 * `utils/character-key.js` still adopts.
 *
 * Grouped by the feature that owns each family so that a feature being deleted
 * takes its rows with it. Legacy names are kept even when nothing writes them
 * any more — an account that still holds one is still entitled to sync it.
 */
export const OWNED_KEY_PREFIXES = [
    // Settings themselves, and the bookkeeping that makes them load correctly
    'script_settingsMap',
    'settings_shared_scope_v3',
    'settings_shared_scope_conflicts',
    // Covers every rewrite batch's flag: v2, v3, and whatever comes next
    'settings_default_rewrites_',
    'settings_key_migrations_applied_',
    'known_character_ids',
    'accountCharacterNames',
    'adoptionTargetCharacterId',
    'toolasha_settingsFingerprint_',
    'toolasha_collapsedGroups',
    'toolasha_allOffSnapshot_',
    'toolasha_characterGameModes',
    'toolasha_forkBackupPrompted',
    'toolasha_ironCowSnapshot',
    'ironCowFarmOverrides',
    'ironCowFarmPlanCollapsed',
    'ironCowFarmSnapshot',
    'whatsNew_state',
    'updateCheckIntroduced',
    'updateCheckState',

    // Panels, layout and other places the UI remembers where it was
    'panelGeometry',
    'panelOpenState',
    'panelSizeMemory',
    'modalPositions3',
    'tabOrder_',
    'overlayPanel',
    'overlayLayouts',
    'overlayAppliedLayout',
    'charmPanelFolds',
    'bulkSellPanelPosition',
    'consumablesBuyWidgetPosition',
    'queueMonitor_collapsed',
    'queueSnapshot_',
    'toolasha_local_', // device-local, but ours — see LOCAL_ONLY_KEY_PREFIXES
    'toolasha_sync_', // the sync's own bookkeeping: ours, and device-local too

    // Actions panel
    'actionSortMode_',
    'actionTimingLog_',
    'pinnedActions_',
    'quickInput_addMode',

    // Market
    'Toolasha_marketAPI_', // device-local, but ours
    'Toolasha_customPriceOverrides',
    'marketHistoryFilters',
    'marketHistoryKMBFormat',
    'mooketWatchlist',
    'mooketPanelPrefs',
    'bulkSellStatusExpanded',
    'watchlist',
    'tradeHistory',
    'tradeLedger',
    'marketListingTimestamps',
    'inventoryReservationLedger',
    'inventorySort',
    'equipmentSavings',
    'housesUntracked',
    'philoCalculatorSettings',

    // Combat, its panels and its recorders
    'combatProfitView',
    'combatIncomeNetSalesTax',
    'combatLevelSelection',
    'combatRecordControl_target',
    'combatReplayCheck_',
    'combatStatsChatFields',
    'combatStatsChatUseCheckboxes',
    'combatSessionHistory',
    'consumablesSettings',
    'consumablesIdleLoadout',
    'consumablesIdleZone',
    'consumablesDungeonRuns',
    'consumablesLabRuns',
    'loadout_snapshots_',
    'scroll_simulation_',
    'dungeonTracker_',
    'labyrinthRoomLogs',
    'labyrinthFightOutcomes',
    'spawnCensus',
    'allZonesSnapshot',
    'playerColors',
    'playerClassOverrides',

    // Simulators
    'combatSim',
    'labSim',
    'simEditorLoadoutName',

    // Guild
    'guildShrinePlan',
    'guildTrial',
    'guildToken',
    'trialTrace',

    // Tasks
    'taskIconFilters',
    'taskIconsFilter',
    'taskEstimateMode',
    'taskCapProtection',
    'taskCapCoinThreshold',
    'taskCapCowbellThreshold',
    'taskProtectedHrids_',
    'taskAutoRerollHrids_',
    'taskReroll',

    // Alchemy, enhancement, networth, goals, briefing, notices
    'alchemyItemPins',
    'alchemyProtectedCategories_',
    'enhancementItemPins',
    'enhancementTracker_',
    'networth_exclusions_',
    'networthDetail_',
    'networthChartPrefs',
    'treasureTally',
    'treasureSettings',
    'treasureScrollPurge',
    'goalPlanner',
    'briefingSnapshot_',
    'briefingAwayDiffSeen_',
    'sessionBriefing',
    'noticeLog_',
];

/**
 * Keys whose leading segment is a character id, so no prefix can catch them.
 *
 * Two features name their records `<characterId>_<what>` rather than
 * `<what>_<characterId>`. Nothing is wrong with them, but a prefix registry
 * cannot see them, and a key a registry cannot see is a key that silently stops
 * syncing — which is the failure this whole file exists to avoid. They are
 * matched by shape instead. The character id is left loose (`.+`) on purpose:
 * it has been a number, a `characterId` string and the literal `default` at
 * different times, and a pattern that pins it would quietly drop the forms it
 * did not predict.
 */
export const OWNED_KEY_PATTERNS = [/^.+_bulkSell_lastTab$/, /^.+_inventoryTabs_config$/];

/**
 * Whether a store's contents belong in the payload at all.
 * @param {string} storeName - Object store name
 * @returns {boolean} True when the store is Toolasha's to sync
 */
export function isSyncedStore(storeName) {
    return SYNCED_STORES.includes(storeName);
}

/**
 * Whether one key in one store is Toolasha's.
 *
 * A store that is not key-filtered answers `true` for everything in it: it is
 * this script's own object store, and every key in it got there from this
 * script. Only the shared stores are read key by key.
 *
 * @param {string} storeName - Object store the key lives in
 * @param {string} key - Storage key
 * @returns {boolean} True when the key may be uploaded and restored
 */
export function ownsKey(storeName, key) {
    if (!KEY_FILTERED_STORES.includes(storeName)) return isSyncedStore(storeName);
    const name = String(key);
    if (OWNED_KEY_PREFIXES.some((prefix) => name.startsWith(prefix))) return true;
    return OWNED_KEY_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * Split a store's contents into what Toolasha may carry and what it may not.
 *
 * The foreign half comes back as a count and a byte total and nothing else —
 * deliberately. This is what the push logs, and a log line is a thing people
 * paste into a chat: naming another script's keys in it would publish what that
 * script stores, which is not ours to publish. A count and a weight are enough
 * to watch the foreign share over time, which is the only thing the number is
 * for.
 *
 * @param {string} storeName - Object store the entries came from
 * @param {Record<string, *>} entries - The store's contents
 * @returns {{owned: Record<string, *>, foreignKeys: number, foreignBytes: number}}
 *   The entries that may travel, and the weight of the ones that may not
 */
export function partitionOwnedKeys(storeName, entries) {
    const source = entries || {};
    if (!KEY_FILTERED_STORES.includes(storeName)) {
        return { owned: source, foreignKeys: 0, foreignBytes: 0 };
    }

    const keys = Object.keys(source);
    if (keys.every((key) => ownsKey(storeName, key))) {
        return { owned: source, foreignKeys: 0, foreignBytes: 0 };
    }

    const owned = {};
    let foreignKeys = 0;
    let foreignBytes = 0;
    for (const key of keys) {
        if (ownsKey(storeName, key)) {
            owned[key] = source[key];
            continue;
        }
        foreignKeys += 1;
        foreignBytes += weigh(source[key]) + key.length;
    }
    return { owned, foreignKeys, foreignBytes };
}

/**
 * Roughly how many bytes a stored value would occupy in the payload.
 *
 * `JSON.stringify` on a value that cannot be serialized (a cycle, something
 * exotic another script stored) throws, and a diagnostic figure is never worth
 * failing a push over — an unmeasurable value counts as zero and the summary is
 * a little low, which is the harmless direction.
 *
 * @param {*} value - Stored value
 * @returns {number} Serialized length, or 0 when it cannot be measured
 */
function weigh(value) {
    try {
        return JSON.stringify(value)?.length ?? 0;
    } catch {
        return 0;
    }
}

export default {
    SYNCED_STORES,
    FOREIGN_STORES,
    KEY_FILTERED_STORES,
    OWNED_KEY_PREFIXES,
    OWNED_KEY_PATTERNS,
    isSyncedStore,
    ownsKey,
    partitionOwnedKeys,
};
