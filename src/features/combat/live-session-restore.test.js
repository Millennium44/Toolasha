/** @vitest-environment happy-dom */

/**
 * The personal combat meters through a page refresh.
 *
 * A reload is modelled the way the page does it: every module's `cleanup`
 * (what the unload leaves behind is what was written), the clock moving while
 * the page is shut, then `initialize` on a module that remembers nothing of its
 * own. What must hold: the same character's same run comes back, with the ticks
 * since the reload added rather than replaced and the shut stretch never
 * counted as fighting; anything else — another party, another character, an
 * old save, a Reset, the setting off — comes back as nothing.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    characterId: 7001,
    settings: { combatDpsGraph: true },
    listeners: new Map(),
    disk: new Map(),
    sets: [],
    deletes: [],
    /** When set, every read waits for it — a read still out while something else happens */
    gate: null,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({}),
        getCurrentCharacterId: () => game.characterId,
        getCurrentCharacterName: () => null,
        isBossMonster: () => false,
    },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (type, handler) => {
            if (!game.listeners.has(type)) game.listeners.set(type, new Set());
            game.listeners.get(type).add(handler);
        },
        off: (type, handler) => game.listeners.get(type)?.delete(handler),
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, storeName, fallback) => {
            if (game.gate) await game.gate;
            const id = `${storeName}:${key}`;
            return game.disk.has(id) ? structuredClone(game.disk.get(id)) : fallback;
        },
        set: (key, value, storeName) => {
            game.sets.push({ key, storeName });
            game.disk.set(`${storeName}:${key}`, structuredClone(value));
            return Promise.resolve(true);
        },
        delete: async (key, storeName) => {
            game.deletes.push({ key, storeName });
            game.disk.delete(`${storeName}:${key}`);
            return true;
        },
    },
}));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: (key, fallback) => (key in game.settings ? game.settings[key] : fallback) },
}));
vi.mock('../combat-stats/combat-stats-data-collector.js', () => ({
    default: { getLatestData: () => null },
}));

const damage = await import('./damage-tracker.js');
const taken = await import('./damage-taken-tracker.js');
const graph = await import('./dps-graph.js');
const { LIVE_SESSION_PERSIST_MS, LIVE_SESSION_MAX_AGE_MS } = await import('../../utils/live-session-persist.js');

const T0 = Date.parse('2026-09-12T12:00:00Z');

/** @param {string} type @param {Object} data */
function emit(type, data) {
    for (const handler of [...(game.listeners.get(type) || [])]) handler(data);
}

/** Let the reads a module started at `initialize` come back */
async function settle() {
    for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** The same zone and party, unless told otherwise */
const battle = (names = ['You'], combatStartTime = '2026-09-12T11:00:00Z') => ({
    combatStartTime,
    players: Object.fromEntries(names.map((name, index) => [index, { name, isPreparingAutoAttack: true }])),
    monsters: { 0: { name: 'Eye', combatDetails: { maxHitpoints: 100_000 }, currentHitpoints: 100_000 } },
});

/** Slot 0 swinging at the Eye */
const hit = ({ atk, hp, dmg }) =>
    emit('battle_updated', {
        battleId: 1,
        pMap: { 0: { atkCounter: atk, cMP: 100, isAutoAtk: true } },
        mMap: { 0: { cHP: hp, dmgCounter: dmg, mHP: 100_000 } },
    });

/** The Eye hitting slot 0 */
const struck = ({ hp, dmg }) =>
    emit('battle_updated', {
        battleId: 1,
        pMap: { 0: { cHP: hp, dmgCounter: dmg } },
        mMap: { 0: { cHP: 100_000, cMP: 100, dmgCounter: 0 } },
    });

function start() {
    damage.default.initialize();
    taken.default.initialize();
}

function stop() {
    graph.stopDpsSampler();
    damage.default.cleanup();
    taken.default.cleanup();
}

/**
 * Close the page, keep it shut for a while, open it again.
 * @param {number} [shutMs] - How long it stays shut
 * @param {Function} [whileShut] - Something that changes while it is shut
 */
async function reload(shutMs = 90_000, whileShut = null) {
    stop();
    vi.advanceTimersByTime(shutMs);
    whileShut?.();
    start();
    await settle();
}

/** A run with 2,000 damage over two measured seconds, saved */
function fightAndSave() {
    emit('new_battle', battle());
    hit({ atk: 1, hp: 100_000, dmg: 0 });
    vi.advanceTimersByTime(1000);
    hit({ atk: 2, hp: 99_000, dmg: 1 });
    vi.advanceTimersByTime(1000);
    hit({ atk: 3, hp: 98_000, dmg: 2 });
    vi.advanceTimersByTime(LIVE_SESSION_PERSIST_MS);
}

/** After a reload: a tick that can only be a baseline, then 1,000 damage a second later */
function fightOn() {
    hit({ atk: 10, hp: 50_000, dmg: 20 });
    vi.advanceTimersByTime(1000);
    hit({ atk: 11, hp: 49_000, dmg: 21 });
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    game.characterId = 7001;
    game.settings = { combatDpsGraph: true };
    game.disk.clear();
    game.sets.length = 0;
    game.deletes.length = 0;
    game.gate = null;
    damage.setFilterNonDamaging(true);
    start();
});

