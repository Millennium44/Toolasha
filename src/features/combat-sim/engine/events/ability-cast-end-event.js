// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
import CombatEvent from './combat-event.js';

class AbilityCastEndEvent extends CombatEvent {
    static type = 'abilityCastEndEvent';

    constructor(time, source, ability) {
        super(AbilityCastEndEvent.type, time);

        this.source = source;
        this.ability = ability;
    }
}

export default AbilityCastEndEvent;
