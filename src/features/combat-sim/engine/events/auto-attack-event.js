// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
import CombatEvent from './combat-event.js';

class AutoAttackEvent extends CombatEvent {
    static type = 'autoAttack';

    constructor(time, source) {
        super(AutoAttackEvent.type, time);

        this.source = source;
    }
}

export default AutoAttackEvent;
