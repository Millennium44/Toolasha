/** @vitest-environment happy-dom
 *
 * The trial board's DPS graph, drawn from the recorder's readings.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const opts = vi.hoisted(() => ({ settings: { combatDpsGraph: true } }));

vi.mock('../../core/config.js', () => ({ default: { getSetting: (key) => opts.settings[key] ?? false } }));
vi.mock('../../core/storage.js', () => ({
    default: { get: async (_key, _store, fallback) => fallback, set: async () => {} },
}));
vi.mock('./guild-trial-recorder.js', () => ({ guildTrialRecorder: { session: null } }));

const { trialRates, trialDpsGraphHTML, noteTrialTier, wireTrialDpsGraph, TOP_PLAYERS, _resetTrialDpsGraph } =
    await import('./trial-dps-graph.js');

const snap = (seconds, players, fights = 1) => ({
    t: seconds * 1000,
    seconds,
    fights,
    players: Object.entries(players).map(([name, damage]) => ({ name, damage })),
});

function parse(html) {
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    return host;
}

beforeEach(() => {
    opts.settings = { combatDpsGraph: true };
    _resetTrialDpsGraph();
    document.body.replaceChildren();
});

describe('trialRates', () => {
    test('a rate per interval between readings, on the watched clock', () => {
        const rates = trialRates([
            snap(0, { Abe: 0, Bo: 0 }),
            snap(15, { Abe: 1500, Bo: 300 }),
            snap(30, { Abe: 3000, Bo: 900 }),
        ]);
        expect(rates.xs).toEqual([15, 30]);
        expect(rates.players.Abe).toEqual([100, 100]);
        expect(rates.players.Bo).toEqual([20, 40]);
        expect(rates.party).toEqual([120, 140]);
    });

    test('a player first seen part-way counts from their first reading, not from zero', () => {
        const rates = trialRates([
            snap(0, { Abe: 0 }),
            snap(15, { Abe: 1500, Cy: 9000 }),
            snap(30, { Abe: 3000, Cy: 9300 }),
        ]);
        expect(rates.players.Cy).toEqual([0, 20]);
        expect(rates.party[0]).toBe(100);
    });

    test('a reading behind the last is a new trial, and the live breakdown is the newest reading', () => {
        const rates = trialRates([snap(600, { Abe: 60_000 }), snap(0, { Abe: 0 }), snap(15, { Abe: 1500 })], {
            seconds: 30,
            fights: 1,
            players: [{ name: 'Abe', damage: 3000 }],
        });
        expect(rates.xs).toEqual([15, 30]);
        expect(rates.players.Abe).toEqual([100, 100]);
    });

    test('a change in fight count is a boundary', () => {
        const rates = trialRates([snap(0, { Abe: 0 }, 1), snap(15, { Abe: 1500 }, 1), snap(30, { Abe: 3000 }, 2)]);
        expect(rates.boundaries).toEqual([15]);
    });
});

describe('trialDpsGraphHTML', () => {
    test('without a recording it says where the graph comes from', () => {
        expect(trialDpsGraphHTML(null, { session: null })).toContain('trial recorder');
    });

    test('the party and the leading players, not the whole roster', () => {
        const names = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'];
        const reading = (seconds) =>
            snap(seconds, Object.fromEntries(names.map((name, i) => [name, seconds * (i + 1)])));
        const host = parse(trialDpsGraphHTML(null, { session: { snapshots: [reading(0), reading(15), reading(30)] } }));

        const titles = [...host.querySelectorAll('polyline title')].map((title) => title.textContent);
        expect(titles).toHaveLength(TOP_PLAYERS + 1);
        expect(titles).toContain('A7');
        expect(titles).not.toContain('A1');
        expect(titles.at(-1)).toBe('Party');
        expect(host.textContent).toContain('5 leading players of 7');
    });

    test('a tier change seen live labels its boundary, and the fight-count mark beside it is the same one', () => {
        noteTrialTier({ seconds: 0, tier: 1 });
        noteTrialTier({ seconds: 20, tier: 2 });
        const session = {
            snapshots: [
                snap(0, { Abe: 0 }, 1),
                snap(15, { Abe: 1500 }, 1),
                snap(30, { Abe: 3000 }, 2),
                snap(45, { Abe: 4500 }, 2),
            ],
        };
        const host = parse(trialDpsGraphHTML({ seconds: 45, tier: 2, fights: 2, players: [] }, { session }));
        expect(host.textContent).toContain('T2');
        expect(host.querySelectorAll('[data-marker]')).toHaveLength(1);
    });

    test('the tier where watching began is not a boundary', () => {
        noteTrialTier({ seconds: 300, tier: 4 });
        const session = { snapshots: [snap(300, { Abe: 0 }), snap(315, { Abe: 10 }), snap(330, { Abe: 20 })] };
        const host = parse(trialDpsGraphHTML({ seconds: 330, tier: 4, players: [] }, { session }));
        expect(host.querySelector('[data-marker]')).toBeNull();
    });

    test('switched off it draws nothing; hidden it keeps only its buttons', () => {
        const session = { snapshots: [snap(0, { Abe: 0 }), snap(15, { Abe: 10 }), snap(30, { Abe: 20 })] };
        const host = parse(trialDpsGraphHTML(null, { session }));
        const redraw = vi.fn();
        wireTrialDpsGraph(host, redraw);
        host.querySelector('[data-trial-graph-view="hidden"]').click();
        expect(redraw).toHaveBeenCalledTimes(1);
        expect(trialDpsGraphHTML(null, { session })).not.toContain('<svg');

        opts.settings = {};
        expect(trialDpsGraphHTML(null, { session })).toBe('');
    });
});
