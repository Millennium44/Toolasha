import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    setting: true,
    characterData: null,
    combined: null,
    equipment: [],
    guildBuffMap: {},
    wsHandlers: {},
    dmHandlers: {},
    rows: {},
    scoreResult: { total: 42 },
    toggles: 0,
    scoreSource: null,
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
        on: (event, handler) => {
            game.dmHandlers[event] = handler;
        },
        off: (event, handler) => {
            if (game.dmHandlers[event] === handler) delete game.dmHandlers[event];
        },
    },
}));
vi.mock('../../utils/overlay-rows.js', () => ({
    registerRow: (definition) => {
        game.rows[definition.key] = definition;
    },
}));
vi.mock('./score-calculator.js', () => ({
    calculateCombatScore: async () => {
        if (game.scoreGate) await game.scoreGate;
        return game.scoreResult;
    },
}));
vi.mock('./build-score-panel.js', () => ({
    buildScorePanel: {
        toggle: () => {
            game.toggles += 1;
        },
    },
    setScoreSource: (source) => {
        game.scoreSource = source;
    },
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

    test('character_switching clears the score, since this module lives outside the feature registry', async () => {
        // build-score-row.js has no initialize()/cleanup() in feature-registry.js
        // — it starts lazily from the overlay row's render — so nothing but a
        // direct dataManager listener can catch a character switch. Without it,
        // MIN_INTERVAL_MS and "ensureWatching is a no-op once watching" together
        // meant the departing character's score kept showing under the arriving
        // character's name until their own equipment or house changed, not just
        // for a redraw or two.
        buildScore.ensureWatching();
        await vi.runAllTimersAsync();
        expect(buildScore.score).toEqual({ total: 42 });

        game.dmHandlers.character_switching();

        expect(buildScore.score).toBeNull();
        expect(buildScore.watching).toBe(false);
    });

    test('a refresh in flight when the character switches must not repopulate the departed score', async () => {
        // calculateCombatScore prices every worn item and can simulate enhancement
        // chains — slow enough that a character switch can land while it is still
        // running. character_switching clears the score and detaches the
        // listeners synchronously; the profile snapshot the gated call closed over
        // still describes the departing character, and its `finally` still runs.
        let releaseGate;
        game.scoreGate = new Promise((resolve) => {
            releaseGate = resolve;
        });
        game.scoreResult = { total: 42 };

        buildScore.ensureWatching();
        // Let the microtask queue advance to the gated await inside refresh().
        await Promise.resolve();
        await Promise.resolve();

        game.dmHandlers.character_switching();
        expect(buildScore.score).toBeNull();

        releaseGate();
        await vi.runAllTimersAsync();

        expect(buildScore.score).toBeNull();

        game.scoreGate = null;
    });
});

describe('the tile and the panel behind it', () => {
    beforeEach(() => {
        game.setting = true;
        game.characterData = { characterAbilities: [], combatUnit: { combatAbilities: [] } };
        game.combined = { characterHouseRoomMap: {} };
        game.wsHandlers = {};
        game.toggles = 0;
        buildScore.disable();
        buildScore.score = null;
        buildScore.computedAt = 0;
    });

    test('double-clicking the tile toggles the breakdown panel', () => {
        game.rows.buildScore.onOpen();

        expect(game.toggles).toBe(1);
    });

    test('the panel is given a way to read the same figure the tile shows', () => {
        buildScore.score = { total: 42 };

        expect(typeof game.scoreSource).toBe('function');
        expect(game.scoreSource()).toEqual({ total: 42 });
    });

    test('asking for the score is what starts the watcher, so opening the panel first still works', () => {
        expect(game.wsHandlers.items_updated).toBeUndefined();

        game.scoreSource();

        expect(game.wsHandlers.items_updated).toBeDefined();
    });
});

/**
 * The Build Score tile's `version()`.
 *
 * The score is recomputed on the game's own item and house messages, debounced,
 * and left on `buildScore.score` — so between those messages the tile was
 * rebuilding an identical line sixty times a minute. The version is a transcript
 * of that object at the one decimal the tile draws.
 */
describe('the Build Score tile summarises its own inputs', () => {
    const version = () => game.rows.buildScore.version();

    test('no score yet is one settled version', () => {
        buildScore.score = null;
        expect(version()).toBe('blank');
        expect(version()).toBe(version());
    });

    test('it holds still while the score does', () => {
        buildScore.score = { total: 42.5, equipment: 20, ability: 10, house: 5, skillerTotal: 7.5 };
        expect(version()).toBe(version());
    });

    test('the total moving moves it', () => {
        buildScore.score = { total: 42.5, equipment: 20, ability: 10, house: 5, skillerTotal: 7.5 };
        const before = version();

        buildScore.score = { total: 43.5, equipment: 21, ability: 10, house: 5, skillerTotal: 7.5 };
        expect(version()).not.toBe(before);
    });

    test('and so does a component that only shows in the tooltip', () => {
        // The tooltip is part of the tile: a version keyed on the total alone
        // would leave the breakdown behind whenever two components traded places
        buildScore.score = { total: 42.5, equipment: 20, ability: 10, house: 5, skillerTotal: 7.5 };
        const before = version();

        buildScore.score = { total: 42.5, equipment: 15, ability: 15, house: 5, skillerTotal: 7.5 };
        expect(version()).not.toBe(before);
    });
});
