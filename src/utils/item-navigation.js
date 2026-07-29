/**
 * Item Navigation Utilities
 * Handles Alt+click navigation to crafting/gathering actions or item dictionary
 */

import dataManager from '../core/data-manager.js';

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
        if (fiber.stateNode?.handleGoToMarketplace) return fiber.stateNode;
        return find(fiber.child) || find(fiber.sibling);
    }

    return find(rootFiber);
}

/**
 * Find which action produces a given item
 * Prioritizes production actions over gathering actions
 * @param {string} itemHrid - Item HRID to search for
 * @returns {Object|null} { actionHrid, type: 'production'|'gathering' } or null
 */
export function findActionForItem(itemHrid) {
    const gameData = dataManager.getInitClientData();
    if (!gameData?.actionDetailMap) {
        return null;
    }

    const itemSlug = itemHrid.split('/').pop();

    // First pass: Look for production actions (outputItems)
    const productionMatches = [];
    for (const [actionHrid, action] of Object.entries(gameData.actionDetailMap)) {
        if (action.outputItems?.some((item) => item.itemHrid === itemHrid)) {
            productionMatches.push(actionHrid);
        }
    }
    if (productionMatches.length > 0) {
        const exact = productionMatches.find((a) => a.split('/').pop() === itemSlug);
        return { actionHrid: exact || productionMatches[0], type: 'production' };
    }

    // Second pass: Look for gathering actions (dropTable)
    const gatheringMatches = [];
    for (const [actionHrid, action] of Object.entries(gameData.actionDetailMap)) {
        if (action.dropTable?.some((drop) => drop.itemHrid === itemHrid)) {
            gatheringMatches.push(actionHrid);
        }
    }
    if (gatheringMatches.length > 0) {
        const exact = gatheringMatches.find((a) => a.split('/').pop() === itemSlug);
        return { actionHrid: exact || gatheringMatches[0], type: 'gathering' };
    }

    return null;
}

/**
 * Open the game's Item Dictionary for an item.
 * @param {string} itemHrid - Item HRID to open
 * @returns {boolean} True if the dictionary was opened
 */
export function openItemDictionary(itemHrid) {
    const game = getGameObject();
    if (!game?.handleOpenItemDictionary) {
        return false;
    }
    // Validate HRID exists before passing to game (invalid HRIDs crash renderDescription)
    if (!dataManager.getItemDetails(itemHrid)) {
        return false;
    }
    game.handleOpenItemDictionary(itemHrid);
    return true;
}

/**
 * Navigate to the action page for an item, or item dictionary if no action found
 * @param {string} itemHrid - Item HRID to navigate to
 * @returns {boolean} True if navigation was attempted, false if game API unavailable
 */
export function navigateToItem(itemHrid) {
    const game = getGameObject();
    if (!game) {
        return false;
    }

    // Try to find action that produces this item
    const actionInfo = findActionForItem(itemHrid);

    if (actionInfo && game.handleGoToAction) {
        // Navigate to the action page
        game.handleGoToAction(actionInfo.actionHrid);
        return true;
    } else if (game.handleOpenItemDictionary) {
        // Validate HRID exists before passing to game (invalid HRIDs crash renderDescription)
        const itemDetails = dataManager.getItemDetails(itemHrid);
        if (!itemDetails) {
            return false;
        }
        game.handleOpenItemDictionary(itemHrid);
        return true;
    }

    return false;
}
