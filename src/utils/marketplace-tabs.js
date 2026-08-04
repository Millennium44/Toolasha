/**
 * Marketplace Custom Tabs Utility
 * Provides shared functionality for creating and managing custom marketplace tabs
 * Used by missing materials features (actions, houses, etc.)
 */

import { formatWithSeparator } from './formatters.js';

/**
 * Create a custom material tab for the marketplace
 * @param {Object} material - Material data object
 * @param {string} material.itemHrid - Item HRID
 * @param {string} material.itemName - Display name for the item
 * @param {number} material.missing - Amount missing (0 if sufficient)
 * @param {number} [material.queued=0] - Amount reserved by queue
 * @param {boolean} material.isTradeable - Whether item can be traded
 * @param {HTMLElement} referenceTab - Tab element to clone structure from
 * @param {Function} onClickCallback - Callback when tab is clicked, receives (e, material)
 * @param {Object} [options] - Optional extras
 * @param {Function} [options.onDismiss] - Called with `material` when the tab's own
 *   dismiss (×) button is used, right before the tab is removed from the DOM. Lets a
 *   caller prune whatever list of its own it is keeping alongside the tab.
 * @returns {HTMLElement} Created tab element
 */
export function createMaterialTab(material, referenceTab, onClickCallback, options = {}) {
    // Clone reference tab structure
    const tab = referenceTab.cloneNode(true);

    // Mark as custom tab for later identification
    tab.setAttribute('data-mwi-custom-tab', 'true');
    tab.setAttribute('data-item-hrid', material.itemHrid);
    tab.setAttribute('data-missing-quantity', material.missing.toString());

    // Color coding:
    // - Red: Missing materials (missing > 0)
    // - Green: Sufficient materials (missing = 0)
    // - Gray: Not tradeable
    let statusColor;
    let statusText;

    if (!material.isTradeable) {
        statusColor = '#888888'; // Gray - not tradeable
        statusText = 'Not Tradeable';
    } else if (material.missing > 0) {
        statusColor = '#ef4444'; // Red - missing materials
        // Show queued amount if any materials are reserved by queue
        const queuedText = material.queued > 0 ? ` (${formatWithSeparator(material.queued)} Q'd)` : '';
        statusText = `Missing: ${formatWithSeparator(material.missing)}${queuedText}`;
    } else {
        statusColor = '#4ade80'; // Green - sufficient materials
        statusText = `Sufficient (${formatWithSeparator(material.required)})`;
    }

    // Update text content
    const badgeSpan = tab.querySelector('[class*="TabsComponent_badge"]');
    if (badgeSpan) {
        // Title case: capitalize first letter of each word
        const titleCaseName = material.itemName
            .split(' ')
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(' ');

        badgeSpan.innerHTML = `
            <div style="text-align: center;">
                <div>${titleCaseName}</div>
                <div style="font-size: 0.75em; color: ${statusColor};">
                    ${statusText}
                </div>
            </div>
        `;
    }

    // Gray out if not tradeable
    if (!material.isTradeable) {
        tab.style.opacity = '0.5';
        tab.style.cursor = 'not-allowed';
    }

    // Remove selected state
    tab.classList.remove('Mui-selected');
    tab.setAttribute('aria-selected', 'false');
    tab.setAttribute('tabindex', '-1');

    // Add click handler
    tab.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (!material.isTradeable) {
            // Not tradeable - do nothing
            return;
        }

        // Call the provided callback
        if (onClickCallback) {
            onClickCallback(e, material);
        }
    });

    attachDismissButton(tab, material, options.onDismiss);

    return tab;
}

/**
 * Pin a small × in the corner of a tab, visible on hover, that removes just that
 * tab. It never got one, which is why the fix for "I don't want this pinned
 * anymore" was always "wait for the whole strip to be replaced or the
 * marketplace to close" — the only two things that called `removeMaterialTabs`.
 *
 * @param {HTMLElement} tab - Tab element (mutated in place)
 * @param {Object} material - The material this tab represents, handed to `onDismiss`
 * @param {Function} [onDismiss] - Called with `material` right before the tab is removed
 */
