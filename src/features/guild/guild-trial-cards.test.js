/**
 * The trial cards' readout rows and the cycle labels they and "Past weeks" share.
 *
 * The claims: a card zeroed by the cycle's roll keeps its tier and reads 0 points,
 * which is a missing figure and never "0 pts"; a finished cycle is never labeled
 * "This week" — the test server leads with the plain end time, live reads as a
 * weekly cycle; every readout row is one label and value on one grid, whatever
 * its content; the card carries only a best tier, the cycles and dates are the
 * hover's; the Trial history table is one grid per row with a header.
 */

/** @vitest-environment happy-dom */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ testServer: false }));
vi.mock('../../utils/game-server.js', async (importOriginal) => ({
    ...(await importOriginal()),
    isTestServer: () => game.testServer === true,
}));

import {
    resultPoints,
    resultsFromCycle,
    trialHistoryBest,
    trialHistoryDetail,
    trialHistoryTiers,
    trialResultsHistory,
} from './guild-trial-results.js';
import { cycleEndLabel, pastWeekLine, summariseArchivedCycle } from './guild-trial-history.js';
import { analyseTrial, pastTiersSummary, renderTrialBlock } from './guild-trials.js';
import { trialWeekStart } from './guild-trials-math.js';

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
const now = Date.parse('2026-10-28T12:00:00Z');
const thisWeek = trialWeekStart(now);

/** A card archived after the cycle's roll zeroed it: the tier stands, the points are 0 */
const zeroedCard = (tier) => ({
    name: 'Alchemy',
    kind: 'skilling',
    tier,
    points: 0,
    pointsByTier: {},
    completed: true,
    samples: [],
    tiers: [],
});
const stated = (tier, points) => ({ ...zeroedCard(tier), points, pointsByTier: { [tier]: points } });
const cycle = (week, tiles, extra = {}) => ({
    archivedAt: week + WEEK,
    reason: 'the week rolled over',
    weekStart: week,
    tiles,
    ...extra,
});
const rowOf = (cycles, options = {}) =>
    trialResultsHistory(
        cycles.flatMap((c) => resultsFromCycle(c)),
        { now, ...options }
    );

beforeEach(() => {
    game.testServer = false;
});

describe('a tier above T0 with 0 points is a missing figure', () => {
    const history = [cycle(thisWeek - WEEK, { a: zeroedCard(20) })];

    test('the hover says "— pts", not "0 pts", with no Builder’s Hall bonus to price it', () => {
        const [row] = rowOf(history).rows;
        expect(row.weeks[0].points).toBeNull();
        expect(trialHistoryDetail(row)).toContain('Last week: T20 · — pts');
        expect(trialHistoryDetail(row)).not.toContain('0 pts');
    });

    test('with the bonus it is priced off the ladder and marked derived', () => {
        const [row] = rowOf(history, { buildersHallBonus: 0 }).rows;
        expect(row.weeks[0].points.derived).toBe(true);
        expect(row.weeks[0].points.points).toBeGreaterThan(0);
        expect(trialHistoryDetail(row)).toMatch(/Last week: T20 · ~[\d,]+ pts/);
    });

    test('a stated figure and a real T0 are still read as stated', () => {
        const [result] = resultsFromCycle(cycle(thisWeek - WEEK, { a: stated(20, 21475) }));
        expect(resultPoints(result)).toEqual({ points: 21475, derived: false });
        const [t0] = resultsFromCycle(cycle(thisWeek - WEEK, { a: { ...zeroedCard(0), points: 0 } }));
        expect(resultPoints(t0, 0)).toEqual({ points: 0, derived: false });
    });

    test('"Past weeks" does not sum the zero into the cycle total', () => {
        const c = cycle(thisWeek - WEEK, { a: zeroedCard(20) });
        expect(summariseArchivedCycle(c, { now }).points).toBeNull();
        expect(pastWeekLine(summariseArchivedCycle(c, { now }))).toContain('— pts');
        const priced = summariseArchivedCycle(c, { now, buildersHallBonus: 0 });
        expect(priced.points).toBeGreaterThan(0);
        expect(priced.pointsDerived).toBe(true);
    });
});

