import CombatEvent from './combat-event.js';

class SilenceExpirationEvent extends CombatEvent {
    static type = 'silenceExpiration';

    constructor(time, source) {
        super(SilenceExpirationEvent.type, time);

        this.source = source;
    }
}

export default SilenceExpirationEvent;
