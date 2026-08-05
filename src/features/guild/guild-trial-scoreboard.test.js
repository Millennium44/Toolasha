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

const game = vi.hoisted(() => ({ breakdown: null, loadouts: {}, restarts: 0 }));

vi.mock('./guild-trial-damage.js', () => ({
    default: { breakdown: () => game.breakdown },
}));
vi.mock('./guild-loadout-capture.js', () => ({
    guildLoadoutCapture: { forPlayer: (name) => game.loadouts[name] || null },
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

const { damageTypeOf, guildTrialScoreboard, PANEL_CLASS, scoreboardRows, scoreboardText, TYPE_COLORS } =
    await import('./guild-trial-scoreboard.js');

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
                { index: '2', name: 'Ada', healingDone: 150_000, damageTaken: 0 },
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
    game.restarts = 0;
    document.body.innerHTML = '';
});

afterEach(() => {
    guildTrialScoreboard.close();
    // A panel remembers which tab you left it on, which is right for a panel
    // and wrong for the next test
    guildTrialScoreboard.tab = 'damage';
    guildTrialScoreboard.noteForecast(null);
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = '';
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

    test('the healing tab switches what is ranked', () => {
        guildTrialScoreboard.open();
        document.querySelector('[data-tab="healing"]').click();

        expect(text()).toContain('Ada');
        expect(text()).toContain('party hps');
        expect(text()).toContain('unattributed');
    });

    test('it says why it is empty rather than drawing zeroes', () => {
        game.breakdown = {
            measured: false,
            reason: 'the monsters are not this week’s trial encounter',
            players: [],
            seconds: 0,
        };
        guildTrialScoreboard.open();

        expect(text()).toContain('Nothing measured yet');
        expect(text()).toContain('not this week');
    });

    test('every panel says its figures are estimates', () => {
        guildTrialScoreboard.open();
        expect(text()).toContain('Estimated from the battle feed');
        expect(text()).toContain('Only fights this character took part in');
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

    test('a walled forecast says so here too', () => {
        guildTrialScoreboard.noteForecast({ tier: 3, source: 'estimated', limitedBy: 'enrage' });
        guildTrialScoreboard.open();

        expect(text()).toContain('walled by the ten-minute enrage');
        expect(text()).toContain('estimated from captured loadouts');
    });

    test('no forecast is no row rather than an empty one', () => {
        guildTrialScoreboard.noteForecast(null);
        guildTrialScoreboard.open();

        expect(text()).not.toContain('Expected to reach');
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
