// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
import CombatEvent from './combat-event.js';

class RegenTickEvent extends CombatEvent {
    static type = 'regenTick';

    constructor(time) {
        super(RegenTickEvent.type, time);
    }
}

export default RegenTickEvent;
