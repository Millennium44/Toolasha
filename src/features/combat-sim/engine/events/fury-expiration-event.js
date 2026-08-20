// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
import CombatEvent from './combat-event.js';

class FuryExpirationEvent extends CombatEvent {
    static type = 'furyExpiration';

    constructor(time, furyAmount, source) {
        super(FuryExpirationEvent.type, time);

        this.furyAmount = furyAmount;
        this.source = source;
    }
}

export default FuryExpirationEvent;
