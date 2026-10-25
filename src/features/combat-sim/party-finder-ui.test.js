/** @vitest-environment happy-dom
 *
 * The Party tab end to end, against a fake coordinator: every way a search can end, and what the tab shows for
 * each. The coordinator is driven by hand — each call parks until the test feeds it results and lets it finish,
 * fail or be cancelled — so a stop, a switch or a closed panel can land exactly mid-pass.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({
    charId: 'me',
    db: undefined,
    failWrite: false,
    calls: [],
    downloads: [],
    zones: [],
    selfDTO: null,
    gameData: null,
    imported: null,
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSettingValue: (_key, fallback) => fallback,
        getSetting: () => true,
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => state.charId,
        get characterData() {
            return { character: { name: 'Milkman' } };
        },
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (_k, _s, fallback) => (state.db === undefined ? fallback : structuredClone(state.db)),
        update: async (_k, mutate) => {
            if (state.failWrite) return null;
            const next = mutate(state.db === undefined ? undefined : structuredClone(state.db));
            if (next === undefined) return { written: false, value: state.db };
            state.db = structuredClone(next);
            return { written: true, value: structuredClone(next) };
        },
    },
}));
vi.mock('../../utils/liquidity-cap.js', () => ({
    capProfitRateCached: ({ goldPerHour }) => ({ goldPerHour, capped: false, limit: null }),
}));
vi.mock('../../utils/csv-export.js', () => ({
    toCsv: (rows, columns) => JSON.stringify({ rows, columns: columns.map((c) => c.key) }),
    csvFilename: (stem) => `${stem}.csv`,
    downloadCsv: (name, csv) => {
        state.downloads.push({ name, csv });
        return true;
    },
}));
vi.mock('./combat-sim-adapter.js', () => ({
    buildGameDataPayload: () => state.gameData,
    buildPlayerDTO: () => (state.selfDTO ? structuredClone(state.selfDTO) : null),
    getCombatZones: () => state.zones,
    getCommunityBuffs: () => ({}),
    getCurrentCombatZone: () => null,
    parseShykaiImport: () => state.imported,
    calculateSimRevenue: (sim, _gameData, playerHrid, hours) => ({
        netPerHour: (sim.__profit?.[playerHrid] ?? 0) / hours,
        dropEntries: [],
        unpricedDrops: sim.__unpriced || [],
        unpricedConsumables: [],
        unpricedKeys: [],
    }),
    recomputeLevelGapDebuffs: () => {},
}));
vi.mock('./all-zones-runner.js', () => ({
    runAllZonesSimulation: (params, onProgress) =>
        new Promise((resolve, reject) => {
            state.calls.push({ params, onProgress, resolve, reject });
        }),
    cancelAllZonesSimulation: () => {
        const call = state.calls.find((c) => !c.settled);
        if (call) {
            call.settled = true;
            call.reject(new Error('Cancelled'));
        }
    },
}));

const { PartyFinderTab, displayNames } = await import('./party-finder-ui.js');
const { announceSyncPullApplied } = await import('../../utils/sync-merge-registry.js');

const HOUR = 3600 * 1e9;
const ZONE = { hrid: '/actions/combat/swamp_planet', name: 'Swamp Planet', isDungeon: false };
const DUNGEON = { hrid: '/actions/combat/chimerical_den', name: 'Chimerical Den', isDungeon: true };

function build(magicLevel, weapon = '/items/rippling_trident') {
    return {
        staminaLevel: 90,
        intelligenceLevel: 90,
        attackLevel: 90,
        meleeLevel: 90,
        defenseLevel: 90,
        rangedLevel: 1,
        magicLevel,
        equipment: {
            '/equipment_types/main_hand': { hrid: weapon, enhancementLevel: 10 },
            '/equipment_types/body': { hrid: '/items/royal_water_robe_top', enhancementLevel: 0 },
        },
        food: [{ hrid: '/items/star_fruit_yogurt', triggers: null }, null, null],
        drinks: [null, null, null],
        abilities: [null, { hrid: '/abilities/water_strike', level: 40, triggers: null }, null, null, null],
        houseRooms: {},
    };
}

function seedRoster(entries) {
    state.db = {
        savedAt: 1,
        entries: entries.map(([id, name, dto]) => ({ id, name, dto, source: 'editor', addedAt: 1, updatedAt: 1 })),
    };
}

/** A sim result in which you (player1) earn `xp` EXP and `profit` gold over `hours` */
function sim(xp, profit, { hours = 2, deaths = 0, unpriced } = {}) {
    return {
        simulatedTime: hours * HOUR,
        experienceGained: { player1: { magic: xp * hours } },
        deaths: { player1: deaths * hours },
        __profit: { player1: profit * hours },
        __unpriced: unpriced,
    };
}

