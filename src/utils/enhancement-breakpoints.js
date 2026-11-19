/**
 * Enhancement breakpoints: the levels players usually stop at, by kind of item.
 *
 * One copy for every surface that offers "the usual levels": the upgrade advisor, the skilling optimizer and
 * Craft & Enhance's best-level column.
 */

/** Enhancement breakpoints by slot type */
export const BREAKPOINTS_DEFAULT = Object.freeze([7, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
export const BREAKPOINTS_JEWELRY = Object.freeze([5, 7, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
export const BREAKPOINTS_BACK = Object.freeze([3, 5, 7, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
export const BREAKPOINTS_REFINED = Object.freeze([10, 12, 13, 14, 15, 16, 17, 18, 19, 20]);

/** The equipment types that are jewelry */
export const JEWELRY_EQUIPMENT_TYPES = new Set([
    '/equipment_types/earrings',
    '/equipment_types/ring',
    '/equipment_types/neck',
]);

/**
 * The breakpoint list for an item.
 *
 * Refined (star) items, jewelry and back-slot items each have their own list. The advisor checks the back slot
 * before the refined name and the optimizer after it; `backFirst` keeps each caller's own order.
 *
 * @param {string} itemHrid - The item
 * @param {Object} [kind] - What the caller knows about the slot
 * @param {boolean} [kind.isBack] - A back-slot item
 * @param {boolean} [kind.isJewelry] - An earrings, ring or neck item
 * @param {boolean} [kind.backFirst=false] - Pick the back list before the refined one
 * @returns {readonly number[]}
 */
export function breakpointsFor(itemHrid, { isBack = false, isJewelry = false, backFirst = false } = {}) {
    const refined = String(itemHrid || '').includes('_refined');
    if (backFirst && isBack) return BREAKPOINTS_BACK;
    if (refined) return BREAKPOINTS_REFINED;
    if (isJewelry) return BREAKPOINTS_JEWELRY;
    if (isBack) return BREAKPOINTS_BACK;
    return BREAKPOINTS_DEFAULT;
}
