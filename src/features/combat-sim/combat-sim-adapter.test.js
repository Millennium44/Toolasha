/**
 * Tests for the guild shrine helpers in the combat sim adapter.
 *
 * The server sends resolved guild buffs and never the levels behind them, so
 * every "what would one more level do" answer rests on this arithmetic being the
 * same arithmetic the game does. It is checked against the values a live client
 * dump showed: Force combat damage is 0.003 × level as a ratio boost, Scholar
 * wisdom 0.005 × level as a flat boost.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    clientData: null,
    guildBuffLevels: {},
    characterData: null,
    equippedAbilities: [],
    equipment: new Map(),
    shrineCapturedAt: null,
    shrineHydrated: false,
    personalActionTypeBuffsMap: null,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => mocks.clientData,
        getCharacterGuildBuffLevel: (hrid) => mocks.guildBuffLevels[hrid] || 0,
        getGuildShrineCapturedAt: () => mocks.shrineCapturedAt,
        isGuildShrineHydrated: () => mocks.shrineHydrated,
        getEquippedAbilities: () => mocks.equippedAbilities.map((entry) => ({ ...entry })),
        getCommunityBuffLevel: () => 0,
        getAchievementBuffs: () => [],
        get characterData() {
            return mocks.characterData;
        },
        get characterEquipment() {
            return mocks.equipment;
        },
        get personalActionTypeBuffsMap() {
            return mocks.personalActionTypeBuffsMap;
        },
    },
}));
vi.mock('../../core/storage.js', () => ({ default: {} }));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => null, getSettingValue: (_k, d) => d } }));
vi.mock('../combat/loadout-snapshot.js', () => ({ default: {} }));
vi.mock('../../api/marketplace.js', () => ({ default: {} }));
vi.mock('../market/expected-value-calculator.js', () => ({ default: {} }));
vi.mock('../../utils/dungeon-level-gap.js', () => ({ partyLevelGaps: () => ({}) }));

const {
    getGuildBuffDetailMap,
    guildBuffMaxLevel,
    synthesizeGuildBuffs,
    applyGuildBuffLevel,
    readGuildShrineLevels,
    readGuildShrineSnapshot,
    buildPlayerDTO,
} = await import('./combat-sim-adapter.js');

const FORCE = {
    hrid: '/guild_buffs/force_combat',
    shrineHrid: '/guild_shrines/force',
    isCombat: true,
    buffs: [
        {
            typeHrid: '/buff_types/damage',
            ratioBoost: 0.003,
            ratioBoostLevelBonus: 0.003,
            flatBoost: 0,
            flatBoostLevelBonus: 0,
        },
    ],
    levelCosts: { 1: { guildTokenCost: 10, creditCosts: [] }, 2: { guildTokenCost: 20, creditCosts: [] } },
};

const SCHOLAR_SKILLING = {
    hrid: '/guild_buffs/scholar_skilling',
    shrineHrid: '/guild_shrines/scholar',
    isCombat: false,
    buffs: [
        {
            typeHrid: '/buff_types/wisdom',
            ratioBoost: 0,
            ratioBoostLevelBonus: 0,
            flatBoost: 0.005,
            flatBoostLevelBonus: 0.005,
        },
    ],
    levelCosts: { 1: {}, 2: {}, 3: {} },
};

beforeEach(() => {
    mocks.clientData = {
        guildBuffDetailMap: {
            '/guild_buffs/force_combat': FORCE,
            '/guild_buffs/scholar_skilling': SCHOLAR_SKILLING,
        },
        abilityDetailMap: {
            '/abilities/aura': { isSpecialAbility: true },
            '/abilities/cleave': {},
            '/abilities/toughness': {},
            '/abilities/fireball': {},
        },
        itemDetailMap: {},
    };
    mocks.guildBuffLevels = {};
    mocks.characterData = null;
    mocks.equippedAbilities = [];
    mocks.equipment = new Map();
    mocks.shrineCapturedAt = null;
    mocks.shrineHydrated = false;
    mocks.personalActionTypeBuffsMap = null;
});

describe('guild shrine buff synthesis', () => {
    test('reads the detail map, and survives data not having arrived', () => {
        expect(Object.keys(getGuildBuffDetailMap())).toHaveLength(2);
        mocks.clientData = null;
        expect(getGuildBuffDetailMap()).toEqual({});
    });

    test('max level comes from the level cost table', () => {
        expect(guildBuffMaxLevel(FORCE)).toBe(2);
        expect(guildBuffMaxLevel(SCHOLAR_SKILLING)).toBe(3);
        expect(guildBuffMaxLevel(undefined)).toBe(0);
    });

    test('a level resolves to base + (level − 1) × bonus', () => {
        expect(synthesizeGuildBuffs(FORCE, 1)[0].ratioBoost).toBeCloseTo(0.003, 10);
        expect(synthesizeGuildBuffs(FORCE, 7)[0].ratioBoost).toBeCloseTo(0.021, 10);
        expect(synthesizeGuildBuffs(SCHOLAR_SKILLING, 20)[0].flatBoost).toBeCloseTo(0.1, 10);
    });

    test('level bonuses are zeroed, so a reader that applies them cannot double-count', () => {
        const [buff] = synthesizeGuildBuffs(FORCE, 5);
        expect(buff.ratioBoostLevelBonus).toBe(0);
        expect(buff.flatBoostLevelBonus).toBe(0);
        expect(buff.duration).toBe(0);
    });

    test('level 0 grants nothing at all', () => {
        expect(synthesizeGuildBuffs(FORCE, 0)).toEqual([]);
        expect(synthesizeGuildBuffs(null, 5)).toEqual([]);
    });

    test('applying a level replaces that shrine and leaves the rest of the array alone', () => {
        const current = [
            { typeHrid: '/buff_types/damage', ratioBoost: 0.009, flatBoost: 0 },
            { typeHrid: '/buff_types/attack_speed', ratioBoost: 0.02, flatBoost: 0 },
        ];
        const updated = applyGuildBuffLevel(current, FORCE, 4);

        expect(updated.find((b) => b.typeHrid === '/buff_types/attack_speed')).toEqual(current[1]);
        expect(updated.filter((b) => b.typeHrid === '/buff_types/damage')).toHaveLength(1);
        expect(updated.find((b) => b.typeHrid === '/buff_types/damage').ratioBoost).toBeCloseTo(0.012, 10);
        // The caller's array is theirs
        expect(current[0].ratioBoost).toBe(0.009);
    });

    test('applying to a shrine that grants nothing yet adds it', () => {
        expect(applyGuildBuffLevel([], FORCE, 1)).toHaveLength(1);
        expect(applyGuildBuffLevel([], FORCE, 0)).toEqual([]);
    });

    test('shrine levels are read for every buff, unpurchased ones included', () => {
        mocks.guildBuffLevels = { '/guild_buffs/force_combat': 6 };
        expect(readGuildShrineLevels()).toEqual({
            '/guild_buffs/force_combat': 6,
            '/guild_buffs/scholar_skilling': 0,
        });
    });

    test('the snapshot says how old the reading is, without changing the levels', () => {
        mocks.guildBuffLevels = { '/guild_buffs/force_combat': 6 };
        mocks.shrineCapturedAt = 1_700_000_000_000;
        mocks.shrineHydrated = true;

        const snapshot = readGuildShrineSnapshot();
        expect(snapshot.levels).toEqual(readGuildShrineLevels());
        expect(snapshot.capturedAt).toBe(1_700_000_000_000);
        expect(snapshot.hydrated).toBe(true);
    });
});

/**
 * The player DTO's equipped kit.
 *
 * The sim used to read `characterData.combatUnit.combatAbilities` directly,
 * which is the field login writes once and nothing updated afterwards. Reading
 * it is what made a post-labyrinth sim run the kit from hours earlier, so the
 * DTO now goes through the data-manager getter that every ability message feeds.
 */
