import { describe, test, expect } from 'vitest';
import { neverFiresReason, findNeverFiringRows, neverFiringWarnings } from './trigger-checks.js';

const ALLIES = '/combat_trigger_dependencies/all_allies';
const SELF = '/combat_trigger_dependencies/self';
const LOWEST = '/combat_trigger_conditions/lowest_hp_percentage';
const CURRENT_HP = '/combat_trigger_conditions/current_hp';
const ACTIVE_UNITS = '/combat_trigger_conditions/number_of_active_units';
const BERSERK = '/combat_trigger_conditions/berserk';
const GTE = '/combat_trigger_comparators/greater_than_equal';
const LTE = '/combat_trigger_comparators/less_than_equal';
const IS_ACTIVE = '/combat_trigger_comparators/is_active';
const QUICK_AID = '/abilities/quick_aid';
const DONUT = '/items/donut';

const row = (dependencyHrid, conditionHrid, comparatorHrid, value) => ({
    dependencyHrid,
    conditionHrid,
    comparatorHrid,
    value,
});

const gameData = {
    abilityDetailMap: {
        [QUICK_AID]: {
            name: 'Quick Aid',
            defaultCombatTriggers: [row(ALLIES, LOWEST, LTE, 50)],
        },
    },
    itemDetailMap: { [DONUT]: { name: 'Donut', consumableDetail: { defaultCombatTriggers: [] } } },
    combatTriggerDependencyDetailMap: { [ALLIES]: { name: "Allies' Total" } },
    combatTriggerConditionDetailMap: { [LOWEST]: { name: 'Lowest HP %' } },
};

const healer = (triggers) => ({
    hrid: 'player1',
    abilities: [{ hrid: QUICK_AID, triggers }],
    food: [],
    drinks: [],
});

describe('neverFiresReason', () => {
    test("the reported row, Allies' Total Lowest HP % >= 350, can never be true", () => {
        expect(neverFiresReason(row(ALLIES, LOWEST, GTE, 350))).toMatch(/never above 100/);
    });

    test('>= 100 is possible (a full-health party); >= 101 is not', () => {
        expect(neverFiresReason(row(ALLIES, LOWEST, GTE, 100))).toBeNull();
        expect(neverFiresReason(row(ALLIES, LOWEST, GTE, 101))).not.toBeNull();
    });

    test('<= 0 on the lowest HP % never fires (living units have HP above 0); <= 1 can', () => {
        expect(neverFiresReason(row(ALLIES, LOWEST, LTE, 0))).not.toBeNull();
        expect(neverFiresReason(row(ALLIES, LOWEST, LTE, 1))).toBeNull();
    });

    test('a negative <= bound on any count or point reading never fires, while >= 0 always does', () => {
        expect(neverFiresReason(row(SELF, CURRENT_HP, LTE, -1))).not.toBeNull();
        expect(neverFiresReason(row(ALLIES, ACTIVE_UNITS, LTE, -3))).not.toBeNull();
        expect(neverFiresReason(row(SELF, CURRENT_HP, LTE, 0))).toBeNull();
        expect(neverFiresReason(row(SELF, CURRENT_HP, GTE, 99999))).toBeNull();
    });

    test('ordinary rows and a missing row read as fine', () => {
        expect(neverFiresReason(row(ALLIES, LOWEST, LTE, 50))).toBeNull();
        expect(neverFiresReason(null)).toBeNull();
        expect(neverFiresReason(row(SELF, BERSERK, IS_ACTIVE, 0))).toBeNull();
    });
});

describe('findNeverFiringRows', () => {
    test('reads custom rows, falls back to defaults, and names the row', () => {
        const dtos = [healer([row(ALLIES, LOWEST, GTE, 350)]), { ...healer(null), hrid: 'player2' }];
        const found = findNeverFiringRows(dtos, gameData, { player1: 'Healer' });
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({
            playerName: 'Healer',
            itemName: 'Quick Aid',
            rowIndex: 0,
            slotType: 'abilities',
        });
    });

    test('one impossible row among several is reported with its own index, and food is checked too', () => {
        const dto = healer([row(SELF, CURRENT_HP, GTE, 1), row(ALLIES, LOWEST, GTE, 120)]);
        dto.food = [{ hrid: DONUT, triggers: [row(SELF, CURRENT_HP, LTE, -5)] }];
        const found = findNeverFiringRows([dto], gameData);
        expect(found.map((f) => [f.itemName, f.rowIndex, f.slotType])).toEqual([
            ['Quick Aid', 1, 'abilities'],
            ['Donut', 0, 'food'],
        ]);
    });

    test('an empty trigger list (always fires) and an empty party are fine', () => {
        expect(findNeverFiringRows([healer([])], gameData)).toEqual([]);
        expect(findNeverFiringRows(null, gameData)).toEqual([]);
    });
});

describe('neverFiringWarnings', () => {
    test('names the player, the ability and the row', () => {
        const [line] = neverFiringWarnings(
            [healer([row(ALLIES, LOWEST, GTE, 350)])],
            [{ hrid: 'player1', name: 'Healer' }],
            gameData
        );
        expect(line).toContain('Healer');
        expect(line).toContain('Quick Aid');
        expect(line).toContain("Allies' Total: Lowest HP % ≥ 350%");
        expect(line).toContain('never');
    });

    test('a name with markup is escaped', () => {
        const [line] = neverFiringWarnings(
            [healer([row(ALLIES, LOWEST, GTE, 350)])],
            [{ hrid: 'player1', name: '<b>x</b>' }],
            gameData
        );
        expect(line).not.toContain('<b>');
    });

    test('a healthy party yields no warnings', () => {
        expect(neverFiringWarnings([healer(null)], [{ hrid: 'player1', name: 'Healer' }], gameData)).toEqual([]);
    });
});
