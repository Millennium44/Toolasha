// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
import { getGameData } from './game-data.js';
import { recordUnknown } from './sim-warnings.js';

/**
 * What a condition the engine has never heard of reads as.
 *
 * Distinct from every real reading, including `undefined`: a comparator asked
 * about `undefined` answers *true* for `is_inactive`, which would fire an
 * ability whose trigger the engine could not evaluate. The sentinel is checked
 * before any comparator sees it.
 */
const UNKNOWN = Symbol('unknown trigger reading');

class Trigger {
    constructor(dependencyHrid, conditionHrid, comparatorHrid, value = 0) {
        this.dependencyHrid = dependencyHrid;
        this.conditionHrid = conditionHrid;
        this.comparatorHrid = comparatorHrid;
        this.value = value;
    }

    static createFromDTO(dto) {
        const trigger = new Trigger(dto.dependencyHrid, dto.conditionHrid, dto.comparatorHrid, dto.value);

        return trigger;
    }

    /**
     * Whether this trigger's condition is met right now.
     *
     * A trigger the engine cannot evaluate — a dependency, condition or
     * comparator the game grew after this port was written — reads as *not*
     * met, and the run records a warning naming it (see sim-warnings.js for
     * why: one new mechanic used to throw away every number in the run). The
     * ability behind it simply never fires, so the result understates rather
     * than disappearing.
     *
     * @param {Object} source - The unit whose trigger this is
     * @param {Object|null} target - Its current target, if any
     * @param {Array|null} friendlies - Its side
     * @param {Array|null} enemies - The other side
     * @param {number} currentTime - Simulation time in nanoseconds
     * @returns {boolean}
     */
    isActive(source, target, friendlies, enemies, currentTime) {
        const combatTriggerDependencyDetailMap = getGameData().combatTriggerDependencyDetailMap;
        const dependencyDetail = combatTriggerDependencyDetailMap[this.dependencyHrid];
        if (!dependencyDetail) {
            recordUnknown('combat trigger dependency', this.dependencyHrid);
            return false;
        }
        if (dependencyDetail.isSingleTarget) {
            return this.isActiveSingleTarget(source, target, currentTime);
        } else {
            return this.isActiveMultiTarget(friendlies, enemies, currentTime);
        }
    }

    isActiveSingleTarget(source, target, currentTime) {
        let dependencyValue;
        switch (this.dependencyHrid) {
            case '/combat_trigger_dependencies/self':
                dependencyValue = this.getDependencyValue(source, currentTime);
                break;
            case '/combat_trigger_dependencies/targeted_enemy':
                if (!target) {
                    return false;
                }
                dependencyValue = this.getDependencyValue(target, currentTime);
                break;
            default:
                recordUnknown('combat trigger dependency', this.dependencyHrid);
                return false;
        }

        if (dependencyValue === UNKNOWN) {
            return false;
        }

        return this.compareValue(dependencyValue);
    }

    isActiveMultiTarget(friendlies, enemies, currentTime) {
        let dependency;
        switch (this.dependencyHrid) {
            case '/combat_trigger_dependencies/all_allies':
                if (!friendlies) {
                    return false;
                }
                dependency = friendlies;
                break;
            case '/combat_trigger_dependencies/all_enemies':
                if (!enemies) {
                    return false;
                }
                dependency = enemies;
                break;
            default:
                recordUnknown('combat trigger dependency', this.dependencyHrid);
                return false;
        }

        if (!dependency) {
            return false;
        }

        let dependencyValue;
        switch (this.conditionHrid) {
            case '/combat_trigger_conditions/number_of_active_units':
                dependencyValue = dependency.filter((unit) => unit.combatDetails.currentHitpoints > 0).length;
                break;
            case '/combat_trigger_conditions/number_of_dead_units':
                dependencyValue = dependency.filter((unit) => unit.combatDetails.currentHitpoints <= 0).length;
                break;
            case '/combat_trigger_conditions/lowest_hp_percentage':
                dependencyValue =
                    dependency
                        .filter((unit) => unit.combatDetails.currentHitpoints > 0)
                        .reduce((prev, curr) => {
                            const currentHpPercentage =
                                curr.combatDetails.currentHitpoints / curr.combatDetails.maxHitpoints;
                            return currentHpPercentage < prev ? currentHpPercentage : prev;
                        }, 2) * 100;
                break;
            default: {
                // Per living unit, exactly what the single-target path reads,
                // then combined. Buff conditions return the buff OBJECT (see
                // getDependencyValue) — summing those produced the string
                // "0[object Object]", which is_active read as truthy for every
                // ally and >= read as false for all of them. Counting units
                // instead gives both comparators the reading the single-target
                // path would give: is_active/is_inactive become any/none, and
                // >= n becomes "at least n of them have it".
                const values = dependency
                    .filter((unit) => unit.combatDetails.currentHitpoints > 0)
                    .map((unit) => this.getDependencyValue(unit, currentTime));
                if (values.includes(UNKNOWN)) {
                    return false;
                }
                dependencyValue = values.reduce((prev, cur) => {
                    // Numbers (current_hp, missing_mp, ...) still add up; a buff
                    // object or a status boolean counts as one unit.
                    const numeric = typeof cur === 'number' ? cur : cur ? 1 : 0;
                    return prev + numeric;
                }, 0);
                break;
            }
        }

        return this.compareValue(dependencyValue);
    }

