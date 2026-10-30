import { describe, it, expect } from 'vitest';
import {
    buildRun,
    getCurrentStep,
    getOwnedCount,
    getRemainingQuantity,
    getScrollHrids,
    isStepFinished,
    normalizePlan,
    normalizeSteps,
    observeInventory,
} from './scroll-planner-logic.js';

const itemDetailMap = {
    '/items/seal_of_gathering': { categoryHrid: '/item_categories/scroll', isOpenable: true, sortIndex: 2 },
    '/items/seal_of_damage': { categoryHrid: '/item_categories/scroll', isOpenable: true, sortIndex: 1 },
    '/items/bishops_scroll': { categoryHrid: '/item_categories/resource', isOpenable: false, sortIndex: 3 },
};
const SCROLLS = ['/items/seal_of_damage', '/items/seal_of_gathering'];

const inv = (itemHrid, count, extra = {}) => ({
    itemHrid,
    count,
    itemLocationHrid: '/item_locations/inventory',
    enhancementLevel: 0,
    ...extra,
});

describe('getScrollHrids', () => {
    it('returns only openable scroll-category items in game order', () => {
        expect(getScrollHrids(itemDetailMap)).toEqual(SCROLLS);
    });
    it('handles missing data', () => {
        expect(getScrollHrids(null)).toEqual([]);
    });
});

describe('getOwnedCount', () => {
    it('sums unenhanced inventory stacks only', () => {
        const items = [
            inv('/items/seal_of_damage', 4),
            inv('/items/seal_of_damage', 9, { itemLocationHrid: '/item_locations/equipment' }),
            inv('/items/seal_of_damage', 2, { enhancementLevel: 1 }),
        ];
        expect(getOwnedCount(items, '/items/seal_of_damage')).toBe(4);
    });
    it('is zero without items', () => {
        expect(getOwnedCount(null, '/items/seal_of_damage')).toBe(0);
    });
});

describe('normalizePlan', () => {
    it('drops unknown items, non-positive and non-numeric quantities, and floors decimals', () => {
        expect(
            normalizePlan(
                { '/items/seal_of_damage': 3.9, '/items/seal_of_gathering': 0, '/items/nope': 5, x: 'a' },
                SCROLLS
            )
        ).toEqual({ '/items/seal_of_damage': 3 });
    });
    it('tolerates garbage', () => {
        expect(normalizePlan(null, SCROLLS)).toEqual({});
        expect(normalizePlan('x', SCROLLS)).toEqual({});
    });
});

describe('buildRun', () => {
    it('clamps to owned, records shortfalls and orders by game order', () => {
        const items = [inv('/items/seal_of_gathering', 10), inv('/items/seal_of_damage', 2)];
        const { steps, shortfalls } = buildRun(
            { '/items/seal_of_gathering': 4, '/items/seal_of_damage': 5 },
            SCROLLS,
            items
        );
        expect(steps.map((s) => [s.itemHrid, s.quantity, s.remaining, s.lastOwned])).toEqual([
            ['/items/seal_of_damage', 2, 2, 2],
            ['/items/seal_of_gathering', 4, 4, 10],
        ]);
        expect(shortfalls).toEqual([{ itemHrid: '/items/seal_of_damage', planned: 5, owned: 2 }]);
    });
    it('omits scrolls the character does not own', () => {
        const { steps, shortfalls } = buildRun({ '/items/seal_of_damage': 3 }, SCROLLS, []);
        expect(steps).toEqual([]);
        expect(shortfalls).toHaveLength(1);
    });
});

const DAMAGE = '/items/seal_of_damage';
const GATHERING = '/items/seal_of_gathering';

