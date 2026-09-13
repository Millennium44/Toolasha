/**
 * Saving a finished Per-player session from outside the trackers.
 *
 * The trackers wipe a run the moment it ends and say nothing first, so what is
 * worth asserting is the boundary: that a changed `startedAt` or a changed
 * character saves the reading before it, under the character that reading
 * belonged to — and that a run too slight to matter is not saved at all.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const opts = vi.hoisted(() => ({
    settings: { combatDpsGraph: true },
    characterId: 'A',
    dealt: null,
    taken: null,
    audit: null,
    stored: new Map(),
    ws: new Map(),
    actions: [],
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback = false) => opts.settings[key] ?? fallback,
        getSettingValue: (_key, fallback) => fallback,
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) => (opts.stored.has(key) ? opts.stored.get(key) : fallback),
        set: async (key, value) => {
            opts.stored.set(key, value);
            return true;
        },
        delete: async (key) => opts.stored.delete(key),
    },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, handler) => opts.ws.set(type, handler),
        off: (type) => opts.ws.delete(type),
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => opts.characterId,
        getCurrentActions: () => opts.actions,
        getActionDetails: (hrid) => (hrid === '/actions/combat/swamp_planet' ? { name: 'Swamp Planet' } : null),
        isBossMonster: (hrid) => hrid === '/monsters/boss',
        getInitClientData: () => null,
    },
}));
vi.mock('./damage-tracker.js', () => ({ damageBreakdown: () => opts.dealt }));
vi.mock('./damage-taken-tracker.js', () => ({ takenBreakdown: () => opts.taken }));
vi.mock('./rotation-tracker.js', () => ({ rotationAudit: () => opts.audit }));

const {
    MIN_ARCHIVE_SECONDS,
    buildCombatEntry,
    graphFromSeries,
    sampleCombatHistory,
    savedCombatGraphHTML,
    startCombatHistory,
    stopCombatHistory,
    _resetCombatHistory,
} = await import('./combat-history.js');
const { getHistoryEntry, loadHistoryIndex, _resetMeterHistory } = await import('./meter-history.js');
const { BUCKET_MS, newDpsSeries, noteTotals } = await import('../../utils/dps-series.js');

const T0 = 5_000_000;

/** What `damageBreakdown()` says `seconds` into a run */
const reading = (seconds, startedAt = 1000) => ({
    startedAt,
    seconds,
    unownedKills: 0,
    team: { damage: seconds * 100, unattributed: 0, filtered: 0 },
    healing: { total: 0, players: [] },
    players: [
        {
            index: '0',
            name: 'Abe',
            damage: seconds * 60,
            kills: 1,
            abilities: [{ action: 'auto', damage: seconds * 60, hits: 5, crits: 1, misses: 0 }],
        },
        { index: '1', name: 'Bo', damage: seconds * 40, kills: 0, abilities: [] },
    ],
});

/** A run of `seconds`, one reading per graph bucket */
function run(seconds, { startedAt = 1000, characterId = 'A', from = T0 } = {}) {
    for (let s = 0; s <= seconds; s += 2) {
        sampleCombatHistory(from + s * 1000, {
            dealt: reading(s, startedAt),
            taken: { seconds: s, players: [{ name: 'Abe', damage: s * 3 }] },
            audit: null,
            characterId,
        });
    }
}

beforeEach(() => {
    opts.settings = { combatDpsGraph: true };
    opts.characterId = 'A';
    opts.stored = new Map();
    opts.ws = new Map();
    opts.actions = [];
    _resetCombatHistory();
    _resetMeterHistory();
});

afterEach(() => _resetCombatHistory());

describe('what is worth keeping', () => {
    test('thirty seconds of fighting with something measured', () => {
        expect(buildCombatEntry({ at: T0, dealt: reading(MIN_ARCHIVE_SECONDS - 2) })).toBeNull();
        expect(buildCombatEntry({ at: T0, dealt: { ...reading(40), team: {}, players: [] } })).toBeNull();

        const entry = buildCombatEntry({ at: T0, dealt: reading(40), zone: 'Swamp Planet' });
        expect(entry).toMatchObject({
            id: 'combat_1000',
            type: 'combat',
            startedAt: 1000,
            endedAt: T0,
            seconds: 40,
            summary: { label: 'Swamp Planet', total: 4000, perSecond: 100, players: 2, kills: 1, detail: 'Abe, Bo' },
        });
    });
});

