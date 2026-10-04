import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
const game = vi.hoisted(() => ({
    owner: '1',
    entries: [],
    profileRead: vi.fn(),
    save: vi.fn(),
    set: vi.fn(),
    stored: new Map(),
    buildings: {},
    ws: {},
}));
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
vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: (...args) => game.profileRead(...args),
        setJSON: (...args) => game.set(...args),
        update: (...args) => game.save(...args),
    },
}));
vi.mock('../../utils/view-loadout.js', () => ({
    getLoadouts: () => game.entries,
    VIEW_LOADOUT_CONTEXT: { GuildTrial: 'guild_trial' },
}));
import {
    captureTrialSimulationInputs,
    startTrialSimulationCapture,
    stopTrialSimulationCapture,
    trialSimulationProfiles,
    trialSimulationLoadouts,
    restoreTrialSimulationInputs,
    validateTrialInputBundle,
    parseTrialInputBundle,
    loadSavedTrialInputBundles,
    saveTrialInputBundle,
} from './guild-trial-simulation-inputs.js';
beforeEach(() => {
    game.owner = '1';
    game.entries = [];
    game.buildings = {};
    game.profileRead.mockReset();
    game.stored.clear();
    game.set.mockReset().mockImplementation(async (key, value) => {
        game.stored.set(key, structuredClone(value));
        return true;
    });
    game.save.mockReset().mockImplementation(async (key, mutate) => {
        const value = mutate(structuredClone(game.stored.get(key)));
        game.stored.set(key, structuredClone(value));
        return { written: true, value };
    });
    game.ws = {};
});

function bundle(overrides = {}) {
    const at = Date.parse('2026-10-04T16:00:00Z');
    return {
        format: 'toolasha-guild-trial-inputs',
        version: 1,
        guildName: 'SuperMoo',
        host: 'test.milkywayidle.com',
        weekStartAt: '2026-10-04T00:00:00Z',
        exportedAt: new Date(at).toISOString(),
        capturedSince: at - 1000,
        coverage: [
            {
                characterId: '2',
                name: 'Ada',
                trials: { combat: '/guild_combat/badger', skilling: '/guild_skilling/alchemy' },
            },
        ],
        simulationInputs: {
            version: 1,
            ownerCharacterId: '1',
            capturedAt: at,
            viewLoadouts: [
                {
                    ownerCharacterId: '1',
                    characterId: '2',
                    name: 'Ada',
                    context: 'guild_trial',
                    kind: 'combat',
                    capturedAt: at,
                    hasLoadout: true,
                    loadout: {
                        sharableCharacter: { id: 2, name: 'Ada' },
                        hasLoadout: true,
                        wearableItemMap: {},
                        equippedAbilities: [],
                        combatConsumables: [],
                        abilityCombatTriggersMap: {},
                        consumableCombatTriggersMap: {},
                    },
                },
            ],
            profiles: [
                {
                    characterID: 2,
                    characterName: 'Ada',
                    timestamp: at,
                    profile: {
                        sharableCharacter: { id: 2, name: 'Ada' },
                        characterSkills: [{ characterID: 2, skillHrid: '/skills/attack', level: 100 }],
                        characterHouseRoomMap: {},
                        guildBuffLevelMap: {},
                    },
                },
            ],
            guildBuildingLevelMap: {},
            guildBuildingDetailMap: {},
            guildBuffDetailMap: {},
            guildTrialDetailMap: {},
            buffTypeDetailMap: {},
        },
        ...overrides,
    };
}

