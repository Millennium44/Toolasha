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
