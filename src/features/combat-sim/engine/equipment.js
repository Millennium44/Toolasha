import { getGameData } from './game-data.js';

class Equipment {
    constructor(hrid, enhancementLevel) {
        this.hrid = hrid;
        const gameData = getGameData();
        const gameItem = gameData.itemDetailMap[this.hrid];
        if (!gameItem) {
            throw new Error('No equipment found for hrid: ' + this.hrid);
        }
        this.gameItem = gameItem;
        this.enhancementLevel = enhancementLevel;
    }

    static createFromDTO(dto) {
        const equipment = new Equipment(dto.hrid, dto.enhancementLevel);

        return equipment;
    }

    getCombatStat(combatStat) {
        const gameData = getGameData();
        const multiplier = gameData.enhancementLevelTotalBonusMultiplierTable[this.enhancementLevel];
        if (this.gameItem.equipmentDetail.combatStats[combatStat]) {
            const enhancementBonus = this.gameItem.equipmentDetail.combatEnhancementBonuses[combatStat] || 0;
            const stat = this.gameItem.equipmentDetail.combatStats[combatStat] + multiplier * enhancementBonus;
            return stat;
        }
        return 0;
    }

    getCombatStyle() {
        return this.gameItem.equipmentDetail.combatStats.combatStyleHrids[0];
    }

    getDamageType() {
        return this.gameItem.equipmentDetail.combatStats.damageType;
    }

    getPrimaryTraining() {
        return this.gameItem.equipmentDetail.combatStats.primaryTraining;
    }

    getFocusTraining() {
        return this.gameItem.equipmentDetail.combatStats.focusTraining;
    }
}

export default Equipment;
