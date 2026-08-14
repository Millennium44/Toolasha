// ==UserScript==
// @name         Toolasha (Millennium44)
// @namespace    http://tampermonkey.net/
// @version      3.3.0
// @description  Toolasha (Millennium44 fork) — enhanced tools for Milky Way Idle: combat & labyrinth simulators with upgrade advisors, per-character data, cross-device sync, goal planner, guild tools, overlay, mobile support. Built on work by bot7420, Celasha, Frotty, Q7, jigglymoose, dakonglong, and the combat-sim team — full credits in the listing info.
// @author       Millennium44 (fork of Celasha and Claude's Toolasha). Thank you to bot7420, DrDucky, Frotty, Truth_Light, AlphB, qu, and sentientmilk for providing the basis for a lot of this; to Shykai, amVoidGuy, vlad, and kuganDev for their immense work on the combat sim; and to Paradoxian for extensive bug finding, testing, and detailed writeups. Thanks to Miku, Orvel, Jigglymoose, Incinarator, Knerd, Maarg, MekaPyon, and others for their time and help; to SilkyPanda for contributing several features; to Steez for testing and catching my mistakes; to Tib for the Character Cards; to Sapnas for deep testing and singlehandedly improving performance; to vidonnus for infrastructure, bug fixes, engineering, and issue raising; and to Zaeter for the name. This fork also draws on code and ideas from other Milky Way Idle tools: MWITools by bot7420, MWI Combat Suite by Frotty, JIGS by jigglymoose, the Labyrinth Win Rate Calculator by dakonglong, and the mooket market pools by Q7 (mooket II) and IOMisaka (mooket I).
// @license      CC-BY-NC-SA-4.0
// @run-at       document-start
// @match        https://www.milkywayidle.com/*
// @match        https://test.milkywayidle.com/*
// @match        https://shykai.github.io/MWICombatSimulatorTest/dist/*
// @grant        GM_addStyle
// @grant        GM.xmlHttpRequest
// @grant        GM_xmlhttpRequest
// @connect      api.github.com
// @connect      gist.githubusercontent.com
// @grant        GM_notification
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @require      https://cdnjs.cloudflare.com/ajax/libs/mathjs/12.4.2/math.js
// @require      https://cdn.jsdelivr.net/npm/chart.js@3.7.0/dist/chart.min.js
// @require      https://cdn.jsdelivr.net/npm/chartjs-plugin-datalabels@2.0.0/dist/chartjs-plugin-datalabels.min.js
// @require      https://cdn.jsdelivr.net/gh/Millennium44/Toolasha@35311ca90f2ebb38bfef7d883621522f7a015010/dist/libraries/toolasha-core.js
// @require      https://cdn.jsdelivr.net/gh/Millennium44/Toolasha@35311ca90f2ebb38bfef7d883621522f7a015010/dist/libraries/toolasha-utils.js
// @require      https://cdn.jsdelivr.net/gh/Millennium44/Toolasha@35311ca90f2ebb38bfef7d883621522f7a015010/dist/libraries/toolasha-sim.js
// @require      https://cdn.jsdelivr.net/gh/Millennium44/Toolasha@35311ca90f2ebb38bfef7d883621522f7a015010/dist/libraries/toolasha-market.js
// @require      https://cdn.jsdelivr.net/gh/Millennium44/Toolasha@35311ca90f2ebb38bfef7d883621522f7a015010/dist/libraries/toolasha-actions.js
// @require      https://cdn.jsdelivr.net/gh/Millennium44/Toolasha@35311ca90f2ebb38bfef7d883621522f7a015010/dist/libraries/toolasha-combat.js
// @require      https://cdn.jsdelivr.net/gh/Millennium44/Toolasha@35311ca90f2ebb38bfef7d883621522f7a015010/dist/libraries/toolasha-ui.js
// ==/UserScript==
// Note: Combat Sim auto-import requires Tampermonkey for cross-domain storage. Not available on Steam (use manual clipboard copy/paste instead).

