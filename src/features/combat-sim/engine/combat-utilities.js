// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
import { random } from './rng.js';
import { recordUnknown } from './sim-warnings.js';

class CombatUtilities {
    /**
     * The result of an attack the engine could not model, shaped like a real
     * one so callers need no special case: nothing hit, nothing was drained,
     * and no unit's state was touched.
     * @returns {Object} A zeroed attack result
     */
    static skippedAttackResult() {
        return {
            damageDone: 0,
            didHit: false,
            thornDamageDone: 0,
            thornType: undefined,
            retaliationDamageDone: 0,
            lifeStealHeal: 0,
            hpDrain: 0,
            manaLeechMana: 0,
            isCrit: false,
        };
    }

    static getTarget(enemies) {
        if (!enemies) {
            return null;
        }
        const target = enemies.find((enemy) => enemy.combatDetails.currentHitpoints > 0);

        return target ?? null;
    }

    static randomInt(min, max) {
        if (max < min) {
            const temp = min;
            min = max;
            max = temp;
        }

        const minCeil = Math.ceil(min);
        const maxFloor = Math.floor(max);

        if (Math.floor(min) === maxFloor) {
            return Math.floor((min + max) / 2 + random());
        }

        const minTail = -1 * (min - minCeil);
        const maxTail = max - maxFloor;

        const balancedWeight = 2 * minTail + (maxFloor - minCeil);
        const balancedAverage = (maxFloor + minCeil) / 2;
        const average = (max + min) / 2;
        const extraTailWeight = (balancedWeight * (average - balancedAverage)) / (maxFloor + 1 - average);
        const extraTailChance = Math.abs(extraTailWeight / (extraTailWeight + balancedWeight));

        if (random() < extraTailChance) {
            if (maxTail > minTail) {
                return Math.floor(maxFloor + 1);
            } else {
                return Math.floor(minCeil - 1);
            }
        }

        if (maxTail > minTail) {
            return Math.floor(min + random() * (maxFloor + minTail - min + 1));
        } else {
            return Math.floor(minCeil - maxTail + random() * (max - (minCeil - maxTail) + 1));
        }
    }

