/**
 * Tuning an ability's trigger on how hurt the party is: a heal gated on the lowest ally's HP %, or on the
 * caster's own HP. Before this the tuner only read enemy HP on abilities, so a healer whose Quick Aid
 * never fired (its row asked for the lowest HP % to be at least 350) had nothing to tune.
 */
import { describe, test, expect } from 'vitest';
import {
    KIND_ALLY_PCT,
    KIND_HP_POOL,
    KIND_ENEMY_PCT,
    abilityHeals,
    tunableKind,
    collectTunables,
    applyTriggerValues,
    coarseGrid,
    fineGrid,
    gridMaximum,
    clampValue,
    describeRow,
} from './trigger-tuning.js';
import { buildConditionCandidates, conditionSlots } from './lab-condition-search.js';

const SELF = '/combat_trigger_dependencies/self';
const ALLIES = '/combat_trigger_dependencies/all_allies';
const ENEMIES = '/combat_trigger_dependencies/all_enemies';
const LOWEST = '/combat_trigger_conditions/lowest_hp_percentage';
const MISSING_HP = '/combat_trigger_conditions/missing_hp';
const CURRENT_HP = '/combat_trigger_conditions/current_hp';
const GTE = '/combat_trigger_comparators/greater_than_equal';
const LTE = '/combat_trigger_comparators/less_than_equal';
const QUICK_AID = '/abilities/quick_aid';
const FIREBALL = '/abilities/fireball';

const row = (dependencyHrid, conditionHrid, comparatorHrid, value = 0) => ({
    dependencyHrid,
    conditionHrid,
    comparatorHrid,
    value,
});

const healEffect = (targetType) => ({ effectType: '/ability_effect_types/heal', targetType });
const damageEffect = { effectType: '/ability_effect_types/damage', targetType: 'enemy' };

function gameData() {
    return {
        abilityDetailMap: {
            [QUICK_AID]: {
                name: 'Quick Aid',
                abilityEffects: [healEffect('lowestHpAlly')],
                defaultCombatTriggers: [row(ALLIES, LOWEST, LTE, 50)],
            },
            [FIREBALL]: {
                name: 'Fireball',
                abilityEffects: [damageEffect],
                defaultCombatTriggers: [row(ALLIES, LOWEST, LTE, 50)],
            },
        },
        itemDetailMap: {},
        combatTriggerDependencyDetailMap: {
            [SELF]: { name: 'Self', isSingleTarget: true },
            [ALLIES]: { name: "Allies' Total", isSingleTarget: false },
        },
        combatTriggerConditionDetailMap: {
            [LOWEST]: {
                name: 'Lowest HP %',
                isSingleTarget: false,
                allowedComparatorHrids: [GTE, LTE],
            },
            [MISSING_HP]: { name: 'Missing HP', isSingleTarget: true, allowedComparatorHrids: [GTE, LTE] },
            [CURRENT_HP]: { name: 'Current HP', isSingleTarget: true, allowedComparatorHrids: [GTE, LTE] },
        },
    };
}

const healerDto = (triggers = null) => ({
    hrid: 'player1',
    abilities: [{ hrid: QUICK_AID, level: 50, triggers }],
    food: [],
    drinks: [],
});

describe('abilityHeals', () => {
    test('is true for an ability with a heal effect, whatever its target, and false otherwise', () => {
        expect(abilityHeals(gameData(), QUICK_AID)).toBe(true);
        expect(abilityHeals(gameData(), FIREBALL)).toBe(false);
        expect(abilityHeals(gameData(), '/abilities/unknown')).toBe(false);
        expect(abilityHeals(null, QUICK_AID)).toBe(false);
    });
});

describe('tunableKind for heal abilities', () => {
    test('the lowest HP % of all allies is a percentage kind, with either comparator, on a heal only', () => {
        expect(tunableKind('abilities', row(ALLIES, LOWEST, LTE, 50), { heals: true })).toBe(KIND_ALLY_PCT);
        expect(tunableKind('abilities', row(ALLIES, LOWEST, GTE, 350), { heals: true })).toBe(KIND_ALLY_PCT);
        expect(tunableKind('abilities', row(ALLIES, LOWEST, LTE, 50))).toBeNull();
        expect(tunableKind('abilities', row(ALLIES, LOWEST, LTE, 50), { heals: false })).toBeNull();
    });

    test("a heal's own HP rows tune like a food's HP row; an is_active row never does", () => {
        expect(tunableKind('abilities', row(SELF, MISSING_HP, GTE, 500), { heals: true })).toBe(KIND_HP_POOL);
        expect(tunableKind('abilities', row(SELF, CURRENT_HP, LTE, 500), { heals: true })).toBe(KIND_HP_POOL);
        expect(tunableKind('abilities', row(SELF, MISSING_HP, GTE, 500))).toBeNull();
        expect(
            tunableKind('abilities', row(ALLIES, LOWEST, '/combat_trigger_comparators/is_active', 0), { heals: true })
        ).toBeNull();
    });

    test('the enemy rows on a heal are unchanged', () => {
        expect(tunableKind('abilities', row(ENEMIES, LOWEST, LTE, 50), { heals: true })).toBe(KIND_ENEMY_PCT);
    });
});

