/**
 * Tests for the shared outputItem → actions index.
 *
 * The contract worth pinning is the one four features used to satisfy by hand:
 * actions come back in map order, an item appearing as a secondary output is
 * found unless the caller asks for primary producers only, and the index is
 * rebuilt exactly when the action map it was built from is replaced.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ gameData: null }));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => state.gameData,
    },
}));

const { getProductionIndex, findProducingActions, findProducingAction, _resetProductionIndex } =
    await import('./production-index.js');

const actions = () => ({
    '/actions/milking/cow': { outputItems: [{ itemHrid: '/items/milk', count: 1 }] },
    '/actions/cheesesmithing/cheese': {
        inputItems: [{ itemHrid: '/items/milk', count: 2 }],
        outputItems: [{ itemHrid: '/items/cheese', count: 1 }],
    },
    '/actions/cheesesmithing/fancy_cheese': {
        outputItems: [
            { itemHrid: '/items/fancy_cheese', count: 1 },
            { itemHrid: '/items/cheese', count: 3 },
        ],
    },
    '/actions/combat/idle': {},
});

beforeEach(() => {
    _resetProductionIndex();
    state.gameData = { actionDetailMap: actions() };
});

describe('findProducingActions', () => {
    test('returns nothing without game data', () => {
        state.gameData = null;
        expect(getProductionIndex()).toBeNull();
        expect(findProducingActions('/items/milk')).toEqual([]);
        expect(findProducingAction('/items/milk')).toBeNull();
    });

    test('lists every producer in map order, with the matching output', () => {
        const producers = findProducingActions('/items/cheese');
        expect(producers.map((p) => p.actionHrid)).toEqual([
            '/actions/cheesesmithing/cheese',
            '/actions/cheesesmithing/fancy_cheese',
        ]);
        expect(producers[1].output).toEqual({ itemHrid: '/items/cheese', count: 3 });
        expect(producers[0].action).toBe(state.gameData.actionDetailMap['/actions/cheesesmithing/cheese']);
    });

    test('primaryOnly keeps only actions whose first output is the item', () => {
        const producers = findProducingActions('/items/cheese', { primaryOnly: true });
        expect(producers.map((p) => p.actionHrid)).toEqual(['/actions/cheesesmithing/cheese']);
        expect(findProducingAction('/items/fancy_cheese', { primaryOnly: true }).actionHrid).toBe(
            '/actions/cheesesmithing/fancy_cheese'
        );
    });

    test('an item nothing makes is an empty list', () => {
        expect(findProducingActions('/items/coin')).toEqual([]);
        expect(findProducingAction('/items/coin')).toBeNull();
    });

    test('findProducingAction is the first producer in map order', () => {
        expect(findProducingAction('/items/cheese').actionHrid).toBe('/actions/cheesesmithing/cheese');
    });

    test('an explicit action map is indexed instead of the live one', () => {
        const other = { '/actions/alt/milk': { outputItems: [{ itemHrid: '/items/milk', count: 5 }] } };
        expect(findProducingAction('/items/milk', { actionDetailMap: other }).actionHrid).toBe('/actions/alt/milk');
        expect(findProducingAction('/items/milk').actionHrid).toBe('/actions/milking/cow');
    });
});

describe('caching', () => {
    test('the same action map is indexed once', () => {
        const first = getProductionIndex();
        expect(getProductionIndex()).toBe(first);
        expect(findProducingAction('/items/milk').actionHrid).toBe('/actions/milking/cow');
        expect(getProductionIndex()).toBe(first);
    });

    test('a replaced action map rebuilds the index', () => {
        const first = getProductionIndex();
        state.gameData = {
            actionDetailMap: { '/actions/new/milk': { outputItems: [{ itemHrid: '/items/milk', count: 1 }] } },
        };
        expect(getProductionIndex()).not.toBe(first);
        expect(findProducingAction('/items/milk').actionHrid).toBe('/actions/new/milk');
        expect(findProducingAction('/items/cheese')).toBeNull();
    });

    test('reads the action at lookup time, so edits to an indexed action are seen', () => {
        findProducingAction('/items/cheese');
        state.gameData.actionDetailMap['/actions/cheesesmithing/cheese'].inputItems = [
            { itemHrid: '/items/truffle', count: 1 },
        ];
        expect(findProducingAction('/items/cheese').action.inputItems[0].itemHrid).toBe('/items/truffle');
    });
});
