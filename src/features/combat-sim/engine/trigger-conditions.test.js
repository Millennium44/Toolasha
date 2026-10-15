/**
 * Every trigger condition the game offers, read the way the engine reads it.
 *
 * The condition list is the game's own (`combatTriggerConditionDetailMap` from init_client_data,
 * captured verbatim in the guild-trial fixture), so a condition the game adds later and the engine
 * has not learned shows up here as a warning rather than as an ability that silently never fires.
 * The buff cases use the buffs the game's own abilities grant, through `addBuff`, so a buff's
 * identity (one unique hrid, or several sharing a prefix, as Toughness's four do) is the game's.
 */

import { describe, test, expect, afterEach, beforeEach } from 'vitest';

import Ability from './ability.js';
import CombatUnit from './combat-unit.js';
import { setGameData } from './game-data.js';
import { TRIAL_GAME_DATA } from './guild-trial-game-data.fixture.js';
import Monster from './monster.js';
import { getSimWarnings, resetSimWarnings } from './sim-warnings.js';
import Trigger from './trigger.js';

const SELF = '/combat_trigger_dependencies/self';
const TARGET = '/combat_trigger_dependencies/targeted_enemy';
const ALL_ENEMIES = '/combat_trigger_dependencies/all_enemies';
const IS_ACTIVE = '/combat_trigger_comparators/is_active';
const IS_INACTIVE = '/combat_trigger_comparators/is_inactive';
const AT_LEAST = '/combat_trigger_comparators/greater_than_equal';

const TOUGHNESS = '/combat_trigger_conditions/toughness';
const FRENZY = '/combat_trigger_conditions/frenzy';
const BOSS = '/combat_trigger_conditions/boss_status';

/** A trial monster whose kit includes Frenzy (a self-buff), and which the game marks as a boss */
const FRENZY_MONSTER = '/monsters/trial_wasp';

/** A player-side unit: the engine's own CombatUnit, with nothing on it */
function player() {
    const unit = new CombatUnit();
    unit.isPlayer = true;
    unit.hrid = 'player1';
    unit.combatDetails.currentHitpoints = 1000;
    unit.combatDetails.maxHitpoints = 1000;
    return unit;
}

/** The buffs one of the game's abilities grants, as the engine builds them */
function buffsOf(abilityHrid, level = 1) {
    return new Ability(abilityHrid, level).abilityEffects.flatMap((e) => e.buffs || []);
}

beforeEach(() => {
    setGameData(TRIAL_GAME_DATA);
    resetSimWarnings();
});

afterEach(() => {
    setGameData(null);
    resetSimWarnings();
});

describe('the game condition list', () => {
    test('every condition the game offers is one the engine reads', () => {
        const me = player();
        const enemy = new Monster(FRENZY_MONSTER);
        enemy.combatDetails.currentHitpoints = 1;
        const conditions = TRIAL_GAME_DATA.combatTriggerConditionDetailMap;
        for (const [hrid, detail] of Object.entries(conditions)) {
            const comparator = detail.allowedComparatorHrids[0];
            if (detail.isSingleTarget) {
                new Trigger(SELF, hrid, comparator, 0).isActive(me, enemy, [me], [enemy], 0);
                new Trigger(TARGET, hrid, comparator, 0).isActive(me, enemy, [me], [enemy], 0);
            }
            if (detail.isMultiTarget) {
                new Trigger(ALL_ENEMIES, hrid, comparator, 0).isActive(me, enemy, [me], [enemy], 0);
            }
        }

        expect(getSimWarnings()).toEqual([]);
    });
});

describe('Boss Status', () => {
    test("reads the target enemy's boss flag from the game's monster detail", () => {
        const me = player();
        const boss = new Monster(FRENZY_MONSTER);
        expect(TRIAL_GAME_DATA.combatMonsterDetailMap[FRENZY_MONSTER].isBoss).toBe(true);

        expect(new Trigger(TARGET, BOSS, IS_ACTIVE).isActive(me, boss, [me], [boss], 0)).toBe(true);
        expect(new Trigger(TARGET, BOSS, IS_INACTIVE).isActive(me, boss, [me], [boss], 0)).toBe(false);
    });

    test('a monster the game does not mark, and a player, are not bosses', () => {
        const me = player();
        const plain = new Monster(FRENZY_MONSTER);
        plain.isBoss = false;

        expect(new Trigger(TARGET, BOSS, IS_INACTIVE).isActive(me, plain, [me], [plain], 0)).toBe(true);
        expect(new Trigger(SELF, BOSS, IS_ACTIVE).isActive(me, plain, [me], [plain], 0)).toBe(false);
        expect(getSimWarnings()).toEqual([]);
    });
});

