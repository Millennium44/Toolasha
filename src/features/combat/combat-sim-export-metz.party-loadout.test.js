/**
 * The Metz team export wearing a partymate's stored View Loadout, through the real
 * constructPartyPlayer and the real GM store, as on the Metz site: no live character, everything
 * read from the game page's GM bridge.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../core/data-manager.js', () => ({
    default: {
        characterData: null,
        battleData: null,
        characterEquipment: new Map(),
        getInitClientData: vi.fn(() => null),
        getCurrentCharacterId: vi.fn(() => null),
        getPartyMembers: vi.fn(() => ({ members: [], source: 'none', updatedAt: null })),
        getCurrentActions: vi.fn(() => null),
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: { available: false, getJSON: vi.fn(async () => null), setJSON: vi.fn(async () => {}) },
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('../../utils/profile-command.js', () => ({ getGameCore: () => null }));
vi.mock('./combat-sim-loadouts-metz.js', () => ({ getMetzLoadouts: vi.fn(() => []) }));

const { constructMetzTeamExport } = await import('./combat-sim-export-metz.js');
const { GM_PARTY_LOADOUTS_KEY } = await import('./combat-sim-party-loadouts-metz.js');
const { battleBridgeKeyFor } = await import('../../utils/battle-bridge-keys.js');

const HOUR = 60 * 60 * 1000;
let gm;

const row = (location, itemHrid, enhancementLevel) => ({
    itemLocationHrid: `/item_locations/${location}`,
    itemHrid,
    enhancementLevel,
});

function seed({ loadoutAgeMs }) {
    const now = Date.now();
    const clientData = {
        itemDetailMap: {
            '/items/spaceberry_cake': { categoryHrid: '/item_categories/food' },
            '/items/super_stamina_coffee': { categoryHrid: '/item_categories/drink' },
            '/items/apple': { categoryHrid: '/item_categories/food' },
        },
        abilityDetailMap: {
            '/abilities/invincible': { isSpecialAbility: true },
            '/abilities/aqua_arrow': { isSpecialAbility: false },
            '/abilities/frost_surge': { isSpecialAbility: false },
            '/abilities/old_ability': { isSpecialAbility: false },
        },
    };
    const character = {
        character: { id: 100, name: 'Self' },
        characterSkills: [],
        characterAbilities: [],
        characterItems: [],
        combatUnit: { combatAbilities: [] },
        partyInfo: { partySlotMap: { 1: { characterID: 100 }, 2: { characterID: 7 } } },
    };
    const profile = {
        characterID: 7,
        characterName: 'Ann',
        timestamp: now - 2 * HOUR,
        profile: {
            characterSkills: [{ skillHrid: '/skills/attack', level: 95 }],
            characterHouseRoomMap: { a: { houseRoomHrid: '/house_rooms/dojo', level: 6 } },
            // A head piece the loadout does not wear must not leak through
            wearableItemMap: {
                '/item_locations/main_hand': row('main_hand', '/items/profile_sword', 3),
                '/item_locations/head': row('head', '/items/profile_hat', 2),
            },
            equippedAbilities: [{ abilityHrid: '/abilities/old_ability', level: 10 }],
            abilityCombatTriggersMap: { '/abilities/old_ability': [] },
            consumableCombatTriggersMap: { '/items/apple': [] },
        },
    };
    const loadout = {
        actionTypeHrid: '/action_types/combat',
        wearableItemMap: { '/item_locations/two_hand': row('two_hand', '/items/loadout_bow', 9) },
        // Out of slot order, with the special
        equippedAbilities: [
            { abilityHrid: '/abilities/frost_surge', level: 50, slotNumber: 2 },
            { abilityHrid: '/abilities/invincible', level: 40, slotNumber: 0 },
            { abilityHrid: '/abilities/aqua_arrow', level: 60, slotNumber: 1 },
        ],
        // The coffee has no trigger entry
        combatConsumables: [{ itemHrid: '/items/spaceberry_cake' }, { itemHrid: '/items/super_stamina_coffee' }],
        abilityCombatTriggersMap: { '/abilities/aqua_arrow': [] },
        consumableCombatTriggersMap: { '/items/spaceberry_cake': [] },
    };
    // The live fight has Ann eating apples with the profile's triggers
    const battle = {
        players: [
            {
                character: { id: 7 },
                combatConsumables: [{ itemHrid: '/items/apple' }],
                abilityCombatTriggersMap: { '/abilities/old_ability': [] },
                consumableCombatTriggersMap: { '/items/apple': [] },
            },
        ],
    };
    gm.set('toolasha_init_character_data', JSON.stringify(character));
    gm.set('toolasha_init_client_data', JSON.stringify(clientData));
    gm.set('toolasha_profile_list', JSON.stringify([profile]));
    gm.set(battleBridgeKeyFor(100), JSON.stringify(battle));
    gm.set(
        GM_PARTY_LOADOUTS_KEY,
        JSON.stringify({ ownerCharacterId: '100', entries: { 7: { capturedAt: now - loadoutAgeMs, loadout } } })
    );
}

beforeEach(() => {
    gm = new Map();
    globalThis.GM_getValue = vi.fn((key, fallback) => (gm.has(key) ? gm.get(key) : fallback));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    delete globalThis.GM_getValue;
    vi.restoreAllMocks();
});

describe('a partymate exported in their View Loadout', () => {
    test("wears the loadout's whole build and keeps the profile's levels and house", async () => {
        seed({ loadoutAgeMs: HOUR / 2 });
        const warnings = [];

        const team = await constructMetzTeamExport('100', { warnings });
        const ann = team.find((entry) => entry.name === 'Ann');

        expect(ann.player.equipment).toEqual([row('two_hand', '/items/loadout_bow', 9)]);
        expect(ann.abilities).toEqual([
            { abilityHrid: '/abilities/invincible', level: 40 },
            { abilityHrid: '/abilities/aqua_arrow', level: 60 },
            { abilityHrid: '/abilities/frost_surge', level: 50 },
        ]);
        expect(ann.food['/action_types/combat']).toEqual([{ itemHrid: '/items/spaceberry_cake' }]);
        expect(ann.drinks['/action_types/combat']).toEqual([{ itemHrid: '/items/super_stamina_coffee' }]);
        expect(ann.triggerMap).toEqual({ '/abilities/aqua_arrow': [], '/items/spaceberry_cake': [] });
        expect(ann.player.attackLevel).toBe(95);
        expect(ann.houseRooms).toEqual({ '/house_rooms/dojo': 6 });
        expect(warnings).toEqual([
            expect.objectContaining({ name: 'Ann', level: 'loadout', text: expect.stringContaining('View Loadout') }),
        ]);
    });

    test('an older loadout leaves the profile and live battle build as before', async () => {
        seed({ loadoutAgeMs: 3 * HOUR });

        const team = await constructMetzTeamExport('100');
        const ann = team.find((entry) => entry.name === 'Ann');

        expect(ann.player.equipment.map((item) => item.itemHrid).sort()).toEqual([
            '/items/profile_hat',
            '/items/profile_sword',
        ]);
        expect(ann.food['/action_types/combat']).toEqual([{ itemHrid: '/items/apple' }]);
    });
});
