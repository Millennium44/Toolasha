import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    characterData: null,
    onGamePage: true,
    inventory: [],
    itemDetailMap: {},
    mooPassBuffs: [],
    mooPassExpireTime: null,
    selfEquipment: [],
    selfAbilities: [],
    partyEquipment: [],
    partySkills: [],
    profiles: null,
    battleRoster: null,
    loadouts: [],
    // `${ownerId}|${memberId}` -> {capturedAt, loadout}, as combat-sim-party-loadouts-metz.js answers
    partyLoadouts: {},
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterData() {
            return mocks.onGamePage ? mocks.characterData : null;
        },
        // The game page's own character; nothing on an external simulator page
        getCurrentCharacterId: vi.fn(() => (mocks.onGamePage ? (mocks.characterData?.character?.id ?? null) : null)),
        getInventory: vi.fn(() => mocks.inventory),
        getMooPassBuffs: vi.fn(() => mocks.mooPassBuffs),
        getMooPassExpireTime: vi.fn(() => mocks.mooPassExpireTime),
        // Mirrors the real one: the battle roster wins, else the login slot map
        getPartyMembers: vi.fn(() => {
            if (mocks.battleRoster?.length) return { members: mocks.battleRoster, source: 'battle', updatedAt: 1 };
            const slots = mocks.characterData?.partyInfo?.partySlotMap || {};
            return {
                members: Object.values(slots)
                    .filter((member) => member?.characterID)
                    .map((member) => ({ characterID: member.characterID, characterName: member.characterName || '' })),
                source: 'login',
                updatedAt: null,
            };
        }),
    },
}));

vi.mock('./combat-sim-loadouts-metz.js', () => ({
    getMetzLoadouts: vi.fn(() => mocks.loadouts),
}));

vi.mock('./combat-sim-party-loadouts-metz.js', () => ({
    getPartyLoadout: vi.fn((owner, member) => mocks.partyLoadouts[`${owner}|${member}`] || null),
}));

vi.mock('./combat-sim-export.js', () => ({
    getCharacterData: vi.fn(() => mocks.characterData),
    getClientData: vi.fn(() => ({ itemDetailMap: mocks.itemDetailMap })),
    getBattleData: vi.fn(() => null),
    getProfileList: vi.fn(async () =>
        mocks.profiles
            ? mocks.profiles
            : [{ characterID: 'party-1', characterName: 'Teammate', profile: { characterSkills: mocks.partySkills } }]
    ),
    constructSelfPlayer: vi.fn(() => playerShape(mocks.selfEquipment, mocks.selfAbilities)),
    constructPartyPlayer: vi.fn(() => playerShape(mocks.partyEquipment, [])),
}));

function playerShape(equipment, abilities) {
    return {
        player: { attackLevel: 100, defenseLevel: 100, equipment },
        food: { '/action_types/combat': [{ itemHrid: '/items/apple' }, { itemHrid: '' }] },
        drinks: { '/action_types/combat': [] },
        abilities,
        triggerMap: {},
        houseRooms: {},
        guildCombatBuffLevels: {},
        achievements: {},
    };
}

import {
    constructMetzCharacterExport,
    constructMetzTeamExport,
    applyLoadoutOverrideToMetzCharacter,
    describePartyProfiles,
} from './combat-sim-export-metz.js';
import { constructPartyPlayer } from './combat-sim-export.js';

function baseCharacter(overrides = {}) {
    return {
        character: { id: 'self-1', name: 'Self' },
        characterSkills: [],
        characterAbilities: [],
        combatUnit: { combatAbilities: [] },
        partyInfo: { partySlotMap: {} },
        ...overrides,
    };
}

