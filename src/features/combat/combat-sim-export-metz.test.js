import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    characterData: null,
    inventory: [],
    itemDetailMap: {},
    mooPassBuffs: [],
    selfEquipment: [],
    selfAbilities: [],
    partyEquipment: [],
    partySkills: [],
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInventory: vi.fn(() => mocks.inventory),
        getMooPassBuffs: vi.fn(() => mocks.mooPassBuffs),
    },
}));

vi.mock('./combat-sim-export.js', () => ({
    getCharacterData: vi.fn(() => mocks.characterData),
    getClientData: vi.fn(() => ({ itemDetailMap: mocks.itemDetailMap })),
    getBattleData: vi.fn(() => null),
    getProfileList: vi.fn(async () => [
        { characterID: 'party-1', characterName: 'Teammate', profile: { characterSkills: mocks.partySkills } },
    ]),
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
        mocks.inventory = [];
        mocks.itemDetailMap = {};
        mocks.mooPassBuffs = [];
        mocks.selfEquipment = [];
        mocks.selfAbilities = [];
        mocks.partyEquipment = [];
        mocks.partySkills = [];
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
            characterAbilities: [
                { abilityHrid: '/abilities/cleave', level: 60 },
                { abilityHrid: '/abilities/rejuvenate', level: 45 },
            ],
            combatUnit: { combatAbilities: [{ abilityHrid: '/abilities/cleave', level: 60 }] },
        });
        mocks.itemDetailMap = {
            '/items/philosophers_necklace': {
                equipmentDetail: { type: '/equipment_types/neck', noncombatStats: { skillingSpeed: 0.04 } },
            },
            '/items/plate_body': { equipmentDetail: { type: '/equipment_types/body' } },
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

    test('saved combat loadouts retain live tools and preserve their selected ability holes', () => {
        const character = {
            player: { equipment: [] },
            skilling: { enhancingTool: { itemHrid: '/items/celestial_enhancer', enhancementLevel: 10 } },
        };
        const overridden = applyLoadoutOverrideToMetzCharacter(character, {
            equipment: [{ itemLocationHrid: '/item_locations/body', itemHrid: '/items/plate_body' }],
            abilities: [null, { abilityHrid: '/abilities/cleave', level: 60 }, null],
            triggerMap: {},
            food: [],
            drinks: [],
        });

        expect(overridden.skilling).toEqual(character.skilling);
        expect(overridden.abilities).toEqual([{ abilityHrid: '/abilities/cleave', level: 60 }]);
    });
});