function makeHost() {
    const panel = document.createElement('div');
    panel.innerHTML = `<select id="mwi-csim-zone"><option value="${ZONE.hrid}">Swamp</option><option value="${DUNGEON.hrid}">Den</option></select>
        <select id="mwi-csim-tier"><option value="0">0</option><option value="1">1</option><option value="2">2</option></select>`;
    panel.querySelector('#mwi-csim-zone').value = ZONE.hrid;
    panel.querySelector('#mwi-csim-tier').value = '1';
    document.body.appendChild(panel);
    const host = {
        panel,
        isRunning: false,
        statuses: [],
        _setStatus(text) {
            this.statuses.push(text);
        },
        _isBusy() {
            return this.isRunning || Boolean(tab?.isBusy());
        },
        _switchTab: vi.fn(),
        _flushPendingReprice: vi.fn(),
        _updateTierDropdown: vi.fn(),
        _editor: {
            initialized: true,
            players: [],
            isInitialized() {
                return this.initialized;
            },
            getEditedDTOs() {
                return Object.fromEntries(this.players.map((p) => [p.hrid, p.dto]));
            },
            getPlayerInfo() {
                return this.players.map(({ hrid, name }) => ({ hrid, name }));
            },
            getSelfHrid() {
                return this.players.find((p) => p.self)?.hrid || null;
            },
            playerCount() {
                return this.players.length;
            },
            importPlayers: vi.fn(),
            resetToSelf: vi.fn(),
            loadParty: vi.fn(),
        },
    };
    return host;
}

let host;
let tab;
let container;

const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
};
const lastStatus = () => host.statuses[host.statuses.length - 1];
const el = (name) => tab.root.querySelector(`[data-pf="${name}"]`);
const resultRows = () => [...tab.root.querySelectorAll('[data-pf-row]')];
const rowText = (id) => tab.root.querySelector(`[data-pf-row="${id}"]`)?.textContent || '';

/** Feed every task of the pending pass a result (by `pick(task, index)`), then let it finish */
async function finishPass(pick) {
    const call = state.calls.find((c) => !c.settled);
    call.params.zones.forEach((zone, index) => call.params.onResult(index, pick(zone, index)));
    call.settled = true;
    call.resolve([]);
    await flush();
    return call;
}

async function mountTab() {
    tab = new PartyFinderTab(host);
    tab.mount(container);
    await flush();
    tab.onShow();
}

beforeEach(() => {
    state.charId = 'me';
    state.db = undefined;
    state.failWrite = false;
    state.calls = [];
    state.downloads = [];
    state.zones = [
        { ...ZONE, maxDifficulty: 5 },
        { ...DUNGEON, maxDifficulty: 2 },
    ];
    state.selfDTO = build(90);
    state.imported = null;
    state.gameData = {
        itemDetailMap: {
            '/items/rippling_trident': {},
            '/items/royal_water_robe_top': {},
            '/items/star_fruit_yogurt': {},
            '/items/blazing_trident': {},
        },
        abilityDetailMap: { '/abilities/water_strike': {} },
    };
    document.body.innerHTML = '';
    host = makeHost();
    container = document.createElement('div');
    host.panel.appendChild(container);
});

afterEach(() => {
    tab?.detach();
    tab = null;
});