describe('collectTunables with a healer', () => {
    test("a heal's default ally row is collected; the same row on a damage ability is not", () => {
        const dtos = [
            {
                hrid: 'player1',
                abilities: [
                    { hrid: QUICK_AID, triggers: null },
                    { hrid: FIREBALL, triggers: null },
                ],
                food: [],
                drinks: [],
            },
        ];
        const tunables = collectTunables({ playerDTOs: dtos, playerIndices: [0], gameData: gameData() });
        expect(tunables.map((t) => [t.itemName, t.kind, t.original])).toEqual([['Quick Aid', KIND_ALLY_PCT, 50]]);
    });

    test('the reported row (>= 350) is collected, and an override reaches the DTO without touching the source', () => {
        const dtos = [healerDto([row(ALLIES, LOWEST, GTE, 350)])];
        const tunables = collectTunables({ playerDTOs: dtos, playerIndices: [0], gameData: gameData() });
        expect(tunables).toHaveLength(1);
        const out = applyTriggerValues(dtos, tunables, { [tunables[0].key]: 40 });
        expect(out[0].abilities[0].triggers[0].value).toBe(40);
        expect(dtos[0].abilities[0].triggers[0].value).toBe(350);
    });

    test('a party of two healers yields one tunable each, keyed apart', () => {
        const dtos = [healerDto(), { ...healerDto(), hrid: 'player2' }];
        const tunables = collectTunables({ playerDTOs: dtos, playerIndices: [0, 1], gameData: gameData() });
        expect(new Set(tunables.map((t) => t.key)).size).toBe(2);
    });
});

describe('ally percentage grids', () => {
    const tunable = { kind: KIND_ALLY_PCT, original: 350, dependencyHrid: ALLIES };

    test('run 0 to 100 in tens, and an impossible current value is clamped into range', () => {
        expect(gridMaximum(tunable, {})).toBe(100);
        expect(coarseGrid(tunable, {})).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
        expect(clampValue(KIND_ALLY_PCT, 350)).toBe(100);
    });

    test('fine grids step by 2 and 5 and stay in range', () => {
        expect(fineGrid(tunable, {}, 40)).toEqual([35, 38, 42, 45]);
        expect(fineGrid(tunable, {}, 98)).toEqual([93, 96, 100]);
    });

    test('a self HP row on a heal is scaled to the pool, like a food', () => {
        const hp = { kind: KIND_HP_POOL, original: 100, playerHrid: 'player1', dependencyHrid: SELF };
        expect(gridMaximum(hp, { pools: { player1: { hp: 3000, mp: 500 } } })).toBe(3000);
    });

    test('rows read aloud with a percent sign', () => {
        expect(describeRow(row(ALLIES, LOWEST, LTE), gameData(), 40)).toBe("Allies' Total: Lowest HP % ≤ 40%");
    });
});

describe('buildConditionCandidates for a heal', () => {
    const slotsOf = (dto) => conditionSlots(dto, gameData(), 'abilities');
    const rowsFor = (hrid, gd = gameData()) => {
        const dto = {
            hrid: 'player1',
            abilities: [
                {
                    hrid: QUICK_AID,
                    triggers: [
                        row(SELF, '/combat_trigger_conditions/berserk', '/combat_trigger_comparators/is_active'),
                    ],
                },
                {
                    hrid: FIREBALL,
                    triggers: [
                        row(SELF, '/combat_trigger_conditions/berserk', '/combat_trigger_comparators/is_active'),
                    ],
                },
            ],
            food: [],
            drinks: [],
        };
        const slot = slotsOf(dto).find((s) => s.itemHrid === hrid);
        return buildConditionCandidates({ slot, dto, gameData: gd, monsterHrids: [], pools: { hp: 2000, mp: 1000 } });
    };

    test('a heal is offered lowest-ally-HP rows at 25, 50 and 75 percent', () => {
        const rows = rowsFor(QUICK_AID);
        const ally = rows.filter((r) => r.dependencyHrid === ALLIES);
        expect(ally.map((r) => [r.conditionHrid, r.comparatorHrid, r.value])).toEqual([
            [LOWEST, LTE, 25],
            [LOWEST, LTE, 50],
            [LOWEST, LTE, 75],
        ]);
    });

    test('an ability that does not heal gets none, even in a party', () => {
        expect(rowsFor(FIREBALL).some((r) => r.dependencyHrid === ALLIES)).toBe(false);
    });

    test('the cap still holds, and a row the slot already has alone is not offered again', () => {
        const dto = {
            hrid: 'player1',
            abilities: [{ hrid: QUICK_AID, triggers: [row(ALLIES, LOWEST, LTE, 50)] }],
            food: [],
            drinks: [],
        };
        const slot = slotsOf(dto)[0];
        const capped = buildConditionCandidates({ slot, dto, gameData: gameData(), monsterHrids: [], cap: 2 });
        expect(capped).toHaveLength(2);
        const all = buildConditionCandidates({ slot, dto, gameData: gameData(), monsterHrids: [] });
        expect(all.some((r) => r.dependencyHrid === ALLIES && r.value === 50)).toBe(false);
        expect(all.some((r) => r.dependencyHrid === ALLIES && r.value === 25)).toBe(true);
    });

    test('game data without the ally dependency offers none rather than an invalid row', () => {
        const gd = gameData();
        delete gd.combatTriggerDependencyDetailMap[ALLIES];
        expect(rowsFor(QUICK_AID, gd).some((r) => r.dependencyHrid === ALLIES)).toBe(false);
    });
});