describe('Metz combat export', () => {
    beforeEach(() => {
        mocks.characterData = baseCharacter();
        mocks.onGamePage = true;
        mocks.loadouts = [];
        mocks.inventory = [];
        mocks.itemDetailMap = {};
        mocks.mooPassBuffs = [];
        mocks.mooPassExpireTime = null;
        mocks.selfEquipment = [];
        mocks.selfAbilities = [];
        mocks.partyEquipment = [];
        mocks.partySkills = [];
        mocks.profiles = null;
        mocks.battleRoster = null;
        mocks.partyLoadouts = {};
    });

    test('mid-battle the team and the preview read the battle roster, not the emptied slot map', async () => {
        // The game empties partySlotMap for a whole battle; new_battle names the party
        mocks.characterData = baseCharacter({ partyInfo: { partySlotMap: {} } });
        mocks.battleRoster = [
            { characterID: 'self-1', characterName: 'Self' },
            { characterID: 'party-1', characterName: 'Teammate' },
        ];

        const team = await constructMetzTeamExport('self-1');
        const members = describePartyProfiles(mocks.characterData, [{ characterID: 'party-1' }]);

        expect(team.map((entry) => entry.name)).toEqual(['Self', 'Teammate']);
        expect(members.map((member) => member.characterId)).toEqual(['party-1']);
    });

    test('a bridged character on a simulator page still reads its own slot map', () => {
        const bridged = baseCharacter({ partyInfo: { partySlotMap: { 1: { characterID: 'party-9' } } } });
        mocks.onGamePage = false;
        mocks.battleRoster = [{ characterID: 'party-1', characterName: 'Teammate' }];

        expect(describePartyProfiles(bridged, []).map((member) => member.characterId)).toEqual(['party-9']);
    });

    test('a copy captured before a character-data refresh still reads the live roster', () => {
        const captured = baseCharacter({ partyInfo: { partySlotMap: { 1: { characterID: 'former-1' } } } });
        // init_character_data replaced the object; same character, new roster from the battle
        mocks.characterData = baseCharacter({ partyInfo: { partySlotMap: {} } });
        mocks.battleRoster = [{ characterID: 'party-1', characterName: 'Teammate' }];

        expect(describePartyProfiles(captured, []).map((member) => member.characterId)).toEqual(['party-1']);
    });

    test('moves live tools into skilling and keeps only filled combat slots', async () => {
        mocks.characterData = baseCharacter({
            characterSkills: [
                { skillHrid: '/skills/enhancing', level: 42 },
                { skillHrid: '/skills/alchemy', level: 33 },
            ],
        });
        mocks.selfEquipment = [
            { itemLocationHrid: '/item_locations/body', itemHrid: '/items/plate_body', enhancementLevel: 5 },
            {
                itemLocationHrid: '/item_locations/enhancing_tool',
                itemHrid: '/items/celestial_enhancer',
                enhancementLevel: 10,
            },
        ];
        mocks.selfAbilities = [{ abilityHrid: '' }, { abilityHrid: '/abilities/cleave', level: 60 }];

        const character = await constructMetzCharacterExport();

        expect(character.player.equipment).toEqual([mocks.selfEquipment[0]]);
        expect(character.abilities).toEqual([{ abilityHrid: '/abilities/cleave', level: 60 }]);
        expect(character.food['/action_types/combat']).toEqual([{ itemHrid: '/items/apple' }]);
        expect(character.skilling).toMatchObject({
            enhancingLevel: 42,
            alchemyLevel: 33,
            enhancingTool: { itemHrid: '/items/celestial_enhancer', enhancementLevel: 10 },
        });
    });

    test('the Shykai-only player.slottedTalismans is stripped from the Metz character', async () => {
        mocks.characterData = baseCharacter();
        const { constructSelfPlayer } = await import('./combat-sim-export.js');
        const source = playerShape([], []);
        source.player.slottedTalismans = [
            { talismanTypeHrid: '/talisman_types/combat', modifiers: [{ hrid: '/a', grade: 1 }], slotIndex: 1 },
        ];
        constructSelfPlayer.mockReturnValueOnce(source);

        const character = await constructMetzCharacterExport();

        expect(character.player.attackLevel).toBe(100);
        expect(JSON.stringify(character)).not.toContain('slottedTalismans');
        // The source is not mutated: the Shykai export built from it still carries the field
        expect(source.player.slottedTalismans).toHaveLength(1);
    });

    test('every other skilling-tool slot is dropped from player.equipment', async () => {
        mocks.characterData = baseCharacter();
        mocks.selfEquipment = [
            { itemLocationHrid: '/item_locations/body', itemHrid: '/items/plate_body', enhancementLevel: 5 },
            {
                itemLocationHrid: '/item_locations/tailoring_tool',
                itemHrid: '/items/holy_needle',
                enhancementLevel: 10,
            },
            { itemLocationHrid: '/item_locations/foraging_tool', itemHrid: '/items/holy_shears', enhancementLevel: 0 },
        ];

        const character = await constructMetzCharacterExport();

        expect(character.player.equipment).toEqual([mocks.selfEquipment[0]]);
    });

    test('uses the real inventory shape for speed gear, spare wearables and unequipped abilities', async () => {
        mocks.characterData = baseCharacter({
            mooPassBuffs: [],
            characterAbilities: [
                { abilityHrid: '/abilities/cleave', level: 60 },
                { abilityHrid: '/abilities/rejuvenate', level: 45 },
            ],
            combatUnit: { combatAbilities: [{ abilityHrid: '/abilities/cleave', level: 60 }] },
        });
        mocks.mooPassBuffs = [{ typeHrid: '/buff_types/wisdom' }];
        mocks.itemDetailMap = {
            '/items/philosophers_necklace': {
                equipmentDetail: {
                    type: '/equipment_types/neck',
                    combatStats: { armor: 4 },
                    noncombatStats: { skillingSpeed: 0.04 },
                },
            },
            '/items/plate_body': { equipmentDetail: { type: '/equipment_types/body', combatStats: { armor: 12 } } },
            '/items/enhancer': { equipmentDetail: { type: '/equipment_types/enhancing_tool' } },
        };
        mocks.inventory = [
            {
                itemHrid: '/items/philosophers_necklace',
                enhancementLevel: 12,
                itemLocationHrid: '/item_locations/inventory',
                count: 1,
            },
            {
                itemHrid: '/items/plate_body',
                enhancementLevel: 3,
                itemLocationHrid: '/item_locations/inventory',
                count: 2,
            },
            {
                itemHrid: '/items/enhancer',
                enhancementLevel: 1,
                itemLocationHrid: '/item_locations/inventory',
                count: 1,
            },
        ];

        const character = await constructMetzCharacterExport();

        expect(character.skilling.speedGear).toEqual([
            { itemHrid: '/items/philosophers_necklace', enhancementLevel: 12 },
        ]);
        expect(character.owned.equipment).toEqual(
            expect.arrayContaining([{ itemHrid: '/items/plate_body', enhancementLevel: 3, count: 2, equipped: false }])
        );
        expect(character.owned.equipment).not.toContainEqual(expect.objectContaining({ itemHrid: '/items/enhancer' }));
        expect(character.owned.abilities).toEqual([
            { abilityHrid: '/abilities/rejuvenate', level: 45, equipped: false },
        ]);
        expect(character.hasMooPass).toBe(true);
    });

    test('uses bridged characterItems when the external simulator has no in-memory inventory', async () => {
        mocks.characterData = baseCharacter({
            mooPassBuffs: [{ typeHrid: '/buff_types/wisdom' }],
            characterItems: [
                {
                    itemHrid: '/items/plate_body',
                    enhancementLevel: 6,
                    itemLocationHrid: '/item_locations/inventory',
                    count: 2,
                },
            ],
        });
        mocks.itemDetailMap = {
            '/items/plate_body': {
                equipmentDetail: { type: '/equipment_types/body', combatStats: { armor: 12 } },
            },
        };
        mocks.inventory = [];
        mocks.onGamePage = false;

        const character = await constructMetzCharacterExport();

        expect(character.owned.equipment).toEqual([
            { itemHrid: '/items/plate_body', enhancementLevel: 6, count: 2, equipped: false },
        ]);
        expect(character.owned).not.toHaveProperty('capturedAt');
        expect(character.hasMooPass).toBe(true);
    });

    test('dates bridged inventory by when the game tab wrote it, not by when it was imported', async () => {
        mocks.characterData = baseCharacter({
            characterItems: [
                {
                    itemHrid: '/items/plate_body',
                    enhancementLevel: 6,
                    itemLocationHrid: '/item_locations/inventory',
                    count: 1,
                },
            ],
        });
        mocks.itemDetailMap = {
            '/items/plate_body': {
                equipmentDetail: { type: '/equipment_types/body', combatStats: { armor: 12 } },
            },
        };
        mocks.onGamePage = false;
        const writtenAt = Date.parse('2026-09-20T08:00:00.000Z');
        vi.stubGlobal(
            'GM_getValue',
            vi.fn((key, fallback) =>
                key === 'toolasha_init_character_data_meta'
                    ? JSON.stringify({ characterId: 'self-1', writtenAt })
                    : fallback
            )
        );

        try {
            const character = await constructMetzCharacterExport();
            expect(character.owned.capturedAt).toBe('2026-09-20T08:00:00.000Z');
        } finally {
            vi.unstubAllGlobals();
        }
    });

    test('does not claim non-combat speed pieces as combat inventory', async () => {
        mocks.itemDetailMap = {
            '/items/enhancers_top': {
                equipmentDetail: {
                    type: '/equipment_types/body',
                    combatStats: {},
                    noncombatStats: { enhancingSpeed: 0.04 },
                },
            },
        };
        mocks.inventory = [
            {
                itemHrid: '/items/enhancers_top',
                enhancementLevel: 8,
                itemLocationHrid: '/item_locations/inventory',
                count: 1,
            },
        ];

        const character = await constructMetzCharacterExport();

        expect(character.skilling.speedGear).toEqual([{ itemHrid: '/items/enhancers_top', enhancementLevel: 8 }]);
        expect(character).not.toHaveProperty('owned');
    });

    test('speed gear includes only pieces still held in inventory', async () => {
        mocks.itemDetailMap = {
            '/items/enhancers_top': {
                equipmentDetail: {
                    type: '/equipment_types/body',
                    noncombatStats: { enhancingSpeed: 0.04 },
                },
            },
        };
        mocks.inventory = [
            {
                itemHrid: '/items/enhancers_top',
                enhancementLevel: 8,
                itemLocationHrid: '/item_locations/inventory',
                count: 1,
            },
            {
                itemHrid: '/items/enhancers_top',
                enhancementLevel: 9,
                itemLocationHrid: '/item_locations/body',
                count: 1,
            },
            {
                itemHrid: '/items/enhancers_top',
                enhancementLevel: 10,
                itemLocationHrid: '/item_locations/inventory',
                count: 0,
            },
        ];

        const character = await constructMetzCharacterExport();

        expect(character.skilling.speedGear).toEqual([{ itemHrid: '/items/enhancers_top', enhancementLevel: 8 }]);
    });

    test('adds cached party members without claiming their inventory or pass state', async () => {
        mocks.characterData = baseCharacter({
            partyInfo: { partySlotMap: { 1: { characterID: 'party-1' } } },
        });
        mocks.partySkills = [{ skillHrid: '/skills/enhancing', level: 77 }];

        const team = await constructMetzTeamExport();
        const teammate = team.find((entry) => entry.name === 'Teammate');

        expect(team).toHaveLength(2);
        expect(teammate.skilling).toMatchObject({ enhancingLevel: 77, speedGear: [] });
        expect(teammate).not.toHaveProperty('owned');
        expect(teammate).not.toHaveProperty('hasMooPass');
    });

    test('keeps a gearless member in the team and reports them, and names a member with no profile', async () => {
        const now = Date.now();
        mocks.characterData = baseCharacter({
            partyInfo: {
                partySlotMap: {
                    1: { characterID: 'self-1' },
                    2: { characterID: 'party-1' },
                    3: { characterID: 'party-2', characterName: 'Ghost' },
                },
            },
        });
        // Hidden equipment captured outside a shared party: the map arrives empty
        mocks.profiles = [
            {
                characterID: 'party-1',
                characterName: 'Teammate',
                timestamp: now - 60 * 1000,
                profile: { characterSkills: [], hideWearableItems: true, wearableItemMap: {} },
            },
        ];
        const warnings = [];

        const team = await constructMetzTeamExport('self-1', { warnings });

        expect(team.map((entry) => entry.name)).toEqual(['Self', 'Teammate']);
        expect(warnings).toEqual([
            expect.objectContaining({ name: 'Teammate', level: 'gearless' }),
            expect.objectContaining({ name: 'Ghost', level: 'missing' }),
        ]);
    });

    test('reports a geared member whose profile is days old', async () => {
        mocks.characterData = baseCharacter({ partyInfo: { partySlotMap: { 1: { characterID: 'party-1' } } } });
        mocks.profiles = [
            {
                characterID: 'party-1',
                characterName: 'Teammate',
                timestamp: Date.now() - 4 * 24 * 60 * 60 * 1000,
                profile: {
                    characterSkills: [],
                    wearableItemMap: {
                        '/item_locations/head': {
                            itemLocationHrid: '/item_locations/head',
                            itemHrid: '/items/rough_hood',
                            enhancementLevel: 0,
                        },
                    },
                },
            },
        ];
        const warnings = [];

        await constructMetzTeamExport(null, { warnings });

        expect(warnings).toEqual([
            expect.objectContaining({ level: 'stale', text: expect.stringContaining('4 d old') }),
        ]);
    });

    test('refuses a team export when the character changes while cached profiles are read', async () => {
        mocks.characterData = baseCharacter({ partyInfo: { partySlotMap: { 1: { characterID: 'party-1' } } } });
        const { getProfileList } = await import('./combat-sim-export.js');
        getProfileList.mockImplementationOnce(async () => {
            mocks.characterData = baseCharacter({ character: { id: 'other-2', name: 'Other' } });
            return [];
        });

        expect(await constructMetzTeamExport('self-1')).toBeNull();
    });

    test('builds from the same character refreshed while cached profiles are read', async () => {
        mocks.characterData = baseCharacter();
        const refreshed = baseCharacter({ characterSkills: [{ skillHrid: '/skills/stamina', level: 90 }] });
        const { getProfileList, constructSelfPlayer } = await import('./combat-sim-export.js');
        getProfileList.mockImplementationOnce(async () => {
            // A reconnect re-sends the same character's data
            mocks.characterData = refreshed;
            return [];
        });

        expect(await constructMetzTeamExport('self-1')).not.toBeNull();
        expect(constructSelfPlayer.mock.calls.at(-1)[0]).toBe(refreshed);
    });

    test('refuses a team export when another game tab has replaced the intended character', async () => {
        mocks.characterData = baseCharacter({ character: { id: 'other-2', name: 'Other' } });
        expect(await constructMetzTeamExport('self-1')).toBeNull();
    });

    test('normalizes character IDs before excluding self and finding cached party profiles', async () => {
        mocks.characterData = baseCharacter({
            character: { id: 101, name: 'Self' },
            partyInfo: {
                partySlotMap: {
                    1: { characterID: '101' },
                    2: { characterID: 202 },
                },
            },
        });
        mocks.profiles = [{ characterID: '202', characterName: 'Teammate', profile: { characterSkills: [] } }];

        const team = await constructMetzTeamExport();
        const self = await constructMetzCharacterExport('101');

        expect(team.map((entry) => entry.name)).toEqual(['Self', 'Teammate']);
        expect(self.name).toBe('Self');
    });

    test('saved combat loadouts retain live tools and compact blank ability slots without reordering', () => {
        const character = {
            player: { equipment: [] },
            skilling: { enhancingTool: { itemHrid: '/items/celestial_enhancer', enhancementLevel: 10 } },
        };
        const overridden = applyLoadoutOverrideToMetzCharacter(character, {
            equipment: [{ itemLocationHrid: '/item_locations/body', itemHrid: '/items/plate_body' }],
            abilities: [
                { abilityHrid: '/abilities/aura', level: 50 },
                null,
                { abilityHrid: '/abilities/cleave', level: 60 },
            ],
            triggerMap: {},
            food: [],
            drinks: [],
        });

        expect(overridden.skilling).toEqual(character.skilling);
        expect(overridden.abilities).toEqual([
            { abilityHrid: '/abilities/aura', level: 50 },
            { abilityHrid: '/abilities/cleave', level: 60 },
        ]);
    });

    test('saved loadouts move displaced live gear into owned and consume selected spare gear once', () => {
        const character = {
            player: {
                equipment: [
                    {
                        itemLocationHrid: '/item_locations/body',
                        itemHrid: '/items/live_body',
                        enhancementLevel: 5,
                    },
                ],
            },
            abilities: [{ abilityHrid: '/abilities/live_skill', level: 50 }],
            owned: {
                capturedAt: '2026-09-22T00:00:00.000Z',
                equipment: [{ itemHrid: '/items/saved_body', enhancementLevel: 9, count: 2, equipped: false }],
                abilities: [{ abilityHrid: '/abilities/saved_skill', level: 60, equipped: false }],
            },
        };

        const overridden = applyLoadoutOverrideToMetzCharacter(character, {
            equipment: [
                {
                    itemLocationHrid: '/item_locations/body',
                    itemHrid: '/items/saved_body',
                    enhancementLevel: 9,
                },
            ],
            abilities: [{ abilityHrid: '/abilities/saved_skill', level: 60 }],
            triggerMap: {},
            food: [],
            drinks: [],
        });

        expect(overridden.owned).toEqual({
            capturedAt: '2026-09-22T00:00:00.000Z',
            equipment: expect.arrayContaining([
                { itemHrid: '/items/live_body', enhancementLevel: 5, count: 1, equipped: false },
                { itemHrid: '/items/saved_body', enhancementLevel: 9, count: 1, equipped: false },
            ]),
            abilities: [{ abilityHrid: '/abilities/live_skill', level: 50, equipped: false }],
        });
        expect(overridden.owned.equipment).toHaveLength(2);
    });
});

