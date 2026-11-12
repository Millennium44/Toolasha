/**
 * Missing Materials Marketplace Button
 * Adds button to production, enhancement and alchemy panels that opens marketplace with tabs for missing materials
 */

import dataManager from '../../core/data-manager.js';
import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import webSocketHook from '../../core/websocket.js';
import {
    findActionInput,
    attachInputListeners,
    performInitialUpdate,
    onActionPanelsRefresh,
    onDetailPanel,
    resolveDetailPanel,
} from '../../utils/action-panel-helper.js';
import {
    calculateMaterialRequirements,
    calculateEnhancementMaterialRequirements,
    calculateEnhancementWholeAttempts,
    calculateQueuedMaterialsForAction,
    unclaimedBoughtCount,
} from '../../utils/material-calculator.js';
import { upgradeLevelForPanel } from '../../utils/upgrade-slot.js';
import { artisanTeaShortfall } from '../../utils/drink-calculator.js';
import { formatWithSeparator } from '../../utils/formatters.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { createAutofillManager, findQuantityInput } from '../../utils/marketplace-autofill.js';
import {
    createMaterialTab,
    updateTabBadge,
    createClearAllTabsControl,
    insertTabInOrder,
    removeMaterialTabs,
    setupMarketplaceCleanupObserver,
    navigateToMarketplace,
    navigateToMarketListingsTab,
    visibleTabsContainer,
    attachRegularTabClearListener,
} from '../../utils/marketplace-tabs.js';
import {
    getProtectionItemFromUI,
    getProtectFromLevelFromUI,
    getCurrentEnhancementLevel,
} from './enhancement-display.js';
import { calculateEnhancementPath } from '../enhancement/tooltip-enhancement.js';
import { getEnhancingParams } from '../../utils/enhancement-config.js';
import { createMutationWatcher } from '../../utils/dom-observer-helpers.js';
import { buildItemHash, parseItemHash } from '../../utils/item-hash.js';
import { readAlchemyPanelSelection } from '../alchemy/alchemy-profit.js';
import { openAlchemyOnItem, selectAlchemyTab as selectAlchemyTabAt } from '../../utils/alchemy-navigation.js';
import { getCatalystWhatIfResult, onCatalystWhatIfChange } from '../alchemy/alchemy-catalyst-whatif.js';
import { setReactInputValue } from '../../utils/react-input.js';
import { clickThroughReact } from '../../utils/react-click.js';
import { findEnhancingInput } from '../../utils/enhancing-inputs.js';
import { testerShopEnabled, testerShopCoinCost } from '../../utils/tester-shop.js';
// The walk to the Tester tab is shared with the Item Dictionary's ability-book
// panel — see utils/tester-shop-nav.js
import { findTesterTab, setShopFilter, openTesterShopPage } from '../../utils/tester-shop-nav.js';
import {
    effectiveInventory,
    onReservationsChanged,
    INVENTORY_LOCATION,
    release,
    reserve,
    reservedElsewhere,
    shortfallNote,
} from '../../utils/inventory-reservations.js';
import { ENHANCEMENT_SOLVER_MAX_LEVEL } from '../../utils/game-maximums.js';

/**
 * The owner this feature claims stock under, while its tabs are open.
 *
 * One id and not one per action: only one bill of materials is ever open at a
 * time (`storedActionHrid` and its siblings are single-valued), so a second bill
 * replacing the first is exactly right. Transient — the claim goes when the
 * player leaves the marketplace, and the ledger's TTL is only a backstop for
 * tabs that were never left properly.
 */
const RESERVATION_OWNER = 'missingMats';

/**
 * This feature's owner id for the marketplace tabs it pins — distinct from
 * `RESERVATION_OWNER`, which names the inventory-reservation ledger claim
 * rather than a DOM tab. Passed to `createMaterialTab` / `createClearAllTabsControl`
 * and to `removeMaterialTabs({ owner })`, so this feature's own tab-strip
 * rebuilds and teardowns never sweep up another feature's pinned tabs (the
 * shopping list's, in particular) the way the unscoped calls used to.
 */
const TAB_OWNER = 'missing-materials';

/**
 * Module-level state
 */
let cleanupObserver = null;
const currentMaterialsTabs = [];
let domObserverUnregister = null;
let enhancementDomObserverUnregister = null;
let unsubscribeRefresh = null;
let processedPanels = new WeakSet();
let processedEnhancingPanels = new WeakSet();
let enhancingPanelWatchers = [];
let inventoryUpdateHandler = null;
let unsubscribeBaseReservations = null;
let baseQueueHandler = null;
let billCharacterHandler = null;
let billGeneration = 0;
let storedActionHrid = null;
let storedNumActions = 0;
let storedEnhancementContext = null;
/**
 * Per-panel Missing Mats adjustments for Enhancing: the attempts to buy for (null = the computed
 * value) and the copies to enhance. In memory only; reset when the item, target, protection or
 * repeat count changes.
 * @type {WeakMap<HTMLElement, {key: string, attempts: number|null, copies: number}>}
 */
const enhancementAdjustments = new WeakMap();
const CONTROLS_ID = 'mwi-missing-mats-controls';
/**
 * Not a limit on what a player may ask for, a guard against a pasted or garbled figure. The bill is
 * cost x attempts x copies, so two figures at the guard can pass 1e18 and far exceed exact integers; the
 * calculator therefore caps each line's total at Number.MAX_SAFE_INTEGER, which keeps it plain digits.
 */
const ADJUST_GUARD = 1e9;
/** A plain bill of materials opened from elsewhere (a house level), kept for live updates */
let storedMaterialList = null;
/** The level the open bill's upgrade item is wanted at, kept so live updates do not lose it */
let storedUpgradeBaseAcquisition = null;
let storedUpgradeItemLevel = 0; // null: the panel's upgrade slot was empty
/**
 * The Alchemy panel's bill, kept for live updates and the Return tab:
 * `{itemHrid, actionType, numActions}`.
 * @type {{itemHrid: string, actionType: string|null, numActions: number}|null}
 */
let storedAlchemyContext = null;
/** Alchemy panels being watched → their teardown */
const alchemyPanelWatchers = new Map();
let alchemyDomObserverUnregister = null;
let alchemyRefreshTimeout = null;
/** dataManager listeners that redraw the Alchemy button: inventory and queue */
let alchemyDataHandler = null;
/** Unsubscribe from the profit display's catalyst what-if */
let alchemyWhatIfUnsubscribe = null;
const ALCHEMY_PANEL_SELECTOR = '[class*="SkillActionDetail_alchemyComponent"]';
/**
 * Its own id, not the production button's: the Alchemy panel is also a detail
 * panel, and the production path removes `#mwi-missing-mats-button` from every
 * panel it is handed before deciding the panel is not a production one.
 */
const ALCHEMY_BUTTON_ID = 'mwi-alchemy-missing-mats-button';
const timerRegistry = createTimerRegistry();
const autofillManager = createAutofillManager('MissingMats-Actions');

/**
 * Enhancement panel debounce timeout
 */
let enhancementDebounceTimeout = null;

/**
 * Production action types (where button should appear)
 */
const PRODUCTION_TYPES = [
    '/action_types/brewing',
    '/action_types/cooking',
    '/action_types/cheesesmithing',
    '/action_types/crafting',
    '/action_types/tailoring',
];

/** Label every Missing Mats button carries */
const ENHANCE_ACTION_HRID = '/actions/enhancing/enhance';
const ENHANCE_INVENTORY_LOCATION = '/item_locations/inventory';
const BUTTON_LABEL = 'Missing Mats Marketplace';

/**
 * What the button will buy: the lines that get a marketplace tab with something
 * still missing. Coins never reach the bill, and a non-tradeable line cannot be
 * bought, so neither is counted.
 *
 * @param {Array<Object>} materials - Lines from the material calculator
 * @returns {Array<Object>} Lines with a quantity to buy
 */
export function buyableMissing(materials) {
    if (!Array.isArray(materials)) return [];
    return materials.filter((m) => m && m.isTradeable !== false && m.missing > 0 && m.itemHrid !== '/items/coin');
}

/**
 * Label and tooltip for a button, from the same lines it will open.
 *
 * @param {Array<Object>} materials - Lines from the material calculator
 * @param {{note?: string}} [options] - `note` is appended to the tooltip
 * @returns {{label: string, title: string, count: number}} Nothing missing leaves the plain label
 */
export function describeMissingMaterials(materials, { note = '' } = {}) {
    const buy = buyableMissing(materials);
    if (buy.length === 0) return { label: BUTTON_LABEL, title: '', count: 0 };
    const list = buy.map((m) => `${m.itemName} ×${formatWithSeparator(m.missing)}`).join(', ');
    const title = `Will buy: ${list}${
        note
            ? `
${note}`
            : ''
    }`;
    return {
        label: `${BUTTON_LABEL} · ${buy.length} ${buy.length === 1 ? 'item' : 'items'}`,
        title,
        count: buy.length,
    };
}

/**
 * Initialize missing materials button feature
 */
export function initialize() {
    cleanupObserver = setupMarketplaceCleanupObserver(handleMarketplaceCleanup, currentMaterialsTabs);
    autofillManager.initialize();

    // Watch for production action panels appearing
    domObserverUnregister = onDetailPanel((context) => processActionPanel(context.panel));

    // Watch for enhancement panels appearing
    enhancementDomObserverUnregister = domObserver.onClass(
        'MissingMaterialsButton-EnhancingPanel',
        'SkillActionDetail_enhancingComponent__17bOx',
        (panel) => processEnhancingPanel(panel)
    );

    // The button's missing list reads the action queue; a finite queue change
    // must redraw a panel already on screen
    unsubscribeRefresh = onActionPanelsRefresh((panel, value) => updateButtonForPanel(panel, value));

    // Watch for Alchemy panels appearing
    alchemyDomObserverUnregister = domObserver.onClass(
        'MissingMaterialsButton-AlchemyPanel',
        'SkillActionDetail_alchemyComponent',
        (panel) => processAlchemyPanel(panel)
    );
    // The Alchemy bill reads the bag and the queue; either moving redraws it
    alchemyDataHandler = () => scheduleAlchemyUpdate();
    dataManager.on('items_updated', alchemyDataHandler);
    dataManager.on('actions_updated', alchemyDataHandler);
    // A catalyst picked in the profit display's what-if joins the bill
    alchemyWhatIfUnsubscribe = onCatalystWhatIfChange(() => scheduleAlchemyUpdate());

    // Process existing panels
    processActionPanels();
    processExistingEnhancingPanels();
    document.querySelectorAll(ALCHEMY_PANEL_SELECTOR).forEach((panel) => processAlchemyPanel(panel));
}

/**
 * Cleanup function
 */
export function cleanup() {
    if (domObserverUnregister) {
        domObserverUnregister();
        domObserverUnregister = null;
    }
    if (unsubscribeRefresh) {
        unsubscribeRefresh();
        unsubscribeRefresh = null;
    }

    if (enhancementDomObserverUnregister) {
        enhancementDomObserverUnregister();
        enhancementDomObserverUnregister = null;
    }

    // Disconnect marketplace cleanup observer
    if (cleanupObserver) {
        cleanupObserver();
        cleanupObserver = null;
    }

    autofillManager.cleanup();

    // Remove any existing custom tabs
    handleMarketplaceCleanup();

    // Disconnect enhancing panel mutation watchers
    enhancingPanelWatchers.forEach((unwatch) => unwatch());
    enhancingPanelWatchers = [];

    // Clear processed panels
    processedPanels = new WeakSet();
    processedEnhancingPanels = new WeakSet();

    // Clear enhancement debounce
    if (enhancementDebounceTimeout) {
        clearTimeout(enhancementDebounceTimeout);
        enhancementDebounceTimeout = null;
    }

    // Alchemy: the panel watchers (each removes its own button), the observer and the data listeners
    if (alchemyDomObserverUnregister) {
        alchemyDomObserverUnregister();
        alchemyDomObserverUnregister = null;
    }
    if (alchemyDataHandler) {
        dataManager.off('items_updated', alchemyDataHandler);
        dataManager.off('actions_updated', alchemyDataHandler);
        alchemyDataHandler = null;
    }
    if (alchemyWhatIfUnsubscribe) {
        alchemyWhatIfUnsubscribe();
        alchemyWhatIfUnsubscribe = null;
    }
    for (const unwatch of alchemyPanelWatchers.values()) unwatch();
    alchemyPanelWatchers.clear();
    if (alchemyRefreshTimeout) {
        clearTimeout(alchemyRefreshTimeout);
        alchemyRefreshTimeout = null;
    }

    timerRegistry.clearAll();
}

/**
 * Process action panels - watch for input changes
 */
function processActionPanels() {
    const panels = document.querySelectorAll('[class*="SkillActionDetail_skillActionDetail"]');
    panels.forEach((panel) => processActionPanel(panel));
}

