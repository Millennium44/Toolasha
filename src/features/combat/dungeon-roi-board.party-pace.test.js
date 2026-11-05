/**
 * The ROI board's food and XP come from the same party whose pace prices the row.
 */

import { describe, test, expect } from 'vitest';
import { buildDungeonRoiRows, measuredSessionRates } from './dungeon-roi-board.js';

const DEN = '/actions/combat/chimerical_den';
const dungeons = [{ hrid: DEN, name: 'Chimerical Den', maxWaves: 50, maxDifficulty: 2 }];

const pricing = {
    rewardsPerRun: (hrid, tier, partySize) =>
        new Map([
            ['/items/chimerical_chest', 5 / partySize],
            ['/items/chimerical_token', 40],
        ]),
    isToken: (hrid) => hrid.endsWith('_token'),
    tokenValue: () => 100,
    valueOf: (hrid) => (hrid.endsWith('_chest') ? 20_000 : null),
    keyCost: () => 1_000,
    entryKeyFor: () => '/items/chimerical_entry_key',
    consumablePrice: () => 200,
};

function run(durationMs, team) {
    return { dungeonName: 'Chimerical Den', tier: 0, duration: durationMs, team, teamKey: team.join(',') };
}

const player = (consumed, extra = {}) => ({
    isCurrentPlayer: true,
    consumables: [{ itemHrid: '/items/coffee', consumed }],
    experience: { attack: 36_000 },
    ...extra,
});
// Two party members sharing a name, neither the current character
const mate = { isCurrentPlayer: false, name: 'Mate', consumables: [{ itemHrid: '/items/x', consumed: 99 }] };

// An hour solo eating 50 coffee; an hour in a party of three eating 10
const soloSession = { actionHrid: DEN, durationSeconds: 3600, players: [player(50)] };
const partySession = { actionHrid: DEN, durationSeconds: 3600, players: [player(10), mate, { ...mate }] };

const denRow = (rows) => rows.find((row) => row.key === `${DEN}::T0`);

describe('food and XP come from the party the row prices', () => {
    test('measuredSessionRates counts only sessions of the asked party size', () => {
        const sessions = [soloSession, partySession];
        expect(measuredSessionRates(sessions, DEN, () => 200).consumableCostPerHour).toBeCloseTo(6_000);
        expect(measuredSessionRates(sessions, DEN, () => 200, 1).consumableCostPerHour).toBeCloseTo(10_000);
        expect(measuredSessionRates(sessions, DEN, () => 200, 3).consumableCostPerHour).toBeCloseTo(2_000);
        expect(measuredSessionRates(sessions, DEN, () => 200, 2)).toBeNull();
    });

    test('a party row is not charged a solo food bill, and a solo row not the party one', () => {
        const sessions = [soloSession, partySession];
        const party = buildDungeonRoiRows({
            dungeons,
            runs: [run(900_000, ['Me', 'B', 'C'])],
            sessions,
            pricing,
            filters: { tier: 0 },
        });
        expect(denRow(party).partySize).toBe(3);
        expect(denRow(party).consumableSource).toBe('measured');
        expect(denRow(party).consumableCostPerHour).toBeCloseTo(2_000);

        const solo = buildDungeonRoiRows({ dungeons, runs: [], sessions, pricing, filters: { tier: 0, partySize: 1 } });
        expect(denRow(solo).consumableCostPerHour).toBeCloseTo(10_000);
    });

    test('no session of the row party size blanks food and XP rather than borrowing another party', () => {
        const rows = buildDungeonRoiRows({
            dungeons,
            runs: [],
            sessions: [soloSession],
            pricing,
            filters: { tier: 0, partySize: 3 },
        });
        expect(denRow(rows).consumableCostPerHour).toBeNull();
        expect(denRow(rows).xpPerHour).toBeNull();
        expect(denRow(rows).netPerHour).toBeNull();
    });

    test('an unpriced consumable blanks the party that ate it', () => {
        const rows = buildDungeonRoiRows({
            dungeons,
            runs: [run(900_000, ['Me', 'B', 'C'])],
            sessions: [soloSession, partySession],
            pricing: { ...pricing, consumablePrice: (hrid) => (hrid === '/items/coffee' ? null : 200) },
            filters: { tier: 0 },
        });
        expect(denRow(rows).consumableUnpriced).toBe(true);
        expect(denRow(rows).consumableCostPerHour).toBeNull();
        expect(denRow(rows).netPerRun).toBeNull();
    });

    test('a session with no consumables list is unknown food, not free food', () => {
        const sessions = [{ actionHrid: DEN, durationSeconds: 3600, players: [{ isCurrentPlayer: true }] }];
        expect(measuredSessionRates(sessions, DEN, () => 200).consumableCostPerHour).toBeNull();
    });

    test('a sim reading of another party size is not used for food or XP', () => {
        const snapshot = {
            zones: [
                {
                    zoneHrid: DEN,
                    difficultyTier: 0,
                    xpPerHour: 70_000,
                    dungeon: { completions: 10, simHours: 5, partySize: 1, consumableCostPerHour: 9_000 },
                },
            ],
        };
        const base = { dungeons, runs: [], sessions: [], snapshot, pricing };
        const party = denRow(buildDungeonRoiRows({ ...base, filters: { tier: 0, partySize: 3 } }));
        expect(party.consumableCostPerHour).toBeNull();
        expect(party.xpPerHour).toBeNull();
        const solo = denRow(buildDungeonRoiRows({ ...base, filters: { tier: 0 } }));
        expect(solo.consumableCostPerHour).toBe(9_000);
    });

    test('a member with no recorded experience still counts the session', () => {
        const sessions = [{ actionHrid: DEN, durationSeconds: 3600, players: [player(10, { experience: undefined })] }];
        const rates = measuredSessionRates(sessions, DEN, () => 200, 1);
        expect(rates.xpPerHour).toBe(0);
        expect(rates.consumableCostPerHour).toBeCloseTo(2_000);
    });
});