describe('buff conditions', () => {
    test('"My Toughness Is Inactive" until any of its four buffs is on me', () => {
        const me = player();
        const inactive = new Trigger(SELF, TOUGHNESS, IS_INACTIVE);
        const active = new Trigger(SELF, TOUGHNESS, IS_ACTIVE);
        expect(inactive.isActive(me, null, [me], null, 0)).toBe(true);

        const toughness = buffsOf('/abilities/toughness');
        // The game's Toughness grants toughness_armor and three resistances; none is called "toughness"
        expect(toughness.map((b) => b.uniqueHrid)).not.toContain('/buff_uniques/toughness');
        me.addBuff(toughness[0], 0);

        expect(inactive.isActive(me, null, [me], null, 1)).toBe(false);
        expect(active.isActive(me, null, [me], null, 1)).toBe(true);

        // And inactive again once it has run out
        me.removeExpiredBuffs(toughness[0].duration);
        expect(inactive.isActive(me, null, [me], null, toughness[0].duration)).toBe(true);
    });

    test('"Target Enemy\'s Frenzy Is Active" reads the Frenzy the monster casts on itself', () => {
        const me = player();
        const monster = new Monster(FRENZY_MONSTER);
        const ownFrenzy = monster.abilities.find((a) => a?.hrid === '/abilities/frenzy');
        expect(ownFrenzy).toBeTruthy();
        const trigger = new Trigger(TARGET, FRENZY, IS_ACTIVE);
        expect(trigger.isActive(me, monster, [me], [monster], 0)).toBe(false);

        for (const buff of ownFrenzy.abilityEffects.flatMap((e) => e.buffs || [])) monster.addBuff(buff, 0);

        expect(trigger.isActive(me, monster, [me], [monster], 1)).toBe(true);
        // "My Frenzy" is a different unit's buff: the monster's own does not make mine active
        expect(new Trigger(SELF, FRENZY, IS_ACTIVE).isActive(me, monster, [me], [monster], 1)).toBe(false);
    });

    test('"target enemy" is the first living enemy, not any enemy', () => {
        const me = player();
        const first = new Monster(FRENZY_MONSTER);
        const second = new Monster(FRENZY_MONSTER);
        first.combatDetails.currentHitpoints = 10;
        second.combatDetails.currentHitpoints = 10;
        for (const buff of buffsOf('/abilities/frenzy')) second.addBuff(buff, 0);
        const trigger = new Trigger(TARGET, FRENZY, IS_ACTIVE);

        // The trigger is handed the target the simulator picked (CombatUtilities.getTarget)
        expect(trigger.isActive(me, first, [me], [first, second], 1)).toBe(false);
        expect(trigger.isActive(me, second, [me], [first, second], 1)).toBe(true);
    });

    test('AND: an ability fires only when every row holds', () => {
        const me = player();
        const monster = new Monster(FRENZY_MONSTER);
        monster.combatDetails.currentHitpoints = 10;
        const ability = new Ability('/abilities/toughness', 1, [
            new Trigger(SELF, TOUGHNESS, IS_INACTIVE),
            new Trigger(TARGET, FRENZY, IS_ACTIVE),
        ]);
        const fires = (t) => ability.shouldTrigger(t, me, monster, [me], [monster]);

        // My Toughness is off, but the enemy is not frenzied
        expect(fires(0)).toBe(false);
        for (const buff of buffsOf('/abilities/frenzy')) monster.addBuff(buff, 0);
        expect(fires(1)).toBe(true);
        // Both hold until my Toughness goes up
        for (const buff of buffsOf('/abilities/toughness')) me.addBuff(buff, 1);
        expect(fires(2)).toBe(false);
    });

    test('a numeric row is the plain reading: current HP at least a value', () => {
        const me = player();
        const monster = new Monster(FRENZY_MONSTER);
        monster.combatDetails.currentHitpoints = 600;
        const hp = '/combat_trigger_conditions/current_hp';

        expect(new Trigger(TARGET, hp, AT_LEAST, 600).isActive(me, monster, [me], [monster], 0)).toBe(true);
        expect(new Trigger(TARGET, hp, AT_LEAST, 601).isActive(me, monster, [me], [monster], 0)).toBe(false);
    });
});
