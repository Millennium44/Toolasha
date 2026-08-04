/** @vitest-environment happy-dom */
/**
 * Tests for Item Navigation Utilities
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ gameData: null, itemDetails: {} }));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => state.gameData,
        getItemDetails: (hrid) => state.itemDetails[hrid] || null,
    },
}));

const { findActionForItem, openItemDictionary, navigateToItem } = await import('./item-navigation.js');

function setGameRoot(gameStateNode) {
    const root = document.createElement('div');
    root.id = 'root';
    root._reactRootContainer = { current: { stateNode: gameStateNode, child: null, sibling: null } };
    document.body.appendChild(root);
    return root;
}

describe('findActionForItem', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
    });

    test('returns null without game data', () => {
        state.gameData = null;
        expect(findActionForItem('/items/plank')).toBeNull();
    });

    test('prioritizes a production action over a gathering action', () => {
        state.gameData = {
            actionDetailMap: {
                '/actions/woodcutting/log': {
                    dropTable: [{ itemHrid: '/items/plank' }],
                },
                '/actions/crafting/plank': {
                    outputItems: [{ itemHrid: '/items/plank' }],
                },
            },
        };
        const result = findActionForItem('/items/plank');
        expect(result).toEqual({ actionHrid: '/actions/crafting/plank', type: 'production' });
    });

    test('falls back to a gathering action when no production action exists', () => {
        state.gameData = {
            actionDetailMap: {
                '/actions/woodcutting/log': { dropTable: [{ itemHrid: '/items/log' }] },
            },
        };
        const result = findActionForItem('/items/log');
        expect(result).toEqual({ actionHrid: '/actions/woodcutting/log', type: 'gathering' });
    });

    test('returns null when no action produces or drops the item', () => {
        state.gameData = { actionDetailMap: {} };
        expect(findActionForItem('/items/nonexistent')).toBeNull();
    });

    test('prefers the action whose slug matches the item slug among multiple production matches', () => {
        state.gameData = {
            actionDetailMap: {
                '/actions/crafting/other_bar': { outputItems: [{ itemHrid: '/items/bar' }] },
                '/actions/crafting/bar': { outputItems: [{ itemHrid: '/items/bar' }] },
            },
        };
        const result = findActionForItem('/items/bar');
        expect(result.actionHrid).toBe('/actions/crafting/bar');
    });
});

describe('openItemDictionary', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        state.itemDetails = {};
    });

    test('returns false when no game object is found', () => {
        expect(openItemDictionary('/items/plank')).toBe(false);
    });

    test('returns false when the item HRID is invalid', () => {
        setGameRoot({ handleGoToMarketplace: () => {}, handleOpenItemDictionary: vi.fn() });
        expect(openItemDictionary('/items/unknown')).toBe(false);
    });

    test('calls handleOpenItemDictionary and returns true for a valid item', () => {
        const handle = vi.fn();
        setGameRoot({ handleGoToMarketplace: () => {}, handleOpenItemDictionary: handle });
        state.itemDetails['/items/plank'] = { name: 'Plank' };

        expect(openItemDictionary('/items/plank')).toBe(true);
        expect(handle).toHaveBeenCalledWith('/items/plank');
    });
});

describe('navigateToItem', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        state.itemDetails = {};
    });

    test('returns false when no game object is found', () => {
        state.gameData = { actionDetailMap: {} };
        expect(navigateToItem('/items/plank')).toBe(false);
    });

    test('navigates to the producing action when one exists', () => {
        state.gameData = {
            actionDetailMap: {
                '/actions/crafting/plank': { outputItems: [{ itemHrid: '/items/plank' }] },
            },
        };
        const handleGoToAction = vi.fn();
        setGameRoot({ handleGoToAction, handleGoToMarketplace: () => {} });

        expect(navigateToItem('/items/plank')).toBe(true);
        expect(handleGoToAction).toHaveBeenCalledWith('/actions/crafting/plank');
    });

    test('falls back to item dictionary when no action produces the item', () => {
        state.gameData = { actionDetailMap: {} };
        state.itemDetails['/items/relic'] = { name: 'Relic' };
        const handleOpenItemDictionary = vi.fn();
        setGameRoot({ handleOpenItemDictionary, handleGoToMarketplace: () => {} });

        expect(navigateToItem('/items/relic')).toBe(true);
        expect(handleOpenItemDictionary).toHaveBeenCalledWith('/items/relic');
    });

    test('returns false when falling back to dictionary for an item with no details', () => {
        state.gameData = { actionDetailMap: {} };
        setGameRoot({ handleOpenItemDictionary: vi.fn(), handleGoToMarketplace: () => {} });

        expect(navigateToItem('/items/unknown')).toBe(false);
    });
});