/**
 * Attach to one action panel, once
 * @param {HTMLElement} panel - Action panel element
 */
function processActionPanel(panel) {
    if (processedPanels.has(panel)) {
        return;
    }

    // Find the input box using utility
    const inputField = findActionInput(panel);
    if (!inputField) {
        return;
    }

    // Mark as processed
    processedPanels.add(panel);

    // Attach input listeners using utility
    attachInputListeners(panel, inputField, (value) => {
        updateButtonForPanel(panel, value);
    });

    // Initial update if there's already a value
    performInitialUpdate(inputField, (value) => {
        updateButtonForPanel(panel, value);
    });
}

/**
 * Update button visibility and content for a panel based on input value
 * @param {HTMLElement} panel - Action panel element
 * @param {string} value - Input value (number of actions)
 */
function updateButtonForPanel(panel, value) {
    const numActions = parseInt(value) || 0;

    // Remove existing button and warning
    const existingButton = panel.querySelector('#mwi-missing-mats-button');
    if (existingButton) {
        existingButton.remove();
    }
    panel.querySelector('.mwi-artisan-shortfall-warning')?.remove();

    // Check setting early
    if (!config.getSetting('actions_missingMaterialsButton')) {
        return;
    }

    const actionHrid = getActionHridFromPanel(panel);
    if (!actionHrid) {
        return;
    }

    const gameData = dataManager.getInitClientData();
    const actionDetail = gameData.actionDetailMap[actionHrid];
    if (!actionDetail) {
        return;
    }

    // Verify this is a production action
    if (!PRODUCTION_TYPES.includes(actionDetail.type)) {
        return;
    }

    // Check if action has input materials
    if (!actionDetail.inputItems || actionDetail.inputItems.length === 0) {
        return;
    }

    // Determine disabled state: no quantity entered (∞ parses to 0)
    let missingMaterials = [];
    let disabled = false;
    // The stack the panel's upgrade slot shows (null: empty slot), so the bill and the opened
    // marketplace bill count the piece the craft would really spend
    const slotLevel = upgradeLevelForPanel(panel, actionDetail.upgradeItemHrid);

    if (numActions <= 0) {
        disabled = true;
    } else {
        // Get missing materials using shared utility
        // Check if user wants to ignore queue (default: false, meaning we DO account for queue)
        const ignoreQueue = config.getSetting('actions_missingMaterialsButton_ignoreQueue') || false;
        const accountForQueue = !ignoreQueue; // Invert: ignoreQueue=false means accountForQueue=true
        missingMaterials = calculateMaterialRequirements(actionHrid, numActions, accountForQueue, {
            ownerId: RESERVATION_OWNER,
            upgradeItemLevel: slotLevel,
        });
        if (missingMaterials.length === 0) {
            disabled = true;
        }
    }

    // Create and insert button with actionHrid and numActions for live updates
    const button = createMissingMaterialsButton(missingMaterials, actionHrid, numActions, disabled, () =>
        handleMissingMaterialsClick(actionHrid, numActions, slotLevel)
    );

    // Find insertion point (beneath item requirements field)
    const itemRequirements = panel.querySelector('.SkillActionDetail_itemRequirements__3SPnA');
    if (itemRequirements) {
        itemRequirements.parentNode.insertBefore(button, itemRequirements.nextSibling);
    } else {
        // Fallback: insert at top of panel
        panel.insertBefore(button, panel.firstChild);
    }

    // Warn when a slotted Artisan Tea will run dry partway through this run: the
    // bill above assumes its discount for every craft, but the last several would
    // actually cost full price. Distinct from the tea being out of stock right
    // now — that case gets no discount at all, and required-materials.js already
    // says so.
    if (numActions > 0) {
        const shortfalls = artisanTeaShortfall(actionHrid, numActions);
        if (shortfalls.length > 0) {
            const warning = document.createElement('div');
            warning.className = 'mwi-artisan-shortfall-warning';
            warning.style.cssText = 'color:#f0a830; font-size:11px; text-align:center; padding:3px 0 1px 0;';
            warning.textContent = shortfalls
                .map(
                    (s) =>
                        `⚠ ${s.name} runs out after ~${formatWithSeparator(s.craftsSustained)} crafts — ` +
                        `${formatWithSeparator(s.shortfall)} of these will not get the discount`
                )
                .join(' ');
            button.insertAdjacentElement('afterend', warning);
        }
    }

    // Don't manipulate modal styling - let the game handle it
    // The modal will scroll naturally if content overflows
}

/**
 * Get action HRID from panel
 * @param {HTMLElement} panel - Action panel element
 * @returns {string|null} Action HRID or null
 */
function getActionHridFromPanel(panel) {
    return resolveDetailPanel(panel).actionHrid;
}

/**
 * Process existing enhancing panels on the page
 */
function processExistingEnhancingPanels() {
    const panels = document.querySelectorAll('[class*="SkillActionDetail_enhancingComponent"]');
    panels.forEach((panel) => processEnhancingPanel(panel));
}

/**
 * Process an enhancing panel - set up mutation watcher and create button
 * @param {HTMLElement} panel - Enhancing panel element
 */
function processEnhancingPanel(panel) {
    if (!panel || processedEnhancingPanels.has(panel)) {
        return;
    }

    processedEnhancingPanels.add(panel);

    // Watch for changes (item swap, level change, protection change) with debounce
    const unwatch = createMutationWatcher(
        panel,
        (mutations) => {
            // Ignore mutations caused by our own button insertion/removal
            const isOwnButton = mutations.every((m) => {
                const nodes = [...m.addedNodes, ...m.removedNodes];
                return (
                    nodes.length > 0 && nodes.every((n) => n.id === 'mwi-missing-mats-button' || n.id === CONTROLS_ID)
                );
            });
            if (isOwnButton) return;

            if (enhancementDebounceTimeout) {
                clearTimeout(enhancementDebounceTimeout);
            }
            enhancementDebounceTimeout = setTimeout(() => {
                enhancementDebounceTimeout = null;
                updateEnhancementButton(panel);
            }, 500);
        },
        { childList: true, subtree: true, attributes: true }
    );
    enhancingPanelWatchers.push(unwatch);

    // Initial button creation (delay to let panel-observer set mwiItemHrid first)
    setTimeout(() => updateEnhancementButton(panel), 600);
}

/**
 * Get target enhancement level from UI input
 * @param {HTMLElement} panel - Enhancing panel element
 * @returns {number|null} Target level (1-20) or null if not found
 */
/**
 * Get repeat count from enhancement panel UI
 * @param {HTMLElement} panel - Enhancing panel element
 * @returns {number} Repeat count (defaults to 1 if not found)
 */
function getRepeatCountFromUI(panel) {
    const labels = Array.from(panel.querySelectorAll('*')).filter(
        (el) => el.textContent.trim() === 'Repeat' && el.children.length === 0
    );

    if (labels.length > 0) {
        const parent = labels[0].parentElement;
        const input = parent.querySelector('input[type="number"], input[type="text"]');
        if (input) {
            if (input.value === '∞') return null;
            const value = parseInt(input.value, 10);
            if (!isNaN(value) && value > 0) return value;
        }
    }

    return 1;
}

function getTargetLevelFromUI(panel) {
    // By the panel's structure as well as the English label, so a translated client reads it too
    const input = findEnhancingInput(panel, 'target');
    if (input && input.value) {
        const value = parseInt(input.value, 10);
        if (!isNaN(value) && value <= ENHANCEMENT_SOLVER_MAX_LEVEL) return Math.max(1, value);
    }

    return null;
}

/**
 * Update the missing materials button on an enhancement panel
 * @param {HTMLElement} panel - Enhancing panel element
 */
function updateEnhancementButton(panel) {
    // Remove the existing button; the adjust controls stay while they describe the same setup
    panel.querySelector('#mwi-missing-mats-button')?.remove();

    if (!config.getSetting('actions_missingMaterialsButton')) {
        panel.querySelector(`#${CONTROLS_ID}`)?.remove();
        return;
    }

    // Get item HRID (set by panel-observer.js)
    const itemHrid = panel.dataset.mwiItemHrid;
    if (!itemHrid) {
        panel.querySelector(`#${CONTROLS_ID}`)?.remove();
        return;
    }

    // Get current and target levels
    // Only the running enhance of THIS item counts: another item's level says nothing here
    const startLevel = getCurrentEnhancementLevel(panel, itemHrid) ?? 0;
    const targetLevel = getTargetLevelFromUI(panel);
    if (targetLevel === null || targetLevel <= startLevel) {
        panel.querySelector(`#${CONTROLS_ID}`)?.remove();
        return;
    }

    // Get protection settings from UI
    const protectionItemHrid = getProtectionItemFromUI(panel);
    const protectFromLevel = getProtectFromLevelFromUI(panel);
    const repeatCount = getRepeatCountFromUI(panel);

    // Auto-calculate optimal protection if user hasn't set one
    let resolvedProtectFrom = protectFromLevel;
    let resolvedProtectionItem = protectionItemHrid;
    let autoProtection = false;
    if (protectFromLevel === 0) {
        const enhancingConfig = getEnhancingParams();
        const pathResult = calculateEnhancementPath(itemHrid, targetLevel, enhancingConfig);
        if (pathResult?.optimalStrategy) {
            resolvedProtectFrom = pathResult.optimalStrategy.protectFrom;
            resolvedProtectionItem = pathResult.optimalStrategy.protectionItemHrid || protectionItemHrid;
            autoProtection = true;
        }
    }

    // The whole attempts the bill covers untouched: the repeat count, else the expected attempts rounded up
    const computedAttempts =
        repeatCount ?? calculateEnhancementWholeAttempts(itemHrid, startLevel, targetLevel, resolvedProtectFrom);

    // Any change to the setup the numbers describe resets the player's adjustments
    const key = [itemHrid, startLevel, targetLevel, resolvedProtectionItem, resolvedProtectFrom, repeatCount].join('|');
    let adjust = enhancementAdjustments.get(panel);
    if (!adjust || adjust.key !== key) {
        adjust = { key, attempts: null, copies: 1, computed: computedAttempts, render: null };
        enhancementAdjustments.set(panel, adjust);
        panel.querySelector(`#${CONTROLS_ID}`)?.remove();
    }
    // Controls outlive a refresh, so they read the current computed value and renderer from here
    adjust.computed = computedAttempts;

    const strategyInfo = autoProtection
        ? { protectFrom: resolvedProtectFrom, protectionItemHrid: resolvedProtectionItem }
        : null;

    const placeNode = (node) => {
        const itemRequirements = panel.querySelector('.SkillActionDetail_itemRequirements__3SPnA');
        if (itemRequirements) {
            itemRequirements.parentNode.insertBefore(node, itemRequirements.nextSibling);
        } else {
            const enhancementStats = panel.querySelector('#mwi-enhancement-stats');
            if (enhancementStats) {
                enhancementStats.parentNode.insertBefore(node, enhancementStats);
            } else {
                panel.appendChild(node);
            }
        }
    };

    // Build (or rebuild, after an adjustment) just the button from the current adjustments
    const renderButton = () => {
        panel.querySelector('#mwi-missing-mats-button')?.remove();
        const attempts = adjust.attempts ?? repeatCount;
        const missingMaterials = calculateEnhancementMaterialRequirements(
            itemHrid,
            startLevel,
            targetLevel,
            resolvedProtectionItem,
            resolvedProtectFrom,
            attempts,
            RESERVATION_OWNER,
            adjust.copies
        );
        const button = createEnhancementMissingMaterialsButton(
            missingMaterials,
            itemHrid,
            startLevel,
            targetLevel,
            resolvedProtectionItem,
            resolvedProtectFrom,
            attempts,
            missingMaterials.length === 0,
            strategyInfo,
            { copies: adjust.copies, adjustedAttempts: adjust.attempts !== null, computedAttempts: adjust.computed }
        );
        const controls = panel.querySelector(`#${CONTROLS_ID}`);
        if (controls) {
            controls.parentNode.insertBefore(button, controls.nextSibling);
        } else {
            placeNode(button);
        }
    };

    adjust.render = renderButton;
    const controls = panel.querySelector(`#${CONTROLS_ID}`);
    if (!controls) {
        placeNode(createAdjustControls(adjust));
    } else {
        // Keep what the player is typing; refresh the prefill only when it is not theirs
        const attemptsInput = controls.querySelector('[data-mwi-adjust="attempts"]');
        if (attemptsInput && adjust.attempts === null && computedAttempts !== null) {
            attemptsInput.value = String(computedAttempts);
        }
    }
    renderButton();
}

/**
 * Read a typed adjustment: a whole number of at least 1. Only a figure past {@link ADJUST_GUARD} is cut.
 * @param {string} raw - Input text
 * @param {number|null} [computed] - The automatic figure, which an edit never shrinks below
 * @returns {number|null} Whole number, or null when empty/unparseable/not finite
 */
