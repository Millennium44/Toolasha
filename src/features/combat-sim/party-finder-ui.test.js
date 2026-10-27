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
    revenueTaxRates: [],
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
        getCurrentCharacterGameMode: () => state.gameMode,
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
    calculateSimRevenue: (sim, _gameData, playerHrid, hours, options = {}) => {
        state.revenueTaxRates.push(options.saleTaxRate);
        return {
            netPerHour: (sim.__profit?.[playerHrid] ?? 0) / hours,
            dropEntries: [],
            unpricedDrops: sim.__unpriced || [],
            unpricedConsumables: [],
            unpricedKeys: [],
        };
    },
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
        entries: entries.map(([id, name, dto, gameMode]) => ({
            id,
            name,
            dto,
            source: 'editor',
            addedAt: 1,
            updatedAt: 1,
            ...(gameMode ? { gameMode } : {}),
        })),
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
        <select id="mwi-csim-tier"><option value="0">0</option><option value="1">1</option><option value="2">2</option></select>
        <button id="mwi-csim-run">Simulate</button>`;
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
    state.gameMode = undefined;
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
    state.revenueTaxRates = [];
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

    test('a numbered name never repeats a teammate literally called that', () => {
        const names = displayNames([
            { id: 'a', name: 'Bob' },
            { id: 'b', name: 'Bob' },
            { id: 'c', name: 'Bob #2' },
            { id: 'd', name: 'Bob' },
        ]);
        expect([...names.values()]).toEqual(['Bob', 'Bob #3', 'Bob #2', 'Bob #4']);
        expect(new Set(names.values()).size).toBe(4);
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
        // ...so his profit against solo is built on a zero too, and says so; Ann's is not
        const marker = rows[3].querySelectorAll('td')[6].querySelector('[data-pf-delta-unpriced]');
        expect(marker?.getAttribute('title')).toContain('/items/x');
        expect(rows[1].querySelector('[data-pf-delta-unpriced]')).toBeNull();
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

describe('aura options in the tab', () => {
    const auraDetail = (name) => ({
        name,
        isSpecialAbility: true,
        abilityEffects: [{ effectType: '/ability_effect_types/buff', targetType: 'allAllies', buffs: [{}] }],
    });
    beforeEach(() => {
        state.gameData.abilityDetailMap['/abilities/fierce_aura'] = auraDetail('Fierce Aura');
        state.gameData.abilityDetailMap['/abilities/mystic_aura'] = auraDetail('Mystic Aura');
        state.gameData.levelExperienceTable = Array.from({ length: 201 }, (_, i) => i);
    });

    const openAuras = async (id) => {
        [...tab.root.querySelectorAll(`[data-pf-member="${id}"] button`)]
            .find((b) => b.textContent.startsWith('Auras'))
            .click();
        await flush();
    };

    test('only auras are offered; add, refuse a level out of range, untick as built, remove', async () => {
        seedRoster([['a', 'Ann', build(80)]]);
        await mountTab();
        await openAuras('a');
        const pick = tab.root.querySelector('[data-pf-aura-pick="a"]');
        expect([...pick.options].map((o) => o.textContent)).toEqual(['Fierce Aura', 'Mystic Aura']);

        tab.root.querySelector('[data-pf-aura-level="a"]').value = '999';
        tab.root.querySelector('[data-pf-aura-add="a"]').click();
        await flush();
        expect(el('roster-note').textContent).toBe('Aura level must be 1-200.');
        expect(state.db.entries[0].auras).toBeUndefined();

        tab.root.querySelector('[data-pf-aura-pick="a"]').value = '/abilities/mystic_aura';
        tab.root.querySelector('[data-pf-aura-level="a"]').value = '30';
        tab.root.querySelector('[data-pf-aura-add="a"]').click();
        await flush();
        expect(state.db.entries[0].auras).toEqual([{ hrid: '/abilities/mystic_aura', level: 30 }]);
        expect(el('plan').textContent).toMatch(/^3 quick sims/);

        tab.root.querySelector('[data-pf-as-built="a"]').click();
        await flush();
        expect(state.db.entries[0].includeAsBuilt).toBe(false);
        expect(el('plan').textContent).toMatch(/^2 quick sims/);

        tab.root.querySelector('[data-pf-aura-option="/abilities/mystic_aura"] button').click();
        await flush();
        expect(state.db.entries[0].auras).toEqual([]);
    });

    test('an edit drawn from an older copy lands on the list as stored now', async () => {
        seedRoster([['a', 'Ann', build(80)]]);
        await mountTab();
        await openAuras('a');
        // Another tab adds an aura after this editor was drawn
        state.db.entries[0].auras = [{ hrid: '/abilities/fierce_aura', level: 20 }];
        state.db.entries[0].updatedAt = 2;
        tab.root.querySelector('[data-pf-aura-pick="a"]').value = '/abilities/mystic_aura';
        tab.root.querySelector('[data-pf-aura-level="a"]').value = '15';
        tab.root.querySelector('[data-pf-aura-add="a"]').click();
        await flush();
        expect(state.db.entries[0].auras).toEqual([
            { hrid: '/abilities/fierce_aura', level: 20 },
            { hrid: '/abilities/mystic_aura', level: 15 },
        ]);
    });

    test('a stored aura the game no longer has is shown as skipped, and the plan says so', async () => {
        seedRoster([['a', 'Ann', build(80)]]);
        state.db.entries[0].auras = [{ hrid: '/abilities/retired_aura', level: 10 }];
        await mountTab();
        await openAuras('a');
        expect(tab.root.querySelector('[data-pf-aura-option="/abilities/retired_aura"]').textContent).toMatch(
            /not in the game data; skipped/
        );
        expect(el('plan').textContent).toMatch(/Ann: \/abilities\/retired_aura is not in the game data, skipped/);
    });

    test('the run tries each aura, the row names it, and Load puts that aura on the teammate', async () => {
        seedRoster([['a', 'Ann', build(80)]]);
        state.db.entries[0].auras = [{ hrid: '/abilities/fierce_aura', level: 20 }];
        await mountTab();
        el('top-k').value = '0';
        tab.start();
        await flush();
        const zones = state.calls[0].params.zones;
        expect(zones).toHaveLength(3);
        expect(zones[2].playerDTOs[1].abilities[0]).toMatchObject({ hrid: '/abilities/fierce_aura', level: 20 });
        expect(zones[1].playerDTOs[1].abilities[0]).toBeNull();
        await finishPass((_z, index) => [sim(1000, 100), sim(1100, 100), sim(1300, 100)][index]);

        const auraRow = tab.sortedRows()[0];
        expect(rowText(auraRow.id)).toMatch(/Ann \[Fierce Aura 20\]/);
        tab.root.querySelector(`[data-pf-load="${auraRow.id}"]`).click();
        const [party] = host._editor.loadParty.mock.calls[0];
        expect(party[1].abilities[0]).toMatchObject({ hrid: '/abilities/fierce_aura', level: 20 });
    });

    test('two players on one aura is run and flagged on the row', async () => {
        state.selfDTO.abilities[0] = { hrid: '/abilities/fierce_aura', level: 10, triggers: null };
        seedRoster([['a', 'Ann', build(80)]]);
        state.db.entries[0].auras = [{ hrid: '/abilities/fierce_aura', level: 20 }];
        state.db.entries[0].includeAsBuilt = false;
        await mountTab();
        el('top-k').value = '0';
        tab.start();
        await flush();
        await finishPass((_z, index) => [sim(1000, 100), sim(1100, 100)][index]);
        const party = tab.sortedRows().find((r) => !r.isBaseline);
        expect(rowText(party.id)).toMatch(/Fierce Aura ×2/);
    });

    test('the confirm count includes every aura variant', async () => {
        seedRoster(Array.from({ length: 6 }, (_, i) => [`m${i}`, `M${i}`, build(60 + i)]));
        for (const e of state.db.entries) {
            e.auras = [
                { hrid: '/abilities/fierce_aura', level: 20 },
                { hrid: '/abilities/mystic_aura', level: 20 },
            ];
        }
        await mountTab();
        tab.start();
        await flush();
        // 6 teammates x 3 variants: 1 + 18 + 15 x 9 = 154 quick sims
        expect(el('confirm').textContent).toMatch(/154 quick/);
    });
});

describe('the Configure tab while a party search runs', () => {
    test('Simulate is disabled for the run and enabled again when it stops or the tab goes', async () => {
        seedRoster([['a', 'Ann', build(80)]]);
        await mountTab();
        const simulate = host.panel.querySelector('#mwi-csim-run');
        tab.start();
        await flush();
        expect(simulate.disabled).toBe(true);
        tab.stop();
        await flush();
        expect(simulate.disabled).toBe(false);

        tab.start();
        await flush();
        expect(simulate.disabled).toBe(true);
        tab.detach();
        expect(simulate.disabled).toBe(false);
        tab = null;
    });
});

describe('whose sale tax prices "you"', () => {
    test('an Iron Cow loaded in the editor is priced with no market tax; the live character with their own', async () => {
        host._editor.players = [
            { hrid: 'player1', name: 'Milkman', dto: build(90), self: true },
            { hrid: 'player2', name: 'Cow', dto: { ...build(95), gameMode: 'ironcow' } },
        ];
        seedRoster([['a', 'Ann', build(80)]]);
        await mountTab();
        el('top-k').value = '0';
        el('self').value = 'editor:player2';
        tab.start();
        await flush();
        await finishPass((_z, index) => [sim(1000, 100), sim(1100, 100)][index]);
        expect(state.revenueTaxRates).toEqual([0, 0]);
        // Repricing keeps it
        state.revenueTaxRates = [];
        tab.onPricingChanged();
        expect(state.revenueTaxRates).toEqual([0, 0]);

        state.revenueTaxRates = [];
        el('self').value = 'editor:player1';
        tab.start();
        await flush();
        await finishPass((_z, index) => [sim(1000, 100), sim(1100, 100)][index]);
        expect(state.revenueTaxRates).toEqual([undefined, undefined]);
    });
});

describe('a pricing change held for the end of a run', () => {
    /** The panel's own hold and replay, as `_redisplayLastResults` / `_flushPendingReprice` do it */
    const panelHolds = () => {
        host._repricePending = false;
        host._flushPendingReprice = vi.fn(() => {
            if (!host._repricePending) return;
            host._repricePending = false;
            queueMicrotask(() => tab?.onPricingChanged());
        });
        return () => {
            if (host.isRunning) host._repricePending = true;
            tab.onPricingChanged();
        };
    };

    test('is replayed once, not twice', async () => {
        seedRoster([['a', 'Ann', build(80)]]);
        await mountTab();
        const pricingChanged = panelHolds();
        el('top-k').value = '0';
        tab.start();
        await flush();
        const call = state.calls[0];
        call.params.onResult(0, sim(1000, 100));
        call.params.onResult(1, sim(1100, 100));
        pricingChanged();
        state.revenueTaxRates = [];
        call.settled = true;
        call.resolve([]);
        await flush();
        // Two rows, priced once each by the replay
        expect(state.revenueTaxRates).toHaveLength(2);
    });

    test('a teardown mid-run lets the panel replay what it held', async () => {
        seedRoster([['a', 'Ann', build(80)]]);
        await mountTab();
        const pricingChanged = panelHolds();
        tab.start();
        await flush();
        pricingChanged();
        expect(host._repricePending).toBe(true);
        tab.detach();
        expect(host._flushPendingReprice).toHaveBeenCalled();
        expect(host._repricePending).toBe(false);
        tab = null;
    });
});

describe('redrawing while results stream in', () => {
    test('at most once a second while streaming, at once at the end; clicks still work after redraws', async () => {
        seedRoster([
            ['a', 'Ann', build(80)],
            ['b', 'Bob', build(100)],
        ]);
        await mountTab();
        el('top-k').value = '0';
        tab.start();
        await flush();
        const renders = vi.spyOn(tab, '_renderResults');
        const call = state.calls[0];
        call.params.onResult(0, sim(1000, 100));
        call.params.onResult(1, sim(1100, 100));
        await new Promise((r) => setTimeout(r, 400));
        call.params.onResult(2, sim(900, 100));
        expect(renders).toHaveBeenCalledTimes(0);
        await new Promise((r) => setTimeout(r, 800));
        expect(renders).toHaveBeenCalledTimes(1);
        call.params.onResult(3, sim(1300, 100));
        call.settled = true;
        call.resolve([]);
        await flush();
        expect(renders).toHaveBeenCalledTimes(2);
        // The pending streamed redraw was folded into the final one
        await new Promise((r) => setTimeout(r, 1100));
        expect(renders).toHaveBeenCalledTimes(2);

        // One click, one action, however many times the table was rebuilt
        el('csv').click();
        expect(state.downloads).toHaveLength(1);
        const header = () => tab.root.querySelector('[data-pf-sort="xp"]');
        header().click();
        expect(tab._sortAsc).toBe(true);
        header().click();
        expect(tab._sortAsc).toBe(false);
    });
});

describe('teammates of the other game mode', () => {
    const planText = () => el('plan').textContent;
    const member = (id) => tab.root.querySelector(`[data-pf-member="${id}"]`);

    test('a market character searches without its Iron Cow teammates, who show greyed with the reason', async () => {
        state.gameMode = 'standard';
        seedRoster([
            ['a', 'Ann', build(80), 'standard'],
            ['b', 'Bob', build(81), 'ironcow'],
            ['c', 'Cy', build(82)],
        ]);
        await mountTab();
        expect(member('b').textContent).toContain("Iron Cow — can't party with a market character");
        expect(member('b').querySelector('[data-pf-choice]').disabled).toBe(true);
        expect(member('a').querySelector('[data-pf-choice]').disabled).toBe(false);
        expect(member('c').textContent).toContain('game mode unknown');
        expect(planText()).toContain('Left out, other game mode: Bob');
        // Bob out leaves solo, Ann, Cy and both per zone/tier; with him in it would be more
        const withBob = Number(/^(\d+) quick sim/.exec(planText())[1]);
        state.gameMode = undefined;
        tab._renderRoster();
        expect(Number(/^(\d+) quick sim/.exec(planText())[1])).toBeGreaterThan(withBob);
    });

    test('an Iron Cow searches without its market teammates', async () => {
        state.gameMode = 'legacy_ironcow';
        seedRoster([
            ['a', 'Ann', build(80), 'standard'],
            ['b', 'Bob', build(81), 'ironcow'],
        ]);
        await mountTab();
        expect(member('a').textContent).toContain("market character — can't party with an Iron Cow");
        expect(member('b').textContent).not.toContain("can't party");
        expect(planText()).toContain('Left out, other game mode: Ann');
    });

    test('when every teammate is of the other mode, the plan and the status say so', async () => {
        state.gameMode = 'standard';
        seedRoster([
            ['a', 'Ann', build(80), 'ironcow'],
            ['b', 'Bob', build(81), 'ironcow'],
        ]);
        await mountTab();
        expect(planText()).toContain("No teammates of this character's mode");
        await tab.start();
        await flush();
        expect(lastStatus()).toContain("No teammates of this character's mode");
        expect(state.calls).toHaveLength(0);
    });

    test('an unknown live mode excludes nobody', async () => {
        seedRoster([['a', 'Ann', build(80), 'ironcow']]);
        await mountTab();
        expect(member('a').textContent).not.toContain("can't party");
        expect(planText()).not.toContain('other game mode');
    });

    test('copying your own build saves the live mode with it', async () => {
        state.gameMode = 'ironcow';
        await mountTab();
        await tab._onCopySelf();
        expect(tab._roster.entries[0].gameMode).toBe('ironcow');
    });

    test('a party loaded into the editor carries each teammate mode with their build', async () => {
        state.gameMode = 'ironcow';
        seedRoster([
            ['a', 'Ann', build(80), 'ironcow'],
            ['b', 'Bob', { ...build(81), gameMode: 'legacy_ironcow' }, 'ironcow'],
        ]);
        await mountTab();
        el('top-k').value = '0';
        tab.start();
        await flush();
        await finishPass((_z, index) => sim(1000 + index, 100));
        const both = tab.sortedRows().find((r) => r.comp.members.length === 2);
        tab.root.querySelector(`[data-pf-load="${both.id}"]`).click();
        const [party] = host._editor.loadParty.mock.calls[0];
        // Ann's mode was on her entry alone; Bob's build already said his own
        expect(party.slice(1).map((p) => p.gameMode)).toEqual(['ironcow', 'legacy_ironcow']);
        // You are the live character, whose mode the live sync knows; nothing is stamped on you
        expect(party[0].gameMode).toBeUndefined();
    });

    test('a teammate taken to the editor and saved back as a new one keeps their mode', async () => {
        // Saved with the mode on the entry only: a copy of your own build, whose DTO does not say
        state.gameMode = 'ironcow';
        seedRoster([['a', 'Ann', build(80), 'ironcow']]);
        host._editor.players = [{ hrid: 'player1', name: 'Milkman', dto: build(90), self: true }];
        await mountTab();
        member('a')
            .querySelectorAll('button')
            .forEach((b) => b.textContent === 'Edit' && b.click());
        const [[imported]] = host._editor.importPlayers.mock.calls[0];
        expect(imported.gameMode).toBe('ironcow');

        // Edited there, then saved as a second teammate; later searched for from a market character
        host._editor.players.push({ hrid: 'player2', name: 'Ann', dto: { ...imported, magicLevel: 95 } });
        tab._renderAddFromEditor();
        el('editor-player').value = 'player2';
        el('editor-target').value = '';
        el('add-editor').click();
        await flush();
        expect(state.db.entries.map((e) => e.gameMode)).toEqual(['ironcow', 'ironcow']);
        state.gameMode = 'standard';
        tab._renderRoster();
        expect(planText()).toContain("No teammates of this character's mode");
    });
});
