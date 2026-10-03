/**
 * `getActionDetailsByName` backs the Max button when a reused detail modal has moved on to another
 * action. The title the game draws is translated while the detail map is keyed in English, so on a
 * non-English client the modal's own props are what name the action.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: () => () => {}, register: () => () => {} },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getActionDetails: () => null,
        getItemDetails: () => null,
        getInventory: () => [],
        getInitClientData: () => ({ itemDetailMap: {} }),
        getActionDrinkSlots: () => [],
        getSkills: () => [],
        getEquipment: () => new Map(),
        getPersonalBuffFlatBoost: () => 0,
        isTaskAction: () => false,
        isBuffBeingSimulated: () => false,
        getCommunityBuffLevel: () => 0,
        characterData: {},
        on: () => () => {},
        off: () => {},
    },
}));

vi.mock('../../core/storage.js', () => ({
    default: { get: vi.fn(async () => false), set: vi.fn() },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => false,
        getSettingValue: (_key, fallback) => fallback,
        onSettingChange: () => () => {},
        onSettingsLoaded: () => () => {},
    },
}));

vi.mock('../combat/scroll-simulator.js', () => ({
    default: { getScrollSetForActionType: () => new Set() },
}));

const lookups = vi.hoisted(() => ({ fiberAction: null }));
vi.mock('../../utils/game-lookups.js', () => ({
    getActionHridFromName: (name) => (name === 'Cheese' ? '/actions/cheesesmithing/cheese' : null),
    getActionHridFromFiber: () => lookups.fiberAction,
}));

const quickInputButtons = (await import('./quick-input-buttons.js')).default;

const GAME_DATA = {
    actionDetailMap: {
        '/actions/cheesesmithing/cheese': { name: 'Cheese' },
        '/actions/milking/cow': { name: 'Cow' },
    },
};

beforeEach(() => {
    lookups.fiberAction = null;
});

describe('getActionDetailsByName', () => {
    test('an English title resolves by name, as before', () => {
        expect(quickInputButtons.getActionDetailsByName('Cheese', GAME_DATA)).toEqual({
            name: 'Cheese',
            hrid: '/actions/cheesesmithing/cheese',
        });
    });

    test('a translated title resolves through the modal props when a panel is given', () => {
        lookups.fiberAction = '/actions/milking/cow';
        const panel = document.createElement('div');

        const details = quickInputButtons.getActionDetailsByName('奶牛', GAME_DATA, panel);

        expect(details?.hrid).toBe('/actions/milking/cow');
    });

    test('a translated title with no panel to read props from resolves to nothing', () => {
        lookups.fiberAction = '/actions/milking/cow';

        expect(quickInputButtons.getActionDetailsByName('奶牛', GAME_DATA)).toBeNull();
    });
});
