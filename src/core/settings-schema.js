/**
 * Settings Configuration
 * Organizes all script settings into logical groups for the settings UI
 */

import { loadoutSnapshot } from '../utils/bundle-bridge.js';
import { isTestServer } from '../utils/game-server.js';

/**
 * `needsPrices: true` on a setting means the feature shows market prices or is not worth having without a price
 * feed (a priced tooltip, a profit figure, a listing tool, a value tracker). Declare it next to the setting and the
 * rest follows: Essentials must hold none, every default-on one must be in the Market preset (or on LEFT_OUT), and
 * Iron Cow mode must either lock it (IRON_COW_SETTINGS) or record that it leaves it alone
 * (IRON_COW_UNLOCKED_PRICED). Leave it off a setting that merely reads a price as an optional input.
 */
export const settingsGroups = {
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
        title: 'General Settings',
        icon: '⚙️',
        settings: {
            whatsNew_showPopup: {
                id: 'whatsNew_showPopup',
                label: "Show what's new after an update",
                type: 'checkbox',
                default: true,
                help:
                    'Once per new version, shows what changed and lists any new settings with live switches — ' +
                    'so an update never quietly rearranges things.',
            },
            whatsNew_newDefaultsOff: {
                id: 'whatsNew_newDefaultsOff',
                label: 'New settings start turned off',
                type: 'checkbox',
                default: false,
                help:
                    'When an update introduces a new on-by-default switch, keep it off until you turn it on ' +
                    'yourself. Numbers and dropdowns keep their defaults — only behavior switches are held back.',
            },
            mobileMode: {
                id: 'mobileMode',
                label: 'Mobile mode',
                type: 'select',
                default: 'auto',
                options: [
                    { value: 'auto', label: 'Auto-detect' },
                    { value: 'on', label: 'On' },
                    { value: 'off', label: 'Off' },
                ],
                help:
                    'Adjusts for touch screens: bigger resize grips, panels sized to the viewport. Auto-detect keys ' +
                    'on whether the primary pointer is a finger, which a touchscreen laptop can override here.',
            },
            chatCommands: {
                id: 'chatCommands',
                label: 'Enable chat commands (/item, /wiki, /market, /shrines)',
                type: 'checkbox',
                default: true,
                help: 'Type /item, /wiki, or /market followed by an item name in chat (/shrines takes no name). Example: /item radiant fiber',
                requiresRefresh: true,
            },
            chat_mentionTracker: {
                id: 'chat_mentionTracker',
                label: 'Show badge when mentioned in chat',
                type: 'checkbox',
                default: true,
                help: 'Displays a red badge on chat tabs when someone @mentions you',
            },
            chat_profileLink: {
                id: 'chat_profileLink',
                label: 'Chat: Clickable names in announcements',
                type: 'checkbox',
                default: true,
                help: 'Makes the player name in system announcements (e.g. "PlayerName has reached level 150 Magic!" or "PlayerName has joined the guild!") clickable — clicking it opens their profile (or sends "/profile name" in chat if the profile view is unavailable).',
            },
            chat_popOut: {
                id: 'chat_popOut',
                label: 'Enable Pop-out Chat Window button',
                type: 'checkbox',
                default: true,
                help: 'Adds a button to the chat panel to open chat in a separate browser window with multi-channel split view',
            },
            chatHistoryExtender: {
                id: 'chatHistoryExtender',
                label: 'Chat: Extend chat history',
                type: 'checkbox',
                default: true,
                help: 'Preserves messages that the game removes from the live buffer, keeping them visible above the live chat',
                requiresRefresh: true,
            },
            chatHistoryExtender_maxHistory: {
                id: 'chatHistoryExtender_maxHistory',
                label: 'Chat: Max messages to retain per tab',
                type: 'text',
                default: '150',
                requires: 'chatHistoryExtender',
            },
            chat_24hrTimestamps: {
                id: 'chat_24hrTimestamps',
                label: 'Chat: Reformat message timestamps',
                type: 'checkbox',
                default: false,
                help: 'Rewrites chat message timestamps using your Market date/time format settings (24-hour or 12-hour, MM-DD or DD-MM) instead of the browser default',
            },
            altClickNavigation: {
                id: 'altClickNavigation',
                label: 'Alt+click items to navigate to crafting/gathering or dictionary',
                type: 'checkbox',
                default: true,
                help: 'Hold Alt/Option and click any item to navigate to its crafting/gathering page, or item dictionary if not craftable',
            },
            tokenShopShortcuts: {
                id: 'tokenShopShortcuts',
                label: 'Add shop buttons to token item menus',
                type: 'checkbox',
                default: true,
                help: 'Adds a View Shop button to the item menu of dungeon, Labyrinth, task and guild tokens (and guild credits), like the Cowbell Store button on Cowbells',
            },
            collectionNavigation: {
                id: 'collectionNavigation',
                label: 'Add navigation buttons to collection items',
                type: 'checkbox',
                default: true,
                help: 'Adds View Action and Item Dictionary buttons when clicking collection items',
            },
            queueMonitor: {
                id: 'queueMonitor',
                label: 'Cross-character queue monitor',
                type: 'checkbox',
                default: false,
                help: 'Shows estimated queue time remaining for your other characters in a floating widget',
            },
            characterSelect_activityStatus: {
                id: 'characterSelect_activityStatus',
                label: 'Character select: Show activity status',
                type: 'checkbox',
                default: true,
                help: 'On the character-select screen, shows what each character is expected to be doing and the earliest point it may need attention (action or queue end, materials, or offline cap)',
            },
            startupRecovery_autoReload: {
                id: 'startupRecovery_autoReload',
                label: 'Recover by itself when Toolasha misses the login data',
                type: 'checkbox',
                default: false,
                help:
                    'The game sometimes sends your character data before Toolasha is listening, leaving panels empty. ' +
                    'Off, you get a Reload notice. On, the connection is dropped about five seconds in and the game ' +
                    'reopens it, keeping what you typed. The page reloads only if that fails, and a broken page still ' +
                    'asks.',
            },
            takeoverAutoReload: {
                id: 'takeoverAutoReload',
                label: 'Reload by itself after the game was opened elsewhere',
                type: 'select',
                default: 'off',
                options: [
                    { value: 'off', label: 'Off' },
                    { value: '5', label: 'After 5 minutes' },
                    { value: '10', label: 'After 10 minutes' },
                    { value: '15', label: 'After 15 minutes (recommended)' },
                    { value: '30', label: 'After 30 minutes' },
                    { value: '60', label: 'After 60 minutes' },
                ],
                help:
                    'When this tab is disconnected because the game opened elsewhere, it waits the chosen time, then ' +
                    'reloads to take the character back. A notice has Reload now and Cancel. It never reloads while ' +
                    'you use the page. If two tabs keep taking it back, each wait doubles and it stops after 3 ' +
                    'reloads.',
            },
            reloadLog_enabled: {
                id: 'reloadLog_enabled',
                label: 'Keep a log of reload prompts',
                type: 'checkbox',
                default: false,
                help:
                    'Logs one line on this device each time Toolasha asks you to reload: when, what asked, and how it ' +
                    'ended. Nothing is sent anywhere or synced. Settings > Diagnostics has Copy reload log and Clear ' +
                    'reload log. The last 200 prompts are kept.',
            },
            dataChangeAutoReload: {
                id: 'dataChangeAutoReload',
                label: 'Reload automatically when data changes underneath you',
                type: 'select',
                default: 'off',
                options: [
                    { value: 'off', label: 'Off' },
                    { value: '30', label: 'After 30 seconds' },
                    { value: '60', label: 'After 60 seconds' },
                    { value: '120', label: 'After 2 minutes' },
                ],
                help:
                    'After a sync pull or backup restore, stored records refuse saves until a reload. On, a notice ' +
                    'counts down with Cancel, then reloads once pending saves are written. A click, key or scroll ' +
                    'makes it an offer; a sim, focused text box or sync delays it. Stops after 3 automatic reloads ' +
                    'within 10 minutes.',
            },
            // Toggled by the PFormance panel's header button, never listed as a row. It
            // has to exist here: the config store only writes keys the schema declares,
            // so without this the button's choice was silently dropped.
            pformanceAttribution: {
                id: 'pformanceAttribution',
                label: 'Performance attribution extras',
                type: 'checkbox',
                default: false,
                hidden: true,
                help: 'Extra diagnostics in the Performance panel: stall attribution, leak canary, heap trend, Tampermonkey traffic and the all-tabs list.',
            },
        },
    },

    actionBar: {
        title: 'Action Bar',
        icon: '⚡',
        settings: {
            actionBar_enabled: {
                id: 'actionBar_enabled',
                label: 'Action bar: Enable action bar display',
                type: 'checkbox',
                default: true,
            },
            actionBar_compactWidth: {
                id: 'actionBar_compactWidth',
                label: 'Action bar: Compact width (800px limit)',
                type: 'checkbox',
                default: false,
                help: 'Limits action bar width to 800px and clips instead of wrapping. Useful for wide monitors. Always on in mobile mode, where clipping the long stats line keeps it from overflowing the narrow header.',
            },
            actionBar_showQueueCount: {
                id: 'actionBar_showQueueCount',
                label: 'Action bar: Queue/remaining count',
                type: 'checkbox',
                default: true,
            },
            actionBar_showActionDuration: {
                id: 'actionBar_showActionDuration',
                label: 'Action bar: Time per action (e.g. 14.94s/action)',
                type: 'checkbox',
                default: true,
            },
            actionBar_showActionsPerHour: {
                id: 'actionBar_showActionsPerHour',
                label: 'Action bar: Actions/hr and items/hr',
                type: 'checkbox',
                default: true,
            },
            actionBar_showTimeRemaining: {
                id: 'actionBar_showTimeRemaining',
                label: 'Action bar: Time remaining display',
                type: 'select',
                default: 'both',
                options: [
                    { value: 'both', label: 'Time remaining and completion ETA' },
                    { value: 'relative', label: 'Time remaining only' },
                    { value: 'absolute', label: 'Completion ETA only' },
                    { value: 'none', label: 'Neither' },
                ],
            },
            actionBar_showRecycleTime: {
                id: 'actionBar_showRecycleTime',
                label: 'Action bar: Transmute recycle time estimate',
                type: 'checkbox',
                default: true,
                help: 'Shows estimated total time accounting for self-return recycling during transmute actions',
            },
            actionBar_showProfit: {
                id: 'actionBar_showProfit',
                label: 'Action bar: Show current action profit',
                type: 'checkbox',
                default: false,
                help: 'Displays profit/hr and remaining profit for the current action (gathering and production)',
            },
            actionPanel_liveCountdown: {
                id: 'actionPanel_liveCountdown',
                label: 'Action bar: Live countdown timer',
                type: 'checkbox',
                default: false,
                help: 'Replaces the static time display on the action progress bar with a live countdown in seconds',
            },
            actionTiming_monitor: {
                id: 'actionTiming_monitor',
                label: 'Action bar: Timing diagnostic',
                type: 'checkbox',
                default: false,
                help: 'Diagnostic. Measures how long each action really takes from the progress bar animation and records the ones where the bar finishes early and then sits full. Read the results with Toolasha.Debug.actionTimingReport() in the browser console.',
            },
        },
    },

    skillPageTiles: {
        title: 'Skill Page & Tiles',
        icon: '🗃️',
        settings: {
            actionPanel_showFilter: {
                id: 'actionPanel_showFilter',
                label: 'Skill page: Filter actions input',
                type: 'checkbox',
                default: true,
            },
            actionPanel_showSort: {
                id: 'actionPanel_showSort',
                label: 'Skill page: Sort button',
                type: 'checkbox',
                default: true,
            },
            actionPanel_showPricingMode: {
                id: 'actionPanel_showPricingMode',
                needsPrices: true,
                label: 'Skill page: Pricing mode button',
                type: 'checkbox',
                default: true,
            },
            actionPanel_showCraftToggle: {
                id: 'actionPanel_showCraftToggle',
                needsPrices: true,
                label: 'Skill page: Craft toggle button',
                type: 'checkbox',
                default: true,
            },
            actionPanel_showSellTaxToggle: {
                id: 'actionPanel_showSellTaxToggle',
                needsPrices: true,
                label: 'Skill page: Sell tax toggle button',
                type: 'checkbox',
                default: false,
                help: 'Adds a Tax button to the skill page that flips "Profit: Exclude sell tax (producing for personal use)" without opening Settings. Off by default.',
            },
            market_showPricingControls: {
                id: 'market_showPricingControls',
                label: 'Marketplace page: Pricing dropdowns and Craft toggle',
                type: 'checkbox',
                default: false,
                help:
                    'Adds the Buy and Sell pricing dropdowns and the Craft toggle next to the Marketplace title, so you ' +
                    'can change how item tooltips are priced without opening a skill page. They change the same settings ' +
                    'as the skill-page controls.',
            },
            actionPanel_showProfitPerHour_gathering: {
                id: 'actionPanel_showProfitPerHour_gathering',
                needsPrices: true,
                label: 'Action page: Show profit/hr on gathering tiles',
                type: 'checkbox',
                default: true,
                help: 'Displays profit/hr on gathering action tiles (Foraging, Woodcutting, etc.)',
            },
            actionPanel_showProfitPerHour_production: {
                id: 'actionPanel_showProfitPerHour_production',
                needsPrices: true,
                label: 'Action page: Show profit/hr on production tiles',
                type: 'checkbox',
                default: true,
                help: 'Displays profit/hr on production action tiles (Crafting, Tailoring, etc.)',
            },
            actionPanel_showExpPerHour_gathering: {
                id: 'actionPanel_showExpPerHour_gathering',
                label: 'Action page: Show exp/hr on gathering tiles',
                type: 'checkbox',
                default: true,
                help: 'Displays exp/hr on gathering action tiles (Foraging, Woodcutting, etc.)',
            },
            actionPanel_showExpPerHour_production: {
                id: 'actionPanel_showExpPerHour_production',
                label: 'Action page: Show exp/hr on production tiles',
                type: 'checkbox',
                default: true,
                help: 'Displays exp/hr on production action tiles (Crafting, Tailoring, etc.)',
            },
            actionPanel_hideNegativeProfit: {
                id: 'actionPanel_hideNegativeProfit',
                needsPrices: true,
                label: 'Action panel: Hide actions with negative profit',
                type: 'checkbox',
                default: false,
                help: 'Hides action panels that would result in a loss (negative profit/hr)',
            },
            inventoryCountDisplay: {
                id: 'inventoryCountDisplay',
                label: 'Action panels: Show current inventory count of output item',
                type: 'checkbox',
                default: true,
                help: 'Shows how many of the output item you currently own, on action tiles and in the action detail panel',
            },
            actions_pinnedPage: {
                id: 'actions_pinnedPage',
                label: 'Pinned actions: Enable pinned actions page and pin icons',
                type: 'checkbox',
                default: true,
                help: 'Adds a Pinned button to the left nav bar showing all pinned actions, and shows pin icons on action tiles.',
            },
        },
    },

    actionPanel: {
        title: 'Action Panel',
        icon: '📄',
        settings: {
            actionPanel_totalTime_quickInputs: {
                id: 'actionPanel_totalTime_quickInputs',
                label: 'Action panel: Quick input buttons (hours, count presets, Max)',
                type: 'checkbox',
                default: true,
                requiresRefresh: true,
            },
            actionPanel_quickInputs_countPresets: {
                id: 'actionPanel_quickInputs_countPresets',
                label: 'Action panel: Custom count presets (comma-separated, e.g. 100,1000,1000000)',
                type: 'text',
                default: '',
            },
            actionPanel_quickInputs_hourPresets: {
                id: 'actionPanel_quickInputs_hourPresets',
                label: 'Action panel: Custom hour presets (comma-separated, e.g. 0.5,1,24,168,720)',
                type: 'text',
                default: '',
            },
            actionPanel_foragingTotal: {
                id: 'actionPanel_foragingTotal',
                needsPrices: true,
                label: 'Action panel: Overall profit for multi-outcome foraging',
                type: 'checkbox',
                default: true,
            },
            actionPanel_outputTotals: {
                id: 'actionPanel_outputTotals',
                label: 'Action panel: Show total expected outputs below per-action outputs',
                type: 'checkbox',
                default: true,
                help: 'Displays calculated totals when you enter a quantity in the action input',
            },
            actionPanel_maxProduceable: {
                id: 'actionPanel_maxProduceable',
                label: 'Action panel: Show max produceable count on crafting actions',
                type: 'checkbox',
                default: true,
                help: 'Displays how many items you can make based on current inventory',
            },
            actionPanel_showProfitDetail: {
                id: 'actionPanel_showProfitDetail',
                needsPrices: true,
                label: 'Action panel: Show profitability detail',
                type: 'checkbox',
                default: true,
                help: 'Displays the profitability breakdown section inside gathering, production, and alchemy action panels',
            },
            actionPanel_showLevelProgress: {
                id: 'actionPanel_showLevelProgress',
                label: 'Action panel: Show level progress',
                type: 'checkbox',
                default: true,
                requiresRefresh: true,
                help: 'Displays XP and level progress estimates inside action panels',
            },
            actionPanel_showSpeedTime: {
                id: 'actionPanel_showSpeedTime',
                label: 'Action panel: Show action speed & time',
                type: 'checkbox',
                default: true,
                requiresRefresh: true,
                help: 'Displays speed breakdown, efficiency, and total time inside action panels',
            },
            requiredMaterials: {
                id: 'requiredMaterials',
                label: 'Action panel: Show total required and missing materials',
                type: 'checkbox',
                default: true,
                help: 'Displays total materials needed and shortfall when entering quantity',
            },
            teaRecommendation_xpFloor: {
                id: 'teaRecommendation_xpFloor',
                needsPrices: true,
                label: 'Tea recommendation: Show an "almost as fast" choice',
                type: 'checkbox',
                default: true,
                help:
                    'On a single-action tea recommendation (or Alchemy popup), adds the setup with the best gold/hr ' +
                    'that keeps a set share of top XP/hr, and states the XP given up and gold/hr gained. Pinned and ' +
                    'banned teas apply in single-goal popups. Alchemy Both shows the unconstrained pick. Unpriced ' +
                    'items are marked.',
            },
            teaRecommendation_xpFloorPercent: {
                id: 'teaRecommendation_xpFloorPercent',
                label: 'Tea recommendation: Share of top XP/hr to keep (%)',
                type: 'number',
                default: 95,
                min: 50,
                max: 100,
                requires: 'teaRecommendation_xpFloor',
                help: '95 keeps at least 95% of the best XP/hr and picks the highest gold/hr among the setups that qualify (setups resting on an unpriced item or tea are passed over while a fully priced one qualifies). 100 only accepts setups as fast as the top one.',
            },
            actionPanel_enhanceMatLimitProtections: {
                id: 'actionPanel_enhanceMatLimitProtections',
                label: 'Enhancement material limit: Include protection items',
                type: 'checkbox',
                default: true,
                help: 'When enabled, protection item availability is factored into the material limit estimate. Disable to see material limit based only on enhancement materials.',
            },
        },
    },

    actionQueue: {
        title: 'Action Queue',
        icon: '📌',
        settings: {
            actionQueue: {
                id: 'actionQueue',
                label: 'Queued actions: Show total time and completion time',
                type: 'checkbox',
                default: true,
            },
            actionQueue_showValue: {
                id: 'actionQueue_showValue',
                needsPrices: true,
                label: 'Queued actions: Show profit/value for queued actions',
                type: 'checkbox',
                default: true,
            },
            actionQueue_zoneSimButton: {
                id: 'actionQueue_zoneSimButton',
                label: 'Queued actions: Show the "sim 24h" button',
                type: 'checkbox',
                default: true,
                help:
                    'Adds a button above the queue that simulates each queued fight solo for 24 hours in the loadout it ' +
                    'uses, so counted fights can be timed and valued. Fights with a fresh rate are skipped. Needs the ' +
                    'Combat Simulator on.',
                requires: 'actionQueue',
            },
            actionQueue_valueMode: {
                id: 'actionQueue_valueMode',
                needsPrices: true,
                label: 'Queued actions: Value calculation mode',
                type: 'select',
                default: 'profit',
                options: [
                    { value: 'profit', label: 'Total Profit (revenue - all costs)' },
                    { value: 'estimated_value', label: 'Estimated Value (revenue after tax)' },
                ],
                help: 'Choose how to calculate the total value for queued actions. Profit shows net earnings after materials and drinks. Estimated Value shows gross revenue after market tax (always positive).',
            },
            actionQueue_coinifyCashAsCowbells: {
                id: 'actionQueue_coinifyCashAsCowbells',
                label: 'Coinify cash in Cowbells',
                type: 'checkbox',
                default: false,
                help: "Also show a coinify row's cash as the number of Cowbells it would buy, at the market price of a Bag of 10 Cowbells ÷ 10. Omitted when that price is unavailable.",
            },
            actionQueue_showXp: {
                id: 'actionQueue_showXp',
                label: 'Queued actions: Show XP for queued actions',
                type: 'checkbox',
                default: false,
                help:
                    'Adds an XP line to each queued row and a Total XP to the footer. Fights use the last combat ' +
                    'simulation. Other actions use game data including wisdom, Charm Experience and efficiency. A row ' +
                    'with no figure marks the total "+ [?]" rather than counting zero.',
                requires: 'actionQueue',
            },
            actionQueue_completionTimeStyle: {
                id: 'actionQueue_completionTimeStyle',
                label: 'Queued actions: Completion display',
                type: 'select',
                default: 'absolute',
                options: [
                    { value: 'absolute', label: 'Clock time only' },
                    { value: 'relative', label: 'Cumulative duration only' },
                    { value: 'both', label: 'Cumulative duration and clock time' },
                ],
                help: 'Chooses whether each reachable queue row shows when it finishes, how long it takes to reach, or both. Clock times follow the 12/24-hour and date order set under Marketplace: Time format and Date format for date/time display.',
            },
        },
    },

    alchemy: {
        title: 'Alchemy',
        icon: '⚗️',
        settings: {
            alchemy_profitDisplay: {
                id: 'alchemy_profitDisplay',
                needsPrices: true,
                label: 'Alchemy panel: Show profit calculator',
                type: 'checkbox',
                default: true,
                help: 'Displays profit/hour and profit/day for alchemy actions based on success rate and market prices',
            },
            alchemy_catalystWhatIf: {
                id: 'alchemy_catalystWhatIf',
                needsPrices: true,
                label: 'Alchemy panel: Catalyst what-if picker in Profitability',
                type: 'checkbox',
                default: true,
                help:
                    'Adds a picker to Profitability that recomputes it as if no catalyst, the type catalyst or a ' +
                    'Prime Catalyst were slotted, even ones you do not own. Your real catalyst is unchanged. Figures ' +
                    'are marked what-if until you pick Equipped again, and Missing Mats includes the picked catalyst.',
            },
            alchemy_bestItems: {
                id: 'alchemy_bestItems',
                needsPrices: true,
                label: 'Alchemy panel: Show best items button',
                type: 'checkbox',
                default: true,
                help: 'Adds a button to see items ranked by profit or XP for each alchemy type.',
            },
            alchemy_bestItems_sortMode: {
                id: 'alchemy_bestItems_sortMode',
                label: 'Alchemy panel: Best items sort',
                type: 'select',
                default: 'profit',
                options: [
                    { value: 'profit', label: 'Profit per hour' },
                    { value: 'xp', label: 'XP per hour' },
                    { value: 'decomposeChainPerHour', label: 'Full decompose chain per hour (Decompose tab)' },
                    { value: 'chainOwnStock', label: 'Full decompose chain per hour, items you hold (Decompose tab)' },
                ],
                help:
                    'Which figure the best items table ranks by. The chain modes decompose the item and everything it ' +
                    'yields, then sell what is left after tax, on the sides your Buy/Sell pricing uses. The full ' +
                    'chain buys the item. The items-you-hold chain uses copies you already hold. The table buttons ' +
                    'change this too.',
                requires: 'alchemy_bestItems',
            },
            alchemy_bestItems_shopPrices: {
                id: 'alchemy_bestItems_shopPrices',
                needsPrices: true,
                label: 'Alchemy panel: Best Items include shop prices',
                type: 'checkbox',
                default: true,
                help: 'Buys the item at the NPC shop price when that is below the market price, or when the market has no price at all. Only shop offers paid in coins count, only on the buy side, and only in Best Items. The same box sits in the table.',
                requires: 'alchemy_bestItems',
            },
            alchemy_bestItems_gearOnly: {
                id: 'alchemy_bestItems_gearOnly',
                label: 'Alchemy panel: Best Items gear only (Decompose)',
                type: 'checkbox',
                default: false,
                help: 'Hides every Decompose row whose item is not gear. Lumber, cheese, hide, tea, fiber and core only yield essences, and bury the gear chains. The same box sits in the table.',
                requires: 'alchemy_bestItems',
            },
            alchemyBestItems_prefillLevelFilter: {
                id: 'alchemyBestItems_prefillLevelFilter',
                label: 'Alchemy panel: Pre-fill Best Items max level from current skill level',
                type: 'checkbox',
                default: false,
                help: 'When opening Best Items, sets the max level filter to your current Alchemy skill level. Off by default: alchemy has no hard level requirement, so a higher-level item can still be the most profitable.',
            },
            alchemyItemPins: {
                id: 'alchemyItemPins',
                requiresRefresh: true,
                label: 'Alchemy panel: Pin items in the item picker',
                type: 'checkbox',
                default: true,
                help: 'Adds a 📌 to each item in the Alchemize Item list that moves it to the front. Kept per action, since what is worth coinifying is rarely what is worth decomposing. Pins reorder but do not exempt: a pinned item that does not match the filter box stays hidden',
            },
            alchemyCatalystMark: {
                id: 'alchemyCatalystMark',
                label: 'Alchemy panel: Mark the best catalyst in the catalyst picker',
                type: 'checkbox',
                default: true,
                help:
                    'When you open the catalyst picker, adds a line naming the catalyst (none, type or Prime) that ' +
                    'earns the most per hour for the selected item, what it earns and whether you own it. A clear ' +
                    'winner gets a star on its tile; a tie gets none. Information only. Uses your pricing mode.',
            },
            alchemyCatalystCheck: {
                id: 'alchemyCatalystCheck',
                label: 'Alchemy panel: Check the catalyst when you press Start or Queue',
                type: 'checkbox',
                default: false,
                help:
                    'Off by default because it holds a button press. Pressing an alchemy Start or Queue button without ' +
                    'the most profitable catalyst selected does nothing and says which option is best and what your ' +
                    'choice costs per hour; one more press within 15 seconds goes ahead, and that setup is not asked ' +
                    'about again for a minute. Only speaks up when your choice earns at least 10K coins an hour less ' +
                    "and the gap is at least 5% of the best option's hourly figure, gain or loss. Stays quiet when " +
                    'figures are missing or unpriced, a catalyst has an empty order book, options tie, or an Iron Cow ' +
                    'does not own the best catalyst. Never picks a catalyst or starts anything for you.',
            },
            alchemyItemSort: {
                id: 'alchemyItemSort',
                requiresRefresh: true,
                label: 'Alchemy panel: Sort item picker by profit or XP',
                type: 'checkbox',
                default: true,
                help: "Adds a Game / Profit/hr / XP/hr toggle to the Alchemize Item picker, remembered per tab. Game by default, so the picker's order never changes until a tab is switched to Profit/hr or XP/hr.",
            },
            alchemy_transmuteHistory: {
                id: 'alchemy_transmuteHistory',
                needsPrices: true,
                label: 'Alchemy panel: Track and view transmute session history',
                type: 'checkbox',
                default: true,
                help: 'Records transmutation sessions and shows them under Transmute in the Alchemy History tab of the Alchemy panel',
            },
            alchemy_coinifyHistory: {
                id: 'alchemy_coinifyHistory',
                needsPrices: true,
                label: 'Alchemy panel: Track and view coinify session history',
                type: 'checkbox',
                default: true,
                help: 'Records coinify sessions and shows them under Coinify in the Alchemy History tab of the Alchemy panel',
            },
            alchemy_decomposeHistory: {
                id: 'alchemy_decomposeHistory',
                needsPrices: true,
                label: 'Alchemy panel: Track and view decompose session history',
                type: 'checkbox',
                default: true,
                help: 'Records decompose sessions and shows them under Decompose in the Alchemy History tab of the Alchemy panel',
            },
            alchemy_actionProtection: {
                id: 'alchemy_actionProtection',
                needsPrices: true,
                label: 'Alchemy panel: Protect categories from accidental alchemy actions',
                type: 'checkbox',
                default: true,
                help: 'Blocks alchemy action buttons for 3 seconds when the selected item belongs to a protected category. A shield icon appears in the alchemy panel to configure protected categories.',
                requiresRefresh: true,
            },
            alchemyItemDimming: {
                id: 'alchemyItemDimming',
                requiresRefresh: true,
                label: 'Alchemy panel: Dim items requiring higher level',
                type: 'checkbox',
                default: true,
            },
        },
    },

    missingMaterials: {
        title: 'Missing Materials & Crafting Plan',
        icon: '🛒',
        settings: {
            actionPanelLayout: {
                id: 'actionPanelLayout',
                label: 'Keep the action panel on screen',
                type: 'checkbox',
                default: true,
                help: 'Stops the action detail panel growing past the window: it scrolls instead, and the Queue and Start buttons stay pinned to the bottom rather than falling off it. Also tightens the spacing of the added sections.',
            },
            actions_missingMaterialsButton: {
                id: 'actions_missingMaterialsButton',
                needsPrices: true,
                label: 'Show "Missing Mats Marketplace" button on production, enhancing and alchemy panels',
                type: 'checkbox',
                default: true,
                help: 'Adds a button to production, enhancing and alchemy panels that opens marketplace with tabs for missing materials',
            },
            actions_missingMaterialsButton_ignoreQueue: {
                id: 'actions_missingMaterialsButton_ignoreQueue',
                needsPrices: true,
                label: 'Ignore queued actions when calculating missing materials',
                type: 'checkbox',
                default: false,
                help: 'When enabled, missing materials calculation only considers current action request, ignoring materials already reserved by queued actions. Default (off) accounts for queue.',
                requires: 'actions_missingMaterialsButton',
            },
            actions_budgetCalculator: {
                id: 'actions_budgetCalculator',
                needsPrices: true,
                label: 'Action panel: Budget calculator',
                type: 'checkbox',
                default: true,
                help: 'Adds a budget input below the Missing Mats button. Enter a gold budget (e.g. 50m) to calculate how many units you can produce by buying missing tradeable materials at ask price. Any coin fee the recipe charges is paid out of the same budget.',
            },
            actions_costSummary: {
                id: 'actions_costSummary',
                needsPrices: true,
                label: 'Action panel: Show cost summary',
                type: 'checkbox',
                default: true,
                help: 'Compact 4-line cost comparison for the selected produce quantity: direct recipe cost, missing direct mats, best crafting plan, and finished item market price.',
            },
            actions_arbitrageBoard: {
                id: 'actions_arbitrageBoard',
                needsPrices: true,
                label: 'Skill pages: Production arbitrage board',
                type: 'checkbox',
                default: true,
                help:
                    'Adds an "Arbitrage" button to the cheesesmithing, crafting, tailoring, cooking and brewing ' +
                    'pages. It opens a ranked table of every recipe: material cost, sale after tax, margin, profit ' +
                    'per hour and day (bounded by market volume), level (unmet flagged) and a data-quality flag. ' +
                    'Click a row to open it.',
            },
            actions_craftEnhance: {
                id: 'actions_craftEnhance',
                needsPrices: true,
                label: 'Skill pages: Craft & Enhance window',
                type: 'checkbox',
                default: true,
                help:
                    'Adds a "Craft & Enhance" button to the cheesesmithing, crafting and tailoring pages. Opens a ' +
                    'window ranking gear whose recipe uses a dungeon drop or token shop item by craft cost, enhancing ' +
                    'cost, sale after tax, profit and XP per hour. Missing prices show as a dash, never 0. Hidden for ' +
                    'Iron Cow.',
            },
            actions_craftEnhance_targetLevel: {
                id: 'actions_craftEnhance_targetLevel',
                label: 'Craft & Enhance: Target enhancement level',
                type: 'number',
                default: 5,
                min: 1,
                max: 10,
                requires: 'actions_craftEnhance',
                help: 'The enhancement level the Craft & Enhance window rates each recipe at, next to +0. The window has the same choice in its header.',
            },
            actions_craftEnhance_ownedDrops: {
                id: 'actions_craftEnhance_ownedDrops',
                label: 'Craft & Enhance: Owned dungeon drops count as',
                type: 'select',
                default: 'market',
                options: [
                    { value: 'market', label: 'Sale value after tax (the ones you hold)' },
                    { value: 'buy', label: 'Buy price, untaxed (you buy them all)' },
                    { value: 'sunk', label: 'Nothing (the ones you hold, sunk)' },
                ],
                requires: 'actions_craftEnhance',
                help:
                    'How the window prices drops and token items. Held units count as owned; the rest are bought at ' +
                    'your buy side, untaxed (token items: the cheaper of that and token value). Sale value after tax ' +
                    'prices owned units at after-tax sale. Nothing counts them free (badged "sunk"). Buy price ' +
                    'ignores holdings.',
            },
            actionPanel_bestCraftingPlan: {
                id: 'actionPanel_bestCraftingPlan',
                needsPrices: true,
                label: 'Action panel: Show best crafting plan',
                type: 'checkbox',
                default: true,
                help: 'Shows the cheapest way to obtain a crafted item by comparing buy vs craft at each material tier.',
            },
            actionPanel_craftingPlanBuyIntermediates: {
                id: 'actionPanel_craftingPlanBuyIntermediates',
                label: 'Action panel: Crafting plan buys raw materials only',
                type: 'checkbox',
                default: false,
                help: 'Always craft items that have a recipe — only buy uncraftable raw materials from the market.',
            },
            actionPanel_craftingPlanNoProcessing: {
                id: 'actionPanel_craftingPlanNoProcessing',
                label: 'Action panel: Crafting plan no processing',
                type: 'checkbox',
                default: false,
                help: 'Only craft the final item — buy all sub-materials from the market instead of processing them yourself.',
            },
            actionPanel_craftingPlanTaskMode: {
                id: 'actionPanel_craftingPlanTaskMode',
                label: 'Action panel: Crafting plan task mode',
                type: 'checkbox',
                default: false,
                help: 'Forces the final craft step (for task credit) but allows buying intermediate materials if cheaper.',
            },
            actionPanel_craftingPlanTimeCost: {
                id: 'actionPanel_craftingPlanTimeCost',
                label: 'Action panel: Crafting plan time cost',
                type: 'checkbox',
                default: false,
                help: 'Factor in the time cost of crafting when deciding buy vs craft. Uses your gold/hr value to determine if crafting is worth your time.',
            },
            actionPanel_craftingPlanGoldPerHour: {
                id: 'actionPanel_craftingPlanGoldPerHour',
                label: 'Your gold rate (gold/hr)',
                type: 'number',
                shorthand: true,
                default: 0,
                min: 0,
                help:
                    'Your time value: what an hour of your time earns elsewhere, in gold. The crafting plan uses it to decide whether ' +
                    'crafting an intermediate is worth the time, and "Instead of buying" alchemy routes charge their time ' +
                    'at it. Use your typical hourly profit (3m, 500k, 1.5b). 0 leaves time free.',
            },
            actionPanel_craftingPlanThinMarket: {
                id: 'actionPanel_craftingPlanThinMarket',
                label: 'Action panel: Crafting plan re-routes thin buys to craft',
                type: 'checkbox',
                default: false,
                help:
                    'When the plan would buy an intermediate but community price data shows fewer units listed at that ' +
                    'cheap ask than it needs, craft it instead. Only acts when the data positively shows a thin listing, ' +
                    'and never overrides "buys raw materials only" or "no processing".',
            },
            craftingPlan_guidedWalk: {
                id: 'craftingPlan_guidedWalk',
                label: 'Crafting plan: guided walk through the plan, one step at a time',
                type: 'checkbox',
                default: false,
                help:
                    'Adds a "Start guided walk" button under the plan\'s crafting steps. Going leaves first, it opens ' +
                    'each action in the game and types the count, then waits for you to press the button yourself. A ' +
                    'buy step opens the marketplace. Skip and Stop are on the strip. A reload or character switch ' +
                    'ends it.',
            },
            inventoryReservations: {
                id: 'inventoryReservations',
                label: 'Share one inventory between plans (reservation ledger)',
                type: 'checkbox',
                default: false,
                help:
                    'On, a plan claims what it needs from your bag and other plans plan against what is left, so two ' +
                    'plans needing the same 500 logs no longer both count them. Goal claims last until the goal goes, ' +
                    'crafting plan claims 7 days. Queued sales claim too. Budget and missing-materials claims last ' +
                    'while open.',
            },
            actions_artisanMaterialMode: {
                id: 'actions_artisanMaterialMode',
                label: 'Missing materials: Artisan requirement mode',
                type: 'select',
                default: 'expected',
                options: [
                    { value: 'expected', label: 'Expected value (average)' },
                    { value: 'worst-case', label: 'Worst-case per action (ceil per craft)' },
                    { value: 'hybrid', label: 'Hybrid (ceil below 100 actions, average at 100+)' },
                ],
                help:
                    'How missing materials counts Artisan Tea savings. Expected value averages them (long queues; can ' +
                    'under-buy short ones). Worst-case rounds every craft up (few actions; over-buys long ones). ' +
                    'Hybrid: worst-case below 100 actions, then expected value; in Craft & Enhance it always averages.',
            },
        },
    },

    lootLog: {
        title: 'Loot Log',
        icon: '📦',
        settings: {
            treasureTracker_popup: {
                id: 'treasureTracker_popup',
                needsPrices: true,
                label: "Treasure Tracker: Pop up what an opening paid, beside the game's loot dialog",
                type: 'checkbox',
                default: true,
                help: "The game's Opened Loot dialog says what you got; this says whether it was good, item by item, against what the drop table owed",
                requires: 'treasureTracker',
            },
            treasureTracker: {
                id: 'treasureTracker',
                needsPrices: true,
                label: 'Treasure Tracker: Record chest openings and compare against expected value',
                type: 'checkbox',
                default: true,
                help: 'Tracks what every chest you open actually paid out against what its drop table says it owes. Open the panel from the Treasure button on the settings page',
                requiresRefresh: true,
            },
            watchlist: {
                id: 'watchlist',
                needsPrices: true,
                label: "Watchlist: Track chosen items, a zone's drops, or a chest's contents",
                type: 'checkbox',
                default: true,
                help: 'A list of items with what you hold and what it is worth. Tick a combat zone to add everything it drops, or a chest to add its contents. Tracked items get a dot in the inventory, and anything the vendor pays more for than the market is flagged. Open it from the Watchlist overlay row.',
                requiresRefresh: true,
            },
            watchlist_menuButton: {
                id: 'watchlist_menuButton',
                label: 'Watchlist: Add a Track button to the item menu in your inventory',
                type: 'checkbox',
                default: false,
                help: 'Puts a Track / Untrack button beside Sell when you click an inventory item. Off by default because it changes a menu you use for other things — the Watchlist panel has the same switch',
                requires: 'watchlist',
            },
            watchlist_inventoryDots: {
                id: 'watchlist_inventoryDots',
                needsPrices: true,
                label: 'Watchlist: Dot tracked items in the inventory',
                type: 'checkbox',
                default: true,
                help: 'Puts a small dot in the corner of every inventory tile holding a tracked item, so you see the watchlist while browsing your inventory. Turn it off if the grid is too busy. The Watchlist panel has the same switch.',
                requires: 'watchlist',
            },
            equipmentSavings_menuButton: {
                id: 'equipmentSavings_menuButton',
                label: 'Equipment Savings: Add a Save for button to the item menu',
                type: 'checkbox',
                default: false,
                help: 'Puts a Save for / Stop saving button beside Sell when you click a piece of equipment, which is how a target gets onto the Equipment Savings list. Off by default because it changes a menu you use for other things',
            },
            upgradeAdvisor_compareRoutes: {
                id: 'upgradeAdvisor_compareRoutes',
                needsPrices: true,
                label: 'Upgrade advisors: Price upgrades by your preferred route',
                type: 'checkbox',
                default: true,
                help:
                    "The Combat and Lab advisors price a supported upgrade by Equipment Watch's preferred route " +
                    '(Buy, Craft or Mirror, or Auto for the lowest real cost). Supported means one tradable item of ' +
                    "your own. Others keep the advisor's own quote. Rerun the analysis after changing this.",
            },
            equipmentWatch_routePreference: {
                id: 'equipmentWatch_routePreference',
                label: 'Equipment Watch: Preferred route',
                type: 'select',
                default: 'auto',
                options: [
                    { value: 'auto', label: 'Auto (lowest real cost)' },
                    { value: 'buy', label: 'Prefer buying' },
                    { value: 'craft', label: 'Prefer crafting' },
                    { value: 'mirror', label: 'Prefer mirror' },
                ],
                help: 'Applies to Equipment Watch cards whose route chip is on Auto: the preferred route is used whenever it is priced and applicable, otherwise the card falls back to Auto (lowest real cost, counting the sale value of any copy of yours the route uses up). A card pinned to a route ignores this.',
            },
            combatText_floating: {
                id: 'combatText_floating',
                label: 'Floating Combat Text: Damage numbers over the units taking them',
                type: 'checkbox',
                default: false,
                help: 'A health bar tells you the state, not the event — "did that hit for 400 or 4,000" is a question a number answers and a bar does not',
            },
            combatText_scrolling: {
                id: 'combatText_scrolling',
                label: 'Scrolling Combat Text: Keep a log of recent hits',
                type: 'checkbox',
                default: false,
                help: 'Adds a Combat Log overlay row with the last few hits, for anything that went past too fast to read',
            },
            manaTracker: {
                id: 'manaTracker',
                label: 'Mana Tracker: Count what your abilities cost per fight',
                type: 'checkbox',
                default: true,
                help: 'Mana is the constraint nobody watches — it shows up only as the moment an ability does not fire. Adds a Mana/fight overlay row',
                requiresRefresh: true,
            },
            lootLogStats: {
                id: 'lootLogStats',
                needsPrices: true,
                label: 'Loot Log Statistics',
                type: 'checkbox',
                default: true,
                help: 'Display total value, average time, and daily output in loot logs',
            },
            lootLogHistory: {
                id: 'lootLogHistory',
                label: 'Loot Log: Persist and display historical entries',
                type: 'checkbox',
                default: true,
                help: 'Saves loot log entries and displays older entries below current ones in the loot log panel',
            },
            lootLogPivot: {
                id: 'lootLogPivot',
                label: 'Loot Log: Analytics pivot table (📊 button beside Refresh)',
                type: 'checkbox',
                default: false,
                help:
                    "Adds a button to the game's own Loot Log that opens a sortable table of your runs: one row per " +
                    'action and difficulty tier, with time spent, drop value at ask and bid, and XP/hr per skill. ' +
                    'Covers this session plus stored history, which needs the Loot Log history setting on.',
                requiresRefresh: true,
            },
            lootLogPivotSplitLabyrinth: {
                id: 'lootLogPivotSplitLabyrinth',
                label: 'Loot Log: Analytics shows each Labyrinth run as its own row',
                type: 'checkbox',
                default: false,
                help: 'In the Loot & XP Analytics table, gives every Labyrinth run its own row, labeled with when it started, instead of one row adding up every run. Every other action is grouped as before. Off by default because it changes how the table groups',
                requires: 'lootLogPivot',
            },
            lootLogDropLuck: {
                id: 'lootLogDropLuck',
                needsPrices: true,
                label: 'Loot Log: Drop luck percentile for gathering runs',
                type: 'checkbox',
                default: true,
                help: "Places a run's drop value in the distribution of everything those actions could have paid: 50 is typical, 5 means nineteen runs in twenty do better. Only for actions with their own drop table (gathering); combat has its own verdict and production rolls nothing.",
            },
            lootLogEnhancingCost: {
                id: 'lootLogEnhancingCost',
                label: 'Loot Log: Enhancing cost, luck and profit',
                type: 'checkbox',
                default: false,
                help: 'Adds a summary to enhancing loot-log entries: material and protection cost vs the statistically expected cost (how lucky the run was), and the profit (finished item after-fee value minus base and spend). Assumes the cost-optimal protect level.',
            },
        },
    },

    tooltips: {
        title: 'Item Tooltip Enhancements',
        icon: '💬',
        settings: {
            itemTooltip_prices: {
                id: 'itemTooltip_prices',
                needsPrices: true,
                label: 'Show 24-hour average market prices',
                type: 'checkbox',
                default: true,
            },
            itemTooltip_effectivePrices: {
                id: 'itemTooltip_effectivePrices',
                label: 'Show effective (after-tax) prices',
                type: 'checkbox',
                default: false,
                help: 'Shows what you actually receive after the marketplace tax next to ask/bid prices in item tooltips',
                requires: 'itemTooltip_prices',
            },
            itemTooltip_artisanPrices: {
                id: 'itemTooltip_artisanPrices',
                needsPrices: true,
                label: 'Adjust tooltip prices for Artisan Tea reduction',
                type: 'checkbox',
                default: true,
                help: 'When viewing a recipe on an action panel, adjusts the total price to reflect actual material cost after Artisan Tea reduction',
                requires: 'itemTooltip_prices',
            },
            itemTooltip_profit: {
                id: 'itemTooltip_profit',
                needsPrices: true,
                label: 'Show production cost and profit',
                type: 'checkbox',
                default: true,
            },
            itemTooltip_ownUseCompare: {
                id: 'itemTooltip_ownUseCompare',
                needsPrices: true,
                label: 'Show make-vs-buy line for own use (no sales tax)',
                type: 'checkbox',
                default: true,
                help: 'Adds a line to the profit section comparing buying the item at the current ask with crafting it for your own use (materials and teas at your efficiency, no sales tax on either side). The profit figures above stay seller-priced.',
            },
            itemTooltip_heldCraftCompare: {
                id: 'itemTooltip_heldCraftCompare',
                needsPrices: true,
                label: 'Show craft-vs-sell line for materials you already hold',
                type: 'checkbox',
                default: true,
                help:
                    'For materials you already hold, such as dungeon drops, adds a profit line showing what crafting ' +
                    'them and selling the result earns per item over selling the materials as they are, after tax. ' +
                    'Not shown for multi-output recipes, enhanced upgrades, Iron Cow characters, or when a price is ' +
                    'missing.',
            },
            itemTooltip_detailedProfit: {
                id: 'itemTooltip_detailedProfit',
                needsPrices: true,
                label: 'Show detailed materials breakdown in profit display',
                type: 'checkbox',
                default: false,
                help: 'Shows material costs table with Ask/Bid prices, actions/hour, and profit breakdown',
            },
            itemTooltip_craftCostSubMaterials: {
                id: 'itemTooltip_craftCostSubMaterials',
                label: 'Craft cost includes crafting sub-materials',
                type: 'checkbox',
                default: true,
                help:
                    'Adds a "Best plan" row to the materials breakdown: buy or craft each ingredient, whichever is ' +
                    'cheaper. Shown only if it differs from Total; an unpriced sub-material marks it a floor (≥). ' +
                    'Profit/hr uses Total. Not with "direct recipe only". Needs "Show detailed materials breakdown in ' +
                    'profit display".',
                requires: 'itemTooltip_detailedProfit',
            },
            itemTooltip_detailedProfitFlat: {
                id: 'itemTooltip_detailedProfitFlat',
                label: 'Profit: direct recipe only (buy base items, no sub-craft chain)',
                type: 'checkbox',
                default: false,
                help: 'Costs each recipe ingredient at its own market Ask/Bid and stops there instead of recursing into how it is made. The breakdown shows only direct ingredients, and profit/hr is for buying the base items and crafting this one step. Overrides "Use crafting cost for upgrade items if cheaper" while on.',
            },
            itemTooltip_multiActionProfit: {
                id: 'itemTooltip_multiActionProfit',
                needsPrices: true,
                label: 'Show profit comparison for all item actions',
                type: 'checkbox',
                default: true,
                help: 'Displays best profit/hr highlighted, with other alternative actions (craft, coinify, decompose, transmute) summarized below',
            },
            itemTooltip_selfUseAlchemy: {
                id: 'itemTooltip_selfUseAlchemy',
                needsPrices: true,
                label: 'Show self-use alchemy lines (no sales tax)',
                type: 'checkbox',
                default: false,
                help:
                    'Adds self-use lines to the alternative actions: decompose once, the full decompose chain, and ' +
                    'transmuting an item you hold. Which outputs are kept follows "What a K mark means". Kept outputs ' +
                    'are valued at your buy price and sold ones after tax. The ordinary taxed figures are unchanged.',
            },
            itemTooltip_selfUseKeepChip: {
                id: 'itemTooltip_selfUseKeepChip',
                needsPrices: true,
                label: 'Show the Keep for self-use chip on tooltips',
                type: 'checkbox',
                default: false,
                help: 'A small "Sell (K)" tag ("Keep (K)" in keep mode) on an alchemy output tooltip, clickable or toggled with the K key, for marking it. Needs the self-use lines or the cheaper-routes setting on. Earlier marks still count with this off, and the list below can review and remove them.',
            },
            selfUse_markMeaning: {
                id: 'selfUse_markMeaning',
                label: 'What a K mark means',
                type: 'select',
                default: 'sell',
                options: [
                    { value: 'sell', label: 'K marks items to sell (keep the rest)' },
                    { value: 'keep', label: 'K marks items to keep (sell the rest)' },
                ],
                help:
                    'Which way the self-use K marks on a tooltip cut. "Sell" (default) values a marked output as sold ' +
                    'after tax and keeps every other output. "Keep" flips that: a marked output is valued at what you ' +
                    'would pay and every other output is sold after tax.',
            },
            itemTooltip_selfUseKeepList: {
                id: 'itemTooltip_selfUseKeepList',
                label: 'Self-use marks (this character)',
                type: 'button',
                buttonLabel: 'Review marked items',
                help: 'The items this character marked from their tooltips (to sell, or to keep in keep mode), which the self-use alchemy lines treat differently from the rest. Remove one, or clear the list.',
            },
            itemTooltip_alchemyInsteadOfBuying: {
                id: 'itemTooltip_alchemyInsteadOfBuying',
                needsPrices: true,
                label: 'Show cheaper alchemy routes instead of buying',
                type: 'checkbox',
                default: false,
                help:
                    'On an item you might buy, names the best items to buy and decompose or transmute to get it ' +
                    'cheaper, and the saving per unit. Prices follow your profit pricing mode. Other outputs sell ' +
                    'after tax, or count at your buy price when kept. Estimated prices are left out. Alchemy time ' +
                    'uses your gold rate.',
            },
            itemTooltip_alchemyInsteadHeadline: {
                id: 'itemTooltip_alchemyInsteadHeadline',
                label: 'Highlighted figure for cheaper alchemy routes',
                type: 'select',
                default: 'perUnit',
                requires: 'itemTooltip_alchemyInsteadOfBuying',
                options: [
                    { value: 'perUnit', label: 'Saving per unit' },
                    { value: 'perHour', label: 'Saving per hour over your time value' },
                    { value: 'grossPerHour', label: 'Alchemy gold/hr' },
                ],
                help: 'Which figure the "Instead of buying" line shows first, in green. The other figures stay on the line, and the working is in its hover text. Alchemy gold/hr is the hourly saving before your time value is taken off.',
            },
            itemTooltip_alchemyInsteadOfSelling: {
                id: 'itemTooltip_alchemyInsteadOfSelling',
                needsPrices: true,
                label: 'Show alchemy routes that beat selling an item you hold',
                type: 'checkbox',
                default: true,
                help:
                    'On an item you might sell, names the alchemy action (decompose, transmute or coinify) that pays ' +
                    'more for one unit you hold than selling it after tax. Outputs are sold after tax whatever your K ' +
                    'marks say. Estimated prices are left out. Alchemy time is charged at "Your gold rate (gold/hr)".',
            },
            itemTooltip_expectedValue: {
                id: 'itemTooltip_expectedValue',
                needsPrices: true,
                label: 'Show expected value for openable containers',
                type: 'checkbox',
                default: true,
                help: 'Shows the expected value of a crate, chest or other openable container on its tooltip, and the all-N duration line on a stack of scrolls. Only the tooltip changes: with this off, containers are still priced in net worth, inventory badges, the loot log, combat stats and task values.',
            },
            expectedValue_showDrops: {
                id: 'expectedValue_showDrops',
                needsPrices: true,
                label: 'Expected value drop display',
                type: 'select',
                default: 'All',
                options: [
                    { value: 'Top 5', label: 'Top 5' },
                    { value: 'Top 10', label: 'Top 10' },
                    { value: 'All', label: 'All Drops' },
                    { value: 'None', label: 'Summary Only' },
                ],
            },
            expectedValue_respectPricingMode: {
                id: 'expectedValue_respectPricingMode',
                needsPrices: true,
                label: 'Use pricing mode for dungeon token valuation',
                help: 'Only affects how dungeon tokens (Chimerical, Sinister, Enchanted, Pirate) are valued. Ordinary drops are always priced at sell, regardless of this setting.',
                type: 'checkbox',
                default: true,
            },
            expectedValue_includeCowbells: {
                id: 'expectedValue_includeCowbells',
                needsPrices: true,
                label: 'Include cowbell value in expected value calculations',
                type: 'checkbox',
                default: true,
            },
            showConsumTips: {
                id: 'showConsumTips',
                requiresRefresh: true,
                label: 'HP/MP consumables: Restore speed, cost performance',
                type: 'checkbox',
                default: true,
            },
            dungeonTokenTooltips: {
                id: 'dungeonTokenTooltips',
                needsPrices: true,
                label: 'Currency tooltips: Show shop values for tokens, scrolls, and cowbells',
                type: 'checkbox',
                default: true,
            },
            dungeonTokenTooltips_crafts: {
                id: 'dungeonTokenTooltips_crafts',
                needsPrices: true,
                label: 'Dungeon token tooltips: best crafts from that dungeon',
                type: 'checkbox',
                default: true,
                requires: 'dungeonTokenTooltips',
                help:
                    "Under a dungeon token shop table, lists the most profitable gear to craft from that dungeon's " +
                    'drops and token shop items, per item after tax, at +0 and at the Craft & Enhance target level. ' +
                    'Needs the Craft & Enhance setting on. Hidden for Iron Cow characters.',
            },
            inventoryTooltipBeside: {
                id: 'inventoryTooltipBeside',
                label: 'Keep item tooltips off the hovered item',
                type: 'checkbox',
                default: true,
                help: 'When an item tooltip (inventory, Loadouts and equipment panels, marketplace, item pickers) is too tall to fit above or below the item, it opens to the left or right instead of covering it. Tooltips that fit stay where the game puts them. Off on phones.',
            },
            itemTooltip_wheelScroll: {
                id: 'itemTooltip_wheelScroll',
                label: 'Scroll tall tooltips with the mouse wheel',
                type: 'checkbox',
                default: true,
                help: 'When a tooltip is taller than the window, the mouse wheel over the item scrolls the tooltip instead of the page, so cut-off lines (enhancement milestones and the like) can be read. At the top or bottom the wheel scrolls the page again.',
            },
            shop_maxBuyButton: {
                id: 'shop_maxBuyButton',
                label: "Shop: Add 'Max' buy buttons",
                type: 'checkbox',
                default: true,
                help: 'Adds a Max button to the Shop, Task Shop, Labyrinth Shop, and Cowbell Store buy dialogs that fills in the most you can afford. It only types the quantity; you press Buy',
            },
            shopTokenValues: {
                id: 'shopTokenValues',
                needsPrices: true,
                label: 'Shop: Show value per token',
                type: 'checkbox',
                default: true,
                help:
                    'Shows what one token is worth in each Dungeon, Labyrinth and Task shop entry (market value of ' +
                    'what it buys, after tax, per token) and stars the best per token. A Task chest uses the higher ' +
                    'of market price and expected drops. Untradable capes show the base value with an asterisk, never ' +
                    'starred.',
            },
            dungeonShopPlanner: {
                id: 'dungeonShopPlanner',
                needsPrices: true,
                label: 'Dungeon shop: Plan token spend (volume-capped)',
                type: 'checkbox',
                default: true,
                help: "Adds a Plan spend button on the Shop's Dungeon tab. It plans what to buy with your dungeon tokens for the most gold after tax, holding each item to what the market could absorb, and fills the quantity in the game's buy dialog. You press Buy.",
            },
            dungeonShopPlanner_days: {
                id: 'dungeonShopPlanner_days',
                label: 'Dungeon shop planner: Days of traded volume to sell into',
                type: 'number',
                default: 3,
                min: 0.1,
                max: 365,
                requires: 'dungeonShopPlanner',
            },
            dungeonShopPlanner_sharePercent: {
                id: 'dungeonShopPlanner_sharePercent',
                label: 'Dungeon shop planner: % of traded volume you can take',
                type: 'number',
                default: 25,
                min: 0.1,
                max: 100,
                requires: 'dungeonShopPlanner',
            },
            dungeonShopPlanner_includeUnmeasured: {
                id: 'dungeonShopPlanner_includeUnmeasured',
                label: 'Dungeon shop planner: Plan items with no volume data (uncapped)',
                type: 'checkbox',
                default: false,
                requires: 'dungeonShopPlanner',
            },
            dungeonShopPlanner_holdPercent: {
                id: 'dungeonShopPlanner_holdPercent',
                label: 'Dungeon shop planner: Hold items below this % of the best gold/token',
                type: 'number',
                default: 80,
                min: 0,
                max: 100,
                requires: 'dungeonShopPlanner',
                help: 'Once the best items hit their volume caps, leftover tokens used to fall through to a much worse item. This holds them for the next run instead of spending them on an item below this share of the best gold/token available. 0 turns the hold off.',
            },
            dungeonShopPlanner_skipEssence: {
                id: 'dungeonShopPlanner_skipEssence',
                label: 'Dungeon shop planner: Never plan essence',
                type: 'checkbox',
                default: false,
                requires: 'dungeonShopPlanner',
                help: 'Leaves dungeon essence out of the plan, so tokens the other items cannot take stay unspent for next time instead of going into essence.',
            },
            itemTooltip_gathering: {
                id: 'itemTooltip_gathering',
                label: 'Show gathering sources and profit',
                type: 'checkbox',
                default: true,
                help: 'Shows gathering actions that produce this item (foraging, woodcutting, milking)',
            },
            itemTooltip_gatheringRareDrops: {
                id: 'itemTooltip_gatheringRareDrops',
                label: 'Show rare gathering drops in item tooltips',
                type: 'checkbox',
                default: true,
                help: "When you hover an item, also list the gathering zones where it is a rare drop (under 1%), shown as items per day. For example, hovering Thread of Expertise lists Asteroid Belt. Requires 'Show gathering sources and profit'.",
                requires: 'itemTooltip_gathering',
            },
            itemTooltip_abilityStatus: {
                id: 'itemTooltip_abilityStatus',
                label: 'Show ability book status',
                type: 'checkbox',
                default: true,
                help: 'Shows whether ability is learned and current level/progress on ability book tooltips',
            },
            itemTooltip_loadoutMarks: {
                id: 'itemTooltip_loadoutMarks',
                label: 'Show which saved loadouts an item is in',
                type: 'checkbox',
                default: true,
                help:
                    'Names the saved loadouts an item is slotted in: equipment at the level the loadout uses — its ' +
                    "pinned level, or the highest copy you own if it isn't pinned — plus food and drinks. Says so " +
                    "when it's in none, and separately when you haven't saved any loadouts.",
            },
            itemTooltip_abilityFreshCost: {
                id: 'itemTooltip_abilityFreshCost',
                label: 'Show fresh-to-level cost on ability hovers',
                type: 'checkbox',
                default: false,
                help: 'When hovering an ability (in a loadout or ability slot, including on another player’s profile), adds what it would cost to buy that ability up to the level shown. Uses the level in the tooltip, so it is correct on other players’ profiles too.',
            },
            abilityTooltip_effectiveTiming: {
                id: 'abilityTooltip_effectiveTiming',
                label: 'Show effective cooldown/cast time on ability hovers',
                type: 'checkbox',
                default: true,
                help: 'The game’s ability tooltip always shows base Cooldown and Cast Time. This adds, in parentheses, what they actually are with your Ability Haste, Cast Speed and Attack level applied — and adds nothing when the figures match.',
            },
            itemTooltip_enhancementMilestones: {
                id: 'itemTooltip_enhancementMilestones',
                label: 'Show enhancement milestones (+5/+7/+10/+12)',
                type: 'checkbox',
                default: false,
                help: 'Shows expected cost and XP to reach +5, +7, +10, and +12 on unenhanced equipment tooltips',
            },
            itemTooltip_enhancementPath: {
                id: 'itemTooltip_enhancementPath',
                needsPrices: true,
                label: 'Show enhancement path on enhanced items',
                type: 'checkbox',
                default: true,
                help: 'Shows the optimal enhancement path cost breakdown when hovering over enhanced (+1 to +20) items',
            },
            itemTooltip_enhancementProRates: {
                id: 'itemTooltip_enhancementProRates',
                label: 'Quote enhancement predictions at pro rates instead of your stats',
                type: 'checkbox',
                default: false,
                help: 'Prices the enhancement path and milestones as a top-end enhancer (level 140, Observatory 8, ultra + blessed tea, +15 Celestial enhancer, +10 to +12 gear) instead of your own gear. Also toggled from the "Yours / Pro" chip on the tooltip header, or with P while the tooltip is open.',
            },
            itemTooltip_enhancingHourlyRate: {
                id: 'itemTooltip_enhancingHourlyRate',
                label: 'Target hourly rate for enhancing (e.g. 50m)',
                type: 'text',
                default: '',
                help: 'Adds a minimum sell price to the enhancement tooltip that covers total cost plus this rate for time spent. Leave blank to disable.',
            },
            itemTooltip_enhancingHourlyRateTax: {
                id: 'itemTooltip_enhancingHourlyRateTax',
                label: 'Include marketplace tax in minimum sell price',
                type: 'checkbox',
                default: false,
                help: 'Accounts for the marketplace seller tax so listing at minimum sell still nets your target rate after tax',
                requires: 'itemTooltip_enhancingHourlyRate',
            },
            itemTooltip_pinTop: {
                id: 'itemTooltip_pinTop',
                label: 'Pin tooltips to top-center of screen',
                type: 'checkbox',
                default: false,
                help: 'Forces item tooltips to always appear centered at the top of the screen instead of near the hovered item',
            },
            itemTooltip_hideInEnhanceSelector: {
                id: 'itemTooltip_hideInEnhanceSelector',
                label: 'Hide tooltip extras in enhance item selector',
                type: 'checkbox',
                default: false,
                help: 'Suppresses injected tooltip content (prices, profit, milestones) when browsing items in the enhancement selector',
            },
            itemDictionary_transmuteRates: {
                id: 'itemDictionary_transmuteRates',
                needsPrices: true,
                label: 'Item Dictionary: Show transmutation success rates',
                type: 'checkbox',
                default: true,
                help: 'Displays success rate percentages in the "Transmuted From (Alchemy)" section',
            },
            itemDictionary_transmuteIncludeBaseRate: {
                id: 'itemDictionary_transmuteIncludeBaseRate',
                needsPrices: true,
                label: 'Item Dictionary: Include base success rate in transmutation percentages',
                type: 'checkbox',
                default: true,
                help: 'When enabled, shows total probability (base rate × drop rate). When disabled, shows conditional probability (drop rate only, matching "Transmutes Into" section)',
            },
        },
    },

    enhancementSimulator: {
        title: 'Enhancement Simulator Settings',
        icon: '✨',
        settings: {
            enhanceSim: {
                id: 'enhanceSim',
                needsPrices: true,
                label: 'Show enhancement simulator calculations',
                type: 'checkbox',
                default: true,
            },
            enhanceSim_baseItemCraftingCost: {
                id: 'enhanceSim_baseItemCraftingCost',
                needsPrices: true,
                label: 'Enhancement path: Use crafting cost for base item if cheaper',
                type: 'checkbox',
                // Ships on because it has always behaved as on: its only readers
                // go through `config.isFeatureEnabled`, which answered `true` for
                // any key outside the legacy features map. Now that the gate
                // reads the schema, a default of `false` would silently change
                // every enhancement path's base-item cost. This one DOES have a
                // DEFAULT_REWRITES entry (settings-storage.js): a stored `false`
                // here was inert under the old gate no matter how it got there,
                // so it cannot represent a real preference. See that entry for
                // the reasoning.
                default: true,
                help: 'When enabled, uses the lower of crafting cost or market price for the base item in enhancement path calculations, applied independently to both the Ask and Bid columns',
            },
            enhanceSim_autoTargetLevel: {
                id: 'enhanceSim_autoTargetLevel',
                label: 'Enhancement: Auto-fill target level on panel open (0 = disabled)',
                type: 'number',
                default: 0,
                min: 0,
                max: 20,
                help: "When non-zero, automatically sets the Target Level input to this value whenever you open an item's enhancement panel. Re-applies each time you switch items. Works even with the enhancement simulator calculations off.",
            },
            enhanceSim_autoProtectFrom: {
                id: 'enhanceSim_autoProtectFrom',
                label: 'Enhancement: Auto-fill optimal protect-from level when protection item is set',
                type: 'checkbox',
                default: false,
                help: 'When enabled, automatically fills the Protect From Level input with the optimal (cheapest) value whenever a protection item is placed in the slot. Works even with the enhancement simulator calculations off.',
            },
            enhanceSim_protectFromStock: {
                id: 'enhanceSim_protectFromStock',
                label: 'Enhancement: Protect-from sweep spends protection items you hold',
                type: 'checkbox',
                default: false,
                help: 'When enabled, the protect-from sweep prices every protection item you hold spare copies of: those copies are used first, valued at what they would sell for, and only the rest are bought.',
            },
            enhanceSim_protectStockReserve: {
                id: 'enhanceSim_protectStockReserve',
                label: 'Enhancement: Keep this many spare copies of the item being enhanced (when it is its own protection)',
                type: 'number',
                default: 2,
                min: 0,
                max: 100000,
                requires: 'enhanceSim_protectFromStock',
                help:
                    'Holds back this many copies of the enhanced item from the protect-from sweep and the material limit ' +
                    'when it protects itself. Mirrors of Protection are spent freely. The game cannot hold copies back ' +
                    '(it uses up the stack you pick), so keep spares at a different enhancement level.',
            },
            enhanceSim_protectionMarketplaceButton: {
                id: 'enhanceSim_protectionMarketplaceButton',
                needsPrices: true,
                label: 'Protection item picker: Show "Buy Cheapest" marketplace button',
                type: 'checkbox',
                default: true,
                help: 'Adds a button to the Protection item selector popup in the Enhancing panel that opens the Marketplace on the cheapest available protection option',
            },
            enhancementItemPins: {
                id: 'enhancementItemPins',
                label: 'Enhancing panel: Pin items in the item picker',
                type: 'checkbox',
                default: true,
                help: 'Adds a 📌 to each item in the Enhance Item list that moves it to the front. Pins reorder but do not exempt: a pinned item that does not match the filter box stays hidden',
            },
            enhancingPanel_wide: {
                id: 'enhancingPanel_wide',
                label: 'Enhancing panel: Wider center panel',
                type: 'checkbox',
                default: false,
                help: "Raises the width cap on the game's Enhancing panel (up to 1400px, 92% of the window) while the Enhancing skill panel is shown, so the Enhancement Calculator has more room. Other skills are unaffected.",
            },
            enhanceSim_autoDetect: {
                id: 'enhanceSim_autoDetect',
                label: 'Auto-detect your stats (false = use settings below)',
                type: 'checkbox',
                default: false,
                help: 'Most players should leave this off to see realistic professional enhancer costs',
            },
            enhanceSim_resetProDefaults: {
                id: 'enhanceSim_resetProDefaults',
                label: 'Reset the bench below to the pro defaults',
                type: 'button',
                buttonLabel: 'Reset to pro defaults',
                help: 'Puts every setting below back to the shipped professional-enhancer bench - the same values Pro rates quote.',
            },
            // --- ENHANCING ---
            enhanceSim_enhancingLevel: {
                id: 'enhanceSim_enhancingLevel',
                label: 'Enhancing skill level',
                type: 'number',
                default: 140,
                min: 1,
                max: 200,
                help: 'Default: 140 (professional enhancer level)',
                disabledBy: 'enhanceSim_autoDetect',
            },
            enhanceSim_houseLevel: {
                id: 'enhanceSim_houseLevel',
                label: 'Observatory house room level',
                type: 'number',
                default: 8,
                min: 0,
                max: 8,
                help: 'Default: 8 (max level)',
                disabledBy: 'enhanceSim_autoDetect',
            },
            enhanceSim_achievement: {
                id: 'enhanceSim_achievement',
                needsPrices: true,
                label: 'Achievement bonus',
                type: 'checkbox',
                default: true,
                help: 'Include your enhancing achievement success bonus',
                disabledBy: 'enhanceSim_autoDetect',
            },
            // --- GEAR (compact rows: checkbox + optional tier + enhancement level) ---
            enhanceSim_gear_enhancer: {
                id: 'enhanceSim_gear_enhancer',
                label: 'Enhancer',
                type: 'enhanceGear',
                default: { enabled: true, tier: 'celestial', level: 15 },
                tiers: [
                    { value: 'cheese', label: 'Cheese' },
                    { value: 'verdant', label: 'Verdant' },
                    { value: 'azure', label: 'Azure' },
                    { value: 'burble', label: 'Burble' },
                    { value: 'crimson', label: 'Crimson' },
                    { value: 'rainbow', label: 'Rainbow' },
                    { value: 'holy', label: 'Holy' },
                    { value: 'celestial', label: 'Celestial' },
                ],
                disabledBy: 'enhanceSim_autoDetect',
            },
            enhanceSim_gear_gloves: {
                id: 'enhanceSim_gear_gloves',
                label: 'Gloves',
                type: 'enhanceGear',
                default: { enabled: true, level: 12 },
                disabledBy: 'enhanceSim_autoDetect',
            },
            enhanceSim_gear_top: {
                id: 'enhanceSim_gear_top',
                label: 'Top',
                type: 'enhanceGear',
                default: { enabled: true, level: 10 },
                disabledBy: 'enhanceSim_autoDetect',
            },
            enhanceSim_gear_bottoms: {
                id: 'enhanceSim_gear_bottoms',
                label: 'Bottoms',
                type: 'enhanceGear',
                default: { enabled: true, level: 10 },
                disabledBy: 'enhanceSim_autoDetect',
            },
            enhanceSim_gear_neck: {
                id: 'enhanceSim_gear_neck',
                label: 'Neck',
                type: 'enhanceGear',
                default: { enabled: true, tier: 'philo', level: 10 },
                tiers: [
                    { value: 'philo', label: 'Philo' },
                    { value: 'speed', label: 'Speed' },
                ],
                disabledBy: 'enhanceSim_autoDetect',
            },
            enhanceSim_gear_ring: {
                id: 'enhanceSim_gear_ring',
                label: 'Ring',
                type: 'enhanceGear',
                default: { enabled: true, tier: 'philo', level: 10 },
                tiers: [
                    { value: 'philo', label: 'Philo' },
                    { value: 'rarefind', label: 'Rare Find' },
                ],
                disabledBy: 'enhanceSim_autoDetect',
            },
            enhanceSim_gear_earring: {
                id: 'enhanceSim_gear_earring',
                label: 'Earring',
                type: 'enhanceGear',
                default: { enabled: true, tier: 'philo', level: 10 },
                tiers: [
                    { value: 'philo', label: 'Philo' },
                    { value: 'rarefind', label: 'Rare Find' },
                ],
                disabledBy: 'enhanceSim_autoDetect',
            },
            enhanceSim_gear_cape: {
                id: 'enhanceSim_gear_cape',
                label: 'Cape',
                type: 'enhanceGear',
                default: { enabled: true, tier: 'refined', level: 10 },
                tiers: [
                    { value: 'normal', label: 'Normal' },
                    { value: 'refined', label: 'Refined' },
                ],
                disabledBy: 'enhanceSim_autoDetect',
            },
            enhanceSim_gear_guzzling: {
                id: 'enhanceSim_gear_guzzling',
                label: 'Guzzling',
                type: 'enhanceGear',
                default: { enabled: true, level: 10 },
                disabledBy: 'enhanceSim_autoDetect',
            },
            enhanceSim_gear_charm: {
                id: 'enhanceSim_gear_charm',
                label: 'Charm',
                type: 'enhanceGear',
                default: { enabled: true, tier: 'grandmaster', level: 0 },
                tiers: [
                    { value: 'trainee', label: 'Trainee' },
                    { value: 'basic', label: 'Basic' },
                    { value: 'advanced', label: 'Advanced' },
                    { value: 'expert', label: 'Expert' },
                    { value: 'master', label: 'Master' },
                    { value: 'grandmaster', label: 'Grandmaster' },
                ],
                disabledBy: 'enhanceSim_autoDetect',
            },
            // --- BUFFS ---
            enhanceSim_tea: {
                id: 'enhanceSim_tea',
                label: 'Enhancing tea',
                type: 'select',
                default: 'ultra',
                options: [
                    { value: 'none', label: 'None' },
                    { value: 'basic', label: 'Enhancing Tea (+3)' },
                    { value: 'super', label: 'Super Enhancing Tea (+6)' },
                    { value: 'ultra', label: 'Ultra Enhancing Tea (+8)' },
                ],
                help: 'Enhancing tea provides skill level bonus',
                disabledBy: 'enhanceSim_autoDetect',
            },
            enhanceSim_blessedTea: {
                id: 'enhanceSim_blessedTea',
                needsPrices: true,
                label: 'Blessed Tea active',
                type: 'checkbox',
                default: true,
                help: 'Professional enhancers use this to reduce attempts',
                disabledBy: 'enhanceSim_autoDetect',
            },
            enhanceSim_communityBuff: {
                id: 'enhanceSim_communityBuff',
                label: 'Community Buff',
                type: 'enhanceGear',
                default: { enabled: true, level: 1 },
                help: 'Enhancing speed community buff. Checked = auto-detect from game.',
                checkedMeansAuto: true,
                disabledBy: 'enhanceSim_autoDetect',
            },
        },
    },

    enhancementTracker: {
        title: 'Enhancement Tracker',
        icon: '📊',
        settings: {
            enhancementTracker: {
                id: 'enhancementTracker',
                label: 'Enable Enhancement Tracker',
                type: 'checkbox',
                default: false,
                help: 'Track enhancement attempts, costs, and statistics',
            },
            enhancementTracker_showOnlyOnEnhancingScreen: {
                id: 'enhancementTracker_showOnlyOnEnhancingScreen',
                label: 'Show tracker only on Enhancing screen',
                type: 'checkbox',
                default: false,
                help: 'Hide tracker when not on the Enhancing screen',
                requires: 'enhancementTracker',
            },
            enhancementTracker_autoResume: {
                id: 'enhancementTracker_autoResume',
                label: 'Resume the last session when a run picks up where it ended',
                type: 'checkbox',
                default: false,
                help:
                    'A new enhancing run with the same item, target level and protect-from level as your latest ' +
                    'session, starting where it ended, adds to that session. Only active enhancing time counts. A ' +
                    'different protection item still resumes it unless the option below is off. Another copy of the ' +
                    'item also resumes it.',
                requires: 'enhancementTracker',
            },
            enhancementTracker_autoCombine: {
                id: 'enhancementTracker_autoCombine',
                label: 'Auto-resume also continues a run that uses a different protection item',
                type: 'checkbox',
                default: true,
                help: 'Works with auto-resume. When a new run matches the most recent session in everything except the protection item, it still continues that session, which lists the protection used per item. A different target, protect-from level or starting level starts a new session.',
                requires: 'enhancementTracker_autoResume',
            },
            enhancementXPH: {
                id: 'enhancementXPH',
                needsPrices: true,
                label: 'Enhancement: XPH calculator',
                type: 'checkbox',
                default: true,
                help: 'Ranks all enhanceable items by expected XP per hour at your current stats',
            },
            enhancementXPH_maxLevel: {
                id: 'enhancementXPH_maxLevel',
                label: 'Enhancement XPH: Default max enhancement level (1–20)',
                type: 'text',
                default: '6',
                requires: 'enhancementXPH',
            },
            enhancementXPH_protectFrom: {
                id: 'enhancementXPH_protectFrom',
                label: 'Enhancement XPH: Default protect from level (0 = no protection)',
                type: 'text',
                default: '0',
                requires: 'enhancementXPH',
            },
        },
    },

    riskOfRuin: {
        title: 'Risk of Ruin',
        icon: '🎲',
        settings: {
            riskOfRuin: {
                id: 'riskOfRuin',
                label: 'Enable Risk of Ruin calculator',
                type: 'checkbox',
                default: false,
                help: 'Adds a standalone calculator estimating the chance of hitting 0 gold before reaching a target number of dungeon chests, alchemy Transmute actions, or an enhancement level.',
            },
            riskOfRuin_showLauncher: {
                id: 'riskOfRuin_showLauncher',
                label: 'Risk of Ruin: Show the corner launcher button',
                type: 'checkbox',
                default: false,
                help: 'The "Risk of Ruin" button pinned to the bottom-right corner. Turn it off (or press its ✕) to get the corner back — the ⧉ Risk of Ruin tab beside Inventory still opens the calculator.',
                requires: 'riskOfRuin',
            },
            riskOfRuin_trials: {
                id: 'riskOfRuin_trials',
                label: 'Risk of Ruin: Monte Carlo trial count',
                type: 'text',
                default: '10000',
                help: 'Higher trial counts give a more precise probability estimate at the cost of a slower calculation.',
                requires: 'riskOfRuin',
            },
        },
    },

    marketplace: {
        title: 'Marketplace',
        icon: '🏪',
        settings: {
            sellQueue: {
                id: 'sellQueue',
                needsPrices: true,
                label: 'Sell Queue (Shift+RightClick inventory items)',
                type: 'checkbox',
                default: true,
                help: 'Shift+RightClick an inventory item to open the marketplace and create a tab for it. Tabs close automatically when the item sells out.',
            },
            networkAlert: {
                id: 'networkAlert',
                needsPrices: true,
                label: 'Show alert when market price data cannot be fetched',
                type: 'checkbox',
                default: true,
            },
            marketFilter: {
                id: 'marketFilter',
                needsPrices: true,
                label: 'Marketplace: Filter by level, class, slot',
                type: 'checkbox',
                default: true,
            },
            marketSort: {
                id: 'marketSort',
                needsPrices: true,
                label: 'Marketplace: Sort items by profitability',
                type: 'checkbox',
                default: true,
                help: 'Adds a button to sort marketplace items by profit/hour. Items without profit data (drop-only) appear at the end.',
                requiresRefresh: true,
            },
            marketSort_mode: {
                id: 'marketSort_mode',
                label: 'Marketplace: Sort mode',
                type: 'select',
                default: 'profit',
                options: [
                    { value: 'profit', label: 'Production/gathering profit per hour' },
                    { value: 'alchemyProfit', label: 'Alchemy profit per item' },
                    { value: 'alchemyProfitPerHour', label: 'Alchemy profit per hour' },
                    { value: 'decomposeChainPerHour', label: 'Full decompose chain per hour' },
                ],
                help: 'Which figure the marketplace sort button ranks by (the dropdown next to the button changes it too). Alchemy modes buy on your Buy side, run the best alchemy action and sell the outputs on your Sell side; the chain mode decomposes the item and what it yields, selling after tax.',
                requires: 'marketSort',
            },
            fillMarketOrderPrice: {
                id: 'fillMarketOrderPrice',
                needsPrices: true,
                label: 'Auto-fill marketplace orders with optimal price',
                type: 'checkbox',
                default: true,
            },
            market_raiseBuyPriceToCoverQuantity: {
                id: 'market_raiseBuyPriceToCoverQuantity',
                needsPrices: true,
                label: 'Auto-filled purchases: raise the price until it covers the whole quantity',
                type: 'checkbox',
                default: true,
                help:
                    'For Buy Now dialogs Toolasha auto-fills (missing materials, ability books, house costs, ' +
                    'consumables, shopping list and others), raises the price until listings cover the whole ' +
                    'quantity. Never exceeds the modal range, never lowers a price, never presses buy.',
            },
            market_autoFillSellStrategy: {
                id: 'market_autoFillSellStrategy',
                needsPrices: true,
                label: 'Auto-fill sell price strategy',
                type: 'select',
                default: 'match',
                options: [
                    { value: 'match', label: 'Match best sell price' },
                    { value: 'undercut', label: 'Undercut by 1 (best sell - 1)' },
                ],
                help: 'When creating sell listings, choose whether to match or undercut the current best sell price. Only the listing form uses this: profit estimates follow the Sell pricing dropdown and its −1 tick, set separately.',
            },
            market_autoFillBuyStrategy: {
                id: 'market_autoFillBuyStrategy',
                needsPrices: true,
                label: 'Auto-fill buy price strategy',
                type: 'select',
                // 'match' applies to new installs only. This deliberately has no
                // entry in settings-storage.js's DEFAULT_REWRITES: an existing
                // user's stored 'outbid' (the old shipped default) is their
                // strategy, not a value to be moved off of, so it is left alone.
                default: 'match',
                options: [
                    { value: 'outbid', label: 'Outbid by 1 (best buy + 1)' },
                    { value: 'match', label: 'Match best buy price' },
                    { value: 'undercut', label: 'Undercut by 1 (best buy - 1)' },
                ],
                help: 'When creating buy listings, choose whether to outbid, match, or undercut the current best buy price. Only the listing form uses this: profit estimates follow the Buy pricing dropdown and its +1 tick, set separately.',
            },
            market_autoClickMax: {
                id: 'market_autoClickMax',
                needsPrices: true,
                label: 'Auto-click Max button on sell listing dialogs',
                type: 'checkbox',
                default: true,
                help: 'Automatically clicks the Max button in the quantity field when opening Sell listing dialogs',
            },
            market_quickInputButtons: {
                id: 'market_quickInputButtons',
                needsPrices: true,
                label: 'Marketplace: Quick input buttons on order dialogs',
                type: 'checkbox',
                default: true,
                help: 'Adds 10, 100, 1000 preset quantity buttons to buy/sell dialogs',
            },
            market_quickInputButtons_presets: {
                id: 'market_quickInputButtons_presets',
                label: 'Marketplace: Custom quick input presets',
                type: 'text',
                default: '',
                help: 'Comma-separated preset values (e.g. 50,500,5000). Leave blank for defaults (10, 100, 1000). Max 8 values.',
                requires: 'market_quickInputButtons',
            },
            market_multiplierButtons: {
                id: 'market_multiplierButtons',
                needsPrices: true,
                label: 'Marketplace: ÷2 and ×2 buttons on order dialogs',
                type: 'checkbox',
                default: true,
                help: 'Adds ÷2 and ×2 buttons to the price and quantity rows in buy/sell dialogs',
            },
            market_showOwnedInBuyModal: {
                id: 'market_showOwnedInBuyModal',
                needsPrices: true,
                label: 'Marketplace: Show owned count in buy dialogs',
                type: 'checkbox',
                default: true,
                help: 'Displays how many of the item you currently own in Buy Now and Buy Listing modals',
            },
            market_instantOrderGap: {
                id: 'market_instantOrderGap',
                needsPrices: true,
                label: 'Marketplace: Warn when Buy Now / Sell Now is more than one price step from the best listing',
                type: 'checkbox',
                default: true,
                help: 'Adds a line to the Buy Now and Sell Now dialogs when the best sell and buy offers are two or more price steps apart, showing what the gap costs per item and for your quantity. Text only; silent when no recent order book has been seen. Read from English dialog titles.',
            },
            market_marketplaceShortcuts: {
                id: 'market_marketplaceShortcuts',
                needsPrices: true,
                label: 'Marketplace: Show "Marketplace Action" button on item menus',
                type: 'checkbox',
                default: true,
                help: 'Adds a Marketplace Action dropdown to item menus with Sell Now, Buy Now, and listing shortcuts',
            },
            market_visibleItemCount: {
                id: 'market_visibleItemCount',
                needsPrices: true,
                label: 'Market: Show inventory count on items',
                type: 'checkbox',
                default: true,
                help: 'Displays how many of each item you own when browsing the market',
            },
            market_visibleItemCountOpacity: {
                id: 'market_visibleItemCountOpacity',
                needsPrices: true,
                label: 'Market: Opacity for items not in inventory',
                type: 'slider',
                default: 0.25,
                min: 0,
                max: 1,
                step: 0.05,
                help: 'How transparent item tiles appear when you own zero of that item',
                requires: 'market_visibleItemCount',
            },
            market_visibleItemCountIncludeEquipped: {
                id: 'market_visibleItemCountIncludeEquipped',
                needsPrices: true,
                label: 'Market: Count equipped items',
                type: 'checkbox',
                default: true,
                help: 'Include currently equipped items in the displayed count',
                requires: 'market_visibleItemCount',
            },
            market_showListingPrices: {
                id: 'market_showListingPrices',
                needsPrices: true,
                label: 'Market: Show prices on individual listings',
                type: 'checkbox',
                default: true,
                help: 'Displays top order price and total value on each listing in My Listings table',
            },
            market_listingRefreshNavigator: {
                id: 'market_listingRefreshNavigator',
                needsPrices: true,
                label: 'Market: Show Refresh/Next buttons for cycling My Listings',
                type: 'checkbox',
                default: true,
                help:
                    'Adds a "Refresh" button on My Listings that opens your first listing\'s order book, then a ' +
                    '"Next" button on each listing\'s page to move to the next one, ending in "Back to My Listings"',
            },
            market_itemHop: {
                id: 'market_itemHop',
                needsPrices: true,
                label: 'Market: Step between items without going back to the list',
                type: 'checkbox',
                default: true,
                help: "On an item's marketplace page, [ and ] open the previous/next item from the grid you came from (respecting your filter), and Escape goes back to the grid. ◀ / ▶ buttons next to Refresh do the same. Stops at the ends of the list.",
            },
            market_collectableListingsToTop: {
                id: 'market_collectableListingsToTop',
                needsPrices: true,
                label: 'Market: Move collectable listings to top of My Listings',
                type: 'checkbox',
                default: true,
                help:
                    'Listings with something to collect are moved to the top so you can see what "Collect All" ' +
                    'grabbed without scrolling. Manually sorting a column takes over until sort is cleared',
            },
            market_listingDragOrder: {
                id: 'market_listingDragOrder',
                label: 'Market: Drag to arrange My Listings',
                type: 'checkbox',
                default: false,
                help:
                    'Adds a drag handle beside each My Listings status and remembers your visual order per ' +
                    'character. Clear any active column sort before dragging. This does not change server order.',
            },
            market_bulkSellAssistant: {
                id: 'market_bulkSellAssistant',
                label: 'Market: Bulk Sell Assistant',
                type: 'checkbox',
                default: false,
                help: 'Adds a Bulk Sell button to the marketplace tab bar (next to Market History) that opens a floating panel for selling tradable inventory, most valuable stack first, optionally one Toolasha inventory tab. One confirm click per item. Insta-sells per the rules below, otherwise posts a sell listing.',
            },
            market_bulkSellQueueDays: {
                id: 'market_bulkSellQueueDays',
                label: 'Market: Bulk sell insta-sell queue age (days)',
                type: 'number',
                default: 2,
                min: 0,
                max: 30,
                help: 'If the oldest sell listing on an item has been waiting longer than this many days (the queue is not moving), the Bulk Sell Assistant insta-sells to the best bid instead of joining the queue. 0 turns this rule off. Default: 2.',
                requires: 'market_bulkSellAssistant',
            },
            market_bulkSellSupplyRatio: {
                id: 'market_bulkSellSupplyRatio',
                label: 'Market: Bulk sell insta-sell supply ratio',
                type: 'number',
                default: 1,
                min: 0,
                max: 100,
                help: 'Insta-sell when sell-order supply exceeds buy-order demand × this ratio. 1 = insta-sell whenever sell orders outnumber buy orders; 2 = only when supply is at least double demand; 0 turns this rule off (only the queue-age rule insta-sells). Default: 1.',
                requires: 'market_bulkSellAssistant',
            },
            market_bulkSellMaxSpreadPct: {
                id: 'market_bulkSellMaxSpreadPct',
                label: 'Market: Bulk sell insta-sell when the spread is under (%)',
                type: 'number',
                default: 0,
                min: 0,
                max: 100,
                help: 'Insta-sell when the gap between best ask and best bid is at most this percentage of the ask, since a listing earns only a sliver more. E.g. 2 insta-sells when ask and bid are within 2%. 0 turns this rule off. Default: 0.',
                requires: 'market_bulkSellAssistant',
            },
            market_bulkSellMinPatientPremium: {
                id: 'market_bulkSellMinPatientPremium',
                label: 'Market: Bulk sell insta-sell when a listing earns under (coins)',
                type: 'number',
                default: 0,
                min: 0,
                help: 'Insta-sell when waiting in the sell queue would earn less than this many coins over selling now: (ask − bid) × count, after market tax. 0 turns this rule off. Default: 0.',
                requires: 'market_bulkSellAssistant',
            },
            consumables_labPerRunBasis: {
                id: 'consumables_labPerRunBasis',
                label: 'Consumables: Labyrinth per-run basis',
                type: 'select',
                default: 'measured',
                options: [
                    { value: 'measured', label: 'Measured from recorded runs' },
                    { value: 'capacity', label: 'Full capacity every run' },
                ],
                help:
                    'What one labyrinth run is planned to consume: the average your recorded runs actually spent, ' +
                    'or the whole torch/shroud/beacon capacity every run. Also a click on the basis pill in the panel.',
            },
            consumables_idleLoadoutPlan: {
                id: 'consumables_idleLoadoutPlan',
                needsPrices: true,
                label: 'Consumables: plan from the default loadout while idle',
                type: 'checkbox',
                default: true,
                help: "With no combat being measured, the Consumables panel plans from the default combat loadout: drinks rated from buff duration and drink concentration, food rated from the last combat sim's measured use for that zone, or listed unrated until a sim has run.",
            },
            market_consumableBuyMaxSpreadPct: {
                id: 'market_consumableBuyMaxSpreadPct',
                label: 'Market: Consumables buy instantly when the spread is under (%)',
                type: 'number',
                default: 2,
                min: 0,
                max: 100,
                help: 'The bulk-sell spread rule, for restocking: when the gap between best ask and best bid is at most this percentage of the ask, the Consumables panel recommends buying instantly. 0 turns this rule off. Default: 2.',
            },
            market_consumableBuyMinSaving: {
                id: 'market_consumableBuyMinSaving',
                label: 'Market: Consumables buy instantly when an order saves under (coins)',
                type: 'number',
                default: 0,
                min: 0,
                help: 'The same idea in absolute coins: what the whole restock would save by waiting at the bid instead of paying the ask — (ask − bid) × count. Under this amount the Consumables panel recommends buying instantly. 0 turns this rule off. Default: 0.',
            },
            market_consumableBuyMinOrderValue: {
                id: 'market_consumableBuyMinOrderValue',
                label: 'Market: Consumables minimum order value for a buy order',
                type: 'number',
                default: 0,
                min: 0,
                help: 'Restocks whose whole order (bid × count) is worth less than this are recommended as instant buys rather than using up a buy-order slot. 0 turns this rule off. Default: 0.',
            },
            market_consumableBuyInstantWithinHours: {
                id: 'market_consumableBuyInstantWithinHours',
                label: 'Market: Consumables buy instantly when it runs out within (hours)',
                type: 'number',
                default: 24,
                min: 0,
                help: 'When an item is out, or its stock runs out within this many hours, the Consumables panel recommends buying instantly rather than waiting on a buy order. 0 turns this rule off. Default: 24.',
            },
            market_consumableBuyOpenRecommended: {
                id: 'market_consumableBuyOpenRecommended',
                needsPrices: true,
                label: 'Market: Consumables buy links open the recommended order form',
                type: 'checkbox',
                default: true,
                help:
                    'A Buy link in the Consumables panel opens the order form its recommendation points at (Buy Now ' +
                    "or New Buy Listing), quantity filled in. Nothing is bought until you confirm. The Buy all walk's " +
                    'Buy button needs this on and is unavailable for Iron Cow. Off, it opens the item in the ' +
                    'marketplace.',
            },
            market_bulkSellVendorCheck: {
                id: 'market_bulkSellVendorCheck',
                label: 'Market: Bulk sell to vendor when market is no better',
                type: 'checkbox',
                default: true,
                help: "When the vendor pays at least as much as the market after tax, the Bulk Sell Assistant opens the item's inventory menu with All selected, so one click vendors the stack. Unenhanced items only.",
                requires: 'market_bulkSellAssistant',
            },
            market_bulkSellMinListingValue: {
                id: 'market_bulkSellMinListingValue',
                label: 'Market: Bulk sell minimum stack value for a sell listing',
                type: 'number',
                default: 1500000,
                min: 0,
                help: 'Stacks worth less than this (count × ask price) are insta-sold to the best bid instead of using up a sell listing slot. 0 turns this rule off. Default: 1,500,000.',
                requires: 'market_bulkSellAssistant',
            },
            market_bulkSellHoldFavorites: {
                id: 'market_bulkSellHoldFavorites',
                label: 'Market: Bulk sell holds back items marked Favorite',
                type: 'checkbox',
                default: true,
                help: 'The Bulk Sell Assistant never sells items you have marked Favorite in the game. Off: Favorite items are sold like any other item. Food and drinks used by your saved loadouts are always held back.',
                requires: 'market_bulkSellAssistant',
            },
            market_tradeHistory: {
                id: 'market_tradeHistory',
                needsPrices: true,
                label: 'Market: Show personal trade history',
                type: 'checkbox',
                default: true,
                help: 'Displays your last buy/sell prices in the marketplace, including how long ago each price was recorded.',
            },
            market_tradeHistoryComparisonMode: {
                id: 'market_tradeHistoryComparisonMode',
                needsPrices: true,
                label: 'Market: Trade history comparison mode',
                type: 'select',
                default: 'instant',
                options: [
                    { value: 'instant', label: 'Instant' },
                    { value: 'listing', label: 'Orders' },
                ],
                help: 'Instant: Compare to instant buy/sell prices. Orders: Compare to buy/sell orders.',
                requires: 'market_tradeHistory',
            },
            market_tradeLedger: {
                id: 'market_tradeLedger',
                needsPrices: true,
                label: 'Market: Record trade ledger (realized flip profit)',
                type: 'checkbox',
                default: true,
                help: 'Records every fill on your own listings (partial fills included) and adds a Ledger tab to the marketplace with per-item realized profit (sells matched against your average buy cost, net of market tax), weekly totals and CSV export.',
            },
            market_staleCapital: {
                id: 'market_staleCapital',
                needsPrices: true,
                label: 'Market: Show stale capital tab',
                type: 'checkbox',
                default: true,
                help: 'Adds a "Stale" tab to the marketplace ranking your open sell listings and buy orders by coins tied up, with each row\'s age and how its price compares to the current book.',
            },
            market_overbidPanel: {
                id: 'market_overbidPanel',
                needsPrices: true,
                label: 'Market: Show overbid table',
                type: 'checkbox',
                default: true,
                help:
                    'Opens a small movable table when a listing of yours is beaten, showing the price that beats you ' +
                    'and your own. With "Market: Price history panel" on, it also asks the "Market: Price history ' +
                    'data source" server (q7.nainai.eu.org or mooket.qi-e.top) about your listings.',
            },
            market_listingPricePrecision: {
                id: 'market_listingPricePrecision',
                needsPrices: true,
                label: 'Market: Listing price decimal precision',
                type: 'number',
                default: 1,
                min: 0,
                max: 4,
                help: 'Decimal places for the abbreviated Top Order and Total prices on My Listings (e.g. 1.2M vs 1.23M)',
            },
            market_listingAge: {
                id: 'market_listingAge',
                needsPrices: true,
                label: 'Market: Where to show listing age',
                type: 'select',
                default: 'both',
                // What "disabled" means for this row — see iron-cow-mode.js
                offValue: 'off',
                options: [
                    { value: 'off', label: 'Nowhere' },
                    { value: 'myListings', label: 'My Listings only' },
                    { value: 'orderBook', label: 'Order book only' },
                    { value: 'both', label: 'Both' },
                ],
                help:
                    'Shows how old each listing is, on the order book (estimated) and/or on My Listings, where it ' +
                    'adds "Listed" and "Top Order Age" columns. Those columns need "Market: Show prices on individual ' +
                    'listings" on. The format below applies to all of them.',
            },
            market_badgeOnlyWhenFinished: {
                id: 'market_badgeOnlyWhenFinished',
                label: 'Market: Sidebar badge only for finished listings',
                type: 'checkbox',
                default: false,
                help: 'Limits the Marketplace sidebar badge to finished listings (filled completely, or canceled and holding a refund), instead of the game badging anything collectable, such as a partly filled buy order. The badge on the My Listings tab is left alone.',
            },
            market_pooledHistory: {
                id: 'market_pooledHistory',
                label: 'Market: Price history panel',
                type: 'checkbox',
                default: false,
                help: "Adds a History tab to the marketplace: a floating chart of an item's ask, bid, average traded price and volume over the last day to six months, plus pinned items. Uses the pooled dataset the mooket project (by Q7, MIT) maintains at q7.nainai.eu.org. Off until you turn it on: it tells that server which items you look up and sends back the order books you open.",
            },
            market_volumeStats: {
                id: 'market_volumeStats',
                needsPrices: true,
                label: 'Market: 1d/3d/5d trade stats on the order book',
                type: 'checkbox',
                default: true,
                help: 'Pins a table to the current-item card on the order book: average price, median price, volume and an estimated buy/sell split over the last 1, 3 and 5 days. Ported from the "交易量显示" (Trade Volume Display) userscript by baozhi & SukiSukiDaiSuki (CC-BY-NC-SA-4.0). Needs "Market: Price history panel" on.',
                requires: 'market_pooledHistory',
            },
            market_historySource: {
                id: 'market_historySource',
                label: 'Market: Price history data source',
                type: 'select',
                default: 'mooket2',
                options: [
                    { value: 'mooket2', label: 'mooket II \u2014 Q7 (q7.nainai.eu.org)' },
                    { value: 'mooket1', label: 'mooket I \u2014 IOMisaka (mooket.qi-e.top)' },
                ],
                help: 'Which pooled server the price history, pinned-item prices and My Listings "Mooket Refresh" read from, and the one your opened order books are sent to. mooket II (default) has ask, bid, average traded price and volume. mooket I has only ask and bid: the chart\'s third line is a computed "Mid", with no volume bars, and the goal planner\'s volume limits switch off. Both are third parties, governed by the switch above.',
            },
            market_historyVolumeFromMooket2: {
                id: 'market_historyVolumeFromMooket2',
                label: 'Market: With mooket I, also fetch volume from mooket II (q7.nainai.eu.org)',
                type: 'checkbox',
                default: false,
                help: "With mooket I picked above, also asks mooket II (q7.nainai.eu.org) for trade volume and draws it under mooket I's prices. This calls a second third-party server, so it is off until you turn it on; it tells that server which items you look up. If it can't be reached, prices show with no volume, never zero.",
                requires: 'market_pooledHistory',
            },
            market_historyBaseValue: {
                id: 'market_historyBaseValue',
                label: "Price history: show the game's base value in the chart tooltip",
                type: 'checkbox',
                default: true,
                help: 'Adds a "Base value" line to the price history chart tooltip: the game\'s base market value for that day (the median of the day\'s readings on longer ranges). Shown only when the history server sends it. Needs the price history panel.',
                requires: 'market_pooledHistory',
            },
            market_listingAgeFormat: {
                id: 'market_listingAgeFormat',
                needsPrices: true,
                label: 'Market: Listing age display format',
                type: 'select',
                default: 'datetime',
                options: [
                    { value: 'elapsed', label: 'Elapsed Time (e.g., "3h 45m")' },
                    { value: 'datetime', label: 'Date/Time (e.g., "01-13 14:30")' },
                ],
                help: 'How every listing age above is written — on the order book and on My Listings alike',
                requires: 'market_listingAge',
            },
            market_listingTimeFormat: {
                id: 'market_listingTimeFormat',
                label: 'Time format for date/time display',
                type: 'select',
                default: 'auto',
                options: [
                    { value: 'auto', label: "Automatic (match this device's clock)" },
                    { value: '24hour', label: '24-hour (14:30)' },
                    { value: '12hour', label: '12-hour (2:30 PM)' },
                ],
                help: "Time format used for every date and time Toolasha shows, including chat timestamps when that setting is on. Automatic follows each device's own clock and is resolved separately per device.",
            },
            market_listingDateFormat: {
                id: 'market_listingDateFormat',
                label: 'Date format for date/time display',
                type: 'select',
                default: 'MM-DD',
                options: [
                    { value: 'MM-DD', label: 'MM-DD (01-13)' },
                    { value: 'DD-MM', label: 'DD-MM (13-01)' },
                ],
                help: 'Date format used in marketplace listings, action completion times, and chat timestamps',
            },
            market_showOrderTotals: {
                id: 'market_showOrderTotals',
                needsPrices: true,
                label: 'Market: Show order totals in header',
                type: 'checkbox',
                default: true,
                help: 'Displays buy orders (BO), sell orders (SO), and unclaimed coins (💰) in the header area below gold',
            },
            market_showHistoryViewer: {
                id: 'market_showHistoryViewer',
                needsPrices: true,
                label: 'Market: Show history viewer button in settings',
                type: 'checkbox',
                default: true,
                help: 'Adds "View Market History" button to settings panel for viewing and exporting all market listing history',
            },
            market_showPhiloCalculator: {
                id: 'market_showPhiloCalculator',
                needsPrices: true,
                label: 'Market: Show Philo Gamba calculator button in settings',
                type: 'checkbox',
                default: true,
                help: 'Adds "Philo Gamba" button to settings panel for calculating transmutation ROI into Philosopher\'s Stones',
            },
            market_showQueueLength: {
                id: 'market_showQueueLength',
                needsPrices: true,
                label: 'Market: Show queue length estimates',
                type: 'checkbox',
                default: true,
                help: 'Displays total quantity at best price below Buy/Sell buttons. Estimated values (20+ orders at same price) are shown in a different color.',
            },
            market_depthCapEnabled: {
                id: 'market_depthCapEnabled',
                needsPrices: true,
                label: 'Market: Show sell depth cap (Risk of Ruin)',
                type: 'checkbox',
                default: true,
                help: "Shows how many actions worth of the currently-viewed item the order book can profitably absorb, based on the last Risk of Ruin calculation. Ignores the marketplace's tradable range floor, which isn't exposed in game data.",
            },
            market_enhanceProfitPerHour: {
                id: 'market_enhanceProfitPerHour',
                needsPrices: true,
                label: 'Market: Show enhance-to-sell Profit/h on enhanced order books',
                type: 'checkbox',
                default: true,
                help: "On the order book of an enhanced (+1 and up) item, adds a Profit/h column to sell listings: profit per hour of enhancing the base item to that level yourself and selling at that row's ask after tax. Uses your own enhancing stats and the cheapest protection strategy; hover for the breakdown.",
            },
        },
    },

    pricingProfit: {
        title: 'Pricing & Profit',
        icon: '💹',
        settings: {
            // The Buy and Sell dropdowns are a view over the three settings
            // below, which stay exactly as they are: the mode and the two
            // per-side ticks. Their own rows are hidden rather than deleted —
            // the schema entry is what gives each key its default, its stored
            // shape and its place in an export, and a row is not a setting.
            //
            // Two dropdowns instead of a mode plus two checkboxes because each
            // checkbox is a no-op in two of the four modes (with the shipped
            // 'hybrid' the buy tick can never move a number) and nothing said
            // so. `createPricingSideSelect` is the same control the skill
            // toolbar and alchemy Best Items carry, so there is one
            // implementation of the choice rather than three.
            profitCalc_pricingSideBuy: {
                id: 'profitCalc_pricingSideBuy',
                label: 'Buy pricing: instant, patient, or patient +1 tick',
                type: 'pricingSide',
                side: 'buy',
                help:
                    'How purchases are priced everywhere profit is shown. Ask (instant buy) takes the ask. Bid ' +
                    '(patient buy) assumes a buy order at the bid. Bid +1 assumes one tick above the bid, never ' +
                    'crossing the spread. With the Sell dropdown it sets the pricing mode. Listing auto-fill is ' +
                    'separate.',
            },
            profitCalc_pricingSideSell: {
                id: 'profitCalc_pricingSideSell',
                label: 'Sell pricing: instant, patient, or patient −1 tick',
                type: 'pricingSide',
                side: 'sell',
                help:
                    'How sales are priced everywhere profit is shown. Bid (instant sell) takes the bid. Ask (patient ' +
                    'sell) assumes a sell order at the ask. Ask −1 assumes one tick below the ask, never crossing the ' +
                    'spread. With the Buy dropdown it sets the pricing mode. Listing auto-fill is separate.',
            },
            profitCalc_pricingMode: {
                id: 'profitCalc_pricingMode',
                needsPrices: true,
                label: 'Profit calculation pricing mode',
                type: 'select',
                default: 'hybrid',
                // Shown as the Buy and Sell dropdowns above
                hidden: true,
                options: [
                    { value: 'conservative', label: 'Buy: Ask / Sell: Bid (Instant Buy / Instant Sell)' },
                    { value: 'hybrid', label: 'Buy: Ask / Sell: Ask (Instant Buy / Patient Sell)' },
                    { value: 'optimistic', label: 'Buy: Bid / Sell: Ask (Patient Buy / Patient Sell)' },
                    { value: 'patientBuy', label: 'Buy: Bid / Sell: Bid (Patient Buy / Instant Sell)' },
                ],
            },
            untradableCapeBaseValue: {
                id: 'untradableCapeBaseValue',
                label: 'Untradable capes: base value',
                type: 'select',
                default: 'zero',
                options: [
                    { value: 'zero', label: 'Nothing (0)' },
                    { value: 'mirror', label: 'Same as a Mirror of Protection' },
                    { value: 'decompose', label: 'Its decompose value' },
                ],
                help:
                    'Capes cannot be traded. Sets what an unrefined cape is worth in alchemy, enhancement, net worth ' +
                    'and chests, and what the base adds to a refined (★) cape: nothing, a Mirror of Protection, or ' +
                    'its decompose value after tax. Nothing counts an unrefined cape as 0; that or a missing price ' +
                    'marks a floor.',
            },
            profitCalc_patientTickBuy: {
                id: 'profitCalc_patientTickBuy',
                needsPrices: true,
                label: 'Patient buys: +1 tick',
                type: 'checkbox',
                default: false,
                // Shown as the Buy dropdown above
                hidden: true,
                help:
                    'When the pricing mode above buys at the bid, assumes you jump the queue: a patient buy is priced one ' +
                    'market tick above the bid. Instant buys are unchanged and the tick never crosses the spread. Turn on ' +
                    'to match outbidding by 1 when listing.',
            },
            profitCalc_patientTickSell: {
                id: 'profitCalc_patientTickSell',
                needsPrices: true,
                label: 'Patient sells: −1 tick',
                type: 'checkbox',
                default: false,
                // Shown as the Sell dropdown above
                hidden: true,
                help:
                    'When the pricing mode above sells at the ask, assumes you jump the queue: a patient sell is priced ' +
                    'one market tick below the ask. Instant sells are unchanged and the tick never crosses the spread. ' +
                    'Turn on to match undercutting by 1 when listing.',
            },
            pricing_testerShop: {
                id: 'pricing_testerShop',
                label: 'Test server: price purchases from the Tester shop',
                type: 'checkbox',
                default: false,
                hidden: !isTestServer(),
                help:
                    'Test server only. Buy-side prices floor at the Tester shop’s coin prices (house materials, ability ' +
                    'books, enhancement materials), and the simulators’ Upgrade tabs price equipment as bought from the ' +
                    'shop at +10 and mirrored up with Philosopher’s Mirrors beyond that.',
            },
            pricing_useLivePrices: {
                id: 'pricing_useLivePrices',
                label: 'Use live-server prices on the test server',
                type: 'checkbox',
                default: false,
                requiresRefresh: true,
                hidden: !isTestServer(),
                help: "On the test server, price everything from the live server's market instead of the test server's (your own test listings are unaffected). Applies to every character on this device. Takes effect on reload.",
            },
            profitCalc_ironCowValuation: {
                id: 'profitCalc_ironCowValuation',
                label: 'Iron Cow: value items at',
                type: 'select',
                default: 'market',
                ironCowOnly: true,
                options: [
                    { value: 'market', label: 'Market price (ask / bid)' },
                    { value: 'vendor', label: 'Vendor sell price' },
                    { value: 'best', label: 'Better of vendor price and coinify' },
                ],
                help:
                    'Iron Cow characters only, saved per character. Values loot, inventory, net worth and profit at ' +
                    "an item's vendor price, or the better of that and its coinify yield. Buying and selling use the " +
                    'same figure. Custom prices still win. Enhanced items and items with neither value keep market ' +
                    'price.',
            },
            profitCalc_pricingNaming: {
                id: 'profitCalc_pricingNaming',
                needsPrices: true,
                label: 'Pricing mode naming convention',
                type: 'checkbox',
                default: false,
                help: 'Show pricing modes as "Instant Buy / Instant Sell" instead of "Buy: Ask / Sell: Bid"',
            },
            profitCalc_keyPricingMode: {
                id: 'profitCalc_keyPricingMode',
                needsPrices: true,
                label: 'Key pricing mode',
                type: 'select',
                default: 'ask',
                options: [
                    { value: 'ask', label: 'Ask (instant buy)' },
                    { value: 'bid', label: 'Bid (patient buy)' },
                    { value: 'synced', label: 'Same as the profit calculation pricing mode' },
                    { value: 'craft', label: 'What it costs you to craft one' },
                ],
                help:
                    'How a dungeon key is valued wherever it is priced. Ask and Bid use that market price. "What it ' +
                    'costs you to craft one" uses your crafting cost, or market price if you cannot craft it or a ' +
                    'material is unpriced. "Same as the profit calculation pricing mode" follows its buy side and ' +
                    'patient tick.',
            },
            profitCalc_liquidityCap: {
                id: 'profitCalc_liquidityCap',
                needsPrices: true,
                label: 'Profit: Cap displayed rates by market volume',
                type: 'checkbox',
                default: true,
                help:
                    'Bounds profit/hr figures (alchemy Best Items, action bar, pinned actions, the all-zones combat ' +
                    'table) by how fast each output actually trades, using pooled market history. Capped figures ' +
                    'carry a "vol-capped" marker. Needs the Market price history panel to have data. Turn off to see ' +
                    'raw rates.',
            },
            profitCalc_customPriceOverrides: {
                id: 'profitCalc_customPriceOverrides',
                label: 'Custom price overrides',
                type: 'customPriceOverrides',
                default: {},
                help: 'Set custom buy/sell prices for specific items. Overrides marketplace prices in profit calculations.',
            },
            profitCalc_craftUpgradeItems: {
                id: 'profitCalc_craftUpgradeItems',
                needsPrices: true,
                label: 'Profit: Use crafting cost for upgrade items if cheaper',
                type: 'checkbox',
                default: true,
                help: 'When enabled, uses crafting cost instead of market price for upgrade items if cheaper, and factors crafting time into profit/hr calculations.',
            },
            profitCalc_excludeSellTax: {
                id: 'profitCalc_excludeSellTax',
                label: 'Profit: Exclude sell tax (producing for personal use)',
                type: 'checkbox',
                default: false,
                help:
                    'Profit figures on skill pages and the action bar assume you keep what you make, so no sell tax ' +
                    'is deducted. Use for self-used goods. Figures run higher than selling earns; a warning marker ' +
                    'shows. Item tooltips follow it; task cards, market sort, alchemy and the planner still value ' +
                    'output as a sale.',
            },
            offlineProgressEconomics: {
                id: 'offlineProgressEconomics',
                needsPrices: true,
                label: 'Offline Progress: Show Revenue/Cost/Profit summary',
                type: 'checkbox',
                default: true,
                help:
                    'Adds a Revenue/Cost/Profit summary (with per-day projections, each side expandable into items) to ' +
                    'the Welcome Back modal, priced with your Pricing & Profit settings, plus an Experience row with ' +
                    'XP/hr when the modal reports any.',
            },
        },
    },

    inventoryNetWorth: {
        title: 'Inventory & Net Worth',
        icon: '💎',
        settings: {
            networth: {
                id: 'networth',
                needsPrices: true,
                label: 'Net worth tracking (and gold count in the header)',
                type: 'checkbox',
                default: true,
                help: 'Master switch for the net worth calculator. Displays your current gold count next to Total Level in the page header; the inventory breakdown, history chart, and overlay rows below all need this on to have data',
                requiresRefresh: true,
            },
            invWorth: {
                id: 'invWorth',
                needsPrices: true,
                label: 'Below inventory: Show net worth breakdown',
                type: 'checkbox',
                default: true,
                help: 'Shows total net worth with a per-category breakdown (equipment, inventory, listings, houses, abilities) below the inventory panel. Requires net worth tracking to be enabled above',
                requires: 'networth',
            },
            invSort: {
                id: 'invSort',
                label: 'Sort inventory items by value',
                type: 'checkbox',
                default: true,
            },
            inv_valueBadges: {
                id: 'inv_valueBadges',
                needsPrices: true,
                label: 'Value badges on inventory items',
                type: 'select',
                default: 'sorting',
                // What "disabled" means for this row — see iron-cow-mode.js. The
                // default is no longer the off value, now that it defaults to 'sorting'.
                offValue: 'off',
                options: [
                    { value: 'off', label: 'None' },
                    { value: 'sorting', label: 'Stack value, only while sorting by Ask/Bid' },
                    { value: 'alwaysAsk', label: 'Stack value always (Ask when not sorting)' },
                    { value: 'alwaysBid', label: 'Stack value always (Bid when not sorting)' },
                    { value: 'prices', label: 'Per-item ask and bid prices on the icons' },
                ],
                help:
                    'Stack value is one number per stack, priced on the side you sort by. With no sort it shows only ' +
                    'for the two "always" choices (Ask or Bid); None hides it. Per-item ask and bid prices is the ' +
                    'other badge, two small unit prices on the icon, and overlaps it. Custom-tab and category totals ' +
                    'always show.',
            },
            invSort_netOfTax: {
                id: 'invSort_netOfTax',
                needsPrices: true,
                label: 'Show badge values net of market tax',
                type: 'checkbox',
                default: false,
                // No `requires`: the value badges are only one reader. The inventory category totals,
                // the custom-tab section totals and the sort order read the same tax-adjusted values
                // with badges set to None.
                help: 'Takes the market sales tax off every value the inventory shows: the stack badges, the category and custom-tab totals, and the sort order. Applies even when value badges are set to None',
            },
            invSort_sortEquipment: {
                id: 'invSort_sortEquipment',
                label: 'Enable sorting for Equipment category',
                type: 'checkbox',
                default: false,
                requires: 'invSort',
            },
            invSort_collapseAll: {
                id: 'invSort_collapseAll',
                label: 'Show a Collapse all / Expand all button in the inventory',
                type: 'checkbox',
                default: true,
                help: 'Adds a button next to the sort buttons that folds every category heading of the inventory tab you are looking at, or opens them all again',
                requires: 'invSort',
            },
            invCategoryTotals: {
                id: 'invCategoryTotals',
                needsPrices: true,
                label: 'Show category totals in inventory',
                type: 'checkbox',
                default: true,
                help: 'Displays the total market value of all items in each inventory category, and on each custom-tab section and the Unorganized bucket',
            },
            networth_valueSource: {
                id: 'networth_valueSource',
                label: 'Net worth value source',
                type: 'select',
                default: 'orderBook',
                options: [
                    { value: 'orderBook', label: 'Order book (ask/bid, by pricing mode below)' },
                    { value: 'officialValue', label: "Game's market value (matches inventory tooltip)" },
                ],
                help:
                    'Order book prices items live using the pricing mode below. Game value uses the figure behind the ' +
                    'inventory Total Market Value (about hourly), so the total matches the game; it applies at every ' +
                    'enhancement level and ignores the enhancement-cost setting. Iron Cow valuation outranks it.',
            },
            networth_pricingMode: {
                id: 'networth_pricingMode',
                label: 'Net worth pricing mode',
                type: 'select',
                default: 'ask',
                options: [
                    { value: 'ask', label: 'Ask price (patient sell value)' },
                    { value: 'bid', label: 'Bid price (instant liquidation value)' },
                ],
                help: "Ask shows what you could get by listing patiently. Bid shows what you could get by selling instantly. Ignored when the value source above is set to the game's market value.",
            },
            networth_highEnhancementUseCost: {
                id: 'networth_highEnhancementUseCost',
                needsPrices: true,
                label: 'Use enhancement cost for highly enhanced items',
                type: 'checkbox',
                default: true,
                help: 'Market prices are unreliable for highly enhanced items (+13 and above). Use calculated enhancement cost instead. Has no effect on items the game publishes a value for when the value source is set to the game market value.',
            },
            networth_highEnhancementMinLevel: {
                id: 'networth_highEnhancementMinLevel',
                needsPrices: true,
                label: 'Minimum enhancement level to use cost',
                type: 'select',
                default: 13,
                options: [
                    { value: 10, label: '+10 and above' },
                    { value: 11, label: '+11 and above' },
                    { value: 12, label: '+12 and above' },
                    { value: 13, label: '+13 and above (recommended)' },
                    { value: 15, label: '+15 and above' },
                ],
                help: 'Enhancement level at which to stop trusting market prices',
            },
            networth_includeCowbells: {
                id: 'networth_includeCowbells',
                needsPrices: true,
                label: 'Include cowbells in net worth',
                type: 'checkbox',
                default: false,
                help: 'Cowbells are not tradeable, but they have a value based on Bag of 10 Cowbells market price',
                requires: 'networth',
            },
            networth_includeTaskTokens: {
                id: 'networth_includeTaskTokens',
                needsPrices: true,
                label: 'Include task tokens in net worth',
                type: 'checkbox',
                default: true,
                help: 'Value task tokens based on expected value from Task Shop chests. Disable to exclude them from net worth.',
                requires: 'networth',
            },
            networth_includeLabyrinthTokens: {
                id: 'networth_includeLabyrinthTokens',
                needsPrices: true,
                label: 'Include labyrinth tokens and scrolls in net worth and inventory totals',
                type: 'checkbox',
                default: false,
                help:
                    'Values labyrinth tokens at the best gold per token the Labyrinth Shop converts them into (the figure ' +
                    'their tooltip shows), and seal scrolls at the tokens each costs there. Applies to net worth and ' +
                    'inventory values and totals. Off leaves them out.',
                requires: 'networth',
            },
            networth_includeGuildTokens: {
                id: 'networth_includeGuildTokens',
                needsPrices: true,
                label: 'Include guild tokens in net worth',
                type: 'checkbox',
                default: false,
                help: 'Value guild tokens you hold through the Guild Shop credit exchange (credits per token × the gold value of a credit). Tokens already spent on shrine levels are not counted. Disable to exclude them from net worth.',
                requires: 'networth',
            },
            networth_includeGuildCredits: {
                id: 'networth_includeGuildCredits',
                needsPrices: true,
                label: 'Value guild credits (net worth, inventory totals)',
                type: 'checkbox',
                default: true,
                help: 'Guild Credits cannot be sold, so each is valued at the cheapest tradeable item that converts into it. Disable to leave them out of net worth and inventory totals.',
            },
            networth_abilityBooksAsInventory: {
                id: 'networth_abilityBooksAsInventory',
                needsPrices: true,
                label: 'Count ability books as inventory (Current Assets)',
                type: 'checkbox',
                default: true,
                help: 'Move ability books from Fixed Assets to Current Assets inventory value. Useful if you plan to sell them.',
                requires: 'networth',
            },
            networth_historyChart: {
                id: 'networth_historyChart',
                needsPrices: true,
                label: 'Enable net worth history chart',
                type: 'checkbox',
                default: true,
                help: 'Records hourly net worth snapshots and shows a chart icon next to Total Net Worth. Disable to stop tracking and hide the chart button.',
                requires: 'networth',
            },
            networth_forecast: {
                id: 'networth_forecast',
                label: 'Enable net worth forecast',
                type: 'checkbox',
                default: false,
                help:
                    'Adds a collapsed Forecast section to the net worth history chart: a Monte Carlo projection as a ' +
                    'p10–p90 fan to 30, 60 or 90 days, with drift, volatility, doubling time and the odds of reaching a ' +
                    'target you set. Needs the history chart enabled.',
            },
            networth_goldSources: {
                id: 'networth_goldSources',
                needsPrices: true,
                label: 'Enable gold source attribution',
                type: 'checkbox',
                default: true,
                help:
                    'Adds a 💰 button beside Net Worth that splits your net worth change by activity (combat drops, ' +
                    'gathering, production, alchemy, enhancing, marketplace, offline) and shows what is left unexplained. ' +
                    'Also records production and offline income per day.',
                requires: 'networth',
            },
            autoAllButton: {
                id: 'autoAllButton',
                label: 'Auto-click "All" button when opening loot boxes',
                type: 'checkbox',
                default: true,
                help: 'Automatically clicks the "All" button when opening openable containers (crates, chests, caches)',
            },
            autoAllButton_excludeSeals: {
                id: 'autoAllButton_excludeSeals',
                label: 'Auto-click "All": Skip Scroll of... items',
                type: 'checkbox',
                default: true,
                help: 'When enabled, Scroll of... items from the Labyrinth are not auto-opened',
                requires: 'autoAllButton',
            },
            scrollPlanner: {
                id: 'scrollPlanner',
                needsPrices: true,
                label: 'Scroll Planner: plan and step through opening scrolls',
                type: 'checkbox',
                default: true,
                help:
                    'Adds a "Plan scrolls" button to Scroll of... item menus. Choose how many of each scroll to open and ' +
                    'you are walked through them one at a time: the quantity is filled in and Open highlighted, and you ' +
                    'press Open yourself. Your last plan loads on any character.',
            },
        },
    },

    inventoryTabs: {
        title: 'Custom Inventory Tabs',
        icon: '🗂️',
        settings: {
            inventoryTabs: {
                id: 'inventoryTabs',
                label: 'Custom Inventory Tabs: Enable',
                type: 'checkbox',
                default: true,
                help: 'Adds a Toolasha tab to the character panel where you can organize inventory items into personal tabs.',
                requiresRefresh: true,
            },
            inventoryTabs_showUnorganized: {
                id: 'inventoryTabs_showUnorganized',
                label: 'Custom Inventory Tabs: Show Unorganized bucket',
                type: 'checkbox',
                default: true,
                help: 'Show an "Unorganized" section containing all items not assigned to any tab.',
                requires: 'inventoryTabs',
            },
            inventoryTabs_categoryAddAll: {
                id: 'inventoryTabs_categoryAddAll',
                label: 'Custom Inventory Tabs: Add all items when adding category',
                type: 'checkbox',
                default: false,
                hidden: true,
                help: 'When adding a category to a tab, add every item in that category (including items not in your inventory). When disabled, only items currently in your inventory are added.',
                requires: 'inventoryTabs',
            },
            inventoryTabs_defaultTab: {
                id: 'inventoryTabs_defaultTab',
                label: 'Custom Inventory Tabs: Show Toolasha tab by default',
                type: 'checkbox',
                default: false,
                help: 'Opens the inventory on the Toolasha tab. Where the inventory has its own tab row, the Toolasha tab sits first in it and nothing is hidden; otherwise this also hides the native Inventory tab in the character panel.',
                requires: 'inventoryTabs',
            },
            inventoryTabs_iconRowTab: {
                id: 'inventoryTabs_iconRowTab',
                label: "Custom Inventory Tabs: Toolasha tab in the inventory's icon row",
                type: 'checkbox',
                default: true,
                help: 'Off keeps Toolasha as its own tab in the character panel (next to Inventory), which takes less space on small screens.',
                requires: 'inventoryTabs',
            },
            inventoryTabs_tileGap: {
                id: 'inventoryTabs_tileGap',
                label: 'Custom Inventory Tabs: Item spacing (px)',
                type: 'number',
                default: 4,
                min: 0,
                max: 20,
                step: 1,
                help: "Pixel gap between item tiles, on the Toolasha tab and in the game's own Inventory view. 4 matches the game.",
                requires: 'inventoryTabs',
            },
            inventoryTabs_loadoutIncludeConsumables: {
                id: 'inventoryTabs_loadoutIncludeConsumables',
                label: 'Custom Inventory Tabs: Include food & drinks when adding from loadout',
                type: 'checkbox',
                default: false,
                help: 'When adding items from a loadout to a tab, also include food and drink items.',
                requires: 'inventoryTabs',
            },
            inventoryTabs_topTabPriority: {
                id: 'inventoryTabs_topTabPriority',
                label: 'Custom Inventory Tabs: Items visible in topmost tab only',
                type: 'checkbox',
                default: true,
                help: 'When an item appears in multiple tabs, it only shows in the highest (topmost) tab that contains it. When disabled, collapsing a tab releases its items to lower tabs.',
                requires: 'inventoryTabs',
            },
        },
    },

    skills: {
        title: 'Skills',
        icon: '📚',
        settings: {
            simulateScrollEffects: {
                id: 'simulateScrollEffects',
                label: 'Skills: Simulate missing scroll effects in calculations',
                type: 'checkboxWithButton',
                buttonLabel: 'Defaults...',
                default: true,
                help:
                    'Adds scroll chips to gathering and production action panels. Pressing a chip shows speed, XP and ' +
                    'profit as if that scroll were active (the scroll is never used). With none chosen every figure is ' +
                    'real; scrolls chosen with the Defaults button or in the Loadouts panel apply once this is on.',
            },
            skillTiles_simulatedScrolls: {
                id: 'skillTiles_simulatedScrolls',
                needsPrices: true,
                label: 'Skill page: Action tiles use simulated scrolls',
                type: 'checkbox',
                default: true,
                requires: 'simulateScrollEffects',
                help:
                    'Needs "Simulate missing scroll effects" on. Profit/hr, Exp/hr and Eff. XP/hr on every action ' +
                    'tile assume your chosen scrolls, marked with a scroll icon. A scroll active in the game is not ' +
                    'counted twice. The skill page\'s Scrolls button opens a menu whose "Use on tiles" box turns this ' +
                    'on or off.',
            },
            xpTracker: {
                id: 'xpTracker',
                label: 'Left sidebar: Show XP/hr rate on skill bars',
                type: 'checkbox',
                default: true,
                requiresRefresh: true,
                help: 'Displays live XP/hr rate under each skill bar in the navigation panel',
            },
            xpTracker_timeTillLevel: {
                id: 'xpTracker_timeTillLevel',
                label: 'Skill tooltip: Show time till next level',
                type: 'checkbox',
                default: true,
                requiresRefresh: true,
                help: 'Shows estimated time remaining until the next level in the skill hover tooltip (based on current XP/hr)',
            },
            skillRemainingXP: {
                id: 'skillRemainingXP',
                label: 'Left sidebar: Show remaining XP to next level',
                type: 'checkbox',
                default: true,
                help: 'Displays how much XP needed to reach the next level under skill progress bars',
            },
            skillRemainingXP_blackBorder: {
                id: 'skillRemainingXP_blackBorder',
                label: 'Remaining XP: Add black text border for better visibility',
                type: 'checkbox',
                default: true,
                help: 'Adds a black outline/shadow to the XP text for better readability against progress bars',
            },
            skillbook: {
                id: 'skillbook',
                label: 'Skill books: Show books needed to reach target level (in the ability book item dictionary window)',
                type: 'checkbox',
                default: true,
            },
            drinkTimer: {
                id: 'drinkTimer',
                label: 'Drink timer: Show remaining drink supply time in skill panels',
                type: 'checkbox',
                default: true,
                help: 'Shows how long your drink stock lasts and whether it covers the queued actions.',
            },
            drinkTimer_warningThreshold: {
                id: 'drinkTimer_warningThreshold',
                label: 'Drink timer: warning threshold (hours)',
                type: 'number',
                default: 24,
                help: 'Show an amber warning on drink time displays when remaining supply falls below this many hours.',
                requires: 'drinkTimer',
            },
            skillingOptimizer: {
                id: 'skillingOptimizer',
                needsPrices: true,
                label: 'Skilling Simulator/Optimizer: Enable Optimizer tab in character panel',
                type: 'checkbox',
                default: true,
            },
            skillingOptimizer_talismans: {
                id: 'skillingOptimizer_talismans',
                label: 'Skilling Simulator/Optimizer: Talismans section (test server)',
                type: 'checkbox',
                default: true,
                hidden: !isTestServer(),
                help:
                    'Test server only. Adds a Talismans section to the Optimizer tab: ranks every skilling talisman line ' +
                    'for an action, recommends a set (Practical, Ideal or within an orb budget), and finds the best next ' +
                    'target for talismans you own. Off: the section is not drawn.',
            },
        },
    },

    combat: {
        title: 'Combat Features',
        icon: '⚔️',
        settings: {
            damageTracker: {
                id: 'damageTracker',
                label: 'Damage Tracker: Attribute damage per player and per ability',
                type: 'checkbox',
                default: true,
                // Nothing reads this key but the registry gate — switching it on
                // or off is registered as a `liveStop` feature, so the registry
                // starts and stops the tracker's websocket handlers itself.
                help: 'The game attributes nothing, so the caster is worked out from attack counters, then presence, then whose mana fell — an equal split only in a crowd nothing else can separate. Feeds the Damage panel behind the DPS tile',
            },
            damageTakenTracker: {
                id: 'damageTakenTracker',
                label: 'Damage Taken Tracker: What is hitting you, and for how much',
                type: 'checkbox',
                default: true,
                // Same as the damage tracker above: a `liveStop` registry entry
                // starts and stops it on the switch, live.
                help: 'Damage taken against health regenerated, broken out per monster and per wave with hit ranges. Feeds the Deaths panel behind the deaths/hr tile',
            },
            combatSessionRestore: {
                id: 'combatSessionRestore',
                label: 'Combat meters: Keep the live session through a page refresh',
                type: 'checkbox',
                default: true,
                help: 'Saves the damage tallies, DPS graph and a watched guild trial in this browser, and restores them after a refresh within 20 minutes for the same character, party and zone (or trial fight). The last few seconds before a refresh can be missing.',
            },
            partyLint_live: {
                id: 'partyLint_live',
                label: 'Party lint: Flag loadout mistakes in the live party',
                type: 'checkbox',
                default: true,
                help: 'Runs the Combat Sim party checks (skilling gear in a combat slot, the same aura twice) on your live party, as an amber block in the Damage panel. Auras are checked for everyone, gear only for you. Parties of 2+ only.',
            },
            combatRecorder_autoStart: {
                id: 'combatRecorder_autoStart',
                label: 'Auto-record combat on load',
                type: 'checkbox',
                default: false,
                help: 'Starts the combat recorder as soon as the page loads and saves the file on its own, then switches itself off. Catches the first seconds after a reload that the Record button cannot. Turn it on again for each recording.',
            },
            combatRecorder_autoStartSeconds: {
                id: 'combatRecorder_autoStartSeconds',
                label: 'Auto-record length (seconds)',
                type: 'number',
                default: 60,
                min: 10,
                max: 600,
                help: 'How long the automatic recording runs before it saves itself',
                requires: 'combatRecorder_autoStart',
            },
            replayCheck: {
                id: 'replayCheck',
                label: 'Sim Accuracy: Replay recorded fights against the simulator',
                type: 'checkbox',
                default: true,
                help: 'Derives damage dealt, damage taken and fight length from a recorded fight, runs the simulator for the same zone, and reports the deviation with a sampling-noise margin. Feeds the Sim Accuracy overlay row and the panel behind it',
            },
            stunPersistenceWatch: {
                id: 'stunPersistenceWatch',
                label: 'Stun Persistence: Measure whether a stun outlives the monster that cast it',
                type: 'checkbox',
                default: false,
                // A `liveStop` registry entry: turning it on starts recording
                // live, turning it off tears the hooks down live too.
                help: 'Watches for a stun still reported after its caster died, keeping only waves where exactly one thing could have cast it. The tally builds up over sessions. Stun only, not blind or silence. Feeds the Stun Persistence overlay row and panel.',
            },
            waveGapWatch: {
                id: 'waveGapWatch',
                label: 'Wave Gap: Measure the real gap between a wave clearing and the next one starting',
                type: 'checkbox',
                default: false,
                // A `liveStop` registry entry: turning it on starts recording
                // live, turning it off tears the hooks down live too.
                help: "Measures the time from a wave's last monster dying to the next wave starting (open zones, dungeon waves and run boundaries kept apart), to check the constant the simulator uses. The tally builds up over sessions. Feeds the Wave Gap overlay row and panel.",
            },
            tickPeriodWatch: {
                id: 'tickPeriodWatch',
                label: 'Tick Period: Measure how often the repeating combat effects actually fire',
                type: 'checkbox',
                default: false,
                // A `liveStop` registry entry: turning it on starts recording
                // live, turning it off tears the hooks down live too.
                help: 'Measures the interval between regeneration, food and drink recovery, damage-over-time and enrage ticks, to check the constants the simulator uses. The tally builds up over sessions. Feeds the Tick Period overlay row and panel.',
            },
            combatScore: {
                id: 'combatScore',
                label: 'Profile panel: Show gear score',
                type: 'checkbox',
                default: true,
            },
            combatProfileButton: {
                id: 'combatProfileButton',
                label: 'Combat: Profile button on party members',
                type: 'checkbox',
                default: true,
                help: "Adds a 'Profile' button to the battle-unit popup when you click another player in group/party/dungeon combat, opening their profile directly (falls back to the /profile chat command if needed).",
            },
            abilitiesTriggers: {
                id: 'abilitiesTriggers',
                label: 'Profile panel: Show abilities & triggers',
                type: 'checkbox',
                default: true,
                help: 'Displays equipped abilities, consumables, and their combat triggers below the profile',
            },
            abilities_dictionaryButton: {
                id: 'abilities_dictionaryButton',
                label: 'Abilities: Add Open Item Dictionary to ability menus',
                type: 'checkbox',
                default: true,
                help: "Adds an Open Item Dictionary button to the popup shown when clicking an ability, and opens that ability's book entry on a right-click of any ability icon (slots, loadouts, the combat bar).",
            },
            chestKeyMarketButton: {
                id: 'chestKeyMarketButton',
                needsPrices: true,
                label: 'Chests: Add Buy Keys on Marketplace to chest menus',
                type: 'checkbox',
                default: true,
                help: 'Adds a button to the popup shown when clicking a keyed chest, opening its key on the marketplace.',
            },
            characterCard: {
                id: 'characterCard',
                label: 'Profile panel: Show View Card button',
                type: 'checkbox',
                default: true,
                help: 'Adds a button to send the displayed character build to tib-san.gitlab.io and open its character sheet viewer.',
            },
            characterCard_extraAuras: {
                id: 'characterCard_extraAuras',
                label: 'Character card: Include saved-loadout auras',
                type: 'checkbox',
                default: true,
                requires: 'characterCard',
                help: 'Adds up to three other learned auras to tib-san.gitlab.io cards, in saved combat/all-skills loadout order, at current levels (not on skilling-loadout cards). Slots 1–5 remain equipped; 6–8 are extras. The viewer does not label or dim the extras. Your data only.',
            },
            eliteAchievementReminder: {
                id: 'eliteAchievementReminder',
                label: 'Profile panel: Show Elite achievement reminder icon',
                type: 'checkbox',
                default: true,
                help: "Shows a ✉️ icon next to a player's name if they haven't completed Elite achievements; click to pre-fill a whisper.",
            },
            eliteAchievementReminderMessage: {
                id: 'eliteAchievementReminderMessage',
                label: 'Elite achievement reminder: whisper message',
                type: 'text',
                default: 'Be Elite. Do your Elite achievements.',
                help: 'Message pre-filled into chat when the Elite achievement reminder icon is clicked.',
                requires: 'eliteAchievementReminder',
            },
            dungeonTracker: {
                id: 'dungeonTracker',
                label: 'Dungeon Tracker: Real-time progress tracking',
                type: 'checkbox',
                default: true,
                help: 'Tracks dungeon runs with server-validated duration from party messages',
                requiresRefresh: true,
            },
            dungeonTrackerUI: {
                id: 'dungeonTrackerUI',
                label: 'Show Dungeon Tracker UI panel',
                type: 'checkbox',
                default: true,
                help: 'Displays dungeon progress panel with wave counter, run history, and statistics',
                requires: 'dungeonTracker',
            },
            dungeonTrackerChatAnnotations: {
                id: 'dungeonTrackerChatAnnotations',
                label: 'Show run time in party chat',
                type: 'checkbox',
                default: true,
                help: 'Adds colored timer annotations to "Key counts" messages (green if fast, red if slow)',
                requires: 'dungeonTracker',
                requiresRefresh: true,
            },
            dungeonTracker_recordFailedRuns: {
                id: 'dungeonTracker_recordFailedRuns',
                label: 'Dungeon Tracker: record failed and canceled runs',
                type: 'checkbox',
                default: false,
                help: 'Keeps runs that end in a wipe or a cancel in the run history, marked as such, and adds a fail rate and a time-per-clear figure that counts the time they cost. Average, fastest and slowest run stay clears only. Cancels are not counted as failures.',
                requires: 'dungeonTracker',
            },
            dungeonTrackerAverageWindow: {
                id: 'dungeonTrackerAverageWindow',
                label: 'Party chat average covers only the last N runs (0 = all runs)',
                type: 'number',
                default: 0,
                min: 0,
                max: 500,
                help: 'The average beside each run in party chat is lifetime by default, so build changes show up slowly. Set a window (20 is a good start) and each line averages only the last runs, labeled with how many. "Avg from here" in the dungeon panel does the same once.',
                requires: 'dungeonTracker',
            },
            labyrinthRunLedger: {
                id: 'labyrinthRunLedger',
                label: 'Labyrinth: record what each run leaves unspent',
                type: 'checkbox',
                default: true,
                help: "Records each run's ending — the torches, shrouds and beacons it came back with and the deepest floor it reached — so the Consumables panel can say whether the rush-for-exit floor could come down. Kept per character, last 30 runs.",
                requiresRefresh: true,
            },
            labyrinthTracker: {
                id: 'labyrinthTracker',
                label: 'Labyrinth best level tracker',
                type: 'checkbox',
                default: true,
                help: 'Tracks the highest recommended level enemy defeated per monster type and shows it in the Automation tab',
            },
            labyrinthShopPrices: {
                id: 'labyrinthShopPrices',
                requiresRefresh: true,
                needsPrices: true,
                label: 'Labyrinth Shop: Show market prices',
                type: 'checkbox',
                default: true,
                help: 'Shows ask/bid market prices on tradeable items in the Labyrinth Shop tab',
            },
            labyrinthClearRate: {
                id: 'labyrinthClearRate',
                label: 'Labyrinth clear rate calculator',
                type: 'checkbox',
                default: true,
                help: 'Shows expected clear time and success rate on labyrinth skilling room tiles',
            },
            labyrinthMissingSuppliesButton: {
                id: 'labyrinthMissingSuppliesButton',
                needsPrices: true,
                label: 'Labyrinth: Show "Buy supplies" button',
                type: 'checkbox',
                default: true,
                help: 'Replaces the Supplies label on the Labyrinth entry screen with a button that opens the Consumables panel on its Labyrinth tab: what the next runs need against what you hold, with a Buy all walk for the shortfall. Nothing is bought until you confirm in the game',
            },
            combatBuySuppliesButton: {
                id: 'combatBuySuppliesButton',
                needsPrices: true,
                label: 'Combat: Show "Buy supplies" button',
                type: 'checkbox',
                default: true,
                help: 'Replaces the Consumables heading on the combat page with a button that opens the Consumables panel on its Combat tab: how long your food and drinks last, with a Buy all walk for whatever is short of your target. Nothing is bought until you confirm in the game',
            },
            skillingBuySuppliesButton: {
                id: 'skillingBuySuppliesButton',
                needsPrices: true,
                label: 'Skilling: Show "Buy supplies" button',
                type: 'checkbox',
                default: true,
                help: 'Replaces the Consumables heading on a skill action panel with a button opening the Consumables panel on its Skilling tab for that skill: how long your teas last, with a Buy all walk. Nothing is bought until you confirm in the game.',
            },
            labyrinthPathStepper: {
                id: 'labyrinthPathStepper',
                label: 'Labyrinth: Show Next and Beacon step buttons',
                type: 'checkbox',
                default: true,
                help: 'The Next button beside Path carries out the route one game action per press: first the beacons that light the way to the exit, then Path re-runs, then queue rooms and place shrouds, then opens the Next Floor prompt of the game. The Beacon step places beacons. Never presses on its own.',
                requires: 'labyrinthClearRate',
            },
            labyrinthGridScaleControl: {
                id: 'labyrinthGridScaleControl',
                label: 'Labyrinth: Show grid size control',
                type: 'checkbox',
                default: true,
                help: 'Adds a - / + control that enlarges the room grid: in the labyrinth toolbar gear panel, or in the Labyrinth header row when the room calculator is off',
            },
            labyrinthGridScale: {
                id: 'labyrinthGridScale',
                label: 'Labyrinth: Room grid size',
                type: 'slider',
                default: 1,
                min: 0.75,
                max: 2,
                step: 0.25,
                help: 'Scale of the Labyrinth room grid. Also adjustable with the - / + control (the labyrinth toolbar gear panel)',
            },
            labyrinthMonsterStatCheck: {
                id: 'labyrinthMonsterStatCheck',
                label: 'Monster stat check (sim diagnostic)',
                type: 'checkbox',
                default: false,
                help: "Clicking a monster in combat opens a panel comparing the game's live buffed stats (armor, resistances, evasion, accuracy) with what the combat sim computes for it, so a modeling gap or active buff shows. Diagnostic; off by default.",
            },
            labyrinthRecommendTargetRate: {
                id: 'labyrinthRecommendTargetRate',
                label: 'Labyrinth: Recommend target clear rate (%)',
                type: 'number',
                default: 70,
                min: 1,
                max: 100,
                step: 1,
                help: 'Default target clear rate for labyrinth skip threshold recommendations',
            },
            labyrinthRecommendTargetSeconds: {
                id: 'labyrinthRecommendTargetSeconds',
                label: 'Labyrinth: Recommend target time per clear (s)',
                type: 'number',
                default: 300,
                min: 1,
                max: 100000,
                step: 1,
                help: 'Target for "Recommend by Time": the highest skip threshold whose expected time per clear, failed runs included, is within this many seconds',
            },
            // How long a labyrinth simulation may run used to be eleven
            // settings — four "Uncapped" checkboxes (one per panel), two
            // precisions that disagreed about their own default, and five
            // ceilings in two different units. Every one of them was answering
            // the same question, and a player who tightened the Automation tab
            // found the floor map unchanged. It is three now: whether the caps
            // apply at all, how tight an answer to hold out for, and the
            // backstop that ends a run which can never converge. The panels
            // still show their own "Uncapped" box; it is a view onto
            // `labyrinthSimCaps` rather than a setting of its own.
            labyrinthSimCaps: {
                id: 'labyrinthSimCaps',
                label: 'Labyrinth: Simulation stopping rule',
                type: 'select',
                default: 'capped',
                options: [
                    { value: 'capped', label: 'Stop at the fight and time ceilings' },
                    { value: 'precision', label: 'Run to the precision target' },
                ],
                help: 'Capped: a sim stops at the standard fight budget even if its clear chance is still loose, and a wide result is marked "(capped)". Run to precision: keeps fighting until the precision below is met, up to a 100x backstop. Applies to every labyrinth sim.',
            },
            labyrinthSimPrecision: {
                id: 'labyrinthSimPrecision',
                label: 'Labyrinth: Combat sim precision (±%)',
                type: 'number',
                default: 1,
                min: 0.1,
                max: 10,
                step: 0.5,
                help: 'A room sim keeps fighting until its 95% confidence interval for the clear chance fits within this many percentage points either side. Settled rooms need a few hundred fights, close ones thousands. Lower = tighter, more fights, slower.',
            },
            labyrinthSimMaxHours: {
                id: 'labyrinthSimMaxHours',
                label: 'Labyrinth: Simulation time ceiling (hours)',
                type: 'number',
                default: 24,
                min: 1,
                max: 100000,
                step: 1,
                help: 'Upper bound on one room simulation, in simulated hours (the fight clock, not your wait). Stops a room with very long fights from eating the whole fight budget. Ignored when the stopping rule above is "run to the precision target".',
            },
            labyrinthPathClearThreshold: {
                id: 'labyrinthPathClearThreshold',
                label: 'Labyrinth: Path clearable threshold (%)',
                type: 'number',
                default: 70,
                min: 1,
                max: 100,
                step: 1,
                help: 'Clear chance at or above which the labyrinth path planner treats a tile as clearable without a shroud (separate from the skip recommendation target)',
                requires: 'labyrinthClearRate',
            },
            labyrinthPathUnknownMode: {
                id: 'labyrinthPathUnknownMode',
                label: 'Labyrinth: Path treats unrevealed rooms as',
                type: 'select',
                default: 'shroud',
                options: [
                    { value: 'clearable', label: 'Clearable (optimistic)' },
                    { value: 'shroud', label: 'Needing a shroud (pessimistic)' },
                    { value: 'avoid', label: 'Impassable (route revealed rooms only)' },
                ],
                help: 'How the labyrinth path planner costs rooms whose contents are not revealed yet',
                requires: 'labyrinthClearRate',
            },
            labyrinthBeaconCount: {
                id: 'labyrinthBeaconCount',
                label: 'Labyrinth: Beacon plan count',
                type: 'number',
                default: 0,
                min: 0,
                max: 20,
                step: 1,
                help: 'Beacons the beacon planner places on the floor in view, sited to cover a revealed path to the exit first, a second independent route next, and the most rooms with what is left — 0 uses the fewest that cover a path, which every new floor resets to',
                requires: 'labyrinthClearRate',
            },
            labyrinthBeaconPlanFor: {
                id: 'labyrinthBeaconPlanFor',
                label: 'Labyrinth: Beacons to plan for the floor',
                type: 'number',
                default: 0,
                min: 0,
                max: 20,
                step: 1,
                help: 'Plan for this many beacons on the floor in all while placing only the beacon count now: the plan is ordered so the beacons placed first are the best start toward the full set, and the rest are drawn dashed as "later" — 0 plans only the beacons placed now',
                requires: 'labyrinthClearRate',
            },
            labyrinthBeaconPriority: {
                id: 'labyrinthBeaconPriority',
                label: 'Labyrinth: Beacon plan priority',
                type: 'select',
                default: 'rooms',
                options: [
                    { value: 'rooms', label: 'Most rooms' },
                    { value: 'holes', label: 'Fewest holes' },
                ],
                help: 'What the beacon planner ranks placements on once a path to the exit and its routes are covered: the most rooms revealed, or the fewest dark pockets left walled in by lit rooms (then rooms). Also in the labyrinth toolbar gear panel',
                requires: 'labyrinthClearRate',
            },
            labyrinthBeaconRoutes: {
                id: 'labyrinthBeaconRoutes',
                label: 'Labyrinth: Beacon plan routes wanted',
                type: 'select',
                default: '2',
                options: [
                    { value: '1', label: '1 route' },
                    { value: '2', label: '2 routes' },
                ],
                help: 'Independent covered routes to the exit the beacon planner aims for: two means no single room can block the way out, one frees beacons for rooms. Also in the labyrinth toolbar gear panel',
                requires: 'labyrinthClearRate',
            },
            labyrinthBeaconNearExit: {
                id: 'labyrinthBeaconNearExit',
                label: 'Labyrinth: Beacon plan stays near the way out',
                type: 'checkbox',
                default: false,
                help: 'Once a path to the exit and its routes are covered, the beacon planner prefers rooms close to the straight line from the entrance to the exit over rooms in the far corners. Also in the labyrinth toolbar gear panel',
                requires: 'labyrinthClearRate',
            },
            labyrinthBeaconPathFirst: {
                id: 'labyrinthBeaconPathFirst',
                label: 'Labyrinth: Number the route beacons first',
                type: 'checkbox',
                default: true,
                help: 'Numbers the beacons the way out depends on first (B1, B2...) and the ones only there for rooms last, so the first beacons placed open the route. Also in the labyrinth toolbar gear panel',
                requires: 'labyrinthClearRate',
            },
            labyrinthRoomDistribution: {
                id: 'labyrinthRoomDistribution',
                label: 'Labyrinth: Show clear chance distribution button',
                type: 'checkbox',
                default: true,
                help: 'Adds a Spread button to the floor map controls that opens a panel charting how the floor’s calculated rooms are spread across clear chance, with rooms not yet calculated counted apart. Takes effect the next time the floor map controls are drawn.',
                requires: 'labyrinthClearRate',
            },
            labyrinthDistributionBinWidth: {
                id: 'labyrinthDistributionBinWidth',
                label: 'Labyrinth: Distribution bin width (%)',
                type: 'number',
                default: 10,
                min: 5,
                max: 100,
                step: 5,
                help: 'Width of each clear-chance bin in the distribution panel, in percentage points. The panel has its own selector that changes this same value.',
                requires: 'labyrinthRoomDistribution',
            },
            labyrinthSkipEditAutofill: {
                id: 'labyrinthSkipEditAutofill',
                label: 'Labyrinth: Autofill skip Edit input',
                type: 'checkbox',
                default: false,
                help: "Clicking a skip threshold's Edit button fills the input with the recommended threshold (or the current value when no recommendation exists), replacing whatever is in it",
                requires: 'labyrinthClearRate',
            },
            labyrinthLiveProgress: {
                id: 'labyrinthLiveProgress',
                label: 'Labyrinth: Show live clear chance',
                type: 'checkbox',
                default: true,
                help: 'Shows a live clear chance in the action bar during labyrinth rooms — from the actions left in a skilling or enhancing room, and from how the fight is going in a combat room',
            },
            labyrinthLiveCombatSim: {
                id: 'labyrinthLiveCombatSim',
                label: 'Labyrinth: Replay the live fight for a better clear chance',
                type: 'checkbox',
                default: false,
                help: 'Replays the fight in progress hundreds of times from its current health and remaining time, instead of extrapolating from how fast health is being lost. Slower but far more accurate, since it runs the real combat engine',
                requires: 'labyrinthLiveProgress',
            },
            labyrinthRoomLogs: {
                id: 'labyrinthRoomLogs',
                label: 'Labyrinth: Room action logs',
                type: 'checkbox',
                default: true,
                help: 'Records per-action success/fail/double logs for labyrinth skilling rooms and per-attempt win/death/timeout logs for combat rooms, next to the clear chance the calculator predicted, with experience per hour. Logs button in the labyrinth panel.',
                requiresRefresh: true,
            },
            labyrinthRoomLogSize: {
                id: 'labyrinthRoomLogSize',
                label: 'Labyrinth: Rooms of history to keep',
                type: 'number',
                default: 120,
                min: 20,
                max: 500,
                help: 'A floor is around thirty rooms, so anything near that shows barely one floor and nothing to compare it against. 120 keeps roughly three floors. Each room is a few hundred bytes, and the long-term accuracy record is kept separately and never trimmed',
                requires: 'labyrinthRoomLogs',
            },
            labyrinthAutoCalcTiles: {
                id: 'labyrinthAutoCalcTiles',
                label: 'Labyrinth: Auto-calc revealed tiles',
                type: 'checkbox',
                default: false,
                help: 'Automatically calculates clear chances for newly revealed labyrinth tiles without clicking Calc Tiles',
                requires: 'labyrinthClearRate',
            },
            labyrinthAutoPath: {
                id: 'labyrinthAutoPath',
                label: 'Labyrinth: Auto-path after a beacon',
                type: 'checkbox',
                default: true,
                help: 'Works out the labyrinth path after a beacon reveals rooms on the floor, whether or not a path is shown yet (once per reveal, after any room calculation it triggers)',
                requires: 'labyrinthClearRate',
            },
            labyrinthAutoPathOnReveal: {
                id: 'labyrinthAutoPathOnReveal',
                label: 'Labyrinth: Auto-path also when a room clear reveals rooms',
                type: 'checkbox',
                default: true,
                help: 'Needs Auto-path above. Also works out the path again when clearing a room lights up a new room beside it (no beacon spent). Turn this off to re-path only after a beacon.',
                requires: 'labyrinthAutoPath',
            },
            labyrinthBeaconDots: {
                id: 'labyrinthBeaconDots',
                label: 'Labyrinth: Corner dot on rooms a beacon reveals',
                type: 'checkbox',
                default: true,
                help: 'Marks every room a planned beacon will reveal with a small dot (filled for a beacon placed now, a ring for one planned for later), so the reach still shows under a path tile. Also in the labyrinth toolbar gear panel',
                requires: 'labyrinthClearRate',
            },
            combatBattleCounter: {
                id: 'combatBattleCounter',
                label: 'Show battle/wave counter in current action panel during combat',
                type: 'checkbox',
                default: true,
                help: 'Displays "Battle #N" for regular zones or "Wave N" for dungeons in the top-left action panel',
            },
            combatBossEta: {
                id: 'combatBossEta',
                label: 'Show battles/time until the boss is defeated next to the battle counter',
                type: 'checkbox',
                default: true,
                help: 'For zones with a boss cycle, shows how many battles remain and — once a few battles have been timed — an estimate of when the boss will be defeated and you are free to start another action',
            },
            combatSummary: {
                id: 'combatSummary',
                requiresRefresh: true,
                label: 'Combat Summary: Add rate stats to Battle Info panel',
                type: 'checkbox',
                default: true,
                help: 'Adds encounters/hour, revenue and experience rates to the Battle Info panel for the unit being viewed',
            },
            combatDeathRecap: {
                id: 'combatDeathRecap',
                label: 'Death Recap: Show what happened in your last seconds before a death',
                type: 'checkbox',
                default: true,
                help: 'Keeps your last ~15 seconds of HP, MP, incoming hits and casts in memory (nothing saved) and freezes a recap when you die. Open it from the death alert or the Death recap button; the last five are kept until reload. Hit attribution is approximate.',
            },
            combatDeathRecapLabyrinth: {
                id: 'combatDeathRecapLabyrinth',
                label: 'Death notification and recap in the labyrinth',
                type: 'checkbox',
                default: false,
                help: 'A death inside the labyrinth is routine, so while this is off it raises no "You died" notification, no Death recap chip and no count there. Applies whether or not Death Recap is on; the recap itself is still kept in memory. Deaths anywhere else are unaffected.',
            },
            combatDropLuck: {
                id: 'combatDropLuck',
                label: 'Combat Drop Luck: Show how lucky a session was on return',
                type: 'checkbox',
                default: true,
                help: "Puts the session's drop value in the distribution of everything those battles could have paid, as a percentile. Skips dungeons, which pay from a reward table rather than per monster",
                requiresRefresh: true,
            },
            dropLuck_profitAdjust: {
                id: 'dropLuck_profitAdjust',
                label: 'Dungeon profit: value chests at my measured treasure rate',
                type: 'checkbox',
                default: false,
                help: "Scales a dungeon chest's expected value in profit estimates by your own treasure rate for it (what your recorded openings returned against the drop table, at today's prices). Needs a few hundred openings; adjusted figures are marked (*).",
            },
            combatDps: {
                id: 'combatDps',
                label: 'Combat DPS: Measure damage per second during a run',
                type: 'checkbox',
                default: true,
                help: "Infers damage from health lost between combat ticks, since the game sends no damage figure. Overkill is not counted, and in a party it is the whole party's damage — nothing on the wire says who struck",
            },
            combatDpsPanel: {
                id: 'combatDpsPanel',
                label: 'Per-player panel: Rank the party’s damage during normal combat',
                type: 'checkbox',
                default: false,
                help: 'The guild trial per-player board for ordinary party and solo fights: damage (with kills), damage taken, healing received and healing done, ranked with shares and rates. Opens from a "Per-player" button on the battle panel. Damage and healing are attributed, not measured. Off by default.',
                requiresRefresh: true,
            },
            portraitDps: {
                id: 'portraitDps',
                label: 'Portrait DPS: Show each character’s damage on their battle portrait',
                type: 'checkbox',
                default: false,
                help: "Draws the run's DPS and total damage over each character in the battle panel, matched by name. Off by default because the portraits are already busy with health and mana",
            },
            combatUnitBadges: {
                id: 'combatUnitBadges',
                label: 'Unit badges: Show each player’s DPS and share of the damage on their portrait',
                type: 'checkbox',
                default: false,
                help: 'A small "1,240/s · 22%" on every party tile, matched by name; narrow mini units get a compact "1,240/s" along the bottom edge. In a guild trial it shows the spectated trial split. With Portrait DPS on, the badge covers only the mini units. Off by default.',
            },
            combatPlayerColors: {
                id: 'combatPlayerColors',
                label: 'Player colors: Give each player one color on the damage boards and unit badges',
                type: 'checkbox',
                default: true,
                help: 'Each player keeps one color across the Per-player panel, trial damage board and unit badges (up to twelve; party members differ). Click the dot beside a name to pick one; it is remembered per player on every character. Off: trial bars color by damage type.',
            },
            combatDpsGraph: {
                id: 'combatDpsGraph',
                label: 'DPS graph: Chart damage per second over time on the Per-player panel and trial damage board',
                type: 'checkbox',
                default: true,
                help:
                    'A line chart above the rows on the Damage tab: the party and each player in their own color. ' +
                    'Per-player panel: five-minute and whole-session views, boss fights shaded; the trial board shows ' +
                    'recorder readings. Also the party DPS line in the panel header. Needs the Per-player panel for ' +
                    'normal fights.',
            },
            combatDpsHitTape: {
                id: 'combatDpsHitTape',
                label: 'Hit tape: Show your last minute of hits on the Per-player panel',
                type: 'checkbox',
                default: true,
                help: 'A strip under the DPS graph with one bar per hit you landed in the last minute: height is damage, a gold cap is a crit, a hollow stub is a miss, purple is damage over time, orange is reflected. Only hits credited to you alone. Needs the Per-player panel on.',
                requires: 'combatDpsPanel',
            },
            combatMeterHistory: {
                id: 'combatMeterHistory',
                label: 'Meter history: Keep finished sessions on the Per-player panel and trial damage board',
                type: 'checkbox',
                default: true,
                help:
                    'Saves each finished session (after 30 seconds of fighting) to a History button on the Per-player ' +
                    'panel, and each trial once on the trial damage board. Keeps the last ten per character plus ' +
                    'thirty starred. Rename, copy or delete. Needs the Per-player panel on for normal fights.',
            },
            combatClassOverride: {
                id: 'combatClassOverride',
                label: 'Class override: Click a player’s class on the damage boards to set it by hand',
                type: 'checkbox',
                default: true,
                help: 'The class beside each name is inferred from casts and gear and can be wrong. Click the class (or the dot beside the name) to set it, or choose Automatic to go back. Remembered by player name on every character; shown on the Per-player panel and trial damage board.',
            },
            combatUnitBuffBars: {
                id: 'combatUnitBuffBars',
                label: 'Buff bars: Show the buffs and debuffs on every combat unit',
                type: 'checkbox',
                default: false,
                help: "A strip of the game's ability icons under each tile (yours, party members and monsters) counting down what is on them, read from the server buff maps, so a resisted debuff never appears. Drinks and community buffs show an abbreviation. Off by default.",
            },
            combatConsumableRunway: {
                id: 'combatConsumableRunway',
                label: 'Consumable runway: Show how long each food and drink lasts on the battle grid',
                type: 'checkbox',
                default: false,
                help: 'A small duration under each icon in the in-battle Consumables grid: how long that stock lasts at the rate it is used, red under the low-consumable warning hours, infinity for a filled slot not being drunk. Off by default.',
            },
            portraitDpsPosition: {
                id: 'portraitDpsPosition',
                label: 'Portrait DPS: Where to put it',
                type: 'select',
                default: 'above',
                options: [
                    { value: 'above', label: 'Above the portrait' },
                    { value: 'below', label: 'Below the portrait' },
                ],
                help: 'Above sits over the name; below sits under the ability bar',
                requires: 'portraitDps',
            },
            portraitDps_timeToKill: {
                id: 'portraitDps_timeToKill',
                label: 'Portrait DPS: Time-to-kill on enemy tiles',
                type: 'checkbox',
                default: false,
                help: 'Adds "dead ~8s" to each enemy tile — its remaining health over the rate it is being hit at. Dashed until the fight has both a health reading and a rate; nothing is ever extrapolated from a guess',
                requires: 'portraitDps',
            },
            portraitDps_waveClear: {
                id: 'portraitDps_waveClear',
                label: 'Portrait DPS: Wave-clear countdown',
                type: 'checkbox',
                default: false,
                help: 'One "wave ~19s" figure on the topmost enemy tile: every living enemy\'s remaining health over the party\'s combined rate. Dashed until every health bar is known and a rate exists — a countdown that silently excluded a monster would lie',
                requires: 'portraitDps',
            },
            portraitDps_manaRunway: {
                id: 'portraitDps_manaRunway',
                label: 'Portrait DPS: Mana runway per player',
                type: 'checkbox',
                default: false,
                help: 'Adds "mana ~40s" to a player\'s meter when their mana is draining and under a minute from empty, measured net of regeneration and refills. Steady or rising mana shows a dash — there is nothing to warn about',
                requires: 'portraitDps',
            },
            portraitDps_sustain: {
                id: 'portraitDps_sustain',
                label: 'Portrait DPS: Damage taken and net sustain per player',
                type: 'checkbox',
                default: false,
                help: 'Adds "taken 220/s" from the incoming-damage tracker, and "net −35/s" where regeneration is measurable — red when the net is negative, which is the reading that says a zone is not survivable',
                requires: 'portraitDps',
            },
            portraitDps_accuracy: {
                id: 'portraitDps_accuracy',
                label: 'Portrait DPS: Hit and crit rate per player',
                type: 'checkbox',
                default: false,
                help: 'Adds "94% hit · 31% crit" to each player\'s meter once 20 swings back it. Fewer swings show a dash rather than one fight\'s luck dressed up as a rate',
                requires: 'portraitDps',
            },
            portraitDps_enemyOutgoing: {
                id: 'portraitDps_enemyOutgoing',
                label: 'Portrait DPS: Enemy outgoing damage',
                type: 'checkbox',
                default: false,
                help: 'A red "hits for 210/s" line on each enemy tile — what that enemy is doing to the party this fight, from the incoming-damage split. Dashed until a hit can be pinned to that enemy',
                requires: 'portraitDps',
            },
            portraitDps_enrage: {
                id: 'portraitDps_enrage',
                label: 'Portrait DPS: Enrage countdown on enemy tiles',
                type: 'checkbox',
                default: false,
                help: 'Adds "enrage 1:42" counting down when the monster\'s sheet carries an enrage timer and spawn time, amber under 30 seconds. Monsters whose sheet states no timer show a dash',
                requires: 'portraitDps',
            },
            dungeonPace: {
                id: 'dungeonPace',
                label: 'Dungeon Tracker: Pace vs your average',
                type: 'checkbox',
                default: true,
                help: 'A chip on the in-progress dungeon panel — "pace +6% vs your avg" — comparing this run\'s average wave time against your stored history for the same dungeon, green when faster. No stored history, or fewer than three waves in, shows nothing',
                requires: 'dungeonTrackerUI',
            },
            dungeonKeyRunway: {
                id: 'dungeonKeyRunway',
                label: 'Dungeon Tracker: How long your keys will last',
                type: 'checkbox',
                default: true,
                help: 'Adds "(~1h 20m)" beside the Keys count on the in-progress dungeon panel: held entry keys times your average recent clear of this dungeon, tier and team (up to 20, within the Dungeon Tracker window). Needs at least three clears; nothing with no keys.',
                requires: 'dungeonTrackerUI',
            },
            combatSim: {
                id: 'combatSim',
                requiresRefresh: true,
                label: 'Combat Simulator',
                type: 'checkbox',
                default: true,
                help: 'Simulate combat encounters to estimate XP/hr, deaths, and consumable usage',
            },
            labSim: {
                id: 'labSim',
                requiresRefresh: true,
                label: 'Lab Simulator',
                type: 'checkbox',
                default: true,
                help: 'Simulate labyrinth runs to estimate performance across skills and combat',
            },
            combatSim_defaultHours: {
                id: 'combatSim_defaultHours',
                label: 'Combat Simulator: Default hours (single zone)',
                type: 'number',
                default: 100,
                min: 1,
                max: 10000,
                step: 1,
                help: 'Default simulation duration in hours for single-zone runs',
            },
            combatSim_allZonesDefaultHours: {
                id: 'combatSim_allZonesDefaultHours',
                label: 'Combat Simulator: Default hours (All Zones)',
                type: 'number',
                default: 10,
                min: 1,
                max: 10000,
                step: 1,
                help: 'Default simulation duration in hours for All Zones runs',
            },
            combatSim_seekDefaultHours: {
                id: 'combatSim_seekDefaultHours',
                label: 'Combat Simulator: Default hours (Seek)',
                type: 'number',
                default: 10,
                min: 1,
                max: 10000,
                step: 1,
                help: 'Default simulation duration in hours for Seek Best Source runs',
            },
            combatSim_partyFinder: {
                id: 'combatSim_partyFinder',
                label: 'Combat Simulator: Party tab (find your best party)',
                type: 'checkbox',
                default: true,
                help: 'Adds a Party tab to the Combat Simulator: save teammate builds to a roster, sim you with every party you could make from it in the zones you pick, and rank the parties by your EXP/hr and profit/hr against solo. Off: the tab is not drawn.',
            },
            combatSim_talismanLineRanking: {
                id: 'combatSim_talismanLineRanking',
                label: 'Combat Simulator: Talisman lines ranking (test server)',
                type: 'checkbox',
                default: true,
                hidden: !isTestServer(),
                help: 'Test server only. Adds a Talisman lines section to the Upgrade tab: ranks every combat talisman line by what it adds to your build (by sim in the chosen zone) and recommends a set (Practical, Ideal or within an orb budget). Off: section hidden.',
            },
            combatSim_talismanBalanceXp: {
                id: 'combatSim_talismanBalanceXp',
                label: 'Combat Simulator: Talisman lines Balanced weight, EXP/hr',
                type: 'number',
                default: 1,
                hidden: !isTestServer(),
                min: 0,
                help: 'How much the EXP/hr % gain counts in the Talisman lines "Balanced" ranking.',
            },
            combatSim_talismanBalanceProfit: {
                id: 'combatSim_talismanBalanceProfit',
                label: 'Combat Simulator: Talisman lines Balanced weight, Profit/hr',
                type: 'number',
                default: 1,
                hidden: !isTestServer(),
                min: 0,
                help: 'How much the Profit/hr % gain counts in the Talisman lines "Balanced" ranking.',
            },
            combatSim_talismanBalanceDps: {
                id: 'combatSim_talismanBalanceDps',
                label: 'Combat Simulator: Talisman lines Balanced weight, DPS',
                type: 'number',
                default: 1,
                hidden: !isTestServer(),
                min: 0,
                help: 'How much the DPS % gain counts in the Talisman lines "Balanced" ranking.',
            },
            combatSim_talismanBalanceEncounters: {
                id: 'combatSim_talismanBalanceEncounters',
                label: 'Combat Simulator: Talisman lines Balanced weight, Encounters/hr',
                type: 'number',
                default: 0,
                hidden: !isTestServer(),
                min: 0,
                help: 'How much the Encounters/hr % gain counts in the Talisman lines "Balanced" ranking. 0 leaves it out.',
            },
            combatSim_talismanBalanceDeaths: {
                id: 'combatSim_talismanBalanceDeaths',
                label: 'Combat Simulator: Talisman lines Balanced weight, Deaths/hr',
                type: 'number',
                default: 0,
                hidden: !isTestServer(),
                min: 0,
                help: 'How much the Deaths/hr % change counts against a line in the Talisman lines "Balanced" ranking (a rise lowers its score). 0 leaves it out and keeps the automatic penalty for a clear rise in deaths; above 0 this replaces that penalty.',
            },
            combatSim_decimalMinutes: {
                id: 'combatSim_decimalMinutes',
                label: 'Combat Simulator: Show completion time as decimal minutes',
                type: 'checkbox',
                default: false,
                help: 'Display avg completion time as "X.XX min" instead of "Xm Ys"',
            },
            combatSim_bestiary: {
                id: 'combatSim_bestiary',
                label: 'Combat Simulator: Bestiary column and route planner in All Zones',
                type: 'checkbox',
                default: true,
                help:
                    'Adds the Bestiary points/day column to the All Zones table and the Bestiary route planner under it. ' +
                    'Off: neither is drawn and the Bestiary is not requested from the game.',
            },
            combatSim_defaultLoadout: {
                id: 'combatSim_defaultLoadout',
                label: 'Combat Simulator: Default loadout',
                type: 'select',
                default: '',
                options: () => {
                    const snapshot = loadoutSnapshot();
                    const loadouts = snapshot
                        ? snapshot.getAllSnapshots().filter((s) => s.actionTypeHrid === '/action_types/combat')
                        : [];
                    return [
                        { value: '', label: 'Current Gear' },
                        ...loadouts.map((s) => ({ value: s.name, label: s.name })),
                    ];
                },
                help: 'Loadout to use by default for combat estimates instead of currently equipped gear',
            },
            combatSim_autoEstimate: {
                id: 'combatSim_autoEstimate',
                label: 'Combat Simulator: Auto-run estimate on task cards',
                type: 'checkbox',
                default: false,
                help: 'Automatically run combat estimates using the default loadout when task cards appear',
            },
            combatSim_maxThreads: {
                id: 'combatSim_maxThreads',
                label: 'Combat Simulator: Max threads',
                type: 'number',
                default: 0,
                min: 0,
                max: 32,
                help:
                    'Maximum Web Worker threads for simulations (0 = auto: 4, or fewer on a smaller machine; with Ignore ' +
                    'thread caps, every core)',
            },
            combatSim_uncapThreads: {
                id: 'combatSim_uncapThreads',
                label: 'Combat Simulator: Ignore thread caps',
                type: 'checkbox',
                default: false,
                help: 'Max threads is normally clamped to your core count, and an analysis runs a limited number of simulations at once. Turn this on to take the thread number literally (0 = every core) and lift the phone 2-thread limit and Simulations at once. Max hrs, the re-sim time cap and Shorten above still apply.',
            },
            combatSim_maxConcurrentSims: {
                id: 'combatSim_maxConcurrentSims',
                label: 'Combat Simulator: Simulations at once',
                type: 'number',
                default: 6,
                min: 1,
                max: 32,
                help:
                    'Most simulations one analysis (Upgrade tab, trigger optimizer) runs at the same time, never more ' +
                    'than Max threads allows. Each one holds its own copy of the game data. Ignored when "Ignore thread ' +
                    'caps" is on.',
            },
            combatSim_resimMaxMinutes: {
                id: 'combatSim_resimMaxMinutes',
                label: 'Combat Simulator: Close-call re-sim time cap (minutes)',
                type: 'number',
                default: 10,
                min: 0,
                help:
                    'Longest the "Re-sim close calls" phase of an Upgrade analysis may run, in minutes. It is otherwise ' +
                    'allowed as long as the first pass took (at least 30 s). 0 = no time cap: it runs until the rows ' +
                    'separate, its round limit is reached, or you press Stop.',
            },
            labSim_allFightsSimBudget: {
                id: 'labSim_allFightsSimBudget',
                label: 'Lab Simulator: Shorten whole-run analyses above this many sims',
                type: 'number',
                default: 0,
                min: 0,
                help:
                    'A whole-run Lab analysis that plans more simulations than this runs each one for a smaller share ' +
                    'of the hours asked for (never below 25%), so the win rates are noisier but it finishes sooner. ' +
                    '0 = never shorten: every simulation runs the full hours.',
            },
            combatSim_upgradeSkipSkillingRooms: {
                id: 'combatSim_upgradeSkipSkillingRooms',
                label: 'Combat Simulator: Upgrade Advisor - skip skilling house rooms',
                type: 'checkbox',
                default: false,
                help:
                    'House Rooms Upgrade mode: skip rooms whose only combat results are the small Wisdom and Rare ' +
                    'Find bonuses shared by every room. This saves simulation time, but omits their real EXP and ' +
                    'Profit changes.',
            },
            labSim_keepReplacedGear: {
                id: 'labSim_keepReplacedGear',
                label: 'Lab Simulator: Keep gear the forced armor swaps replace',
                type: 'checkbox',
                default: true,
                help: 'The labyrinth needs every element set, so the Anchorbound / elemental robe / weapon swaps price as an added purchase with no resale credit for the gear they replace. Turn off to price them as a straight swap that sells the old piece.',
            },
            combatSim_sharedSeed: {
                id: 'combatSim_sharedSeed',
                label: 'Combat Simulator: Shared random seed for upgrade comparisons',
                type: 'checkbox',
                default: true,
                help: 'Runs the baseline and every candidate on the same random draws, so a small difference reflects the upgrade instead of luck. Turn off to give every sim independent randomness (the old behavior).',
            },
            combatSim_autoVerifyCloseCalls: {
                id: 'combatSim_autoVerifyCloseCalls',
                label: 'Combat & Lab Simulator: Auto-verify close calls',
                type: 'checkbox',
                default: false,
                help: 'After an analysis finishes, re-runs up to 3 "within noise" winners longer on fresh paired seeds and marks each confirmed, not confirmed or worse. Slower when it triggers; never runs on a stopped or remembered result. The Verify buttons do the same on demand.',
            },
            combatSim_soloMode: {
                id: 'combatSim_soloMode',
                label: 'Combat Simulator: Solo (Configure tab checkbox)',
                type: 'checkbox',
                default: false,
                help: 'Mirrors the Solo checkbox next to the party controls on the Configure tab. When on, a simulation runs only the player selected there instead of the whole loaded party; the roster, loadouts and edits are kept, so unchecking goes straight back.',
            },
            combatSim_taskDamage: {
                id: 'combatSim_taskDamage',
                label: 'Combat Simulator: Task damage',
                type: 'select',
                default: 'off',
                options: [
                    { value: 'off', label: 'Off' },
                    { value: 'perMonster', label: 'Only on your task monsters' },
                    { value: 'everyFight', label: 'Every fight' },
                ],
                help:
                    'Whether a simulation pays the task damage from task badges and trinkets. Off: never. Only on ' +
                    'your task monsters: against monsters your combat tasks name, until each task has its kills. ' +
                    'Every fight: treats every fight as a task fight, which overstates a mixed zone. Task estimates ' +
                    'always count it.',
            },
            combatSim_rememberUpgradeResults: {
                id: 'combatSim_rememberUpgradeResults',
                label: 'Combat & Lab Simulator: Remember upgrade results across refreshes',
                type: 'checkbox',
                default: false,
                help: 'Keeps the last Upgrade-tab results (Combat Sim and Lab Sim) after a page reload, until you run a new analysis. Off by default because it stores the full result set (one blob per character per sim) in the browser database.',
            },
            combatStats: {
                id: 'combatStats',
                label: 'Combat Statistics: Show Statistics tab in Combat panel',
                type: 'checkbox',
                default: true,
                help: 'Adds a Statistics button to the Combat panel showing income, profit, consumable costs, EXP, and drop details',
                requiresRefresh: true,
            },
            combatStatsChatMessage: {
                id: 'combatStatsChatMessage',
                label: 'Combat Statistics: Chat message format',
                type: 'template',
                default: [
                    { type: 'text', value: 'Combat Stats: ' },
                    { type: 'variable', key: '{duration}', label: 'Duration' },
                    { type: 'text', value: ' duration | ' },
                    { type: 'variable', key: '{encountersPerHour}', label: 'Encounters/Hour' },
                    { type: 'text', value: ' EPH | ' },
                    { type: 'variable', key: '{income}', label: 'Total Income' },
                    { type: 'text', value: ' income | ' },
                    { type: 'variable', key: '{dailyIncome}', label: 'Daily Income' },
                    { type: 'text', value: ' income/d | ' },
                    { type: 'variable', key: '{dailyConsumableCosts}', label: 'Daily Consumable Costs' },
                    { type: 'text', value: ' consumables/d | ' },
                    { type: 'variable', key: '{dailyProfit}', label: 'Daily Profit' },
                    { type: 'text', value: ' profit/d | ' },
                    { type: 'variable', key: '{exp}', label: 'EXP/Hour' },
                    { type: 'text', value: ' exp/h | ' },
                    { type: 'variable', key: '{deathCount}', label: 'Deaths' },
                    { type: 'text', value: ' deaths' },
                ],
                help: 'Advanced: a custom format for the Statistics popup\'s 💬 Chat button (and Ctrl+click on a player card). Left at the default, the Chat button\'s ▾ field picker decides what is included instead. Click "Edit Template" to customize.',
                templateVariables: [
                    { key: '{duration}', label: 'Duration', description: 'Combat session duration' },
                    { key: '{encountersPerHour}', label: 'Encounters/Hour', description: 'Encounters per hour (EPH)' },
                    { key: '{income}', label: 'Total Income', description: 'Total income from combat' },
                    { key: '{dailyIncome}', label: 'Daily Income', description: 'Income per day' },
                    {
                        key: '{dailyConsumableCosts}',
                        label: 'Daily Consumable Costs',
                        description: 'Consumable costs per day',
                    },
                    { key: '{dailyProfit}', label: 'Daily Profit', description: 'Profit per day' },
                    { key: '{exp}', label: 'EXP/Hour', description: 'Experience per hour' },
                    { key: '{deathCount}', label: 'Deaths', description: 'Number of deaths' },
                    { key: '{luck}', label: 'Drop Luck', description: 'Drop luck percentile (live run only)' },
                    { key: '{dps}', label: 'DPS', description: 'Damage per second (live run only)' },
                    { key: '{kills}', label: 'Kills', description: 'Killing blows (live run only)' },
                    { key: '{keyCosts}', label: 'Daily Key Costs', description: 'Dungeon key costs per day' },
                    { key: '{topDrop}', label: 'Top Drop', description: 'Most valuable drop, with count' },
                    { key: '{bossEta}', label: 'Boss ETA', description: 'Battles/time to the boss (live run only)' },
                    { key: '{zone}', label: 'Zone', description: 'Combat zone name' },
                ],
            },
        },
    },

    tasks: {
        title: 'Tasks',
        icon: '📋',
        settings: {
            taskProfitCalculator: {
                id: 'taskProfitCalculator',
                needsPrices: true,
                label: 'Show total profit for gathering/production tasks',
                type: 'checkbox',
                default: true,
            },
            taskSpeedBreakdown: {
                id: 'taskSpeedBreakdown',
                label: 'Show expandable speed & time breakdown on tasks',
                type: 'checkbox',
                default: true,
                help: 'Displays an expandable action speed, efficiency, and timing breakdown on task cards.',
            },
            taskCombatEstimate: {
                id: 'taskCombatEstimate',
                label: 'Show combat estimate on combat tasks',
                type: 'checkbox',
                default: true,
                help: 'Displays a loadout dropdown and estimate button on combat task cards.',
            },
            taskCombatEstimatePercentile: {
                id: 'taskCombatEstimatePercentile',
                label: 'Zone fight estimate confidence',
                type: 'select',
                default: '90',
                options: [
                    { value: '50', label: 'Median (50%)' },
                    { value: '80', label: '80%' },
                    { value: '90', label: '90%' },
                    { value: '95', label: '95%' },
                ],
                help:
                    'How many fights the zone estimates plan for. At 90% the slowest task in the zone is finished by ' +
                    'then nine times in ten. The median shows on hover. Go and zone rows use the larger of this and ' +
                    'the zone padded by Combat pre-fill confidence, and never less than the Go count buffer.',
            },
            taskEfficiencyRating: {
                id: 'taskEfficiencyRating',
                needsPrices: true,
                label: 'Show task efficiency rating (tokens/profit per hour)',
                type: 'checkbox',
                default: true,
                help: 'Displays a color-graded efficiency score based on expected completion time.',
            },
            taskMaterialsIndicator: {
                id: 'taskMaterialsIndicator',
                label: 'Show materials availability on production tasks',
                type: 'checkbox',
                default: true,
                help: 'Shows how many task actions you can complete with current inventory.',
            },
            taskEfficiencyRatingMode: {
                id: 'taskEfficiencyRatingMode',
                label: 'Efficiency algorithm',
                type: 'select',
                default: 'gold',
                options: [
                    { value: 'tokens', label: 'Task tokens per hour' },
                    { value: 'gold', label: 'Task profit per hour' },
                ],
                help: 'Choose whether to rate by task token payout or total profit.',
            },
            taskEfficiencyGradient: {
                id: 'taskEfficiencyGradient',
                label: 'Use relative gradient colors',
                type: 'checkbox',
                default: false,
                help: 'Colors efficiency ratings relative to visible tasks.',
            },
            taskQueuedIndicator: {
                id: 'taskQueuedIndicator',
                label: 'Show "Queued" indicator on task cards',
                type: 'checkbox',
                default: true,
                help: 'Displays a status message on task cards when their action is in your action queue',
            },
            taskRerollTracker: {
                id: 'taskRerollTracker',
                needsPrices: true,
                label: 'Track task reroll costs',
                type: 'checkbox',
                default: true,
                help: 'Tracks how much gold/cowbells spent rerolling each task',
            },
            taskMapIndex: {
                id: 'taskMapIndex',
                label: 'Show combat zone index numbers on tasks',
                type: 'checkbox',
                default: true,
            },
            taskIcons: {
                id: 'taskIcons',
                requiresRefresh: true,
                label: 'Show visual icons on task cards',
                type: 'checkbox',
                default: true,
                help: 'Displays semi-transparent item/monster icons on task cards',
            },
            taskIconsDungeons: {
                id: 'taskIconsDungeons',
                label: 'Show dungeon icons on combat tasks',
                type: 'checkbox',
                default: false,
                help: 'Shows which dungeons contain the monster (requires Task Icons enabled)',
                requires: 'taskIcons',
            },
            taskSorter: {
                id: 'taskSorter',
                label: 'Task sorter: Sort tasks by skill type',
                type: 'checkbox',
                default: true,
                help: 'Adds the sort button and sorting machinery to the task panel.',
            },
            taskSorter_autoSort: {
                id: 'taskSorter_autoSort',
                label: 'Automatically sort tasks when opening task panel',
                type: 'checkbox',
                default: false,
                help: 'Automatically sorts tasks by skill type when you open the task panel',
            },
            taskSorter_sortAfterRead: {
                id: 'taskSorter_sortAfterRead',
                label: 'Sort tasks after reading new ones',
                type: 'checkbox',
                default: false,
                help: 'Sorts the board again once you press Read, since new tasks always arrive at the end',
            },
            taskSorter_hideButton: {
                id: 'taskSorter_hideButton',
                label: 'Hide Sort Tasks button',
                type: 'checkbox',
                default: false,
                help: 'Hides the Sort Tasks button while keeping auto-sort functional',
                requires: 'taskSorter',
            },
            taskSorter_sortMode: {
                id: 'taskSorter_sortMode',
                label: 'Task sort mode',
                type: 'select',
                default: 'skill',
                options: [
                    { value: 'skill', label: 'Skill / Zone' },
                    { value: 'time', label: 'Time to Completion' },
                    { value: 'protection', label: 'Protection (unprotected first)' },
                ],
                help: 'How tasks are ordered when clicking Sort Tasks. "Time to Completion" sorts fastest tasks first; combat and completed tasks go to the bottom. "Protection" puts unprotected tasks first.',
            },
            taskInventoryHighlighter: {
                id: 'taskInventoryHighlighter',
                label: 'Enable Task Inventory Highlighter button',
                type: 'checkbox',
                default: true,
                // The module watches for the tasks panel from its initialize and
                // nothing else reads the key: a `liveStop` registry entry starts
                // and stops it live in either direction.
                help: 'Adds a button to dim inventory items not needed for your current non-combat tasks',
            },
            taskStatistics: {
                id: 'taskStatistics',
                label: 'Show task statistics button on Tasks panel',
                type: 'checkbox',
                default: true,
                help: 'Adds a Statistics button to the Tasks panel showing overflow time, expected rewards, and completion estimates',
            },
            taskStatistics_zoneProgress: {
                id: 'taskStatistics_zoneProgress',
                label: 'Show per-zone combat task progress in task statistics',
                type: 'checkbox',
                default: false,
                help: 'Adds a Zone Task Progress section to Task Statistics: per zone with active combat tasks, the fights and time to clear them and the slowest monster. Runs one combat simulation per zone each time the popup opens; click a zone to open it with the fight count filled in.',
                requires: 'taskStatistics',
            },
            taskClaimCollector: {
                id: 'taskClaimCollector',
                label: 'Move Claim Reward buttons to top of task list',
                type: 'checkbox',
                default: true,
                help: 'Moves all Claim Reward buttons to a stack at the top of the task list so you can click the same spot repeatedly to claim all completed tasks',
            },
            taskClaimToast: {
                id: 'taskClaimToast',
                label: 'Show a toast summary when a task is claimed',
                type: 'checkbox',
                default: false,
                help: 'Pops a brief toast naming the coins, tokens, and items a claimed task paid out — the reward the claimed card no longer shows once it is gone.',
            },
            taskRerollSpendBadge: {
                id: 'taskRerollSpendBadge',
                needsPrices: true,
                label: 'Show total reroll spend next to the task slot count',
                type: 'checkbox',
                default: true,
                help: 'Sums the reroll cost already sunk into the tasks currently on the board and shows it next to the slot count, without opening Statistics.',
            },
            taskGoMerge: {
                id: 'taskGoMerge',
                label: 'Merge duplicate tasks on Go',
                type: 'checkbox',
                default: true,
                help: 'When clicking Go on a task, combines the required amounts of all in-progress tasks for the same action into a single pre-filled count',
            },
            taskCombatGoTier: {
                id: 'taskCombatGoTier',
                label: 'Combat estimate: tier',
                type: 'select',
                default: 'game',
                options: [
                    { value: 'game', label: 'The tier selected in the game' },
                    { value: 'best', label: 'Best Score (simulates every tier)' },
                ],
                help:
                    'Tier for combat task estimates and Go. "The tier selected in the game" uses the zone\'s ' +
                    'Difficulty box; Go never changes it. "Best Score" simulates every tier, skips tiers where you ' +
                    'die or never kill the task monster, picks the best Combat Sim Score, and Go sets the box to it. ' +
                    'Slower.',
            },
            taskCombatGoBuffer: {
                id: 'taskCombatGoBuffer',
                label: 'Combat estimate: Go count buffer %',
                type: 'number',
                default: 5,
                min: 0,
                max: 100,
                help:
                    'The smallest padding a pre-filled fight count ever gets. The confidence setting below usually ' +
                    'asks for more than this; this is the floor it can never fall below. Boss fights ignore it — ' +
                    'bosses spawn on a fixed wave, so there is no bad luck to pad against.',
            },
            combatFightConfidence: {
                id: 'combatFightConfidence',
                label: 'Combat pre-fill: confidence %',
                type: 'number',
                default: 90,
                min: 0,
                max: 99,
                help: 'How often a pre-filled fight count (task Go button and Bestiary plan) should actually be enough. At 90 you finish the kills nine runs in ten instead of roughly half. Small targets are padded much harder than large ones. 0 turns it off, leaving only the flat buffer above.',
            },
            taskRerollProtection: {
                id: 'taskRerollProtection',
                requiresRefresh: true,
                label: 'Task reroll protection',
                type: 'checkbox',
                default: true,
                help: 'Protect specific tasks from accidental rerolling. Protected tasks get a green highlight and require a confirmation click before rerolling. A shield icon appears in the task panel to configure protected zones.',
            },
            taskRerollProtection_hideHighlight: {
                id: 'taskRerollProtection_hideHighlight',
                label: 'Task reroll protection: Hide green highlight',
                type: 'checkbox',
                default: false,
                help: 'Removes the green outline/glow from protected tasks while keeping the reroll confirmation active.',
                requires: 'taskRerollProtection',
            },
            taskAutoReroll: {
                id: 'taskAutoReroll',
                label: 'Task auto-reroll reminder',
                type: 'checkbox',
                default: true,
                help: 'Highlights tasks you want to reroll with a red border and reminder badge. Configure per-character via the target icon in the task panel.',
                requiresRefresh: true,
            },
            taskAutoReroll_belowPar: {
                id: 'taskAutoReroll_belowPar',
                label: 'Also flag tasks rating below the board ("Below par")',
                type: 'checkbox',
                default: false,
                help:
                    'With the reminder on, also give the red border and a "Below par" badge to any task whose ' +
                    'rate sits below the board median by more than its next reroll would cost. Off (the default) ' +
                    'leaves only your auto-reroll list flagged.',
                requires: 'taskAutoReroll',
            },
            tasks_rerollWalk: {
                id: 'tasks_rerollWalk',
                label: 'Reroll walk: step through the board one click at a time',
                type: 'checkbox',
                default: false,
                help:
                    'Adds a floating Reroll walk panel to the Tasks page (and a 🎲 in the task panel header to show ' +
                    'or hide it). It works down the board using your protection list and "Block rerolls at" ' +
                    'thresholds and tells you what the next click will do. One click is always one game action. It ' +
                    'never chains clicks.',
                requiresRefresh: true,
            },
            tasks_rerollWalkCurrency: {
                id: 'tasks_rerollWalkCurrency',
                label: 'Reroll walk: which currency to pay with',
                type: 'select',
                default: 'auto',
                options: [
                    { value: 'auto', label: 'Cheapest (compare in coins)' },
                    { value: 'cowbell', label: 'Prefer cowbells' },
                    { value: 'coin', label: 'Prefer coins' },
                ],
                help: 'Cheapest values a cowbell through the Bag of 10 Cowbells and picks whichever of the two rerolls costs less in coins. Either preference falls back to the other currency when its own is blocked. A free reroll is always taken first.',
                requires: 'tasks_rerollWalk',
            },
            tasks_rerollWalkBarPosition: {
                id: 'tasks_rerollWalkBarPosition',
                label: 'Reroll walk bar position',
                type: 'select',
                default: 'toolbar',
                options: [
                    { value: 'toolbar', label: 'In the toolbar' },
                    { value: 'floating', label: 'Floating' },
                ],
                help: 'In the toolbar docks a compact walk button beside Sort Tasks on the Task Board tab, so it never covers a task card. Floating is the movable panel. Either way it shows only on the Task Board tab.',
                requires: 'tasks_rerollWalk',
            },
            tasks_mergedCraftingWalk: {
                id: 'tasks_mergedCraftingWalk',
                label: 'Tasks: walk several tasks that share a crafting chain as one',
                type: 'checkbox',
                default: false,
                help:
                    'Adds a "Merged crafting walk" button to the task panel header. It groups production tasks whose ' +
                    'chains share a craft step and offers one guided walk per group, so a shared intermediate is ' +
                    'crafted once at the combined count. Opens each step and fills in the count. Never presses the ' +
                    'button.',
                requiresRefresh: true,
            },
            tasks_rerollWalkTrashAtLimit: {
                id: 'tasks_rerollWalkTrashAtLimit',
                label: 'Reroll walk: discard a task once both reroll options are blocked',
                type: 'checkbox',
                default: true,
                help: 'When both the coin and the cowbell reroll would cost at or over the shield popup’s "Block rerolls at" thresholds, offer to discard the task (the red trash can) rather than leaving it on the board. Turn off to skip past it instead.',
                requires: 'tasks_rerollWalk',
            },
        },
    },

    ui: {
        title: 'UI & Appearance',
        icon: '🎨',
        settings: {
            accountView: {
                id: 'accountView',
                label: 'Account view: All characters on one screen',
                type: 'checkbox',
                default: true,
                help:
                    'One panel for the whole account: combined net worth with each character’s share, plus per-character ' +
                    'status (current action, time left, whether anything is idle). A character shows up once it has been ' +
                    'played with Toolasha running.',
            },
            sessionBriefing: {
                id: 'sessionBriefing',
                label: 'Session briefing: What needs you, inside the Welcome Back window',
                type: 'checkbox',
                default: true,
                // A `liveStop` registry entry: switching it off live unhooks it.
                // Switching it back on mid-session starts it again, but the
                // briefing itself is only drawn once, when the game opens its
                // Welcome Back window — there is nothing to redraw until the
                // next one appears.
                help:
                    'Adds a section to the game\'s "Welcome Back!" window listing only what needs attention, such as ' +
                    'an empty queue, waiting tasks, a lapsing buff, the first consumable to run dry, filled or ' +
                    'undercut listings, an unfinished enhancement run and idle characters. Appears only when the game ' +
                    'shows that window.',
            },
            equipmentMismatchWarning: {
                id: 'equipmentMismatchWarning',
                label: 'Warn when the gear contradicts the action',
                type: 'checkbox',
                default: true,
                help:
                    'A pulsing header pill when your kit and running action disagree: a production piece still worn in ' +
                    'combat, or a cooking, gathering, crafting or enhancing action running while the piece that would ' +
                    'speed it up sits unequipped in your bag. Quiet inside a labyrinth run.',
            },
            talismanWindowValues: {
                id: 'talismanWindowValues',
                label: 'Talisman window: Show values scaled by your belt',
                type: 'checkbox',
                default: true,
                hidden: !isTestServer(),
                help: 'Test server only. Beside each modifier line in the talisman window, the value your worn Talisman Belt turns it into (Talisman Power included), for example +4.5% → +5.66%',
            },
            talismanRerollAdvisor: {
                id: 'talismanRerollAdvisor',
                label: 'Talisman window: Reroll advisor',
                type: 'checkbox',
                default: true,
                hidden: !isTestServer(),
                help:
                    'Test server only. Pick up to six lines, how many you need and which are required. Shows the next ' +
                    'move (which orb, when to lock a line, or a new roll), the average orbs spent and a coin cost ' +
                    'only when every orb has a price. Do next step presses the advised button, one action per click.',
            },
            overlayPanel: {
                id: 'overlayPanel',
                label: 'Overlay Panel: One floating panel other features add a row to',
                type: 'checkbox',
                default: true,
                // A `liveStop` registry entry: turning it on starts the panel
                // live and turning it off tears it down live too.
                help:
                    'A configurable overlay. Open it from the Overlay tab beside Inventory and use the gear to choose ' +
                    'which rows show and in what order. Its ⇲ button docks it below the character tabs so it no longer ' +
                    'covers the game.',
            },
            overlayTabButton: {
                id: 'overlayTabButton',
                label: 'Overlay tab button',
                type: 'checkbox',
                default: true,
                // Read in the module's initialize, like the Overlay Panel above it,
                // with no listener of its own: a `liveStop` registry entry draws
                // the tab and removes it live in either direction.
                help: 'Adds an Overlay switch to the character tabs, beside Inventory and before Optimizer, so the overlay can be shown and hidden without opening settings. Needs the Overlay Panel above',
            },
            commandPalette: {
                id: 'commandPalette',
                label: 'Command palette (Ctrl+K)',
                type: 'checkbox',
                default: true,
                help: 'Ctrl+K (or Cmd+K) opens a search box listing every panel, every overlay row, every saved overlay layout and every setting by name — arrow keys and Enter to choose, Escape to dismiss. Ignored while you are typing in chat or any other input',
            },
            commandPaletteNavEntry: {
                id: 'commandPaletteNavEntry',
                label: 'Command palette sidebar entry (phone)',
                type: 'checkbox',
                default: true,
                help: 'Adds a Search entry to the left navigation on a phone, which has no Ctrl+K, that opens the command palette. Needs the Command palette above',
                requires: 'commandPalette',
            },
            commandPaletteSettingsButton: {
                id: 'commandPaletteSettingsButton',
                label: 'Command palette button on the Settings page',
                type: 'checkbox',
                default: true,
                help: 'Adds a Command Palette button at the top of the game Settings page, beside Philo Gamba, that opens the command palette. Needs the Command palette above',
                requires: 'commandPalette',
            },
            goalPlanner: {
                id: 'goalPlanner',
                needsPrices: true,
                label: 'Goal Planner: Ordered steps, cost and time to reach a goal',
                type: 'checkbox',
                default: true,
                help:
                    'A floating panel (Ctrl+K → Goal Planner) that turns a goal (500M coins, Sinister Cape +10, Enhancing ' +
                    '110, Observatory 8) into ordered steps, each with its own cost and time. Refresh re-prices against ' +
                    'the current market; satisfied steps are struck through.',
            },
            ironCowFarm: {
                // Display name is "Iron Bell Farming"; the setting id is kept as
                // ironCowFarm since settings persist by id and renaming it would
                // drop an existing user's saved preference.
                id: 'ironCowFarm',
                label: 'Iron Bell Farming: The cowbell-farming plan, and what it earns',
                type: 'checkbox',
                default: true,
                help:
                    'Panel (Ctrl+K, Iron Bell Farming) with the iron cow route to gold for cowbells, each stage ' +
                    'checked against your levels, gear and house. Shows bells per hour, day and week. While a loop ' +
                    'leg runs, action-bar lines show bells you can buy now and when the queued cycle ends. Gold is ' +
                    'coinify, never sold.',
            },
            draggableModals: {
                id: 'draggableModals',
                label: 'Draggable modals',
                type: 'checkbox',
                default: true,
                help: 'Makes game popup modals draggable. Position is remembered per modal type across sessions. Double-click the dotted bar at the top of a modal to put that modal type back in the center.',
            },
            formatting_useKMBFormat: {
                id: 'formatting_useKMBFormat',
                label: 'Number format mode',
                type: 'select',
                default: 'compact',
                options: [
                    { value: 'full', label: 'Full (1,250,000)' },
                    { value: 'threshold', label: 'Abbreviate after 4 digits (1,250K)' },
                    { value: 'compact', label: 'Always abbreviate (1.25M)' },
                ],
                help: 'Controls how large numbers are displayed throughout the UI',
            },
            formatting_precision: {
                id: 'formatting_precision',
                label: 'Abbreviation precision (decimal digits)',
                type: 'select',
                default: '2',
                options: [
                    { value: '1', label: '1 digit (1.2M)' },
                    { value: '2', label: '2 digits (1.25M)' },
                    { value: '3', label: '3 digits (1.250M)' },
                    { value: '4', label: '4 digits (1.2500M)' },
                ],
                help: 'Number of decimal places shown when numbers are abbreviated with K/M/B suffixes',
            },
            ui_textScale: {
                id: 'ui_textScale',
                label: 'Toolasha text size',
                type: 'select',
                default: '100',
                options: [
                    { value: '80', label: '80%' },
                    { value: '90', label: '90%' },
                    { value: '100', label: '100% (as designed)' },
                    { value: '110', label: '110%' },
                    { value: '125', label: '125%' },
                    { value: '150', label: '150%' },
                ],
                help:
                    "Scales the text inside Toolasha's own windows: floating panels, dialogs, menus, tooltips, " +
                    'toasts, the command palette and this settings page. Windows keep their size, so larger text ' +
                    "scrolls. Lines Toolasha adds inside the game's pages are not scaled. Shared by every character " +
                    'on this device.',
            },
            ui_fontFamily: {
                id: 'ui_fontFamily',
                label: 'Toolasha font',
                type: 'select',
                default: 'default',
                options: [
                    { value: 'default', label: 'Default (unchanged)' },
                    { value: 'system', label: 'System UI' },
                    { value: 'verdana', label: 'Verdana' },
                    { value: 'tahoma', label: 'Tahoma' },
                    { value: 'arial', label: 'Arial' },
                    { value: 'georgia', label: 'Georgia (serif)' },
                    { value: 'mono', label: 'Monospace' },
                ],
                help:
                    'The typeface for the same Toolasha surfaces as the text size. Only fonts already installed with ' +
                    'your operating system are offered, so nothing is downloaded; a machine missing one falls back to ' +
                    'a similar face. Text that is monospace on purpose keeps its face',
            },
            ui_gameText: {
                id: 'ui_gameText',
                label: 'Game text: Use the font above, and the size below, for the game’s own text',
                type: 'checkbox',
                default: false,
                help:
                    "Off leaves the game's text as is. On, the font chosen above applies to the whole game, and the " +
                    'size below enlarges text in chat, tooltips, the item dictionary, patch notes and news. Item ' +
                    "tiles and fixed-layout areas are left alone. Use the browser's zoom (Ctrl and +) for " +
                    'everything.',
            },
            ui_gameTextScale: {
                id: 'ui_gameTextScale',
                label: 'Game text size',
                type: 'select',
                default: '100',
                requires: 'ui_gameText',
                options: [
                    { value: '100', label: '100% (as the game draws it)' },
                    { value: '110', label: '110%' },
                    { value: '125', label: '125%' },
                    { value: '150', label: '150%' },
                ],
                help: 'How much larger the game’s text is in the areas listed above. Only used while the game text setting is on',
            },
            ui_externalLinks: {
                id: 'ui_externalLinks',
                label: 'Left sidebar: Show external tool links',
                type: 'checkbox',
                default: true,
                help: 'Adds quick links to external tools in the left sidebar, such as the combat sims, market trackers and Enhancelator',
            },
            hideLabyrinthBadge: {
                id: 'hideLabyrinthBadge',
                label: 'Left sidebar: Hide Labyrinth ping badge',
                type: 'checkbox',
                default: false,
            },
            hideGuildBadge: {
                id: 'hideGuildBadge',
                label: 'Left sidebar: Hide Guild notification badge',
                type: 'checkbox',
                default: false,
            },
            panelSizeMemory: {
                id: 'panelSizeMemory',
                label: 'Layout: Remember panel sizes you drag',
                type: 'checkbox',
                default: true,
                help: 'The game forgets panel widths on reload. This records whatever a divider drag changes and reapplies it next session — only styles the game itself wrote in response to your own drag are replayed, and a remembered size is dropped if the layout changes shape.',
            },
            tabReorder: {
                id: 'tabReorder',
                label: 'Character panel: Drag-and-drop tab reordering',
                type: 'checkbox',
                default: true,
                help: 'Drag tabs to rearrange the order of Inventory, Toolasha, Equipment, Houses, Abilities, and Loadout. Order persists through refresh.',
            },
            expPercentage: {
                id: 'expPercentage',
                label: 'Left sidebar: Show skill XP percentages',
                type: 'checkbox',
                default: true,
            },
            combatLevelProgress: {
                id: 'combatLevelProgress',
                label: 'Left sidebar: Show decimal Combat Level',
                type: 'checkbox',
                default: true,
                help: "Shows the unrounded Combat Level formula value from current whole skill levels (e.g. 133.2). MWI's native sidebar floors it to an integer for display. The XP-weighted progress toward the next Combat Level lives in the Combat Level panel.",
            },
            itemIconLevel: {
                id: 'itemIconLevel',
                label: 'Bottom left corner of icons: Show equipment level',
                type: 'checkbox',
                default: true,
            },
            loadoutEnhancementDisplay: {
                id: 'loadoutEnhancementDisplay',
                label: 'Loadout panel: Show highest-owned enhancement level on equipment icons',
                type: 'checkbox',
                default: true,
            },
            loadoutTalismanCheck: {
                id: 'loadoutTalismanCheck',
                label: 'Test server: warn when loadout talismans will not work',
                type: 'checkbox',
                default: true,
                hidden: !isTestServer(),
                help:
                    'Test server only. Marks the selected loadout in the Loadouts panel when it names a talisman that ' +
                    'no longer exists, puts one in a slot its belt lacks, mixes combat and skilling talismans, or ' +
                    'carries the same Special line in two slots. Such talismans do nothing when the loadout is ' +
                    're-equipped.',
            },
            loadoutSnapshot: {
                id: 'loadoutSnapshot',
                label: 'Loadout panel: Use saved loadout snapshots in profit calculations',
                type: 'checkbox',
                default: true,
                help:
                    'When you queue an action, Toolasha predicts its XP, time and profit from the saved loadout for that ' +
                    'skill (skill default → all-skills default → any saved loadout → currently equipped). Save loadouts ' +
                    'in-game so they are captured. Off predicts with currently equipped gear.',
                requiresRefresh: true,
            },
            showsKeyInfoInIcon: {
                id: 'showsKeyInfoInIcon',
                label: 'Bottom left corner of key icons: Show zone index',
                type: 'checkbox',
                default: true,
            },
            mapIndex: {
                id: 'mapIndex',
                label: 'Combat zones: Show zone index numbers',
                type: 'checkbox',
                default: true,
            },
            combatScale: {
                id: 'combatScale',
                label: 'Battle panel: Resize the fight',
                type: 'checkbox',
                default: false,
                help:
                    'Scales your side and the enemy side of the battle panel independently and chooses how they sit, so a ' +
                    'ten-monster wave and a solo fight stop getting the same slab of screen. Settings below are stored ' +
                    'per character. Technique from Scaley Way Idle by Frotty. Turning this on or off takes a refresh.',
            },
            combatScalePlayers: {
                id: 'combatScalePlayers',
                label: 'Battle panel: Your side (%)',
                type: 'number',
                default: 100,
                min: 25,
                max: 200,
                help: 'Size of your own combat units. 100 leaves them as the game draws them',
                requires: 'combatScale',
            },
            combatScaleMonsters: {
                id: 'combatScaleMonsters',
                label: 'Battle panel: Enemy side (%)',
                type: 'number',
                default: 100,
                min: 25,
                max: 200,
                help: 'Size of the enemy combat units, set separately from yours — a wave of ten and a single boss want opposite things',
                requires: 'combatScale',
            },
            combatScaleMethod: {
                id: 'combatScaleMethod',
                label: 'Battle panel: How to resize',
                type: 'select',
                default: 'zoom',
                options: [
                    { value: 'zoom', label: 'Zoom — reflows, so shrinking recovers the space' },
                    { value: 'transform', label: 'Transform — scales in place, leaves a gap' },
                ],
                help: 'Zoom changes the layout size, so a shrunk side actually gives its space back. Transform only redraws smaller and leaves the original box behind; use it if zoom misbehaves in your browser',
                requires: 'combatScale',
            },
            combatScaleOrigin: {
                id: 'combatScaleOrigin',
                label: 'Battle panel: Transform anchor',
                type: 'select',
                default: 'top center',
                options: [
                    { value: 'top center', label: 'Top center' },
                    { value: 'top left', label: 'Top left' },
                    { value: 'center', label: 'Center' },
                ],
                help: 'Which corner a scaled side shrinks toward. Only used when resizing by transform',
                requires: 'combatScale',
            },
            combatScaleLayout: {
                id: 'combatScaleLayout',
                label: 'Battle panel: Layout',
                type: 'select',
                default: 'game',
                options: [
                    { value: 'game', label: "Leave the game's own layout" },
                    { value: 'side', label: 'Force side by side' },
                    { value: 'stack', label: 'Force stacked' },
                ],
                help: 'Forcing a layout overrides how the game arranges the two sides at your window width, so it can fight future game changes. Leave it alone unless you want the override',
                requires: 'combatScale',
            },
            combatScalePanelHeight: {
                id: 'combatScalePanelHeight',
                label: 'Character panel: Height (% of window, 0 = leave alone)',
                type: 'number',
                default: 0,
                min: 0,
                max: 100,
                help: 'Height of the inventory/equipment panel beside the fight, as a percentage of the window, up to all the room the game gives it. Set it shorter to give the fight room. 0 leaves the height the game picks',
                requires: 'combatScale',
            },
            updateCheck: {
                id: 'updateCheck',
                label: 'Check for a newer Toolasha release',
                type: 'checkbox',
                default: false,
                requiresRefresh: true,
                help:
                    'On page load, asks api.github.com for the latest release, compares it with the running version and shows a toast with an install ' +
                    'link when a newer one exists. The answer is cached, so the network is asked only as often as the ' +
                    'interval below allows.',
            },
            tabVersionSync: {
                id: 'tabVersionSync',
                label: 'Follow a newer Toolasha version loaded in another tab',
                type: 'select',
                default: 'ask',
                options: [
                    { value: 'ask', label: 'Ask (show a Reload notice)' },
                    { value: 'auto', label: 'Background tabs reload, the tab in use asks' },
                    { value: 'reload', label: 'Always reload' },
                    { value: 'off', label: 'Off' },
                ],
                help:
                    'When another tab loads a newer Toolasha, this tab shows a Reload notice. With "Background tabs ' +
                    'reload", a tab hidden for 2 minutes reloads itself once pending saves are written, if connected; ' +
                    'the tab in use still asks. "Always reload" reloads that one too. Off opens no channel between ' +
                    'tabs.',
            },
            updateCheckHours: {
                id: 'updateCheckHours',
                label: 'Update check: Hours between checks (0 = every refresh)',
                type: 'number',
                default: 6,
                requiresRefresh: true,
                min: 0,
                max: 168,
                help:
                    'How long a checked answer is trusted before the network is asked again, on page load and while a tab ' +
                    'stays open. At 0 every page load asks the network (the in-tab repeat still waits at least an hour).',
                requires: 'updateCheck',
            },
        },
    },

    guild: {
        title: 'Guild',
        icon: '👥',
        settings: {
            guildXPTracker: {
                id: 'guildXPTracker',
                label: 'Track guild and member XP over time',
                type: 'checkbox',
                default: true,
                help: 'Records guild and member XP data from WebSocket messages for XP/hr calculations on the Guild panel.',
            },
            guildXPDisplay: {
                id: 'guildXPDisplay',
                label: 'Show XP/hr stats on Guild panel',
                type: 'checkbox',
                default: true,
                help: 'Displays XP/hr rates, rankings, and a weekly chart on the Guild Overview, Members, and Guild Leaderboard tabs. Disable the standalone Guild XP/h userscript if using this.',
            },
            profileGuildBackButton: {
                id: 'profileGuildBackButton',
                label: 'Guild window: Back button to the profile',
                type: 'checkbox',
                default: true,
                help: 'Adds a Back button to a guild window you opened by clicking the guild name in a player profile. It reopens that profile, which the game otherwise replaces with no way back.',
            },
            guildIdleDisplay: {
                id: 'guildIdleDisplay',
                label: 'Guild Overview: Show idle members list',
                type: 'checkbox',
                default: true,
                help: 'Shows a list of guild members with no action running on the Guild Overview tab; offline members without one count too (shown dimmed). Members hiding their online status are included, but only their action state is shown, never their presence.',
            },
            guildTrialSignupDisplay: {
                id: 'guildTrialSignupDisplay',
                label: 'Guild Trials: Show unsigned members list',
                type: 'checkbox',
                default: true,
                help: "Displays which guild members have not yet signed up for the current week's skilling and combat trials.",
            },
            guildTrialWhisperTemplate: {
                id: 'guildTrialWhisperTemplate',
                label: 'Guild Trials: Whisper message when clicking a name',
                type: 'text',
                default: "/w {name} Why haven't you signed up for your trial(s) yet?!",
                help: "Message pre-filled in chat when clicking an unsigned member's name. Use {name} for the player's name.",
                templateVariables: [
                    { key: '{name}', label: 'Player Name', description: 'The name of the unsigned guild member' },
                ],
            },
            guildTrialsInfo: {
                id: 'guildTrialsInfo',
                label: 'Guild Trials: Enable (rates, pace and payout on In Progress, plus trial tools)',
                type: 'checkbox',
                default: true,
                help:
                    'Master switch for the Guild Trials features. The other Guild Trials settings need it on. Shows ' +
                    'rates, pace and payout on the In Progress tab: the ETA to clear the current tier, how many tiers ' +
                    "the hour is on pace for, the next tier's projected size, and the Guild Points and token payout.",
            },
            guildTrialSim: {
                id: 'guildTrialSim',
                label: 'Guild Trials: Experimental skilling and combat simulator',
                type: 'checkbox',
                default: false,
                help: 'Adds Trial Sim to the Guild page and command palette. Simulates a chosen roster locally with editable assumptions, per-tier clear odds and payout estimates. Does not sign up members or modify game loadouts.',
            },
            guildTrialKeepInputs: {
                id: 'guildTrialKeepInputs',
                label: 'Guild Trials: Keep captured inputs on this browser',
                type: 'checkbox',
                default: false,
                help: 'Saves trial loadouts and profiles while the capture helper is open, and restores the current guild/week after a refresh. Keeps the latest capture for up to eight guild/week sets per character locally. Captures retain their dates and can become outdated.',
                requires: 'guildTrialSim',
            },
            guildTrialTracking: {
                id: 'guildTrialTracking',
                label: 'Guild Trials: Track trial combat per player (damage, healing, kills)',
                type: 'checkbox',
                default: true,
                help: 'Reads the trial fight stream from the In Progress fight view and splits damage, healing and kills per player. Turning it off stops that at once, no reload: an open recording is filed and the live figures are dropped.',
                requires: 'guildTrialsInfo',
            },
            guildTrialBossDebuffs: {
                id: 'guildTrialBossDebuffs',
                label: 'Guild Trials: Show debuff timers on the trial boss',
                type: 'checkbox',
                default: true,
                help: 'Shows the debuffs the party has on the boss, with a countdown, on the boss tile in the In Progress fight view. The stream carries no buff state, so timers start when a debuffing ability is seen to hit; a stun lasts as long as the stream says the boss is stunned.',
                requires: 'guildTrialsInfo',
            },
            guildTrialPackUnits: {
                id: 'guildTrialPackUnits',
                label: 'Guild trials: keep party players in a fixed order and wrap extras under your card',
                type: 'checkbox',
                default: true,
                help: "Keeps trial party members in a fixed order (combat: by role, then name; skilling: by name) so they stop jumping around at tier changes. Players who don't fit beside your card wrap into rows under it.",
                requires: 'guildTrialsInfo',
            },
            guildTrialAutoRecord: {
                id: 'guildTrialAutoRecord',
                label: 'Guild Trials: Record a trial automatically when one starts',
                type: 'checkbox',
                default: true,
                help:
                    'Starts a recording session by itself when a trial fight is seen or the In Progress tab ' +
                    'shows a live reading, so the whole hour is captured without having to press anything. ' +
                    'The Record button on the trials block starts and stops one by hand either way.',
                requires: 'guildTrialsInfo',
            },
            guildTrialAutoOpenScoreboard: {
                id: 'guildTrialAutoOpenScoreboard',
                label: 'Guild Trials: Open the trial damage board when a trial fight starts',
                type: 'checkbox',
                default: false,
                help: "Opens the per-player damage board when a trial fight starts being watched, once per trial; closing it keeps it closed until the next trial, reloads included. A button beside the guild panel's tabs opens or closes it by hand.",
                requires: 'guildTrialsInfo',
            },
            guildTrialDiagnosticTrace: {
                id: 'guildTrialDiagnosticTrace',
                label: 'Guild Trials: Keep a raw diagnostic trace of trial combat',
                type: 'checkbox',
                default: false,
                help: 'Records every trial battle message as it arrives, for exporting as a file a reviewer can reconstruct the fight from. The file is large (thousands of ticks an hour) and includes participant names. Nothing is uploaded; the trace stays in memory until you export or clear it.',
                requires: 'guildTrialsInfo',
            },
            guildTrialsBuildersHallBonus: {
                id: 'guildTrialsBuildersHallBonus',
                label: 'Guild Trials: Builders Hall bonus override (%)',
                type: 'number',
                default: 0,
                help:
                    'Guild Points are Base × (1 + Builders Hall bonus). Leave at 0 to read it from the game once ' +
                    'the guild Buildings tab has been opened; set it here if your guild knows the number and the ' +
                    'game does not expose it.',
            },
            guildTrialsTreasuryBonus: {
                id: 'guildTrialsTreasuryBonus',
                label: 'Guild Trials: Treasury bonus override (%)',
                type: 'number',
                default: 0,
                help:
                    'Token payouts are 0.5 × TotalBasePoints × (1 + Treasury bonus). Leave at 0 to read it from ' +
                    'the game once the guild Buildings tab has been opened.',
            },
            guildMembersActivityTab: {
                id: 'guildMembersActivityTab',
                label: 'Guild Members: Show Activity column on',
                type: 'select',
                default: 'contributions',
                options: [
                    { value: 'status', label: 'Status tab only (native)' },
                    { value: 'contributions', label: 'Contributions tab only' },
                    { value: 'both', label: 'Both tabs' },
                ],
                help: 'Controls where the Activity column appears. "Contributions tab only" hides the native column on Status and shows it on Contributions instead.',
            },
            guildMembersShowGameMode: {
                id: 'guildMembersShowGameMode',
                label: 'Guild Members: Show Game Mode column',
                type: 'checkbox',
                default: true,
                help: 'Shows the MC/IC/LC game mode column (Status tab).',
            },
            guildMembersShowJoined: {
                id: 'guildMembersShowJoined',
                label: 'Guild Members: Show Joined column',
                type: 'checkbox',
                default: true,
                help: 'Shows the date each member joined the guild (Status tab).',
            },
            guildMembersShowLastXPH: {
                id: 'guildMembersShowLastXPH',
                label: 'Guild Members: Show Last XP/h column',
                type: 'checkbox',
                default: true,
                help: 'Shows recent XP/hr tracked by Toolasha (Contributions tab).',
                requires: 'guildXPDisplay',
            },
            guildMembersShowLastDayXPH: {
                id: 'guildMembersShowLastDayXPH',
                label: 'Guild Members: Show Last day XP/h column',
                type: 'checkbox',
                default: true,
                help: 'Shows 24-hour average XP/hr tracked by Toolasha (Contributions tab).',
                requires: 'guildXPDisplay',
            },
            guildTokenCreditRate: {
                id: 'guildTokenCreditRate',
                label: 'Guild Shop: Guild credits received per guild token',
                type: 'number',
                default: 1,
                min: 0,
                help: 'A last-resort guess for credits per guild token, used only when the game publishes no exchange rate and no Guild Shop dialog has been read. Figures built on it say "assumed rate", the upgrade advisor marks them, and net worth ignores them. Set to 0 to leave tokens unpriced.',
            },
            guildCreditValue: {
                id: 'guildCreditValue',
                needsPrices: true,
                label: 'Guild Shop: Show gold cost per credit table',
                type: 'checkbox',
                default: true,
                help: 'Injects a cost-efficiency table into each guild credit exchange modal, sorted cheapest first using your profit pricing mode.',
            },
            guildCreditExchangeAdvisor: {
                id: 'guildCreditExchangeAdvisor',
                needsPrices: true,
                label: 'Guild Shop: Show exchange advisor (sell → rebuy comparison)',
                type: 'checkbox',
                default: true,
                help: 'When the selected item is not the cheapest option, shows whether selling it and rebuying the best item would yield more credits (accounts for the market seller tax). Needs "Guild Shop: Show gold cost per credit table".',
                requires: 'guildCreditValue',
            },
            guildShrineUpgradePlanner: {
                id: 'guildShrineUpgradePlanner',
                label: 'Guild Shop: Show shrine upgrade planner',
                type: 'checkbox',
                default: true,
                help: 'Adds a shrine upgrade planner to the guild credit exchange panel, showing total credit and token costs to upgrade from your current level to a target level. Needs "Guild Shop: Show gold cost per credit table".',
                requires: 'guildCreditValue',
            },
            guildTrialLedger: {
                id: 'guildTrialLedger',
                label: 'Guild Trials: Attendance ledger and roster composition planner',
                type: 'checkbox',
                default: true,
                help:
                    'Keeps a per-member tally of every trial recorded on this client (trials joined, damage share, ' +
                    "healing, damage taken, deaths, mana-starved time) for far longer than the trials panel's four " +
                    'cycles. Adds a Trial Ledger panel with a sortable table, CSV export and sign-up composition ' +
                    'check.',
                requiresRefresh: true,
            },
            guildRoster: {
                id: 'guildRoster',
                label: 'Guild Roster: Contribution shares and gone-quiet flags',
                type: 'checkbox',
                default: true,
                help: 'Adds a Guild Roster overlay tile and panel showing each member’s share of the XP actually observed over 7 and 30 days, who has gone quiet against their own weekly rate, and a guild level projection. Uses the XP the Guild XP Tracker has already recorded.',
                requiresRefresh: true,
            },
        },
    },

    insights: {
        title: 'Insights',
        icon: '🔍',
        settings: {
            insights_calibration: {
                id: 'insights_calibration',
                needsPrices: true,
                label: 'Prediction Calibration: Check profit forecasts against finished runs',
                type: 'checkbox',
                default: true,
                help: 'Records what the profit calculators predicted for an action beside what the loot log says the run actually paid, and flags skills where the forecast is persistently off. Adds a Prediction Calibration overlay tile and panel.',
                requiresRefresh: true,
            },
            insights_calibrationBadges: {
                id: 'insights_calibrationBadges',
                needsPrices: true,
                label: 'Prediction Calibration: Show track-record badges beside forecasts',
                type: 'checkbox',
                default: true,
                help: 'Marks profit forecasts (action panel, action bar, alchemy rankings, all-zones sim) with how that forecast has fared against finished runs — e.g. “−12% over 40 runs” when it has run hot, or “on target”. Nothing is shown until enough runs are measured.',
                requires: 'insights_calibration',
            },
        },
    },

    house: {
        title: 'House',
        icon: '🏠',
        settings: {
            houseUpgradeCosts: {
                id: 'houseUpgradeCosts',
                needsPrices: true,
                label: 'House: Show room upgrade costs with market prices and inventory comparison',
                type: 'checkbox',
                default: true,
            },
        },
    },

    leaderboard: {
        title: 'Leaderboard',
        icon: '🏆',
        settings: {
            leaderboardXPTracker: {
                id: 'leaderboardXPTracker',
                label: 'Track player XP over time from Leaderboard',
                type: 'checkbox',
                default: true,
                help: 'Records player XP from leaderboard WebSocket messages for XP/hr calculations on the Leaderboard panel.',
            },
            leaderboardXPDisplay: {
                id: 'leaderboardXPDisplay',
                requiresRefresh: true,
                label: 'Show XP/hr columns on Leaderboard',
                type: 'checkbox',
                default: true,
                help: 'Adds Last XP/h and Last day XP/h columns to the player Leaderboard panel.',
            },
            leaderboardRankBadges: {
                id: 'leaderboardRankBadges',
                label: 'Leaderboard rank badges next to player names',
                type: 'select',
                default: 'off',
                options: [
                    { value: 'off', label: 'Off' },
                    { value: 'local', label: 'Local only (leaderboards you open)' },
                    { value: 'server', label: 'MWITools data server (polls an external site every 15 min)' },
                ],
                help:
                    'Shows a pill with a skill icon and rank beside players in the top 100 of a leaderboard (chat, guild, ' +
                    'friends, profiles): gold, silver and bronze bands, rainbow border for the top 20. Local only uses ' +
                    'just the rows the game sends when you open a leaderboard. The MWITools data server option fetches ' +
                    'from a third-party host (mwi-guild.43.167.210.211.sslip.io, not run by Toolasha) every 15 minutes ' +
                    'while the game is open; each request is a plain GET carrying only the board type, but the host sees ' +
                    'your IP address. Off contacts nobody.',
            },
            leaderboardRankBadgesSteam: {
                id: 'leaderboardRankBadgesSteam',
                label: 'Rank badges: include Steam leaderboards (Local only)',
                type: 'checkbox',
                default: false,
                help:
                    'With Local only rank badges, Steam boards you open also count toward badges, kept apart from the ' +
                    'global boards and labeled Standard (Steam) or Ironcow (Steam) in the tooltip. No effect with the ' +
                    'MWITools data server or Off.',
            },
            leaderboardRankBadgesSteamMark: {
                id: 'leaderboardRankBadgesSteamMark',
                label: 'Rank badges: mark Steam ranks with an S',
                type: 'checkbox',
                default: false,
                help:
                    'When the rank on a badge comes from a Steam board, shows a small S before the number so it ' +
                    'is not mistaken for a global rank. The tooltip names the board either way. Only matters ' +
                    'while Steam leaderboards are included above.',
                requires: 'leaderboardRankBadgesSteam',
            },
            leaderboardRankBadgesPreferStandard: {
                id: 'leaderboardRankBadgesPreferStandard',
                label: 'Rank badges: prefer the standard rank over Steam',
                type: 'checkbox',
                default: false,
                help:
                    'A player with any non-Steam rank shows their best non-Steam rank on the badge even if a Steam rank ' +
                    'is better (the Steam rank stays in the tooltip). Players with only Steam ranks show the Steam one. ' +
                    'Matters only while Steam leaderboards are included above.',
                requires: 'leaderboardRankBadgesSteam',
            },
        },
    },

    notifications: {
        title: 'Notifications',
        icon: '🔔',
        settings: {
            notifications_browserEnabled: {
                id: 'notifications_browserEnabled',
                label: 'Allow desktop notifications',
                type: 'checkbox',
                default: false,
                help: 'Master switch for desktop notifications; asks the browser for permission when you tick it. With this off or permission refused, notifications still show as an in-page toast, and as a ❗ on the tab title when the tab is hidden.',
            },
            notifiEmptyAction: {
                id: 'notifiEmptyAction',
                label: 'Notify when the current character queue is empty',
                type: 'checkbox',
                default: false,
                help: 'Keys on the action queue going from having actions to having none, as reported by the game over the websocket. Covers only the character you are logged in as, and only while the game page is open.',
            },
            notifications_consumableLow: {
                id: 'notifications_consumableLow',
                label: 'Notify when drinks are running low',
                type: 'checkbox',
                default: false,
                help: 'Notifies when the soonest drink to run out falls below the "Drink timer: warning threshold (hours)" setting, once per crossing; restocking re-arms it. Requires the Drink Timer feature. Covers the skill you are performing and any skill panel you have open.',
            },
            notifications_marketListingFilled: {
                id: 'notifications_marketListingFilled',
                label: 'Notify when a market listing finishes',
                type: 'checkbox',
                default: false,
                help: "Notifies when the count of finished listings goes up: an order that filled completely, or a canceled one holding a refund. Partly filled orders don't count. Works whether or not the Marketplace badge filter is on.",
            },
            notifications_marketListingUndercut: {
                id: 'notifications_marketListingUndercut',
                label: 'Notify when a market listing of yours is undercut',
                type: 'checkbox',
                default: false,
                help: 'Notifies when a sell listing of yours has a cheaper best ask in front of it, or a buy order has a higher best bid (matching your price is not an undercut). Uses cached market data up to 15 minutes old; items with older or no price are skipped. Once per listing per undercut; re-arms when you reprice.',
            },
            notifications_savingsGoalReached: {
                id: 'notifications_savingsGoalReached',
                label: 'Notify when a savings goal becomes affordable',
                type: 'checkbox',
                default: false,
                help:
                    'Notifies the first time a target on the Equipment Savings list (gear, ability level or house ' +
                    'room) costs less than you can spend. The message states the price age. Once per goal. Re-arms ' +
                    'when you spend back below the cost or change the target. Goals reached by leveling or building ' +
                    'are skipped.',
            },
            notifications_priceTargetReached: {
                id: 'notifications_priceTargetReached',
                label: 'Notify when a watchlist price target is reached',
                type: 'checkbox',
                default: false,
                help:
                    'Notifies when a pinned item on the price history panel hits the target set with its chip ◎ ' +
                    'button (ask at or under, bid at or above). Needs "Market: Price history panel" on and stays ' +
                    'quiet without its pooled data. Sightings over 15 minutes old fire nothing. Once per target; ' +
                    're-arms on a move back.',
            },
            notifications_otherCharacterIdle: {
                id: 'notifications_otherCharacterIdle',
                label: 'Notify when another character has run out of queue',
                type: 'checkbox',
                default: false,
                help: "Projected, not observed: each other character's queue is captured when you switch away from it, and this fires when that much time has passed. Characters with an unbounded action are skipped, and queues changed from elsewhere are invisible. Announced again only after you next switch away.",
            },
            notifications_labyrinthRunFinished: {
                id: 'notifications_labyrinthRunFinished',
                label: 'Notify when the labyrinth stops',
                type: 'checkbox',
                default: false,
                help: 'Notifies when your current action leaves the labyrinth: the queued rooms ran out or a fight was lost. Reports the deepest floor reached and what the character is doing instead (no reason is available). Once per stop; queuing the labyrinth again re-arms it.',
            },
            notifications_combatConsumableLow: {
                id: 'notifications_combatConsumableLow',
                label: 'Notify when a combat consumable is running low',
                type: 'checkbox',
                default: false,
                help: "Notifies when the soonest food or drink in your current fight falls under the hours below, the same 'stops in …' reading as the Consumables panel. Your own slots only; once per crossing, and restocking re-arms it.",
            },
            notifications_combatConsumableLowHours: {
                id: 'notifications_combatConsumableLowHours',
                label: 'Combat consumable warning threshold (hours)',
                type: 'number',
                default: 3,
                help: 'How many hours of supply are left when the alert above fires. Decimals are fine (0.5 is half an hour).',
            },
            notifications_labyrinthEntryAvailable: {
                id: 'notifications_labyrinthEntryAvailable',
                label: 'Notify when a labyrinth entry regenerates',
                type: 'checkbox',
                default: false,
                help: 'The Labyrinth holds up to five entries and regenerates one on a cooldown. Notifies when the stock rises, or when the projected regeneration time passes on an open tab. Once per regeneration; a full stock is announced once.',
            },
            notifications_combatDeath: {
                id: 'notifications_combatDeath',
                label: 'Notify when you die in combat',
                type: 'checkbox',
                default: false,
                help: "Notifies the moment your own character dies in combat (not the party's, and not on respawn). One message per cooldown, so a zone that keeps killing you says so once. Deaths from before you switched this on are not announced; a missed tick is caught from the server's death count.",
            },
            notifications_partyStatus: {
                id: 'notifications_partyStatus',
                label: 'Notify when your party starts or stops fighting',
                type: 'checkbox',
                default: false,
                help: 'Notifies when your party starts or stops fighting, whoever started it; no reason is given. Only real changes count: a party already fighting when you log in or switch character says nothing. Your own party only; once per change.',
            },
            notifications_skillLevelUp: {
                id: 'notifications_skillLevelUp',
                label: 'Notify when you hit a skill milestone',
                type: 'checkbox',
                default: false,
                help: 'Notifies on the skill milestones the game broadcasts to guild chat as "… has reached level …" (100, 105, and so on), only for your own character. Needs a guild and guild chat coming through. One message per milestone.',
            },
            notifications_ttlTargetReached: {
                id: 'notifications_ttlTargetReached',
                label: 'Notify when a skill reaches its Time to Level target',
                type: 'checkbox',
                default: false,
                help: 'Notifies once a skill reaches the target level you set in the Time to Level tile (Combat Level panel). Only a target you chose counts; the default "next level" is left to the level-up notification. Re-arms on a new target; a target already passed when you switched this on is not announced.',
            },
            notifications_bestiaryPointsTarget: {
                id: 'notifications_bestiaryPointsTarget',
                label: 'Notify when your Bestiary points reach a target',
                type: 'checkbox',
                default: false,
                help: 'Notifies once when your total Bestiary points reach the target. Set it per character with "Notify me at N points" under the Bestiary plan in the combat simulator, or use the default below. Open Achievements once (or run the combat sim) to start tracking; estimates between readings say "about".',
            },
            notifications_bestiaryPointsTargetDefault: {
                id: 'notifications_bestiaryPointsTargetDefault',
                label: 'Bestiary points target (default for characters without their own)',
                type: 'number',
                default: 0,
                min: 0,
                help: 'Total Bestiary points to be told about, for any character that has not had one set from the Bestiary plan. 0 means none. A target set from the planner belongs to that character alone and wins over this.',
            },
            notifications_enhancementTarget: {
                id: 'notifications_enhancementTarget',
                label: 'Notify when an item reaches its enhancement target',
                type: 'checkbox',
                default: false,
                help: 'Notifies when an item reaches the "enhance until +N" you set in the game\'s enhancing panel; works with the Enhancement Tracker on or off. Nothing is announced when no target is set. Once per item and target; re-arms when the item is seen below the target again.',
            },
            notifications_philosophersStone: {
                id: 'notifications_philosophersStone',
                label: 'Notify when transmuting produces a Philosopher’s Stone',
                type: 'checkbox',
                default: false,
                help: 'Reads the transmute result straight off the wire, so it works whether or not the Transmute History Tracker is on. Fires once per stone (or once per batch, naming how many, if several land in the same message) — not once per session.',
            },
            notifications_trialStarting: {
                id: 'notifications_trialStarting',
                label: 'Notify when a guild trial is about to start',
                type: 'checkbox',
                default: false,
                help: "Notifies when the next guild trial's countdown is inside the lead time below, and again when it starts. The schedule is only read while the guild panel is open.",
                requires: 'guildTrialsInfo',
            },
            notifications_trialStartLeadMinutes: {
                id: 'notifications_trialStartLeadMinutes',
                label: 'Guild trial warning lead time (minutes)',
                type: 'number',
                default: 10,
                min: 1,
                max: 120,
                help: 'How long before a scheduled guild trial to announce it.',
                requires: 'notifications_trialStarting',
            },
            notifications_trialAudience: {
                id: 'notifications_trialAudience',
                label: 'Guild trial start alerts: who they are for',
                type: 'select',
                default: 'guild',
                options: [
                    { value: 'guild', label: 'Every guild trial' },
                    { value: 'signedUp', label: 'Only when I am signed up this week' },
                ],
                help: 'Applies to the “about to start” and “has started” alerts above; the results alert is unchanged. When the guild panel has not shown this character’s sign-up yet, the alert fires anyway rather than stay silent.',
                requires: 'notifications_trialStarting',
            },
            notifications_trialResults: {
                id: 'notifications_trialResults',
                label: 'Notify when a guild trial finishes, with what it paid',
                type: 'checkbox',
                default: false,
                help: 'Announces the Guild Points banked and the token payout — every eligible member’s share and a participant’s — as soon as the guild panel reports the cycle complete.',
                requires: 'guildTrialsInfo',
            },
            notifications_taskSlotsFull: {
                id: 'notifications_taskSlotsFull',
                label: 'Notify before your task slots fill up',
                type: 'checkbox',
                default: false,
                help: 'Warns before your last free task slot fills (a task that arrives with no free slot is simply not given). Works with the task panel closed. A projection, not an observation: it assumes the cadence holds. Completing, claiming or discarding a task re-arms it; an already full board says so once.',
            },
            notifications_taskSlotsLeadHours: {
                id: 'notifications_taskSlotsLeadHours',
                label: 'Task slots warning lead time (hours)',
                type: 'number',
                default: 8,
                min: 1,
                max: 48,
                help: 'How long before the last free task slot fills to warn you — enough notice to claim or clear something. Default: 8.',
            },
            notifications_communityBuffExpiring: {
                id: 'notifications_communityBuffExpiring',
                label: 'Notify before a community buff expires',
                type: 'checkbox',
                default: false,
                help: 'Warns before a community buff expires, timed off the real expiry the server sends. Once per expiry; a donation that extends a buff re-arms it. Pick which buffs count with the per-buff switches below.',
            },
            notifications_communityBuffLeadMinutes: {
                id: 'notifications_communityBuffLeadMinutes',
                label: 'Community buff warning: minutes ahead',
                type: 'number',
                default: 15,
                min: 5,
                max: 120,
                help: 'How many minutes before a community buff’s actual expiry to warn you — enough notice to get to the Cowbell Store and donate. Default: 15.',
            },
            notifications_communityBuff_experience: {
                id: 'notifications_communityBuff_experience',
                label: 'Community buff: Experience',
                type: 'checkbox',
                default: true,
                help: 'Include the Experience community buff in the expiry warning. Only has an effect while "Notify before a community buff expires" is on.',
            },
            notifications_communityBuff_gatheringQuantity: {
                id: 'notifications_communityBuff_gatheringQuantity',
                label: 'Community buff: Gathering Quantity',
                type: 'checkbox',
                default: true,
                help: 'Include the Gathering Quantity community buff in the expiry warning. Only has an effect while "Notify before a community buff expires" is on.',
            },
            notifications_communityBuff_productionEfficiency: {
                id: 'notifications_communityBuff_productionEfficiency',
                label: 'Community buff: Production Efficiency',
                type: 'checkbox',
                default: true,
                help: 'Include the Production Efficiency community buff in the expiry warning. Only has an effect while "Notify before a community buff expires" is on.',
            },
            notifications_communityBuff_enhancingSpeed: {
                id: 'notifications_communityBuff_enhancingSpeed',
                label: 'Community buff: Enhancing Speed',
                type: 'checkbox',
                default: true,
                help: 'Include the Enhancing Speed community buff in the expiry warning. Only has an effect while "Notify before a community buff expires" is on.',
            },
            notifications_communityBuff_combatDropQuantity: {
                id: 'notifications_communityBuff_combatDropQuantity',
                label: 'Community buff: Combat Drop Quantity',
                type: 'checkbox',
                default: true,
                help: 'Include the Combat Drop Quantity community buff in the expiry warning. Only has an effect while "Notify before a community buff expires" is on.',
            },
            notifications_digestEnabled: {
                id: 'notifications_digestEnabled',
                label: 'Digest mode: batch routine notices into one summary',
                type: 'checkbox',
                default: false,
                help: 'Holds low-urgency notices and delivers them as one summary line every few minutes (e.g. "Market: 3 undercuts (Cheese, Milk, Flax) · Buffs: 1 lapsing") instead of one toast each. Every held notice is still written to the Notices log, and critical categories are never held.',
            },
            notifications_digestMinutes: {
                id: 'notifications_digestMinutes',
                label: 'Digest interval (minutes)',
                type: 'number',
                default: 15,
                min: 1,
                max: 240,
                help: 'How long a digest collects for before it goes out. The clock starts with the first held notice rather than restarting with each one, so a steady trickle still produces a summary on schedule. Default: 15.',
            },
            notifications_digestCategories: {
                id: 'notifications_digestCategories',
                label: 'Digest these categories (comma-separated)',
                type: 'text',
                default: 'market, buffs, tasks, labyrinth, guild, skills, enhancement, progress, other',
                help: 'Which categories batch when digest mode is on. Anything not listed here keeps arriving one notice at a time. Known categories: market, buffs, consumables, queue, combat, tasks, labyrinth, guild, skills, enhancement, progress, other.',
            },
            notifications_criticalCategories: {
                id: 'notifications_criticalCategories',
                label: 'Never delay or silence these categories (comma-separated)',
                type: 'text',
                default: 'combat, queue, consumables',
                help: 'The allow-list that outranks digest mode and quiet hours: dying, running out of queue and running out of drinks always get through. Uses the same category names as the digest list above; emptying it makes everything digestible and silenceable.',
            },
            notifications_quietHoursEnabled: {
                id: 'notifications_quietHoursEnabled',
                label: 'Quiet hours: no desktop notifications in a set window',
                type: 'checkbox',
                default: false,
                help: 'Suppresses desktop notifications between the two times below. Notices still go to the Notices log, the overlay tile count and the in-page toast. Categories on the critical allow-list are unaffected.',
            },
            notifications_quietHoursStart: {
                id: 'notifications_quietHoursStart',
                label: 'Quiet hours start (24h, local time)',
                type: 'text',
                default: '23:00',
                help: 'HH:MM in your own local time, read off the wall clock rather than from elapsed time — so the window stays put across a daylight-saving change. A window that ends before it starts crosses midnight, which is the usual case.',
            },
            notifications_quietHoursEnd: {
                id: 'notifications_quietHoursEnd',
                label: 'Quiet hours end (24h, local time)',
                type: 'text',
                default: '07:00',
                help: 'HH:MM in your own local time. Exclusive: an end of 07:00 means the last quiet minute is 06:59. Setting it equal to the start switches the window off rather than silencing the whole day.',
            },
        },
    },

    colors: {
        title: 'Color Customization',
        icon: '🎨',
        settings: {
            color_profit: {
                id: 'color_profit',
                label: 'Profit/Positive Values',
                type: 'color',
                default: '#10b981',
                help: 'Color used for profit, gains, and positive values',
            },
            color_loss: {
                id: 'color_loss',
                label: 'Loss/Negative Values',
                type: 'color',
                default: '#f87171',
                help: 'Color used for losses, costs, and negative values',
            },
            color_warning: {
                id: 'color_warning',
                label: 'Warnings',
                type: 'color',
                default: '#ffa500',
                help: 'Color used for warnings and important notices',
            },
            color_info: {
                id: 'color_info',
                label: 'Informational',
                type: 'color',
                default: '#60a5fa',
                help: 'Color used for informational text and highlights',
            },
            color_essence: {
                id: 'color_essence',
                label: 'Essences',
                type: 'color',
                default: '#c084fc',
                help: 'Color used for essence drops and essence-related text',
            },
            color_tooltip_profit: {
                id: 'color_tooltip_profit',
                label: 'Tooltip Profit/Positive',
                type: 'color',
                default: '#047857',
                help: 'Color for profit/positive values in tooltips (light backgrounds)',
            },
            color_tooltip_loss: {
                id: 'color_tooltip_loss',
                label: 'Tooltip Loss/Negative',
                type: 'color',
                default: '#dc2626',
                help: 'Color for loss/negative values in tooltips (light backgrounds)',
            },
            color_tooltip_info: {
                id: 'color_tooltip_info',
                label: 'Tooltip Informational',
                type: 'color',
                default: '#2563eb',
                help: 'Color for informational text in tooltips (light backgrounds)',
            },
            color_tooltip_warning: {
                id: 'color_tooltip_warning',
                label: 'Tooltip Warnings',
                type: 'color',
                default: '#ea580c',
                help: 'Color for warnings in tooltips (light backgrounds)',
            },
            color_text_primary: {
                id: 'color_text_primary',
                label: 'Primary Text',
                type: 'color',
                default: '#ffffff',
                help: 'Main text color',
            },
            color_text_secondary: {
                id: 'color_text_secondary',
                label: 'Secondary Text',
                type: 'color',
                default: '#888888',
                help: 'Dimmed/secondary text color',
            },
            color_border: {
                id: 'color_border',
                label: 'Borders',
                type: 'color',
                default: '#444444',
                help: 'Border and separator color',
            },
            color_gold: {
                id: 'color_gold',
                label: 'Gold/Currency',
                type: 'color',
                default: '#ffa500',
                help: 'Color used for gold and currency displays',
            },
            color_mirror: {
                id: 'color_mirror',
                label: "Philosopher's Mirror",
                type: 'color',
                default: '#ffd700',
                help: "Color for the Philosopher's Mirror usage line in enhancement tooltips",
            },
            color_listing_price_1m: {
                id: 'color_listing_price_1m',
                label: 'Listing Total: 1M+',
                type: 'color',
                default: '#ffd700',
                help: 'Color for market listing total prices of 1 million or more',
            },
            color_listing_price_100k: {
                id: 'color_listing_price_100k',
                label: 'Listing Total: 100K+',
                type: 'color',
                default: '#22c55e',
                help: 'Color for market listing total prices of 100K or more',
            },
            color_listing_price_10k: {
                id: 'color_listing_price_10k',
                label: 'Listing Total: 10K+',
                type: 'color',
                default: '#ffffff',
                help: 'Color for market listing total prices of 10K or more',
            },
            color_listing_price_low: {
                id: 'color_listing_price_low',
                label: 'Listing Total: <10K',
                type: 'color',
                default: '#888888',
                help: 'Color for market listing total prices under 10K',
            },
            color_accent: {
                id: 'color_accent',
                label: 'Script Accent Color',
                type: 'color',
                default: '#22c55e',
                help: 'Primary accent color for script highlights (zone numbers, XP percentages, some buttons, etc.)',
            },
            color_remaining_xp: {
                id: 'color_remaining_xp',
                label: 'Remaining XP Text',
                type: 'color',
                default: '#FFFFFF',
                help: 'Color for remaining XP text below skill bars in left navigation',
            },
            color_xp_rate: {
                id: 'color_xp_rate',
                label: 'XP Rate Text',
                type: 'color',
                default: '#ffffff',
                help: 'Color for XP/hr rate text on skill bars in left navigation, and for XP figures in the enhancement tables and tooltip',
            },
            color_hours_to_level: {
                id: 'color_hours_to_level',
                label: 'Hours to Level Text',
                type: 'color',
                default: '#ffffff',
                help: 'Color for "hours till next level" text in skill tooltips',
            },
            color_inv_count: {
                id: 'color_inv_count',
                label: 'Inventory Count Text',
                type: 'color',
                default: '#ffffff',
                help: 'Color for inventory count shown on action tiles and in the action detail panel',
            },
            color_invBadge_ask: {
                id: 'color_invBadge_ask',
                needsPrices: true,
                label: 'Inventory Badge: Ask Price',
                type: 'color',
                default: '#047857',
                help: 'Color for Ask price badges on inventory items (seller asking price - better selling value)',
            },
            color_invBadge_bid: {
                id: 'color_invBadge_bid',
                needsPrices: true,
                label: 'Inventory Badge: Bid Price',
                type: 'color',
                default: '#60a5fa',
                help: 'Color for Bid price badges on inventory items (buyer bid price - instant-sell value)',
            },
            color_transmute: {
                id: 'color_transmute',
                label: 'Transmutation Rates',
                type: 'color',
                default: '#ffffff',
                help: 'Color used for transmutation success rate percentages in Item Dictionary',
            },
            color_queueLength_known: {
                id: 'color_queueLength_known',
                needsPrices: true,
                label: 'Queue Length: Known Value',
                type: 'color',
                default: '#ffffff',
                help: 'Color for known queue lengths (when all visible orders are counted)',
            },
            color_queueLength_estimated: {
                id: 'color_queueLength_estimated',
                needsPrices: true,
                label: 'Queue Length: Estimated Value',
                type: 'color',
                default: '#60a5fa',
                help: 'Color for estimated queue lengths (extrapolated from 20+ orders at same price)',
            },
        },
    },

    collectionFilters: {
        title: 'Collection Filters',
        icon: '⭐',
        settings: {
            collectionFilters: {
                id: 'collectionFilters',
                label: 'Collection Filters: Count-range, dungeon, and skilling-outfit filters',
                type: 'checkbox',
                default: true,
            },
            collectionFavorites: {
                id: 'collectionFavorites',
                label: 'Collection Favorites: Star (★) items to mark and filter favorites',
                type: 'checkbox',
                default: true,
            },
            collectionFavoritesSection: {
                id: 'collectionFavoritesSection',
                label: 'Collection Favorites: Show favorites section at top of grid',
                type: 'checkbox',
                default: true,
                requires: 'collectionFavorites',
            },
            collectionFilters_skillingBadges: {
                id: 'collectionFilters_skillingBadges',
                label: 'Show collection count badges on skilling action tiles',
                type: 'checkbox',
                default: true,
                help: 'Displays your collection count on skilling actions (open Collections once to populate counts)',
            },
            achievementFinisher: {
                id: 'achievementFinisher',
                needsPrices: true,
                label: 'Achievement hints: readiness, Go and Missing Mats on each unfinished achievement card',
                type: 'checkbox',
                default: true,
                help:
                    'Adds a line under each unfinished card on your Achievements tab: whether your level is met and ' +
                    'what the inputs cost, plus Go (opens the screen) and Missing Mats (opens the marketplace) ' +
                    'buttons. Neither starts, queues or buys. Also toggled by the Toolasha hints box beside Show ' +
                    'Incomplete Only.',
            },
            collectionOptimizer: {
                id: 'collectionOptimizer',
                label: 'Collection Points Optimizer: cheapest next collection points on the Collections tab',
                type: 'checkbox',
                default: false,
                help:
                    'Ranks each item’s next collection-points rung by net gold per point across crafting, decompose ' +
                    'chains, shop gear decomposed, transmuting and gathering, and plans the best route to +N points. ' +
                    'Buying on the market does not collect. Appears once the Collections tab has loaded.',
            },
        },
    },

    sync: {
        title: 'Cross-Device Sync',
        icon: '☁️',
        settings: {
            sync_enabled: {
                id: 'sync_enabled',
                label: 'Enable cross-device sync (GitHub gist)',
                type: 'checkbox',
                default: false,
                help:
                    'Syncs your Toolasha data between browsers through a private GitHub gist you own (one for the live ' +
                    'game, a separate one for the test server). Nothing goes to any server of ours, and nothing is sent ' +
                    'until you press Push, turn on automatic sync below, or the game is taken over elsewhere (push on ' +
                    'switch). Shared by every character on this device.',
            },
            sync_token: {
                id: 'sync_token',
                label: 'GitHub personal access token',
                type: 'password',
                default: '',
                placeholder: 'ghp_… or github_pat_…',
                help:
                    'Needs the "gist" scope and nothing else: a classic token with only that box ticked, or a ' +
                    'fine-grained token with Gists set to read and write. SECURITY: the token is stored in this browser’s ' +
                    'local database in plain text, readable by any script or extension that can read this page; revoke it ' +
                    'at github.com/settings/tokens if you stop using sync. It is never synced.',
            },
            sync_passphrase: {
                id: 'sync_passphrase',
                label: 'Sync passphrase (optional encryption)',
                type: 'password',
                default: '',
                placeholder: 'Leave empty to sync unencrypted',
                help:
                    'When set, the gist holds AES-256 ciphertext instead of readable JSON. Enter the SAME passphrase on ' +
                    'every device sharing the gist; there is no recovery, so a forgotten one means pushing fresh from a ' +
                    'device that still has the data. It is stored in this browser’s local database in plain text and ' +
                    'never uploaded.',
            },
            sync_scope: {
                id: 'sync_scope',
                label: 'What to sync',
                type: 'select',
                default: 'settings',
                options: [
                    { value: 'settings', label: 'Settings only' },
                    { value: 'everything', label: 'Everything (settings + all tracked history)' },
                ],
                help:
                    'Settings only is small and fast. Everything also carries dungeon runs, XP history, loot logs and ' +
                    'the rest — the same contents as "Back Up Everything" — which on a played-in account can be many ' +
                    'megabytes and is split across several files inside the gist.',
            },
            sync_onSwitch: {
                id: 'sync_onSwitch',
                label: 'Push to GitHub when another device takes over',
                type: 'checkbox',
                default: false,
                help:
                    'With sync configured, this device pushes when another login takes the session over (a phone, say), ' +
                    'so its startup pulls collect the changes. Skipped when nothing changed. Switching characters here ' +
                    'does not push; those changes go up with the next automatic push or when you press Push.',
            },
            sync_auto: {
                id: 'sync_auto',
                label: 'Sync automatically',
                type: 'checkbox',
                default: false,
                help:
                    'Pulls once shortly after the page loads if the gist is newer than what this device last synced, ' +
                    'and pushes every 15 minutes if anything changed. When both sides have changed you are asked ' +
                    'which one wins rather than the older copy being overwritten quietly.',
            },
        },
    },
};

/**
 * Get all setting IDs in order
 * @returns {string[]} Array of setting IDs
 */
export function getAllSettingIds() {
    const ids = [];
    for (const group of Object.values(settingsGroups)) {
        for (const settingId of Object.keys(group.settings)) {
            ids.push(settingId);
        }
    }
    return ids;
}

/**
 * Get a setting definition by ID
 * @param {string} settingId - Setting ID
 * @returns {Object|null} Setting definition or null
 */
export function getSettingDefinition(settingId) {
    for (const group of Object.values(settingsGroups)) {
        if (group.settings[settingId]) {
            return group.settings[settingId];
        }
    }
    return null;
}

/**
 * Check if a setting has dependencies
 * @param {string} settingId - Setting ID
 * @returns {string[]} Array of dependency setting IDs
 */
export function getSettingDependencies(settingId) {
    const def = getSettingDefinition(settingId);
    return def?.dependencies || [];
}