describe('full party export with a saved loadout on yourself', () => {
    // A cached profile_shared entry as websocket.js stores it under profile_list
    function teammateProfile(timestamp) {
        return {
            characterID: 'party-1',
            characterName: 'Teammate',
            timestamp,
            profile: {
                characterSkills: [{ skillHrid: '/skills/enhancing', level: 77 }],
                wearableItemMap: {
                    '/item_locations/main_hand': {
                        itemLocationHrid: '/item_locations/main_hand',
                        itemHrid: '/items/rippling_trident',
                        enhancementLevel: 7,
                    },
                },
            },
        };
    }

    // The parameters combat-score builds from a saved combat loadout
    const savedLoadout = {
        equipment: [
            {
                itemLocationHrid: '/item_locations/main_hand',
                itemHrid: '/items/blazing_trident',
                enhancementLevel: 10,
            },
        ],
        abilities: [null, { abilityHrid: '/abilities/fireball', level: 40 }, null, null, null],
        triggerMap: { '/abilities/fireball': [] },
        food: [{ itemHrid: '/items/star_fruit_yogurt' }, { itemHrid: '' }],
        drinks: [{ itemHrid: '/items/wisdom_coffee' }],
    };

    beforeEach(() => {
        mocks.characterData = baseCharacter({
            partyInfo: { partySlotMap: { 1: { characterID: 'self-1' }, 2: { characterID: 'party-1' } } },
        });
        mocks.onGamePage = true;
        mocks.inventory = [];
        mocks.itemDetailMap = {};
        mocks.mooPassBuffs = [];
        mocks.selfEquipment = [
            {
                itemLocationHrid: '/item_locations/main_hand',
                itemHrid: '/items/live_staff',
                enhancementLevel: 3,
            },
        ];
        mocks.selfAbilities = [{ abilityHrid: '/abilities/cleave', level: 60 }];
        mocks.partyEquipment = [
            {
                itemLocationHrid: '/item_locations/main_hand',
                itemHrid: '/items/rippling_trident',
                enhancementLevel: 7,
            },
        ];
        mocks.partySkills = [];
        mocks.profiles = [teammateProfile(Date.now() - 60 * 1000)];
    });

    test('your own entry wears the saved loadout instead of the live gear', async () => {
        const team = await constructMetzTeamExport('self-1', { selfLoadoutOverride: savedLoadout });

        expect(team[0].name).toBe('Self');
        expect(team[0].player.equipment).toEqual(savedLoadout.equipment);
        expect(team[0].abilities).toEqual([{ abilityHrid: '/abilities/fireball', level: 40 }]);
        expect(team[0].triggerMap).toEqual(savedLoadout.triggerMap);
        expect(team[0].food['/action_types/combat']).toEqual([{ itemHrid: '/items/star_fruit_yogurt' }]);
        expect(team[0].drinks['/action_types/combat']).toEqual([{ itemHrid: '/items/wisdom_coffee' }]);
    });

    test('every other member is exported exactly as without the override', async () => {
        const plain = await constructMetzTeamExport('self-1');
        const overridden = await constructMetzTeamExport('self-1', { selfLoadoutOverride: savedLoadout });

        expect(overridden).toHaveLength(2);
        expect(overridden[1]).toEqual(plain[1]);
        expect(overridden[1].player.equipment).toEqual(mocks.partyEquipment);
        expect(plain[0].player.equipment).toEqual(mocks.selfEquipment);
    });

    test('the override still refuses a team whose character was switched', async () => {
        expect(await constructMetzTeamExport('other-2', { selfLoadoutOverride: savedLoadout })).toBeNull();
    });

    test('the preview description names each other member with their profile status', () => {
        const now = Date.now();
        mocks.characterData = baseCharacter({
            partyInfo: {
                partySlotMap: {
                    1: { characterID: 'self-1' },
                    2: { characterID: 'party-1' },
                    3: { characterID: 'party-2', characterName: 'Ghost' },
                },
            },
        });
        const members = describePartyProfiles(
            mocks.characterData,
            [teammateProfile(now - 3 * 24 * 60 * 60 * 1000)],
            now
        );

        expect(members.map((member) => member.name)).toEqual(['Teammate', 'Ghost']);
        expect(members[0].status).toMatchObject({ found: true, gearless: false, stale: true });
        expect(members[0].warning).toMatchObject({ level: 'stale' });
        expect(members[1].status.found).toBe(false);
        expect(members[1].warning).toMatchObject({ level: 'missing' });
    });
});

