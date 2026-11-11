import { describe, test, expect } from 'vitest';
import SimResult from './sim-result.js';

const zone = { hrid: '/actions/combat/chimerical_den', difficultyTier: 0 };
const player = { hrid: 'player1', isPlayer: true };

describe('SimResult per-ability casts', () => {
    test('each cast adds one to its ability and to the player total', () => {
        const result = new SimResult(zone, 1);
        result.addCastMade(player, { hrid: '/abilities/fireball' });
        result.addCastMade(player, { hrid: '/abilities/fireball' });
        result.addCastMade(player, { hrid: '/abilities/quick_aid' });

        expect(result.abilityCasts.player1).toEqual({ '/abilities/fireball': 2, '/abilities/quick_aid': 1 });
        expect(result.manaCastsMade.player1).toBe(3);
    });

    test('an equipped ability that never fired is recorded with 0, and a cast one is untouched', () => {
        const result = new SimResult(zone, 1);
        result.addCastMade(player, { hrid: '/abilities/fireball' });
        result.setAbilityCastSlots({
            hrid: 'player1',
            abilities: [null, { hrid: '/abilities/fireball' }, { hrid: '/abilities/quick_aid' }],
        });

        expect(result.abilityCasts.player1).toEqual({ '/abilities/fireball': 1, '/abilities/quick_aid': 0 });
    });

    test('a cast with no ability named still counts in the total', () => {
        const result = new SimResult(zone, 1);
        result.addCastMade(player);
        expect(result.manaCastsMade.player1).toBe(1);
        expect(result.abilityCasts.player1).toBeUndefined();
    });
});
