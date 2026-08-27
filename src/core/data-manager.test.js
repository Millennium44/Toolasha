/**
 * Tests for DataManager event forwarding
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

let webSocketHandlers = new Map();

vi.mock('./websocket.js', () => {
    webSocketHandlers = new Map();

    return {
        default: {
            on: vi.fn((event, handler) => {
                webSocketHandlers.set(event, handler);
            }),
            off: vi.fn((event, handler) => {
                if (webSocketHandlers.get(event) === handler) {
                    webSocketHandlers.delete(event);
                }
            }),
            onSocketEvent: vi.fn(),
            offSocketEvent: vi.fn(),
        },
    };
});

const storageMock = vi.hoisted(() => ({
    data: new Map(),
    getJSON: null,
    setJSON: null,
    get: null,
    set: null,
    flushAll: null,
}));

/** Namespaced key so the plain and JSON stores in the mock cannot collide */
const storeKey = (storeName, key) => `${storeName}::${key}`;

vi.mock('./storage.js', () => ({
    default: {
        getJSON: (key, storeName, fallback) => storageMock.getJSON(key, storeName, fallback),
        setJSON: (key, value, storeName) => storageMock.setJSON(key, value, storeName),
        get: (key, storeName, fallback) => storageMock.get(key, storeName, fallback),
        set: (key, value, storeName) => storageMock.set(key, value, storeName),
        flushAll: () => storageMock.flushAll(),
    },
}));

beforeEach(() => {
    storageMock.data = new Map();
    storageMock.getJSON = vi.fn(async (key, _storeName, fallback) =>
        storageMock.data.has(key) ? storageMock.data.get(key) : fallback
    );
    storageMock.setJSON = vi.fn(async (key, value) => {
        storageMock.data.set(key, value);
        return true;
    });
    storageMock.get = vi.fn(async (key, storeName = 'settings', fallback = null) => {
        const k = storeKey(storeName, key);
        return storageMock.data.has(k) ? storageMock.data.get(k) : fallback;
    });
    storageMock.set = vi.fn(async (key, value, storeName = 'settings') => {
        storageMock.data.set(storeKey(storeName, key), value);
        return true;
    });
    storageMock.flushAll = vi.fn(async () => {});
});

/** A minimal init_character_data payload. */
const initPayload = (overrides = {}) => ({
    character: { id: 'char-1', name: 'Tester' },
    characterSkills: [],
    characterItems: [],
    characterActions: [],
    characterQuests: [],
    ...overrides,
});

/**
 * Put the singleton back to a first-login state so a test is not reading
 * whatever the previous one left behind.
 * @param {Object} dataManager - The singleton
 */
function resetCharacter(dataManager) {
    dataManager.currentCharacterId = null;
    dataManager.currentCharacterName = null;
    dataManager.characterData = null;
    dataManager.characterGuildBuffMap = {};
    dataManager.guildBuildingLevelMap = {};
    dataManager.guildShrineCapturedAt = null;
    dataManager.guildShrineHydrated = false;
    dataManager.guildShrineHydration = null;
    dataManager.guildShrineGuildId = null;
}

describe('DataManager', () => {
    test('forwards market item order book updates', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        const listener = vi.fn();
        const payload = {
            marketItemOrderBooks: {
                itemHrid: '/items/gourmet_tea',
            },
        };

        dataManager.on('market_item_order_books_updated', listener);

        const handler = webSocketHandlers.get('market_item_order_books_updated');
        expect(typeof handler).toBe('function');

        handler(payload);

        // Wait for deferred emit (setTimeout in emit())
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(listener).toHaveBeenCalledWith(payload);
    });

    test('community_buffs_updated refreshes the levels getCommunityBuffLevel reads', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        dataManager.characterData = {
            communityBuffs: [{ hrid: '/community_buff_types/experience', level: 3 }],
        };

        const handler = webSocketHandlers.get('community_buffs_updated');
        expect(typeof handler).toBe('function');

        handler({ communityBuffs: [{ hrid: '/community_buff_types/experience', level: 4 }] });

        expect(dataManager.getCommunityBuffLevel('/community_buff_types/experience')).toBe(4);
    });

    test('merges market listings updates and emits updated list', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        const listener = vi.fn();
        const payload = {
            endMarketListings: [
                { id: 2, price: 250, isSell: true },
                { id: 3, price: 300, isSell: false },
            ],
        };

        dataManager.characterData = {
            myMarketListings: [
                { id: 1, price: 100, isSell: true },
                { id: 2, price: 200, isSell: true },
            ],
        };

        dataManager.on('market_listings_updated', listener);

        const handler = webSocketHandlers.get('market_listings_updated');
        expect(typeof handler).toBe('function');

        handler(payload);

        // Wait for deferred emit (setTimeout in emit())
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(dataManager.getMarketListings()).toEqual([
            { id: 1, price: 100, isSell: true },
            { id: 2, price: 250, isSell: true },
            { id: 3, price: 300, isSell: false },
        ]);
        expect(listener).toHaveBeenCalledWith({
            ...payload,
            myMarketListings: [
                { id: 1, price: 100, isSell: true },
                { id: 2, price: 250, isSell: true },
                { id: 3, price: 300, isSell: false },
            ],
        });
    });
});