describe('Metz export - MooPass expiry and speed gear', () => {
    const NECK = { equipmentDetail: { type: '/equipment_types/neck', noncombatStats: { skillingSpeed: 0.04 } } };
    const BAG = '/item_locations/inventory';

    beforeEach(() => {
        mocks.characterData = baseCharacter();
        mocks.onGamePage = true;
        mocks.inventory = [];
        mocks.itemDetailMap = { '/items/philosophers_necklace': NECK };
        mocks.mooPassBuffs = [];
        mocks.mooPassExpireTime = null;
        mocks.selfEquipment = [];
        mocks.selfAbilities = [];
        mocks.partyEquipment = [];
        mocks.partySkills = [];
        mocks.profiles = null;
        mocks.battleRoster = null;
    });

    test('hasMooPass follows the expiry even when the buff list is empty', async () => {
        mocks.mooPassExpireTime = Date.now() + 3600_000;
        expect((await constructMetzCharacterExport()).hasMooPass).toBe(true);
        mocks.mooPassExpireTime = Date.now() - 1000;
        mocks.mooPassBuffs = [{ typeHrid: '/buff_types/wisdom' }];
        expect((await constructMetzCharacterExport()).hasMooPass).toBe(false);
    });

    test('hasMooPass reads the bridged ISO expiry on a simulator page', async () => {
        mocks.onGamePage = false;
        mocks.characterData = baseCharacter({
            characterInfo: { mooPassExpireTime: new Date(Date.now() + 3600_000).toISOString() },
        });
        expect((await constructMetzCharacterExport()).hasMooPass).toBe(true);
    });

    test('worn speed gear is exported and deduped against the bag at the highest level', async () => {
        mocks.selfEquipment = [
            {
                itemLocationHrid: '/item_locations/neck',
                itemHrid: '/items/philosophers_necklace',
                enhancementLevel: 5,
            },
        ];
        mocks.inventory = [
            { itemHrid: '/items/philosophers_necklace', enhancementLevel: 9, itemLocationHrid: BAG, count: 1 },
            { itemHrid: '/items/philosophers_necklace', enhancementLevel: 2, itemLocationHrid: BAG, count: 1 },
        ];
        const character = await constructMetzCharacterExport();
        expect(character.skilling.speedGear).toEqual([
            { itemHrid: '/items/philosophers_necklace', enhancementLevel: 9 },
        ]);
    });

    test('self export carries saved loadouts, teammates never do', async () => {
        mocks.characterData = baseCharacter({
            partyInfo: { partySlotMap: { a: { characterID: 'party-1' } } },
        });
        mocks.loadouts = [{ id: '12', name: 'Dungeon' }];

        const team = await constructMetzTeamExport();

        expect(team[0].loadouts).toEqual(mocks.loadouts);
        expect('loadouts' in team.find((p) => p.name === 'Teammate')).toBe(false);
    });

    test('self export omits loadouts when there are none, and the one-loadout override keeps them', async () => {
        mocks.loadouts = [];
        expect('loadouts' in (await constructMetzCharacterExport())).toBe(false);

        mocks.loadouts = [{ id: '12', name: 'Dungeon' }];
        const team = await constructMetzTeamExport(null, {
            selfLoadoutOverride: { equipment: [], abilities: [], triggerMap: {}, food: [], drinks: [] },
        });
        expect(team[0].loadouts).toEqual(mocks.loadouts);
    });

    test('worn speed gear alone is exported', async () => {
        mocks.selfEquipment = [
            {
                itemLocationHrid: '/item_locations/neck',
                itemHrid: '/items/philosophers_necklace',
                enhancementLevel: 5,
            },
        ];
        const character = await constructMetzCharacterExport();
        expect(character.skilling.speedGear).toEqual([
            { itemHrid: '/items/philosophers_necklace', enhancementLevel: 5 },
        ]);
    });

    test('a teammate gets speed gear from wearableItemMap keyed by full location hrid', async () => {
        mocks.characterData = baseCharacter({ partyInfo: { partySlotMap: { a: { characterID: 'party-1' } } } });
        mocks.profiles = [
            {
                characterID: 'party-1',
                characterName: 'Teammate',
                profile: {
                    characterSkills: [],
                    wearableItemMap: {
                        '/item_locations/neck': { itemHrid: '/items/philosophers_necklace', enhancementLevel: 7 },
                    },
                },
            },
        ];
        const team = await constructMetzTeamExport('self-1');
        expect(team[1].skilling.speedGear).toEqual([{ itemHrid: '/items/philosophers_necklace', enhancementLevel: 7 }]);
    });
});