describe('run progress', () => {
    const items = [inv(DAMAGE, 5), inv(GATHERING, 5)];
    const { steps } = buildRun({ [DAMAGE]: 2, [GATHERING]: 3 }, SCROLLS, items);

    it('starts on the first step with the full quantity remaining', () => {
        const current = getCurrentStep(steps, items);
        expect(current.index).toBe(0);
        expect(getRemainingQuantity(current.step, items)).toBe(2);
    });
    it('finishes a step once its planned scrolls are opened', () => {
        const after = [inv(DAMAGE, 3), inv(GATHERING, 5)];
        const observed = observeInventory(steps, after);
        expect(observed.changed).toBe(true);
        expect(isStepFinished(observed.steps[0], after)).toBe(true);
        expect(getCurrentStep(observed.steps, after).index).toBe(1);
        // The input steps are not changed
        expect(steps[0].remaining).toBe(2);
    });
    it('partial opens still count down, across several updates and stacks', () => {
        const stacks = [inv(DAMAGE, 1), inv(DAMAGE, 2), inv(DAMAGE, 2), inv(GATHERING, 5)];
        let run = buildRun({ [DAMAGE]: 4 }, SCROLLS, stacks).steps;
        run = observeInventory(run, [inv(DAMAGE, 2), inv(DAMAGE, 2), inv(GATHERING, 5)]).steps;
        expect(getRemainingQuantity(run[0], [inv(DAMAGE, 4)])).toBe(3);
        run = observeInventory(run, [inv(DAMAGE, 2)]).steps;
        expect(run[0].remaining).toBe(1);
        expect(run[0].done).toBe(false);
    });
    it('a gain mid-step never raises the quantity past the plan', () => {
        // Plan 3 of 5: before the fix the target was 2, and gaining 4 made 7 to open
        let run = buildRun({ [DAMAGE]: 3 }, SCROLLS, [inv(DAMAGE, 5)]).steps;
        const gained = [inv(DAMAGE, 9)];
        run = observeInventory(run, gained).steps;
        expect(getRemainingQuantity(run[0], gained)).toBe(3);
        run = observeInventory(run, [inv(DAMAGE, 8)]).steps;
        expect(getRemainingQuantity(run[0], [inv(DAMAGE, 8)])).toBe(2);
    });
    it('a gain after a step is done does not bring it back', () => {
        let run = buildRun({ [DAMAGE]: 2, [GATHERING]: 3 }, SCROLLS, items).steps;
        run = observeInventory(run, [inv(DAMAGE, 3), inv(GATHERING, 5)]).steps;
        const regained = [inv(DAMAGE, 20), inv(GATHERING, 5)];
        run = observeInventory(run, regained).steps;
        expect(run[0].done).toBe(true);
        expect(getCurrentStep(run, regained).index).toBe(1);
    });
    it('opening the last scroll of a step finishes it even at zero owned', () => {
        let run = buildRun({ [DAMAGE]: 5 }, SCROLLS, [inv(DAMAGE, 2)]).steps;
        run = observeInventory(run, []).steps;
        expect(run[0].done).toBe(true);
        expect(getCurrentStep(run, [inv(DAMAGE, 4)])).toBeNull();
    });
    it('a later step does not count scrolls opened before it is current', () => {
        let run = buildRun({ [DAMAGE]: 2, [GATHERING]: 3 }, SCROLLS, items).steps;
        run = observeInventory(run, [inv(DAMAGE, 5), inv(GATHERING, 4)]).steps;
        expect(run[1].remaining).toBe(3);
        expect(run[1].lastOwned).toBe(4);
    });
    it('treats a skipped step as finished and returns null when all are done', () => {
        const skipped = steps.map((s) => ({ ...s, skipped: true }));
        expect(getCurrentStep(skipped, items)).toBeNull();
    });
});

describe('normalizeSteps', () => {
    it('reads an old targetCount record without adding scrolls gained since', () => {
        // Planned 3 of 5 (target 2); now 9 owned: the old formula said 7
        const old = [{ itemHrid: DAMAGE, quantity: 3, planned: 3, targetCount: 2, skipped: false }];
        const [step] = normalizeSteps(old, [inv(DAMAGE, 9)]);
        expect(step.remaining).toBe(3);
        expect(step.lastOwned).toBe(9);
    });
    it('reads an old record part-way through', () => {
        const old = [{ itemHrid: DAMAGE, quantity: 3, planned: 3, targetCount: 2, skipped: false }];
        expect(normalizeSteps(old, [inv(DAMAGE, 3)])[0].remaining).toBe(1);
        expect(normalizeSteps(old, [inv(DAMAGE, 2)])[0].done).toBe(true);
    });
    it('keeps a current record as saved, and refuses garbage', () => {
        const saved = [{ itemHrid: DAMAGE, quantity: 3, planned: 4, remaining: 2, lastOwned: 4, done: false }];
        expect(normalizeSteps(saved, [inv(DAMAGE, 7)])[0]).toMatchObject({ remaining: 2, lastOwned: 4 });
        expect(normalizeSteps('x', [])).toBeNull();
        expect(normalizeSteps([null], [])).toBeNull();
    });
});