function clampAdjustment(raw, computed = null) {
    if (raw === '' || raw === null || raw === undefined) return null;
    const value = Math.floor(Number(raw));
    if (!Number.isFinite(value)) return null;
    // An edit never shrinks an automatic figure that is itself past the guard
    return Math.max(1, Math.min(Math.max(ADJUST_GUARD, computed || 0), value));
}

/**
 * Build the attempts / copies row that sits above the Missing Mats button on an Enhancing panel
 * @param {{attempts: number|null, copies: number, computed: number|null, render: Function}} adjust - Per-panel
 *   adjustment state (mutated); computed and render are refreshed on every redraw
 * @returns {HTMLElement} Controls row
 */
function createAdjustControls(adjust) {
    const row = document.createElement('div');
    row.id = CONTROLS_ID;
    row.style.cssText = 'display: flex; align-items: center; gap: 8px; margin: 8px 0 0 0; flex-wrap: wrap;';

    const makeField = (field, labelText, title, initial) => {
        const label = document.createElement('label');
        label.style.cssText =
            'display: flex; align-items: center; gap: 4px; font-size: 11px; color: rgba(232, 236, 245, 0.6);';
        label.title = title;
        const text = document.createElement('span');
        text.textContent = labelText;
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '1';
        input.step = '1';
        input.dataset.mwiAdjust = field;
        input.value = initial === null || initial === undefined ? '' : String(initial);
        Object.assign(input.style, {
            background: 'rgba(0, 0, 0, 0.35)',
            border: '1px solid rgba(255, 255, 255, 0.12)',
            borderRadius: '3px',
            color: '#e8ecf5',
            fontSize: '11px',
            padding: '2px 4px',
            // Room for ten digits and the spinner; the row wraps when two fields do not fit a phone
            width: '96px',
            maxWidth: '100%',
            boxSizing: 'border-box',
        });
        // Typing must not reach the game's hotkeys
        for (const type of ['keydown', 'keyup', 'keypress']) {
            input.addEventListener(type, (event) => event.stopPropagation());
        }
        label.append(text, input);
        return { label, input };
    };

    const attempts = makeField(
        'attempts',
        'Attempts',
        'Attempts to buy materials for, per copy. Resets when the item, target, protection or repeat changes.',
        adjust.attempts ?? adjust.computed
    );
    const copies = makeField(
        'copies',
        'Copies',
        'How many copies of the item to take to the target. Materials held count once against the total.',
        adjust.copies
    );

    attempts.input.addEventListener('input', () => {
        const value = clampAdjustment(attempts.input.value, adjust.computed);
        // An empty box falls back to the computed attempts rather than buying for nothing
        adjust.attempts = value === adjust.computed ? null : value;
        adjust.render();
    });
    copies.input.addEventListener('input', () => {
        adjust.copies = clampAdjustment(copies.input.value) ?? 1;
        adjust.render();
    });
    // On blur show the clamped value the bill is actually using
    attempts.input.addEventListener('change', () => {
        attempts.input.value = String(adjust.attempts ?? adjust.computed ?? '');
    });
    copies.input.addEventListener('change', () => {
        copies.input.value = String(adjust.copies);
    });

    row.append(attempts.label, copies.label);
    return row;
}

/**
 * Create missing materials button for enhancement panels
 * @param {Array} missingMaterials - Array of missing material objects
 * @param {string} itemHrid - Item being enhanced
 * @param {number} startLevel - Current enhancement level
 * @param {number} targetLevel - Target enhancement level
 * @param {string|null} protectionItemHrid - Protection item HRID
 * @param {number} protectFromLevel - Protect from level
 * @param {boolean} disabled - Whether button should be disabled
 * @returns {HTMLElement} Button element
 */
function createEnhancementMissingMaterialsButton(
    missingMaterials,
    itemHrid,
    startLevel,
    targetLevel,
    protectionItemHrid,
    protectFromLevel,
    repeatCount,
    disabled,
    strategyInfo,
    adjustment = {}
) {
    const { copies = 1, adjustedAttempts = false, computedAttempts = null } = adjustment;
    const button = document.createElement('button');
    button.id = 'mwi-missing-mats-button';
    const notes = [];
    if (repeatCount === null) {
        notes.push(
            'Repeat is ∞: quantities cover the expected attempts to reach the target, rounded up to whole attempts.'
        );
    }
    if (copies > 1) {
        const perCopy = repeatCount ?? computedAttempts;
        notes.push(
            `Quantities are for ${perCopy ?? '?'} attempts × ${copies} copies (attempts are per copy); what you hold counts once.`
        );
    } else if (adjustedAttempts) {
        notes.push(`Quantities are for ${repeatCount} attempts, as set in the Attempts box.`);
    }
    const summary = describeMissingMaterials(missingMaterials, { note: notes.join('\n') });
    button.textContent = summary.label;
    button.title = summary.title;
    button.disabled = disabled;
    button.style.cssText = `
        width: 100%;
        box-sizing: border-box;
        padding: 10px 16px;
        margin: 8px 0 16px 0;
        background: linear-gradient(180deg, rgba(91, 141, 239, 0.2) 0%, rgba(91, 141, 239, 0.1) 100%);
        color: #ffffff;
        border: 1px solid rgba(91, 141, 239, 0.4);
        border-radius: 8px;
        cursor: ${disabled ? 'default' : 'pointer'};
        font-size: 14px;
        font-weight: 600;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
        transition: all 0.2s ease;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
        opacity: ${disabled ? '0.45' : '1'};
    `;

    if (!disabled) {
        button.addEventListener('mouseenter', () => {
            button.style.background =
                'linear-gradient(180deg, rgba(91, 141, 239, 0.35) 0%, rgba(91, 141, 239, 0.25) 100%)';
            button.style.borderColor = 'rgba(91, 141, 239, 0.6)';
            button.style.boxShadow = '0 3px 6px rgba(0, 0, 0, 0.3)';
        });

        button.addEventListener('mouseleave', () => {
            button.style.background =
                'linear-gradient(180deg, rgba(91, 141, 239, 0.2) 0%, rgba(91, 141, 239, 0.1) 100%)';
            button.style.borderColor = 'rgba(91, 141, 239, 0.4)';
            button.style.boxShadow = '0 2px 4px rgba(0, 0, 0, 0.2)';
        });

        button.addEventListener('click', async () => {
            await handleEnhancementMissingMaterialsClick(
                itemHrid,
                startLevel,
                targetLevel,
                protectionItemHrid,
                protectFromLevel,
                repeatCount,
                strategyInfo,
                copies
            );
        });
    }

    return button;
}

/**
 * Handle enhancement missing materials button click
 * @param {Array} missingMaterials - Array of missing material objects
 * @param {string} itemHrid - Item being enhanced
 * @param {number} startLevel - Current enhancement level
 * @param {number} targetLevel - Target enhancement level
 * @param {string|null} protectionItemHrid - Protection item HRID
 * @param {number} protectFromLevel - Protect from level
 */
async function handleEnhancementMissingMaterialsClick(
    itemHrid,
    startLevel,
    targetLevel,
    protectionItemHrid,
    protectFromLevel,
    repeatCount,
    strategyInfo,
    copies = 1
) {
    // Store context for live updates (already resolved values)
    storedEnhancementContext = {
        itemHrid,
        startLevel,
        targetLevel,
        protectionItemHrid,
        protectFromLevel,
        repeatCount,
        strategyInfo,
        copies,
    };
    billGeneration++;
    storedUpgradeBaseAcquisition = null;
    storedActionHrid = null;
    storedNumActions = 0;
    storedUpgradeItemLevel = 0;
    storedAlchemyContext = null;
    storedMaterialList = null;

    // Recalculate materials fresh (inventory may have changed since button was rendered)
    const freshMaterials = calculateEnhancementMaterialRequirements(
        itemHrid,
        startLevel,
        targetLevel,
        protectionItemHrid,
        protectFromLevel,
        repeatCount,
        RESERVATION_OWNER,
        copies
    );

    // Open the marketplace, or the Tester shop, with a tab per material
    if (!(await openWhereBought(freshMaterials, strategyInfo))) return;

    // Enhancement bills use the same short-lived reservation as action bills.
    await claimOpenBill(freshMaterials);

    // Setup inventory listener for live updates
    setupInventoryListener();
}

/**
 * Items one alchemy action on this item consumes: its bulk multiplier, as the
 * profit calculator and the gold summary read it.
 * @param {string} itemHrid - Item HRID
 * @returns {number} Items per action, at least 1
 */
function alchemyItemsPerAction(itemHrid) {
    const bulk = Number(dataManager.getItemDetails(itemHrid)?.alchemyDetail?.bulkMultiplier);
    return Number.isFinite(bulk) && bulk >= 1 ? bulk : 1;
}

/**
 * Units of an unenhanced item the finite action queue will already consume:
 * production inputs (as the action panel bill counts them) plus queued alchemy
 * actions on the same +0 item, which name their input by stack hash rather
 * than in `inputItems`. Infinite actions are skipped, as for production.
 * @param {string} itemHrid - Item HRID
 * @returns {number} Queued units
 */
function queuedAlchemyInput(itemHrid) {
    let queued = calculateQueuedMaterialsForAction(null).get(itemHrid) || 0;
    const perAction = alchemyItemsPerAction(itemHrid);
    for (const action of dataManager.getCurrentActions?.() || []) {
        if (!action?.actionHrid?.startsWith('/actions/alchemy/') || !action.hasMaxCount) continue;
        const parsed = parseItemHash(action.primaryItemHash);
        if (parsed.itemHrid !== itemHrid || parsed.level !== 0) continue;
        const remaining = (Number(action.maxCount) || 0) - (Number(action.currentCount) || 0);
        if (remaining > 0) queued += remaining * perAction;
    }
    return queued;
}

/**
 * Catalysts the finite action queue has already committed: queued alchemy
 * actions name theirs in `secondaryItemHash`. A catalyst is spent only on a
 * success, but a queued entry's success rate is not known here (it depends on
 * the catalyst and gear it was queued under), so each remaining action counts
 * as one catalyst — the upper bound, which can only under-state what is free,
 * never promise stock the queue will use. Infinite actions are skipped.
 * @param {string} catalystHrid - Catalyst item HRID
 * @returns {number} Queued catalyst units
 */
function queuedAlchemyCatalyst(catalystHrid) {
    let queued = 0;
    for (const action of dataManager.getCurrentActions?.() || []) {
        if (!action?.actionHrid?.startsWith('/actions/alchemy/') || !action.hasMaxCount) continue;
        if (!action.secondaryItemHash) continue;
        const parsed = parseItemHash(action.secondaryItemHash);
        if (parsed.itemHrid !== catalystHrid || parsed.level !== 0) continue;
        const remaining = (Number(action.maxCount) || 0) - (Number(action.currentCount) || 0);
        if (remaining > 0) queued += remaining;
    }
    return queued;
}

/**
 * The what-if catalyst the profit display computed for exactly this item and tab, if any.
 * @param {string} itemHrid - The selected item
 * @param {string|null} actionType - The selected tab
 * @returns {{catalystHrid: string, successRate: number}|null}
 */
function alchemyWhatIfCatalyst(itemHrid, actionType) {
    const result = getCatalystWhatIfResult();
    if (!result?.catalystHrid || result.itemHrid !== itemHrid || result.actionType !== actionType) return null;
    if (!(result.successRate > 0)) return null;
    return { catalystHrid: result.catalystHrid, successRate: result.successRate };
}

/**
 * The Alchemy panel's bill: the selected item, bulk multiplier times per action.
 *
 * Costed by `materialsFromList`, so it follows every rule the other bills do —
 * unenhanced copies in the bag only, bought-but-unclaimed units count, stock
 * another plan claimed is not this bill's. The coin fee is not a line: it
 * cannot be bought, and the panel's gold summary already shows it.
 *
 * A catalyst picked in the profit display's what-if is a second line. A catalyst
 * is consumed once per success, so its count is an estimate: Repeat × the
 * what-if success rate, rounded up. The equipped catalyst is not billed (as
 * upstream): the button sizes what the player asked to try.
 *
 * @param {{itemHrid: string, numActions: number, catalyst?: {catalystHrid: string, successRate: number}|null}} ctx
 *   What the panel is set to
 * @returns {Array<Object>} Material lines, or [] for no actions
 */
