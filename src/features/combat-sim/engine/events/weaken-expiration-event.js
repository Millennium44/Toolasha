// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
import CombatEvent from './combat-event.js';

class WeakenExpirationEvent extends CombatEvent {
    static type = 'weakenExpiration';
    static maxWeakenStacks = 5;

    constructor(time, weakenAmount, source) {
        super(WeakenExpirationEvent.type, time);
        this.weakenAmount = Math.min(weakenAmount + 1, WeakenExpirationEvent.maxWeakenStacks);
        this.source = source;
    }
}

export default WeakenExpirationEvent;
