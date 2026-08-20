// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
import CombatEvent from './combat-event.js';

class ConsumableTickEvent extends CombatEvent {
    static type = 'consumableTick';

    constructor(time, source, consumable, totalTicks, currentTick) {
        super(ConsumableTickEvent.type, time);

        this.source = source;
        this.consumable = consumable;
        this.totalTicks = totalTicks;
        this.currentTick = currentTick;
    }
}

export default ConsumableTickEvent;