function alchemyMaterials(ctx) {
    const numActions = Math.max(0, Math.floor(Number(ctx?.numActions) || 0));
    if (!ctx?.itemHrid || numActions <= 0) return [];
    const ignoreQueue = config.getSetting('actions_missingMaterialsButton_ignoreQueue') || false;
    const lines = [
        {
            itemHrid: ctx.itemHrid,
            count: numActions * alchemyItemsPerAction(ctx.itemHrid),
            queued: ignoreQueue ? 0 : queuedAlchemyInput(ctx.itemHrid),
        },
    ];
    if (ctx.catalyst?.catalystHrid && ctx.catalyst.successRate > 0) {
        const catalystCount = Math.ceil(numActions * ctx.catalyst.successRate - 1e-9);
        const catalystQueued = ignoreQueue ? 0 : queuedAlchemyCatalyst(ctx.catalyst.catalystHrid);
        if (ctx.catalyst.catalystHrid === ctx.itemHrid) {
            // The item being alchemized is also the catalyst (a catalyst coinified or decomposed):
            // one stack feeds both roles, so it is one line, not two that each see the whole bag
            lines[0].count += catalystCount;
            lines[0].queued += catalystQueued;
        } else {
            lines.push({ itemHrid: ctx.catalyst.catalystHrid, count: catalystCount, queued: catalystQueued });
        }
    }
    return materialsFromList(lines, RESERVATION_OWNER);
}

/**
 * Watch one Alchemy panel: the selected item, the tab and the Repeat count all
 * redraw its button.
 *
 * Every mutation in the panel only schedules a redraw; the redraw itself does
 * nothing unless the bill it computes differs from the one on the button, so
 * the other Alchemy features that write into this panel cannot loop with it.
 *
 * @param {HTMLElement} panel - The alchemy component
 */
function processAlchemyPanel(panel) {
    if (!panel || alchemyPanelWatchers.has(panel)) return;

    for (const [tracked, unwatch] of alchemyPanelWatchers) {
        if (tracked.isConnected) continue;
        unwatch();
        alchemyPanelWatchers.delete(tracked);
    }

    const schedule = () => scheduleAlchemyUpdate();
    const observer = new MutationObserver(schedule);
    observer.observe(panel, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['href', 'xlink:href'],
    });
    // The tab strip sits outside the component
    const tabContainer = document.querySelector('[class*="AlchemyPanel_tabsComponentContainer"]');
    if (tabContainer) {
        observer.observe(tabContainer, { attributes: true, attributeFilter: ['aria-selected'], subtree: true });
    }
    // Typing in Repeat, and the quick 1 / infinity buttons, which set it without an input event
    panel.addEventListener('input', schedule);
    panel.addEventListener('click', schedule);

    alchemyPanelWatchers.set(panel, () => {
        observer.disconnect();
        panel.removeEventListener('input', schedule);
        panel.removeEventListener('click', schedule);
        panel.querySelector(`#${ALCHEMY_BUTTON_ID}`)?.remove();
    });

    updateAlchemyButton(panel);
}

/**
 * Redraw every watched Alchemy panel's button, debounced.
 */
function scheduleAlchemyUpdate() {
    if (alchemyPanelWatchers.size === 0) return;
    if (alchemyRefreshTimeout) clearTimeout(alchemyRefreshTimeout);
    alchemyRefreshTimeout = setTimeout(() => {
        alchemyRefreshTimeout = null;
        for (const [panel, unwatch] of alchemyPanelWatchers) {
            if (!panel.isConnected) {
                unwatch();
                alchemyPanelWatchers.delete(panel);
                continue;
            }
            updateAlchemyButton(panel);
        }
    }, 100);
}

/**
 * Draw, redraw or remove the Alchemy panel's Missing Mats button.
 *
 * Gone when the setting is off, when no item is selected, and for an enhanced
 * selection (the bill counts +0 copies only). Disabled for an infinite or empty
 * Repeat count, as on the production panels.
 *
 * @param {HTMLElement} panel - The alchemy component
 */
function updateAlchemyButton(panel) {
    if (!panel?.isConnected) return;
    const existing = panel.querySelector(`#${ALCHEMY_BUTTON_ID}`);

    const selection = config.getSetting('actions_missingMaterialsButton') ? readAlchemyPanelSelection(panel) : null;
    if (!selection?.itemHrid || selection.enhancementLevel > 0) {
        existing?.remove();
        return;
    }

    const input = panel.querySelector('[class*="maxActionCountInput"] input');
    // "∞" parses to 0: there is no count to buy for
    const numActions = parseInt(input?.value, 10) || 0;
    const ctx = {
        itemHrid: selection.itemHrid,
        actionType: selection.actionType,
        numActions,
        catalyst: alchemyWhatIfCatalyst(selection.itemHrid, selection.actionType),
    };
    const materials = numActions > 0 ? alchemyMaterials(ctx) : [];
    const disabled = numActions <= 0 || materials.length === 0;

    const stateKey = JSON.stringify([
        ctx,
        disabled,
        materials.map((m) => [m.itemHrid, m.required, m.have, m.queued, m.available, m.missing, m.reservedNote]),
    ]);
    if (existing?.dataset.mwiState === stateKey) return;

    const button = createMissingMaterialsButton(materials, null, numActions, disabled, () =>
        handleAlchemyMissingMaterialsClick(ctx)
    );
    button.id = ALCHEMY_BUTTON_ID;
    button.dataset.mwiState = stateKey;
    if (ctx.catalyst && button.title) {
        button.title += '\nCatalyst count is an estimate: Repeat × the what-if success rate.';
    }

    if (existing) {
        existing.replaceWith(button);
        return;
    }
    const anchor =
        panel.querySelector('.mwi-alchemy-gold-summary') ||
        panel.querySelector('[class*="SkillActionDetail_alchemyCosts"]');
    if (anchor) {
        anchor.after(button);
    } else {
        (panel.querySelector('[class*="SkillActionDetail_info"]') || panel).prepend(button);
    }
}

/**
 * Open the marketplace on the Alchemy panel's bill.
 * @param {{itemHrid: string, actionType: string|null, numActions: number, catalyst?: Object|null}} ctx - What
 *   the panel was set to, the what-if catalyst included as it was when clicked
 */
async function handleAlchemyMissingMaterialsClick(ctx) {
    billGeneration++;
    storedUpgradeBaseAcquisition = null;
    storedActionHrid = null;
    storedNumActions = 0;
    storedEnhancementContext = null;
    storedMaterialList = null;
    storedUpgradeItemLevel = 0;
    storedAlchemyContext = { ...ctx };

    // Fresh: the bag may have moved since the button was drawn
    const freshMaterials = alchemyMaterials(storedAlchemyContext);
    if (!(await openWhereBought(freshMaterials))) return;
    await claimOpenBill(freshMaterials);
    setupInventoryListener();
}

/**
 * Create missing materials marketplace button
 * @param {Array} missingMaterials - Array of missing material objects
 * @param {string} actionHrid - Action HRID for recalculating materials
 * @param {number} numActions - Number of actions for recalculating materials
 * @param {boolean} disabled - Whether the button should be rendered in a disabled state
 * @param {Function|null} [onClick] - Opens a bill other than this action's (the Alchemy panel's)
 * @returns {HTMLElement} Button element
 */
function createMissingMaterialsButton(missingMaterials, actionHrid, numActions, disabled = false, onClick = null) {
    const button = document.createElement('button');
    button.id = 'mwi-missing-mats-button';
    const summary = describeMissingMaterials(missingMaterials);
    button.textContent = summary.label;
    button.disabled = disabled;
    button.title = disabled && numActions <= 0 ? 'Enter a quantity to check missing materials' : summary.title;
    button.style.cssText = `
        width: 100%;
        box-sizing: border-box;
        padding: 10px 16px;
        margin: 8px 0 16px 0;
        background: linear-gradient(180deg, rgba(91, 141, 239, 0.2) 0%, rgba(91, 141, 239, 0.1) 100%);
        color: #ffffff;
        border: 1px solid rgba(91, 141, 239, 0.4);
        border-radius: 8px;
        cursor: ${disabled ? 'default' : 'pointer'};
        font-size: 14px;
        font-weight: 600;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
        transition: all 0.2s ease;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
        opacity: ${disabled ? '0.45' : '1'};
    `;

    if (!disabled) {
        // Hover effect
        button.addEventListener('mouseenter', () => {
            button.style.background =
                'linear-gradient(180deg, rgba(91, 141, 239, 0.35) 0%, rgba(91, 141, 239, 0.25) 100%)';
            button.style.borderColor = 'rgba(91, 141, 239, 0.6)';
            button.style.boxShadow = '0 3px 6px rgba(0, 0, 0, 0.3)';
        });

        button.addEventListener('mouseleave', () => {
            button.style.background =
                'linear-gradient(180deg, rgba(91, 141, 239, 0.2) 0%, rgba(91, 141, 239, 0.1) 100%)';
            button.style.borderColor = 'rgba(91, 141, 239, 0.4)';
            button.style.boxShadow = '0 2px 4px rgba(0, 0, 0, 0.2)';
        });

        // Click handler
        button.addEventListener('click', async () => {
            await (onClick ? onClick() : handleMissingMaterialsClick(actionHrid, numActions));
        });
    }

    return button;
}

/**
 * Handle missing materials button click
 * @param {Array} missingMaterials - Array of missing material objects
 * @param {string} actionHrid - Action HRID for recalculating materials
 * @param {number} numActions - Number of actions for recalculating materials
 */
async function handleMissingMaterialsClick(
    actionHrid,
    numActions,
    upgradeItemLevel = 0,
    upgradeBaseAcquisition = null
) {
    // Validate before changing the open bill. A rejected stale Watch route must
    // leave any existing shopping context and reservation untouched.
    const characterId = dataManager.getCurrentCharacterId?.();
    const acquisition = upgradeBaseAcquisition ? structuredClone(upgradeBaseAcquisition) : null;
    const level = upgradeItemLevel === null ? null : Math.max(0, Math.floor(Number(upgradeItemLevel) || 0));
    const ignoreQueue = config.getSetting('actions_missingMaterialsButton_ignoreQueue') || false;
    const accountForQueue = !ignoreQueue;
    const freshMaterials = calculateMaterialRequirements(actionHrid, numActions, accountForQueue, {
        ownerId: RESERVATION_OWNER,
        upgradeItemLevel: level,
        upgradeBaseAcquisition: acquisition,
    });
    if (freshMaterials.some((line) => line.acquisitionUnavailable)) {
        const error = new Error('The owned base is no longer available. Refresh the Equipment Watch route.');
        error.code = 'BASE_UNAVAILABLE';
        throw error;
    }
    billGeneration++;
    storedActionHrid = actionHrid;
    storedNumActions = numActions;
    storedUpgradeBaseAcquisition = acquisition;
    storedEnhancementContext = null;
    storedMaterialList = null;
    storedAlchemyContext = null;
    storedUpgradeItemLevel = level;

    if (!(await openWhereBought(freshMaterials))) return;

    if (acquisition) {
        if (storedUpgradeBaseAcquisition !== acquisition || dataManager.getCurrentCharacterId?.() !== characterId)
            return;
        const current = calculateMaterialRequirements(actionHrid, numActions, accountForQueue, {
            ownerId: RESERVATION_OWNER,
            upgradeItemLevel: level,
            upgradeBaseAcquisition: acquisition,
        });
        if (current.some((line) => line.acquisitionUnavailable)) {
            handleMarketplaceCleanup();
            const error = new Error('The owned base changed while opening the marketplace. Refresh this route.');
            error.code = 'BASE_UNAVAILABLE';
            throw error;
        }
    }
    await claimOpenBill(freshMaterials);
    if (
        acquisition &&
        (storedUpgradeBaseAcquisition !== acquisition || dataManager.getCurrentCharacterId?.() !== characterId)
    )
        return;

    // Setup inventory listener for live updates
    setupInventoryListener();
}

/**
 * Claim what the tabs now on screen are asking for, for as long as they are up.
 *
 * The REQUIRED totals rather than the shortfall: what is already in the bag for
 * this bill is spoken for too, and claiming only the missing part would leave
 * the rest looking free to every other plan.
 *
 * @param {Array<Object>} materials - The material lines the tabs were built from
 * @returns {Promise<boolean>} Whether a write landed
 */
async function claimOpenBill(materials) {
    return reserve(
        RESERVATION_OWNER,
        (materials || []).map((material) => ({
            itemHrid: material.itemHrid,
            count: material.required,
            enhancementLevel: material.enhancementLevel || 0,
        })),
        { label: 'Missing materials panel' }
    );
}

/**
 * Navigate to marketplace by simulating click on navbar
 * @returns {Promise<boolean>} True if successful
 */
async function openMarketplacePage() {
    // Find marketplace navbar button
    const navButtons = document.querySelectorAll('.NavigationBar_nav__3uuUl');
    const marketplaceButton = Array.from(navButtons).find((nav) => {
        const svg = nav.querySelector('svg[aria-label="navigationBar.marketplace"]');
        return svg !== null;
    });

    if (!marketplaceButton) {
        console.error('[MissingMats] Marketplace navbar button not found');
        return false;
    }

    // Simulate click
    marketplaceButton.click();

    // Wait for marketplace panel to appear
    return await waitForMarketplace();
}

