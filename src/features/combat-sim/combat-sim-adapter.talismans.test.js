/**
 * Where a sim player's talismans come from, for every way the adapter builds one.
 *
 * The worst outcome is the wrong player's talismans (the local player's on a party member), or talismans on a
 * server that has none. Each builder is checked to take its own source only, and the chain adapter -> engine
 * Player is checked end to end with a mocked host.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    clientData: null,
    characterData: null,
    equipment: new Map(),
    slotted: [],
    owned: [],
    testServer: true,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => mocks.clientData,
        getSkills: () => null,
        getCharacterGuildBuffLevel: () => 0,
        getGuildBuildingLevel: () => 0,
        getGuildShrineCapturedAt: () => null,
        isGuildShrineHydrated: () => false,
        getEquippedAbilities: () => [],
        getCommunityBuffLevel: () => 0,
        getAchievementBuffs: () => [],
        getMooPassBuffs: () => [],
        getActiveTaskMonsterHrids: () => [],
        getActiveTaskMonsterRemaining: () => ({}),
        getSlottedTalismans: () => mocks.slotted.map((t) => ({ ...t })),
        getCharacterTalismans: () => mocks.owned.map((t) => ({ ...t })),
        getPartyMembers: () => ({ members: [], source: 'none', updatedAt: 1 }),
        battleData: null,
        get characterData() {
            return mocks.characterData;
        },
        get characterEquipment() {
            return mocks.equipment;
        },
        personalActionTypeBuffsMap: null,
    },
}));
vi.mock('../../core/storage.js', () => ({ default: { getJSON: async () => [] } }));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => null, getSettingValue: (_k, d) => d } }));
vi.mock('../combat/loadout-snapshot.js', () => ({
    default: { getAllSnapshots: () => [], resolveEquipment: (snapshot) => snapshot.equipment || [] },
}));
vi.mock('../../api/marketplace.js', () => ({ default: {} }));
vi.mock('../market/expected-value-calculator.js', () => ({ default: {} }));
vi.mock('../../utils/dungeon-level-gap.js', () => ({ partyLevelGaps: () => ({}) }));
vi.mock('../../utils/market-data.js', () => ({ getItemPrice: () => 0, getItemPrices: () => ({}) }));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({ getProductionCost: () => 0 }));
vi.mock('../../utils/enhancement-pricing.js', async (importOriginal) => ({
    ...(await importOriginal()),
    getProductionCost: () => 0,
}));
vi.mock('../../utils/view-loadout.js', () => ({
    VIEW_LOADOUT_CONTEXT: { Party: 'party', GuildTrial: 'guild_trial' },
    getLoadout: () => null,
}));
vi.mock('../../utils/game-server.js', () => ({ isTestServer: () => mocks.testServer }));

const {
    buildPlayerDTO,
    buildPlayerDTOFromProfile,
    applySharedLoadoutToDTO,
    applyLoadoutSnapshotToDTO,
    buildGameDataPayload,
} = await import('./combat-sim-adapter.js');
const { default: Player } = await import('./engine/player.js');
const { setGameData } = await import('./engine/game-data.js');
const { BELT_ITEMS, TALISMAN_ENHANCEMENT_TABLE } = await import('../../__fixtures__/talisman-bonuses.js');
const { COMBAT_MODIFIER_DETAILS } = await import('../../__fixtures__/talisman-combat-modifiers.js');

const BELT = '/items/large_talisman_belt';
const ARMOR = (grade, slotIndex) => ({
    slotIndex,
    talismanTypeHrid: '/talisman_types/combat',
    modifiers: [{ hrid: '/talisman_modifiers/armor', grade }],
});

beforeEach(() => {
    mocks.testServer = true;
    mocks.slotted = [];
    mocks.owned = [];
    mocks.equipment = new Map();
    mocks.characterData = { character: { id: 1, name: 'Me' }, characterSkills: [], characterHouseRoomMap: {} };
    mocks.clientData = {
        itemDetailMap: {
            ...BELT_ITEMS,
            '/items/test_body': {
                name: 'Test Body',
                equipmentDetail: { type: '/equipment_types/body', combatStats: { armor: 10 } },
            },
        },
        abilityDetailMap: {},
        enhancementLevelTotalBonusMultiplierTable: TALISMAN_ENHANCEMENT_TABLE,
        talismanModifierDetailMap: COMBAT_MODIFIER_DETAILS,
    };
});

/** What the engine builds from a DTO, under the payload the adapter makes */
function armorOf(dto) {
    setGameData(buildGameDataPayload());
    const player = Player.createFromDTO({ ...dto, food: dto.food || [], drinks: dto.drinks || [] });
    player.updateCombatDetails();
    return player.combatDetails.combatStats.armor;
}

