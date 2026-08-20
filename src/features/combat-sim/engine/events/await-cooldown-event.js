// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
import CombatEvent from './combat-event.js';

class AwaitCooldownEvent extends CombatEvent {
    static type = 'awaitCooldownEvent';

    constructor(time, source) {
        super(AwaitCooldownEvent.type, time);

        this.source = source;
    }
}

export default AwaitCooldownEvent;
