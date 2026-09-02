/**
 * The per-wave first-hit windup a result keeps for a dungeon.
 *
 * A run that reads long could be slow to start each wave or slow to finish
 * it; the alive time per wave cannot tell those apart, the first-hit delay
 * can. It is timed from the wave's spawn (the '#k' open) to the first player
 * damage on a monster, once per wave, against the clock the simulator injects.
 */

import { describe, test, expect } from 'vitest';
import SimResult from './sim-result.js';

const zone = { hrid: '/actions/combat/chimerical_den', difficultyTier: 2 };
const player = { hrid: 'player1', isPlayer: true };
const monster = { hrid: '/monsters/griffin' };

function resultWithClock() {
    const result = new SimResult(zone, 1);
    let now = 0;
    result.clock = () => now;
    return { result, setTime: (t) => (now = t) };
}

describe('per-wave first hit', () => {
    test('records the delay from spawn to the first player hit, once per wave', () => {
        const { result, setTime } = resultWithClock();

        result.updateTimeSpentAlive('#1', true, 1_000);
        setTime(4_500);
        result.addAttack(player, monster, 'entangle', 120);
        setTime(5_000);
        result.addAttack(player, monster, 'entangle', 120); // a second hit does not count again
        result.updateTimeSpentAlive('#1', false, 9_000);

        expect(result.waveFirstHit).toEqual([{ name: '#1', total: 3_500, count: 1 }]);
    });

    test('each wave opens its own window and sums across runs', () => {
        const { result, setTime } = resultWithClock();

        result.updateTimeSpentAlive('#1', true, 0);
        setTime(3_000);
        result.addAttack(player, monster, 'a', 10);
        result.updateTimeSpentAlive('#1', false, 8_000);

        result.updateTimeSpentAlive('#2', true, 11_000);
        setTime(12_000);
        result.addAttack(player, monster, 'a', 10);
        result.updateTimeSpentAlive('#2', false, 20_000);

        // The next run's wave 1 adds to the same entry
        result.updateTimeSpentAlive('#1', true, 100_000);
        setTime(105_000);
        result.addAttack(player, monster, 'a', 10);
        result.updateTimeSpentAlive('#1', false, 110_000);

        expect(result.waveFirstHit).toEqual([
            { name: '#1', total: 8_000, count: 2 },
            { name: '#2', total: 1_000, count: 1 },
        ]);
    });

    test('a monster hitting a player, a miss, or zero damage does not count as the party’s first hit', () => {
        const { result, setTime } = resultWithClock();
        result.updateTimeSpentAlive('#1', true, 0);
        setTime(1_000);
        result.addAttack(monster, player, 'claw', 50);
        result.addAttack(player, monster, 'a', 'miss');
        result.addAttack(player, monster, 'a', 0);
        expect(result.waveFirstHit).toEqual([]);

        setTime(2_500);
        result.addAttack(player, monster, 'a', 30);
        expect(result.waveFirstHit).toEqual([{ name: '#1', total: 2_500, count: 1 }]);
    });

    test('a hit outside any dungeon wave, or with no clock, records nothing', () => {
        const noClock = new SimResult(zone, 1);
        noClock.updateTimeSpentAlive('#1', true, 0);
        noClock.addAttack(player, monster, 'a', 30);
        expect(noClock.waveFirstHit).toEqual([]);

        const { result, setTime } = resultWithClock();
        // A monster's own alive window ('/monsters/…') is not a wave
        result.updateTimeSpentAlive(monster.hrid, true, 0);
        setTime(500);
        result.addAttack(player, monster, 'a', 30);
        expect(result.waveFirstHit).toEqual([]);
    });
});