/**
 * The desync the labyrinth produces.
 *
 * The lab equips a loadout per room and restores on exit. Equipment tracked
 * those swaps because `items_updated` was handled; abilities did not, because
 * nothing applied `abilities_updated` at all — so the equipped kit stayed frozen
 * at whatever login reported and the combat sim simulated a kit the character
 * had not been wearing for hours.
 *
 * These replay the message sequence rather than testing the reconciler, which
 * has its own tests: what is being checked here is that the handlers are wired
 * and that the view the sim reads is the view the messages update.
 */
describe('equipped abilities through a labyrinth run', () => {
    /**
     * Log in with a kit.
     * @param {Object} dataManager - The singleton
     * @param {Array<Object>} combatAbilities - Equipped abilities at login
     */
    async function login(dataManager, combatAbilities) {
        resetCharacter(dataManager);
        // The handler queues its body behind a promise chain, so two inits cannot
        // interleave mid-teardown; awaiting it is what makes the state visible here
        return webSocketHandlers.get('init_character_data')(
            initPayload({
                characterAbilities: combatAbilities.map((a) => ({ ...a, experience: 0 })),
                combatUnit: { combatAbilities },
            })
        );
    }

    const NORMAL = [
        { abilityHrid: '/abilities/aura', slotNumber: 1, level: 10 },
        { abilityHrid: '/abilities/cleave', slotNumber: 2, level: 10 },
        { abilityHrid: '/abilities/toughness', slotNumber: 3, level: 10 },
    ];

    test('a lab loadout replaces the kit and leaving restores it', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        await login(dataManager, NORMAL);

        expect(dataManager.getEquippedAbilities().map((a) => a.abilityHrid)).toEqual([
            '/abilities/aura',
            '/abilities/cleave',
            '/abilities/toughness',
        ]);

        // Entering the labyrinth: the room loadout swaps two of the three slots.
        // The server reports the ability that left with slotNumber 0.
        webSocketHandlers.get('abilities_updated')({
            endCharacterAbilities: [
                { abilityHrid: '/abilities/cleave', slotNumber: 0 },
                { abilityHrid: '/abilities/toughness', slotNumber: 0 },
                { abilityHrid: '/abilities/fireball', slotNumber: 2, level: 8 },
                { abilityHrid: '/abilities/frost_surge', slotNumber: 3, level: 8 },
            ],
        });

        expect(dataManager.getEquippedAbilities().map((a) => a.abilityHrid)).toEqual([
            '/abilities/aura',
            '/abilities/fireball',
            '/abilities/frost_surge',
        ]);

        // Leaving the labyrinth: the normal loadout comes back
        webSocketHandlers.get('abilities_updated')({
            endCharacterAbilities: [
                { abilityHrid: '/abilities/fireball', slotNumber: 0 },
                { abilityHrid: '/abilities/frost_surge', slotNumber: 0 },
                { abilityHrid: '/abilities/cleave', slotNumber: 2, level: 10 },
                { abilityHrid: '/abilities/toughness', slotNumber: 3, level: 10 },
            ],
        });

        expect(dataManager.getEquippedAbilities().map((a) => a.abilityHrid)).toEqual([
            '/abilities/aura',
            '/abilities/cleave',
            '/abilities/toughness',
        ]);
        // And the lab abilities are gone, not merely reordered behind them
        expect(dataManager.getEquippedAbilities()).toHaveLength(3);
    });

    test('the raw characterData field the sim reads is the one that moved', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        await login(dataManager, NORMAL);

        webSocketHandlers.get('abilities_updated')({
            endCharacterAbilities: [{ abilityHrid: '/abilities/cleave', slotNumber: 0 }],
        });

        expect(dataManager.characterData.combatUnit.combatAbilities.map((a) => a.abilityHrid)).toEqual([
            '/abilities/aura',
            '/abilities/toughness',
        ]);
    });

    test('a battle settles the kit even when no update message was understood', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        await login(dataManager, NORMAL);

        webSocketHandlers.get('new_battle')({
            players: [
                {
                    character: { id: 'char-1', name: 'Tester' },
                    combatDetails: {
                        combatAbilities: [
                            { abilityHrid: '/abilities/aura', slotNumber: 1, level: 10 },
                            { abilityHrid: '/abilities/smack', slotNumber: 2, level: 3 },
                        ],
                    },
                },
                {
                    character: { id: 'char-9', name: 'Somebody Else' },
                    combatDetails: { combatAbilities: [{ abilityHrid: '/abilities/impale', slotNumber: 1 }] },
                },
            ],
        });

        expect(dataManager.getEquippedAbilities().map((a) => a.abilityHrid)).toEqual([
            '/abilities/aura',
            '/abilities/smack',
        ]);
    });

    test('experience ticks raise a level without disturbing the kit', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        await login(dataManager, NORMAL);

        webSocketHandlers.get('action_completed')({
            endCharacterAction: { id: 1, isDone: true },
            endCharacterAbilities: [{ abilityHrid: '/abilities/cleave', level: 11, experience: 5000 }],
        });

        expect(dataManager.getEquippedAbilities()).toHaveLength(3);
        expect(dataManager.getEquippedAbilities().find((a) => a.abilityHrid === '/abilities/cleave').level).toBe(11);
        expect(dataManager.getLearnedAbilities().find((a) => a.abilityHrid === '/abilities/cleave').experience).toBe(
            5000
        );
    });
});