describe('the end of a run', () => {
    test('a changed startedAt saves the reading before it, with its graph', async () => {
        run(40);
        const saving = sampleCombatHistory(T0 + 42_000, { dealt: reading(0, 2000), audit: null, characterId: 'A' });
        expect(saving).not.toBeNull();
        await saving;

        const [summary] = await loadHistoryIndex('combat', 'A');
        expect(summary).toMatchObject({ id: 'combat_1000', total: 4000, seconds: 40 });
        const body = await getHistoryEntry('combat', 'combat_1000', 'A');
        expect(body.dealt.players.map((player) => player.damage)).toEqual([2400, 1600]);
        expect(body.taken.players[0].damage).toBe(120);
        expect(body.graph.keys).toEqual(['0', '1']);
        expect(body.graph.points.length).toBeGreaterThan(2);
    });

    test('a character switch saves the run under the character that fought it', async () => {
        run(40);
        await sampleCombatHistory(T0 + 42_000, { dealt: reading(40), audit: null, characterId: 'B' });
        expect(await loadHistoryIndex('combat', 'A')).toHaveLength(1);
        expect(await loadHistoryIndex('combat', 'B')).toEqual([]);
    });

    test('stopping saves the last reading as it was, even with the id already moved on', async () => {
        run(40);
        opts.characterId = 'B';
        opts.dealt = reading(0, 3000);
        await stopCombatHistory();
        expect(await loadHistoryIndex('combat', 'A')).toHaveLength(1);
        expect(await loadHistoryIndex('combat', 'B')).toEqual([]);
    });

    test('a run too short to matter is not saved', async () => {
        run(10);
        expect(await sampleCombatHistory(T0 + 12_000, { dealt: reading(0, 2000), audit: null })).toBeNull();
        expect(await loadHistoryIndex('combat', 'A')).toEqual([]);
    });

    test('with the setting off nothing is saved', async () => {
        opts.settings.combatMeterHistory = false;
        run(40);
        expect(await sampleCombatHistory(T0 + 42_000, { dealt: reading(0, 2000), audit: null })).toBeNull();
        expect(opts.stored.size).toBe(0);
    });
});

describe('the sampler', () => {
    test('names the zone off the running action, and lets go of the socket when it stops', async () => {
        opts.actions = [{ actionHrid: '/actions/combat/swamp_planet', difficultyTier: 2, ordinal: 1 }];
        startCombatHistory();
        opts.ws.get('new_battle')({ monsters: [{ hrid: '/monsters/boss' }] });
        run(40);
        await sampleCombatHistory(T0 + 42_000, { dealt: reading(0, 2000), audit: null });

        expect((await loadHistoryIndex('combat', 'A'))[0].label).toBe('Swamp Planet T2');
        await stopCombatHistory();
        expect(opts.ws.has('new_battle')).toBe(false);
    });
});

describe('a saved graph', () => {
    const graph = () => {
        const series = newDpsSeries({ fromZero: true });
        for (let i = 0; i <= 40; i++) {
            noteTotals(series, T0 + i * BUCKET_MS, [
                { key: '0', name: 'Abe', damage: i * 400 },
                { key: '1', name: 'Bo', damage: i * 200 },
            ]);
        }
        return graphFromSeries(series, T0 + 40 * BUCKET_MS);
    };

    test('draws a line per player and the party, over the whole session', () => {
        const html = savedCombatGraphHTML(graph());
        expect(html).toContain('<svg');
        expect(html.match(/<polyline/g)).toHaveLength(3);
        expect(html).toContain('The whole session');
    });

    test('says so when none was kept, and draws nothing with the graph setting off', () => {
        expect(savedCombatGraphHTML(null)).toContain('No graph was kept');
        opts.settings.combatDpsGraph = false;
        expect(savedCombatGraphHTML(graph())).toBe('');
    });
});
