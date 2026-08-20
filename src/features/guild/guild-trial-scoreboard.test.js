/** @vitest-environment happy-dom */

/**
 * The per-player panel.
 *
 * The arithmetic it draws is `guild-trial-damage.js`' and is tested there; what
 * is worth asserting here is the ranking, the shares, the two tabs, and — most
 * of all — that a panel with nothing to show says which flavour of nothing it
 * is rather than drawing an empty table that reads as zero damage.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ breakdown: null, loadouts: {}, seen: [], restarts: 0 }));

// The pure parts of the damage module are the real ones — `estimateDamageSplit`
// is what the Damage tab now draws, and a stub of it would be testing the stub
vi.mock('./guild-trial-damage.js', async (importOriginal) => ({
    ...(await importOriginal()),
    default: { breakdown: () => game.breakdown },
}));
vi.mock('./guild-loadout-capture.js', () => ({
    guildLoadoutCapture: {
        forPlayer: (name) => game.loadouts[name] || null,
        seen: () => game.seen,
    },
}));
vi.mock('./guild-trial-recorder.js', () => ({
    guildTrialRecorder: {
        restart: () => {
            game.restarts += 1;
        },
    },
}));
vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: vi.fn(),
    unregisterFloatingPanel: vi.fn(),
    bringPanelToFront: vi.fn(),
}));

const {
    classTagHTML,
    damageOverCeiling,
    damageTypeOf,
    guildTrialScoreboard,
    modalStatsForBreakdown,
    PANEL_CLASS,
    scoreboardRows,
    scoreboardText,
    TYPE_COLORS,
} = await import('./guild-trial-scoreboard.js');

/**
 * A breakdown as the damage module reports one.
 * @param {Object} overrides - Fields to override
 * @returns {Object} The breakdown
 */
function breakdown(overrides = {}) {
    return {
        measured: true,
        active: true,
        reason: 'the monster says it is a trial',
        seconds: 100,
        fights: 3,
        totalDamage: 1_000_000,
        partyDps: 10_000,
        players: [
            { index: '0', name: 'Tib', damage: 600_000, deaths: 0 },
            { index: '1', name: 'Moo', damage: 400_000, deaths: 1 },
            { index: '2', name: 'Ada', damage: 0, deaths: 0 },
        ],
        support: {
            players: [
                { index: '0', name: 'Tib', healingDone: 0, damageTaken: 200_000 },
                { index: '2', name: 'Ada', healingDone: 150_000, damageTaken: 0, manaOuts: 3, emptyManaMs: 240_000 },
            ],
            unattributedHealing: 25_000,
        },
        ...overrides,
    };
}

beforeEach(() => {
    vi.useFakeTimers();
    game.breakdown = breakdown();
    game.loadouts = {};
    game.seen = [];
    game.restarts = 0;
    document.body.innerHTML = '';
});

