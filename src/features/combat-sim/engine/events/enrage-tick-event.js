// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
import CombatEvent from './combat-event.js';

class EnrageTickEvent extends CombatEvent {
    static type = 'enrageTick';

    constructor(time, encounterTime) {
        super(EnrageTickEvent.type, time);

        this.encounterTime = encounterTime;
    }
}

export default EnrageTickEvent;