/**
 * Wait for marketplace panel to appear
 * @returns {Promise<boolean>} True if marketplace appeared within timeout
 */
async function waitForMarketplace() {
    const maxAttempts = 50;
    const delayMs = 100;

    for (let i = 0; i < maxAttempts; i++) {
        // Check for marketplace panel by looking for tabs container
        const tabsContainer = visibleTabsContainer();
        if (tabsContainer) {
            // Verify it's the marketplace tabs (has "Market Listings" tab)
            const hasMarketListings = Array.from(tabsContainer.children).some((btn) =>
                btn.textContent.includes('Market Listings')
            );
            if (hasMarketListings) {
                return true;
            }
        }

        await new Promise((resolve) => {
            timerRegistry.scheduleTimeout(resolve, delayMs);
        });
    }

    console.error('[MissingMats] Marketplace did not open within timeout');
    return false;
}

/**
 * Build the click handler for a material tab.
 * Defined outside the loop to satisfy the no-loop-func lint rule.
 * @param {{ tab: HTMLElement|null }} tabRef - Holder updated to the tab element after creation
 * @returns {Function}
 */
function makeMaterialClickHandler(tabRef) {
    return (_e, mat) => {
        // Read the current missing quantity from the tab's data attribute,
        // which is kept up-to-date by the inventory listener. Armed for this
        // tab's item: the calculation persists on purpose, so without the item
        // it would go on filling buy boxes long after this tab is gone.
        autofillManager.setPendingCalculation(
            () => parseInt(tabRef.tab?.getAttribute('data-missing-quantity') || '0', 10),
            { itemHrid: mat.itemHrid }
        );
        // A material is the unenhanced item; a bill line may name a level — a
        // piece of gear the Upgrade tab wants at +7 — and the listing to open
        // is that level's, not the +0 one underneath it
        navigateToMarketplace(mat.itemHrid, mat.enhancementLevel || 0);
    };
}

/**
 * Whether a bill should be bought in the Tester shop: pricing is on, and the
 * shop sells at least one line of it.
 * @param {Array<{itemHrid: string}>} materials
 * @returns {boolean}
 */
function wantsTesterShop(materials) {
    if (!testerShopEnabled()) return false;
    return (materials || []).some((material) => !material.ownedInput && testerShopCoinCost(material?.itemHrid) > 0);
}

/**
 * Pin the missing-material tabs into the Shop's Tester strip.
 *
 * Same tabs, same live badges, same dismiss — a click filters the shop to the
 * item and arms the buy dialog with what is still missing. A line the shop
 * does not sell keeps the marketplace as its click, and says so.
 *
 * @param {Array<Object>} missingMaterials - Material objects
 * @param {HTMLElement} testerTab - The selected Tester tab, to clone
 */
function createTesterShopTabs(missingMaterials, testerTab) {
    const tabsContainer = testerTab?.parentElement;
    if (!tabsContainer) {
        console.error('[MissingMats] Tester tab strip not found');
        return false;
    }
    removeMaterialTabs({ owner: TAB_OWNER });
    currentMaterialsTabs.length = 0;
    tabsContainer.style.flexWrap = 'wrap';

    attachRegularTabClearListener(tabsContainer, () => autofillManager.clearQuantity());

    for (const material of missingMaterials) {
        if (material.ownedInput || material.acquisition?.kind.startsWith('owned')) continue;
        const sold = testerShopCoinCost(material.itemHrid) > 0;
        const tabRef = { tab: null };
        const handler = sold
            ? (_e, mat) => {
                  // Stay in the Tester tab and narrow it to this item — and
                  // only then arm the quantity: selecting a game tab is what
                  // clears an armed quantity (the strip's own listener)
                  findTesterTab()?.click();
                  setShopFilter(mat.itemName);
                  // Armed for this line's item, as the marketplace strip's tabs
                  // are: the calculation persists on purpose, so unscoped it
                  // went on filling every later buy box, for any item. A dialog
                  // that names no item (the Shop's own, when it draws no item
                  // icon) still fills — see modalItemHrid.
                  autofillManager.setPendingCalculation(
                      () => parseInt(tabRef.tab?.getAttribute('data-missing-quantity') || '0', 10),
                      { itemHrid: mat.itemHrid }
                  );
              }
            : makeMaterialClickHandler(tabRef);
        const tab = createMaterialTab(material, testerTab, handler, { owner: TAB_OWNER });
        tab.setAttribute('data-enhancement-level', String(material.enhancementLevel || 0));
        tabRef.tab = tab;
        tab.setAttribute('data-tester-sold', sold ? 'true' : 'false');
        tab.setAttribute('data-item-name', material.itemName || '');
        if (!sold) tab.title = 'Not sold in the Tester shop — opens the marketplace';
        insertTabInOrder(tabsContainer, tab, 'material');
        currentMaterialsTabs.push(tab);
    }

    const preparation = createBasePreparationIndicator();
    if (preparation) {
        insertTabInOrder(tabsContainer, preparation, 'material');
        currentMaterialsTabs.push(preparation);
    }

    // One press, one purchase: the next line still short, bought for what it
    // is short of. Pressed again, the line after it
    const control = createBuyNextControl();
    insertTabInOrder(tabsContainer, control, 'material');
    currentMaterialsTabs.push(control);

    // One click, every pinned line gone — already on the Tester tab, which is
    // its own "normal view", so nothing to navigate back to
    const clearAllControl = createClearAllTabsControl(testerTab, () => handleClearAllClick(false), {
        owner: TAB_OWNER,
    });
    insertTabInOrder(tabsContainer, clearAllControl, 'close-all');
    currentMaterialsTabs.push(clearAllControl);
    return true;
}
/**
 * The "Buy next" control for the Tester strip.
 *
 * Each press buys exactly one thing: the first pinned line the shop sells
 * that is still short, for the amount it is short of — the shop is filtered
 * to it, its card opened, the quantity typed, Buy pressed. One press is one
 * purchase, so holding the button down does nothing and a line that did not
 * buy (no card, no dialog) is simply the next press's line again. The badges
 * refresh off the inventory as the purchases land, which is what moves the
 * press on to the next line.
 *
 * @returns {HTMLElement}
 */
function createBuyNextControl() {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('data-mwi-custom-tab', 'true');
    button.setAttribute('data-mwi-tab-owner', TAB_OWNER);
    button.setAttribute('data-mwi-buy-next', 'true');
    button.style.cssText =
        'display:inline-flex; align-items:center; gap:6px; margin:4px 8px; padding:4px 10px; font-size:12px; ' +
        'border:1px solid #4caf50; border-radius:4px; background:rgba(76,175,80,0.12); color:#8bc34a; cursor:pointer; ' +
        'font-family:inherit; white-space:nowrap;';
    const label = document.createElement('span');
    label.textContent = 'Buy next ▸';
    const note = document.createElement('span');
    note.style.cssText = 'color:#aaa; font-size:11px;';
    button.append(label, note);
    button.title =
        'Buys the next pinned line the Tester shop sells, for what you are still short of — one purchase per press. ' +
        'Press again for the line after it.';

    let busy = false;
    const refreshNote = () => {
        const next = nextBuyableTab();
        note.textContent = next
            ? `${next.getAttribute('data-item-name')} × ${next.getAttribute('data-missing-quantity')}`
            : 'nothing left to buy';
    };
    refreshNote();
    button.addEventListener('mouseenter', refreshNote);
    // The badges move as purchases land; the note follows them
    button.addEventListener('mwi-tabs-updated', refreshNote);

    button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (busy) return;
        const tab = nextBuyableTab();
        if (!tab) {
            note.textContent = 'nothing left to buy';
            return;
        }
        busy = true;
        const name = tab.getAttribute('data-item-name') || '';
        const quantity = parseInt(tab.getAttribute('data-missing-quantity') || '0', 10);
        note.textContent = `buying ${name} × ${quantity}…`;
        try {
            const outcome = await buyOneFromTesterShop(name, quantity);
            note.textContent = outcome.ok ? `bought ${name} × ${quantity}` : `${name}: ${outcome.reason}`;
        } catch (error) {
            console.error('[MissingMats] Buy next failed:', error);
            note.textContent = `${name}: failed`;
        } finally {
            busy = false;
            // The arming buyOneFromTesterShop sets is a bare constant, for the
            // one dialog this press opens. Left standing it filled that count
            // into every later buy box, for any item — it cannot be scoped to
            // the item (the flow has only the shop's display name), so it ends
            // with the press.
            autofillManager.clearQuantity();
            timerRegistry.scheduleTimeout(refreshNote, 1500);
        }
    });
    return button;
}

/** The first pinned tab the shop sells that is still short */
function nextBuyableTab() {
    return (
        currentMaterialsTabs.find(
            (tab) =>
                tab.getAttribute('data-tester-sold') === 'true' &&
                parseInt(tab.getAttribute('data-missing-quantity') || '0', 10) > 0 &&
                document.body.contains(tab)
        ) || null
    );
}

/**
 * The shop card for an item, on screen.
 *
 * The game's own card class first (`ShopPanel_shopItem`); failing that, the
 * deepest visible element whose text reads as a card — the item name first,
 * a coin price last — since a filtered shop holds the card inside several
 * containers that carry the very same text.
 *
 * @param {string} itemName - As the shop names it
 * @returns {HTMLElement|null}
 */
function findShopCard(itemName) {
    const wanted = String(itemName || '')
        .trim()
        .toLowerCase();
    if (!wanted) return null;
    // The whole name, then straight into the price — "Lumber" must not read
    // "Lumberjack's Top 3,500,000 Coin" as its card
    const escaped = wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const cardText = new RegExp(`^${escaped}\\s*[\\d,.]+\\s*coins?$`);
    const reads = (el) => cardText.test((el.textContent || '').trim().toLowerCase());
    // The card class, not the `shopItems` container that also matches the
    // substring — the token is followed by its hash
    const card = Array.from(document.querySelectorAll('[class*="ShopPanel_shopItem"]')).find(
        (el) => /(^|\s)ShopPanel_shopItem__/.test(el.className || '') && el.offsetParent !== null && reads(el)
    );
    if (card) return card;

    let best = null;
    for (const el of document.querySelectorAll('div, button, span')) {
        if (el.offsetParent === null || !reads(el)) continue;
        // Equal text means nested containers: keep the deepest one
        if (!best || (el.textContent || '').trim().length <= (best.textContent || '').trim().length) best = el;
    }
    return best;
}

/**
 * Buy one pinned line from the Tester shop: filter, open its card, type the
 * quantity, press Buy. Resolves when the dialog is gone or a step could not be
 * found.
 *
 * @param {string} itemName - The item, as the shop names it
 * @param {number} quantity - How many
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
async function buyOneFromTesterShop(itemName, quantity) {
    const wait = (ms) =>
        new Promise((resolve) => {
            timerRegistry.scheduleTimeout(resolve, ms);
        });
    if (!(quantity > 0)) return { ok: false, reason: 'nothing short' };

    findTesterTab()?.click();
    await wait(100);
    setShopFilter(itemName);
    // Armed after the tab click, which would have cleared it: the quantity we
    // are about to type is what any buy dialog should carry, including one
    // the game opens from this card
    autofillManager.setPendingCalculation(() => quantity);

    let card = null;
    for (let i = 0; i < 20 && !card; i++) {
        await wait(100);
        card = findShopCard(itemName);
    }
    if (!card) return { ok: false, reason: 'not found in the shop' };
    // The game ignores a plain synthetic click on many of its elements; go
    // through React's own handler first
    clickThroughReact(card, { reactFirst: true });

    let modal = null;
    for (let i = 0; i < 20 && !modal; i++) {
        await wait(100);
        // Fixed-position: `offsetParent` is null even when shown, so the box
        // on screen is the test
        modal = Array.from(document.querySelectorAll('[class*="Modal_modalContainer"]')).find(
            (el) => el.getClientRects().length > 0 && /quantity/i.test(el.textContent || '')
        );
    }
    if (!modal) return { ok: false, reason: 'no buy dialog' };

    // The Quantity box, not the Enhancement Level box an equipment dialog
    // puts first — the same label-reading the marketplace autofill does
    const input = findQuantityInput(modal);
    if (!input) return { ok: false, reason: 'no quantity box' };
    setReactInputValue(input, String(quantity), { dispatchInput: true, dispatchChange: true });
    await wait(150);

    const buy = Array.from(modal.querySelectorAll('button')).find((b) => /^\s*buy\s*$/i.test(b.textContent || ''));
    if (!buy) return { ok: false, reason: 'no Buy button' };
    // Disabled is the dialog refusing the order (a level out of range, more
    // than you can pay); pressing it would do nothing, so say why instead
    for (let i = 0; i < 10 && buy.disabled; i++) await wait(100);
    if (buy.disabled) return { ok: false, reason: 'Buy is disabled in the dialog' };
    // A plain .click() closes the dialog without buying — the game's handler
    // wants the real event path; React's own handler first, like the card
    clickThroughReact(buy, { reactFirst: true });

    // The dialog closing is the purchase going through; the inventory update
    // behind it is what moves the badge
    for (let i = 0; i < 20; i++) {
        await wait(100);
        if (!document.body.contains(modal) || modal.getClientRects().length === 0) break;
    }
    return { ok: true };
}

/**
 * Open whatever a bill is bought from: the Tester shop when it is priced in
 * and sells some of it, the marketplace otherwise — and draw the tabs there.
 *
 * @param {Array<Object>} materials - Material objects for the tabs
 * @param {Object|null} [strategyInfo] - Enhancement protection strategy, marketplace only
 * @returns {Promise<boolean>} Whether a page opened and tabs were drawn
 */