    /**
     * Resolve one attack.
     *
     * @param {Object} source - Attacking unit
     * @param {Object} target - Defending unit
     * @param {Object} [abilityEffect] - Ability effect, or null for an auto attack
     * @param {boolean} [isTaskFight] - Whether this fight is the player's active
     *   combat task. `taskDamage` is a conditional stat in the live game: it pays
     *   only while the monster in front of you is your task monster. A simulation
     *   has no way to know that on its own, so the caller says. Left false — the
     *   default — a task trinket or task badge contributes nothing, which is what
     *   a generic zone sim or a gear ranking should measure.
     * @returns {Object} Attack result
     */
    static processAttack(source, target, abilityEffect = null, isTaskFight = false) {
        const combatStyle = abilityEffect
            ? abilityEffect.combatStyleHrid
            : source.combatDetails.combatStats.combatStyleHrid;
        const damageType = abilityEffect ? abilityEffect.damageType : source.combatDetails.combatStats.damageType;

        let sourceAccuracyRating = 1;
        let sourceAutoAttackMaxDamage = 1;
        let targetEvasionRating = 1;
        // An unrecognized style or damage type used to throw and take the whole
        // run with it. Neither switch mutates anything, so the attack can be
        // dropped after both have looked, leaving every unit untouched.
        let unknownMechanic = null;

        switch (combatStyle) {
            case '/combat_styles/stab':
                sourceAccuracyRating = source.combatDetails.stabAccuracyRating;
                sourceAutoAttackMaxDamage = source.combatDetails.stabMaxDamage;
                targetEvasionRating = target.combatDetails.stabEvasionRating;
                break;
            case '/combat_styles/slash':
                sourceAccuracyRating = source.combatDetails.slashAccuracyRating;
                sourceAutoAttackMaxDamage = source.combatDetails.slashMaxDamage;
                targetEvasionRating = target.combatDetails.slashEvasionRating;
                break;
            case '/combat_styles/smash':
                sourceAccuracyRating = source.combatDetails.smashAccuracyRating;
                sourceAutoAttackMaxDamage = source.combatDetails.smashMaxDamage;
                targetEvasionRating = target.combatDetails.smashEvasionRating;
                break;
            case '/combat_styles/ranged':
                sourceAccuracyRating = source.combatDetails.rangedAccuracyRating;
                sourceAutoAttackMaxDamage = source.combatDetails.rangedMaxDamage;
                targetEvasionRating = target.combatDetails.rangedEvasionRating;
                break;
            case '/combat_styles/magic':
                sourceAccuracyRating = source.combatDetails.magicAccuracyRating;
                sourceAutoAttackMaxDamage = source.combatDetails.magicMaxDamage;
                targetEvasionRating = target.combatDetails.magicEvasionRating;
                break;
            default:
                unknownMechanic = { category: 'combat style', value: combatStyle };
                break;
        }

        let sourceDamageMultiplier = 1;
        let sourceResistance = 0;
        let sourcePenetration = 0;
        let targetResistance = 0;
        let targetThornPower = 0;
        let targetPenetration = 0;
        let thornType;

        switch (damageType) {
            case '/damage_types/physical':
                sourceDamageMultiplier = 1 + source.combatDetails.combatStats.physicalAmplify;
                sourceResistance = source.combatDetails.totalArmor;
                sourcePenetration = source.combatDetails.combatStats.armorPenetration;
                targetResistance = target.combatDetails.totalArmor;
                targetThornPower = target.combatDetails.combatStats.physicalThorns;
                targetPenetration = target.combatDetails.combatStats.armorPenetration;
                thornType = 'physicalThorns';
                break;
            case '/damage_types/water':
                sourceDamageMultiplier = 1 + source.combatDetails.combatStats.waterAmplify;
                sourceResistance = source.combatDetails.totalWaterResistance;
                sourcePenetration = source.combatDetails.combatStats.waterPenetration;
                targetResistance = target.combatDetails.totalWaterResistance;
                targetThornPower = target.combatDetails.combatStats.elementalThorns;
                targetPenetration = target.combatDetails.combatStats.waterPenetration;
                thornType = 'elementalThorns';
                break;
            case '/damage_types/nature':
                sourceDamageMultiplier = 1 + source.combatDetails.combatStats.natureAmplify;
                sourceResistance = source.combatDetails.totalNatureResistance;
                sourcePenetration = source.combatDetails.combatStats.naturePenetration;
                targetResistance = target.combatDetails.totalNatureResistance;
                targetThornPower = target.combatDetails.combatStats.elementalThorns;
                targetPenetration = target.combatDetails.combatStats.naturePenetration;
                thornType = 'elementalThorns';
                break;
            case '/damage_types/fire':
                sourceDamageMultiplier = 1 + source.combatDetails.combatStats.fireAmplify;
                sourceResistance = source.combatDetails.totalFireResistance;
                sourcePenetration = source.combatDetails.combatStats.firePenetration;
                targetResistance = target.combatDetails.totalFireResistance;
                targetThornPower = target.combatDetails.combatStats.elementalThorns;
                targetPenetration = target.combatDetails.combatStats.firePenetration;
                thornType = 'elementalThorns';
                break;
            default:
                unknownMechanic = unknownMechanic || { category: 'damage type', value: damageType };
                break;
        }

        if (unknownMechanic) {
            recordUnknown(unknownMechanic.category, unknownMechanic.value);
            return CombatUtilities.skippedAttackResult();
        }

        let hitChance = 1;
        let critChance = 0;
        let isCrit = false;
        const bonusCritChance = source.combatDetails.combatStats.criticalRate;
        const bonusCritDamage = source.combatDetails.combatStats.criticalDamage;

        if (abilityEffect) {
            sourceAccuracyRating *= 1 + abilityEffect.bonusAccuracyRatio;
        }

        hitChance =
            Math.pow(sourceAccuracyRating, 1.4) /
            (Math.pow(sourceAccuracyRating, 1.4) + Math.pow(targetEvasionRating, 1.4));

        if (combatStyle === '/combat_styles/ranged') {
            critChance = 0.3 * hitChance;
        }

        critChance = critChance + bonusCritChance;

        const baseDamageFlat = abilityEffect ? abilityEffect.damageFlat : 0;
        const baseDamageRatio = abilityEffect ? abilityEffect.damageRatio : 1;

        const armorDamageRatioFlat = abilityEffect
            ? abilityEffect.armorDamageRatio * source.combatDetails.totalArmor
            : 0;

        let sourceMinDamage = sourceDamageMultiplier * (1 + baseDamageFlat + armorDamageRatioFlat);
        let sourceMaxDamage =
            sourceDamageMultiplier *
            (baseDamageRatio * sourceAutoAttackMaxDamage + baseDamageFlat + armorDamageRatioFlat);

        if (random() < critChance) {
            sourceMaxDamage = sourceMaxDamage * (1 + bonusCritDamage);
            sourceMinDamage = sourceMaxDamage;
            isCrit = true;
        }

        let damageRoll = CombatUtilities.randomInt(sourceMinDamage, sourceMaxDamage);
        // A deliberate divergence from the reference sims, which leave taskDamage
        // out of the attacker's roll. The stat is real — the game applies it, and
        // this engine already applies it to the same unit's thorns and
        // retaliation. Omitting it here understated anyone wearing a task
        // trinket, and made the two paths disagree about the same number.
        //
        // But the game only applies it while the monster is your task, so this
        // is gated on the caller having said so. Applied unconditionally it
        // inflated every generic sim and let task badges rank in the upgrade
        // advisor on damage they would never deal off task.
        if (isTaskFight) {
            damageRoll *= 1 + source.combatDetails.combatStats.taskDamage;
        }
        damageRoll *= 1 + target.combatDetails.combatStats.damageTaken;
        if (!abilityEffect) {
            damageRoll += damageRoll * source.combatDetails.combatStats.autoAttackDamage;
        } else {
            damageRoll *= 1 + source.combatDetails.combatStats.abilityDamage;
        }

        let damageDone = 0;
        let thornDamageDone = 0;

        let didHit = false;
        if (random() < hitChance) {
            didHit = true;
            let penetratedTargetResistance = targetResistance;

            if (sourcePenetration > 0 && targetResistance > 0) {
                penetratedTargetResistance = targetResistance / (1 + sourcePenetration);
            }

            let targetDamageTakenRatio = 100 / (100 + penetratedTargetResistance);
            if (penetratedTargetResistance < 0) {
                targetDamageTakenRatio = (100 - penetratedTargetResistance) / 100;
            }

            const mitigatedDamage = Math.ceil(targetDamageTakenRatio * damageRoll);
            damageDone = Math.min(mitigatedDamage, target.combatDetails.currentHitpoints);
            target.combatDetails.currentHitpoints -= damageDone;
        }

        if (targetThornPower > 0.0 && targetResistance > -99.0) {
            let penetratedSourceResistance = sourceResistance;

            if (sourceResistance > 0) {
                penetratedSourceResistance = sourceResistance / (1 + targetPenetration);
            }

            let sourceDamageTakenRatio = 100.0 / (100 + penetratedSourceResistance);
            if (penetratedSourceResistance < 0) {
                sourceDamageTakenRatio = (100 - penetratedSourceResistance) / 100;
            }

            // Same conditional stat, same gate: off task the defender's task
            // bonus does nothing to their thorns either
            const targetTaskDamageMultiplier = isTaskFight ? 1.0 + target.combatDetails.combatStats.taskDamage : 1.0;
            const sourceDamageTakenMultiplier = 1.0 + source.combatDetails.combatStats.damageTaken;
            const targetDamageMultiplier = targetTaskDamageMultiplier * sourceDamageTakenMultiplier;

            const thornsDamageRoll = CombatUtilities.randomInt(
                1,
                targetDamageMultiplier *
                    target.combatDetails.defensiveMaxDamage *
                    (1.0 + targetResistance / 100.0) *
                    targetThornPower
            );

            const mitigatedThornsDamage = Math.ceil(sourceDamageTakenRatio * thornsDamageRoll);

            thornDamageDone = Math.min(mitigatedThornsDamage, source.combatDetails.currentHitpoints);
            source.combatDetails.currentHitpoints -= thornDamageDone;
        }

        let retaliationDamageDone = 0;
        if (target.combatDetails.combatStats.retaliation > 0) {
            const retaliationHitChance =
                Math.pow(target.combatDetails.smashAccuracyRating, 1.4) /
                (Math.pow(target.combatDetails.smashAccuracyRating, 1.4) +
                    Math.pow(source.combatDetails.smashEvasionRating, 1.4));

            if (retaliationHitChance > random()) {
                let sourceEffectiveArmor = source.combatDetails.totalArmor;
                if (sourceEffectiveArmor > 0) {
                    sourceEffectiveArmor =
                        sourceEffectiveArmor / (1.0 + target.combatDetails.combatStats.armorPenetration);
                }

                let sourceDamageTakenRatio = 100.0 / (100.0 + sourceEffectiveArmor);
                if (sourceEffectiveArmor < 0) {
                    sourceDamageTakenRatio = (100.0 - sourceEffectiveArmor) / 100.0;
                }

                const targetTaskDamageMultiplier = isTaskFight
                    ? 1.0 + target.combatDetails.combatStats.taskDamage
                    : 1.0;
                const sourceDamageTakenMultiplier = 1.0 + source.combatDetails.combatStats.damageTaken;
                const retaliationDamageMultiplier = targetTaskDamageMultiplier * sourceDamageTakenMultiplier;

                let premitigatedDamage = damageRoll;
                premitigatedDamage = Math.min(premitigatedDamage, target.combatDetails.defensiveMaxDamage * 5);

                const retaliationMinDamage =
                    retaliationDamageMultiplier * target.combatDetails.combatStats.retaliation * premitigatedDamage;
                const retaliationMaxDamage =
                    retaliationDamageMultiplier *
                    target.combatDetails.combatStats.retaliation *
                    (target.combatDetails.defensiveMaxDamage + premitigatedDamage);

                const retaliationDamageRoll = CombatUtilities.randomInt(retaliationMinDamage, retaliationMaxDamage);
                const mitigatedRetaliationDamage = Math.ceil(sourceDamageTakenRatio * retaliationDamageRoll);
                retaliationDamageDone = Math.min(mitigatedRetaliationDamage, source.combatDetails.currentHitpoints);
                source.combatDetails.currentHitpoints -= retaliationDamageDone;
            }
        }

        let lifeStealHeal = 0;
        if (!abilityEffect && didHit && source.combatDetails.combatStats.lifeSteal > 0) {
            lifeStealHeal = source.addHitpoints(Math.floor(source.combatDetails.combatStats.lifeSteal * damageDone));
        }

        let hpDrain = 0;
        if (abilityEffect && didHit && abilityEffect.hpDrainRatio > 0) {
            const healingAmplify = 1 + source.combatDetails.combatStats.healingAmplify;
            hpDrain = source.addHitpoints(Math.floor(abilityEffect.hpDrainRatio * damageDone * healingAmplify));
        }

        let manaLeechMana = 0;
        if (!abilityEffect && didHit && source.combatDetails.combatStats.manaLeech > 0) {
            manaLeechMana = source.addManapoints(Math.floor(source.combatDetails.combatStats.manaLeech * damageDone));
        }

        return {
            damageDone,
            didHit,
            thornDamageDone,
            thornType,
            retaliationDamageDone,
            lifeStealHeal,
            hpDrain,
            manaLeechMana,
            isCrit,
        };
    }