afterEach(() => {
    stop();
    graph._resetDpsGraph();
    vi.useRealTimers();
});

describe('the damage tracker through a refresh', () => {
    test('the same run comes back, with the ticks since the reload added', async () => {
        fightAndSave();
        const before = damage.damageBreakdown();
        expect(before.players[0].damage).toBe(2000);
        expect(before.seconds).toBeCloseTo(2);

        await reload();

        // The first tick after a reload is a baseline, and a restored baseline
        // would have read the whole shut stretch as one hit
        hit({ atk: 10, hp: 50_000, dmg: 20 });
        expect(damage.damageBreakdown().players[0]?.damage ?? 0).toBe(0);
        vi.advanceTimersByTime(1000);
        hit({ atk: 11, hp: 49_000, dmg: 21 });

        // Nothing is restored until a battle says which run this is
        expect(damage.damageBreakdown().restored).toBeNull();
        emit('new_battle', battle());

        const after = damage.damageBreakdown();
        expect(after.players[0]).toMatchObject({ name: 'You', damage: 3000 });
        expect(after.team.damage).toBe(3000);
        expect(after.restored).toMatchObject({ savedAt: T0 + LIVE_SESSION_PERSIST_MS });
        // Measured seconds only: two before, one after, and the ninety shut are not among them
        expect(after.seconds).toBeCloseTo(3);
        // Wall clock skips the shut stretch too
        expect(after.logging).toBeLessThan(10);
        // The same run, so the same id — which is what the graph keys on
        expect(after.sessionId).toBe(before.sessionId);
    });

    test('kills and the enemy table come back with the rows', async () => {
        emit('new_battle', battle());
        hit({ atk: 1, hp: 100_000, dmg: 0 });
        vi.advanceTimersByTime(1000);
        hit({ atk: 2, hp: 0, dmg: 1 });
        vi.advanceTimersByTime(LIVE_SESSION_PERSIST_MS);
        const before = damage.damageBreakdown();
        expect(before.players[0].kills).toBe(1);

        await reload();
        emit('new_battle', battle());

        const after = damage.damageBreakdown();
        expect(after.players[0].kills).toBe(1);
        expect(after.enemies.find((enemy) => enemy.name === 'Eye')).toMatchObject({ damage: 100_000, kills: 1 });
    });

    test('a different party at the first battle is a different run, and keeps nothing', async () => {
        fightAndSave();
        await reload();
        fightOn();
        emit('new_battle', battle(['You', 'Gold999']));

        const after = damage.damageBreakdown();
        expect(after.players.reduce((sum, row) => sum + row.damage, 0)).toBe(1000);
        expect(after.restored).toBeNull();
    });

    test('a later battle cannot adopt it either: the first one decides', async () => {
        fightAndSave();
        await reload();
        emit('new_battle', battle(['You'], '2026-09-12T11:30:00Z'));
        emit('new_battle', battle());
        expect(damage.damageBreakdown().restored).toBeNull();
    });

    test('a save older than twenty minutes is not restored', async () => {
        fightAndSave();
        await reload(LIVE_SESSION_MAX_AGE_MS + 1000);
        fightOn();
        emit('new_battle', battle());
        expect(damage.damageBreakdown().players[0].damage).toBe(1000);
        expect(damage.damageBreakdown().restored).toBeNull();
    });

    test('another character never gets it', async () => {
        fightAndSave();
        await reload(90_000, () => {
            game.characterId = 7002;
        });
        fightOn();
        emit('new_battle', battle());
        expect(damage.damageBreakdown().players[0].damage).toBe(1000);
        expect(damage.damageBreakdown().restored).toBeNull();
    });

    test('a character switch while the read is out drops what it read', async () => {
        fightAndSave();
        stop();
        let release;
        game.gate = new Promise((resolve) => {
            release = resolve;
        });
        start();
        // Identity was captured when the read began; this is somebody else now
        game.characterId = 7002;
        release();
        await settle();

        fightOn();
        emit('new_battle', battle());
        expect(damage.damageBreakdown().restored).toBeNull();
    });

    test('a read that comes back after the first battle still decides on it', async () => {
        fightAndSave();
        stop();
        let release;
        game.gate = new Promise((resolve) => {
            release = resolve;
        });
        start();
        emit('new_battle', battle());
        hit({ atk: 1, hp: 100_000, dmg: 0 });
        // Until the read decides, nothing measured since the reload is written over the saved run
        vi.advanceTimersByTime(LIVE_SESSION_PERSIST_MS);
        expect(game.disk.get('combatStats:toolasha_local_liveDamage_7001').savedAt).toBe(T0 + LIVE_SESSION_PERSIST_MS);
        release();
        await settle();

        expect(damage.damageBreakdown().players[0].damage).toBe(2000);
        expect(damage.damageBreakdown().restored).not.toBeNull();
    });

    test('the panel’s Reset throws the saved run away', async () => {
        fightAndSave();
        damage.resetDamageTracker();
        expect(game.deletes.map((entry) => entry.key)).toContain('toolasha_local_liveDamage_7001');

        await reload();
        fightOn();
        emit('new_battle', battle());
        expect(damage.damageBreakdown().restored).toBeNull();
    });

    test('with the setting off nothing is saved and nothing restored', async () => {
        game.settings.combatSessionRestore = false;
        fightAndSave();
        expect(game.sets).toHaveLength(0);

        await reload();
        emit('new_battle', battle());
        expect(damage.damageBreakdown().restored).toBeNull();
    });

    test('closing the page writes what the throttle had not yet', () => {
        emit('new_battle', battle());
        hit({ atk: 1, hp: 100_000, dmg: 0 });
        vi.advanceTimersByTime(LIVE_SESSION_PERSIST_MS);
        const written = game.sets.length;

        vi.advanceTimersByTime(500);
        hit({ atk: 2, hp: 99_000, dmg: 1 });
        window.dispatchEvent(new Event('beforeunload'));

        expect(game.sets.length).toBeGreaterThan(written);
        const saved = game.disk.get('combatStats:toolasha_local_liveDamage_7001');
        expect(saved.tally[0].damage).toBe(1000);
    });
});

