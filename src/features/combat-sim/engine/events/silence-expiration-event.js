// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
import CombatEvent from './combat-event.js';

class SilenceExpirationEvent extends CombatEvent {
    static type = 'silenceExpiration';

    constructor(time, source) {
        super(SilenceExpirationEvent.type, time);

        this.source = source;
    }
}

export default SilenceExpirationEvent;