(function () {
    'use strict';

    /**
     * Toolasha Entrypoint
     * Minimal bootstrap script that loads libraries and initializes features
     *
     * Libraries are loaded via @require in userscript header:
     * - Core (core modules, API)
     * - Utils (all utilities)
     * - Market (market, inventory, economy)
     * - Actions (production, gathering, alchemy)
     * - Combat (combat, stats, abilities)
     * - UI (tasks, skills, settings, misc)
     */

    // Access libraries from global namespace
    const Core = window.Toolasha.Core;
    const Utils = window.Toolasha.Utils;
    const Market = window.Toolasha.Market;
    const Actions = window.Toolasha.Actions;
    const Combat = window.Toolasha.Combat;
    const UI = window.Toolasha.UI;

    // Destructure core modules
    const { storage, config, webSocketHook, domObserver, dataManager, featureRegistry, performanceMonitor } = Core;

    const { setupScrollTooltipDismissal } = Utils.dom;
    const { showToast } = Utils.toast;
    const { GAME } = Utils.selectors;

    /**
     * Detect if running on Combat Simulator page
     * @returns {boolean} True if on Combat Simulator
     */
    function isCombatSimulatorPage() {
        const url = window.location.href;
        // Only work on test Combat Simulator for now
        return url.includes('shykai.github.io/MWICombatSimulatorTest/dist/');
    }

    /* ------------------------------------------------------------------------- *
     * Health checks
     *
     * `featureRegistry.checkFeatureHealth()` has run since the beginning and has
     * always found nothing, because it skips any feature without a `healthCheck`
     * and no feature had one. The registry entry is the right place to put them:
     * a check belongs to how the feature is wired into the page, not to the module,
     * and writing them here keeps ~150 feature modules untouched.
     *
     * The contract the registry expects, from `checkFeatureHealth`:
     *
     *   true   — healthy
     *   false  — broken; the feature is retried once and then reported
     *   null   — cannot tell right now; ignored
     *
     * The registry has already skipped anything switched off (`customCheck`, or
     * `config.isFeatureEnabled(key)`) before calling these, so a check never has to
     * ask whether its own feature is on. It does have to ask about the sub-settings
     * that gate what gets drawn — `actionBar_enabled` under `actionTimeDisplay`,
     * for instance — because a feature whose output the player turned off is not a
     * feature that failed. Those cases return true.
     *
     * Every check is the same shape: *given the game has drawn the thing this
     * feature attaches to, did the feature's own mark appear on it?* No anchor
     * means the panel is not open, which is not evidence of anything — null. The
     * predicates, feature by feature:
     *
     *   networth              header total-level block exists  → .mwi-networth-header
     *   marketOrderTotals     header total-level block exists  → .mwi-market-order-totals
     *   actionTimeDisplay     header action-name block exists  → #mwi-action-time-display
     *   taskIcons             a task card is on screen         → [data-mwi-task-processed]
     *   taskStatistics        the Tasks tab strip exists       → .toolasha-task-stats-btn
     *   overlayTabButton      the tab strip holding Inventory  → #toolasha-overlay-tab
     *   skillExpPercentage    a nav XP bar with a width        → .mwi-exp-percentage
     *   skillRemainingXP      a nav XP bar with a label        → .mwi-remaining-xp
     *   inventoryBadgeManager inventory item containers        → [data-ask-value] on one
     *   inventoryBadgePrices  an item priced above zero        → .mwi-badge-price-ask/bid
     *   itemCountDisplay      marketplace item tiles           → .mwi-item-count
     *   zoneIndices           combat zone tab buttons          → span.script_mapIndex
     *   combatScore           a profile overview tab is open   → #mwi-combat-score-panel
     *
     * None of the above can catch the game renaming its own classes wholesale — an
     * absent anchor just reads as "null, ignored" everywhere above. `checkAnchorCanaries`
     * is the separate check for that: a handful of selectors for elements that exist
     * on any loaded game page no matter which panel is open (the header, the page's
     * own wrapper, the persistent skill nav bars). It runs once, on the same delay as
     * the health pass, and reports through the same `UI.healthStatus.reportFailures`
     * channel with reason "selector missing — game update?".
     *
     * `UI.schemaCanary` is the third of these, and the one that looks at neither the
     * page nor the features but at the game's own data: the top-level maps this
     * script indexes by literal key, the item and buff-type hrids it matches by
     * literal string, and the dungeon wave counts it falls back to. Those fail even
     * more quietly than a selector does — a renamed map is `{}`, a renamed hrid is
     * `null` — so it runs beside the selector canary and reports through the same
     * channel with reason "data shape changed — game update?".
     * ------------------------------------------------------------------------- */

    /**
     * The shape every check shares: no anchor is no evidence, an anchor without the
     * mark is a failure.
     *
     * @param {string} anchor - Selector for the game element the feature attaches to
     * @param {string} marker - Selector for what the feature injects
     * @returns {boolean|null} true healthy, false broken, null undecidable
     */
    function injectedInto(anchor, marker) {
        if (!document.querySelector(anchor)) return null;
        return Boolean(document.querySelector(marker));
    }

    /**
     * A check that only applies while a sub-setting is on.
     *
     * A switched-off readout must never read as a broken one — that is the failure
     * mode that would make the whole health pass noise the moment anybody turned
     * something off.
     *
     * @param {string} setting - Setting key gating the visible output
     * @param {Function} check - The predicate to run when it is on
     * @returns {boolean|null} true when the setting is off, else the predicate
     */
    function whenSetting(setting, check) {
        if (!config.getSetting(setting)) return true;
        return check();
    }

    /**
     * The character panel's tab strip, identified by holding an Inventory tab —
     * every tab strip in the game shares the same classes.
     * @returns {HTMLElement|null} The strip, or null if it is not drawn
     */
    function findCharacterTabList() {
        for (const list of document.querySelectorAll('[role="tablist"]')) {
            for (const tab of list.querySelectorAll('[role="tab"]')) {
                if (tab.textContent.trim() === 'Inventory') return list;
            }
        }
        return null;
    }

    /**
     * One list of failures from several, with each feature named once.
     *
     * A feature whose initializer threw will usually also fail its health check, and
     * a toast that says "2 features failed" about one feature is a toast nobody
     * trusts the next time. The first reason wins, because the throw says more than
     * "its mark is missing" does.
     *
     * @param {...Array<{key: string, name: string, reason: string}>} lists - Failure lists
     * @returns {Array<{key: string, name: string, reason: string}>} Deduplicated by key
     */
    function mergeFailures(...lists) {
        const byKey = new Map();
        for (const list of lists) {
            for (const failure of list || []) {
                if (!byKey.has(failure.key)) byKey.set(failure.key, failure);
            }
        }
        return [...byKey.values()];
    }

    /**
     * The selectors that should exist on a loaded game page, checked once, well
     * after startup, to catch the one failure a per-feature health check cannot:
     * the game renaming its classes out from under every selector at once. A
     * missing feature mark says "reopen the panel"; a missing anchor says the game
     * updated.
     *
     * Two kinds of entry:
     *
     * - **Ungated** (the first four): anchors that exist on any loaded page no
     *   matter which panel is open — the header, the page's own wrapper, the
     *   persistent skill nav bars. Their absence is always evidence.
     * - **Gated** (`when`): the highest-fanout hashed-class selectors in the
     *   codebase — `Item_itemContainer` alone is load-bearing in twenty-odd files
     *   — which only exist on particular screens. Each is checked only while its
     *   `when` selector matches: an element from the same screen that cannot be
     *   drawn without the canaried one. A closed panel therefore reads as "no
     *   evidence" rather than as a failure, which is what keeps this from being
     *   noise on every page where a panel is legitimately shut.
     *
     * Gates are taken from a *different* CSS-module component wherever one
     * co-exists (Inventory_↔Item_, Chat_→ChatMessage_, BattlePanel_→CombatUnit_,
     * [role="tablist"]→TabsComponent_), so a whole component renaming still trips
     * the canary whose gate survived. Where no cross-component witness exists
     * (SkillActionDetail, RandomTask) the pair gates on a sibling class: a rename
     * of one class in the component is caught, a rename of the whole component
     * falls back to the ungated four.
     *
     * The name half of the SkillActionDetail pair gates on the *regular* component
     * (`SkillActionDetail_regularComponent`) rather than the shared detail wrapper,
     * because the alchemy and enhancing panels reuse that wrapper but draw no name
     * heading — gating on the wrapper alarmed on every alchemy or enhancing screen.
     * Detection of a real `_name` rename survives: the regular panel still carries
     * the name, so a rename there trips it as before.
     *
     * Left out on purpose, despite their fanout: `Item_enhancementLevel` (only
     * drawn when an enhanced item happens to be on screen — no screen guarantees
     * one, so its absence is never evidence) and `ProgressBar_text` (absent
     * whenever the action queue is empty, and only one file leans on it).
     *
     * @returns {Array<{key: string, name: string, reason: string}>} One entry per missing anchor
     */
    function checkAnchorCanaries() {
        const ANCHORS = [
            { key: 'canaryHeaderTotalLevel', name: 'Header (total level)', selector: GAME.TOTAL_LEVEL },
            { key: 'canaryGamePanel', name: 'Game panel wrapper', selector: GAME.GAME_PANEL },
            { key: 'canaryNavLevel', name: 'Navigation bar (skill levels)', selector: GAME.NAV_LEVEL },
            { key: 'canaryNavExperience', name: 'Navigation bar (skill XP)', selector: GAME.NAV_CURRENT_EXPERIENCE },
            // Gated: checked only while `when` matches
            { key: 'canaryNavBar', name: 'Navigation bar (nav entries)', selector: GAME.NAV_BAR, when: GAME.NAV_LEVEL },
            {
                key: 'canaryTabsContainer',
                name: 'Tab strip (container)',
                selector: GAME.TABS_CONTAINER,
                when: '[role="tablist"]',
            },
            { key: 'canaryTabBadge', name: 'Tab strip (badges)', selector: GAME.TAB_BADGE, when: GAME.TABS_CONTAINER },
            {
                key: 'canaryItemContainer',
                name: 'Item tiles',
                selector: GAME.ITEM_CONTAINER,
                when: GAME.INVENTORY_ITEMS,
            },
            {
                key: 'canaryInventoryItems',
                name: 'Inventory item grid',
                selector: GAME.INVENTORY_ITEMS,
                when: GAME.ITEM_CONTAINER,
            },
            {
                key: 'canaryItemName',
                name: 'Item names (requirements list)',
                selector: GAME.ITEM_NAME,
                when: GAME.SKILL_ACTION_ITEM_REQUIREMENTS,
            },
            {
                key: 'canarySkillActionDetail',
                name: 'Skill action panel',
                selector: GAME.SKILL_ACTION_DETAIL,
                when: GAME.SKILL_ACTION_NAME,
            },
            {
                key: 'canarySkillActionName',
                name: 'Skill action panel (name)',
                selector: GAME.SKILL_ACTION_NAME,
                // Gated on the regular component, not the shared detail wrapper: the
                // alchemy and enhancing panels reuse that wrapper but draw no name,
                // so gating on the wrapper false-alarms whenever one is on screen.
                when: GAME.SKILL_ACTION_DETAIL_REGULAR,
            },
            { key: 'canaryTaskCard', name: 'Task cards', selector: GAME.TASK_CARD, when: GAME.TASK_NAME },
            {
                key: 'canaryChatMessage',
                name: 'Chat messages',
                selector: GAME.CHAT_MESSAGE,
                when: GAME.CHAT_INPUT_CONTAINER,
            },
            {
                key: 'canaryCombatUnit',
                name: 'Combat units',
                selector: GAME.COMBAT_UNIT,
                when: GAME.BATTLE_MONSTERS_AREA,
            },
            // Marketplace anchors. The item grid is present whenever the panel is
            // open; the current-item and order-books halves only appear once an item
            // is selected, so they gate on each other (a mirrored pair: renaming
            // either one is caught by the other, as long as the sibling survives).
            {
                key: 'canaryMarketItems',
                name: 'Marketplace item grid',
                selector: GAME.MARKETPLACE_ITEMS,
                when: GAME.MARKETPLACE_PANEL,
            },
            {
                key: 'canaryMarketCurrentItem',
                name: 'Marketplace current item',
                selector: GAME.MARKETPLACE_CURRENT_ITEM,
                when: GAME.MARKETPLACE_ORDER_BOOKS,
            },
            {
                key: 'canaryMarketOrderBooks',
                name: 'Marketplace order books',
                selector: GAME.MARKETPLACE_ORDER_BOOKS,
                when: GAME.MARKETPLACE_CURRENT_ITEM,
            },
            {
                key: 'canaryMarketNewListingButtons',
                name: 'Marketplace new-listing buttons',
                selector: GAME.MARKETPLACE_NEW_LISTING_BUTTONS,
                when: GAME.MARKETPLACE_CURRENT_ITEM,
            },
        ];

        const failures = [];
        for (const { key, name, selector, when } of ANCHORS) {
            if (when && !document.querySelector(when)) continue;
            if (!document.querySelector(selector)) {
                failures.push({ key, name, reason: 'selector missing — game update?' });
            }
        }
        return failures;
    }

    /**
     * Is any element matching `selector` carrying a value above zero in `field`?
     * @param {string} selector - Element selector
     * @param {string} field - dataset key
     * @returns {boolean} True if at least one is positive
     */
    function anyPositiveDataset(selector, field) {
        for (const el of document.querySelectorAll(selector)) {
            if (parseFloat(el.dataset[field]) > 0) return true;
        }
        return false;
    }

    /**
     * Register all features from libraries into the feature registry
     */
    function registerFeatures() {
        // Market Features
        const marketFeatures = [
            {
                key: 'tooltipPrices',
                name: 'Tooltip Prices',
                category: 'Market',
                module: Market.tooltipPrices,
                async: true,
                // Start the feature when ANY tooltip section is on, not just
                // prices/pin-to-top — otherwise the registry skips it and never
                // calls initialize for a profit/EV/enhancement-only setup.
                customCheck: () => Market.tooltipPrices.shouldEnable(),
            },
            {
                key: 'expectedValueCalculator',
                name: 'Expected Value Calculator',
                category: 'Market',
                module: Market.expectedValueCalculator,
                async: true,
            },
            {
                key: 'tooltipConsumables',
                name: 'Tooltip Consumables',
                category: 'Market',
                module: Market.tooltipConsumables,
                async: true,
            },
            {
                key: 'dungeonTokenTooltips',
                name: 'Dungeon Token Tooltips',
                category: 'Inventory',
                module: Market.dungeonTokenTooltips,
                async: true,
            },
            { key: 'marketFilter', name: 'Market Filter', category: 'Market', module: Market.marketFilter, async: false },
            { key: 'marketSort', name: 'Market Sort', category: 'Market', module: Market.marketSort, async: false },
            {
                key: 'autoFillPrice',
                name: 'Auto Fill Price',
                category: 'Market',
                module: Market.autoFillPrice,
                async: false,
            },
            {
                key: 'autoClickMax',
                name: 'Auto Click Max',
                category: 'Market',
                module: Market.autoClickMax,
                async: false,
            },
            {
                key: 'itemCountDisplay',
                name: 'Item Count Display',
                category: 'Market',
                module: Market.itemCountDisplay,
                async: false,
                healthCheck: () =>
                    whenSetting('market_visibleItemCount', () =>
                        injectedInto('[class*="MarketplacePanel_marketItems"] use', '.mwi-item-count')
                    ),
            },
            {
                key: 'estimatedListingAge',
                name: 'Estimated Listing Age',
                category: 'Market',
                module: Market.estimatedListingAge,
                async: true,
            },
            {
                key: 'listingPriceDisplay',
                name: 'Listing Price Display',
                category: 'Market',
                module: Market.listingPriceDisplay,
                async: false,
            },
            {
                key: 'marketplaceBadgeFilter',
                name: 'Marketplace Badge Filter',
                category: 'Market',
                module: Market.marketplaceBadgeFilter,
                async: false,
            },
            {
                key: 'marketHistoryPanel',
                name: 'Market History Panel',
                category: 'Market',
                module: Market.marketHistoryPanel,
                async: true,
            },
            {
                key: 'myListingsPriceRefresh',
                name: 'My Listings Mooket Price Refresh',
                category: 'Market',
                module: Market.myListingsPriceRefresh,
                async: false,
            },
            {
                key: 'queueLengthEstimator',
                name: 'Queue Length Estimator',
                category: 'Market',
                module: Market.queueLengthEstimator,
                async: false,
            },
            {
                key: 'marketOrderTotals',
                name: 'Market Order Totals',
                category: 'Market',
                module: Market.marketOrderTotals,
                async: false,
                healthCheck: () =>
                    whenSetting('market_showOrderTotals', () =>
                        injectedInto('[class*="Header_totalLevel"]', '.mwi-market-order-totals')
                    ),
            },
            {
                key: 'marketHistoryViewer',
                name: 'Market History Viewer',
                category: 'Market',
                module: Market.marketHistoryViewer,
                async: false,
            },
            {
                key: 'listingRefreshNavigator',
                name: 'Listing Refresh Navigator',
                category: 'Market',
                module: Market.listingRefreshNavigator,
                async: false,
            },
            {
                key: 'bulkSellAssistant',
                name: 'Bulk Sell Assistant',
                category: 'Market',
                module: Market.bulkSellAssistant,
                async: true,
            },
            {
                key: 'philoCalculator',
                name: 'Philo Calculator',
                category: 'Market',
                module: Market.philoCalculator,
                async: false,
            },
            { key: 'tradeHistory', name: 'Trade History', category: 'Market', module: Market.tradeHistory, async: false },
            {
                key: 'tradeLedgerStore',
                name: 'Trade Ledger',
                category: 'Market',
                module: Market.tradeLedgerStore,
                async: false,
            },
            {
                key: 'tradeLedgerView',
                name: 'Trade Ledger View',
                category: 'Market',
                module: Market.tradeLedgerView,
                async: false,
            },
            {
                key: 'tradeHistoryDisplay',
                name: 'Trade History Display',
                category: 'Market',
                module: Market.tradeHistoryDisplay,
                async: false,
            },
            {
                key: 'milkywayMarketLink',
                name: 'MilkyWay Market Link',
                category: 'Market',
                module: Market.milkywayMarketLink,
                async: false,
            },
            {
                key: 'sellQueue',
                name: 'Sell Queue',
                category: 'Market',
                module: Market.sellQueue,
                async: false,
            },
            {
                key: 'networth',
                name: 'Net Worth',
                category: 'Economy',
                module: Market.networthFeature,
                async: false,
                healthCheck: () => injectedInto('[class*="Header_totalLevel"]', '.mwi-networth-header'),
            },
            {
                key: 'inventoryBadgeManager',
                name: 'Inventory Badge Manager',
                category: 'Inventory',
                module: Market.inventoryBadgeManager,
                async: false,
                // The manager prices item containers, but only when a badge provider
                // drives a render — which is asynchronous, throttled, and may not
                // have run (or the price-badge provider may be off entirely) by the
                // time the health pass fires. A drawn-but-unpriced inventory is
                // "not yet", not "broken", so this confirms health when a priced
                // container exists and otherwise stands down — it must never report
                // `false`, or it cries wolf on every marketplace/mobile open. The
                // real badge output is health-checked by inventoryBadgePrices, which
                // handles the not-yet case the same way.
                healthCheck: () => {
                    if (!document.querySelector('[class*="Inventory_items"] [class*="Item_itemContainer"]')) return null;
                    return document.querySelector(
                        '[class*="Inventory_items"] [class*="Item_itemContainer"][data-ask-value]'
                    )
                        ? true
                        : null;
                },
            },
            {
                key: 'treasureTracker',
                name: 'Treasure Tracker',
                category: 'Inventory',
                module: Market.treasureTracker,
                async: true,
            },
            {
                key: 'combatText',
                name: 'Combat Text',
                category: 'UI',
                module: UI.combatText,
                async: false,
                // Either half being on is enough; the module subscribes to nothing
                // when both are off
                customCheck: () => config.getSetting('combatText_floating') || config.getSetting('combatText_scrolling'),
            },
            {
                key: 'watchlist',
                name: 'Watchlist',
                category: 'Inventory',
                module: Market.watchlist,
                async: false,
            },
            {
                // The list itself is always live — the overlay tile and the panel
                // read it whatever this says. What the switch turns on is only the
                // button in the game's own item menu.
                key: 'equipmentSavings_menuButton',
                name: 'Equipment Savings',
                category: 'Inventory',
                module: Market.equipmentSavings,
                async: false,
                customCheck: () => true,
            },
            {
                key: 'inventorySort',
                name: 'Inventory Sort',
                category: 'Inventory',
                module: Market.inventorySort,
                async: false,
            },
            {
                key: 'inventoryBadgePrices',
                name: 'Inventory Badge Prices',
                category: 'Inventory',
                module: Market.inventoryBadgePrices,
                async: false,
                // A badge is only drawn for an item worth something, so the anchor is
                // not "an inventory" but "an item the manager has priced above zero"
                healthCheck: () =>
                    whenSetting('invBadgePrices', () => {
                        const items = '[class*="Inventory_items"] [class*="Item_itemContainer"]';
                        if (!anyPositiveDataset(items, 'askPrice')) return null;
                        return Boolean(document.querySelector('.mwi-badge-price-ask, .mwi-badge-price-bid'));
                    }),
            },
            {
                key: 'invCategoryTotals',
                name: 'Inventory Category Totals',
                category: 'Inventory',
                module: Market.inventoryCategoryTotals,
                async: false,
            },
            {
                key: 'autoAllButton',
                name: 'Auto All Button',
                category: 'Inventory',
                module: Market.autoAllButton,
                async: false,
            },
            {
                key: 'inventoryTabs',
                name: 'Custom Inventory Tabs',
                category: 'Inventory',
                module: Market.customTabsFeature,
                async: true,
            },
        ];

        // Actions Features
        const actionsFeatures = [
            {
                key: 'actionTimeDisplay',
                name: 'Action Time Display',
                category: 'Actions',
                module: Actions.actionTimeDisplay,
                async: false,
                healthCheck: () =>
                    whenSetting('actionBar_enabled', () =>
                        injectedInto('div[class*="Header_actionName"]', '#mwi-action-time-display')
                    ),
            },
            {
                key: 'actionCountdown',
                name: 'Action Bar Countdown',
                category: 'Actions',
                module: Actions.actionCountdown,
                async: false,
            },
            {
                key: 'actionPanelLayout',
                name: 'Action Panel Layout',
                category: 'Actions',
                module: Actions.actionPanelLayout,
                async: false,
            },
            {
                key: 'quickInputButtons',
                name: 'Quick Input Buttons',
                category: 'Actions',
                module: Actions.quickInputButtons,
                async: false,
            },
            { key: 'outputTotals', name: 'Output Totals', category: 'Actions', module: Actions.outputTotals, async: false },
            {
                key: 'maxProduceable',
                name: 'Max Produceable',
                category: 'Actions',
                module: Actions.maxProduceable,
                async: false,
            },
            {
                key: 'gatheringStats',
                name: 'Gathering Stats',
                category: 'Actions',
                module: Actions.gatheringStats,
                async: false,
            },
            {
                key: 'requiredMaterials',
                name: 'Required Materials',
                category: 'Actions',
                module: Actions.requiredMaterials,
                async: false,
            },
            {
                key: 'drinkTimer',
                name: 'Drink Timer',
                category: 'Actions',
                module: Actions.drinkTimer,
                async: false,
            },
            {
                key: 'missingMaterialsButton',
                name: 'Missing Materials Button',
                category: 'Actions',
                module: Actions.missingMaterialsButton,
                async: false,
            },
            {
                key: 'budgetCalculator',
                name: 'Budget Calculator',
                category: 'Actions',
                module: Actions.budgetCalculator,
                async: false,
            },
            {
                key: 'costSummary',
                name: 'Cost Summary',
                category: 'Actions',
                module: Actions.costSummary,
                async: false,
            },
            {
                key: 'craftingPlan',
                name: 'Crafting Plan',
                category: 'Actions',
                module: Actions.craftingPlan,
                async: false,
            },
            {
                key: 'alchemyProfitDisplay',
                name: 'Alchemy Profit Display',
                category: 'Alchemy',
                module: Actions.alchemyProfitDisplay,
                async: false,
            },
            {
                key: 'alchemyBestItems',
                name: 'Alchemy Best Items',
                category: 'Alchemy',
                module: Actions.alchemyBestItems,
                async: false,
                customCheck: () => config.getSetting('alchemy_bestItems'),
            },
            {
                key: 'alchemyItemPins',
                name: 'Alchemy Item Pins',
                category: 'Alchemy',
                module: Actions.alchemyItemPins,
                async: true,
            },
            {
                key: 'teaRecommendation',
                name: 'Tea Recommendation',
                category: 'Actions',
                module: Actions.teaRecommendation,
                async: false,
            },
            {
                key: 'lootLogStats',
                name: 'Loot Log Statistics',
                category: 'Actions',
                module: UI.lootLogStats,
                async: true,
            },
            {
                key: 'inventoryCountDisplay',
                name: 'Inventory Count Display',
                category: 'Actions',
                module: Actions.inventoryCountDisplay,
                async: false,
            },
            {
                key: 'pinnedActionsPage',
                name: 'Pinned Actions Page',
                category: 'Actions',
                module: Actions.pinnedActionsPage,
                async: false,
            },
            {
                key: 'skillingOptimizer',
                name: 'Skilling Optimizer',
                category: 'Actions',
                module: Actions.skillingOptimizer,
                async: false,
            },
            {
                key: 'goalPlanner',
                name: 'Goal Planner',
                category: 'General',
                module: Actions.goalPlanner,
                async: true,
            },
        ];

        // Combat Features
        const combatFeatures = [
            {
                key: 'damageTracker',
                name: 'Damage Tracker',
                category: 'Combat',
                // `.default` because the global is the module namespace — see
                // the note in libraries/combat.js
                module: Combat.damageTracker.default,
                async: false,
            },
            {
                key: 'damageTakenTracker',
                name: 'Damage Taken Tracker',
                category: 'Combat',
                module: Combat.damageTakenTracker.default,
                async: false,
            },
            {
                key: 'combatRecorder_autoStart',
                name: 'Combat Recorder',
                category: 'Combat',
                module: Combat.combatRecorder,
                async: false,
                // The module is always reachable from the Damage panel's Record
                // button; what this switch turns on is only the automatic start
                customCheck: () => true,
            },
            {
                key: 'manaTracker',
                name: 'Mana Tracker',
                category: 'Combat',
                module: Combat.manaTracker,
                async: false,
            },
            {
                key: 'abilityBookCalculator',
                name: 'Ability Book Calculator',
                category: 'Combat',
                module: Combat.abilityBookCalculator,
                async: false,
            },
            {
                key: 'abilityDictionaryButton',
                name: 'Ability Dictionary Button',
                category: 'Combat',
                module: Combat.abilityDictionaryButton,
                async: false,
            },
            {
                key: 'chestKeyMarketButton',
                name: 'Chest Key Market Button',
                category: 'Combat',
                module: Combat.chestKeyMarketButton,
                async: false,
            },
            {
                key: 'zoneIndices',
                name: 'Zone Indices',
                category: 'Combat',
                module: Combat.zoneIndices,
                async: false,
                // The map numbering is the unconditional half — every zone button
                // gets one. The task numbering only applies to combat tasks, so it
                // is not what this asks about.
                healthCheck: () =>
                    whenSetting('mapIndex', () =>
                        injectedInto(
                            'div.MainPanel_subPanelContainer__1i-H9 div.CombatPanel_tabsComponentContainer__GsQlg ' +
                                'div.MuiTabs-root.MuiTabs-vertical button.MuiButtonBase-root.MuiTab-root span.MuiBadge-root',
                            'span.script_mapIndex'
                        )
                    ),
            },
            {
                key: 'combatScore',
                name: 'Combat Score',
                category: 'Profile',
                module: Combat.combatScore,
                async: false,
                healthCheck: () => injectedInto('div.SharableProfile_overviewTab__W4dCV', '#mwi-combat-score-panel'),
            },
            {
                key: 'characterCardButton',
                name: 'Character Card Button',
                category: 'Profile',
                module: Combat.characterCardButton,
                async: false,
            },
            {
                key: 'loadoutEnhancementDisplay',
                name: 'Loadout Enhancement Display',
                category: 'Combat',
                module: Combat.loadoutEnhancementDisplay,
                async: false,
            },
            {
                key: 'dungeonTracker',
                name: 'Dungeon Tracker',
                category: 'Combat',
                module: Combat.dungeonTracker,
                async: false,
            },
            {
                key: 'dungeonTrackerUI',
                name: 'Dungeon Tracker UI',
                category: 'Combat',
                module: Combat.dungeonTrackerUI,
                async: false,
            },
            {
                key: 'dungeonTrackerChatAnnotations',
                name: 'Dungeon Tracker Chat',
                category: 'Combat',
                module: Combat.dungeonTrackerChatAnnotations,
                async: false,
            },
            {
                key: 'combatBattleCounter',
                name: 'Combat Battle Counter',
                category: 'Combat',
                module: Combat.combatBattleCounter,
                async: false,
            },
            {
                key: 'combatSummary',
                name: 'Combat Summary',
                category: 'Combat',
                module: Combat.combatSummary,
                async: false,
            },
            {
                key: 'combatDropLuck',
                name: 'Combat Drop Luck',
                category: 'Combat',
                // `.default` because the global is the module namespace — see
                // the note in libraries/combat.js
                module: Combat.combatDropLuck,
                async: false,
            },
            {
                key: 'combatDps',
                name: 'Combat DPS',
                category: 'Combat',
                module: Combat.combatDPS,
                async: false,
            },
            {
                key: 'portraitDps',
                name: 'Portrait DPS',
                category: 'Combat',
                module: Combat.portraitDps,
                async: false,
            },
            {
                key: 'partyProfileButton',
                name: 'Party Profile Button',
                category: 'Combat',
                module: Combat.partyProfileButton,
                async: false,
                customCheck: () => config.getSetting('combatProfileButton'),
            },
            { key: 'combatStats', name: 'Combat Stats', category: 'Combat', module: Combat.combatStats, async: false },
            {
                key: 'labyrinthTracker',
                name: 'Labyrinth Tracker',
                category: 'Combat',
                module: Combat.labyrinthTracker,
                async: false,
            },
            {
                key: 'labyrinthBestLevel',
                name: 'Labyrinth Best Level',
                category: 'Combat',
                module: Combat.labyrinthBestLevel,
                async: false,
            },
            {
                key: 'labyrinthShopPrices',
                name: 'Labyrinth Shop Prices',
                category: 'Combat',
                module: Combat.labyrinthShopPrices,
                async: false,
            },
            {
                key: 'labyrinthClearRate',
                name: 'Labyrinth Clear Rate',
                category: 'Combat',
                module: Combat.labyrinthClearRate,
                async: false,
            },
            {
                key: 'labyrinthRoomLogs',
                name: 'Labyrinth Room Logs',
                category: 'Combat',
                module: Combat.labyrinthRoomLogs,
                async: true,
            },
            {
                key: 'loadoutSnapshot',
                name: 'Loadout Snapshots',
                category: 'Combat',
                module: Combat.loadoutSnapshot,
                async: true,
            },
            {
                key: 'scrollSimulatorUI',
                name: 'Scroll Simulator UI',
                category: 'Combat',
                module: Combat.scrollSimulatorUI,
                async: false,
            },
            {
                key: 'combatSim',
                name: 'Combat Simulator',
                category: 'Combat',
                module: Combat.combatSim,
                async: false,
            },
            {
                key: 'labSim',
                name: 'Lab Simulator',
                category: 'Combat',
                module: Combat.labSim,
                async: false,
            },
        ];

        // UI Features
        const uiFeatures = [
            {
                key: 'equipmentLevelDisplay',
                name: 'Equipment Level Display',
                category: 'UI',
                module: UI.equipmentLevelDisplay,
                async: false,
            },
            {
                key: 'alchemyItemDimming',
                name: 'Alchemy Item Dimming',
                category: 'UI',
                module: UI.alchemyItemDimming,
                async: false,
            },
            {
                key: 'skillExperiencePercentage',
                name: 'Skill Experience Percentage',
                category: 'UI',
                module: UI.skillExperiencePercentage,
                async: false,
                // The percentage is read off the bar's inline width, so a bar
                // without one is not yet something the feature could have acted on
                healthCheck: () =>
                    injectedInto('[class*="NavigationBar_currentExperience"][style*="width"]', '.mwi-exp-percentage'),
            },
            { key: 'externalLinks', name: 'External Links', category: 'UI', module: UI.externalLinks, async: false },
            {
                key: 'hideLabyrinthBadge',
                name: 'Hide Labyrinth Badge',
                category: 'UI',
                module: UI.hideLabyrinthBadge,
                async: false,
            },
            {
                key: 'hideGuildBadge',
                name: 'Hide Guild Badge',
                category: 'UI',
                module: UI.hideGuildBadge,
                async: false,
            },
            {
                key: 'combatScale',
                name: 'Combat Panel Scale',
                category: 'UI',
                module: UI.combatPanelScale,
                async: false,
            },
            {
                key: 'welcomeBackValue',
                name: 'Welcome Back Value',
                category: 'UI',
                module: UI.welcomeBackValue,
                async: false,
            },
            {
                key: 'panelSizeMemory',
                name: 'Panel Size Memory',
                category: 'UI',
                module: UI.panelSizeMemory,
                async: true,
            },
            {
                key: 'tabReorder',
                name: 'Tab Reorder',
                category: 'UI',
                module: UI.tabReorder,
                async: true,
            },
            {
                key: 'overlayPanel',
                name: 'Overlay Panel',
                category: 'Interface',
                module: UI.overlayPanel,
                async: true,
            },
            {
                key: 'overlayTabButton',
                name: 'Overlay Tab Button',
                category: 'Interface',
                module: UI.overlayTabButton,
                async: false,
                // The button is a switch for the overlay and the module refuses to
                // draw one when the overlay itself is off
                healthCheck: () =>
                    whenSetting('overlayPanel', () => {
                        if (!findCharacterTabList()) return null;
                        return Boolean(document.getElementById('toolasha-overlay-tab'));
                    }),
            },
            {
                key: 'commandPalette',
                name: 'Command Palette',
                category: 'Interface',
                module: UI.commandPalette,
                async: false,
                // No entry in config's own feature map, so the schema switch is what
                // decides — without this the palette would be on regardless
                customCheck: () => config.getSetting('commandPalette'),
            },
            {
                key: 'draggableModals',
                name: 'Draggable Modals',
                category: 'UI',
                module: UI.draggableModals,
                async: true,
            },
            {
                key: 'altClickNavigation',
                name: 'Alt+Click Navigation',
                category: 'Navigation',
                module: UI.altClickNavigation,
                async: false,
            },
            {
                key: 'collectionNavigation',
                name: 'Collection Navigation',
                category: 'Navigation',
                module: UI.collectionNavigation,
                async: false,
            },
            {
                key: 'collectionFilters',
                name: 'Collection Filters',
                category: 'Collection',
                module: UI.collectionFilters,
                async: true,
                customCheck: () =>
                    config.isFeatureEnabled('collectionFilters') || config.isFeatureEnabled('collectionFavorites'),
            },
            { key: 'chatCommands', name: 'Chat Commands', category: 'Chat', module: UI.chatCommands, async: true },
            {
                key: 'chatProfileLink',
                name: 'Chat Profile Link',
                category: 'Chat',
                module: UI.chatProfileLink,
                async: false,
            },
            { key: 'mentionTracker', name: 'Mention Tracker', category: 'Chat', module: UI.mentionTracker, async: true },
            { key: 'popOutChat', name: 'Pop-Out Chat', category: 'Chat', module: UI.popOutChat, async: true },
            { key: 'chatBlockList', name: 'Chat Block List', category: 'Chat', module: UI.chatBlockList, async: false },
            {
                key: 'chatHistoryExtender',
                name: 'Chat History Extender',
                category: 'Chat',
                module: UI.chatHistoryExtender,
                async: false,
            },
            {
                key: 'taskProfitDisplay',
                name: 'Task Profit Display',
                category: 'Tasks',
                module: UI.taskProfitDisplay,
                async: false,
                customCheck: () =>
                    config.getSetting('taskProfitCalculator') ||
                    config.getSetting('taskGoMerge') ||
                    config.getSetting('taskQueuedIndicator') ||
                    config.getSetting('taskMaterialsIndicator') ||
                    config.getSetting('taskEfficiencyRating'),
            },
            {
                key: 'taskRerollTracker',
                name: 'Task Reroll Tracker',
                category: 'Tasks',
                module: UI.taskRerollTracker,
                async: false,
            },
            { key: 'taskSorter', name: 'Task Sorter', category: 'Tasks', module: UI.taskSorter, async: false },
            {
                key: 'taskIcons',
                name: 'Task Icons',
                category: 'Tasks',
                module: UI.taskIcons,
                async: false,
                // The attribute rather than `.mwi-task-icon`: it is stamped on every
                // card the feature has looked at, whereas an icon depends on a sprite
                // resolving, and a missing sprite is a different complaint
                healthCheck: () =>
                    injectedInto(
                        '[class*="TasksPanel_taskList"] [class*="RandomTask_randomTask"]',
                        '[class*="RandomTask_randomTask"][data-mwi-task-processed]'
                    ),
            },
            {
                key: 'taskInventoryHighlighter',
                name: 'Task Inventory Highlighter',
                category: 'Tasks',
                module: UI.taskInventoryHighlighter,
                async: false,
            },
            {
                key: 'taskStatistics',
                name: 'Task Statistics',
                category: 'Tasks',
                module: UI.taskStatistics,
                async: false,
                healthCheck: () =>
                    injectedInto(
                        '[class*="TasksPanel_tabsComponentContainer"] [class*="TabsComponent_tabsContainer"]',
                        '.toolasha-task-stats-btn'
                    ),
            },
            {
                key: 'taskClaimCollector',
                name: 'Task Claim Collector',
                category: 'Tasks',
                module: UI.taskClaimCollector,
                async: false,
            },
            {
                key: 'taskRerollProtection',
                name: 'Task Reroll Protection',
                category: 'Tasks',
                module: UI.taskRerollProtection,
                async: true,
            },
            {
                key: 'taskAutoReroll',
                name: 'Task Auto-Reroll Reminder',
                category: 'Tasks',
                module: UI.taskAutoReroll,
                async: true,
            },
            {
                key: 'skillRemainingXP',
                name: 'Remaining XP',
                category: 'Skills',
                module: UI.remainingXP,
                async: false,
                // Needs a nav entry that both has an XP bar and names its skill —
                // the name is what the remaining figure is computed from
                healthCheck: () => {
                    const bars = [...document.querySelectorAll('[class*="NavigationBar_currentExperience"]')];
                    const named = bars.some((bar) =>
                        bar.closest('[class*="NavigationBar_nav"]')?.querySelector('[class*="NavigationBar_label"]')
                    );
                    if (!named) return null;
                    return Boolean(document.querySelector('.mwi-remaining-xp'));
                },
            },
            { key: 'xpTracker', name: 'XP/hr Tracker', category: 'Skills', module: UI.xpTracker, async: false },
            {
                key: 'housePanelObserver',
                name: 'House Panel Observer',
                category: 'House',
                module: UI.housePanelObserver,
                async: true,
            },
            {
                key: 'transmuteRates',
                name: 'Transmute Rates',
                category: 'Dictionary',
                module: UI.transmuteRates,
                async: false,
            },
            {
                key: 'alchemy_transmuteHistory',
                name: 'Transmute History Tracker',
                category: 'Alchemy',
                module: UI.transmuteHistoryTracker,
                async: false,
            },
            {
                key: 'alchemy_transmuteHistoryViewer',
                name: 'Transmute History Viewer',
                category: 'Alchemy',
                module: UI.transmuteHistoryViewer,
                async: false,
            },
            {
                key: 'alchemy_coinifyHistory',
                name: 'Coinify History Tracker',
                category: 'Alchemy',
                module: UI.coinifyHistoryTracker,
                async: false,
            },
            {
                key: 'alchemy_coinifyHistoryViewer',
                name: 'Coinify History Viewer',
                category: 'Alchemy',
                module: UI.coinifyHistoryViewer,
                async: false,
            },
            {
                key: 'alchemy_decomposeHistory',
                name: 'Decompose History Tracker',
                category: 'Alchemy',
                module: UI.decomposeHistoryTracker,
                async: false,
            },
            {
                key: 'alchemy_decomposeHistoryViewer',
                name: 'Decompose History Viewer',
                category: 'Alchemy',
                module: UI.decomposeHistoryViewer,
                async: false,
            },
            {
                key: 'alchemy_actionProtection',
                name: 'Alchemy Action Protection',
                category: 'Alchemy',
                module: UI.alchemyActionProtection,
                async: true,
            },
            {
                key: 'enhancementFeature',
                name: 'Enhancement Tracker',
                category: 'Enhancement',
                module: UI.enhancementFeature,
                async: false,
            },
            {
                key: 'enhancementXPH',
                name: 'Enhancement XPH Calculator',
                category: 'Enhancement',
                module: UI.xphCalculator,
                async: false,
            },
            {
                key: 'guildXPTracker',
                name: 'Guild XP Tracker',
                category: 'Guild',
                module: Combat.guildXPTracker,
                async: false,
            },
            {
                key: 'guildXPDisplay',
                name: 'Guild XP Display',
                category: 'Guild',
                module: Combat.guildXPDisplay,
                async: false,
            },
            {
                key: 'guildCreditValue',
                name: 'Guild Credit Value',
                category: 'Guild',
                module: Combat.guildCreditValue,
                async: false,
            },
            {
                key: 'guildRoster',
                name: 'Guild Roster',
                category: 'Guild',
                module: Combat.guildRosterView,
                async: false,
            },
            {
                key: 'guildTrialsInfo',
                name: 'Guild Trials',
                category: 'Guild',
                module: Combat.guildTrials,
                async: true,
            },
            {
                key: 'insights_calibration',
                name: 'Prediction Calibration',
                category: 'Insights',
                module: UI.predictionCalibration,
                async: true,
            },
            {
                key: 'leaderboardXPTracker',
                name: 'Leaderboard XP Tracker',
                category: 'Leaderboard',
                module: UI.leaderboardXPTracker,
                async: false,
            },
            {
                key: 'leaderboardXPDisplay',
                name: 'Leaderboard XP Display',
                category: 'Leaderboard',
                module: UI.leaderboardXPDisplay,
                async: false,
            },
            {
                key: 'emptyQueueNotification',
                name: 'Empty Queue Notification',
                category: 'Notifications',
                module: UI.emptyQueueNotification,
                async: true,
            },
            {
                key: 'communityBuffAlerts',
                name: 'Community Buff Expiry Alerts',
                category: 'Notifications',
                module: UI.communityBuffAlerts,
                async: true,
                // No entry in config's feature map, so the schema setting is the
                // only gate — an unknown registry key would otherwise default to on
                customCheck: () => config.getSetting('notifications_communityBuffExpiring'),
            },
            {
                key: 'labyrinthRunAlerts',
                name: 'Labyrinth Run Finished Alerts',
                category: 'Notifications',
                module: UI.labyrinthRunAlerts,
                async: true,
                // As above: no feature-map entry, so the schema setting is the only
                // gate and an unknown registry key would otherwise default to on
                customCheck: () => config.getSetting('notifications_labyrinthRunFinished'),
            },
            {
                key: 'labyrinthEntryAlerts',
                name: 'Labyrinth Entry Alerts',
                category: 'Notifications',
                module: UI.labyrinthEntryAlerts,
                async: true,
                // Schema setting is the only gate; no feature-map entry.
                customCheck: () => config.getSetting('notifications_labyrinthEntryAvailable'),
            },
            {
                key: 'combatDeathAlerts',
                name: 'Combat Death Alerts',
                category: 'Notifications',
                module: UI.combatDeathAlerts,
                async: true,
                customCheck: () => config.getSetting('notifications_combatDeath'),
            },
            {
                key: 'marketUndercutAlerts',
                name: 'Market Undercut Alerts',
                category: 'Notifications',
                module: UI.marketUndercutAlerts,
                async: true,
                customCheck: () => config.getSetting('notifications_marketListingUndercut'),
            },
            {
                key: 'enhancementTargetAlerts',
                name: 'Enhancement Target Alerts',
                category: 'Notifications',
                module: UI.enhancementTargetAlerts,
                async: true,
                customCheck: () => config.getSetting('notifications_enhancementTarget'),
            },
            {
                key: 'taskSlotAlerts',
                name: 'Task Slot Alerts',
                category: 'Notifications',
                module: UI.taskSlotAlerts,
                async: true,
                customCheck: () => config.getSetting('notifications_taskSlotsFull'),
            },
            {
                key: 'queueMonitor',
                name: 'Queue Monitor',
                category: 'General',
                module: UI.queueMonitor,
                async: false,
            },
            {
                // Registry key stays ironCowFarm (persisted enable/disable state);
                // the display name is "Iron Bell Farming".
                key: 'ironCowFarm',
                name: 'Iron Bell Farming',
                category: 'General',
                module: UI.ironCowFarmPanel,
                async: true,
            },
            {
                key: 'accountView',
                name: 'Account View',
                category: 'General',
                module: UI.accountView,
                async: true,
                // No entry in settings-schema yet, so `getSetting`'s own default is
                // what decides — an unknown key returns whatever is passed here
                customCheck: () => config.getSetting('accountView', true),
            },
        ];

        // Combine all features
        const allFeatures = [...marketFeatures, ...actionsFeatures, ...combatFeatures, ...uiFeatures];

        // Convert to feature registry format
        const features = allFeatures.map((feature) => {
            // Modules may export either disable() or cleanup() as their teardown;
            // some cleanup(instance) implementations expect the instance returned by initialize().
            const teardown =
                typeof feature.module.disable === 'function'
                    ? (instance) => feature.module.disable(instance)
                    : typeof feature.module.cleanup === 'function'
                      ? (instance) => feature.module.cleanup(instance)
                      : undefined;
            let instance = null;
            return {
                key: feature.key,
                name: feature.name,
                category: feature.category,
                // Always await: modules whose initialize() is async but were
                // registered without the async flag would otherwise store a
                // pending Promise as the instance and escape error handling
                initialize: async () => {
                    instance = await feature.module.initialize();
                },
                disable: teardown
                    ? () => {
                          const current = instance;
                          instance = null;
                          return teardown(current);
                      }
                    : undefined,
                async: feature.async,
                customCheck: feature.customCheck || undefined,
                // Without this the checks above would be dropped on the way into the
                // registry, and `checkFeatureHealth` would go on finding nothing
                healthCheck: feature.healthCheck || undefined,
            };
        });

        // Replace feature registry's features array
        featureRegistry.replaceFeatures(features);
    }

    if (isCombatSimulatorPage()) {
        // Initialize combat sim integration only
        Combat.combatSimIntegration.initialize();

        // Skip all other initialization
    } else {
        // CRITICAL: Install WebSocket hook FIRST, before game connects
        webSocketHook.install();

        // CRITICAL: Start centralized DOM observer SECOND, before features initialize
        domObserver.start();

        // Set up scroll listener to dismiss stuck tooltips
        setupScrollTooltipDismissal();

        // Initialize network alert (must be early, before market features)
        Market.networkAlert.initialize();

        // Start capturing client data from localStorage (for Combat Sim export)
        webSocketHook.captureClientDataFromLocalStorage();

        performanceMonitor.mark('script:start');

        // Register all features from libraries
        registerFeatures();

        // Initialize action panel observer (special case - not a regular feature)
        Actions.initActionPanelObserver();

        // Initialize storage and config THIRD (async)
        // Store the promise so character_initialized can wait for storage readiness
        const storageReady = (async () => {
            try {
                // Initialize storage (opens IndexedDB)
                await storage.initialize();
                performanceMonitor.mark('storage:open');

                // Initialize config (loads settings from storage)
                await config.initialize();
                performanceMonitor.mark('config:loaded');

                // Add beforeunload handler to flush all pending writes
                window.addEventListener('beforeunload', () => {
                    storage.flushAll();
                });

                // Initialize Data Manager immediately
                // Don't wait for localStorageUtil - it handles missing data gracefully
                dataManager.initialize();
            } catch (error) {
                console.error('[Toolasha] Storage/config initialization failed:', error);
                // Initialize anyway
                dataManager.initialize();
            }
        })();

        // Setup character switch handler once (NOT inside character_initialized listener)
        featureRegistry.setupCharacterSwitchHandler();

        dataManager.on('character_initialized', (_data) => {
            performanceMonitor.mark('character:data');
            // Skip full initialization during character switches
            // The character_switched handler in feature-registry already handles reinitialization
            if (_data._isCharacterSwitch) {
                return;
            }

            // Initialize all features using the feature registry
            setTimeout(async () => {
                try {
                    // Ensure storage/config are initialized before loading character settings
                    // On Steam, character data can arrive before IndexedDB is open
                    await storageReady;

                    // Reload config settings with character-specific data
                    await config.loadSettings();
                    config.applyColorSettings();
                    performanceMonitor.mark('settings:character');

                    // Before features initialise: the conservative-defaults policy
                    // has to turn a new switch off before anything reads it — a
                    // feature switched off after startup has already run once
                    await UI.whatsNew.applyPolicy();

                    // Initialize scroll simulator storage (character-specific)
                    await Combat.scrollSimulator.initialize().catch((error) => {
                        console.error('[Toolasha] Scroll simulator initialization failed:', error);
                    });

                    // Initialize Settings UI after character data is loaded
                    await UI.settingsUI.initialize().catch((error) => {
                        console.error('[Toolasha] Settings UI initialization failed:', error);
                    });

                    const initFailures = await featureRegistry.initializeFeatures();
                    performanceMonitor.mark('startup:complete');

                    // Offer a full backup before the What's New popup can change any
                    // settings, so a first-time fork user keeps a restore point of
                    // their pre-fork state. Awaited so the two popups never overlap.
                    await UI.forkBackupPrompt.maybeShow();

                    UI.whatsNew.maybeShow();

                    // Health check after initialization
                    setTimeout(async () => {
                        const failedFeatures = mergeFailures(initFailures, featureRegistry.checkFeatureHealth());

                        // Note: Settings tab health check removed - tab only appears when user opens settings panel

                        // Selector canary: runs regardless of whether any single feature
                        // reported unhealthy, because a game update can rename every
                        // class at once without a single per-feature check noticing —
                        // each one's anchor is just "not open," which reads as null.
                        //
                        // The schema canary is the same argument one layer down: the
                        // script hardcodes the game's own data keys and hrids, and a
                        // renamed one produces empty maps and null lookups rather
                        // than an error. Both are reported together — two toasts
                        // about the same game update is one toast too many.
                        const canaryFailures = [...checkAnchorCanaries(), ...UI.schemaCanary.runSchemaCanary()];
                        if (canaryFailures.length > 0) {
                            console.warn(
                                '[Toolasha] Canary found missing anchors or game data — the game may have updated:',
                                canaryFailures.map((f) => f.name)
                            );
                            UI.healthStatus.reportFailures(canaryFailures);
                        }

                        if (failedFeatures.length > 0) {
                            console.warn(
                                '[Toolasha] Health check found failed features:',
                                failedFeatures.map((f) => f.name)
                            );

                            setTimeout(async () => {
                                // What the retry could not fix, plus whatever the
                                // second health pass still objects to. A feature that
                                // came up on the second attempt — usually because the
                                // panel it anchors to had not been drawn yet — is not
                                // worth interrupting anybody about.
                                const retryFailures = await featureRegistry.retryFailedFeatures(failedFeatures);
                                const stillFailed = mergeFailures(retryFailures, featureRegistry.checkFeatureHealth());

                                if (stillFailed.length > 0) {
                                    console.warn(
                                        '[Toolasha] These features could not initialize:',
                                        stillFailed.map((f) => f.name)
                                    );
                                    console.warn(
                                        '[Toolasha] Try refreshing the page or reopening the relevant game panels'
                                    );
                                    UI.healthStatus.reportFailures(stillFailed);
                                }
                            }, 1000);
                        }
                    }, 500); // Wait 500ms after initialization to check health
                } catch (error) {
                    // Nothing below this point ran, so the console was the only place
                    // that said so — and a script that silently did not start is
                    // indistinguishable from one that was never installed
                    console.error('[Toolasha] Feature initialization failed:', error);
                    showToast(`Toolasha failed to start: ${error.message}`, {
                        kind: 'error',
                        duration: 0,
                        action: {
                            label: 'Diagnostics',
                            onClick: () =>
                                UI.healthStatus.showHealthStatus([
                                    {
                                        key: 'startup',
                                        name: 'Toolasha startup',
                                        reason: error.message || String(error),
                                    },
                                ]),
                        },
                    });
                }
            }, 100);
        });

        // Expose minimal user-facing API
        const targetWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

        targetWindow.Toolasha.version = '3.3.0';
        // Which fork this build came from. Version numbers are shared with
        // upstream, so the what's-new popup keys on the (fork, version) pair —
        // the same number on a different fork is still an update.
        targetWindow.Toolasha.fork = 'Millennium44/Toolasha';

        // Feature toggle API (for users to manage settings via console)
        targetWindow.Toolasha.features = {
            list: () => config.getFeaturesByCategory(),
            enable: (key) => config.setFeatureEnabled(key, true),
            disable: (key) => config.setFeatureEnabled(key, false),
            toggle: (key) => config.toggleFeature(key),
            status: (key) => config.isFeatureEnabled(key),
            info: (key) => config.getFeatureInfo(key),
        };

        // Guild XP data management
        targetWindow.Toolasha.guild = {
            resetMemberXP: () => Combat.guildXPTracker.resetMemberData(),
            memberSample: (name) => Combat.guildXPTracker.getRawMemberSample(name),
        };

        // The per-player trial panel, so the command palette can reach it the way it
        // reaches every other panel — through the page rather than through an import
        targetWindow.Toolasha.guildTrialScoreboard = Combat.guildTrialScoreboard;

        // Debug utilities (for diagnosing issues via console)
        targetWindow.Toolasha.debug = {
            storage: () => {
                const diag = storage.diagnostics();
                console.log('=== Storage Diagnostics ===');
                console.log('DB connection exists:', diag.dbExists);
                console.log('Storage available:', diag.available);
                console.log('DB name:', diag.dbName);
                console.log('DB version:', diag.dbVersion);
                console.log('Reconnecting:', diag.reconnecting);
                console.log('Last null reason:', diag.lastNullReason || 'never');
                console.log('Pending writes:', diag.pendingWrites);
                console.log('Active timers:', diag.activeTimers);
                return diag;
            },
            // The selector canary, callable directly for a spot-check without
            // waiting for the delayed health pass to run it on its own.
            canary: checkAnchorCanaries,
            // The same, for the shape of the game data rather than the page
            schema: () => UI.schemaCanary.runSchemaCanary(),
            // The health report on demand, rather than only when a startup toast
            // leads to it. Assembles the failures the delayed pass would — minus the
            // startup-only init failures, which are not available once the page is
            // running — refreshes the storage numbers so the report is current,
            // logs it so it is copyable straight from the console, and opens the
            // panel with its Copy button. Returns the report text, or null on error.
            health: async () => {
                try {
                    const failures = mergeFailures(featureRegistry.checkFeatureHealth(), [
                        ...checkAnchorCanaries(),
                        ...UI.schemaCanary.runSchemaCanary(),
                    ]);
                    await UI.healthStatus.refreshStorageFacts();
                    const report = UI.healthStatus.buildDiagnosticReport(failures);
                    console.log(report);
                    UI.healthStatus.showHealthStatus(failures);
                    return report;
                } catch (error) {
                    console.error('[Toolasha] Building the health report failed:', error);
                    return null;
                }
            },
        };
    }

})();
