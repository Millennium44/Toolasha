import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
const game = vi.hoisted(() => ({ owner: '1', entries: [], profileRead: vi.fn(), buildings: {}, ws: {} }));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, handler) => {
            game.ws[type] = handler;
        },
        off: (type) => {
            delete game.ws[type];
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => game.owner,
        getInitClientData: () => ({
            guildBuildingDetailMap: { '/guild_buildings/stamina': { buffs: [] } },
            buffTypeDetailMap: { '/buff_types/stamina_level': { isCombat: true } },
        }),
        get guildBuildingLevelMap() {
            return game.buildings;
        },
    },
}));
vi.mock('../../core/storage.js', () => ({ default: { getJSON: (...args) => game.profileRead(...args) } }));
vi.mock('../../utils/view-loadout.js', () => ({
    getLoadouts: () => game.entries,
    VIEW_LOADOUT_CONTEXT: { GuildTrial: 'guild_trial' },
}));
import {
    captureTrialSimulationInputs,
    startTrialSimulationCapture,
    stopTrialSimulationCapture,
} from './guild-trial-simulation-inputs.js';
beforeEach(() => {
    game.owner = '1';
    game.entries = [];
    game.buildings = {};
    game.profileRead.mockReset();
    game.ws = {};
});
afterEach(() => stopTrialSimulationCapture?.());
describe('trial simulation export inputs', () => {
    test('exports a collected guild profile even when its loadout is still missing', async () => {
        startTrialSimulationCapture();
        game.ws.profile_shared({
            profile: {
                sharableCharacter: { id: 2, name: 'Ada' },
                characterSkills: [{ characterID: 2, skillHrid: '/skills/attack', level: 100 }],
            },
        });
        game.profileRead.mockResolvedValue([]);
        const result = await captureTrialSimulationInputs('1', [{ characterID: 2, name: 'Ada' }]);
        expect(result.viewLoadouts).toEqual([]);
        expect(result.profiles).toHaveLength(1);
        expect(result.profiles[0].profile.characterSkills[0].level).toBe(100);
    });
    test('an unavailable roster cannot export captures from an earlier guild', async () => {
        game.entries = [{ context: 'guild_trial', ownerCharacterId: '1', characterId: '2', name: 'Former guildmate' }];
        game.profileRead.mockResolvedValue([]);
        expect((await captureTrialSimulationInputs('1', [])).viewLoadouts).toEqual([]);
    });
    test('keeps opened profiles for a full guild after the general cache evicts its earliest members', async () => {
        startTrialSimulationCapture?.();
        const roster = Array.from({ length: 125 }, (_, i) => ({ characterID: i + 10, name: `Member ${i + 1}` }));
        const profiles = roster.map((member) => ({
            characterID: member.characterID,
            characterName: member.name,
            timestamp: Date.now(),
            profile: {
                sharableCharacter: { id: member.characterID, name: member.name },
                characterSkills: [{ characterID: member.characterID, skillHrid: '/skills/attack', level: 100 }],
                houseRooms: {},
            },
        }));
        game.entries = roster.map((member) => ({
            context: 'guild_trial',
            ownerCharacterId: '1',
            characterId: String(member.characterID),
            name: member.name,
            kind: 'combat',
            hasLoadout: true,
            loadout: { wearableItemMap: {}, equippedAbilities: [], abilityCombatTriggersMap: {} },
        }));
        for (const profile of profiles) game.ws.profile_shared?.({ type: 'profile_shared', profile: profile.profile });
        game.profileRead.mockResolvedValue(profiles.slice(-20));
        const result = await captureTrialSimulationInputs('1', roster);
        expect(result.profiles).toHaveLength(125);
        expect(
            result.profiles.find((profile) => Number(profile.characterID) === 10).profile.characterSkills[0].level
        ).toBe(100);
        stopTrialSimulationCapture?.();
        expect(game.ws.profile_shared).toBeUndefined();
    });
    test('exports only this character’s current guild captures with matching dated profiles and building context', async () => {
        const entry = {
            context: 'guild_trial',
            ownerCharacterId: '1',
            characterId: '2',
            name: 'Ada',
            kind: 'combat',
            capturedAt: 100,
            hasLoadout: true,
            loadout: {
                wearableItemMap: {
                    '/item_locations/main_hand': { itemHrid: '/items/iron_sword', enhancementLevel: 7 },
                },
                equippedAbilities: [{ abilityHrid: '/abilities/cleave', level: 50 }],
                abilityCombatTriggersMap: {},
            },
        };
        game.entries = [
            entry,
            { ...entry, ownerCharacterId: '9' },
            { ...entry, context: 'party' },
            { ...entry, characterId: '3', name: 'Former guildmate' },
        ];
        const profile = {
            characterID: 2,
            characterName: 'Ada',
            timestamp: 50,
            profile: { skills: { '/skills/attack': 100 }, houseRooms: {} },
        };
        game.profileRead.mockResolvedValue([profile, { ...profile, characterID: 3 }]);
        game.buildings = { '/guild_buildings/stamina': 3 };
        const result = await captureTrialSimulationInputs('1', [{ characterID: 2, name: 'Ada' }]);
        expect(result.viewLoadouts).toEqual([entry]);
        expect(result.profiles).toEqual([profile]);
        expect(result.guildBuildingLevelMap).toEqual(game.buildings);
        expect(result.buffTypeDetailMap['/buff_types/stamina_level'].isCombat).toBe(true);
        entry.loadout.equippedAbilities[0].level = 1;
        profile.profile.skills['/skills/attack'] = 1;
        game.buildings['/guild_buildings/stamina'] = 0;
        expect(result.viewLoadouts[0].loadout.equippedAbilities[0].level).toBe(50);
        expect(result.profiles[0].profile.skills['/skills/attack']).toBe(100);
        expect(result.guildBuildingLevelMap['/guild_buildings/stamina']).toBe(3);
    });
    test('drops a delayed snapshot after a character switch and reports an unreadable cache', async () => {
        game.profileRead.mockImplementation(async () => {
            game.owner = '9';
            return [];
        });
        expect(await captureTrialSimulationInputs('1')).toBeNull();
        game.owner = '1';
        game.profileRead.mockRejectedValue(new Error('unavailable'));
        expect(await captureTrialSimulationInputs('1')).toMatchObject({ profileCacheRead: false, profiles: [] });
    });
});