/**
 * Guild shrine levels reaching the client at all.
 *
 * They ride on guild traffic that a session may never see, which is why the
 * upgrade advisor keeps having to say it does not know whether a shrine can
 * support a level. Capture is by shape and persistence is per character, so the
 * next login starts with the last reading rather than with nothing.
 */
describe('guild shrine levels', () => {
    test('are captured off whatever message carries them, and persisted', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        resetCharacter(dataManager);
        await webSocketHandlers.get('init_character_data')(initPayload());

        expect(dataManager.getGuildBuildingLevel('/guild_shrines/force')).toBe(0);

        webSocketHandlers.get('*')({
            type: 'guild_updated',
            guild: { id: 'g1' },
            characterGuildBuffMap: {
                '/guild_buffs/force_combat': { guildBuffHrid: '/guild_buffs/force_combat', level: 4 },
            },
            guildBuildingLevelMap: { '/guild_shrines/force': 6 },
        });

        expect(dataManager.getCharacterGuildBuffLevel('/guild_buffs/force_combat')).toBe(4);
        expect(dataManager.getGuildBuildingLevel('/guild_shrines/force')).toBe(6);
        expect(dataManager.getGuildShrineCapturedAt()).toBeGreaterThan(0);
        expect(dataManager.isGuildShrineHydrated()).toBe(false);

        await dataManager.persistGuildShrineLevels();
        expect(storageMock.setJSON).toHaveBeenCalled();
    });

    test('a message carrying one map does not erase the other', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        resetCharacter(dataManager);
        await webSocketHandlers.get('init_character_data')(initPayload());

        webSocketHandlers.get('*')({ guildBuildingLevelMap: { '/guild_shrines/force': 6 } });
        webSocketHandlers.get('*')({ characterGuildBuffMap: { '/guild_buffs/force_combat': { level: 2 } } });

        expect(dataManager.getGuildBuildingLevel('/guild_shrines/force')).toBe(6);
        expect(dataManager.getCharacterGuildBuffLevel('/guild_buffs/force_combat')).toBe(2);
    });

    test('a login with no guild data hydrates the last reading, marked as old', async () => {
        const { default: dataManager } = await import('./data-manager.js');

        storageMock.data.set('guildShrineLevels_char-1', {
            characterGuildBuffMap: { '/guild_buffs/force_combat': { level: 4 } },
            guildBuildingLevelMap: { '/guild_shrines/force': 6 },
            guildId: 'g1',
            capturedAt: 1_700_000_000_000,
        });

        resetCharacter(dataManager);
        await webSocketHandlers.get('init_character_data')(initPayload());
        await dataManager.whenGuildShrineLevelsReady();

        expect(dataManager.getGuildBuildingLevel('/guild_shrines/force')).toBe(6);
        expect(dataManager.getCharacterGuildBuffLevel('/guild_buffs/force_combat')).toBe(4);
        expect(dataManager.isGuildShrineHydrated()).toBe(true);
        expect(dataManager.getGuildShrineCapturedAt()).toBe(1_700_000_000_000);
    });

    test('a live message wins over the hydrated reading', async () => {
        const { default: dataManager } = await import('./data-manager.js');

        storageMock.data.set('guildShrineLevels_char-1', {
            characterGuildBuffMap: {},
            guildBuildingLevelMap: { '/guild_shrines/force': 6 },
            capturedAt: 1_700_000_000_000,
        });

        resetCharacter(dataManager);
        await webSocketHandlers.get('init_character_data')(initPayload());
        await dataManager.whenGuildShrineLevelsReady();
        expect(dataManager.getGuildBuildingLevel('/guild_shrines/force')).toBe(6);

        webSocketHandlers.get('*')({ guildBuildingLevelMap: { '/guild_shrines/force': 8 } });

        expect(dataManager.getGuildBuildingLevel('/guild_shrines/force')).toBe(8);
        expect(dataManager.isGuildShrineHydrated()).toBe(false);
    });

    test('login data that does carry the levels is not overwritten by an older reading', async () => {
        const { default: dataManager } = await import('./data-manager.js');

        storageMock.data.set('guildShrineLevels_char-1', {
            characterGuildBuffMap: { '/guild_buffs/force_combat': { level: 1 } },
            guildBuildingLevelMap: { '/guild_shrines/force': 1 },
            capturedAt: 1_600_000_000_000,
        });

        resetCharacter(dataManager);
        await webSocketHandlers.get('init_character_data')(
            initPayload({
                characterGuildBuffMap: { '/guild_buffs/force_combat': { level: 9 } },
                guildBuildingLevelMap: { '/guild_shrines/force': 10 },
            })
        );
        await dataManager.whenGuildShrineLevelsReady();

        expect(dataManager.getCharacterGuildBuffLevel('/guild_buffs/force_combat')).toBe(9);
        expect(dataManager.getGuildBuildingLevel('/guild_shrines/force')).toBe(10);
        expect(dataManager.isGuildShrineHydrated()).toBe(false);
    });
});