describe('setting up', () => {
    test('the zone list starts from the Configure tab', async () => {
        await mountTab();
        expect([...el('zone-chips').querySelectorAll('[data-pf-zone]')].map((c) => c.dataset.pfZone)).toEqual([
            `${ZONE.hrid}#1`,
        ]);
    });

    test('same-named teammates are told apart', () => {
        const names = displayNames([
            { id: 'a', name: 'Bob' },
            { id: 'b', name: 'Bob' },
            { id: 'c', name: 'Cy' },
        ]);
        expect([...names.values()]).toEqual(['Bob', 'Bob #2', 'Cy']);
    });

    test('save a player from the editor, then replace their build from the editor', async () => {
        host._editor.players = [
            { hrid: 'player1', name: 'Milkman', dto: build(90), self: true },
            { hrid: 'player2', name: 'Venaam', dto: build(110) },
        ];
        await mountTab();
        el('editor-player').value = 'player2';
        el('add-editor').click();
        await flush();
        expect(state.db.entries.map((e) => e.name)).toEqual(['Venaam']);

        host._editor.players[1].dto = build(130);
        tab._renderAddFromEditor();
        el('editor-player').value = 'player2';
        el('editor-target').value = state.db.entries[0].id;
        el('add-editor').click();
        await flush();
        expect(state.db.entries).toHaveLength(1);
        expect(state.db.entries[0].dto.magicLevel).toBe(130);
    });

    test('copy my build, and paste an import', async () => {
        state.imported = { players: [build(70), build(71)], names: ['Ann', 'Ann'], skipped: [] };
        await mountTab();
        el('add-self').click();
        await flush();
        el('import-text').value = '{"1":"..."}';
        el('import').click();
        await flush();
        expect(state.db.entries.map((e) => e.name)).toEqual(['Milkman (copy)', 'Ann', 'Ann']);
        expect([...tab.root.querySelectorAll('[data-pf-name]')].map((n) => n.textContent)).toEqual([
            'Milkman (copy)',
            'Ann',
            'Ann #2',
        ]);
    });

    test('unreadable import text says so and adds nothing', async () => {
        state.imported = null;
        await mountTab();
        el('import-text').value = 'nonsense';
        el('import').click();
        await flush();
        expect(el('roster-note').textContent).toMatch(/not a sim export/);
        expect(state.db).toBeUndefined();
    });

    test('a roster write that fails says so', async () => {
        state.failWrite = true;
        await mountTab();
        el('add-self').click();
        await flush();
        expect(el('roster-note').textContent).toMatch(/Could not save/);
    });

    test('delete takes two clicks', async () => {
        seedRoster([['a', 'Ann', build(80)]]);
        await mountTab();
        const del = () => [...tab.root.querySelectorAll('[data-pf-member="a"] button')].pop();
        del().click();
        await flush();
        expect(state.db.entries).toHaveLength(1);
        expect(del().textContent).toBe('Delete?');
        del().click();
        await flush();
        expect(state.db.entries).toHaveLength(0);
    });

    test('a pull that writes the roster is read back in', async () => {
        await mountTab();
        seedRoster([['x', 'From another device', build(80)]]);
        announceSyncPullApplied({ settings: ['combatSimPartyRoster'] });
        await flush();
        expect(tab.root.querySelector('[data-pf-name]').textContent).toBe('From another device');
    });
});

