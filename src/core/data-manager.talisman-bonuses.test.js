/**
 * dataManager.getEquipment() carries the live talisman bonuses, and the buff state version moves when the
 * talismans do, so every memo keyed on it is recomputed.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
    BELT_ITEMS,
    MODIFIER_DETAILS,
    TALISMAN_ENHANCEMENT_TABLE,
    talisman as fixtureTalisman,
} from '../__fixtures__/talisman-bonuses.js';

// The test character's id in this file is 'char-1'; a row naming another character is refused by the merge
const talisman = (...args) => ({ ...fixtureTalisman(...args), characterID: 'char-1' });

const server = vi.hoisted(() => ({ test: true }));
let webSocketHandlers = new Map();

vi.mock('./websocket.js', () => {
    webSocketHandlers = new Map();
    return {
        default: {
            on: vi.fn((event, handler) => {
                webSocketHandlers.set(event, handler);
            }),
            off: vi.fn(),
            onSocketEvent: vi.fn(),
            offSocketEvent: vi.fn(),
            saveCombatSimSnapshot: vi.fn(() => true),
        },
    };
});
vi.mock('./storage.js', () => ({
    default: {
        getJSON: async (_key, _store, fallback) => fallback,
        setJSON: async () => true,
        get: async (_key, _store, fallback = null) => fallback,
        set: async () => true,
        flushAll: async () => {},
    },
}));
vi.mock('../utils/game-server.js', () => ({ isTestServer: () => server.test }));

const { talismanStat } = await import('../utils/talisman-bonuses.js');
let dataManager;

const belt = (level = 10) => ({
    itemHrid: '/items/large_talisman_belt',
    itemLocationHrid: '/item_locations/belt',
    enhancementLevel: level,
    count: 1,
});

async function login(characterTalismans) {
    dataManager.currentCharacterId = null;
    dataManager.currentCharacterName = null;
    dataManager.characterData = null;
    dataManager.activeSocket = null;
    await webSocketHandlers.get('init_character_data')({
        character: { id: 'char-1', name: 'Tester' },
        characterSkills: [],
        characterItems: [belt()],
        characterActions: [],
        characterQuests: [],
        characterTalismans,
    });
    dataManager.initClientData = {
        itemDetailMap: BELT_ITEMS,
        talismanModifierDetailMap: MODIFIER_DETAILS,
        enhancementLevelTotalBonusMultiplierTable: TALISMAN_ENHANCEMENT_TABLE,
    };
}

beforeEach(async () => {
    server.test = true;
    ({ default: dataManager } = await import('./data-manager.js'));
});

describe('getEquipment() and the live talismans', () => {
    test('a slotted talisman under the worn belt rides on the returned Map: Milking Speed G2 is 0.05661', async () => {
        await login([talisman(1, 1, [['milking_speed', 2]])]);
        const equipment = dataManager.getEquipment();
        expect(talismanStat(equipment, 'milkingSpeed')).toBeCloseTo(0.05661, 10);
    });

    test('the Map keeps exactly the worn items it had (the belt is an ordinary entry)', async () => {
        await login([talisman(1, 1, [['milking_speed', 2]])]);
        expect([...dataManager.getEquipment().keys()]).toEqual(['/item_locations/belt']);
    });

    test('off the test server nothing rides on it, however many talismans the list holds', async () => {
        await login([talisman(1, 1, [['milking_speed', 2]])]);
        server.test = false;
        expect(talismanStat(dataManager.getEquipment(), 'milkingSpeed')).toBe(0);
    });

    test('a character with no talismans list (a live server never sends one) reads gear alone', async () => {
        await login(undefined);
        expect(talismanStat(dataManager.getEquipment(), 'milkingSpeed')).toBe(0);
        expect(dataManager.getLiveTalismanBonuses()).toEqual({ noncombat: {}, buffs: {}, combat: {} });
    });

    test('talismans_updated moves the buff state version and the next Map has the new value', async () => {
        await login([talisman(1, 1, [['milking_speed', 2]])]);
        const before = dataManager.getBuffStateVersion();
        expect(talismanStat(dataManager.getEquipment(), 'milkingSpeed')).toBeCloseTo(0.05661, 10);

        webSocketHandlers.get('talismans_updated')({
            endCharacterTalismans: [talisman(1, 1, [['milking_speed', 4]])],
            deletedTalismanIds: [],
        });
        expect(dataManager.getBuffStateVersion()).toBeGreaterThan(before);
        expect(talismanStat(dataManager.getEquipment(), 'milkingSpeed')).toBeCloseTo(0.075 * 1.258, 10);

        // Unslotting (slotIndex 0) takes it back out
        webSocketHandlers.get('talismans_updated')({
            endCharacterTalismans: [talisman(1, 0, [['milking_speed', 4]])],
            deletedTalismanIds: null,
        });
        expect(talismanStat(dataManager.getEquipment(), 'milkingSpeed')).toBe(0);
    });

    test('taking the belt off drops every talisman (no belt, no talismans)', async () => {
        await login([talisman(1, 1, [['milking_speed', 2]])]);
        dataManager.characterEquipment.delete('/item_locations/belt');
        dataManager.buffStateVersion++; // what updateEquipmentMap does for an unequip
        expect(talismanStat(dataManager.getEquipment(), 'milkingSpeed')).toBe(0);
    });
});