describe('cycle labels', () => {
    const ended = Date.parse('2026-10-26T20:00:00Z');

    test('the test server leads with the plain end time', () => {
        game.testServer = true;
        const label = cycleEndLabel('this week', ended);
        expect(label).toMatch(/^[A-Z][a-z]{2} \d{1,2}:\d{2} [AP]M$/);
        expect(label).not.toMatch(/week|ended/i);
        // The history names a column by when its trial ran: a day before the cycle ended
        const { cycles } = rowOf([cycle(thisWeek, { a: stated(4, 400) }, { cycleFrom: ended })]);
        expect(cycles[0].label).toBe(cycleEndLabel('this week', ended - 24 * 3600_000));
        expect(pastWeekLine({ when: 'this week', endedAt: ended })).toMatch(/^[A-Z][a-z]{2} \d/);
    });

    test('live reads as a weekly cycle and is never "This week" once finished', () => {
        expect(cycleEndLabel('last week')).toBe('Last week');
        expect(cycleEndLabel('2 weeks ago')).toBe('2 weeks ago');
        expect(cycleEndLabel('last week', ended)).toMatch(/^Last week \(ended [A-Z][a-z]{2} /);
        expect(cycleEndLabel('this week')).toBe('Earlier this week');
        expect(cycleEndLabel(null)).toBe('—');
    });
});

describe('the card’s best tier and the Trial history cells', () => {
    test('no past cycles: nothing to summarize', () => {
        expect(pastTiersSummary(null)).toBeNull();
        expect(pastTiersSummary({ weeks: [{ tier: null }], best: null })).toBeNull();
    });

    test('one past cycle, a T0, and a missed cycle', () => {
        const one = rowOf([cycle(thisWeek - WEEK, { a: stated(20, 5000) })]).rows[0];
        expect(trialHistoryTiers(one)).toBe('T20');
        expect(trialHistoryBest(one)).toBe('T20');

        const zero = rowOf([cycle(thisWeek - WEEK, { a: { ...zeroedCard(0) } })]).rows[0];
        expect(trialHistoryBest(zero)).toBe('T0');

        const missed = rowOf([
            cycle(thisWeek - 2 * WEEK, { a: stated(20, 5000) }),
            cycle(thisWeek - WEEK, { b: { ...stated(3, 100), name: 'Trial Badger', kind: 'combat' } }),
        ]);
        const alchemy = missed.rows.find((r) => r.name === 'Alchemy');
        expect(trialHistoryTiers(alchemy)).toBe('— · T20');
        expect(trialHistoryBest(alchemy)).toBe('T20');
    });

    test('the summary has no time; its hover lists the cycles and the best’s date', () => {
        game.testServer = true;
        const ended = Date.parse('2026-10-26T20:00:00Z');
        const row = rowOf([cycle(thisWeek, { a: stated(20, 5000) }, { cycleFrom: ended })]).rows[0];
        const summary = pastTiersSummary(row);
        expect(summary.best).toBe('Best T20');
        expect(summary.best).not.toMatch(/AM|PM|week/);
        expect(summary.detail).toContain('Past tiers: T20');
        expect(summary.detail).toMatch(/Best: T20, [A-Z][a-z]{2} \d/);
    });
});

describe('the Banked row carries the best', () => {
    const analysis = (extra = {}) =>
        analyseTrial({ kind: 'skilling', name: 'Alchemy', tier: 18, samples: [], ...extra }, {});
    const pastRow = rowOf([cycle(thisWeek - WEEK, { a: stated(20, 5000) })]).rows[0];
    const bankedCells = (html) => {
        const host = document.createElement('div');
        host.innerHTML = html;
        const row = [...host.children].find((node) => node.firstElementChild?.textContent === 'Banked');
        return { text: row?.lastElementChild.textContent, title: row?.getAttribute('title') };
    };
    const render = (a, past) =>
        renderTrialBlock(a, 3, { measured: false, reason: 'none' }, { phase: 'live', pastRow: past });

    test('"Banked  18 · Best T20", the cycles only in the hover', () => {
        const cells = bankedCells(render(analysis(), pastRow));
        expect(cells.text).toMatch(/ · Best T20$/);
        expect(cells.title).toContain('Past tiers: T20');
        expect(cells.title).toContain('Last week: T20 · 5,000 pts');
        expect(bankedCells(render(analysis(), null)).text).not.toContain('Best');
    });

    test('an unknown tier is "—" and the row stays, with the best beside it', () => {
        const cells = bankedCells(render(analysis({ tier: null }), pastRow));
        expect(cells.text).toBe('— · Best T20');
    });
});

describe('every readout row is one grid', () => {
    test('rows of any content share one template, label first and value second', () => {
        const html = renderTrialBlock(
            analyseTrial({ kind: 'skilling', name: 'A Very Long Skill Name Indeed', tier: 18, samples: [] }, {}),
            3,
            { measured: false, reason: 'none' },
            { phase: 'live' }
        );
        const host = document.createElement('div');
        host.innerHTML = html;
        const rows = [...host.children];
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
            expect(row.style.display).toBe('grid');
            expect(row.style.gridTemplateColumns).toBe('minmax(0,45%) minmax(0,1fr)');
            expect(row.children).toHaveLength(2);
            expect(row.children[1].style.textAlign).toBe('right');
        }
        expect(html).not.toContain('flex-wrap');
        expect(html).not.toContain('Next tier work');
        expect(html).not.toContain('Tier clears in');
    });
});