describe('every way a search can end', () => {
    test('empty roster', async () => {
        await mountTab();
        tab.start();
        await flush();
        expect(lastStatus()).toBe('Add teammates to the roster first.');
        expect(state.calls).toHaveLength(0);
    });

    test('zero zones', async () => {
        seedRoster([['a', 'Ann', build(80)]]);
        await mountTab();
        tab._zones = [];
        tab.start();
        await flush();
        expect(lastStatus()).toBe('Pick at least one zone first.');
    });

    test('over the run cap: refused before anything runs', async () => {
        seedRoster(Array.from({ length: 40 }, (_, i) => [`m${i}`, `M${i}`, build(60 + i)]));
        await mountTab();
        tab._addZone(ZONE.hrid, 2);
        tab.start();
        await flush();
        expect(lastStatus()).toMatch(/over the 1,500 limit/);
        expect(state.calls).toHaveLength(0);
    });

    test('a large search asks first; cancel runs nothing, continue runs it', async () => {
        seedRoster(Array.from({ length: 12 }, (_, i) => [`m${i}`, `M${i}`, build(60 + i)]));
        await mountTab();
        tab.start();
        await flush();
        expect(el('confirm').style.display).toBe('block');
        expect(el('confirm').textContent).toMatch(/This will run up to \d+ sims/);
        expect(state.calls).toHaveLength(0);

        el('confirm-no').click();
        expect(lastStatus()).toBe('Party search not started.');

        tab.start();
        await flush();
        el('confirm-yes').click();
        await flush();
        expect(state.calls).toHaveLength(1);
        // 1 + 12 + 66 parties in a 3-player zone
        expect(state.calls[0].params.zones).toHaveLength(79);
        tab.stop();
        await flush();
    });

    test('a teammate whose build names unknown gear is left out, and says so', async () => {
        seedRoster([
            ['a', 'Ann', build(80)],
            ['b', 'Broken', build(80, '/items/not_in_this_game')],
        ]);
        await mountTab();
        expect(el('plan').textContent).toMatch(/Left out, not runnable here: Broken/);
        tab.start();
        await flush();
        expect(state.calls[0].params.zones).toHaveLength(2);
        tab.stop();
        await flush();
    });

    test('a full run: quick pass, then the best re-run at full hours; worse than solo is red', async () => {
        seedRoster([
            ['a', 'Ann', build(80)],
            ['b', 'Bob', build(100, '/items/blazing_trident')],
        ]);
        await mountTab();
        el('top-k').value = '1';
        tab.start();
        await flush();
        expect(host.isRunning).toBe(true);
        const quick = state.calls[0].params;
        expect(quick.hours).toBe(2);
        expect(quick.useEarlyExit).toBe(false);
        // Solo, Ann, Bob, Ann + Bob; you are player1 in every party
        expect(quick.zones.map((z) => z.playerDTOs.length)).toEqual([1, 2, 2, 3]);
        expect(quick.zones.every((z) => z.playerDTOs[0].magicLevel === 90)).toBe(true);

        // Ann helps, Bob hurts, both together help most
        const byParty = [sim(1000, 100), sim(1200, 150), sim(800, 50, { unpriced: ['/items/x'] }), sim(1500, 90)];
        await finishPass((_zone, index) => byParty[index]);

        const full = state.calls[1].params;
        expect(full.hours).toBe(10);
        // The best party by EXP (Ann + Bob) and its solo baseline, baseline first
        expect(full.zones.map((z) => z.playerDTOs.length)).toEqual([1, 3]);
        await finishPass((_zone, index) => [sim(1000, 100, { hours: 10 }), sim(1400, 80, { hours: 10 })][index]);

        expect(host.isRunning).toBe(false);
        expect(host._flushPendingReprice).toHaveBeenCalled();
        expect(lastStatus()).toMatch(/Party search done in .*: 4 parties\./);
        const rows = resultRows();
        expect(rows).toHaveLength(4);
        // Ranked by EXP/hr: Ann + Bob (full 1.4K), Ann (1.2K), Solo (full 1K), Bob (800)
        expect(rows.map((r) => r.querySelector('td:nth-child(2) span').textContent)).toEqual([
            'Ann + Bob',
            'Ann',
            'Solo',
            'Bob',
        ]);
        expect(rows[0].textContent).toMatch(/10h/);
        expect(rows[0].textContent).toMatch(/\+40\.0%/);
        const bobDelta = rows[3].querySelectorAll('td')[5];
        expect(bobDelta.textContent).toBe('-20.0%');
        expect(bobDelta.getAttribute('style')).toMatch(/#f44336/);
        // Bob's loot had an unpriced drop
        expect(rows[3].querySelectorAll('td')[3].textContent).toMatch(/^≥/);
    });

    test('sort by profit vs solo, export CSV and load a party into the editor', async () => {
        seedRoster([['a', 'Ann', build(80)]]);
        await mountTab();
        el('top-k').value = '0';
        tab.start();
        await flush();
        await finishPass((_z, index) => [sim(1000, 100), sim(1100, 50)][index]);
        expect(state.calls).toHaveLength(1);

        // Ann earns less than you alone: below the baseline, which compares to itself at 0
        tab.root.querySelector('[data-pf-sort="profitVsSolo"]').click();
        expect(tab.sortedRows().map((r) => r.comp.isBaseline)).toEqual([true, false]);
        tab.root.querySelector('[data-pf-sort="profitVsSolo"]').click();
        expect(tab.sortedRows().map((r) => r.comp.isBaseline)).toEqual([false, true]);

        el('csv').click();
        const { rows, columns } = JSON.parse(state.downloads[0].csv);
        expect(columns).toContain('profitVsSolo');
        expect(rows[0]).toMatchObject({ party: 'Ann', profitVsSolo: -50, xpVsSoloPct: 10 });
        expect(rows[1]).toMatchObject({ party: 'Solo', profitVsSolo: 0 });

        const annRow = tab.sortedRows()[0];
        tab.root.querySelector(`[data-pf-load="${annRow.id}"]`).click();
        const [party, names, options] = host._editor.loadParty.mock.calls[0];
        expect(party.map((p) => p.hrid)).toEqual(['player1', 'player2']);
        expect(names).toEqual(['Milkman', 'Ann']);
        expect(options.selfIsLive).toBe(true);
        expect(host.panel.querySelector('#mwi-csim-zone').value).toBe(ZONE.hrid);
        expect(host._switchTab).toHaveBeenCalledWith('configure');
    });

    test('stopped in the quick pass: finished rows stay, and it says N of M', async () => {
        seedRoster([
            ['a', 'Ann', build(80)],
            ['b', 'Bob', build(100)],
        ]);
        await mountTab();
        tab.start();
        await flush();
        const call = state.calls[0];
        call.params.onResult(0, sim(1000, 100));
        call.params.onResult(1, sim(1100, 100));
        tab.stop();
        await flush();
        expect(lastStatus()).toBe('Party search stopped early — 2 of 4 sims.');
        expect(state.calls).toHaveLength(1);
        expect(host.isRunning).toBe(false);
        await new Promise((r) => setTimeout(r, 300));
        expect(resultRows()).toHaveLength(2);
    });

    test('stopped in the full re-run: says so, quick rows stay', async () => {
        seedRoster([['a', 'Ann', build(80)]]);
        await mountTab();
        tab.start();
        await flush();
        await finishPass((_z, index) => [sim(1000, 100), sim(1100, 100)][index]);
        expect(state.calls).toHaveLength(2);
        tab.stop();
        await flush();
        expect(lastStatus()).toBe('Party search stopped early — 0 of 2 sims (full re-run).');
        expect(resultRows()).toHaveLength(2);
    });

    test("the panel's own Stop (Simulate while running) cancels it too, read as a stop", async () => {
        seedRoster([['a', 'Ann', build(80)]]);
        await mountTab();
        tab.start();
        await flush();
        // As `_onSimulate` does when isRunning
        state.calls[0].settled = true;
        state.calls[0].reject(new Error('Cancelled'));
        await flush();
        expect(lastStatus()).toMatch(/stopped early — 0 of 2 sims/);
    });

    test('a sim that fails is a "sim failed" row; a run that throws keeps what finished', async () => {
        seedRoster([['a', 'Ann', build(80)]]);
        await mountTab();
        tab.start();
        await flush();
        const call = state.calls[0];
        call.params.onResult(0, sim(1000, 100));
        call.params.onResult(1, null);
        call.settled = true;
        call.reject(new Error('MultiWorker error'));
        await flush();
        expect(lastStatus()).toMatch(
            /Party search error: MultiWorker error\. Rows that finished are kept\. 1 sim failed/
        );
        expect(rowText(tab.sortedRows().find((r) => !r.isBaseline).id)).toMatch(/sim failed/);
    });

    test('another run in the panel: refused', async () => {
        seedRoster([['a', 'Ann', build(80)]]);
        await mountTab();
        host.isRunning = true;
        tab.start();
        await flush();
        expect(lastStatus()).toBe('A simulation is already running.');
        expect(state.calls).toHaveLength(0);
    });

    test('a character switch mid-run: nothing more is drawn or said', async () => {
        seedRoster([['a', 'Ann', build(80)]]);
        await mountTab();
        tab.start();
        await flush();
        const before = host.statuses.length;
        state.charId = 'someone else';
        await finishPass((_z, index) => [sim(1000, 100), sim(1100, 100)][index]);
        expect(state.calls).toHaveLength(1);
        expect(resultRows()).toHaveLength(0);
        expect(host.statuses.slice(before).some((s) => /done|stopped|error/.test(s))).toBe(false);
    });

    test('the panel torn down mid-run (setting off, feature off, switch): run cancelled, everything let go', async () => {
        seedRoster([['a', 'Ann', build(80)]]);
        await mountTab();
        tab.start();
        await flush();
        expect(host.isRunning).toBe(true);
        const root = tab.root;
        tab.detach();
        await flush();
        expect(state.calls[0].settled).toBe(true);
        expect(host.isRunning).toBe(false);
        expect(root.isConnected).toBe(false);
        expect(tab.isBusy()).toBe(false);
        // The pull listener went with it
        seedRoster([['z', 'Late', build(80)]]);
        announceSyncPullApplied({ settings: ['combatSimPartyRoster'] });
        await flush();
        expect(tab.root).toBeNull();
        tab = null;
    });

    test('a pricing change during the run is replayed when it ends', async () => {
        seedRoster([['a', 'Ann', build(80)]]);
        await mountTab();
        el('top-k').value = '0';
        tab.start();
        await flush();
        const call = state.calls[0];
        call.params.onResult(0, sim(1000, 100));
        call.params.onResult(1, sim(1100, 100));
        tab.onPricingChanged();
        expect(tab._repricePending).toBe(true);
        call.settled = true;
        call.resolve([]);
        await flush();
        expect(tab._repricePending).toBe(false);
    });

    test('a dungeon tries parties of up to five', async () => {
        seedRoster(Array.from({ length: 4 }, (_, i) => [`m${i}`, `M${i}`, build(70 + i)]));
        await mountTab();
        tab._zones = [];
        tab._addZone(DUNGEON.hrid, 0);
        tab.start();
        await flush();
        const sizes = state.calls[0].params.zones.map((z) => z.playerDTOs.length);
        expect(Math.max(...sizes)).toBe(5);
        // 1 + 4 + 6 + 4 + 1
        expect(sizes).toHaveLength(16);
        tab.stop();
        await flush();
    });
});
