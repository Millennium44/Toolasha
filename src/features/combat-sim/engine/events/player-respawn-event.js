import CombatEvent from './combat-event.js';

class PlayerRespawnEvent extends CombatEvent {
    static type = 'playerRespawn';

    constructor(time, hrid) {
        super(PlayerRespawnEvent.type, time);
        this.hrid = hrid;
    }
}

export default PlayerRespawnEvent;
