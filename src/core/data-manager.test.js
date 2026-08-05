/**
 * Tests for DataManager event forwarding
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

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
}));

vi.mock('./storage.js', () => ({
    default: {
        getJSON: (key, storeName, fallback) => storageMock.getJSON(key, storeName, fallback),
        setJSON: (key, value, storeName) => storageMock.setJSON(key, value, storeName),
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
    function login(dataManager, combatAbilities) {
        resetCharacter(dataManager);
        webSocketHandlers.get('init_character_data')(
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
        login(dataManager, NORMAL);

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
        login(dataManager, NORMAL);

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
        login(dataManager, NORMAL);

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
        login(dataManager, NORMAL);

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
        webSocketHandlers.get('init_character_data')(initPayload());

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
        webSocketHandlers.get('init_character_data')(initPayload());

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
        webSocketHandlers.get('init_character_data')(initPayload());
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
        webSocketHandlers.get('init_character_data')(initPayload());
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
        webSocketHandlers.get('init_character_data')(
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

    test('deferred events use the listener set that existed when emit was called', async () => {
        const { default: dataManager } = await import('./data-manager.js');
        const first = vi.fn();
        const late = vi.fn();

        dataManager.on('snapshot_test', first);
        dataManager.emit('snapshot_test', { id: 1 });
        dataManager.off('snapshot_test', first);
        dataManager.on('snapshot_test', late);

        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(first).toHaveBeenCalledWith({ id: 1 });
        expect(late).not.toHaveBeenCalled();
        dataManager.off('snapshot_test', late);
    });
});
