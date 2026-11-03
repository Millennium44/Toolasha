/**
 * Past weeks' Guild Points against the guild's own completion announcements.
 *
 * The 11/1 cycle read 21,475 where the guild paid 24,419: the alchemy card was
 * zeroed by the roll and counted for nothing. The 11/2 cycle states 23,544 outright
 * in the guild payload's `points` map, which no reader looked at. Both pairs are real.
 */

import { describe, test, expect } from 'vitest';

import { payloadPoints, summariseArchivedCycle } from './guild-trial-history.js';
import { resultPoints, resultsFromCycle } from './guild-trial-results.js';
import { eligibleMemberTokens, parseCurrentTrialsData } from './guild-trials-math.js';
import { recordServerTiers } from './guild-trials-store.js';
import {
    ANNOUNCED,
    HALL_BONUS,
    NOV1_TILES,
    NOV2_CURRENT_TRIALS_DATA,
    TREASURY_BONUS,
} from './guild-trial-points.fixture.js';

const bonuses = { buildersHallBonus: HALL_BONUS, treasuryBonus: TREASURY_BONUS };
const now = Date.parse('2026-11-02T22:00:00Z');

/**
 * The 11/2 cycle's tiles as the store writes them from the payload alone.
 * @returns {Object} Archived cycle
 */
function nov2Cycle() {
    const read = parseCurrentTrialsData(NOV2_CURRENT_TRIALS_DATA);
    const at = 1793658000000;
    let record = { weekStart: 1793318400000, tiles: {} };
    const parties = { ...read.skilling.trials, ...read.combat.trials };
    for (const [hrid, party] of Object.entries(parties)) {
        const kind = hrid.startsWith('/guild_combat') ? 'combat' : 'skilling';
        const name = hrid.split('/').pop();
        record = recordServerTiers(record, `${kind}::${name}`, {
            bankedTier: party.highestTier,
            done: party.done,
            at,
            points: party.points,
            create: { name: kind === 'combat' ? `Trial ${name}` : name, kind },
        });
    }
    return {
        weekStart: 1793318400000,
        archivedAt: at,
        cycleFrom: at,
        reason: 'a new cycle is scheduled',
        tiles: record.tiles,
    };
}

describe('the guild payload states each trial’s Guild Points', () => {
    test('the 11/2 payload’s points sum to the announced 23,544', () => {
        const read = parseCurrentTrialsData(NOV2_CURRENT_TRIALS_DATA);
        const all = [...Object.values(read.skilling.trials), ...Object.values(read.combat.trials)];
        expect(all.reduce((sum, party) => sum + party.points, 0)).toBe(ANNOUNCED.nov2.points);
    });

    test('a payload with no points map reads null, not zero', () => {
        const read = parseCurrentTrialsData(
            JSON.stringify({
                combat: { status: 'in_progress', parties: { '/guild_combat/swarm': { highestTier: 2 } } },
            })
        );
        expect(read.combat.trials['/guild_combat/swarm'].points).toBeNull();
    });

    test('Past weeks for 11/2 is exact and the tokens fit the announcement', () => {
        const summary = summariseArchivedCycle(nov2Cycle(), { now, ...bonuses });
        expect(summary.points).toBe(23544);
        expect(summary.pointsDerived).toBe(false);
        // 23,544 / 1.4 = 16,817.1 base; half at +6% is 8,913.1 against the announced 8,913
        expect(Math.round(summary.tokens)).toBe(ANNOUNCED.nov2.eligibleTokens);
        // Participants: a further half, rounded up
        expect(Math.ceil(Math.round(summary.tokens) / 2)).toBe(ANNOUNCED.nov2.participantExtra);
    });

    test('points never start a tile, and never land on one with no statement of this cycle', () => {
        const record = { weekStart: 1, tiles: { 'skilling::alchemy': { name: 'Alchemy', kind: 'skilling' } } };
        expect(recordServerTiers(record, 'skilling::alchemy', { points: 2981, at: 5 })).toBe(record);
        const empty = { weekStart: 1, tiles: {} };
        expect(recordServerTiers(empty, 'skilling::alchemy', { points: 2981, at: 5 }).tiles).toEqual({});
    });

    test('points ride on a tile already stated, and a repeat changes nothing', () => {
        const held = {
            weekStart: 1,
            tiles: { 'skilling::alchemy': { name: 'Alchemy', kind: 'skilling', serverTier: 20, serverTierAt: 9 } },
        };
        const next = recordServerTiers(held, 'skilling::alchemy', { points: 2981, at: 9 });
        expect(next.tiles['skilling::alchemy'].serverPoints).toBe(2981);
        expect(recordServerTiers(next, 'skilling::alchemy', { points: 2981, at: 9 })).toBe(next);
    });

    test('a record an older build wrote, with no serverPoints, reads as before', () => {
        const tile = { name: 'Alchemy', kind: 'skilling', tier: 3, points: 700, serverTier: 3, serverTierAt: 1 };
        expect(payloadPoints(tile)).toBeNull();
        expect(summariseArchivedCycle({ weekStart: 1, tiles: { a: tile } }, { now }).points).toBe(700);
    });

    test('a card that reached a higher tier than the payload keeps its own figure', () => {
        const tile = {
            name: 'Alchemy',
            kind: 'skilling',
            tier: 5,
            points: 1500,
            serverTier: 4,
            serverTierAt: 1,
            serverPoints: 1100,
        };
        expect(payloadPoints(tile)).toBeNull();
    });
});

describe('the 11/1 cycle: a zeroed card still has its quoted figure', () => {
    const cycle = { weekStart: 1793318400000, archivedAt: 1793660000000, cycleFrom: 1793660000000, tiles: NOV1_TILES };

    test('the six stated figures add to the announced 24,419, not 21,475', () => {
        const summary = summariseArchivedCycle(cycle, { now, ...bonuses });
        expect(summary.points).toBe(ANNOUNCED.nov1.points);
        expect(summary.pointsDerived).toBe(false);
        expect(summary.combatTier).toBe(21);
        expect(summary.skillingTier).toBe(21);
    });

    test('tokens come within one of the announced 9,245', () => {
        const summary = summariseArchivedCycle(cycle, { now, ...bonuses });
        // 24,419 / 1.4 / 2 x 1.06 = 9,244.3: the game's own rounding is one off, which the ~ covers
        expect(Math.abs(Math.round(summary.tokens) - ANNOUNCED.nov1.eligibleTokens)).toBeLessThanOrEqual(1);
        expect(eligibleMemberTokens(24419 / 1.4, TREASURY_BONUS)).toBeCloseTo(9244.3, 1);
    });

    test('the Trial history result for the zeroed card carries the quoted figure, not zero or the ladder', () => {
        const alchemy = resultsFromCycle(cycle).find((result) => result.trial === 'alchemy');
        expect(resultPoints(alchemy, HALL_BONUS)).toEqual({ points: 2944, derived: false });
    });

    test('a zeroed card that quoted nothing is still priced off the ladder, marked derived', () => {
        const bare = { ...NOV1_TILES, 'skilling::alchemy': { ...NOV1_TILES['skilling::alchemy'], pointsByTier: {} } };
        const summary = summariseArchivedCycle({ ...cycle, tiles: bare }, { now, ...bonuses });
        expect(summary.points).toBe(24415);
        expect(summary.pointsDerived).toBe(true);
    });
});
