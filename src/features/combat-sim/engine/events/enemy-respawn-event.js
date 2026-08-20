// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
import CombatEvent from './combat-event.js';

class EnemyRespawnEvent extends CombatEvent {
    static type = 'enemyRespawn';

    constructor(time) {
        super(EnemyRespawnEvent.type, time);
    }
}

export default EnemyRespawnEvent;
