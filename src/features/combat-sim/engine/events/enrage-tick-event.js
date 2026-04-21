import CombatEvent from './combat-event.js';

class EnrageTickEvent extends CombatEvent {
    static type = 'enrageTick';

    constructor(time, encounterTime) {
        super(EnrageTickEvent.type, time);

        this.encounterTime = encounterTime;
    }
}

export default EnrageTickEvent;
