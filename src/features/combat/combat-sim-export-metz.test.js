import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    characterData: null,
    onGamePage: true,
    inventory: [],
    itemDetailMap: {},
    mooPassBuffs: [],
    selfEquipment: [],
    selfAbilities: [],
    partyEquipment: [],
    partySkills: [],
    profiles: null,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterData() {
            return mocks.onGamePage ? mocks.characterData : null;
        },
        getInventory: vi.fn(() => mocks.inventory),
        getMooPassBuffs: vi.fn(() => mocks.mooPassBuffs),
    },
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
} from './combat-sim-export-metz.js';

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
        mocks.inventory = [];
        mocks.itemDetailMap = {};
        mocks.mooPassBuffs = [];
        mocks.selfEquipment = [];
        mocks.selfAbilities = [];
        mocks.partyEquipment = [];
        mocks.partySkills = [];
        mocks.profiles = null;
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