describe('event listener snapshots (upstream 03204a5)', () => {
    test('character switching calls every listener when listeners remove themselves', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        const calls = [];

        const first = () => {
            calls.push('first');
            dataManager.off('character_switching', first);
        };
        const second = () => {
            calls.push('second');
            dataManager.off('character_switching', second);
        };
        const third = () => {
            calls.push('third');
            dataManager.off('character_switching', third);
        };

        dataManager.on('character_switching', first);
        dataManager.on('character_switching', second);
        dataManager.on('character_switching', third);

        dataManager.emit('character_switching', {});

        expect(calls).toEqual(['first', 'second', 'third']);
    });

    test('a deferred event goes to listeners registered at emit time and still registered at delivery', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        const stays = vi.fn();
        const leaves = vi.fn();
        const late = vi.fn();

        dataManager.on('snapshot_test', stays);
        dataManager.on('snapshot_test', leaves);
        dataManager.emit('snapshot_test', { id: 1 });

        // Unregistered in the gap between emit and the deferred delivery — the
        // shape a character switch produces, where a feature is torn down while
        // an event is already in flight. Calling it would hand a cleaned-up
        // feature an event it can no longer service.
        dataManager.off('snapshot_test', leaves);
        // Registered in the same gap: it did not exist when the event happened.
        dataManager.on('snapshot_test', late);

        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(stays).toHaveBeenCalledWith({ id: 1 });
        expect(leaves).not.toHaveBeenCalled();
        expect(late).not.toHaveBeenCalled();

        dataManager.off('snapshot_test', stays);
        dataManager.off('snapshot_test', late);
    });

    test('a listener that unregisters others mid-delivery does not skip the rest', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        const calls = [];
        const second = () => calls.push('second');
        const first = () => {
            calls.push('first');
            // Already-snapshotted and still registered when the loop reaches it
            dataManager.off('mid_delivery_test', first);
        };
        const third = () => calls.push('third');

        dataManager.on('mid_delivery_test', first);
        dataManager.on('mid_delivery_test', second);
        dataManager.on('mid_delivery_test', third);
        dataManager.emit('mid_delivery_test', {});

        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(calls).toEqual(['first', 'second', 'third']);
        dataManager.off('mid_delivery_test', second);
        dataManager.off('mid_delivery_test', third);
    });
});

