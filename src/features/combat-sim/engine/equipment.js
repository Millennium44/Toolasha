// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
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
        const multiplier = gameData.enhancementLevelTotalBonusMultiplierTable?.[this.enhancementLevel] || 0;
        const base = this.gameItem.equipmentDetail.combatStats?.[combatStat] || 0;
        const enhancementBonus = this.gameItem.equipmentDetail.combatEnhancementBonuses?.[combatStat] || 0;

        // Gating on the base stat alone dropped the enhancement bonus of every
        // item whose base for that stat is exactly 0 — a real shape in the game
        // data, where enhancing is what turns the stat on in the first place
        if (!base && !enhancementBonus) {
            return 0;
        }

        return base + multiplier * enhancementBonus;
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
