/** @vitest-environment happy-dom */

/**
 * The guild roster, over a faked tracker.
 *
 * Two claims here are the ones a guild would act on, so they are the ones worth
 * pinning down. A contribution share must be of the XP actually *observed* —
 * counting a member nobody has two readings for as a zero would put a newly
 * tracked player in the same list as one who quit. And "gone quiet" must be each
 * member against their own week, not against a fixed rate, or every casual
 * player is permanently flagged and the list stops being read.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const tracker = vi.hoisted(() => ({
    guildName: 'Milky Way',
    series: {},
    members: [],
    guildSeries: [],
    level: { level: 42, currentXP: 1_000_000, nextLevelXP: 1_200_000, xpToNext: 200_000 },
}));

vi.mock('../../core/config.js', () => ({ default: { Z_FLOATING_PANEL: 1100, getSetting: () => true } }));
vi.mock('../../utils/panel-geometry.js', () => ({
    restoreGeometry: () => {},
    saveGeometry: () => {},
    saveOpenState: async () => {},
    reopenIfLeftOpen: async () => {},
}));
vi.mock('../../utils/overlay-rows.js', () => ({ registerRow: (definition) => tracker.rows.push(definition) }));
vi.mock('./guild-xp-tracker.js', () => ({
    guildXPTracker: {
        getOwnGuildName: () => tracker.guildName,
        getAllMemberSeries: () => tracker.series,
        getMemberList: () => tracker.members,
        getGuildSeries: () => tracker.guildSeries,
        getGuildLevelProgress: () => tracker.level,
    },
}));

tracker.rows = [];

const {
    drawSeenLoadouts,
    seriesDelta,
    ratePerHour,
    isGoneQuiet,
    contributionShares,
    projectGuildXP,
    buildRoster,
    guildRosterPanel,
    registerGuildRosterRow,
    WINDOW_7D,
} = await import('./guild-roster-view.js');

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const now = Date.parse('2026-08-04T12:00:00Z');

/**
 * A member's samples: `xp` at each of `hoursAgo`.
 * @param {Array<[number, number]>} points - `[hoursAgo, xp]`
 * @returns {Array<{t: number, xp: number}>} Oldest first
 */
const series = (points) => points.map(([hoursAgo, xp]) => ({ t: now - hoursAgo * HOUR, xp })).sort((a, b) => a.t - b.t);

describe('seriesDelta', () => {
    test('measures what was gained inside the window, and over how long', () => {
        const measured = seriesDelta(
            series([
                [48, 1000],
                [24, 2000],
                [1, 3000],
            ]),
            WINDOW_7D,
            now
        );

        expect(measured.delta).toBe(2000);
        expect(measured.spanMs).toBe(47 * HOUR);
    });

    test('ignores samples outside the window', () => {
        const measured = seriesDelta(
            series([
                [200, 1000],
                [2, 5000],
                [1, 5500],
            ]),
            DAY,
            now
        );

        expect(measured.delta).toBe(500);
    });

    test('one sample in the window is not a measurement', () => {
        expect(seriesDelta(series([[1, 100]]), DAY, now)).toBeNull();
        expect(
            seriesDelta(
                series([
                    [200, 100],
                    [1, 500],
                ]),
                DAY,
                now
            )
        ).toBeNull();
    });
});

describe('ratePerHour', () => {
    test('is the gain over the span it was gained in', () => {
        const rate = ratePerHour(
            series([
                [10, 0],
                [0, 5000],
            ]),
            WINDOW_7D,
            now
        );
        expect(rate).toBe(500);
    });
});

describe('isGoneQuiet', () => {
    test('flags a rate that has collapsed against the member’s own week', () => {
        expect(isGoneQuiet(10, 1000)).toBe(true);
        expect(isGoneQuiet(null, 1000)).toBe(true);
    });

    test('leaves a steady member alone, however slow', () => {
        expect(isGoneQuiet(900, 1000)).toBe(false);
        // A member who was barely earning all week has no collapse to detect
        expect(isGoneQuiet(0, 0.5)).toBe(false);
    });
});

describe('contributionShares', () => {
    test('shares are of the total actually earned', () => {
        expect(contributionShares([{ delta: 300 }, { delta: 100 }])).toEqual([75, 25]);
    });

    test('an unmeasured member neither takes a share nor breaks the sum', () => {
        const shares = contributionShares([{ delta: 300 }, { delta: null }, { delta: 100 }]);
        expect(shares).toEqual([75, 0, 25]);
    });

    test('nothing earned is not a division by zero', () => {
        expect(contributionShares([{ delta: 0 }, { delta: 0 }])).toEqual([0, 0]);
    });
});

