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
}));

const { xpPerDay, timeToOvertake, boardUnit } = await import('./leaderboard-xp-display.js');

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
