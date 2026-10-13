// Ported from the MWI Combat Simulator (MIT (c) 2024 AmVoidGuy) - see third-party/mwi-combat-simulator/.
import CombatEvent from './combat-event.js';

class AwaitCooldownEvent extends CombatEvent {
    static type = 'awaitCooldownEvent';

    /**
     * @param {number} time - When the wake fires
     * @param {Object} source - The unit being woken
     * @param {boolean} [blindWake] - True for the cadence wake a blinded unit queues in place of its
     *   swing. Those belong to a wave and are retired with its swings; the other wakes (mana
     *   restoration, cooldown ready) are not.
     */
    constructor(time, source, blindWake = false) {
        super(AwaitCooldownEvent.type, time);

        this.source = source;
        this.blindWake = blindWake;
    }
}

export default AwaitCooldownEvent;
