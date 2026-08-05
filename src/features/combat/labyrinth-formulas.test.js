/**
 * Tests for the game's own labyrinth formulas and reward tables.
 *
 * Moved out of labyrinth-clear-rate.test.js with the code they cover; like
 * the formulas themselves these need no game state.
 */

import { describe, test, expect } from 'vitest';

import { labyrinthGridSize, labyrinthRoomRewards } from './labyrinth-formulas.js';

describe('official labyrinth reward tables', () => {
    test('a challenge room rolls MIN(Floor × 5%, 50%) for a token, capped from floor 10', () => {
        expect(labyrinthRoomRewards(1, 'combat').tokens).toBeCloseTo(0.05, 10);
        expect(labyrinthRoomRewards(7, 'skilling').tokens).toBeCloseTo(0.35, 10);
        expect(labyrinthRoomRewards(10, 'combat').tokens).toBeCloseTo(0.5, 10);
        expect(labyrinthRoomRewards(25, 'combat').tokens).toBeCloseTo(0.5, 10);
    });

    test("a challenge room rolls MIN(Floor × 1%, 10%) for a Purdora's Box of its own kind", () => {
        const combat = labyrinthRoomRewards(7, 'combat');
        expect(combat.combatBoxes).toBeCloseTo(0.07, 10);
        expect(combat.skillingBoxes).toBe(0);

        // Enhancing rooms are skilling rooms, so they pay the Skilling box
        for (const kind of ['skilling', 'enhancing']) {
            const skilling = labyrinthRoomRewards(7, kind);
            expect(skilling.skillingBoxes).toBeCloseTo(0.07, 10);
            expect(skilling.combatBoxes).toBe(0);
        }

        expect(labyrinthRoomRewards(10, 'combat').combatBoxes).toBeCloseTo(0.1, 10);
        expect(labyrinthRoomRewards(30, 'combat').combatBoxes).toBeCloseTo(0.1, 10);
    });

    test('a treasure room always pays MIN(Floor, 10) tokens', () => {
        expect(labyrinthRoomRewards(3, 'treasure').tokens).toBe(3);
        expect(labyrinthRoomRewards(10, 'treasure').tokens).toBe(10);
        expect(labyrinthRoomRewards(14, 'treasure').tokens).toBe(10);
    });

    test('a treasure room rolls MIN(Floor × 5%, 50%) for one box of each type', () => {
        const mid = labyrinthRoomRewards(6, 'treasure');
        expect(mid.skillingBoxes).toBeCloseTo(0.3, 10);
        expect(mid.combatBoxes).toBeCloseTo(0.3, 10);

        const capped = labyrinthRoomRewards(12, 'treasure');
        expect(capped.skillingBoxes).toBeCloseTo(0.5, 10);
        expect(capped.combatBoxes).toBeCloseTo(0.5, 10);
    });

    test('the floor exit always pays 5 × Floor tokens', () => {
        expect(labyrinthRoomRewards(1, 'exit').tokens).toBe(5);
        expect(labyrinthRoomRewards(9, 'exit').tokens).toBe(45);
    });

    test('the floor exit pays both box types from floor 4, averaging (Floor − 3) / 2 each', () => {
        expect(labyrinthRoomRewards(3, 'exit').skillingBoxes).toBe(0);
        expect(labyrinthRoomRewards(3, 'exit').combatBoxes).toBe(0);

        expect(labyrinthRoomRewards(4, 'exit').skillingBoxes).toBeCloseTo(0.5, 10);
        expect(labyrinthRoomRewards(4, 'exit').combatBoxes).toBeCloseTo(0.5, 10);
        expect(labyrinthRoomRewards(9, 'exit').skillingBoxes).toBeCloseTo(3, 10);
        expect(labyrinthRoomRewards(9, 'exit').combatBoxes).toBeCloseTo(3, 10);
    });

    test('the floor exit pays a Refinement Chest from floor 6, averaging (Floor − 4) / 2', () => {
        expect(labyrinthRoomRewards(5, 'exit').refinementChests).toBe(0);
        expect(labyrinthRoomRewards(6, 'exit').refinementChests).toBeCloseTo(1, 10);
        expect(labyrinthRoomRewards(9, 'exit').refinementChests).toBeCloseTo(2.5, 10);
    });

    test('nothing drops below floor 1', () => {
        for (const kind of ['combat', 'skilling', 'treasure', 'exit']) {
            expect(labyrinthRoomRewards(0, kind)).toEqual({
                tokens: 0,
                skillingBoxes: 0,
                combatBoxes: 0,
                refinementChests: 0,
            });
        }
    });
});

describe('labyrinthGridSize', () => {
    test('a floor is MIN(3 + Floor, 8) rooms per side', () => {
        expect(labyrinthGridSize(1)).toBe(4);
        expect(labyrinthGridSize(4)).toBe(7);
        expect(labyrinthGridSize(5)).toBe(8);
        expect(labyrinthGridSize(12)).toBe(8);
    });

    test('there is no grid below floor 1', () => {
        expect(labyrinthGridSize(0)).toBe(0);
        expect(labyrinthGridSize(null)).toBe(0);
    });
});
