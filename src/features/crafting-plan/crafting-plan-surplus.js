import { artisanInputTotal, getArtisanMaterialMode } from '../../utils/artisan-material-mode.js';

/**
 * Reconcile repeated plan branches against output surplus from earlier craft
 * actions, without counting the player's inventory. Buy quantities reflect
 * material made by the plan, and child actions are sized to remaining work.
 *
 * @param {Object} plan - A node from the crafting plan calculator
 * @returns {Object} A shallowly rebuilt plan tree with shared production applied
 */
export function normalizePlannedSurplus(plan) {
    const stock = new Map();
    const artisanMode = getArtisanMaterialMode();

    function normalize(node, isRoot = false, quantityOverride) {
        if (!node) return null;
        const quantity = quantityOverride !== undefined ? quantityOverride : node.quantity;

        if (node.strategy === 'buy') {
            if (node.itemHrid === '/items/coin' || !(quantity > 0)) return { ...node, quantity, children: [] };
            const held = stock.get(node.itemHrid) || 0;
            const used = Math.min(held, quantity);
            if (used > 0) stock.set(node.itemHrid, held - used);
            const remaining = quantity - used;
            return {
                ...node,
                quantity: remaining,
                totalCost: Number.isFinite(node.unitCost) ? node.unitCost * remaining : node.totalCost,
                children: [],
            };
        }

        let remaining = quantity;
        let actionsForRemainder = null;
        if (!isRoot && quantity > 0) {
            const held = stock.get(node.itemHrid) || 0;
            const used = Math.min(held, quantity);
            if (used > 0) stock.set(node.itemHrid, held - used);
            remaining = quantity - used;
            if (!(remaining > 0)) {
                return { ...node, quantity, actionsNeeded: 0, stepCount: quantity, children: [] };
            }

            if (node.outputCount > 0) {
                actionsForRemainder = Math.ceil(remaining / node.outputCount);
                const surplus = actionsForRemainder * node.outputCount - remaining;
                if (surplus > 0) stock.set(node.itemHrid, (stock.get(node.itemHrid) || 0) + surplus);
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

            const normalizedChild = normalize(child, false, childQuantity);
            if (normalizedChild) children.push(normalizedChild);
        }

        return {
            ...node,
            quantity,
            ...(actionsForRemainder !== null ? { actionsNeeded: actionsForRemainder } : {}),
            ...(!isRoot && quantity > 0 ? { stepCount: quantity } : {}),
            children,
        };
    }

    return normalize(plan, true);
}