describe('inventory index', () => {
    test('items_updated updates, removes and appends by id without rescanning', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        dataManager.characterItems = [
            { id: 'a', count: 1, itemLocationHrid: '/item_locations/inventory' },
            { id: 'b', count: 2, itemLocationHrid: '/item_locations/inventory' },
            { id: 'c', count: 3, itemLocationHrid: '/item_locations/inventory' },
        ];
        dataManager._itemIndexById = null;

        const handler = webSocketHandlers.get('items_updated');
        handler({
            endCharacterItems: [
                { id: 'b', count: 20 },
                { id: 'a', count: 0 },
                { id: 'd', count: 7 },
            ],
        });

        expect(dataManager.characterItems.map((i) => i.id)).toEqual(['b', 'c', 'd']);
        expect(dataManager.characterItems.find((i) => i.id === 'b').count).toBe(20);
        expect(dataManager.characterItems.find((i) => i.id === 'd').count).toBe(7);
    });

    test('the index recovers when characterItems is replaced behind its back', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        dataManager.characterItems = [{ id: 'x', count: 1 }];
        dataManager._itemIndexById = null;
        expect(dataManager._itemIndexOf('x')).toBe(0);

        // Something outside the update paths reorders the array
        dataManager.characterItems = [
            { id: 'y', count: 5 },
            { id: 'x', count: 1 },
        ];
        expect(dataManager._itemIndexOf('x')).toBe(1);
        expect(dataManager._itemIndexOf('y')).toBe(0);
        expect(dataManager._itemIndexOf('nope')).toBe(-1);
    });

    test('action_completed inventory updates go through the same index', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        dataManager.characterItems = [{ id: 'a', count: 1, itemLocationHrid: '/item_locations/inventory' }];
        dataManager._itemIndexById = null;
        dataManager.characterActions = [];

        const handler = webSocketHandlers.get('action_completed');
        handler({
            endCharacterAction: { id: 99, isDone: true },
            endCharacterItems: [
                { id: 'a', count: 9, itemLocationHrid: '/item_locations/inventory' },
                { id: 'z', count: 4, itemLocationHrid: '/item_locations/inventory' },
                { id: 'ignored', count: 4, itemLocationHrid: '/item_locations/bank' },
            ],
        });

        expect(dataManager.characterItems.map((i) => [i.id, i.count])).toEqual([
            ['a', 9],
            ['z', 4],
        ]);
    });
});

describe('actions_updated', () => {
    test('replaces existing actions once and drops finished ones', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        dataManager.characterActions = [
            { id: 1, isDone: false },
            { id: 2, isDone: false },
            { id: 3, isDone: false },
        ];

        const handler = webSocketHandlers.get('actions_updated');
        handler({
            endCharacterActions: [
                { id: 2, isDone: true },
                { id: 4, isDone: false },
                { id: 1, isDone: false, updated: true },
            ],
        });

        expect(dataManager.characterActions).toEqual([
            { id: 3, isDone: false },
            { id: 4, isDone: false },
            { id: 1, isDone: false, updated: true },
        ]);
    });

    test('a repeated id in one message keeps the last copy', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        dataManager.characterActions = [];

        const handler = webSocketHandlers.get('actions_updated');
        handler({
            endCharacterActions: [
                { id: 7, isDone: false, take: 'first' },
                { id: 8, isDone: false },
                { id: 7, isDone: false, take: 'second' },
            ],
        });

        expect(dataManager.characterActions).toEqual([
            { id: 8, isDone: false },
            { id: 7, isDone: false, take: 'second' },
        ]);
    });
});

