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
vi.mock('./guild-member-skills.js', () => ({
    default: {
        progress: () => tracker.cycler,
        nextBattleUnit: () => tracker.unit ?? null,
        openNextUnit: () => {
            tracker.openedUnits.push(tracker.unit?.name ?? null);
            return tracker.unitResult ?? { opened: null, how: 'no-unit' };
        },
        openNextProfile: () => {
            tracker.opened.push(tracker.cycler.next?.name ?? null);
            return tracker.cyclerResult;
        },
        redoAll: () => {
            tracker.redone += 1;
            return tracker.cycler.logged;
        },
    },
}));
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
tracker.cycler = { logged: 0, total: 0, next: null, stale: 0 };
tracker.cyclerResult = { opened: null, how: 'done' };
tracker.opened = [];
tracker.redone = 0;
tracker.unit = null;
tracker.unitResult = null;
tracker.openedUnits = [];

const {
    drawProfileCycler,
    drawSeenLoadouts,
    seriesDelta,
    ratePerHour,
    isGoneQuiet,
    contributionShares,
    projectGuildXP,
    buildRoster,
    memberLabel,
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

describe('the profile cycler', () => {
    beforeEach(() => {
        tracker.opened = [];
        tracker.redone = 0;
        tracker.cycler = { logged: 2, total: 8, next: { name: 'Ada' }, stale: 0 };
        tracker.cyclerResult = { opened: 'Ada', how: 'row' };
        tracker.unit = null;
        tracker.unitResult = null;
        tracker.openedUnits = [];
        document.body.innerHTML = '';
    });

    test('a fight on screen gets its own battle-info button, separate from profiles', () => {
        // A profile carries skills but no combat sheet, so the two
        // collections are separate tools — one button must never silently
        // stand in for the other
        tracker.unit = { name: 'Bo', el: document.createElement('div') };
        tracker.unitResult = { opened: 'Bo', how: 'unit' };
        const body = document.createElement('div');
        drawProfileCycler(body);

        const battle = body.querySelector('.mwi-battleinfo-cycler');
        const profile = body.querySelector('.mwi-profile-cycler');
        expect(battle.textContent).toContain('Bo’s battle info');
        expect(profile.textContent).toContain('Ada’s profile');

        battle.click();
        expect(tracker.openedUnits).toEqual(['Bo']);
        expect(tracker.opened).toEqual([]);
        expect(body.textContent).toContain('Waiting for Bo’s battle info');
    });

    test('no fight on screen means no battle-info button at all', () => {
        const body = document.createElement('div');
        drawProfileCycler(body);
        expect(body.querySelector('.mwi-battleinfo-cycler')).toBeNull();
    });

    test('shows how far along the roster it is, and who is next', () => {
        const body = document.createElement('div');
        drawProfileCycler(body);

        expect(body.textContent).toContain('logged 2/8');
        expect(body.querySelector('button').textContent).toContain('Ada');
    });

    test('one click opens one profile', () => {
        const body = document.createElement('div');
        drawProfileCycler(body);
        body.querySelector('button').click();

        // One click, one profile — nothing loops
        expect(tracker.opened).toEqual(['Ada']);
    });

    test('when the chat command is the only way in, it says to press Enter', () => {
        tracker.cyclerResult = { opened: 'Ada', how: 'chat' };
        const body = document.createElement('div');
        drawProfileCycler(body);
        const button = body.querySelector('button');
        button.click();

        // The button says what it did; the status line says what to do next
        expect(button.textContent).toContain('Asked for Ada');
        expect(body.textContent).toContain('Press Enter in chat');
    });

    test('a hidden chat is said plainly rather than swallowed', () => {
        // The reported failure: chat was hidden, the fill went nowhere, and the
        // cycler moved on regardless
        tracker.cyclerResult = { opened: 'Ada', how: 'no-chat' };
        const body = document.createElement('div');
        drawProfileCycler(body);
        body.querySelector('button').click();

        expect(body.textContent).toContain('Open the chat panel first');
        // And the member is still the one being offered
        expect(body.querySelector('button').textContent).toContain('Ada');
    });

    test('a profile still in flight is shown as waiting, not as done', () => {
        tracker.cycler = { logged: 2, total: 8, next: null, pending: { name: 'Ada' }, stale: 0 };
        const body = document.createElement('div');
        drawProfileCycler(body);

        expect(body.textContent).toContain('Waiting for Ada');
        expect(body.textContent).toContain('logged 2/8');
    });

    test('redo marks everyone due again without asking for anything', () => {
        const body = document.createElement('div');
        drawProfileCycler(body);

        const redo = body.querySelector('.mwi-profile-redo');
        expect(redo.textContent).toContain('Redo all 2');

        redo.click();

        expect(tracker.redone).toBe(1);
        // Redo changes who is due; it never opens a profile
        expect(tracker.opened).toEqual([]);
    });

    test('with nothing captured there is nothing to redo', () => {
        tracker.cycler = { logged: 0, total: 8, next: { name: 'Ada' }, stale: 0 };
        const body = document.createElement('div');
        drawProfileCycler(body);

        expect(body.querySelector('.mwi-profile-redo')).toBeNull();
    });

    test('a fully logged roster has nothing to click', () => {
        tracker.cycler = { logged: 8, total: 8, next: null, stale: 0 };
        const body = document.createElement('div');
        drawProfileCycler(body);

        expect(body.querySelector('button').disabled).toBe(true);
        expect(body.textContent).toContain('Every member logged');
    });

    test('stale captures are counted so they can be refreshed', () => {
        tracker.cycler = { logged: 8, total: 8, next: { name: 'Bo' }, stale: 3 };
        const body = document.createElement('div');
        drawProfileCycler(body);

        expect(body.textContent).toContain('3 captures older than a week');
    });

    test('no roster is a note rather than a dead button', () => {
        tracker.cycler = { logged: 0, total: 0, next: null, stale: 0 };
        const body = document.createElement('div');
        drawProfileCycler(body);

        expect(body.querySelector('button')).toBeNull();
        expect(body.textContent).toContain('No roster yet');
    });
});

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

describe('a member who has left the guild', () => {
    // Reported live from a 107-member guild: "Gone quiet (2)" listed
    // "#9349 · —/h today vs 348/h this week" — somebody who left, still holding
    // last week's rate, doing nothing today because they were gone, and headed
    // with an internal id because they had been dropped from the member list
    const departed = {
        now,
        meta: { a: { name: 'Alice' } },
        series: {
            a: series([
                [160, 0],
                [24, 6000],
                [1, 6500],
            ]),
            9349: series([
                [160, 0],
                [48, 9000],
                [1, 9000],
            ]),
        },
    };

    test('is not on the roster at all, however much history they left behind', () => {
        const roster = buildRoster(departed);

        expect(roster.map((member) => member.characterID)).toEqual(['a']);
        expect(roster.some((member) => member.quiet)).toBe(false);
    });

    test('and does not count towards anybody’s share', () => {
        // Their nine thousand XP was diluting everyone else's contribution
        const roster = buildRoster(departed);
        expect(roster[0].share7d).toBeCloseTo(100, 6);
    });

    test('an empty member list is “not known yet”, not “nobody is here”', () => {
        // Before any roster message has arrived, the history stands in — which
        // is what it did before, and losing the whole panel would be worse
        const roster = buildRoster({ ...departed, meta: {} });
        expect(roster).toHaveLength(2);
    });

    test('a member with no name is said to have none, never numbered', () => {
        const roster = buildRoster({ now, meta: { 9349: {} }, series: { 9349: series([[1, 10]]) } });

        expect(roster[0].name).toBeNull();
        expect(memberLabel(roster[0])).toBe('Unnamed member');
        expect(memberLabel(roster[0])).not.toContain('9349');
    });
});

describe('the panel and tile', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(now);
        tracker.rows = [];
        tracker.cycler = { logged: 0, total: 0, next: null, stale: 0 };
        tracker.cyclerResult = { opened: null, how: 'done' };
        tracker.opened = [];
        tracker.redone = 0;
        tracker.unit = null;
        tracker.unitResult = null;
        tracker.openedUnits = [];
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

    test('a departed member is drawn nowhere, not even in Gone quiet', () => {
        // The live report: "Gone quiet (2)" listing "#9349 · —/h today vs 348/h
        // this week" — a member who had left, still holding last week's rate
        tracker.series = {
            ...tracker.series,
            9349: series([
                [160, 0],
                [48, 9000],
                [1, 9000],
            ]),
        };
        guildRosterPanel.show({ remember: false });
        const text = guildRosterPanel.panel.textContent;

        expect(text).not.toContain('9349');
        // Bob is the one genuinely quiet member, and the count is his alone
        expect(text).toContain('Gone quiet (1)');
        expect(text).toContain('Contribution (2 of 2 measured)');
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