describe('the damage-taken tracker through a refresh', () => {
    test('what hit the party comes back, and the wave counts on', async () => {
        emit('new_battle', battle());
        struck({ hp: 500, dmg: 3 });
        vi.advanceTimersByTime(1000);
        struck({ hp: 420, dmg: 4 });
        vi.advanceTimersByTime(LIVE_SESSION_PERSIST_MS);

        const before = taken.takenBreakdown();
        expect(before.players[0].damage).toBe(80);
        expect(before.encounters).toBe(1);

        await reload();
        emit('new_battle', battle());

        const after = taken.takenBreakdown();
        expect(after.players[0].damage).toBe(80);
        expect(after.enemies.find((enemy) => enemy.name === 'Eye')).toMatchObject({ damage: 80, min: 80, max: 80 });
        // The battle before the refresh and the one that just began
        expect(after.encounters).toBe(2);
        expect(after.waves[0]).toMatchObject({ encounters: 2, damage: 80 });
        expect(after.restored).not.toBeNull();
    });

    test('another run keeps nothing', async () => {
        emit('new_battle', battle());
        struck({ hp: 500, dmg: 3 });
        vi.advanceTimersByTime(1000);
        struck({ hp: 420, dmg: 4 });
        vi.advanceTimersByTime(LIVE_SESSION_PERSIST_MS);

        await reload();
        emit('new_battle', battle(['You'], '2026-09-12T11:45:00Z'));
        expect(taken.takenBreakdown().players[0].damage).toBe(0);
        expect(taken.takenBreakdown().restored).toBeNull();
    });
});

