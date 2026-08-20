// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
import CombatEvent from './combat-event.js';

class CooldownReadyEvent extends CombatEvent {
    static type = 'cooldownReady';

    constructor(time) {
        super(CooldownReadyEvent.type, time);
    }
}

export default CooldownReadyEvent;