    // The combat-style guards on processHeal and processRevive stay fatal on
    // purpose: CombatSimulator screens for an unsupported style before it
    // touches anything, so reaching one of these means a new caller skipped
    // that screen and is about to heal or revive off a formula that does not
    // apply. Better a loud stop than a silently wrong heal.
    static processHeal(source, abilityEffect, target) {
        if (abilityEffect.combatStyleHrid !== '/combat_styles/magic') {
            throw new Error('Heal ability effect not supported for combat style: ' + abilityEffect.combatStyleHrid);
        }

        const healingAmplify = 1 + source.combatDetails.combatStats.healingAmplify;
        const magicMaxDamage = source.combatDetails.magicMaxDamage;

        const baseHealFlat = abilityEffect.damageFlat;
        const baseHealRatio = abilityEffect.damageRatio;

        const minHeal = healingAmplify * (1 + baseHealFlat);
        const maxHeal = healingAmplify * (baseHealRatio * magicMaxDamage + baseHealFlat);

        const heal = this.randomInt(minHeal, maxHeal);
        const amountHealed = target.addHitpoints(heal);

        return amountHealed;
    }

    static processRevive(source, abilityEffect, target) {
        if (abilityEffect.combatStyleHrid !== '/combat_styles/magic') {
            throw new Error('Heal ability effect not supported for combat style: ' + abilityEffect.combatStyleHrid);
        }

        const healingAmplify = 1 + source.combatDetails.combatStats.healingAmplify;
        const magicMaxDamage = source.combatDetails.magicMaxDamage;

        const baseHealFlat = abilityEffect.damageFlat;
        const baseHealRatio = abilityEffect.damageRatio;

        const minHeal = healingAmplify * (1 + baseHealFlat);
        const maxHeal = healingAmplify * (baseHealRatio * magicMaxDamage + baseHealFlat);

        const heal = this.randomInt(minHeal, maxHeal);
        const amountHealed = target.addHitpoints(heal);
        target.combatDetails.currentManapoints = target.combatDetails.maxManapoints;
        target.clearCCs();

        // target.clearBuffs();

        return amountHealed;
    }

