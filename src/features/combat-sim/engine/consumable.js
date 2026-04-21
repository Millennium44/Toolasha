import Buff from './buff.js';
import { getGameData } from './game-data.js';
import Trigger from './trigger.js';

class Consumable {
    constructor(hrid, triggers = null) {
        this.hrid = hrid;

        const itemDetailMap = getGameData().itemDetailMap;
        const gameConsumable = itemDetailMap[this.hrid];
        if (!gameConsumable) {
            throw new Error('No consumable found for hrid: ' + this.hrid);
        }

        this.cooldownDuration = gameConsumable.consumableDetail.cooldownDuration;
        this.hitpointRestore = gameConsumable.consumableDetail.hitpointRestore;
        this.manapointRestore = gameConsumable.consumableDetail.manapointRestore;
        this.recoveryDuration = gameConsumable.consumableDetail.recoveryDuration;
        this.catagoryHrid = gameConsumable.categoryHrid;

        this.buffs = [];
        if (gameConsumable.consumableDetail.buffs) {
            for (const consumableBuff of gameConsumable.consumableDetail.buffs) {
                const buff = new Buff(consumableBuff);
                this.buffs.push(buff);
            }
        }

        if (triggers) {
            this.triggers = triggers;
        } else {
            this.triggers = [];
            for (const defaultTrigger of gameConsumable.consumableDetail.defaultCombatTriggers) {
                const trigger = new Trigger(
                    defaultTrigger.dependencyHrid,
                    defaultTrigger.conditionHrid,
                    defaultTrigger.comparatorHrid,
                    defaultTrigger.value
                );
                this.triggers.push(trigger);
            }
        }

        this.lastUsed = Number.MIN_SAFE_INTEGER;
    }

    static createFromDTO(dto) {
        const triggers = dto.triggers.map((trigger) => Trigger.createFromDTO(trigger));
        const consumable = new Consumable(dto.hrid, triggers);

        return consumable;
    }

    shouldTrigger(currentTime, source, target, friendlies, enemies) {
        if (source.isStunned) {
            return false;
        }
        let consumableHaste;
        if (this.catagoryHrid.includes('food')) {
            consumableHaste = source.combatDetails.combatStats.foodHaste;
        } else {
            consumableHaste = source.combatDetails.combatStats.drinkConcentration;
        }
        let cooldownDuration = this.cooldownDuration;
        if (consumableHaste > 0) {
            cooldownDuration = cooldownDuration / (1 + consumableHaste);
        }

        if (this.lastUsed + cooldownDuration > currentTime) {
            return false;
        }

        if (this.triggers.length === 0) {
            return true;
        }

        let shouldTrigger = true;
        for (const trigger of this.triggers) {
            if (!trigger.isActive(source, target, friendlies, enemies, currentTime)) {
                shouldTrigger = false;
            }
        }

        return shouldTrigger;
    }
}

export default Consumable;