function wearBelt() {
    mocks.equipment = new Map([
        ['/item_locations/belt', { itemHrid: BELT, itemLocationHrid: '/item_locations/belt', enhancementLevel: 0 }],
        [
            '/item_locations/body',
            { itemHrid: '/items/test_body', itemLocationHrid: '/item_locations/body', enhancementLevel: 0 },
        ],
    ]);
}

describe('game data payload', () => {
    test('says talismans exist on the test server and not elsewhere', () => {
        expect(buildGameDataPayload().talismansEnabled).toBe(true);
        mocks.testServer = false;
        expect(buildGameDataPayload().talismansEnabled).toBe(false);
    });
});

describe('the local player', () => {
    test('live: the slotted talismans reach the engine, scaled by the belt', () => {
        wearBelt();
        mocks.slotted = [ARMOR(6, 1)];
        const dto = buildPlayerDTO();
        expect(dto.talismans).toEqual([{ slotIndex: 1, modifiers: [{ hrid: '/talisman_modifiers/armor', grade: 6 }] }]);
        // Large belt +0: power 0.2, grade 6 armor is 8
        expect(armorOf(dto)).toBeCloseTo(10 + 8 * 1.2, 9);
    });

    test('live: no talismans leaves the field off, and the same DTO on a live server gets none', () => {
        wearBelt();
        expect(buildPlayerDTO().talismans).toBeUndefined();
        mocks.slotted = [ARMOR(6, 1)];
        const dto = buildPlayerDTO();
        mocks.testServer = false;
        expect(armorOf(dto)).toBe(10);
    });

    test('the talisman-only mechanics reach the worker player through the structured clone, and not on a live server', () => {
        wearBelt();
        const line = (name) => `/talisman_modifiers/${name}`;
        mocks.slotted = [
            {
                slotIndex: 1,
                talismanTypeHrid: '/talisman_types/combat',
                modifiers: ['echo', 'smite', 'shatter', 'fortify'].map((name) => ({ hrid: line(name), grade: 6 })),
            },
            {
                slotIndex: 2,
                talismanTypeHrid: '/talisman_types/combat',
                modifiers: [{ hrid: line('overkill'), grade: 6 }],
            },
        ];
        // The runner posts the DTO to the worker, which clones it again before building the Player
        const dto = structuredClone(structuredClone(buildPlayerDTO()));
        setGameData(buildGameDataPayload());
        const player = Player.createFromDTO({ ...dto, food: dto.food || [], drinks: dto.drinks || [] });
        player.updateCombatDetails();
        // Large belt +0: power 0.2, so each grade-6 value is scaled by 1.2
        for (const name of ['echo', 'smite', 'shatter', 'fortify', 'overkill']) {
            const grade6 = COMBAT_MODIFIER_DETAILS[line(name)].gradeValues[5];
            expect(player.talismanMechanics[name]).toBeCloseTo(grade6 * 1.2, 12);
        }

        mocks.testServer = false;
        setGameData(buildGameDataPayload());
        const live = Player.createFromDTO({ ...dto, food: dto.food || [], drinks: dto.drinks || [] });
        live.updateCombatDetails();
        expect(live.talismanMechanics).toEqual({});
    });

    test('a loadout: its own talismanIdMap, resolved against what is owned', () => {
        wearBelt();
        mocks.owned = [
            { id: 7, ...ARMOR(3, 0) },
            { id: 8, ...ARMOR(6, 1) },
        ];
        mocks.slotted = [mocks.owned[1]];
        const dto = buildPlayerDTO();
        applyLoadoutSnapshotToDTO(
            dto,
            { name: 'x', equipment: [], talismanIdMap: { 1: 7, 2: 0, 3: 0 } },
            { itemDetailMap: mocks.clientData.itemDetailMap, abilityDetailMap: {} }
        );
        expect(dto.talismans).toEqual([{ slotIndex: 1, modifiers: [{ hrid: '/talisman_modifiers/armor', grade: 3 }] }]);
    });

    test('a loadout with an all-zero talismanIdMap drops the live talismans', () => {
        mocks.slotted = [ARMOR(6, 1)];
        const dto = { equipment: {}, talismans: [{ slotIndex: 1, modifiers: [] }] };
        applyLoadoutSnapshotToDTO(
            dto,
            { name: 'x', equipment: [], talismanIdMap: { 1: 0, 2: 0, 3: 0 } },
            { itemDetailMap: mocks.clientData.itemDetailMap, abilityDetailMap: {} }
        );
        expect(dto.talismans).toBeUndefined();
    });
});

