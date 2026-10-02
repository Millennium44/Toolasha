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

    test('the final snapshot restated in the game’s totals is not a reading of the stream', () => {
        // Watched from partway: the stream saw 3,000 of Abe's 90,000. The
        // recorder replaces its last snapshot with the game's totals, keeping
        // the watched clock (`reconcileSnapshot`)
        const reconciled = { ...snap(45, { Abe: 90_000 }), basis: 'game', streamTotalDamage: 4500 };
        const rates = trialRates([snap(0, { Abe: 0 }), snap(15, { Abe: 1500 }), snap(30, { Abe: 3000 }), reconciled], {
            seconds: 45,
            fights: 1,
            players: [{ name: 'Abe', damage: 4500 }],
        });
        expect(rates.xs).toEqual([15, 30, 45]);
        expect(rates.players.Abe).toEqual([100, 100, 100]);
        expect(Math.max(...rates.party)).toBe(100);
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

const { thinTrialRates, snapshotTierMarks, savedTrialGraphHTML } = await import('./trial-dps-graph.js');

describe('a saved trial’s graph', () => {
    const seven = (seconds, tier) => ({
        seconds,
        fights: tier,
        tier,
        players: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'].map((name, i) => ({ name, damage: seconds * (i + 1) })),
    });

    test('keeps the leading players and how many there were', () => {
        const thin = thinTrialRates(trialRates([seven(0, 1), seven(15, 1), seven(30, 2)]));
        expect(Object.keys(thin.players)).toEqual(['A7', 'A6', 'A5', 'A4', 'A3']);
        expect(thin.playerCount).toBe(7);
        expect(thin.party).toEqual([28, 28]);
    });

    test('tier changes come from the readings, and a new trial starts the list again', () => {
        expect(snapshotTierMarks([seven(0, 1), seven(15, 2), seven(30, 2), seven(45, 4)])).toEqual([
            { seconds: 15, tier: 2 },
            { seconds: 45, tier: 4 },
        ]);
        expect(snapshotTierMarks([seven(0, 1), seven(15, 2), seven(5, 1), seven(20, 3)])).toEqual([
            { seconds: 20, tier: 3 },
        ]);
    });

    test('draws the kept lines with every tier labelled, and says so when nothing was kept', () => {
        const snapshots = [seven(0, 1), seven(15, 1), seven(30, 2), seven(45, 2)];
        const graph = { rates: thinTrialRates(trialRates(snapshots)), marks: snapshotTierMarks(snapshots) };
        const host = parse(savedTrialGraphHTML(graph));
        expect(host.querySelectorAll('polyline')).toHaveLength(TOP_PLAYERS + 1);
        expect(host.textContent).toContain('T2');
        expect(host.textContent).toContain('5 leading players of 7');

        expect(savedTrialGraphHTML(null)).toContain('No graph was kept');
        expect(savedTrialGraphHTML(graph, { draw: false })).toBe('');
        opts.settings = { combatDpsGraph: false };
        expect(savedTrialGraphHTML(graph)).toBe('');
    });
});

describe('two scales', () => {
    // Abe ~100/s, Bo ~20/s; the party (120/s) is the sum
    const session = {
        snapshots: [
            snap(0, { Abe: 0, Bo: 0 }),
            snap(15, { Abe: 1500, Bo: 300 }),
            snap(30, { Abe: 3000, Bo: 600 }),
            snap(45, { Abe: 4500, Bo: 900 }),
        ],
    };

    /**
     * @param {Element} host - The drawn graph
     * @param {string} side - 'left' or 'right'
     * @returns {string[]} Tick labels on that axis
     */
    const ticks = (host, side) => [...host.querySelectorAll(`text[data-axis="${side}"]`)].map((t) => t.textContent);

    test('players set the left axis and the party sets the right', () => {
        const host = parse(trialDpsGraphHTML(null, { session }));
        expect(ticks(host, 'left').at(-1)).toBe('100');
        expect(ticks(host, 'right').at(-1)).toBe('150');
        expect(host.querySelector('polyline[stroke-dasharray="5 2"] title').textContent).toBe('Party');
        expect(host.textContent).toContain('right-hand scale');
    });

    test('a large party leaves the players readable', () => {
        const big = {
            snapshots: [
                snap(0, { Abe: 0, Bo: 0, Cy: 0 }),
                snap(15, { Abe: 15_000, Bo: 300_000, Cy: 600_000 }),
                snap(30, { Abe: 30_000, Bo: 600_000, Cy: 1_200_000 }),
            ],
        };
        const host = parse(trialDpsGraphHTML(null, { session: big }));
        // Cy is 40,000/s, the party 61,000/s: each axis is sized to its own maximum
        expect(ticks(host, 'left').at(-1)).toBe('40.0K');
        expect(ticks(host, 'right').at(-1)).toBe('80.0K');
    });

    test('toggling a series recomputes the scales from what is showing', () => {
        let host = parse(trialDpsGraphHTML(null, { session }));
        const redraw = vi.fn(() => {
            document.body.replaceChildren();
            host = parse(trialDpsGraphHTML(null, { session }));
            wireTrialDpsGraph(host, redraw);
        });
        wireTrialDpsGraph(host, redraw);

        // Hide Abe: the left axis now belongs to Bo alone (20/s)
        host.querySelector('[data-trial-graph-series="Abe"]').click();
        expect(ticks(host, 'left').at(-1)).toBe('20');
        expect(host.querySelectorAll('polyline')).toHaveLength(2);
        expect(host.querySelector('[data-trial-graph-series="Abe"]').getAttribute('aria-pressed')).toBe('false');

        // Hide Bo as well: the party alone, on its own axis, with no left labels
        host.querySelector('[data-trial-graph-series="Bo"]').click();
        expect(ticks(host, 'left')).toEqual([]);
        expect(ticks(host, 'right').at(-1)).toBe('150');
        expect(host.querySelectorAll('polyline')).toHaveLength(1);

        // Hide the party too: nothing drawn, and nothing throws
        host.querySelector('[data-trial-graph-series=" party"]').click();
        expect(host.querySelectorAll('polyline')).toHaveLength(0);
        expect(host.textContent).not.toContain('could not be drawn');

        // Show Abe again with the party still hidden: left axis only
        host.querySelector('[data-trial-graph-series="Abe"]').click();
        expect(ticks(host, 'right')).toEqual([]);
        expect(ticks(host, 'left').at(-1)).toBe('100');
    });

    test('hidden series survive a redraw and the Show/Hide toggle', () => {
        const host = parse(trialDpsGraphHTML(null, { session }));
        const redraw = vi.fn();
        wireTrialDpsGraph(host, redraw);
        host.querySelector('[data-trial-graph-series="Abe"]').click();
        host.querySelector('[data-trial-graph-view="hidden"]').click();
        host.querySelector('[data-trial-graph-view="shown"]').click();
        const again = parse(trialDpsGraphHTML(null, { session }));
        expect(again.querySelector('[data-trial-graph-series="Abe"]').getAttribute('aria-pressed')).toBe('false');
    });

    test('a single player, and tiny values, still draw both axes', () => {
        const lone = { snapshots: [snap(0, { Abe: 0 }), snap(15, { Abe: 3 }), snap(30, { Abe: 6 })] };
        const host = parse(trialDpsGraphHTML(null, { session: lone }));
        expect(host.querySelectorAll('polyline')).toHaveLength(2);
        expect(ticks(host, 'left').length).toBeGreaterThan(1);
        expect(ticks(host, 'right').length).toBeGreaterThan(1);
    });

    test('a saved trial draws the same two scales', () => {
        const graph = { rates: thinTrialRates(trialRates(session.snapshots)), marks: [] };
        const host = parse(savedTrialGraphHTML(graph));
        expect(ticks(host, 'right').at(-1)).toBe('150');
        expect(host.querySelector('[data-trial-graph-series=" party"]')).not.toBeNull();
    });
});
