import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    setting: true,
    characterData: null,
    combined: null,
    equipment: [],
    guildBuffMap: {},
    wsHandlers: {},
    rows: {},
    scoreResult: { total: 42 },
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => game.setting },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (event, handler) => {
            game.wsHandlers[event] = handler;
        },
        off: (event, handler) => {
            if (game.wsHandlers[event] === handler) delete game.wsHandlers[event];
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterData() {
            return game.characterData;
        },
        get characterGuildBuffMap() {
            return game.guildBuffMap;
        },
        getCombinedData: () => game.combined,
        getEquipment: () => game.equipment,
    },
}));
vi.mock('../../utils/overlay-rows.js', () => ({
    registerRow: (definition) => {
        game.rows[definition.key] = definition;
    },
}));
vi.mock('./score-calculator.js', () => ({
    calculateCombatScore: async () => game.scoreResult,
}));

const { ownProfileData } = await import('./build-score-row.js');
const buildScore = (await import('./build-score-row.js')).default;

describe('ownProfileData', () => {
    beforeEach(() => {
        game.characterData = null;
        game.combined = null;
        game.equipment = [];
        game.guildBuffMap = {};
    });

    test('null before the character has loaded', () => {
        expect(ownProfileData()).toBeNull();
    });

    test('null when combined data is not yet available', () => {
        game.characterData = { characterAbilities: [], combatUnit: { combatAbilities: [] } };
        game.combined = null;

        expect(ownProfileData()).toBeNull();
    });

    test('assembles equipment, abilities, and house rooms into a profile_shared shape', () => {
        game.characterData = {
            characterAbilities: [{ abilityHrid: '/abilities/fireball', level: 5 }],
            combatUnit: { combatAbilities: [{ abilityHrid: '/abilities/fireball' }] },
        };
        game.combined = { characterHouseRoomMap: { '/house_rooms/brewery': { level: 3 } } };
        game.equipment = [
            ['/item_locations/head', { itemHrid: '/items/helmet', enhancementLevel: 5 }],
            ['/item_locations/feet', null],
        ];
        game.guildBuffMap = { '/guild_buffs/force': { level: 2 } };

        const profile = ownProfileData();

        expect(profile.profile.wearableItemMap).toEqual({
            '/item_locations/head': {
                itemLocationHrid: '/item_locations/head',
                itemHrid: '/items/helmet',
                enhancementLevel: 5,
            },
        });
        expect(profile.profile.equippedAbilities).toEqual([{ abilityHrid: '/abilities/fireball', level: 5 }]);
        expect(profile.profile.characterHouseRoomMap).toEqual({ '/house_rooms/brewery': { level: 3 } });
        expect(profile.profile.characterGuildBuffMap).toEqual({ '/guild_buffs/force': { level: 2 } });
        expect(profile.profile.hideWearableItems).toBe(false);
    });

    test('an unenhanced item defaults enhancementLevel to 0', () => {
        game.characterData = { characterAbilities: [], combatUnit: { combatAbilities: [] } };
        game.combined = { characterHouseRoomMap: {} };
        game.equipment = [['/item_locations/head', { itemHrid: '/items/helmet' }]];

        expect(ownProfileData().profile.wearableItemMap['/item_locations/head'].enhancementLevel).toBe(0);
    });

    test('an equipped ability with no matching characterAbilities entry falls back to its own level, then 1', () => {
        game.characterData = {
            characterAbilities: [],
            combatUnit: { combatAbilities: [{ abilityHrid: '/abilities/ice_spike', level: 7 }] },
        };
        game.combined = { characterHouseRoomMap: {} };

        expect(ownProfileData().profile.equippedAbilities).toEqual([{ abilityHrid: '/abilities/ice_spike', level: 7 }]);

        game.characterData.combatUnit.combatAbilities = [{ abilityHrid: '/abilities/ice_spike' }];
        expect(ownProfileData().profile.equippedAbilities).toEqual([{ abilityHrid: '/abilities/ice_spike', level: 1 }]);
    });
});

describe('BuildScore', () => {
    beforeEach(() => {
        game.setting = true;
        game.characterData = { characterAbilities: [], combatUnit: { combatAbilities: [] } };
        game.combined = { characterHouseRoomMap: {} };
        game.equipment = [];
        game.guildBuffMap = {};
        game.wsHandlers = {};
        game.scoreResult = { total: 42 };
        buildScore.disable();
        buildScore.score = null;
        buildScore.computedAt = 0;
        buildScore.running = false;
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('disabled by setting, ensureWatching does not subscribe', () => {
        game.setting = false;
        buildScore.ensureWatching();

        expect(game.wsHandlers.items_updated).toBeUndefined();
    });

    test('ensureWatching computes an initial score', async () => {
        buildScore.ensureWatching();
        await vi.runAllTimersAsync();

        expect(buildScore.score).toEqual({ total: 42 });
    });

    test('a second ensureWatching call does not re-subscribe', () => {
        buildScore.ensureWatching();
        const handler = game.wsHandlers.items_updated;
        buildScore.ensureWatching();

        expect(game.wsHandlers.items_updated).toBe(handler);
    });

    test('a burst of change events is debounced into a single recompute', async () => {
        buildScore.ensureWatching();
        await vi.runAllTimersAsync();
        buildScore.computedAt = 0; // allow another refresh

        game.scoreResult = { total: 99 };

        game.wsHandlers.items_updated();
        game.wsHandlers.house_rooms_updated();
        game.wsHandlers.items_updated();

        await vi.advanceTimersByTimeAsync(3000);

        expect(buildScore.score).toEqual({ total: 99 });
    });

    test('a fresh score within the minimum interval is not recomputed', async () => {
        buildScore.ensureWatching();
        await vi.runAllTimersAsync();

        game.scoreResult = { total: 999 };
        await buildScore.refresh();

        expect(buildScore.score).toEqual({ total: 42 });
    });

    test('a zero-total result does not overwrite a previously good score', async () => {
        buildScore.ensureWatching();
        await vi.runAllTimersAsync();
        buildScore.computedAt = 0;

        game.scoreResult = { total: 0 };
        await buildScore.refresh();

        expect(buildScore.score).toEqual({ total: 42 });
    });

    test('disable clears the score and stops listening', () => {
        buildScore.ensureWatching();
        buildScore.score = { total: 42 };

        buildScore.disable();

        expect(buildScore.score).toBeNull();
        expect(buildScore.watching).toBe(false);
        expect(game.wsHandlers.items_updated).toBeUndefined();
    });

    test('refresh is a no-op with no assembled profile (character not loaded)', async () => {
        game.characterData = null;
        await buildScore.refresh();

        expect(buildScore.score).toBeNull();
    });
});
