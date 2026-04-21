import Buff from './buff.js';
import { getGameData } from './game-data.js';

class HouseRoom {
    constructor(hrid, level) {
        this.hrid = hrid;
        this.level = level;

        const gameData = getGameData();
        const gameHouseRoom = gameData.houseRoomDetailMap[this.hrid];
        if (!gameHouseRoom) {
            throw new Error('No house room found for hrid: ' + this.hrid);
        }

        this.buffs = [];
        if (gameHouseRoom.actionBuffs) {
            for (const actionBuff of gameHouseRoom.actionBuffs) {
                const buff = new Buff(actionBuff, level);
                this.buffs.push(buff);
            }
        }
        if (gameHouseRoom.globalBuffs) {
            for (const globalBuff of gameHouseRoom.globalBuffs) {
                const buff = new Buff(globalBuff, level);
                this.buffs.push(buff);
            }
        }
    }
}

export default HouseRoom;
