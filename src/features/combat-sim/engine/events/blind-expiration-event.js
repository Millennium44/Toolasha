// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
import CombatEvent from './combat-event.js';

class BlindExpirationEvent extends CombatEvent {
    static type = 'blindExpiration';

    constructor(time, source) {
        super(BlindExpirationEvent.type, time);

        this.source = source;
    }
}

export default BlindExpirationEvent;
