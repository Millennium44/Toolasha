/** @vitest-environment happy-dom
 *
 * The Per-player panel's DPS graph.
 *
 * The bucket arithmetic is `dps-series.js`' and tested there. What is worth
 * asserting here is the wiring: that the graph covers the tracker's run and
 * nothing before it, that a boss battle announced on the socket shades the
 * stretch it covers, that each line is drawn in its player's colour, and that
 * the sampler lets go of the socket when it stops.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const opts = vi.hoisted(() => ({
    settings: { combatDpsGraph: true },
    breakdown: { startedAt: 1, seconds: 0, players: [] },
    ws: new Map(),
}));

vi.mock('../../core/config.js', () => ({ default: { getSetting: (key) => opts.settings[key] ?? false } }));
vi.mock('../../core/storage.js', () => ({
    default: { get: async (_key, _store, fallback) => fallback, set: async () => {} },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, handler) => opts.ws.set(type, handler),
        off: (type) => opts.ws.delete(type),
    },
}));
vi.mock('./damage-tracker.js', () => ({ damageBreakdown: () => opts.breakdown }));
vi.mock('../../core/data-manager.js', () => ({
    default: { isBossMonster: (hrid) => hrid === '/monsters/crystal_colossus' },
}));

const {
    isBossBattle,
    sampleDamage,
    startDpsSampler,
    stopDpsSampler,
    dpsGraphHTML,
    wireDpsGraph,
    bossBands,
    _resetDpsGraph,
} = await import('./dps-graph.js');
const { BUCKET_MS } = await import('../../utils/dps-series.js');
const { PARTY_COLOR } = await import('../../utils/dps-graph-svg.js');
const { playerColor } = await import('../../utils/player-colors.js');

const T0 = 5_000_000;
const reading = (players, startedAt = 1) => ({ startedAt, seconds: 10, players });

function parse(html) {
    const host = document.createElement('div');
    host.innerHTML = html;
    document.body.appendChild(host);
    return host;
}

/** A steady two-player fight, one reading per bucket */
function fight(buckets, startedAt = 1) {
    for (let i = 0; i <= buckets; i++) {
        sampleDamage(
            T0 + i * BUCKET_MS,
            reading(
                [
                    { index: '0', name: 'Abe', damage: i * 400 },
                    { index: '1', name: 'Bo', damage: i * 200 },
                ],
                startedAt
            )
        );
    }
}

beforeEach(() => {
    opts.settings = { combatDpsGraph: true };
    opts.breakdown = { startedAt: 1, seconds: 0, players: [] };
    opts.ws = new Map();
    _resetDpsGraph();
    document.body.replaceChildren();
});

afterEach(() => {
    _resetDpsGraph();
    vi.useRealTimers();
});

describe('what a boss is', () => {
    test('an enrage timer past three minutes; exactly three is an ordinary monster', () => {
        expect(isBossBattle({ monsters: [{ hrid: '/monsters/crystal_colossus' }] })).toBe(true);
        // A zone's ordinary spawns can carry a long enrage timer too (Pirate Cove's enrage at 600 s)
        expect(isBossBattle({ monsters: [{ hrid: '/monsters/anchor_shark', enrageTimerDuration: 6e11 }] })).toBe(false);
        expect(isBossBattle({})).toBe(false);
    });

    test('a boss battle heard on the socket shades the stretch after it', () => {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        opts.breakdown = reading([{ index: '0', name: 'Abe', damage: 0 }]);
        startDpsSampler();
        opts.ws.get('new_battle')({ monsters: [{ hrid: '/monsters/crystal_colossus' }] });

        for (let i = 1; i <= 5; i++) {
            opts.breakdown = reading([{ index: '0', name: 'Abe', damage: i * 200 }]);
            vi.advanceTimersByTime(BUCKET_MS);
        }

        const host = parse(dpsGraphHTML({ now: Date.now() + BUCKET_MS }));
        expect(host.querySelector('[data-band]')).not.toBeNull();
        expect(host.textContent).toContain('boss fight');
    });

    test('contiguous boss points are one band', () => {
        const points = [0, 1, 2, 3, 4].map((i) => ({ t: i * 2, boss: i !== 2 }));
        expect(bossBands(points, 2)).toEqual([
            { from: 0, to: 4 },
            { from: 6, to: 10 },
        ]);
    });
});

describe('the sampler’s lifecycle', () => {
    test('with the graph setting off nothing listens and nothing is drawn', () => {
        opts.settings = {};
        startDpsSampler();
        expect(opts.ws.size).toBe(0);
        expect(dpsGraphHTML({ now: T0 })).toBe('');
    });

    test('stopping lets go of the socket and forgets the series', () => {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        startDpsSampler();
        expect(opts.ws.has('new_battle')).toBe(true);
        stopDpsSampler();
        expect(opts.ws.has('new_battle')).toBe(false);
        expect(dpsGraphHTML({ now: T0 + 60_000 })).toContain('fills in as the fight goes on');
    });
});

describe('the graph', () => {
    test('one line per player in their own colour, and the party on top', () => {
        fight(20);
        const lines = parse(dpsGraphHTML({ now: T0 + 21 * BUCKET_MS })).querySelectorAll('polyline');
        expect([...lines].map((line) => line.getAttribute('stroke'))).toEqual([
            playerColor('Abe'),
            playerColor('Bo'),
            PARTY_COLOR,
        ]);
    });

    test('a new run on the tracker starts the graph again, from zero', () => {
        fight(20);
        sampleDamage(T0 + 21 * BUCKET_MS, reading([{ index: '0', name: 'Cy', damage: 400 }], 2));
        sampleDamage(T0 + 22 * BUCKET_MS, reading([{ index: '0', name: 'Cy', damage: 800 }], 2));

        const host = parse(dpsGraphHTML({ now: T0 + 23 * BUCKET_MS }));
        const titles = [...host.querySelectorAll('polyline title')].map((title) => title.textContent);
        // One player is their own party, so no second line on top of theirs
        expect(titles).toEqual(['Cy']);
    });

    test('before two whole buckets it says what it is waiting for', () => {
        expect(dpsGraphHTML({ now: T0 })).toContain('fills in as the fight goes on');
    });

    test('the view buttons switch between five minutes, the session and hidden', () => {
        fight(20);
        const now = T0 + 21 * BUCKET_MS;
        const host = parse(dpsGraphHTML({ now }));
        const redraw = vi.fn();
        wireDpsGraph(host, redraw);

        host.querySelector('[data-graph-view="hidden"]').click();
        expect(redraw).toHaveBeenCalledTimes(1);
        expect(dpsGraphHTML({ now })).not.toContain('<svg');

        const hidden = parse(dpsGraphHTML({ now }));
        wireDpsGraph(hidden, redraw);
        hidden.querySelector('[data-graph-view="session"]').click();
        expect(dpsGraphHTML({ now })).toContain('<svg');
    });
});