describe('the DPS graph through a refresh', () => {
    /**
     * The largest y-axis label the graph drew.
     * @param {string} html - `dpsGraphHTML()`
     * @returns {number}
     */
    function yMax(html) {
        const labels = [...html.matchAll(/text-anchor="end"[^>]*>([^<]+)</g)].map((match) => match[1]);
        return Math.max(
            0,
            ...labels.map((label) => {
                const parsed = /^([\d.,]+)\s*([kmb]?)$/i.exec(label.trim());
                if (!parsed) return 0;
                const scale = { k: 1e3, m: 1e6, b: 1e9 }[parsed[2].toLowerCase()] || 1;
                return Number(parsed[1].replace(/,/g, '')) * scale;
            })
        );
    }

    test('the series comes back with the run it was drawn from', async () => {
        graph.startDpsSampler();
        // Nothing is written while the sampler's own read of a saved series is out
        await settle();
        fightAndSave();
        for (let i = 0; i < 4; i++) vi.advanceTimersByTime(2000);
        expect(graph.dpsGraphHTML()).toContain('<svg');

        await reload(60_000);
        graph.startDpsSampler();
        await settle();
        // A fresh series has nothing whole to draw yet
        expect(graph.dpsGraphHTML()).not.toContain('<svg');

        emit('new_battle', battle());
        vi.advanceTimersByTime(2000);
        expect(graph.dpsGraphHTML()).toContain('<svg');
    });

    test('a restored run with no saved series draws its totals as a baseline, not a spike', async () => {
        // The graph was off before the refresh, so there is nothing of its own to restore
        emit('new_battle', battle());
        hit({ atk: 1, hp: 100_000, dmg: 0 });
        vi.advanceTimersByTime(1000);
        hit({ atk: 2, hp: 1000, dmg: 1 });
        vi.advanceTimersByTime(LIVE_SESSION_PERSIST_MS);

        await reload(60_000);
        graph.startDpsSampler();
        await settle();
        emit('new_battle', battle());
        vi.advanceTimersByTime(2000);

        // 1,000 more after it, which is the only thing this series should draw
        hit({ atk: 3, hp: 100_000, dmg: 0 });
        vi.advanceTimersByTime(1000);
        hit({ atk: 4, hp: 99_000, dmg: 1 });
        for (let i = 0; i < 6; i++) vi.advanceTimersByTime(2000);

        expect(damage.damageBreakdown().players[0].damage).toBe(100_000);
        const html = graph.dpsGraphHTML();
        expect(html).toContain('<svg');
        // 99,000 filed into one two-second bucket would draw in the thousands
        expect(yMax(html)).toBeLessThan(1000);
    });
});