describe('action unit boundary (upstream 9210b4ab)', () => {
    /** An action queue entry, front-most by default */
    const queued = (overrides = {}) => ({
        id: 1,
        ordinal: 0,
        isDone: false,
        actionHrid: '/actions/combat/holy_hammer',
        currentCount: 5,
        ...overrides,
    });

    // Every test here drives the clock; leaving fake timers armed would leak into the rest
    // of the file, which does not expect them.
    afterEach(() => {
        vi.useRealTimers();
    });

    test('an action_completed continuation dates the new unit from that instant', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        dataManager.characterActions = [queued()];
        dataManager.actionUnitBoundary = null;

        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-27T12:00:00Z'));

        // First sighting only establishes the pair — nothing is claimed as elapsed yet
        webSocketHandlers.get('action_completed')({ endCharacterAction: queued() });
        expect(dataManager.getElapsedSecondsInCurrentUnit(1, 5, 135)).toBe(0);

        // The continuation for the next unit is the boundary we can actually date
        vi.setSystemTime(new Date('2026-08-27T12:02:15Z'));
        webSocketHandlers.get('action_completed')({ endCharacterAction: queued({ currentCount: 6 }) });

        vi.setSystemTime(new Date('2026-08-27T12:03:15Z'));
        expect(dataManager.getElapsedSecondsInCurrentUnit(1, 6, 135)).toBe(60);
    });

    test('the boundary is not reset while the same unit is still running', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        dataManager.characterActions = [queued()];
        dataManager.actionUnitBoundary = null;

        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-27T12:00:00Z'));
        webSocketHandlers.get('actions_updated')({ endCharacterActions: [queued()] });

        // Same (id, currentCount) arriving again is the same in-progress unit; re-anchoring it
        // here is exactly the bug — the ETA would walk later on every message
        vi.setSystemTime(new Date('2026-08-27T12:00:40Z'));
        webSocketHandlers.get('actions_updated')({ endCharacterActions: [queued()] });

        expect(dataManager.getElapsedSecondsInCurrentUnit(1, 5, 135)).toBe(40);
    });

    test('a new action taking the front slot starts its own unit', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        dataManager.characterActions = [queued()];
        dataManager.actionUnitBoundary = null;

        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-27T12:00:00Z'));
        webSocketHandlers.get('actions_updated')({ endCharacterActions: [queued()] });

        vi.setSystemTime(new Date('2026-08-27T12:05:00Z'));
        dataManager.characterActions = [];
        webSocketHandlers.get('actions_updated')({
            endCharacterActions: [queued({ id: 2, currentCount: 0 })],
        });

        vi.setSystemTime(new Date('2026-08-27T12:05:10Z'));
        expect(dataManager.getElapsedSecondsInCurrentUnit(2, 0, 135)).toBe(10);
        // The old action's boundary is gone, not merely shadowed
        expect(dataManager.getElapsedSecondsInCurrentUnit(1, 5, 135)).toBe(0);
    });

    test('fails closed for a different action id or a count that moved on', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        dataManager.actionUnitBoundary = { actionId: 1, currentCount: 5, unitStartTime: Date.now() - 60_000 };

        expect(dataManager.getElapsedSecondsInCurrentUnit(2, 5, 135)).toBe(0);
        expect(dataManager.getElapsedSecondsInCurrentUnit(1, 6, 135)).toBe(0);
        expect(dataManager.getElapsedSecondsInCurrentUnit(1, 5, 135)).toBeCloseTo(60, 0);
    });

    test('fails closed with no boundary at all, and clamps to one unit', async () => {
        const { default: dataManager } = await import('./data-manager.js');

        dataManager.actionUnitBoundary = null;
        expect(dataManager.getElapsedSecondsInCurrentUnit(1, 5, 135)).toBe(0);

        // A boundary older than the unit it describes still cannot claim more than one unit
        dataManager.actionUnitBoundary = { actionId: 1, currentCount: 5, unitStartTime: Date.now() - 10 * 60_000 };
        expect(dataManager.getElapsedSecondsInCurrentUnit(1, 5, 135)).toBe(135);

        // An unusable unit duration is never a licence to subtract anything
        expect(dataManager.getElapsedSecondsInCurrentUnit(1, 5, Infinity)).toBe(0);
        expect(dataManager.getElapsedSecondsInCurrentUnit(1, 5, 0)).toBe(0);
    });

    test('a matching boundary survives a reload, a stale one does not', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        resetCharacter(dataManager);
        dataManager.characterActions = [];
        dataManager.actionUnitBoundary = null;

        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-27T12:00:00Z'));

        await webSocketHandlers.get('init_character_data')(initPayload({ characterActions: [queued()] }));
        expect(storageMock.set).toHaveBeenCalledWith('char-1', expect.anything(), 'actionProgress');

        // Reload: same character, same action still on its fifth count
        vi.setSystemTime(new Date('2026-08-27T12:01:00Z'));
        resetCharacter(dataManager);
        dataManager.actionUnitBoundary = null;
        dataManager.characterActions = [];
        await webSocketHandlers.get('init_character_data')(initPayload({ characterActions: [queued()] }));

        expect(dataManager.getElapsedSecondsInCurrentUnit(1, 5, 135)).toBe(60);

        // A count that moved on while the page was closed is not something we can date
        vi.setSystemTime(new Date('2026-08-27T12:02:00Z'));
        resetCharacter(dataManager);
        dataManager.actionUnitBoundary = null;
        dataManager.characterActions = [];
        await webSocketHandlers.get('init_character_data')(
            initPayload({ characterActions: [queued({ currentCount: 9 })] })
        );

        expect(dataManager.getElapsedSecondsInCurrentUnit(1, 9, 135)).toBe(0);
    });
});

