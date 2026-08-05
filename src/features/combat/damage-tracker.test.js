/**
 * When one run stops being the same run.
 *
 * The tally is keyed by battle slot, which is a position in *this* fight rather
 * than an identity. That is fine while the fight keeps the same shape and wrong
 * the moment it does not: leave a party of five and slot 0 stops being whoever
 * it was, while slots 1 to 4 stop being anybody at all.
 *
 * Both symptoms came from the same cause and both are here — four people who
 * had left still listed, and your own name on two rows at once.
 */

import { describe, test, expect } from 'vitest';
import { sessionKeyFor } from './damage-tracker.js';

const battle = (names, combatStartTime = '2026-08-03T01:00:00Z') => ({
    combatStartTime,
    players: names.map((name) => ({ name })),
});

describe('naming a run', () => {
    test('the same party in the same run is the same key', () => {
        expect(sessionKeyFor(battle(['Millennium44', 'Gold999']))).toBe(
            sessionKeyFor(battle(['Millennium44', 'Gold999']))
        );
    });

    test('somebody leaving is a different run', () => {
        // The screenshot case: a party of five, then alone, and the four who
        // left were still in the DPS table
        const party = sessionKeyFor(battle(['Millennium44', 'Gold999', 'Briggsy99', 'heymouse', 'Overdark']));
        const alone = sessionKeyFor(battle(['Millennium44']));

        expect(alone).not.toBe(party);
    });

    test('somebody joining is too', () => {
        expect(sessionKeyFor(battle(['Millennium44']))).not.toBe(sessionKeyFor(battle(['Millennium44', 'Gold999'])));
    });

    test('the same party starting a new run is a different run', () => {
        // Which is why the roster alone is not enough
        const first = sessionKeyFor(battle(['Millennium44'], '2026-08-03T01:00:00Z'));
        const second = sessionKeyFor(battle(['Millennium44'], '2026-08-03T04:00:00Z'));

        expect(second).not.toBe(first);
    });

    test('a message with nobody in it names nothing', () => {
        // Rather than a key that every other empty message would also match,
        // which would reset the run on every one of them
        expect(sessionKeyFor({ players: [] })).toBeNull();
        expect(sessionKeyFor(null)).toBeNull();
    });

    test('a party in a different order is a different key, and that is fine', () => {
        // Slots are what the tally is keyed by, so a reordered party genuinely
        // cannot keep its figures — resetting is the correct outcome, not a
        // limitation being worked around
        expect(sessionKeyFor(battle(['A', 'B']))).not.toBe(sessionKeyFor(battle(['B', 'A'])));
    });
});
