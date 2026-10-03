import { artisanInputTotal, getArtisanMaterialMode } from '../../utils/artisan-material-mode.js';
import { INVENTORY_LOCATION } from '../../utils/inventory-reservations.js';

/**
 * Reconcile repeated plan branches against earlier planned output and, when
 * supplied, the player's unenhanced bag inventory. These stock sources remain
 * separate; buy quantities reflect material still needed and child actions are
 * sized to the remaining work.
 *
 * @param {Object} plan - A node from the crafting plan calculator
 * @param {Object} [options]
 * @param {Array<Object>} [options.inventory] - Effective inventory rows available to the plan
 * @returns {Object} A shallowly rebuilt plan tree with shared production applied
 */
export function normalizePlannedSurplus(plan, { inventory = [] } = {}) {
    // Keep physical stock separate from output produced by this plan. Both can
    // satisfy a later leg, but only planned output may reduce a later buy after
    // the player has committed the initial inventory to an earlier craft.
    const ownedStock = new Map();
    for (const row of Array.isArray(inventory) ? inventory : []) {
        if (!row?.itemHrid || row.enhancementLevel) continue;
        if (row.itemLocationHrid && row.itemLocationHrid !== INVENTORY_LOCATION) continue;
        ownedStock.set(row.itemHrid, (ownedStock.get(row.itemHrid) || 0) + (row.count || 0));
    }
    const plannedStock = new Map();
    const plannedSources = new Map();
    const artisanMode = getArtisanMaterialMode();

    function addPlannedStock(itemHrid, quantity, stepKey) {
        if (!(quantity > 0)) return;
        plannedStock.set(itemHrid, (plannedStock.get(itemHrid) || 0) + quantity);
        if (!stepKey) return;
        const sources = plannedSources.get(itemHrid) || [];
        sources.push({ quantity, stepKey });
        plannedSources.set(itemHrid, sources);
    }

    function usePlannedStock(itemHrid, quantity) {
        const sources = plannedSources.get(itemHrid) || [];
        let remaining = Math.min(plannedStock.get(itemHrid) || 0, quantity);
        const used = remaining;
        const dependencies = new Set();
        for (const source of sources) {
            if (!(remaining > 0)) break;
            const fromSource = Math.min(source.quantity, remaining);
            source.quantity -= fromSource;
            remaining -= fromSource;
            if (fromSource > 0) dependencies.add(source.stepKey);
        }
        const left = Math.max(0, (plannedStock.get(itemHrid) || 0) - used);
        if (left > 0) plannedStock.set(itemHrid, left);
        else plannedStock.delete(itemHrid);
        const availableSources = sources.filter((source) => source.quantity > 0);
        if (availableSources.length > 0) plannedSources.set(itemHrid, availableSources);
        else plannedSources.delete(itemHrid);
        return { used, dependencies: [...dependencies] };
    }

    function normalize(node, isRoot = false, quantityOverride, skipOwnedCredit = false) {
        if (!node) return null;
        const quantity = quantityOverride !== undefined ? quantityOverride : node.quantity;

        if (node.strategy === 'buy') {
            if (node.itemHrid === '/items/coin' || !(quantity > 0)) return { ...node, quantity, children: [] };
            const owned = skipOwnedCredit ? 0 : ownedStock.get(node.itemHrid) || 0;
            const usedOwned = Math.min(owned, quantity);
            if (usedOwned > 0) ownedStock.set(node.itemHrid, owned - usedOwned);
            const afterOwned = quantity - usedOwned;
            const { used: usedPlanned, dependencies } = usePlannedStock(node.itemHrid, afterOwned);
            const remaining = afterOwned - usedPlanned;
            return {
                ...node,
                quantity: remaining,
                totalCost: Number.isFinite(node.unitCost) ? node.unitCost * remaining : node.totalCost,
                ...(dependencies.length > 0 ? { plannedDependencies: dependencies } : {}),
                children: [],
            };
        }

        let remaining = quantity;
        let actionsForRemainder = null;
        let plannedDependencies = [];
        if (!isRoot && quantity > 0) {
            const owned = skipOwnedCredit ? 0 : ownedStock.get(node.itemHrid) || 0;
            const usedOwned = Math.min(owned, quantity);
            if (usedOwned > 0) ownedStock.set(node.itemHrid, owned - usedOwned);
            const afterOwned = quantity - usedOwned;
            const { used: usedPlanned, dependencies } = usePlannedStock(node.itemHrid, afterOwned);
            plannedDependencies = dependencies;
            remaining = afterOwned - usedPlanned;
            if (!(remaining > 0)) {
                return {
                    ...node,
                    quantity,
                    actionsNeeded: 0,
                    stepCount: quantity,
                    ...(plannedDependencies.length > 0 ? { plannedDependencies } : {}),
                    children: [],
                };
            }

            if (node.outputCount > 0) {
                actionsForRemainder = Math.ceil(remaining / node.outputCount);
                const surplus = actionsForRemainder * node.outputCount - remaining;
                if (surplus > 0) addPlannedStock(node.itemHrid, surplus, node.actionHrid && `craft:${node.actionHrid}`);
            } else if (node.actionsNeeded > 0) {
                actionsForRemainder = Math.ceil(node.actionsNeeded * (remaining / quantity));
            }
        }

        const children = [];
        for (const child of node.children || []) {
            let childQuantity = child.quantity;
            if (actionsForRemainder !== null && child.craftInputMeta) {
                const { countPerAction, artisanBonus } = child.craftInputMeta;
                childQuantity = artisanInputTotal(countPerAction, artisanBonus, actionsForRemainder, artisanMode);
            } else if (actionsForRemainder !== null && child.isUpgradeItem) {
                childQuantity = actionsForRemainder;
            } else if (actionsForRemainder !== null && node.actionsNeeded > 0) {
                childQuantity = child.quantity * (actionsForRemainder / node.actionsNeeded);
            }

            // In a merged task group the immediate children are task targets;
            // bag stock cannot cancel actions the task itself still owes.
            const skipChildOwnedCredit = node.strategy === 'group' && isRoot;
            const normalizedChild = normalize(child, false, childQuantity, skipChildOwnedCredit);
            if (normalizedChild) children.push(normalizedChild);
        }

        return {
            ...node,
            quantity,
            ...(actionsForRemainder !== null ? { actionsNeeded: actionsForRemainder } : {}),
            ...(!isRoot && quantity > 0 ? { stepCount: quantity } : {}),
            ...(plannedDependencies.length > 0 ? { plannedDependencies } : {}),
            children,
        };
    }

    return normalize(plan, true);
}