async function openWhereBought(materials, strategyInfo = null) {
    const generation = billGeneration;
    const characterId = dataManager.getCurrentCharacterId?.();
    const isCurrent = () => generation === billGeneration && dataManager.getCurrentCharacterId?.() === characterId;
    if (wantsTesterShop(materials)) {
        const testerTab = await openTesterShopPage();
        if (!isCurrent()) return false;
        if (testerTab) {
            return createTesterShopTabs(materials, testerTab);
        }
        // The shop could not be reached: the marketplace is still a place to buy
    }

    const success = await openMarketplacePage();
    if (!isCurrent()) return false;
    if (!success) {
        console.error('[MissingMats] Failed to navigate to marketplace');
        return false;
    }
    await new Promise((resolve) => {
        timerRegistry.scheduleTimeout(resolve, 200);
    });
    if (!isCurrent()) return false;
    return createMissingMaterialTabs(materials, strategyInfo);
}

/** The required enhancement stage is not a ready-to-craft base, even after its inputs are bought. */
function createBasePreparationIndicator() {
    const acquisition = storedUpgradeBaseAcquisition;
    if (!acquisition && storedMaterialList?.ownedInputs?.length) {
        const indicator = document.createElement('div');
        indicator.dataset.mwiCustomTab = 'true';
        indicator.dataset.mwiTabOwner = TAB_OWNER;
        indicator.dataset.ownedInputs = 'true';
        indicator.style.cssText = 'padding: 6px 12px; color: #ffc75f; font-size: 12px; max-width: 420px;';
        indicator.textContent =
            'Use owned: ' +
            storedMaterialList.ownedInputs
                .map((input) => {
                    const name = dataManager.getItemDetails(input.itemHrid)?.name || input.itemHrid.split('/').pop();
                    return `${input.count} × ${name} +${input.enhancementLevel || 0}`;
                })
                .join(', ') +
            '. These inputs are consumed, not sold.';
        return indicator;
    }
    if (!acquisition) return null;
    const enhancing = acquisition.kind.endsWith('-enhance');
    if (!enhancing && !acquisition.kind.startsWith('owned')) return null;
    const indicator = document.createElement('div');
    indicator.dataset.mwiCustomTab = 'true';
    indicator.dataset.mwiTabOwner = TAB_OWNER;
    indicator.dataset.basePreparation = 'true';
    indicator.style.cssText = 'padding: 6px 12px; color: #ffc75f; font-size: 12px; max-width: 420px;';
    const name = dataManager.getItemDetails(acquisition.itemHrid)?.name || acquisition.itemHrid.split('/').pop();
    const source = acquisition.kind.startsWith('owned') ? 'Use owned' : 'Buy';
    indicator.textContent = enhancing
        ? `${source} ${name} +${acquisition.startLevel}; enhance to +${acquisition.targetLevel} before crafting. `
        : `Use owned ${name} +${acquisition.startLevel} for this craft. `;
    if (acquisition.kind.startsWith('owned')) indicator.textContent += 'Unequip first if worn. ';
    if (enhancing) {
        const protection =
            dataManager.getItemDetails(acquisition.protectionItemHrid)?.name || acquisition.protectionItemHrid;
        indicator.textContent +=
            acquisition.protectFrom > 0
                ? `Protection: ${protection} from +${acquisition.protectFrom}.`
                : 'No protection in this estimate.';
    }
    return indicator;
}

/**
 * Create a strategy indicator element for the marketplace tab row
 * @param {Object} strategyInfo - Auto-calculated protection strategy
 * @returns {HTMLElement}
 */
function createStrategyIndicator(strategyInfo) {
    const indicator = document.createElement('div');
    indicator.setAttribute('data-mwi-custom-tab', 'true');
    indicator.setAttribute('data-mwi-tab-owner', TAB_OWNER);
    indicator.style.cssText = `
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        font-size: 12px;
        color: #aaa;
        white-space: nowrap;
    `;

    if (strategyInfo.protectFrom === 0) {
        indicator.textContent = 'No protection needed';
    } else {
        // Get item sprite URL from existing DOM
        const spriteUse = document.querySelector('use[href*="items_sprite"]');
        if (spriteUse && strategyInfo.protectionItemHrid) {
            const spriteUrl = spriteUse.getAttribute('href').split('#')[0];
            const iconName = strategyInfo.protectionItemHrid.split('/').pop();
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('width', '20');
            svg.setAttribute('height', '20');
            svg.style.flexShrink = '0';
            const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
            use.setAttribute('href', `${spriteUrl}#${iconName}`);
            svg.appendChild(use);
            indicator.appendChild(svg);
        }

        const label = document.createElement('span');
        label.textContent = `From: +${strategyInfo.protectFrom}`;
        indicator.appendChild(label);
    }

    return indicator;
}

/**
 * Get game object via React fiber tree traversal
 * @returns {Object|null} Game component instance
 */
function getGameObject() {
    const rootEl = document.getElementById('root');
    const rootFiber = rootEl?._reactRootContainer?.current || rootEl?._reactRootContainer?._internalRoot?.current;
    if (!rootFiber) return null;

    function find(fiber) {
        if (!fiber) return null;
        if (fiber.stateNode?.handleGoToAction) return fiber.stateNode;
        return find(fiber.child) || find(fiber.sibling);
    }

    return find(rootFiber);
}

/**
 * Create a "Return to Action" tab for navigating back after buying materials
 * @param {HTMLElement} referenceTab - Tab element to clone structure from
 * @returns {HTMLElement|null} Return tab element, or null if no stored context
 */
function createReturnTab(referenceTab) {
    let displayName;

    if (storedUpgradeBaseAcquisition?.kind.endsWith('-enhance')) {
        const acquisition = storedUpgradeBaseAcquisition;
        displayName = `Enhance +${acquisition.startLevel} → +${acquisition.targetLevel} before crafting`;
    } else if (storedActionHrid) {
        const details = dataManager.getActionDetails(storedActionHrid);
        displayName = details?.name || storedActionHrid.split('/').pop();
        if (storedNumActions > 0) displayName += ` (\u00d7${formatWithSeparator(storedNumActions)})`;
    } else if (storedEnhancementContext) {
        const ctx = storedEnhancementContext;
        const itemName = dataManager.getItemDetails(ctx.itemHrid)?.name || '...';
        displayName = `${itemName} +${ctx.startLevel}\u2192+${ctx.targetLevel}`;
    } else if (storedAlchemyContext) {
        const ctx = storedAlchemyContext;
        const itemName = dataManager.getItemDetails(ctx.itemHrid)?.name || '...';
        displayName = `${itemName} (\u00d7${formatWithSeparator(ctx.numActions)})`;
    } else {
        return null;
    }

    const tab = referenceTab.cloneNode(true);
    tab.setAttribute('data-mwi-custom-tab', 'true');
    tab.setAttribute('data-mwi-tab-owner', TAB_OWNER);
    tab.classList.remove('Mui-selected');
    tab.setAttribute('aria-selected', 'false');
    tab.setAttribute('tabindex', '-1');

    const badgeSpan = tab.querySelector('[class*="TabsComponent_badge"]');
    if (badgeSpan) {
        badgeSpan.innerHTML = `
            <div style="text-align: center;">
                <div>\u21a9 Return</div>
                <div style="font-size: 0.75em; color: #60a5fa;">${displayName}</div>
            </div>
        `;
    }

    tab.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleReturnToAction();
    });

    return tab;
}

/**
 * Open the Enhancing panel with the stack being enhanced preselected.
 *
 * Enhancing is the single action `/actions/enhancing/enhance`, so it is reached
 * through `handleGoToAction` like any other (there is no `handleChangeNavTarget`
 * on the game component). When the inventory still holds a stack at the starting
 * level, the game's own `handleEnhanceItem` preselects it; otherwise the panel
 * opens with nothing selected.
 *
 * @param {Object} game - Game component instance
 * @param {{itemHrid: string, startLevel: number}} ctx - Stored enhancement context
 */
function openEnhancingPanel(game, ctx) {
    const inventory = dataManager.getInventory?.() || [];
    const stack = inventory.find(
        (item) =>
            item &&
            item.itemHrid === ctx.itemHrid &&
            (item.itemLocationHrid || ENHANCE_INVENTORY_LOCATION) === ENHANCE_INVENTORY_LOCATION &&
            (Number(item.enhancementLevel) || 0) === (Number(ctx.startLevel) || 0) &&
            (item.count == null || item.count > 0)
    );
    const hash = stack
        ? stack.hash ||
          buildItemHash(
              dataManager.getCurrentCharacterId?.(),
              ENHANCE_INVENTORY_LOCATION,
              ctx.itemHrid,
              Number(ctx.startLevel) || 0
          )
        : null;

    if (hash && typeof game.handleEnhanceItem === 'function') {
        game.handleEnhanceItem(hash);
    } else if (typeof game.handleGoToAction === 'function') {
        game.handleGoToAction(ENHANCE_ACTION_HRID);
    }
}

/**
 * Navigate back to the stored action and restore input values
 */
async function handleReturnToAction() {
    const game = getGameObject();
    if (!game) return;

    // Captured before navigating: leaving the marketplace runs the cleanup that
    // clears the stored context, and the count is restored after that
    const alchemyContext = storedAlchemyContext;
    const restoreCount = storedUpgradeBaseAcquisition?.kind.endsWith('-enhance')
        ? 0
        : storedActionHrid
          ? storedNumActions
          : alchemyContext
            ? alchemyContext.numActions
            : 0;
    const inputSelector = alchemyContext
        ? `${ALCHEMY_PANEL_SELECTOR} [class*="maxActionCountInput"] input`
        : '[class*="maxActionCountInput"] input';

    if (storedUpgradeBaseAcquisition?.kind.endsWith('-enhance')) {
        openEnhancingPanel(game, storedUpgradeBaseAcquisition);
    } else if (storedActionHrid) {
        game.handleGoToAction(storedActionHrid);
    } else if (storedEnhancementContext) {
        openEnhancingPanel(game, storedEnhancementContext);
    } else if (alchemyContext) {
        if (!openAlchemyPanel(game, alchemyContext)) return;
    } else {
        return;
    }

    // The game's alchemize call selects the item but not the tab, so a Transmute
    // bill would come back on whatever tab the game shows. Select it first: the
    // switch can reset the Repeat input restored below.
    if (alchemyContext?.actionType) await selectAlchemyTab(alchemyContext.actionType);

    // Restore the Repeat count - poll for the input to appear
    if (restoreCount > 0) {
        const maxAttempts = 20;
        for (let i = 0; i < maxAttempts; i++) {
            await new Promise((resolve) => {
                timerRegistry.scheduleTimeout(resolve, 100);
            });

            const input =
                document.querySelector(inputSelector) ||
                (alchemyContext
                    ? null
                    : document.querySelector('[class*="SkillActionDetail_skillActionDetail"] input[type="number"]'));
            if (input) {
                setReactInputValue(input, restoreCount);
                break;
            }
        }
    }
}

/**
 * Select the stored alchemy tab by position once the panel's strip has mounted
 * (see `selectAlchemyTab` in utils/alchemy-navigation.js).
 *
 * @param {string} actionType - The stored tab, e.g. 'transmute'
 * @returns {Promise<void>}
 */
export function selectAlchemyTab(actionType) {
    return selectAlchemyTabAt(actionType, timerRegistry.scheduleTimeout);
}

/**
 * Open the Alchemy panel on the item the bill was for (see `openAlchemyOnItem`).
 *
 * @param {Object} game - Game component instance
 * @param {{itemHrid: string, actionType: string|null}} ctx - Stored alchemy context
 * @returns {boolean} Whether a navigation was made
 */
function openAlchemyPanel(game, ctx) {
    return openAlchemyOnItem(game, ctx);
}

/**
 * Create custom tabs for missing materials
 * @param {Array} missingMaterials - Array of missing material objects
 * @param {Object|null} strategyInfo - Auto-calculated protection strategy info
 */