describe('projectGuildXP', () => {
    test('carries the current rate forward', () => {
        expect(projectGuildXP(1000, 10, 24)).toBe(1240);
    });

    test('declines to project without a rate', () => {
        expect(projectGuildXP(1000, 0, 24)).toBeNull();
        expect(projectGuildXP(1000, null, 24)).toBeNull();
    });
});

describe('buildRoster', () => {
    test('ranks by this week’s share and flags who has stopped', () => {
        const roster = buildRoster({
            now,
            meta: { a: { name: 'Alice' }, b: { name: 'Bob' }, c: { name: 'Carol' } },
            series: {
                // Steady all week
                a: series([
                    [160, 0],
                    [24, 6000],
                    [1, 6500],
                ]),
                // Earned a lot, then stopped two days ago
                b: series([
                    [160, 0],
                    [48, 9000],
                    [1, 9000],
                ]),
                // Only ever seen once
                c: series([[1, 100_000]]),
            },
        });

        expect(roster.map((member) => member.name)).toEqual(['Bob', 'Alice', 'Carol']);
        expect(roster[0].share7d).toBeCloseTo(58.06, 1);
        expect(roster[0].quiet).toBe(true);
        expect(roster[1].quiet).toBe(false);
        // Never measured: no share, and no claim that they earned nothing
        expect(roster[2].delta7d).toBeNull();
        expect(roster[2].share7d).toBe(0);
    });
});

describe('the panel and tile', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(now);
        tracker.rows = [];
        tracker.members = [
            { characterID: 'a', name: 'Alice' },
            { characterID: 'b', name: 'Bob' },
        ];
        tracker.series = {
            a: series([
                [160, 0],
                [24, 6000],
                [1, 6500],
            ]),
            b: series([
                [160, 0],
                [48, 9000],
                [1, 9000],
            ]),
        };
        tracker.guildSeries = series([
            [160, 0],
            [1, 15_500],
        ]);
    });

    afterEach(() => {
        guildRosterPanel.hide({ remember: false });
        vi.useRealTimers();
    });

    test('draws every section', () => {
        guildRosterPanel.show({ remember: false });
        const text = guildRosterPanel.panel.textContent;

        expect(text).not.toContain('could not be drawn');
        expect(text).toContain('Milky Way');
        expect(text).toContain('Alice');
        expect(text).toContain('Bob');
        expect(text).toContain('Gone quiet (1)');
        expect(text).toContain('Projected in 7d');
    });

    test('says so plainly when there is no guild yet', () => {
        tracker.guildName = null;
        guildRosterPanel.show({ remember: false });
        expect(guildRosterPanel.panel.textContent).toContain('No guild data yet');
        tracker.guildName = 'Milky Way';
    });

    test('the tile names the top contributor and counts the quiet', () => {
        registerGuildRosterRow();
        const [tile] = tracker.rows;
        expect(tile.key).toBe('guildRoster');

        const container = document.createElement('div');
        tile.render(container);

        expect(container.textContent).toContain('Bob');
        expect(container.textContent).toContain('1 quiet');
        expect(typeof tile.onOpen).toBe('function');
    });
});

describe('seen loadouts', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    /** @returns {HTMLElement} A panel body to draw into */
    const body = () => {
        const el = document.createElement('div');
        document.body.appendChild(el);
        return el;
    };

    test('every line leads with when the sheet was seen', () => {
        const host = body();
        drawSeenLoadouts(
            host,
            [
                {
                    name: 'Tib',
                    level: 150,
                    at: now - 2 * HOUR,
                    source: 'battle_unit_fetched',
                    rows: [{ label: 'Armor', value: '62' }],
                    abilities: [{ label: 'Fireball', level: 40 }],
                },
            ],
            now
        );

        expect(host.textContent).toContain('Tib Lv.150');
        expect(host.textContent).toMatch(/seen /);
        expect(host.textContent).not.toContain('could not be drawn');
    });

    test('nothing seen names the gesture that would produce something', () => {
        const host = body();
        drawSeenLoadouts(host, [], now);

        expect(host.textContent).toContain('No stat sheets seen yet');
        expect(host.textContent).toContain('In Progress');
    });

    test('a reading with no abilities in it says so rather than implying none are equipped', () => {
        const host = body();
        drawSeenLoadouts(host, [{ name: 'Moo', at: now, source: 'popup', rows: [], abilities: [] }], now);

        expect(host.querySelector('[title]').title).toContain('not carried by this reading');
    });
});