describe('reusable trial capture library', () => {
    beforeEach(() => {
        game.profileRead.mockImplementation(async (key, _store, fallback) =>
            structuredClone(game.stored.get(key) ?? fallback)
        );
    });
    test('accepts the producer shape, unknown kinds and explicit no-loadout replies without promoting them', () => {
        const input = bundle();
        const entry = input.simulationInputs.viewLoadouts[0];
        input.simulationInputs.viewLoadouts.push(
            { ...entry, kind: null },
            { ...entry, kind: 'skilling', hasLoadout: false, loadout: null }
        );
        const parsed = parseTrialInputBundle(JSON.stringify(input));
        expect(parsed.simulationInputs.viewLoadouts).toHaveLength(3);
        expect(parsed.simulationInputs.viewLoadouts[2].hasLoadout).toBe(false);
        parsed.simulationInputs.profiles[0].profile.characterSkills[0].level = 1;
        expect(input.simulationInputs.profiles[0].profile.characterSkills[0].level).toBe(100);
    });
    test.each([
        [
            'other owner',
            (input) => {
                input.simulationInputs.ownerCharacterId = '9';
            },
        ],
        [
            'other server',
            (input) => {
                input.host = 'www.milkywayidle.com';
            },
        ],
        [
            'new version',
            (input) => {
                input.version = 2;
            },
        ],
        [
            'duplicate signup',
            (input) => {
                input.coverage.push(structuredClone(input.coverage[0]));
            },
        ],
        [
            'empty signup',
            (input) => {
                input.coverage[0].trials = { combat: '' };
            },
        ],
        [
            'foreign loadout id',
            (input) => {
                input.simulationInputs.viewLoadouts[0].characterId = '9';
            },
        ],
        [
            'mismatched profile',
            (input) => {
                input.simulationInputs.profiles[0].profile.sharableCharacter.id = 9;
            },
        ],
        [
            'mismatched skill owner',
            (input) => {
                input.simulationInputs.profiles[0].profile.characterSkills[0].characterID = 9;
            },
        ],
    ])('rejects %s before changing any session or storage state', (_name, change) => {
        const input = bundle();
        change(input);
        expect(() => validateTrialInputBundle(input, { host: 'test.milkywayidle.com' })).toThrow();
        expect(game.save).not.toHaveBeenCalled();
        expect(trialSimulationProfiles()).toEqual([]);
    });
    test('accepts a full-sized export above the old setup import limit', () => {
        const input = bundle({ padding: 'x'.repeat(6_500_000) });
        expect(parseTrialInputBundle(JSON.stringify(input)).padding).toHaveLength(6_500_000);
        expect(() => parseTrialInputBundle(JSON.stringify(bundle({ padding: '界'.repeat(7_000_000) })))).toThrow(
            '20 MB'
        );
    });
    test('saves and restores inputs after session capture is cleared without writing the general profile cache', async () => {
        await saveTrialInputBundle(bundle());
        stopTrialSimulationCapture();
        const [saved] = await loadSavedTrialInputBundles();
        restoreTrialSimulationInputs(saved);
        expect(trialSimulationProfiles()[0].profile.characterSkills[0].level).toBe(100);
        expect(trialSimulationLoadouts()).toHaveLength(1);
        expect(game.save.mock.calls[0][0]).toBe('guild_trial_inputs_1');
        expect(game.save.mock.calls[0].slice(2)).toEqual(['combatExport']);
        game.owner = '9';
        expect(trialSimulationProfiles()).toEqual([]);
        expect(trialSimulationLoadouts()).toEqual([]);
        expect(await loadSavedTrialInputBundles()).toEqual([]);
    });
    test('merges legacy guild-name captures with newer guild-id sets and preserves the newest response per member', async () => {
        const old = bundle();
        const fresh = bundle({ guildID: '10', exportedAt: '2026-10-04T16:05:00Z' });
        fresh.simulationInputs.profiles[0].timestamp += 10;
        fresh.simulationInputs.profiles[0].profile.characterSkills[0].level = 110;
        fresh.simulationInputs.viewLoadouts[0].capturedAt += 10;
        fresh.simulationInputs.viewLoadouts[0].hasLoadout = false;
        await Promise.all([saveTrialInputBundle(fresh), saveTrialInputBundle(old)]);
        const saved = await loadSavedTrialInputBundles();
        expect(saved).toHaveLength(1);
        expect(saved[0].guildID).toBe('10');
        expect(saved[0].simulationInputs.profiles[0].profile.characterSkills[0].level).toBe(110);
        expect(saved[0].simulationInputs.viewLoadouts[0].hasLoadout).toBe(false);
    });
    test('independent tabs cannot overwrite another guild/week saved during their read', async () => {
        vi.resetModules();
        const otherTab = await import('./guild-trial-simulation-inputs.js');
        game.profileRead.mockResolvedValue([]);
        await Promise.all([
            saveTrialInputBundle(bundle()),
            otherTab.saveTrialInputBundle(
                bundle({ weekStartAt: '2026-10-11T00:00:00Z', exportedAt: '2026-10-11T16:00:00Z' })
            ),
        ]);
        expect(game.stored.get('guild_trial_inputs_1')).toHaveLength(2);
    });
    test('bounds retention to the latest eight guild/week sets and excludes corrupt records', async () => {
        for (let day = 1; day <= 10; day++) {
            const date = `2026-10-${String(day).padStart(2, '0')}T00:00:00Z`;
            await saveTrialInputBundle(bundle({ weekStartAt: date, exportedAt: date }));
        }
        const saved = await loadSavedTrialInputBundles();
        expect(saved).toHaveLength(8);
        expect(saved[0].weekStartAt).toBe('2026-10-10T00:00:00Z');
        expect(saved.at(-1).weekStartAt).toBe('2026-10-03T00:00:00Z');
        game.stored.set('guild_trial_inputs_1', [{ format: 'bad' }, saved[0]]);
        expect(await loadSavedTrialInputBundles()).toEqual([saved[0]]);
    });
    test('reports failed writes and remains usable for the next save', async () => {
        game.save.mockResolvedValueOnce(null);
        await expect(saveTrialInputBundle(bundle())).rejects.toThrow('could not save');
        await expect(saveTrialInputBundle(bundle())).resolves.toMatchObject({ guildName: 'SuperMoo' });
        expect(await loadSavedTrialInputBundles()).toHaveLength(1);
    });
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
    test('a matching name cannot override an explicit loadout id outside the current roster', async () => {
        const current = {
            context: 'guild_trial',
            ownerCharacterId: '1',
            characterId: '2',
            name: 'Previous name',
            kind: 'combat',
            hasLoadout: true,
            capturedAt: 100,
            loadout: { wearableItemMap: {}, equippedAbilities: [], abilityCombatTriggersMap: {} },
        };
        const nameOnly = { ...current, characterId: null, name: 'ADA', hasLoadout: false };
        const differentMember = { ...current, characterId: '3', name: 'Ada' };
        game.entries = [current, nameOnly, differentMember];
        game.profileRead.mockResolvedValue([]);

        const result = await captureTrialSimulationInputs('1', [{ characterID: 2, name: 'Ada' }]);

        expect(result.viewLoadouts).toEqual([current, nameOnly]);
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
