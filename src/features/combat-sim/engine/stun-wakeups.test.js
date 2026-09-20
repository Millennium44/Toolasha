import { describe, expect, test } from 'vitest';

import CombatSimulator from './combat-simulator.js';
import AutoAttackEvent from './events/auto-attack-event.js';
import AwaitCooldownEvent from './events/await-cooldown-event.js';
import BlindExpirationEvent from './events/blind-expiration-event.js';
import StunExpirationEvent from './events/stun-expiration-event.js';

const SECOND = 1e9;

/** A stunned player whose stun outlasts its normal attack interval. */
function harness() {
    const source = {
        hrid: 'player1',
        isPlayer: true,
        isStunned: true,
        isBlinded: false,
        abilities: [],
        combatDetails: {
            currentHitpoints: 100,
            combatStats: { attackInterval: SECOND },
        },
    };
    const sim = new CombatSimulator([source], { hrid: '/actions/test', difficultyTier: 0 });
    sim.simulationTime = 0;
    sim.enemies = [{ combatDetails: { currentHitpoints: 100 } }];
    sim.checkTriggers = () => {};
    sim.eventQueue.addEvent(new StunExpirationEvent(10 * SECOND, source));
    return { sim, source };
}

describe('stunned units cannot be rearmed by unrelated wake-ups', () => {
    test('a blind expiration does not restart attacks before stun expires', () => {
        const { sim, source } = harness();
        source.isBlinded = true;

        sim.processEvent(new BlindExpirationEvent(SECOND, source));

        expect(source.isBlinded).toBe(false);
        expect(source.isStunned).toBe(true);
        expect(sim.eventQueue.getByTypeAndSource(AutoAttackEvent.type, source)).toBeNull();
        sim.processEvent(sim.eventQueue.getNextEvent());
        expect(source.isStunned).toBe(false);
        expect(sim.eventQueue.getByTypeAndSource(AutoAttackEvent.type, source).time).toBe(11 * SECOND);
    });

    test('a mana-restoration wake-up cannot bypass stun', () => {
        const { sim, source } = harness();

        sim.processEvent(new AwaitCooldownEvent(SECOND, source));

        expect(sim.eventQueue.getByTypeAndSource(AutoAttackEvent.type, source)).toBeNull();
        expect(sim.eventQueue.getByTypeAndSource(StunExpirationEvent.type, source).time).toBe(10 * SECOND);
    });

    test('starting a new wave does not restart a stunned survivor', () => {
        const { sim, source } = harness();
        sim.enemies[0].abilities = [];
        sim.enemies[0].combatDetails.combatStats = { attackInterval: SECOND };

        sim.startAttacks();

        expect(sim.eventQueue.getByTypeAndSource(AutoAttackEvent.type, source)).toBeNull();
    });
});