describe('guild shrine capture', () => {
    test('an unchanged map is not treated as a change', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        resetCharacter(dataManager);

        const levels = { '/guild_buildings/shrine': 4 };
        const first = dataManager.captureGuildShrineData({ guildBuildingLevelMap: { ...levels } });
        expect(first).toBe(true);

        const listener = vi.fn();
        dataManager.on('guild_shrine_levels_updated', listener);

        // Same values arriving again on a later message
        const second = dataManager.captureGuildShrineData({ guildBuildingLevelMap: { ...levels } });
        expect(second).toBe(false);

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(listener).not.toHaveBeenCalled();

        // A real change still gets through
        const third = dataManager.captureGuildShrineData({
            guildBuildingLevelMap: { '/guild_buildings/shrine': 5 },
        });
        expect(third).toBe(true);

        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(listener).toHaveBeenCalledTimes(1);
        dataManager.off('guild_shrine_levels_updated', listener);
    });
});

describe('overlapping character switches', () => {
    test('the switching flag is up before the pre-switch flush suspends the handler', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        await webSocketHandlers.get('init_character_data')(initPayload());

        let releaseFlush;
        storageMock.flushAll = vi.fn(
            () =>
                new Promise((resolve) => {
                    releaseFlush = resolve;
                })
        );

        const pending = webSocketHandlers.get('init_character_data')(
            initPayload({ character: { id: 'char-2', name: 'Two' } })
        );
        await Promise.resolve();

        // Anything arriving while the flush is in flight must see a switch under way,
        // because the arrays it would write into still belong to the departing character
        expect(dataManager.isCharacterSwitching).toBe(true);
        expect(dataManager.getCurrentCharacterId()).toBe('char-1');

        releaseFlush();
        await pending;

        expect(dataManager.isCharacterSwitching).toBe(false);
        expect(dataManager.getCurrentCharacterId()).toBe('char-2');
    });

    test('a second init waits for the first to finish rather than interleaving with it', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const { default: dataManager } = await import('./data-manager.js');
        const order = [];
        const onSwitching = (event) => order.push(`${event.oldId}->${event.newId}`);

        try {
            vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
            await webSocketHandlers.get('init_character_data')(initPayload());
            dataManager.lastCharacterSwitchTime = 0; // the singleton carries earlier tests' clock

            dataManager.on('character_switching', onSwitching);
            // Suspends the handler part way through the teardown, which is where a
            // second init used to run straight into the departing character's state
            storageMock.flushAll = vi.fn(async () => {
                await Promise.resolve();
                await Promise.resolve();
            });

            const first = webSocketHandlers.get('init_character_data')(
                initPayload({ character: { id: 'char-2', name: 'Two' } })
            );
            vi.setSystemTime(new Date('2026-01-01T00:00:02Z'));
            const second = webSocketHandlers.get('init_character_data')(
                initPayload({ character: { id: 'char-3', name: 'Three' } })
            );
            await Promise.all([first, second]);

            // char-3 departs char-2, not char-1: the first switch had finished before
            // the second started, so neither saw the other's half-torn-down state
            expect(order).toEqual(['char-1->char-2', 'char-2->char-3']);
            expect(dataManager.getCurrentCharacterId()).toBe('char-3');
        } finally {
            dataManager.off('character_switching', onSwitching);
            vi.useRealTimers();
        }
    });
});
