/**
 * Trigger reads: the count the trigger optimizer uses to skip rows that could
 * not have changed a run. A slot's rows are counted when they are read — the
 * slot was ready and its turn came — whether or not they passed. A gate that
 * blocks every cast is read every time and must never look unused.
 */

import { describe, test, expect, afterEach } from 'vitest';

import Ability from './ability.js';
import CombatSimulator from './combat-simulator.js';
import { setGameData } from './game-data.js';
import Player from './player.js';
import { clearSimRng, seedSimRng } from './rng.js';
import SimResult from './sim-result.js';
import Trigger from './trigger.js';
import Zone from './zone.js';

const ONE_SECOND = 1e9;
const ZONE_HRID = '/actions/combat/golden_meadow';
const RAT_HRID = '/monsters/golden_rat';
const SELF = '/combat_trigger_dependencies/self';
const TARGET = '/combat_trigger_dependencies/targeted_enemy';
const CURRENT_HP = '/combat_trigger_conditions/current_hp';
const MISSING_HP = '/combat_trigger_conditions/missing_hp';
const GTE = '/combat_trigger_comparators/greater_than_equal';
const STRIKE = '/abilities/fixture_strike';
const NEVER_FOOD = '/items/never_donut';
const SOMETIMES_FOOD = '/items/sometimes_donut';

function installGameData() {
    const food = (hrid) => ({
        hrid,
        name: hrid,
        categoryHrid: '/item_categories/food',
        consumableDetail: {
            cooldownDuration: 10 * ONE_SECOND,
            hitpointRestore: 50,
            manapointRestore: 0,
            recoveryDuration: 0,
            buffs: null,
            defaultCombatTriggers: [{ dependencyHrid: SELF, conditionHrid: MISSING_HP, comparatorHrid: GTE, value: 1 }],
        },
    });
    setGameData({
        actionDetailMap: {
            [ZONE_HRID]: {
                buffs: null,
                combatZoneInfo: {
                    isDungeon: false,
                    dungeonInfo: null,
                    fightInfo: {
                        bossSpawns: null,
                        randomSpawnInfo: {
                            maxSpawnCount: 1,
                            maxTotalStrength: 1,
                            spawns: [{ combatMonsterHrid: RAT_HRID, difficultyTier: 0, rate: 1, strength: 1 }],
                        },
                    },
                },
            },
        },
        combatMonsterDetailMap: {
            [RAT_HRID]: {
                experience: 60,
                enrageTime: 300 * ONE_SECOND,
                abilities: [],
                combatDetails: {
                    staminaLevel: 10,
                    intelligenceLevel: 5,
                    attackLevel: 40,
                    meleeLevel: 40,
                    defenseLevel: 30,
                    rangedLevel: 1,
                    magicLevel: 1,
                    attackInterval: 3500000000,
                    combatStats: {
                        combatStyleHrids: ['/combat_styles/smash'],
                        damageType: '/damage_types/physical',
                        attackInterval: 0,
                    },
                },
            },
        },
        combatStyleDetailMap: { '/combat_styles/smash': { skillExpMap: { '/skills/attack': 1, '/skills/melee': 1 } } },
        abilityDetailMap: {
            [STRIKE]: {
                manaCost: 0,
                cooldownDuration: 5 * ONE_SECOND,
                castDuration: 0,
                isSpecialAbility: false,
                abilityEffects: [],
                defaultCombatTriggers: [],
            },
        },
        itemDetailMap: { [NEVER_FOOD]: food(NEVER_FOOD), [SOMETIMES_FOOD]: food(SOMETIMES_FOOD) },
        combatTriggerDependencyDetailMap: { [SELF]: { isSingleTarget: true }, [TARGET]: { isSingleTarget: true } },
    });
}

afterEach(() => {
    clearSimRng();
    setGameData(null);
});

describe('Ability.shouldTrigger counts reads, not passes', () => {
    const unit = (extra = {}) => ({ combatDetails: { combatStats: { abilityHaste: 0 } }, ...extra });
    const target = { combatDetails: { currentHitpoints: 100, maxHitpoints: 100 } };

    test('a gate that is never met is still read every time the ability is ready', () => {
        installGameData();
        const ability = new Ability(STRIKE, 1, [new Trigger(TARGET, CURRENT_HP, GTE, 1e9)]);
        expect(ability.shouldTrigger(0, unit(), target, [], [target])).toBe(false);
        expect(ability.shouldTrigger(0, unit(), target, [], [target])).toBe(false);
        expect(ability.triggerChecks).toBe(2);
    });

    test('a slot on cooldown, stunned or silenced is not read', () => {
        installGameData();
        const ability = new Ability(STRIKE, 1, [new Trigger(TARGET, CURRENT_HP, GTE, 1)]);
        ability.lastUsed = 0;
        expect(ability.shouldTrigger(ONE_SECOND, unit(), target, [], [target])).toBe(false);
        expect(ability.shouldTrigger(10 * ONE_SECOND, unit({ isStunned: true }), target, [], [target])).toBe(false);
        expect(ability.shouldTrigger(10 * ONE_SECOND, unit({ isSilenced: true }), target, [], [target])).toBe(false);
        expect(ability.triggerChecks).toBe(0);
        expect(ability.shouldTrigger(10 * ONE_SECOND, unit(), target, [], [target])).toBe(true);
        expect(ability.triggerChecks).toBe(1);
    });
});

describe('a whole run records each slot’s reads', () => {
    test('a food whose gate is never met is read throughout and never eaten', () => {
        installGameData();
        seedSimRng(5);
        const zone = new Zone(ZONE_HRID, 0);
        const player = Player.createFromDTO({
            hrid: 'player1',
            staminaLevel: 70,
            intelligenceLevel: 40,
            attackLevel: 70,
            meleeLevel: 70,
            defenseLevel: 60,
            rangedLevel: 1,
            magicLevel: 1,
            equipment: {},
            food: [
                {
                    hrid: NEVER_FOOD,
                    triggers: [{ dependencyHrid: SELF, conditionHrid: MISSING_HP, comparatorHrid: GTE, value: 1e9 }],
                },
                { hrid: SOMETIMES_FOOD, triggers: null },
                null,
            ],
            drinks: [null, null, null],
            abilities: [null, null, null, null],
            houseRooms: {},
            debuffOnLevelGap: 0,
        });
        player.zoneBuffs = zone.buffs;
        player.extraBuffs = [];
        const result = new CombatSimulator([player], zone).simulate(600 * ONE_SECOND);

        expect(result.triggerChecks.player1[NEVER_FOOD]).toBeGreaterThan(0);
        expect(result.consumablesUsed.player1?.[NEVER_FOOD]).toBeUndefined();
        expect(result.triggerChecks.player1[SOMETIMES_FOOD]).toBeGreaterThan(0);
    });

    test('setTriggerChecks sums a hrid held in two slots and reads 0 for a slot never reached', () => {
        const result = new SimResult({ hrid: ZONE_HRID, difficultyTier: 0 }, 1);
        result.setTriggerChecks({
            hrid: 'player1',
            abilities: [{ hrid: STRIKE, triggerChecks: 0 }, null],
            food: [
                { hrid: NEVER_FOOD, triggerChecks: 3 },
                { hrid: NEVER_FOOD, triggerChecks: 4 },
            ],
            drinks: [null],
        });
        expect(result.triggerChecks.player1).toEqual({ [STRIKE]: 0, [NEVER_FOOD]: 7 });
    });
});