afterEach(() => {
    guildTrialScoreboard.close();
    // A panel remembers which tab you left it on, which is right for a panel
    // and wrong for the next test
    guildTrialScoreboard.tab = 'damage';
    guildTrialScoreboard.noteForecast(null);
    guildTrialScoreboard.noteContext(null);
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('damageOverCeiling', () => {
    const withCeiling = (hp, fights = 5) => ({ damageCeiling: { hp, fights } });

    test('flags a total that runs past the bosses’ combined health', () => {
        const over = damageOverCeiling(withCeiling(3_000_000), 3_600_000);
        expect(over).toMatchObject({ ceiling: 3_000_000, fights: 5 });
        expect(over.overBy).toBeCloseTo(0.2, 5);
    });

    test('a total within the ceiling (and its margin) is not flagged', () => {
        expect(damageOverCeiling(withCeiling(3_924_375), 3_691_499)).toBeNull();
        // just over the raw ceiling but inside the 2% rounding margin
        expect(damageOverCeiling(withCeiling(1_000_000), 1_010_000)).toBeNull();
    });

    test('no ceiling to check means no verdict', () => {
        expect(damageOverCeiling({ damageCeiling: { hp: 0 } }, 5_000_000)).toBeNull();
        expect(damageOverCeiling({}, 5_000_000)).toBeNull();
        expect(damageOverCeiling(null, 5_000_000)).toBeNull();
    });
});

describe('scoreboardRows', () => {
    test('ranks by damage, with shares and rates', () => {
        const { rows, total, perSecond } = scoreboardRows(breakdown(), 'damage');

        expect(rows.map((row) => row.name)).toEqual(['Tib', 'Moo']);
        expect(rows[0]).toMatchObject({ rank: 1, value: 600_000 });
        expect(rows[0].share).toBeCloseTo(60, 6);
        expect(rows[0].perSecond).toBeCloseTo(6000, 6);
        expect(total).toBe(1_000_000);
        expect(perSecond).toBeCloseTo(10_000, 6);
    });

    test('a player with nothing on this tab is not a rank', () => {
        // Ada healed and did no damage; a zero-length bar is not a row
        expect(scoreboardRows(breakdown(), 'damage').rows.some((row) => row.name === 'Ada')).toBe(false);
    });

    test('game-reported rows carry the measured delta, for the on-screen comparison', () => {
        // The game credited Tib 500k; the stream measured 600k — 20% over.
        const modalStats = [
            { name: 'Tib', damage: 500_000, healing: 0, damageTaken: 0 },
            { name: 'Moo', damage: 400_000, healing: 0, damageTaken: 0 },
        ];
        const { rows, source } = scoreboardRows(breakdown(), 'damage', modalStats);
        expect(source).toBe('game');
        const tib = rows.find((row) => row.name === 'Tib');
        expect(tib.value).toBe(500_000);
        expect(tib.measuredValue).toBe(600_000);
        expect(tib.measuredDeltaPct).toBeCloseTo(20, 6);
    });

    test('the rendered row shows the measured number itself, not just its error', () => {
        // The delta alone says how far the stream ran from the game's figure but
        // hides what the stream actually read — the before-number the comparison
        // is about. Both belong on the row.
        const html = guildTrialScoreboard._rowHTML({
            rank: 1,
            name: 'Tib',
            value: 500_000,
            share: 55.6,
            perSecond: null,
            measured: true,
            measuredValue: 600_000,
            measuredDeltaPct: 20,
        });
        expect(html).toContain('meas 600.0K · +20%');

        // With no game figure to compare against, the absolute stands alone
        const bare = guildTrialScoreboard._rowHTML({
            rank: 2,
            name: 'Moo',
            value: 0,
            share: 0,
            perSecond: null,
            measured: true,
            measuredValue: 226_100,
            measuredDeltaPct: null,
        });
        // The comparison span ends at the absolute — no dangling delta
        expect(bare).toContain('meas 226.1K</span>');
    });

    test('the wire stats are preferred over the scraped modal', () => {
        const report = breakdown({
            encounter: 'badger',
            trialNames: ['Trial Badger'],
            reported: { Tib: { damage: 500_000, healing: 0, taken: 0 } },
        });
        const stats = modalStatsForBreakdown(report, { getCombatStats: () => [{ name: 'Ghost', damage: 1 }] });
        expect(stats).toEqual([{ name: 'Tib', damage: 500_000, healing: 0, damageTaken: 0 }]);
    });

    test('the healing tab is the same shape from the support tally', () => {
        const { rows, total } = scoreboardRows(breakdown(), 'healing');

        expect(rows.map((row) => row.name)).toEqual(['Ada']);
        expect(rows[0]).toMatchObject({ rank: 1, value: 150_000, share: 100 });
        expect(total).toBe(150_000);
    });

    test('no clock is no rate, and no breakdown is no rows', () => {
        const still = scoreboardRows(breakdown({ seconds: 0 }), 'damage');
        expect(still.perSecond).toBeNull();
        expect(still.rows[0].perSecond).toBeNull();

        expect(scoreboardRows(null, 'damage').rows).toEqual([]);
        expect(scoreboardRows(undefined, 'healing').total).toBe(0);
    });

    test('the game modal, when present, is preferred over the stream and marked as its source', () => {
        // The stream saw a fraction (Tib 600K); the modal is the full trial.
        const modal = [
            { name: 'Estevao', damage: 1_052_000, healing: 0, damageTaken: 226_000 },
            { name: 'MillenniumTestIC', damage: 221_000, healing: 118_000, damageTaken: 220_000 },
        ];
        const dmg = scoreboardRows(breakdown(), 'damage', modal);
        expect(dmg.source).toBe('game');
        expect(dmg.rows.map((row) => row.name)).toEqual(['Estevao', 'MillenniumTestIC']);
        expect(dmg.rows[0]).toMatchObject({ value: 1_052_000, perSecond: null });
        expect(dmg.total).toBe(1_273_000);

        // The Taken tab is modal-only ground: the stream barely captures it.
        const taken = scoreboardRows(breakdown(), 'taken', modal);
        expect(taken.rows.map((row) => row.value)).toEqual([226_000, 220_000]);

        // Healing comes off the modal's healing column.
        const heal = scoreboardRows(breakdown(), 'healing', modal);
        expect(heal.rows).toEqual([expect.objectContaining({ name: 'MillenniumTestIC', value: 118_000 })]);
    });

    test('without the modal the Taken tab falls back to the stream support tally', () => {
        const taken = scoreboardRows(breakdown(), 'taken');
        expect(taken.rows[0]).toMatchObject({ name: 'Tib', value: 200_000 });
        expect(taken.source).toBeNull();
    });
});

describe('modalStatsForBreakdown', () => {
    const modal = {
        getCombatStats: (name) =>
            name === 'Trial Swarm' ? [{ name: 'Estevao', damage: 1_052_000, healing: 0, damageTaken: 226_000 }] : null,
    };

    test('joins the breakdown encounter to the modal trial name', () => {
        const bd = { encounter: 'swarm', trialNames: ['Trial Jellyfish', 'Trial Swarm'] };
        expect(modalStatsForBreakdown(bd, modal)).toEqual([
            { name: 'Estevao', damage: 1_052_000, healing: 0, damageTaken: 226_000 },
        ]);
    });

    test('is null when no encounter, or no modal captured for that trial', () => {
        expect(modalStatsForBreakdown({ trialNames: ['Trial Swarm'] }, modal)).toBeNull();
        expect(modalStatsForBreakdown({ encounter: 'jellyfish', trialNames: ['Trial Jellyfish'] }, modal)).toBeNull();
    });
});

describe('damageTypeOf', () => {
    test('comes off the captured loadout, not off the name', () => {
        game.loadouts = {
            Tib: { stats: { damageType: '/damage_types/fire' } },
            Moo: { stats: { combatStyleHrids: ['/combat_styles/ranged'] } },
        };

        expect(damageTypeOf('Tib')).toBe('fire');
        expect(damageTypeOf('Moo')).toBe('ranged');
        expect(TYPE_COLORS.fire).toBeTruthy();
    });

    test('a player whose loadout has never been seen is unknown, not physical', () => {
        expect(damageTypeOf('Nobody')).toBeNull();
    });
});

describe('scoreboardText', () => {
    test('one line per player, with the totals and the estimate warning', () => {
        const text = scoreboardText(breakdown(), 'damage');

        expect(text).toContain('1,000,000 total');
        expect(text).toContain('estimated from the battle feed');
        expect(text).toContain('1. Tib — 600,000');
        expect(text).toContain('60.0%');
    });

    test('the healing summary carries what could not be attributed', () => {
        const text = scoreboardText(breakdown(), 'healing');
        expect(text).toContain('Unattributed: 25,000');
    });

    test('nothing measured is a reason rather than an empty list', () => {
        const text = scoreboardText(
            { measured: false, reason: 'the monsters are not this week’s encounter' },
            'damage'
        );
        expect(text).toContain('nothing measured');
        expect(text).toContain('not this week');
    });

    test('a split that covers part of the party says so', () => {
        // Two of seven earned a damage row; the copied stats must not read as a
        // claim the other five did nothing
        const text = scoreboardText(
            breakdown({
                source: 'spectated',
                participants: 7,
                roster: { 0: {}, 1: {}, 2: {}, 3: {}, 4: {}, 5: {}, 6: {} },
            }),
            'damage'
        );
        expect(text).toContain('2 of 7 players attributed');
        expect(text).toContain('lower bound');
    });

    test('a full party carries no coverage caveat', () => {
        const text = scoreboardText(breakdown({ source: 'spectated', participants: 2 }), 'damage');
        expect(text).not.toContain('players attributed');
    });
});

describe('the panel', () => {
    /** @returns {string} The panel's text */
    const text = () => document.querySelector(`.${PANEL_CLASS}`)?.textContent || '';

    test('opens, ranks, and closes', () => {
        guildTrialScoreboard.open();

        expect(document.querySelector(`.${PANEL_CLASS}`)).toBeTruthy();
        expect(text()).toContain('Tib');
        expect(text()).toContain('party dps');

        guildTrialScoreboard.close();
        expect(document.querySelector(`.${PANEL_CLASS}`)).toBeNull();
    });

    test('a spectated split that covers part of the party says how much', () => {
        game.breakdown = breakdown({
            source: 'spectated',
            participants: 7,
            roster: { 0: {}, 1: {}, 2: {}, 3: {}, 4: {}, 5: {}, 6: {} },
        });
        guildTrialScoreboard.open();

        expect(text()).toContain('2 of 7 players');
        expect(text()).toContain('lower bound');
    });

    test('a fully covered party gets no coverage caveat', () => {
        game.breakdown = breakdown({ source: 'spectated', participants: 2 });
        guildTrialScoreboard.open();

        expect(text()).not.toContain('of 2 players');
    });

    test('the healing tab switches what is ranked', () => {
        guildTrialScoreboard.open();
        document.querySelector('[data-tab="healing"]').click();

        expect(text()).toContain('Ada');
        expect(text()).toContain('party hps');
        expect(text()).toContain('unattributed');
    });

    test('regeneration is its own line, not part of the unattributed bucket', () => {
        // The live complaint: 333 seconds of "0 party hps" over "22.7K
        // unattributed — regeneration, or two healers on one tick", when most
        // of it was the trial's own flat regen. The two are different claims.
        game.breakdown = breakdown({
            support: {
                players: [{ index: '2', name: 'Ada', healingDone: 150_000, damageTaken: 0 }],
                unattributedHealing: 2_000,
                regenHealing: 20_700,
            },
        });
        guildTrialScoreboard.open();
        document.querySelector('[data-tab="healing"]').click();

        expect(text()).toContain('20.7K regeneration');
        expect(text()).toContain('2.0K unattributed');
        // The old lump that read as a failure is gone
        expect(text()).not.toContain('two healers on one tick');
    });

    test('it says why it is empty rather than drawing zeroes', () => {
        game.breakdown = {
            measured: false,
            reason: 'the monsters are not this week’s trial encounter',
            players: [],
            seconds: 0,
        };
        guildTrialScoreboard.open();

        expect(text()).toContain('Nothing to show yet');
        expect(text()).toContain('not this week');
    });

    test('with no measurement but captured builds, the Damage tab estimates the split', () => {
        // Nothing has been watched, so no measurement has arrived. The tab
        // says what to do about that and shows the estimate meanwhile
        game.breakdown = { measured: false, reason: 'simulated', players: [], seconds: 0 };
        game.seen = [
            { name: 'Tib', at: 1, stats: { attackInterval: 3_000_000_000, autoAttackDamage: 0.6 } },
            { name: 'Moo', at: 2, stats: { attackInterval: 3_000_000_000, autoAttackDamage: 0.3 } },
        ];
        guildTrialScoreboard.noteContext({ trialName: 'Trial Chameleon', members: ['Tib', 'Moo', 'Ada'] });
        guildTrialScoreboard.open();

        expect(text()).toContain('Estimated from builds');
        expect(text()).toContain('only while the In Progress');
        expect(text()).toContain('est. party dps');
        expect(text()).toContain('2/3 builds');
        // Nobody is dropped for having no sheet — they are named
        expect(text()).toContain('Ada');
        expect(text()).toContain('No build captured');
        // And it never reads as a measurement
        expect(text()).toContain('estimated');
        expect(text()).not.toContain('Nothing to show yet');
    });

    test('the Healing tab explains the mechanic instead of promising a measurement', () => {
        game.breakdown = { measured: false, reason: 'simulated', players: [], seconds: 0 };
        game.seen = [{ name: 'Tib', at: 1, stats: { attackInterval: 3_000_000_000, autoAttackDamage: 0.6 } }];
        guildTrialScoreboard.open();
        document.querySelector('[data-tab="healing"]').click();

        expect(text()).toContain('No healing has been watched');
        expect(text()).toContain('fight view has been opened');
        // A build cannot predict healing, so there is no estimate to offer here
        expect(text()).not.toContain('Estimated from builds');
    });

    test('a measured panel says where its figures came from', () => {
        guildTrialScoreboard.open();
        expect(text()).toContain('Attributed off this client’s own battle feed');
    });

    test('a watched trial is measured, and the panel prefers it over the estimate', () => {
        game.breakdown = breakdown({ source: 'spectated', seconds: 45 });
        game.seen = [{ name: 'Tib', at: 1, stats: { attackInterval: 3_000_000_000, autoAttackDamage: 0.6 } }];
        guildTrialScoreboard.noteContext({ trialName: 'Trial Chameleon', members: ['Tib', 'Moo'] });
        guildTrialScoreboard.open();

        expect(text()).toContain('Measured from the trial fight — 45s watched');
        // Observed live: the stream keeps flowing while other tabs are browsed,
        // so the caption claims the gap rule rather than an open-view rule
        expect(text()).toContain('a gap in the stream pauses these');
        expect(text()).not.toContain('Estimated from builds');
    });

    test('every row is measured, and the counter-confirmed one is named', () => {
        // The server groups each tick by actor, so every row's damage is
        // attributed off the stream. Your own unit additionally streams its
        // attack counters, which confirm its rows directly — worth naming
        // without calling anybody else's row a guess
        game.breakdown = breakdown({
            source: 'spectated',
            seconds: 60,
            countedNames: ['Player20'],
            players: [
                { index: '19', name: 'Player20', damage: 600_000, deaths: 0, measured: true },
                { index: '4', name: 'Player01', damage: 400_000, deaths: 0, measured: true },
            ],
        });
        guildTrialScoreboard.open();

        expect(text()).toContain('ticks the server groups by actor');
        expect(text()).toContain('Player20 carries own attack counters');
        // No row is second-class any more
        expect(text()).not.toContain('partial');
    });

    test('a placeholder name is flagged as one', () => {
        game.breakdown = breakdown({
            source: 'spectated',
            nameCoverage: { named: 1, of: 2, placeholders: ['Player 3'], bySource: {} },
        });
        guildTrialScoreboard.open();

        expect(text()).toContain('1 of 2 units could be named');
        expect(text()).toContain('Player 3 is a placeholder');
    });

    test('watched with nothing attributed yet is its own message, not "nothing to show"', () => {
        // Between fights, or a view opened moments ago: the stream is live and
        // the table simply has not seen a hit land yet
        game.breakdown = {
            measured: false,
            source: 'spectated',
            splitFromCounters: false,
            reason: 'watched',
            players: [],
            seconds: 30,
        };
        guildTrialScoreboard.open();

        expect(text()).toContain('no damage has been attributed yet');
        expect(text()).toContain('Healing tab come from the same ticks');
        expect(text()).not.toContain('Nothing to show yet');
    });

    test('“end and start new” goes through the recorder, not a second mechanism', () => {
        guildTrialScoreboard.open();
        document.querySelector('[data-action="restart"]').click();

        expect(game.restarts).toBe(1);
    });

    test('copy puts the plain-text summary on the clipboard', () => {
        const written = [];
        vi.spyOn(navigator.clipboard, 'writeText').mockImplementation((value) => {
            written.push(value);
            return Promise.resolve();
        });

        guildTrialScoreboard.open();
        document.querySelector('[data-action="copy"]').click();

        expect(written[0]).toContain('1. Tib — 600,000');
    });

    test('the expected tier is echoed from the trials feature, not recomputed', () => {
        guildTrialScoreboard.noteForecast({ tier: 6, source: 'measured', limitedBy: 'time' });
        guildTrialScoreboard.open();

        expect(text()).toContain('Expected to reach');
        expect(text()).toContain('T6');
        expect(text()).toContain('measured rate');
    });

    test('an enraged forecast says so here too, without calling it a wall', () => {
        guildTrialScoreboard.noteForecast({ tier: 3, source: 'estimated', limitedBy: 'time', enragedFrom: 3 });
        guildTrialScoreboard.open();

        expect(text()).toContain('with the boss fully enraged by then');
        expect(text()).toContain('estimated from captured loadouts');
        expect(text()).not.toContain('walled');
    });

    test('no forecast is no row rather than an empty one', () => {
        guildTrialScoreboard.noteForecast(null);
        guildTrialScoreboard.noteContext(null);
        guildTrialScoreboard.open();

        expect(text()).not.toContain('Expected to reach');
    });

    test('running dry gets a line, not a tab', () => {
        guildTrialScoreboard.open();
        expect(text()).toContain('Ran out of mana');
        expect(text()).toContain('Ada 3×');
    });

    test('the guild report is copied from the same plumbing as the stats', () => {
        const written = [];
        Object.defineProperty(navigator, 'clipboard', {
            value: {
                writeText: (value) => {
                    written.push(value);
                    return Promise.resolve();
                },
            },
            configurable: true,
        });

        guildTrialScoreboard.noteContext({
            trialName: 'Trial Chameleon',
            tier: 4,
            tiersCleared: 3,
            shortfall: { remaining: 112_000, total: 669_500, unit: 'HP' },
        });
        guildTrialScoreboard.open();
        document.querySelector('[data-action="report"]').click();

        expect(written[0]).toContain('Trial Chameleon — cleared 3 tiers');
        expect(written[0]).toContain('83% into T4');
        expect(written[0]).toContain('died 1×');
        expect(written[0]).not.toMatch(/<[a-z]/i);
    });

    test('toggling twice leaves nothing behind', () => {
        guildTrialScoreboard.toggle();
        expect(document.querySelectorAll(`.${PANEL_CLASS}`)).toHaveLength(1);

        guildTrialScoreboard.toggle();
        expect(document.querySelectorAll(`.${PANEL_CLASS}`)).toHaveLength(0);

        // And opening again does not stack a second panel
        guildTrialScoreboard.open();
        guildTrialScoreboard.open();
        expect(document.querySelectorAll(`.${PANEL_CLASS}`)).toHaveLength(1);
    });
});

describe('the class chip on a board row', () => {
    test('a verdict draws its short label and says it is an inference', () => {
        const html = classTagHTML({ key: 'ranged', label: 'Ranged', short: 'RANGED' });

        expect(html).toContain('>RANGED<');
        expect(html).toContain('inferred from what this player was seen casting');
    });

    test('nothing known draws nothing', () => {
        expect(classTagHTML(null)).toBe('');
        expect(classTagHTML({ label: 'Tank' })).toBe('');
    });

    test('only letters reach the markup', () => {
        // The label comes from this fork's own bucket table, and is stripped
        // anyway — a board row is an HTML string, and nothing off the wire may
        // reach it through a field that is supposed to be a fixed word
        expect(classTagHTML({ short: '<img onerror=x>' })).toBe('');
    });
});
