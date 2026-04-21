import CombatEvent from './combat-event.js';

class CooldownReadyEvent extends CombatEvent {
    static type = 'cooldownReady';

    constructor(time) {
        super(CooldownReadyEvent.type, time);
    }
}

export default CooldownReadyEvent;