    static processSpendHp(source, abilityEffect) {
        const currentHp = source.combatDetails.currentHitpoints;
        const spendHpRatio = abilityEffect.spendHpRatio;

        const spentHp = Math.floor(currentHp * spendHpRatio);

        source.combatDetails.currentHitpoints -= spentHp;

        return spentHp;
    }

    /**
     * Cumulative-floor discretization of totalValue over totalTicks: the per-tick
     * deltas sum to exactly totalValue and land the last unit on the final tick.
     *
     * When totalTicks is a whole number every currentTick is <= totalTicks, so the
     * guard below never fires and the result is byte-identical to the plain floors
     * (which already sum to Math.floor(totalValue)). But a DoT/HoT whose duration
     * is not a whole multiple of its tick interval has a fractional totalTicks and
     * runs ceil(totalTicks) ticks; on that final tick currentTick > totalTicks, and
     * the plain floor would push the cumulative sum past totalValue so the effect
     * over-delivers. Once a tick's index passes totalTicks the cumulative delivery
     * is pinned to Math.floor(totalValue) — the exact total the whole-count case
     * already lands on — so the summed delivery can never exceed it and the final
     * tick lands precisely on it (computing it directly also avoids the floating
     * point error a totalTicks*totalValue/totalTicks division would introduce).
     * @param {number} totalValue - Total to distribute across all ticks.
     * @param {number} totalTicks - Tick count; may be fractional.
     * @param {number} currentTick - 1-based index of the tick being delivered.
     * @returns {number} This tick's share of totalValue.
     */
    static calculateTickValue(totalValue, totalTicks, currentTick) {
        const cumulative = (tick) =>
            tick > totalTicks ? Math.floor(totalValue) : Math.floor((tick * totalValue) / totalTicks);

        return cumulative(currentTick) - cumulative(currentTick - 1);
    }
}

export default CombatUtilities;
