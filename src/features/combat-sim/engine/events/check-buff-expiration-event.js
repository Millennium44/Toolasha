import CombatEvent from './combat-event.js';

class CheckBuffExpirationEvent extends CombatEvent {
    static type = 'checkBuffExpiration';

    constructor(time, source) {
        super(CheckBuffExpirationEvent.type, time);

        this.source = source;
    }
}

export default CheckBuffExpirationEvent;