function attachDismissButton(tab, material, onDismiss) {
    // Absolute-positioned inside the tab, so the tab needs to anchor it. MUI tabs
    // are not positioned by default; only take over `position` when nothing else
    // already claimed it.
    if (!tab.style.position) {
        tab.style.position = 'relative';
    }

    const dismissBtn = document.createElement('span');
    dismissBtn.setAttribute('data-mwi-tab-dismiss', 'true');
    dismissBtn.title = 'Remove this tab';
    dismissBtn.textContent = '×';
    dismissBtn.style.cssText = `
        position: absolute;
        top: 1px;
        right: 1px;
        width: 14px;
        height: 14px;
        line-height: 13px;
        text-align: center;
        font-size: 12px;
        font-weight: 700;
        border-radius: 50%;
        color: #ddd;
        background: rgba(0, 0, 0, 0.45);
        cursor: pointer;
        opacity: 0;
        transition: opacity 0.12s ease;
        z-index: 1;
    `;

    tab.addEventListener('mouseenter', () => {
        dismissBtn.style.opacity = '1';
    });
    tab.addEventListener('mouseleave', () => {
        dismissBtn.style.opacity = '0';
    });

    dismissBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (onDismiss) onDismiss(material);
        tab.remove();
    });

    tab.appendChild(dismissBtn);
}

/**
 * Build a small "clear all" control shaped like the other tabs, so it sits in the
 * strip rather than floating above it. Clicking it removes every custom material
 * tab currently pinned (the same set `removeMaterialTabs` clears) — including
 * itself, since it is tagged `data-mwi-custom-tab` too.
 *
 * @param {HTMLElement} referenceTab - Tab element to clone structure from
 * @param {Function} [onClearAll] - Called after the tabs are removed, so a caller
 *   can prune whatever list of its own it was keeping alongside them
 * @returns {HTMLElement} The control element, not yet attached anywhere
 */
export function createClearAllTabsControl(referenceTab, onClearAll) {
    const control = referenceTab.cloneNode(true);

    control.setAttribute('data-mwi-custom-tab', 'true');
    control.setAttribute('data-mwi-clear-all-tab', 'true');
    control.classList.remove('Mui-selected');
    control.setAttribute('aria-selected', 'false');
    control.setAttribute('tabindex', '-1');
    control.title = 'Clear all pinned tabs';
    control.style.opacity = '0.7';
    control.style.flex = '0 0 auto';

    const badgeSpan = control.querySelector('[class*="TabsComponent_badge"]');
    if (badgeSpan) {
        badgeSpan.innerHTML = `
            <div style="text-align: center; font-weight: 700; font-size: 13px;">
                &times; All
            </div>
        `;
    }

    control.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        removeMaterialTabs();
        if (onClearAll) onClearAll();
    });

    return control;
}

/**
 * Append a `createClearAllTabsControl` to `container`, unless one is already
 * there. Kept idempotent so callers can invoke it every time they add tabs
 * without needing to track whether they already have one.
 *
 * @param {HTMLElement} container - The visible tab bar
 * @param {HTMLElement} referenceTab - Tab element to clone structure from
 * @param {Function} [onClearAll] - Forwarded to `createClearAllTabsControl`
 */
export function ensureClearAllTabsControl(container, referenceTab, onClearAll) {
    if (!container || container.querySelector('[data-mwi-clear-all-tab="true"]')) return;
    container.appendChild(createClearAllTabsControl(referenceTab, onClearAll));
}

/**
 * The marketplace tab bar you can actually see.
 *
 * There can be more than one. The marketplace opens as a popout over whatever
 * you were doing, and the full marketplace page keeps its own tab bar in the
 * document behind it — so `querySelector` returns whichever comes first, which
 * is frequently the hidden one. Tabs added there are added correctly and are
 * invisible, which is the worst shape a bug can take: nothing appears, and
 * visiting the real marketplace first "fixes" it by making the bar that was
 * already being picked the one on screen.
 *
 * Every candidate is checked and the displayed one wins.
 *
 * @param {string} [contains] - Text a tab must contain, to tell a marketplace bar
 *   from any other tab strip on the page
 * @returns {HTMLElement|null} The visible tab bar
 */
export function visibleTabsContainer(contains = 'My Listings') {
    for (const container of document.querySelectorAll('.MuiTabs-flexContainer[role="tablist"]')) {
        if (contains && !Array.from(container.children).some((tab) => tab.textContent.includes(contains))) continue;

        // `offsetParent` is null under any `display: none` ancestor, which is how
        // the game parks the panel you are not looking at
        if (container.offsetParent === null) continue;
        if (!container.getBoundingClientRect().width) continue;

        return container;
    }
    return null;
}

/**
 * Remove all custom material tabs from the marketplace
 */