describe('partymates in their stored View Loadout', () => {
    const HOUR = 60 * 60 * 1000;
    const gear = (itemHrid) => ({
        '/item_locations/main_hand': { itemLocationHrid: '/item_locations/main_hand', itemHrid, enhancementLevel: 5 },
    });
    const profileOf = (id, name, itemHrid, ageMs) => ({
        characterID: id,
        characterName: name,
        timestamp: Date.now() - ageMs,
        profile: { characterSkills: [], wearableItemMap: gear(itemHrid) },
    });
    const loadoutOf = (itemHrid, ageMs) => ({
        capturedAt: Date.now() - ageMs,
        loadout: {
            actionTypeHrid: '/action_types/combat',
            wearableItemMap: gear(itemHrid),
            equippedAbilities: [
                { abilityHrid: '/abilities/b', level: 20, slotNumber: 2 },
                { abilityHrid: '/abilities/a', level: 30, slotNumber: 1 },
            ],
            combatConsumables: [{ itemHrid: '/items/spaceberry_cake' }],
            abilityCombatTriggersMap: {},
            consumableCombatTriggersMap: {},
        },
    });
    /** The profile constructPartyPlayer was handed for a member, and the battle data beside it */
    const builtFor = (id) => {
        const call = constructPartyPlayer.mock.calls.find(([profile]) => String(profile.characterID) === id);
        return call ? { profile: call[0], battle: call[2] } : null;
    };
    const weaponOf = (id) => builtFor(id).profile.profile.wearableItemMap['/item_locations/main_hand'].itemHrid;

    beforeEach(() => {
        constructPartyPlayer.mockClear();
        mocks.onGamePage = true;
        mocks.characterData = baseCharacter({
            partyInfo: {
                partySlotMap: {
                    1: { characterID: 'self-1' },
                    2: { characterID: 'party-1' },
                    3: { characterID: 'party-2' },
                },
            },
        });
        mocks.battleRoster = null;
        mocks.partyLoadouts = {};
        mocks.profiles = [
            profileOf('party-1', 'Ann', '/items/ann_profile_sword', 2 * HOUR),
            profileOf('party-2', 'Bob', '/items/bob_profile_bow', 2 * HOUR),
        ];
    });

    test('each member wears their own loadout, by id, whatever the store order', async () => {
        mocks.partyLoadouts = {
            'self-1|party-2': loadoutOf('/items/bob_loadout_bow', HOUR / 2),
            'self-1|party-1': loadoutOf('/items/ann_loadout_sword', HOUR / 2),
        };
        const warnings = [];

        await constructMetzTeamExport('self-1', { warnings });

        expect(weaponOf('party-1')).toBe('/items/ann_loadout_sword');
        expect(weaponOf('party-2')).toBe('/items/bob_loadout_bow');
        // The loadout's own consumables and slot order, never the live battle's
        expect(builtFor('party-1').battle.players).toEqual([
            expect.objectContaining({
                character: { id: 'party-1' },
                combatConsumables: [{ itemHrid: '/items/spaceberry_cake' }],
            }),
        ]);
        expect(builtFor('party-1').profile.profile.equippedAbilities.map((row) => row.abilityHrid)).toEqual([
            '/abilities/a',
            '/abilities/b',
        ]);
        expect(warnings).toEqual([
            expect.objectContaining({ name: 'Ann', level: 'loadout', text: expect.stringContaining('View Loadout') }),
            expect.objectContaining({ name: 'Bob', level: 'loadout', text: expect.stringContaining('View Loadout') }),
        ]);
    });

    test('two members with the same name still get their own loadouts by id', async () => {
        mocks.profiles = [
            profileOf('party-1', 'Twin', '/items/ann_profile_sword', 2 * HOUR),
            profileOf('party-2', 'Twin', '/items/bob_profile_bow', 2 * HOUR),
        ];
        mocks.partyLoadouts = { 'self-1|party-2': loadoutOf('/items/bob_loadout_bow', HOUR / 2) };

        await constructMetzTeamExport('self-1');

        expect(weaponOf('party-1')).toBe('/items/ann_profile_sword');
        expect(weaponOf('party-2')).toBe('/items/bob_loadout_bow');
    });

    test('a loadout older than the profile is passed over, and the warning says so', async () => {
        mocks.partyLoadouts = { 'self-1|party-1': loadoutOf('/items/ann_loadout_sword', 3 * HOUR) };
        const warnings = [];

        await constructMetzTeamExport('self-1', { warnings });

        expect(weaponOf('party-1')).toBe('/items/ann_profile_sword');
        expect(warnings).toEqual([
            expect.objectContaining({
                name: 'Ann',
                level: 'loadout',
                text: expect.stringContaining('older than their profile (2 h old)'),
            }),
        ]);
    });

    test('an older loadout is passed over even when the profile shows no gear', async () => {
        mocks.profiles = [
            {
                characterID: 'party-1',
                characterName: 'Ann',
                timestamp: Date.now() - HOUR,
                profile: { characterSkills: [], hideWearableItems: true, wearableItemMap: {} },
            },
        ];
        mocks.partyLoadouts = { 'self-1|party-1': loadoutOf('/items/ann_loadout_sword', 3 * HOUR) };
        const warnings = [];

        await constructMetzTeamExport('self-1', { warnings });

        expect(builtFor('party-1').profile.profile.wearableItemMap).toEqual({});
        expect(warnings[0]).toMatchObject({
            level: 'gearless',
            text: expect.stringContaining('older than their profile'),
        });
    });

    test('a newer loadout over a day-old profile keeps the stale warning for the levels', async () => {
        mocks.profiles = [profileOf('party-1', 'Ann', '/items/ann_profile_sword', 30 * HOUR)];
        mocks.partyLoadouts = { 'self-1|party-1': loadoutOf('/items/ann_loadout_sword', HOUR) };
        const warnings = [];

        await constructMetzTeamExport('self-1', { warnings });

        expect(weaponOf('party-1')).toBe('/items/ann_loadout_sword');
        expect(warnings[0]).toMatchObject({ level: 'stale', text: expect.stringContaining('refresh their levels') });
    });

    test('a loadout stored for someone no longer in the party adds nobody', async () => {
        mocks.characterData = baseCharacter({
            partyInfo: { partySlotMap: { 1: { characterID: 'self-1' }, 2: { characterID: 'party-1' } } },
        });
        mocks.partyLoadouts = { 'self-1|party-2': loadoutOf('/items/bob_loadout_bow', HOUR / 2) };

        const team = await constructMetzTeamExport('self-1');

        expect(team.map((entry) => entry.name)).toEqual(['Self', 'Ann']);
        expect(builtFor('party-2')).toBeNull();
    });

    test('a loadout stored by another character is not exported for this one', async () => {
        mocks.partyLoadouts = { 'other-self|party-1': loadoutOf('/items/ann_loadout_sword', HOUR / 2) };

        await constructMetzTeamExport('self-1');

        expect(weaponOf('party-1')).toBe('/items/ann_profile_sword');
    });

    test('without a profile the member is still left out, loadout or not', async () => {
        mocks.profiles = [profileOf('party-1', 'Ann', '/items/ann_profile_sword', 2 * HOUR)];
        mocks.partyLoadouts = { 'self-1|party-2': loadoutOf('/items/bob_loadout_bow', HOUR / 2) };
        const warnings = [];

        const team = await constructMetzTeamExport('self-1', { warnings });

        expect(team).toHaveLength(2);
        expect(warnings).toEqual([expect.objectContaining({ level: 'missing' })]);
    });

    test('describePartyProfiles weighs loadouts only when asked (the Shykai preview stays profile-only)', () => {
        mocks.partyLoadouts = { 'self-1|party-1': loadoutOf('/items/ann_loadout_sword', HOUR / 2) };

        const plain = describePartyProfiles(mocks.characterData, mocks.profiles);
        const metz = describePartyProfiles(mocks.characterData, mocks.profiles, Date.now(), { sharedLoadouts: true });

        expect(plain[0]).toMatchObject({ gearSource: 'profile', loadout: null, warning: null });
        expect(metz[0]).toMatchObject({ gearSource: 'loadout', loadoutCapturedAt: expect.any(Number) });
    });
});