function createMissingMaterialTabs(missingMaterials, strategyInfo = null) {
    const tabsContainer = visibleTabsContainer();

    if (!tabsContainer) {
        console.error('[MissingMats] Tabs container not found');
        return false;
    }

    // Remove any existing custom tabs first (preserve stored context — we're recreating, not leaving)
    removeMaterialTabs({ owner: TAB_OWNER });
    currentMaterialsTabs.length = 0;

    // Get reference tab for cloning (use "My Listings" as template)
    const referenceTab = Array.from(tabsContainer.children).find((btn) => btn.textContent.includes('My Listings'));

    if (!referenceTab) {
        console.error('[MissingMats] Reference tab not found');
        return false;
    }

    // Enable flex wrapping for multiple rows (like game's native tabs)
    if (tabsContainer) {
        tabsContainer.style.flexWrap = 'wrap';
    }

    // See attachRegularTabClearListener: clears the armed quantity when a
    // *different* native tab is picked, but not on "+ New Buy Listing" /
    // "+ New Sell Listing" — those live in the same flex row but aren't MUI
    // Tabs.
    attachRegularTabClearListener(tabsContainer, () => autofillManager.clearQuantity());

    // Create tab for each missing material
    currentMaterialsTabs.length = 0; // Clear without reassigning (preserves observer reference)

    // Add strategy indicator if auto-calculated
    if (strategyInfo) {
        const indicator = createStrategyIndicator(strategyInfo);
        insertTabInOrder(tabsContainer, indicator, 'material');
        currentMaterialsTabs.push(indicator);
    }

    for (const material of missingMaterials) {
        if (material.ownedInput || material.acquisition?.kind.startsWith('owned')) continue;
        const tabRef = { tab: null };
        const handler = makeMaterialClickHandler(tabRef);
        const tab = createMaterialTab(material, referenceTab, handler, { owner: TAB_OWNER });
        tab.setAttribute('data-enhancement-level', String(material.enhancementLevel || 0));
        tabRef.tab = tab;
        insertTabInOrder(tabsContainer, tab, 'material');
        currentMaterialsTabs.push(tab);
    }

    // Add "Return to Action" tab at the end
    const preparation = createBasePreparationIndicator();
    if (preparation) {
        insertTabInOrder(tabsContainer, preparation, 'material');
        currentMaterialsTabs.push(preparation);
    }
    const returnTab = createReturnTab(referenceTab);
    if (returnTab) {
        insertTabInOrder(tabsContainer, returnTab, 'return');
        currentMaterialsTabs.push(returnTab);
    }

    // One click, every pinned tab (material tabs, the strategy indicator, and
    // Return) gone, landing back on the plain Market Listings view
    const clearAllControl = createClearAllTabsControl(referenceTab, () => handleClearAllClick(true), {
        owner: TAB_OWNER,
    });
    insertTabInOrder(tabsContainer, clearAllControl, 'close-all');
    currentMaterialsTabs.push(clearAllControl);
    return true;
}
/**
 * Setup inventory listener for live tab updates
 * Listens for inventory changes via websocket and updates tabs accordingly
 */
function setupInventoryListener() {
    // Remove existing listener if any
    if (inventoryUpdateHandler) {
        webSocketHook.off('*', inventoryUpdateHandler);
    }

    // Create new listener that watches for inventory-related messages
    inventoryUpdateHandler = (data) => {
        // Check if this message might affect inventory
        // Common message types that update inventory:
        // - item_added, item_removed, items_updated
        // - market_buy_complete, market_sell_complete
        // - action_completed carries inventory deltas in endCharacterItems
        // - Or any message with inventory field
        if (
            data.type?.includes('item') ||
            data.type?.includes('inventory') ||
            data.type?.includes('market') ||
            data.inventory ||
            data.characterItems ||
            data.endCharacterItems?.length
        ) {
            updateTabsOnInventoryChange();
        }
    };

    webSocketHook.on('*', inventoryUpdateHandler);
    unsubscribeBaseReservations?.();
    unsubscribeBaseReservations = null;
    if (baseQueueHandler) {
        dataManager.off('actions_updated', baseQueueHandler);
        dataManager.off('items_updated', baseQueueHandler);
    }
    baseQueueHandler = null;
    if (billCharacterHandler) dataManager.off('character_switching', billCharacterHandler);
    // Every shopping bill belongs to the current character, including plain
    // lists opened without this feature's initialize() lifecycle.
    billCharacterHandler = handleMarketplaceCleanup;
    dataManager.on('character_switching', billCharacterHandler);
    if (storedUpgradeBaseAcquisition || storedMaterialList?.ownedInputs?.length) {
        // Checking ownership writes nothing. Calling the full tab update here
        // would reserve again and recursively trigger this same notification.
        const validateBase = () => {
            if (storedMaterialList?.ownedInputs?.length) {
                if (listMaterials(storedMaterialList).some((line) => line.acquisitionUnavailable))
                    handleMarketplaceCleanup();
                return;
            }
            if (!storedUpgradeBaseAcquisition || !storedActionHrid) return;
            const lines = calculateMaterialRequirements(
                storedActionHrid,
                storedNumActions,
                !config.getSetting('actions_missingMaterialsButton_ignoreQueue'),
                {
                    ownerId: RESERVATION_OWNER,
                    upgradeItemLevel: storedUpgradeItemLevel,
                    upgradeBaseAcquisition: storedUpgradeBaseAcquisition,
                }
            );
            if (lines.some((line) => line.acquisitionUnavailable)) handleMarketplaceCleanup();
        };
        unsubscribeBaseReservations = onReservationsChanged(validateBase);
        baseQueueHandler = validateBase;
        dataManager.on('actions_updated', baseQueueHandler);
        // A completed action reports what it used up only as an inventory update, not a queue
        // change: an infinite or ignored-queue craft can spend the owned source while the bill is open
        dataManager.on('items_updated', baseQueueHandler);
        validateBase();
    }
}

/**
 * Update all custom tabs when inventory changes
 * Recalculates materials and updates badge display
 * @param {{claim?: boolean}} [options] - Skip restating a bill just claimed by its opener
 */
function updateTabsOnInventoryChange({ claim = true } = {}) {
    // Check if tabs still exist
    if (currentMaterialsTabs.length === 0) {
        return;
    }

    let updatedMaterials;

    if (storedEnhancementContext) {
        // Enhancement mode
        const ctx = storedEnhancementContext;
        updatedMaterials = calculateEnhancementMaterialRequirements(
            ctx.itemHrid,
            ctx.startLevel,
            ctx.targetLevel,
            ctx.protectionItemHrid,
            ctx.protectFromLevel,
            ctx.repeatCount,
            RESERVATION_OWNER,
            ctx.copies
        );
    } else if (storedActionHrid && storedNumActions > 0) {
        // Production mode
        const ignoreQueue = config.getSetting('actions_missingMaterialsButton_ignoreQueue') || false;
        const accountForQueue = !ignoreQueue;
        updatedMaterials = calculateMaterialRequirements(storedActionHrid, storedNumActions, accountForQueue, {
            ownerId: RESERVATION_OWNER,
            upgradeItemLevel: storedUpgradeItemLevel,
            upgradeBaseAcquisition: storedUpgradeBaseAcquisition,
        });
    } else if (storedAlchemyContext) {
        updatedMaterials = alchemyMaterials(storedAlchemyContext);
    } else if (storedMaterialList) {
        updatedMaterials = listMaterials(storedMaterialList);
    } else {
        return;
    }

    if (updatedMaterials.some((line) => line.acquisitionUnavailable)) {
        // The assumed copy was spent, listed or reserved elsewhere. Close this
        // stale shopping plan rather than offer a replacement it never priced.
        handleMarketplaceCleanup();
        return;
    }

    // The bill has been recomputed; the claim behind it moves with it — but a
    // bill opened under a caller's own owner id is that caller's claim, made
    // once when it opened the tabs. Restating it here under the tabs' own owner
    // would put a second claim on one shopping trip, and since the tabs net
    // against every owner but the caller's, the trip would then be short
    // against itself.
    if (claim && !storedMaterialList?.ownerId) claimOpenBill(updatedMaterials);

    // Update each existing tab
    currentMaterialsTabs.forEach((tab) => {
        const itemHrid = tab.getAttribute('data-item-hrid');
        const level = Number(tab.getAttribute('data-enhancement-level')) || 0;
        const material = updatedMaterials.find((m) => m.itemHrid === itemHrid && (m.enhancementLevel || 0) === level);

        if (material) {
            updateTabBadge(tab, material);
        }
    });
    // Controls pinned beside the tabs (Buy next) re-read the badges
    currentMaterialsTabs.forEach((tab) => {
        if (tab.hasAttribute('data-mwi-buy-next')) tab.dispatchEvent(new Event('mwi-tabs-updated'));
    });
}

/**
 * Handle the "× All" control: the same teardown as leaving the marketplace
 * (every pinned tab and the Return tab gone, the armed quantity cleared, the
 * inventory listener dropped), triggered by the player instead of by navigation.
 * @param {boolean} returnToMarketListings - Click the native Market Listings tab
 *   afterward, so the strip that just lost its selected custom tab does not sit
 *   on nothing. Skipped for the Tester shop hand-off, which has no such tab —
 *   the Tester tab itself is already the "normal" view there.
 */
function handleClearAllClick(returnToMarketListings) {
    handleMarketplaceCleanup();
    if (returnToMarketListings) {
        navigateToMarketListingsTab();
    }
}

/**
 * Handle marketplace cleanup (when leaving marketplace)
 * Called by the marketplace cleanup observer
 */
function handleMarketplaceCleanup() {
    removeMaterialTabs({ owner: TAB_OWNER });
    currentMaterialsTabs.length = 0; // Clear without reassigning (preserves observer reference)

    // Clean up inventory listener
    if (inventoryUpdateHandler) {
        webSocketHook.off('*', inventoryUpdateHandler);
        inventoryUpdateHandler = null;
    }

    unsubscribeBaseReservations?.();
    unsubscribeBaseReservations = null;
    if (baseQueueHandler) {
        dataManager.off('actions_updated', baseQueueHandler);
        dataManager.off('items_updated', baseQueueHandler);
    }
    baseQueueHandler = null;
    if (billCharacterHandler) dataManager.off('character_switching', billCharacterHandler);
    billCharacterHandler = null;

    // The tabs are the panel: leaving the marketplace closes it, and a
    // transient claim does not outlive what made it
    release(RESERVATION_OWNER);

    // Clear stored context — only when genuinely leaving the marketplace
    billGeneration++;
    storedUpgradeBaseAcquisition = null;
    storedActionHrid = null;
    storedNumActions = 0;
    storedEnhancementContext = null;
    storedMaterialList = null;
    storedAlchemyContext = null;
    autofillManager.clearQuantity();
}

/**
 * A bill of materials against the inventory, in the shape the tabs draw.
 *
 * Only unenhanced copies count as "have", as in the action calculator — an
 * enhanced piece is not what a house level or a recipe consumes. Nothing is
 * reserved for the action queue here: a house level is not an action.
 *
 * A line may name an enhancement level, which is how the simulators' Upgrade
 * tab asks for a piece of gear rather than a material: the tab then opens that
 * level's listing, and only copies already at that level count as held. The
 * field is carried only where it means something, so a plain bill's line is
 * the object it has always been. `unclaimedBoughtCount` is +0-only, so a
 * levelled line does not consult it — a buy order for the unenhanced item is
 * not progress towards a +7.
 *
 * A line may also carry `queued`: units the finite action queue will already
 * consume, which are not this bill's to spend either (the Alchemy panel's bill
 * passes it; every other caller leaves it out and gets 0, as before).
 *
 * @param {Array<{itemHrid: string, count: number, enhancementLevel?: number, queued?: number}>} lines - What
 *   is needed, in total
 * @param {string|null} [ownerId] - Who is asking, for the reservation ledger. The asking
 *   owner's own claim is never deducted, and nothing is deducted while the ledger is off
 *   or when no owner is named — omitting it is how every caller that predates the ledger
 *   calls this, and it must go on meaning "the ledger is not part of these figures"
 * @param {Map<string, number>} [ownedInBag] - Bag units required as separate owned inputs,
 *   keyed by item hrid with `@level` for enhanced copies. They cannot also satisfy a purchase line.
 * @returns {Array<Object>} Material objects for `createMaterialTab`
 */