describe('another player', () => {
    const profileWith = (extra) => ({
        characterID: 'other',
        profile: {
            characterSkills: [],
            wearableItemMap: {
                '/item_locations/belt': { itemHrid: BELT, enhancementLevel: 0 },
                '/item_locations/body': { itemHrid: '/items/test_body', enhancementLevel: 0 },
            },
            ...extra,
        },
    });

    test("a party member takes the talismans of their own profile, never the local player's", () => {
        mocks.slotted = [ARMOR(6, 1), ARMOR(6, 2)];
        const dto = buildPlayerDTOFromProfile(profileWith({ slottedTalismans: [{ ...ARMOR(1, 1), id: undefined }] }));
        expect(dto.talismans).toEqual([{ slotIndex: 1, modifiers: [{ hrid: '/talisman_modifiers/armor', grade: 1 }] }]);
        expect(armorOf(dto)).toBeCloseTo(10 + 2 * 1.2, 9);
    });

    test('a profile with no slottedTalismans field carries none, even when the local player wears some', () => {
        mocks.slotted = [ARMOR(6, 1)];
        const dto = buildPlayerDTOFromProfile(profileWith({}));
        expect(dto.talismans).toBeUndefined();
        expect(armorOf(dto)).toBe(10);
    });

    test('malformed records are dropped (unslotted, no lines, not a list)', () => {
        const dto = buildPlayerDTOFromProfile(
            profileWith({ slottedTalismans: [ARMOR(1, 0), { slotIndex: 2 }, null, ARMOR(2, 3)] })
        );
        expect(dto.talismans).toEqual([{ slotIndex: 3, modifiers: [{ hrid: '/talisman_modifiers/armor', grade: 2 }] }]);
        expect(buildPlayerDTOFromProfile(profileWith({ slottedTalismans: 'x' })).talismans).toBeUndefined();
    });

    test("a shared loadout uses its own slottedTalismans; one that lists none drops the profile's", () => {
        const profileDto = buildPlayerDTOFromProfile(profileWith({ slottedTalismans: [ARMOR(1, 1)] }));
        expect(profileDto.talismans).toHaveLength(1);

        const withTalismans = structuredClone(profileDto);
        applySharedLoadoutToDTO(
            withTalismans,
            { wearableItemMap: {}, slottedTalismans: [ARMOR(5, 2)] },
            mocks.clientData
        );
        expect(withTalismans.talismans).toEqual([
            { slotIndex: 2, modifiers: [{ hrid: '/talisman_modifiers/armor', grade: 5 }] },
        ]);

        const silent = structuredClone(profileDto);
        applySharedLoadoutToDTO(silent, { wearableItemMap: {} }, mocks.clientData);
        expect(silent.talismans).toBeUndefined();

        const empty = structuredClone(profileDto);
        applySharedLoadoutToDTO(empty, { wearableItemMap: {}, slottedTalismans: [] }, mocks.clientData);
        expect(empty.talismans).toBeUndefined();
    });
});
