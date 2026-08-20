// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
import CombatEvent from './combat-event.js';

class CombatStartEvent extends CombatEvent {
    static type = 'combatStart';

    constructor(time) {
        super(CombatStartEvent.type, time);
    }
}

export default CombatStartEvent;
