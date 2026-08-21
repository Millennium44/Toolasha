/** @vitest-environment happy-dom */
/**
 * The pure parts of the leaderboard rate columns: the day figure, the catch-up
 * estimate, and what a board counts.
 */
import { describe, test, expect, vi } from 'vitest';

vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
vi.mock('./leaderboard-xp-tracker.js', () => ({
    leaderboardXPTracker: {
        getPlayerStats: () => ({}),
        getLatestValue: () => null,
        getPreviousRank: () => null,
        getLastLeaderboardCategory: () => null,
    },
    isLevelBoard: (category) => category === 'total_level',
    isWeeklyBoard: (category) => typeof category === 'string' && category.includes('weekly'),
}));

const { xpPerDay, xpPerWeek, timeToOvertake, boardUnit, assignRateRanks, rateRankEligible, LEVEL_RATE_RANK_CUTOFF } =
    await import('./leaderboard-xp-display.js');

describe('xpPerDay', () => {
    test('a measured day is the 24h-window rate scaled to a day', () => {
        expect(xpPerDay({ lastDayXPH: 1000, dayReadings: 3, lastXPH: 5000 })).toEqual({
            value: 24000,
            projected: false,
        });
    });

    test('without two readings in the day it projects from the last rate, and says so', () => {
        expect(xpPerDay({ lastDayXPH: 0, dayReadings: 1, lastXPH: 100 })).toEqual({ value: 2400, projected: true });
    });

    test('no rate at all is zero', () => {
        expect(xpPerDay({ lastDayXPH: 0, dayReadings: 0, lastXPH: 0 })).toEqual({ value: 0, projected: false });
    });
});

describe('xpPerWeek', () => {
    const day = 24 * 60 * 60 * 1000;

    test('a measured week needs two readings more than a day apart within the week', () => {
        expect(xpPerWeek({ lastWeekXPH: 1, weekReadings: 3, weekSpanMs: 3 * day, lastDayXPH: 0, lastXPH: 0 })).toEqual({
            value: 168,
            projected: false,
        });
    });

    test('otherwise it projects the day figure over a week, and says so', () => {
        expect(
            xpPerWeek({
                lastWeekXPH: 5,
                weekReadings: 2,
                weekSpanMs: 3600000,
                lastDayXPH: 5,
                dayReadings: 2,
                lastXPH: 5,
            })
        ).toEqual({ value: 5 * 24 * 7, projected: true });
    });
});

describe('timeToOvertake', () => {
    test('closes the gap at the difference of the two rates', () => {
        // 10,000 behind, gaining 1,000/h net: 10h
        const result = timeToOvertake({ rank: 5, value: 90000, lastXPH: 3000 }, { value: 100000, lastXPH: 2000 });
        expect(result).toEqual({ hours: 10, floor: false, reason: 'ok' });
    });

    test('a row above with no rate gives a floor, not a forecast', () => {
        const result = timeToOvertake({ rank: 5, value: 90000, lastXPH: 5000 }, { value: 100000, lastXPH: 0 });
        expect(result).toEqual({ hours: 2, floor: true, reason: 'ok' });
    });

    test('not gaining, no rate, no gap, top and off-page all come back as reasons', () => {
        expect(timeToOvertake({ rank: 5, value: 90000, lastXPH: 1000 }, { value: 100000, lastXPH: 2000 }).reason).toBe(
            'not-gaining'
        );
        expect(timeToOvertake({ rank: 5, value: 90000, lastXPH: 0 }, { value: 100000, lastXPH: 0 }).reason).toBe(
            'no-rate'
        );
        expect(timeToOvertake({ rank: 5, value: 100000, lastXPH: 10 }, { value: 100000, lastXPH: 0 }).reason).toBe(
            'no-gap'
        );
        expect(timeToOvertake({ rank: 1, value: 1, lastXPH: 10 }, null).reason).toBe('top');
        expect(timeToOvertake({ rank: 477, value: 1, lastXPH: 10 }, null).reason).toBe('unknown-above');
    });
});

describe('boardUnit', () => {
    const header = (...names) => {
        const tr = document.createElement('tr');
        for (const name of names) {
            const th = document.createElement('th');
            th.textContent = name;
            tr.appendChild(th);
        }
        return tr;
    };

    test('Experience boards count XP', () => {
        expect(boardUnit(header('Rank', 'Name', 'Level', 'Experience'))).toBe('XP');
    });

    test('points boards count Points, whatever kind', () => {
        expect(boardUnit(header('Rank', 'Name', 'Guild Points'))).toBe('Points');
        expect(boardUnit(header('Rank', 'Name', 'Task Points'))).toBe('Points');
        expect(boardUnit(header('Rank', 'Name', 'Weekly Points △ ▽'))).toBe('Points');
    });

    test('anything else is taken as written, and this module’s own columns are ignored', () => {
        const tr = header('Rank', 'Name', 'Buildings');
        const ours = document.createElement('th');
        ours.className = 'mwi-leaderboard-xp';
        ours.textContent = 'Buildings/h';
        tr.appendChild(ours);
        expect(boardUnit(tr)).toBe('Buildings');
    });
});

describe('rate ranks on a level board', () => {
    const row = (rank, perDay) => ({
        name: `p${rank}`,
        rank,
        lastXPH: perDay / 24,
        perDay: { value: perDay, projected: true },
        perWeek: { value: perDay * 7, projected: true },
    });

    test('a row outside the top 100 by level measures a rate but holds no rank', () => {
        const rows = [row(1, 0.4), row(70, 0.5), row(1199, 3.6)];
        assignRateRanks(rows, 'total_level');
        const outside = rows[2];
        expect(outside.rateRankEligible).toBe(false);
        expect(outside.perDay.value).toBe(3.6); // the rate is still there
        expect(outside.perDay_rank).toBeNull();
        expect(outside.perWeek_rank).toBeNull();
        expect(outside.lastXPH_rank).toBeNull();
    });

    test('the fastest of the top 100 takes #1, undisplaced by the faster row below', () => {
        const rows = [row(1, 0.4), row(70, 0.5), row(1199, 3.6)];
        assignRateRanks(rows, 'total_level');
        expect(rows[1].perDay_rank).toBe(1);
        expect(rows[0].perDay_rank).toBe(2);
        expect(rows[1].perWeek_rank).toBe(1);
    });

    test('the cutoff is inclusive: rank 100 is ranked, rank 101 is not', () => {
        expect(rateRankEligible('total_level', LEVEL_RATE_RANK_CUTOFF)).toBe(true);
        expect(rateRankEligible('total_level', LEVEL_RATE_RANK_CUTOFF + 1)).toBe(false);
        expect(rateRankEligible('total_level', null)).toBe(false);
    });

    test('XP boards rank everyone tracked, at any rank', () => {
        const rows = [row(1, 1e6), row(1199, 5e6)];
        assignRateRanks(rows, 'foraging');
        expect(rows.map((s) => s.rateRankEligible)).toEqual([true, true]);
        expect(rows[1].lastXPH_rank).toBe(1);
        expect(rows[0].lastXPH_rank).toBe(2);
        expect(rateRankEligible('cheesesmithing', 5000)).toBe(true);
        expect(rateRankEligible('guild', 5000)).toBe(true);
    });

    test('an unranked row gets no overtake forecast either', () => {
        const me = { rank: 1199, value: 1849, lastXPH: 1, rateRankEligible: false };
        expect(timeToOvertake(me, { value: 1850, lastXPH: 0 })).toEqual({
            hours: 0,
            floor: false,
            reason: 'unranked',
        });
    });
});