    /**
     * The one reading this trigger's condition asks a unit for.
     * @param {Object} source - The unit to read
     * @param {number} currentTime - Simulation time in nanoseconds
     * @returns {number|boolean|Object|symbol} The reading, or the UNKNOWN
     *   sentinel for a condition this engine does not model
     */
    getDependencyValue(source, currentTime) {
        switch (this.conditionHrid) {
            case '/combat_trigger_conditions/berserk':
            case '/combat_trigger_conditions/frenzy':
            case '/combat_trigger_conditions/precision':
            case '/combat_trigger_conditions/vampirism':
            case '/combat_trigger_conditions/attack_coffee':
            case '/combat_trigger_conditions/defense_coffee':
            case '/combat_trigger_conditions/lucky_coffee':
            case '/combat_trigger_conditions/magic_coffee':
            case '/combat_trigger_conditions/melee_coffee':
            case '/combat_trigger_conditions/ranged_coffee':
            case '/combat_trigger_conditions/swiftness_coffee':
            case '/combat_trigger_conditions/wisdom_coffee':
            case '/combat_trigger_conditions/ice_spear':
            case '/combat_trigger_conditions/puncture':
            case '/combat_trigger_conditions/frost_surge':
            case '/combat_trigger_conditions/elusiveness':
            case '/combat_trigger_conditions/channeling_coffee':
            case '/combat_trigger_conditions/fierce_aura':
            case '/combat_trigger_conditions/invincible_armor':
            case '/combat_trigger_conditions/invincible_fire_resistance':
            case '/combat_trigger_conditions/invincible_nature_resistance':
            case '/combat_trigger_conditions/invincible_water_resistance':
            case '/combat_trigger_conditions/provoke':
            case '/combat_trigger_conditions/taunt':
            case '/combat_trigger_conditions/crippling_slash':
            case '/combat_trigger_conditions/mana_spring':
            case '/combat_trigger_conditions/retribution':
            case '/combat_trigger_conditions/fracturing_impact':
            case '/combat_trigger_conditions/maim':
            case '/combat_trigger_conditions/curse':
            case '/combat_trigger_conditions/weaken': {
                const buffHrid = '/buff_uniques' + this.conditionHrid.slice(this.conditionHrid.lastIndexOf('/'));
                return source.combatBuffs[buffHrid];
            }
            case '/combat_trigger_conditions/critical_aura':
            case '/combat_trigger_conditions/critical_coffee':
            case '/combat_trigger_conditions/intelligence_coffee':
            case '/combat_trigger_conditions/stamina_coffee':
            case '/combat_trigger_conditions/elemental_affinity':
            case '/combat_trigger_conditions/fury':
            case '/combat_trigger_conditions/guardian_aura':
            case '/combat_trigger_conditions/insanity':
            case '/combat_trigger_conditions/spike_shell':
            case '/combat_trigger_conditions/toxic_pollen':
            case '/combat_trigger_conditions/invincible':
            case '/combat_trigger_conditions/mystic_aura':
            case '/combat_trigger_conditions/pestilent_shot':
            case '/combat_trigger_conditions/smoke_burst':
            case '/combat_trigger_conditions/speed_aura':
            case '/combat_trigger_conditions/toughness':
            case '/combat_trigger_conditions/enrage': {
                const buffPrefix = '/buff_uniques' + this.conditionHrid.slice(this.conditionHrid.lastIndexOf('/'));
                const buffs = Object.keys(source.combatBuffs).filter((buff) => buff.startsWith(buffPrefix));
                return source.combatBuffs[buffs?.[0]];
            }
            case '/combat_trigger_conditions/current_hp':
                return source.combatDetails.currentHitpoints;
            case '/combat_trigger_conditions/current_mp':
                return source.combatDetails.currentManapoints;
            case '/combat_trigger_conditions/missing_hp':
                return source.combatDetails.maxHitpoints - source.combatDetails.currentHitpoints;
            case '/combat_trigger_conditions/missing_mp':
                return source.combatDetails.maxManapoints - source.combatDetails.currentManapoints;
            case '/combat_trigger_conditions/stun_status':
                // Replicate the game's behaviour of "stun status active" triggers activating
                // immediately after the stun has worn off
                return source.isStunned || source.stunExpireTime === currentTime;
            case '/combat_trigger_conditions/blind_status':
                return source.isBlinded || source.blindExpireTime === currentTime;
            case '/combat_trigger_conditions/silence_status':
                return source.isSilenced || source.silenceExpireTime === currentTime;
            default:
                recordUnknown('combat trigger condition', this.conditionHrid);
                return UNKNOWN;
        }
    }

    /**
     * Apply this trigger's comparator to a reading.
     * @param {number|boolean|Object} dependencyValue - The reading
     * @returns {boolean} False for a comparator this engine does not model
     */
    compareValue(dependencyValue) {
        switch (this.comparatorHrid) {
            case '/combat_trigger_comparators/greater_than_equal':
                return dependencyValue >= this.value;
            case '/combat_trigger_comparators/less_than_equal':
                return dependencyValue <= this.value;
            case '/combat_trigger_comparators/is_active':
                return !!dependencyValue;
            case '/combat_trigger_comparators/is_inactive':
                return !dependencyValue;
            default:
                recordUnknown('combat trigger comparator', this.comparatorHrid);
                return false;
        }
    }
}

export default Trigger;
