/**
 * @vitest-environment happy-dom
 *
 * The two luck tiles, drawn.
 *
 * They are four lines of layout each and the arithmetic behind them is tested
 * elsewhere, so what this catches is the thing layout gets wrong: showing the
 * same figure twice under two names. The percentile and takings-against-
 * expectation are different measurements of one session, and a tile that
 * quietly renders one where the other belongs looks entirely correct.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ rows: {}, party: null, options: {} }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => false, getSettingValue: (key, fallback) => fallback, COLOR_TEXT_PRIMARY: '#fff' },
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../core/data-manager.js', () => ({ default: {} }));
vi.mock('../../utils/market-data.js', () => ({ getItemPrice: () => 1 }));
vi.mock('../../utils/timer-registry.js', () => ({
    createTimerRegistry: () => ({ registerTimeout: () => {}, clearAll: () => {} }),
}));
vi.mock('./party-luck.js', () => ({ partyLuck: () => game.party }));
vi.mock('../../utils/overlay-rows.js', () => ({
    registerRow: (definition) => {
        game.rows[definition.key] = definition;
    },
    rowOption: (key) => Boolean(game.options[key]),
}));

const combatDropLuck = (await import('./combat-drop-luck.js')).default;

/**
 * Draw one tile and hand back its text.
 * @param {string} key - The row key
 * @returns {string}
 */
function draw(key) {
    const container = document.createElement('div');
    game.rows[key].render(container);
    return container.textContent;
}

beforeEach(() => {
    game.options = {};
    combatDropLuck.lastResult = {
        percentile: 0.347,
        income: 44_870_000,
        expected: 47_880_000,
        battles: 900,
        players: [],
    };
    game.party = {
        battles: 900,
        players: [{ name: 'Millennium44', isCurrentPlayer: true, percent: -6.3 }],
        total: { percent: -6.3 },
    };
});

describe('the Drop Luck tile', () => {
    test('it reads as a name and a figure, as Lucky draws it', () => {
        const text = draw('luck');

        expect(text).toContain('Millennium44');
        expect(text).toContain('34.7%');
    });

    test('it shows the percentile, not the takings', () => {
        // The two tiles sit side by side and would look equally plausible
        // showing either number. This is the session's percentile.
        expect(draw('luck')).not.toContain('6.3');
    });

    test('one row, because a percentile cannot be split between a party', () => {
        game.party.players.push({ name: 'Second', isCurrentPlayer: false, percent: 12 });

        expect(draw('luck')).not.toContain('Second');
    });

    test('with nothing measured it draws nothing rather than a zero', () => {
        combatDropLuck.lastResult = null;
        expect(draw('luck')).toBe('');
    });
});

describe('the Over Expected tile', () => {
    test('a row per player and then the total, solo included', () => {
        const text = draw('overExpected');

        expect(text).toContain('Millennium44');
        expect(text).toContain('TOTAL');
        expect(text).toContain('-6.3%');
    });

    test('it shows the takings, not the percentile', () => {
        expect(draw('overExpected')).not.toContain('34.7');
    });

    test('a party gets a row each, and a total that is not their average', () => {
        // An average weights somebody who looted one item the same as somebody
        // who looted a hundred, so the total comes from the party's own figures
        game.party = {
            battles: 900,
            players: [
                { name: 'Millennium44', isCurrentPlayer: true, percent: -20 },
                { name: 'Second', isCurrentPlayer: false, percent: 40 },
            ],
            total: { percent: -5 },
        };
        const text = draw('overExpected');

        expect(text).toContain('Second');
        expect(text).toContain('-5.0%');
        expect(text).not.toContain('10.0%');
    });

    test('a player owed nothing reads as unmeasured rather than as par', () => {
        game.party.players[0].percent = null;
        expect(draw('overExpected')).toContain('—');
    });
});

describe('the only-numbers options', () => {
    test('Luck drops the name and keeps the figure', () => {
        // On a tile shrunk to sit beside five others, the name is the part you
        // already know
        game.options.luckOnlyNumbers = true;
        const text = draw('luck');

        expect(text).not.toContain('Millennium44');
        expect(text).toContain('34.7%');
    });

    test('Over Expected drops the names and the TOTAL label, not the total', () => {
        game.options.expectedOnlyNumbers = true;
        const text = draw('overExpected');

        expect(text).not.toContain('Millennium44');
        expect(text).not.toContain('TOTAL');
        // Two rows still: the player and the party
        expect(text.match(/-6\.3%/g)).toHaveLength(2);
    });

    test('Over Expected narrowed to one player drops the total as well', () => {
        // A total of one row is that row again, printed twice
        game.party.players.push({ name: 'Second', isCurrentPlayer: false, percent: 40 });
        game.options.expectedOnlyPlayer = true;
        const text = draw('overExpected');

        expect(text).toContain('Millennium44');
        expect(text).not.toContain('Second');
        expect(text).not.toContain('TOTAL');
    });

    test('both together leave the figures alone', () => {
        game.options.expectedOnlyPlayer = true;
        game.options.expectedOnlyNumbers = true;
        const text = draw('overExpected');

        expect(text).toBe('-6.3%');
    });

    test('with the options off nothing changes', () => {
        const text = draw('overExpected');

        expect(text).toContain('Millennium44');
        expect(text).toContain('TOTAL');
    });
});

describe('luck per player', () => {
    beforeEach(() => {
        // Two players, the same battles, different drop gear — so different
        // distributions and genuinely different percentiles
        combatDropLuck.lastResult.players = [
            { name: 'Millennium44', isCurrentPlayer: true, percentile: 0.12 },
            { name: 'Second', isCurrentPlayer: false, percentile: 0.88 },
        ];
        game.party.players.push({ name: 'Second', isCurrentPlayer: false, percent: 40 });
    });

    test('a party gets a row each', () => {
        const text = draw('luck');

        expect(text).toContain('Millennium44');
        expect(text).toContain('12.0%');
        expect(text).toContain('Second');
        expect(text).toContain('88.0%');
    });

    test("the party figure is not repeated as everybody's", () => {
        // The whole reason to break it out: one number under two names says
        // nothing that the single row did not
        expect(draw('luck')).not.toContain('34.7%');
    });

    test('only you narrows it to your row', () => {
        game.options.luckOnlyPlayer = true;
        const text = draw('luck');

        expect(text).toContain('Millennium44');
        expect(text).not.toContain('Second');
    });

    test('only numbers drops the names from every row', () => {
        game.options.luckOnlyNumbers = true;
        const text = draw('luck');

        expect(text).not.toContain('Millennium44');
        expect(text).toContain('12.0%');
        expect(text).toContain('88.0%');
    });

    test('a player who cannot be placed reads as unmeasured', () => {
        combatDropLuck.lastResult.players[1].percentile = null;
        expect(draw('luck')).toContain('—');
    });

    test('solo stays one row and uses the session figure', () => {
        // Solo, the session percentile already is this player's: the model was
        // built from their bonuses, so a second one is the same number computed
        // a second way
        combatDropLuck.lastResult.players = [];
        const text = draw('luck');

        expect(text).toContain('34.7%');
    });
});