describe('the abilities a player DTO carries', () => {
    beforeEach(() => {
        mocks.characterData = {
            characterSkills: [],
            // Deliberately stale: this is the login-time kit the lab moved past
            combatUnit: {
                combatAbilities: [
                    { abilityHrid: '/abilities/aura', slotNumber: 1, level: 10 },
                    { abilityHrid: '/abilities/fireball', slotNumber: 2, level: 8 },
                ],
            },
        };
    });

    test('come from the live kit, not the stale field beside it', () => {
        mocks.equippedAbilities = [
            { abilityHrid: '/abilities/aura', slotNumber: 1, level: 10 },
            { abilityHrid: '/abilities/cleave', slotNumber: 2, level: 12 },
            { abilityHrid: '/abilities/toughness', slotNumber: 3, level: 11 },
        ];

        const dto = buildPlayerDTO();

        expect(dto.abilities[0]).toMatchObject({ hrid: '/abilities/aura' });
        expect(
            dto.abilities
                .slice(1)
                .filter(Boolean)
                .map((a) => a.hrid)
        ).toEqual(['/abilities/cleave', '/abilities/toughness']);
        expect(dto.abilities.some((a) => a?.hrid === '/abilities/fireball')).toBe(false);
    });

    test('always fill five slots, special first', () => {
        mocks.equippedAbilities = [{ abilityHrid: '/abilities/cleave', slotNumber: 2, level: 1 }];

        const dto = buildPlayerDTO();
        expect(dto.abilities).toHaveLength(5);
        expect(dto.abilities[0]).toBeNull();
        expect(dto.abilities[1].hrid).toBe('/abilities/cleave');
    });
});

describe('the scrolls a player DTO starts from', () => {
    beforeEach(() => {
        mocks.characterData = { characterSkills: [] };
    });

    test('are the combat scrolls the player has active', () => {
        mocks.personalActionTypeBuffsMap = {
            '/action_types/combat': [
                { typeHrid: '/buff_types/damage', ratioBoost: 0.08 },
                { typeHrid: '/buff_types/wisdom', flatBoost: 0.2 },
                // A non-combat-scroll buff on the combat map is not carried in
                { typeHrid: '/buff_types/gourmet', flatBoost: 0.16 },
            ],
        };

        expect(buildPlayerDTO().scrollBuffs).toEqual(['/buff_types/damage', '/buff_types/wisdom']);
    });

    test('are empty when the player carries none', () => {
        mocks.personalActionTypeBuffsMap = { '/action_types/combat': [] };
        expect(buildPlayerDTO().scrollBuffs).toEqual([]);
    });

    test('are empty when the game never sent a scroll map', () => {
        mocks.personalActionTypeBuffsMap = null;
        expect(buildPlayerDTO().scrollBuffs).toEqual([]);
    });
});