export function materialsFromList(lines, ownerId = null, ownedInBag = new Map()) {
    const inventory = dataManager.getInventory?.() || [];
    const itemDetailMap = dataManager.getInitClientData?.()?.itemDetailMap || {};
    const out = [];
    for (const line of lines || []) {
        const required = Math.max(0, Math.floor(Number(line?.count) || 0));
        if (!line?.itemHrid || required <= 0) continue;
        const details = itemDetailMap[line.itemHrid];
        const level = Math.max(0, Math.floor(Number(line.enhancementLevel) || 0));
        // Bought-but-unclaimed units on the player's own buy orders count as
        // held — it is what makes the Missing figure fall while the order
        // fills instead of only after a trip to My Listings
        //
        // Only a copy actually sitting in the bag counts as stock, matching
        // `heldInInventory` — `getInventory()` mixes inventory, equipped and
        // listed copies into one array, and a recipe cannot spend an equipped
        // piece or one on the auction. A row with no location at all (a test
        // fixture, or a source that never carried the field) is kept, so this
        // stays the same for every caller that predates location mattering.
        const have =
            (level > 0 ? 0 : unclaimedBoughtCount(line.itemHrid)) +
            inventory
                .filter(
                    (i) =>
                        i.itemHrid === line.itemHrid &&
                        (i.enhancementLevel || 0) === level &&
                        (!i.itemLocationHrid || i.itemLocationHrid === INVENTORY_LOCATION)
                )
                .reduce((sum, i) => sum + (i.count || 0), 0);
        const queued = Math.max(0, Math.floor(Number(line.queued) || 0));
        const key = level > 0 ? `${line.itemHrid}@${level}` : line.itemHrid;
        const owned = ownedInBag.get(key) || 0;
        // The separate owned inputs get their physical bag copies first. A
        // purchase line can use only the remainder, even though both roles
        // are excluded together as this bill's own reservation in the ledger.
        // Stock another plan has claimed or the queue will eat is unavailable too.
        const unclaimed = ownerId
            ? effectiveInventory(line.itemHrid, level, { excludeOwner: ownerId, held: have })
            : have;
        const available = Math.max(0, unclaimed - queued - owned);
        const missing = Math.max(0, required - available);
        const reserved = ownerId ? reservedElsewhere(line.itemHrid, level, { excludeOwner: ownerId }) : 0;
        // Only when a claim is what put the line short: an empty bag needs no explanation
        const reservedNote =
            missing > 0 && have - queued - owned >= required
                ? shortfallNote(missing, line.itemHrid, level, { excludeOwner: ownerId })
                : '';
        out.push({
            itemHrid: line.itemHrid,
            itemName: details?.name || line.itemHrid.split('/').pop().replace(/_/g, ' '),
            ...(level > 0 ? { enhancementLevel: level } : {}),
            required,
            have,
            queued,
            available,
            missing,
            isTradeable: details?.isTradable === true,
            isUpgradeItem: false,
            ...(reserved > 0 ? { reserved } : {}),
            ...(reservedNote ? { reservedNote } : {}),
        });
    }
    return out;
}

/**
 * Recount a list's owned prerequisites separately from its purchasable lines.
 * Exact location prevents a missing bag copy from becoming the distinct worn
 * piece already credited as sold. The ledger itself remains item/level scoped.
 * Nothing bought-but-unclaimed can replace an explicitly owned physical copy.
 * @param {Object} context - The transient list and owned source descriptors
 * @returns {Array<Object>} Full requirements, including non-purchasable owned inputs
 */
function listMaterials(context) {
    const ownerId = context.ownerId || RESERVATION_OWNER;
    const ownedMaterials = [];
    const ownedInBag = new Map();
    const inventory = dataManager.getInventory?.() || [];
    const queued =
        !context.ownedInputs?.length || config.getSetting('actions_missingMaterialsButton_ignoreQueue')
            ? new Map()
            : calculateQueuedMaterialsForAction(null);
    const claimed = new Map();
    for (const input of context.ownedInputs || []) {
        const level = Math.max(0, Math.floor(Number(input.enhancementLevel) || 0));
        const required = Math.max(0, Math.floor(Number(input.count) || 0));
        const key = level > 0 ? `${input.itemHrid}@${level}` : input.itemHrid;
        const have =
            input.sourceLocation && input.sourceLocation !== '/item_locations/market_listing'
                ? inventory
                      .filter(
                          (item) =>
                              item.itemHrid === input.itemHrid &&
                              (item.enhancementLevel || 0) === level &&
                              (item.itemLocationHrid || INVENTORY_LOCATION) === input.sourceLocation &&
                              item.count !== 0
                      )
                      .reduce((total, item) => total + (item.count ?? 1), 0)
                : 0;
        // Reservations and queued crafts do not identify a source location.
        // Deduct them conservatively, once per stack, just as owned craft bases do.
        const used = claimed.get(key) || 0;
        const available = Math.max(
            0,
            effectiveInventory(input.itemHrid, level, { excludeOwner: ownerId, held: have }) -
                (queued.get(key) || 0) -
                used
        );
        claimed.set(key, used + required);
        if (input.sourceLocation === INVENTORY_LOCATION) {
            ownedInBag.set(key, (ownedInBag.get(key) || 0) + required);
        }
        const missing = Math.max(0, required - available);
        ownedMaterials.push({
            itemHrid: input.itemHrid,
            enhancementLevel: level,
            required,
            missing,
            ownedInput: true,
            acquisitionUnavailable:
                context.characterId !== dataManager.getCurrentCharacterId?.() ||
                !input.itemHrid ||
                !required ||
                missing > 0,
        });
    }
    return [...materialsFromList(context.lines, ownerId, ownedInBag), ...ownedMaterials];
}

/** A stale source must never silently turn into a purchase absent from the quote. */
function assertOwnedListAvailable(materials) {
    if (!materials.some((line) => line.acquisitionUnavailable)) return;
    const error = new Error('An owned input is no longer available. Refresh the Equipment Watch route.');
    error.code = 'OWNED_INPUT_UNAVAILABLE';
    throw error;
}

/**
 * Open the marketplace on a bill of materials that is not an action's — a
 * house level's materials, or the two pieces a cross-slot gear swap buys, from
 * the simulators' Upgrade tab — one tab per item, each arming the buy box with
 * what is still missing, kept live as the inventory changes. The same tabs the
 * action panel button builds, from a list instead of a recipe. A line that
 * names an enhancement level opens that level's listing.
 *
 * @param {Array<{itemHrid: string, count: number, enhancementLevel?: number}>} lines - Totals needed
 * @param {Object} [options] - Options
 * @param {string|null} [options.ownerId] - The caller's reservation-ledger owner id, when it
 *   keeps a claim of its own; without one the open tabs claim the bill themselves
 * @param {Array<Object>} [options.ownedInputs] - Required owned copies, each naming itemHrid,
 *   enhancementLevel, count and sourceLocation. They are claimed but never offered as purchases.
 * @returns {Promise<boolean>} Whether the marketplace opened and the tabs were drawn
 */
export async function openMaterialsList(lines, { ownerId = null, ownedInputs = [] } = {}) {
    const wanted = (lines || []).filter((line) => line?.itemHrid && Number(line.count) > 0);
    if (!wanted.length) return false;
    const characterId = dataManager.getCurrentCharacterId?.();
    const context = structuredClone({ lines: wanted, ownerId, ownedInputs, characterId });
    const materials = listMaterials(context);
    // A stale quote must leave the existing bill and its claim intact.
    assertOwnedListAvailable(materials);

    billGeneration++;
    storedUpgradeBaseAcquisition = null;
    storedActionHrid = null;
    storedNumActions = 0;
    storedEnhancementContext = null;
    storedUpgradeItemLevel = 0;
    storedAlchemyContext = null;
    storedMaterialList = context;

    // A caller that keeps a claim of its own has already made it (the crafting
    // plan does, on the click that opened this); only an anonymous bill is
    // claimed here, under the tabs' own transient owner
    const isCurrent = () => storedMaterialList === context && dataManager.getCurrentCharacterId?.() === characterId;
    const opened = await openWhereBought(materials);
    if (!isCurrent()) return false;
    if (!opened) {
        if (context.ownedInputs?.length) handleMarketplaceCleanup();
        return false;
    }
    const fresh = listMaterials(context);
    if (fresh.some((line) => line.acquisitionUnavailable)) {
        handleMarketplaceCleanup();
        assertOwnedListAvailable(fresh);
    }
    if (!ownerId) await claimOpenBill(fresh);
    else await release(RESERVATION_OWNER);
    if (!isCurrent()) return false;
    setupInventoryListener();
    // Navigation and the claim write both await: stock may have moved since the
    // tabs were drawn. Refresh the quantities before a click can arm a stale buy
    // amount. This also removes an old anonymous claim from an external owner's
    // figures after the release above, without claiming the same bill twice.
    if (isCurrent()) updateTabsOnInventoryChange({ claim: false });
    return isCurrent();
}

/**
 * The reservation owner behind the bill of materials currently on screen, when
 * that bill was opened by a caller holding a claim of its own.
 *
 * The seam a caller needs to answer "is my shopping trip still open?". A
 * crafting plan's claim is supposed to live exactly as long as the player can
 * see the plan, and clicking Buy Missing Materials navigates away from the
 * action panel — so without this the claim behind the very trip the player is
 * on would be swept the moment the panel unmounted.
 *
 * Null once the tabs are gone (leaving the marketplace, the × All control) or
 * for a bill the tabs claimed themselves.
 *
 * @returns {string|null} The caller's owner id, or null
 */
export function openBillOwner() {
    if (!currentMaterialsTabs.length) return null;
    return storedMaterialList?.ownerId || null;
}

/**
 * Open the marketplace on the materials an action is short of.
 *
 * The same thing the button in the action panel does, reachable from anywhere.
 * Equipment Watch wants it for a craft it is saving towards, and that card is
 * in another bundle — so this is the seam rather than a second implementation
 * of the tab-building, which is where the two would drift apart.
 *
 * @param {string} actionHrid - The action whose inputs are wanted
 * @param {number} [numActions] - How many of it
 * @param {Object} [options] - Options
 * @param {Object|null} [options.upgradeBaseAcquisition] - Watch's transient source/target levels and
 *   enhancement bill. An owned source is revalidated before shopping and on inventory changes.
 * @param {number} [options.upgradeItemLevel] - The enhancement level the action's upgrade item
 *   is wanted at. A refinement that retains enhancement is made FROM a base already at the
 *   output's level, so a caller saving towards a ★+12 needs the +12 listing rather than the
 *   +0 one. Defaults to 0, which is every action panel and every plain craft — unchanged.
 * @returns {Promise<void>}
 */
export async function openMissingMaterials(
    actionHrid,
    numActions = 1,
    { upgradeItemLevel = 0, upgradeBaseAcquisition = null } = {}
) {
    await handleMissingMaterialsClick(actionHrid, numActions, upgradeItemLevel, upgradeBaseAcquisition);
}

/**
 * Open the marketplace on the materials for crafting several things at once.
 *
 * The Consumables panel's craft route for dungeon keys: the entry key and, if
 * asked, the chest key are made by different actions that share materials, so
 * the bill is the SUM of each action's requirement and the stock held is netted
 * off once. Each action's requirement comes from the same calculator the panel
 * button uses, which applies Artisan per craft (rounded per craft, not per unit)
 * — summing the shortfalls instead would net shared materials against stock
 * twice.
 *
 * @param {Array<{actionHrid: string, numActions: number}>} crafts - What to craft and how many actions of each
 * @returns {Promise<boolean>} Whether the marketplace opened with at least one line
 */
export async function openCraftBill(crafts) {
    const totals = new Map();
    for (const craft of crafts || []) {
        const numActions = Math.max(0, Math.floor(Number(craft?.numActions) || 0));
        if (!craft?.actionHrid || numActions <= 0) continue;
        for (const line of calculateMaterialRequirements(craft.actionHrid, numActions, false)) {
            // A line that names an enhancement level is a different stack
            const level = Math.max(0, Math.floor(Number(line.enhancementLevel) || 0));
            const key = `${line.itemHrid}@${level}`;
            const total = totals.get(key) || { itemHrid: line.itemHrid, enhancementLevel: level, count: 0 };
            total.count += line.required;
            totals.set(key, total);
        }
    }
    const lines = [...totals.values()].map((line) => ({
        itemHrid: line.itemHrid,
        count: line.count,
        ...(line.enhancementLevel > 0 ? { enhancementLevel: line.enhancementLevel } : {}),
    }));
    return openMaterialsList(lines);
}

/**
 * Open the marketplace on one Alchemy action's bill for an item, exactly as the Alchemy panel's
 * button does for the panel's selection. Navigation only: nothing is bought.
 *
 * @param {string} itemHrid - The item being alchemized
 * @param {string|null} actionType - The Alchemy tab (coinify, decompose, transmute)
 * @param {number} [numActions] - How many actions to size the bill for
 * @returns {Promise<void>}
 */
export async function openAlchemyMissingMaterials(itemHrid, actionType, numActions = 1) {
    await handleAlchemyMissingMaterialsClick({ itemHrid, actionType, numActions, catalyst: null });
}

export default {
    initialize,
    openAlchemyMissingMaterials,
    cleanup,
    openMissingMaterials,
    openMaterialsList,
    openCraftBill,
    openBillOwner,
    openTesterShopPage,
};