export function removeMaterialTabs() {
    const customTabs = document.querySelectorAll('[data-mwi-custom-tab="true"]');
    customTabs.forEach((tab) => tab.remove());
}

/**
 * Remove all shrine-specific material tabs from the marketplace
 */
export function removeShrineMarketTabs() {
    document.querySelectorAll('[data-mwi-shrine-tab="true"]').forEach((tab) => tab.remove());
}

/**
 * Update the badge content and quantity attribute on an existing material tab
 * @param {HTMLElement} tab - Tab element created by createMaterialTab
 * @param {Object} material - Updated material data
 * @param {string} material.itemName - Display name
 * @param {number} material.missing - Current missing quantity
 * @param {number} [material.required] - Total required quantity
 * @param {boolean} material.isTradeable - Whether tradeable
 * @param {number} [material.queued] - Queued quantity
 */
export function updateTabBadge(tab, material) {
    const badgeSpan = tab.querySelector('[class*="TabsComponent_badge"]');
    if (!badgeSpan) return;

    let statusColor;
    let statusText;

    if (!material.isTradeable) {
        statusColor = '#888888';
        statusText = 'Not Tradeable';
    } else if (material.missing > 0) {
        statusColor = '#ef4444';
        const queuedText = material.queued > 0 ? ` (${formatWithSeparator(material.queued)} Q'd)` : '';
        statusText = `Missing: ${formatWithSeparator(material.missing)}${queuedText}`;
    } else {
        statusColor = '#4ade80';
        statusText = `Sufficient (${formatWithSeparator(material.required)})`;
    }

    const titleCaseName = material.itemName
        .split(' ')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join(' ');

    badgeSpan.innerHTML = `
        <div style="text-align: center;">
            <div>${titleCaseName}</div>
            <div style="font-size: 0.75em; color: ${statusColor};">
                ${statusText}
            </div>
        </div>
    `;

    tab.setAttribute('data-missing-quantity', material.missing.toString());

    if (!material.isTradeable) {
        tab.style.opacity = '0.5';
        tab.style.cursor = 'not-allowed';
    } else {
        tab.style.opacity = '1';
        tab.style.cursor = 'pointer';
    }
}

/**
 * Setup marketplace cleanup observer
 * Watches for marketplace panel removal and calls cleanup callback
 * @param {Function} onCleanup - Callback when marketplace closes, receives no args
 * @param {Array} tabsArray - Array reference to track tabs (will be checked for length)
 * @returns {Function} Unregister function to stop observing
 */
export function setupMarketplaceCleanupObserver(onCleanup, tabsArray) {
    let pollInterval = null;

    function poll() {
        if (!tabsArray || tabsArray.length === 0) return;

        // If custom tabs were removed from DOM, clean up
        const hasCustomTabsInDOM = tabsArray.some((tab) => document.body.contains(tab));
        if (!hasCustomTabsInDOM) {
            if (onCleanup) onCleanup();
            return;
        }

        // If marketplace panel is hidden (navigated away), clean up
        const marketplacePanel = document.querySelector('.MarketplacePanel_marketplacePanel__21b7o');
        const subPanelContainer = marketplacePanel?.closest('.MainPanel_subPanelContainer__1i-H9');
        if (subPanelContainer && getComputedStyle(subPanelContainer).display === 'none') {
            if (onCleanup) onCleanup();
        }
    }

    pollInterval = setInterval(poll, 1000);

    return () => {
        if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
        }
    };
}

/**
 * Get game object via React fiber
 * @returns {Object|null} Game component instance
 */
function getGameObject() {
    const rootEl = document.getElementById('root');
    const rootFiber = rootEl?._reactRootContainer?.current || rootEl?._reactRootContainer?._internalRoot?.current;
    if (!rootFiber) return null;

    function find(fiber) {
        if (!fiber) return null;
        if (fiber.stateNode?.handleGoToMarketplace) return fiber.stateNode;
        return find(fiber.child) || find(fiber.sibling);
    }

    return find(rootFiber);
}

/**
 * Navigate to marketplace for a specific item
 * @param {string} itemHrid - Item HRID to navigate to
 * @param {number} enhancementLevel - Enhancement level (default 0)
 */
export function navigateToMarketplace(itemHrid, enhancementLevel = 0) {
    const game = getGameObject();
    if (game?.handleGoToMarketplace) {
        game.handleGoToMarketplace(itemHrid, enhancementLevel);
    }
    // Silently fail if game API unavailable - feature still provides value without auto-navigation
}
