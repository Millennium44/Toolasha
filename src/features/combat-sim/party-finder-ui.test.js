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
    /** The saved-parties record (its own key) */
    savedDb: undefined,
    savedGate: null,
    prefs: {},
    failWrite: false,
    calls: [],
    downloads: [],
    zones: [],
    selfDTO: null,
    gameData: null,
    imported: null,
    revenueTaxRates: [],
    priceSeeds: [],
    revenueCaches: [],
    owned: [],
    /** Replaces the template tuner's answer, when a test sets it */
    tune: null,
    progress: null,
    tuneCalls: [],
    tunerCleared: 0,
    /** The in-game party: all members, you included, in slot order */
    party: [],
    /** What buildAllPlayerDTOs answers */
    built: null,
    partyListeners: [],
    /** Character data not loaded yet */
    noCharacterData: false,
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
        getPartyMembers: () => ({ members: state.party, source: 'test' }),
        on: (event, cb) => state.partyListeners.push([event, cb]),
        off: (event, cb) => {
            state.partyListeners = state.partyListeners.filter(([e, c]) => !(e === event && c === cb));
        },
        get characterData() {
            if (state.noCharacterData) return null;
            return { character: { name: 'Milkman' }, characterAbilities: state.owned };
        },
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (k, _s, fallback) => {
            // A read in flight already holds the old value when a later write lands
            if (String(k).startsWith('combatSimPartyIncludeParty_') && state.includeGate) {
                const held = k in state.prefs ? state.prefs[k] : fallback;
                await state.includeGate;
                return held;
            }
            if (
                String(k).startsWith('combatSimPartyScoreWeight_') ||
                String(k).startsWith('combatSimPartyIncludeParty_')
            )
                return k in state.prefs ? state.prefs[k] : fallback;
            if (k === 'combatSimSavedParties' && state.savedGate) {
                const held = state.savedDb === undefined ? fallback : structuredClone(state.savedDb);
                await state.savedGate;
                return held;
            }
            if (k === 'toolasha_local_cappedSeen')
                return state.seenDb === undefined ? fallback : structuredClone(state.seenDb);
            if (k === 'combatSimSavedParties') {
                return state.savedDb === undefined ? fallback : structuredClone(state.savedDb);
            }
            return state.db === undefined ? fallback : structuredClone(state.db);
        },
        set: async (k, v) => {
            // One held write, for races: the next lock-in write waits until the test lets it through
            if (state.setGate && String(k).startsWith('combatSimPartyIncludeParty_')) {
                const gate = state.setGate;
                state.setGate = null;
                await gate;
            }
            state.prefs[k] = v;
        },
        update: async (k, mutate) => {
            if (state.failWrite) return null;
            const key = k === 'combatSimSavedParties' ? 'savedDb' : k === 'toolasha_local_cappedSeen' ? 'seenDb' : 'db';
            const next = mutate(state[key] === undefined ? undefined : structuredClone(state[key]));
            if (next === undefined) return { written: false, value: state[key] };
            state[key] = structuredClone(next);
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
    seedSimPriceCache: (cache, _gameData, options) => {
        state.priceSeeds.push({ cache, options });
        return cache;
    },
    buildAllPlayerDTOs: async () => {
        const built = state.built;
        if (state.builtGate) await state.builtGate;
        return built;
    },
    buildGameDataPayload: () => state.gameData,
    buildPlayerDTO: () => (state.selfDTO ? structuredClone(state.selfDTO) : null),
    getCombatZones: () => state.zones,
    getCommunityBuffs: () => ({}),
    getCurrentCombatZone: () => null,
    parseShykaiImport: () => state.imported,
    guildBuffsFromExportLevels: (levels) => ({
        guildShrineLevels: { resolved: levels },
        guildCombatBuffs: [{ from: 'shrine' }],
    }),
    calculateSimRevenue: (sim, _gameData, playerHrid, hours, options = {}) => {
        state.revenueTaxRates.push(options.saleTaxRate);
        state.revenueCaches.push(options.priceCache);
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
vi.mock('./party-template-tuner.js', () => ({
    clearTunerCache: () => {
        state.tunerCleared += 1;
    },
    tuneTemplate: async (template, levels, _deps, options) => {
        state.progress?.forEach((p) => options?.onProgress?.(p));
        state.tuneCalls.push({ id: template.id, levels });
        if (state.tune) return state.tune(template, levels);
        return {
            status: 'noScore',
            dto: structuredClone(template.playerDto),
            k: null,
            templateScore: null,
            ownScore: null,
        };
    },
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

const { default: webSocketHook } = await import('../../core/websocket.js');
const { PartyFinderTab, displayNames, unpricedMark } = await import('./party-finder-ui.js');
const { announceSyncPullApplied } = await import('../../utils/sync-merge-registry.js');
const { PARTY_TEMPLATES, templateTeammateName } = await import('./party-templates.js');

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
    state.tune = null;
    state.progress = null;
    state.charId = 'me';
    state.gameMode = undefined;
    state.db = undefined;
    state.savedDb = undefined;
    state.seenDb = undefined;
    state.savedGate = null;
    state.setGate = null;
    state.prefs = {};
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
    state.priceSeeds = [];
    state.revenueCaches = [];
    state.owned = [];
    state.party = [];
    state.built = null;
    state.partyListeners = [];
    state.noCharacterData = false;
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

    describe('a pull that dropped entries to the cap', () => {
        const full = (prefix, count = 40) =>
            Array.from({ length: count }, (_, i) => [`${prefix}${i}`, `${prefix.toUpperCase()}${i}`, build(80)]);

        test('says who, the first few and how many more', async () => {
            seedRoster(full('old'));
            await mountTab();
            seedRoster([...full('new', 37), ...full('old', 3)]);
            announceSyncPullApplied({ settings: ['combatSimPartyRoster'] });
            await flush();
            const note = el('roster-note').textContent;
            expect(note).toContain('kept the most recently changed');
            expect(note).toContain('40 teammates kept, OLD3, OLD4, OLD5, OLD6, OLD7 and 32 more dropped');
            expect(note).not.toContain('saved builds');
        });

        test('one or two names are named whole, and saved builds are told apart', async () => {
            const savedBuild = (id) => ({ id, name: id, dto: build(70), addedAt: 1, updatedAt: 1 });
            seedRoster(full('old'));
            state.db.builds = Array.from({ length: 40 }, (_, i) => savedBuild(`b${i}`));
            await mountTab();
            seedRoster(full('old', 40));
            state.db.builds = [...Array.from({ length: 39 }, (_, i) => savedBuild(`b${i}`)), savedBuild('newer')];
            announceSyncPullApplied({ settings: ['combatSimPartyRoster'] });
            await flush();
            expect(el('roster-note').textContent).toContain('40 saved builds kept, b39 dropped');
            expect(el('roster-note').textContent).not.toContain('teammates');
        });

        test('a deletion from another device is not called a drop', async () => {
            seedRoster(full('old'));
            await mountTab();
            seedRoster([...full('old', 39), ['newer', 'Newer', build(80)]]);
            state.db.removed = { old39: Date.now() };
            announceSyncPullApplied({ settings: ['combatSimPartyRoster'] });
            await flush();
            expect(el('roster-note').textContent).toBe('');
        });

        test('a list with room left dropped nothing to the cap', async () => {
            seedRoster(full('old', 5));
            await mountTab();
            seedRoster(full('old', 4));
            announceSyncPullApplied({ settings: ['combatSimPartyRoster'] });
            await flush();
            expect(el('roster-note').textContent).toBe('');
        });

        test('a replay of the pull says nothing more, and an ordinary read back says nothing', async () => {
            seedRoster(full('old'));
            await mountTab();
            expect(el('roster-note').textContent).toBe('');
            seedRoster(full('new'));
            announceSyncPullApplied({ settings: ['combatSimPartyRoster'] });
            await flush();
            expect(el('roster-note').textContent).toContain('dropped');
            tab._rosterNote('');
            announceSyncPullApplied({ settings: ['combatSimPartyRoster'] });
            await flush();
            expect(el('roster-note').textContent).toBe('');
        });

        test('the tab shut before the read comes back draws nothing', async () => {
            seedRoster(full('old'));
            await mountTab();
            seedRoster(full('new'));
            const reading = tab._reloadRoster({ pulled: true });
            tab.root = null;
            await reading;
            expect(tab._roster.entries[0].id).toBe('old0');
        });
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

    test('one frozen set of quotes values the quick pass and the re-run alike (#651 T01)', async () => {
        seedRoster([
            ['a', 'Ann', build(80)],
            ['b', 'Bob', build(100, '/items/blazing_trident')],
        ]);
        await mountTab();
        el('top-k').value = '1';
        tab.start();
        await flush();

        // Taken before the first simulation was even handed out, for the zone searched
        expect(state.priceSeeds).toHaveLength(1);
        expect(state.priceSeeds[0].cache).toBeInstanceOf(Map);
        expect(state.priceSeeds[0].options.zoneHrid).toBe(ZONE.hrid);
        expect(state.calls).toHaveLength(1);

        await finishPass((_zone, index) => [sim(1000, 100), sim(1200, 150), sim(800, 50), sim(1500, 90)][index]);
        await finishPass((_zone, index) => [sim(1000, 100, { hours: 10 }), sim(1400, 80, { hours: 10 })][index]);

        // Every row of both passes read the one cache, so a refresh between them cannot reorder the parties
        expect(state.revenueCaches.length).toBeGreaterThanOrEqual(6);
        expect(new Set(state.revenueCaches).size).toBe(1);
        expect(state.revenueCaches[0]).toBe(state.priceSeeds[0].cache);
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
            'You + Ann + Bob',
            'You + Ann',
            'You alone',
            'You + Bob',
        ]);
        expect(rows[0].textContent).toMatch(/10h/);
        expect(rows[0].textContent).toMatch(/\+40\.0%/);
        const bobDelta = rows[3].querySelectorAll('td')[6];
        expect(bobDelta.textContent).toBe('-20.0%');
        expect(bobDelta.getAttribute('style')).toMatch(/#f44336/);
        // Bob's loot had an unpriced drop
        expect(rows[3].querySelectorAll('td')[3].textContent).toMatch(/^≥/);
        // ...so his profit against solo is built on a zero too, and says so; Ann's is not
        const marker = rows[3].querySelectorAll('td')[7].querySelector('[data-pf-delta-unpriced]');
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
        expect(rows[0]).toMatchObject({ party: 'You + Ann', profitVsSolo: -50, xpVsSoloPct: 10 });
        expect(rows[1]).toMatchObject({ party: 'You alone', profitVsSolo: 0 });

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

    test('a ninth aura against a list another tab filled is refused out loud, and the editor redraws full', async () => {
        seedRoster([['a', 'Ann', build(80)]]);
        await mountTab();
        await openAuras('a');
        // Drawn with room for more; another tab fills the list before Add is pressed
        const eight = Array.from({ length: 8 }, (_, i) => ({ hrid: `/abilities/other_${i}`, level: 5 + i }));
        state.db.entries[0].auras = eight;
        state.db.entries[0].updatedAt = 2;
        tab.root.querySelector('[data-pf-aura-pick="a"]').value = '/abilities/mystic_aura';
        tab.root.querySelector('[data-pf-aura-level="a"]').value = '15';
        tab.root.querySelector('[data-pf-aura-add="a"]').click();
        await flush();
        expect(state.db.entries[0].auras).toEqual(eight);
        // An unchanged teammate is not stamped as a newer edit
        expect(state.db.entries[0].updatedAt).toBe(2);
        expect(el('roster-note').textContent).toBe('At most 8 aura options, so that one was not added.');
        expect(tab.root.querySelector('[data-pf-aura-add="a"]')).toBeNull();
    });

    test('with room left the same add says nothing', async () => {
        seedRoster([['a', 'Ann', build(80)]]);
        await mountTab();
        await openAuras('a');
        tab.root.querySelector('[data-pf-aura-pick="a"]').value = '/abilities/mystic_aura';
        tab.root.querySelector('[data-pf-aura-level="a"]').value = '15';
        tab.root.querySelector('[data-pf-aura-add="a"]').click();
        await flush();
        expect(el('roster-note').textContent).toBe('');
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

describe('score column', () => {
    const scoreCells = () =>
        [...tab.root.querySelectorAll('[data-pf-row]')].map((r) => r.querySelectorAll('td')[4].textContent);
    const run = async () => {
        seedRoster([['a', 'Ann', build(80)]]);
        await mountTab();
        el('top-k').value = '0';
        tab.start();
        await flush();
        await finishPass((_z, index) => [sim(1000, 100), sim(1100, 50)][index]);
    };

    test('is EXP/hr + weight x Profit/hr, sorts like the other columns and follows the weight', async () => {
        await run();
        const header = tab.root.querySelector('[data-pf-sort="score"]');
        expect(header.textContent).toContain('Score');
        expect(header.title).toContain('1 × Profit/hr');
        // Solo 1000 + 100, Ann 1100 + 50
        expect(tab.sortedRows().map((r) => r.comp.isBaseline)).toEqual([false, true]);
        header.click();
        expect(tab._sortKey).toBe('score');
        expect(scoreCells()).toEqual(['1.1K', '1.1K']);
        el('score-weight').value = '20';
        el('score-weight').dispatchEvent(new Event('change'));
        await flush();
        // Solo 1000 + 2000 = 3K now beats Ann 1100 + 1000 = 2.1K
        expect(tab.sortedRows().map((r) => r.comp.isBaseline)).toEqual([true, false]);
        expect(tab.root.querySelector('[data-pf-sort="score"]').title).toContain('1M profit = 20M XP');
    });

    test('the weight is saved for this character and restored, and a bad entry falls back to 1', async () => {
        await run();
        el('score-weight').value = '3';
        el('score-weight').dispatchEvent(new Event('change'));
        await flush();
        expect(state.prefs['combatSimPartyScoreWeight_me']).toBe(3);
        tab.detach();
        await mountTab();
        expect(el('score-weight').value).toBe('3');
        state.charId = 'other';
        tab.detach();
        await mountTab();
        expect(el('score-weight').value).toBe('1');
        el('score-weight').value = 'abc';
        el('score-weight').dispatchEvent(new Event('change'));
        await flush();
        expect(el('score-weight').value).toBe('1');
    });

    test('a party with unpriced drops marks its score as a floor, like its profit', async () => {
        seedRoster([['a', 'Ann', build(80)]]);
        await mountTab();
        el('top-k').value = '0';
        tab.start();
        await flush();
        await finishPass((_z, index) => [sim(1000, 100), sim(1100, 50, { unpriced: ['/items/x'] })][index]);
        expect(scoreCells().some((t) => t.startsWith('≥'))).toBe(true);
    });
});

describe('teammates of the other game mode', () => {
    const planText = () => el('plan').textContent;
    const member = (id) => tab.root.querySelector(`[data-pf-member="${id}"]`);

    test('a stored mode never leaves a teammate out: a market character keeps its Iron Cow teammate', async () => {
        state.gameMode = 'standard';
        seedRoster([
            ['a', 'Ann', build(80), 'standard'],
            ['b', 'Bob', build(81), 'ironcow'],
            ['c', 'Cy', build(82)],
        ]);
        await mountTab();
        expect(member('b').textContent).not.toMatch(/can't party|game mode unknown/);
        expect(member('c').textContent).not.toMatch(/can't party|game mode unknown/);
        expect(member('b').querySelector('[data-pf-choice]').disabled).toBe(false);
        expect(member('b').hasAttribute('data-pf-excluded')).toBe(false);
        expect(planText()).not.toMatch(/other game mode|game mode unknown/);
        const withBob = Number(/^(\d+) quick sim/.exec(planText())[1]);
        // The same plan with the live mode unknown, or the other one: nobody is filtered either way
        state.gameMode = undefined;
        tab._renderRoster();
        expect(Number(/^(\d+) quick sim/.exec(planText())[1])).toBe(withBob);
        state.gameMode = 'legacy_ironcow';
        tab._renderRoster();
        expect(Number(/^(\d+) quick sim/.exec(planText())[1])).toBe(withBob);
    });

    test('when every stored teammate is of the other mode, the search still runs with them', async () => {
        state.gameMode = 'standard';
        seedRoster([
            ['a', 'Ann', build(80), 'ironcow'],
            ['b', 'Bob', build(81), 'ironcow'],
        ]);
        await mountTab();
        expect(planText()).not.toContain("No teammates of this character's mode");
        tab.start();
        await flush();
        expect(lastStatus()).not.toContain("No teammates of this character's mode");
        expect(tab._running).toBe(true);
    });

    test("planned teammates take the live character's mode, whatever they were saved with", async () => {
        state.gameMode = 'ironcow';
        seedRoster([['a', 'Ann', build(80), 'standard']]);
        await mountTab();
        expect(tab._planRoster(null).roster[0].dto.gameMode).toBe('ironcow');
        state.gameMode = undefined;
        expect(tab._planRoster(null).roster[0].dto).not.toHaveProperty('gameMode');
    });

    test('copying your own build saves the live mode with it', async () => {
        state.gameMode = 'ironcow';
        await mountTab();
        await tab._onCopySelf();
        expect(tab._roster.entries[0].gameMode).toBe('ironcow');
    });

    test("a party loaded into the editor carries the live character's mode on each teammate", async () => {
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
        // Ann's stored mode and Bob's own build mode are both ignored: everyone is the live character's
        expect(party.slice(1).map((p) => p.gameMode)).toEqual(['ironcow', 'ironcow']);
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
        // Stored modes stay on the entries, but a market character still searches with both
        state.gameMode = 'standard';
        tab._renderRoster();
        expect(planText()).not.toContain('other game mode');
    });
});

describe('also try my auras', () => {
    const auraDetail = (name) => ({
        name,
        isSpecialAbility: true,
        abilityEffects: [{ effectType: '/ability_effect_types/buff', targetType: 'allAllies', buffs: [{}] }],
    });
    beforeEach(() => {
        state.gameData.abilityDetailMap['/abilities/fierce_aura'] = auraDetail('Fierce Aura');
        state.gameData.abilityDetailMap['/abilities/mystic_aura'] = auraDetail('Mystic Aura');
        state.gameData.levelExperienceTable = Array.from({ length: 201 }, (_, i) => i);
        // Learned abilities: two auras and an ordinary ability, which is never offered
        state.owned = [
            { abilityHrid: '/abilities/fierce_aura', level: 20 },
            { abilityHrid: '/abilities/mystic_aura', level: 7 },
            { abilityHrid: '/abilities/water_strike', level: 40 },
        ];
    });

    const tick = async () => {
        el('self-auras').checked = true;
        el('self-auras').dispatchEvent(new Event('change'));
        await flush();
    };

    test('off by default: the plan is the plain one', async () => {
        seedRoster([['a', 'Ann', build(80)]]);
        await mountTab();
        expect(el('self-auras').checked).toBe(false);
        expect(el('plan').textContent).toMatch(/^2 quick sims/);
        expect(el('plan').textContent).not.toMatch(/aura variant/);
    });

    test('on: you are tried with each aura you own, alone and with Ann; the baseline is you as worn', async () => {
        seedRoster([['a', 'Ann', build(80)]]);
        await mountTab();
        await tick();
        expect(el('self-aura-info').textContent).toBe('2 auras you own');
        // Solo + Ann, each as worn and with 2 auras
        expect(el('plan').textContent).toMatch(/^6 quick sims/);
        expect(el('plan').textContent).toMatch(/2 aura variants of you/);
        el('top-k').value = '0';
        tab.start();
        await flush();
        const zones = state.calls[0].params.zones;
        expect(zones).toHaveLength(6);
        expect(zones.map((z) => z.playerDTOs[0].abilities[0]?.hrid ?? null)).toEqual([
            null,
            '/abilities/fierce_aura',
            '/abilities/mystic_aura',
            null,
            '/abilities/fierce_aura',
            '/abilities/mystic_aura',
        ]);
        expect(zones[1].playerDTOs).toHaveLength(1);
        expect(zones[5].playerDTOs[0].abilities[0]).toMatchObject({ hrid: '/abilities/mystic_aura', level: 7 });
        // Ann is never touched by your aura
        expect(zones[5].playerDTOs[1].abilities[0]).toBeNull();
        await finishPass((_z, index) => sim(1000 + index * 100, 100));
        const rows = tab.sortedRows();
        // Row ids carry your aura, so no two rows share one
        expect(new Set(rows.map((r) => r.id)).size).toBe(6);
        expect(rows.filter((r) => r.isBaseline)).toHaveLength(1);
        const text = rows.map((r) => rowText(r.id));
        expect(text.some((t) => /You alone \(you: Fierce Aura 20\)/.test(t))).toBe(true);
        expect(text.some((t) => /You \+ Ann \(you: Mystic Aura 7\)/.test(t))).toBe(true);
        // A solo row with an aura is compared with the as-worn baseline
        const soloAura = rows.find((r) => r.comp.selfAura && !r.comp.members.length);
        expect(rowText(soloAura.id)).toMatch(/%/);
        // Load puts your aura in the editor's copy of you
        tab.root.querySelector(`[data-pf-load="${soloAura.id}"]`).click();
        expect(host._editor.loadParty.mock.calls[0][0][0].abilities[0].hrid).toBe(soloAura.comp.selfAura.hrid);
    });

    test('with no teammates at all, your own auras still run alone; with the switch off it asks for teammates', async () => {
        seedRoster([]);
        await mountTab();
        expect(el('plan').textContent).toMatch(/Add teammates to the roster first/);
        await tick();
        // As worn plus 2 aura solos
        expect(el('plan').textContent).toMatch(/^3 quick sims/);
        el('top-k').value = '0';
        tab.start();
        await flush();
        expect(lastStatus()).not.toBe('Add teammates to the roster first.');
        expect(state.calls[0].params.zones).toHaveLength(3);
    });

    test('the confirm count includes your auras', async () => {
        seedRoster(Array.from({ length: 6 }, (_, i) => [`m${i}`, `M${i}`, build(60 + i)]));
        await mountTab();
        await tick();
        tab.start();
        await flush();
        // 6 teammates, cap 3 -> 1 + 6 + 15 = 22 compositions, each of 3 variants of you
        expect(el('confirm').textContent).toMatch(/66 quick/);
    });

    test('a player loaded in the editor, not the live character: pick the auras by hand', async () => {
        state.owned = [];
        host._editor.players = [
            { hrid: 'player1', name: 'Milkman', dto: build(90), self: true },
            { hrid: 'player2', name: 'Venaam', dto: build(110) },
        ];
        seedRoster([['a', 'Ann', build(80)]]);
        await mountTab();
        el('self').value = 'editor:player2';
        el('self').dispatchEvent(new Event('change'));
        await tick();
        expect(el('self-aura-info').textContent).toMatch(/unknown/);
        expect(el('self-aura-edit').textContent).toBe('You — Auras');
        expect(el('plan').textContent).toMatch(/no aura of yours to try/);

        el('self-aura-edit').click();
        const select = tab.root.querySelector('[data-pf-aura-pick="self"]');
        select.value = '/abilities/fierce_aura';
        tab.root.querySelector('[data-pf-aura-level="self"]').value = '25';
        tab.root.querySelector('[data-pf-aura-add="self"]').click();
        await flush();
        expect(el('self-aura-edit').textContent).toBe('You — Auras (1) Close');
        expect(el('plan').textContent).toMatch(/^4 quick sims/);
        expect(tab.root.querySelector('[data-pf-as-built="self"]')).toBeNull();

        el('top-k').value = '0';
        tab.start();
        await flush();
        const zones = state.calls[0].params.zones;
        expect(zones[1].playerDTOs[0].abilities[0]).toMatchObject({ hrid: '/abilities/fierce_aura', level: 25 });
        // Venaam's own build is the as-worn row
        expect(zones[0].playerDTOs[0].magicLevel).toBe(110);
        // Picks belong to that player; switching to the live character brings the owned list back
        el('self').value = 'live';
        el('self').dispatchEvent(new Event('change'));
        await flush();
        expect(el('self-aura-info').textContent).toBe('no auras learned yet');
    });

    test('an aura you already wear at that level is not tried twice', async () => {
        state.selfDTO.abilities[0] = { hrid: '/abilities/fierce_aura', level: 20, triggers: null };
        seedRoster([['a', 'Ann', build(80)]]);
        await mountTab();
        await tick();
        // Mystic only: Solo + Ann, as worn and with Mystic
        expect(el('plan').textContent).toMatch(/^4 quick sims/);
    });
});

describe('saved builds', () => {
    const buildRows = () => [...tab.root.querySelectorAll('[data-pf-build]')];
    const buildNames = () => buildRows().map((r) => r.querySelector('[data-pf-build-name]').textContent);
    const rowButton = (id, label) =>
        [...tab.root.querySelectorAll(`[data-pf-build="${id}"] button`)].find((b) => b.textContent === label);

    const saveAs = async (source, name) => {
        el('save-build-open').click();
        el('build-source').value = source;
        el('build-source').dispatchEvent(new Event('change'));
        if (name != null) {
            el('build-name').value = name;
            el('build-name').dispatchEvent(new Event('input'));
        }
        el('save-build').click();
        await flush();
    };

    test('save my current build; the name defaults to the character, and the form closes', async () => {
        await mountTab();
        expect(buildNames()).toEqual([]);
        el('save-build-open').click();
        expect(el('save-build-form').style.display).toBe('flex');
        expect(el('build-name').value).toBe('Milkman');
        el('save-build').click();
        await flush();
        expect(state.db.builds.map((b) => b.name)).toEqual(['Milkman']);
        expect(state.db.builds[0].dto.magicLevel).toBe(90);
        expect(buildNames()).toEqual(['Milkman']);
        expect(el('build-count').textContent).toBe('(1/40)');
        expect(el('save-build-form').style.display).toBe('none');
        expect(el('build-note').textContent).toBe('Saved "Milkman".');
        // A teammate is not made by saving
        expect(state.db.entries).toEqual([]);
    });

    test('save any editor player, with the mode their build carries', async () => {
        host._editor.players = [
            { hrid: 'player1', name: 'Milkman', dto: build(90), self: true },
            { hrid: 'player2', name: 'Venaam', dto: { ...build(110), gameMode: 'ironcow' } },
        ];
        await mountTab();
        await saveAs('editor:player2', null);
        expect(state.db.builds).toHaveLength(1);
        expect(state.db.builds[0]).toMatchObject({ name: 'Venaam', gameMode: 'ironcow' });
        expect(state.db.builds[0].dto.magicLevel).toBe(110);
    });

    test('duplicate names get (2), (3) and the note says the name was taken', async () => {
        await mountTab();
        await saveAs('live', 'Tank');
        await saveAs('live', 'Tank');
        expect(el('build-note').textContent).toBe('Saved as "Tank (2)" (that name was taken).');
        await saveAs('live', 'Tank');
        expect(buildNames()).toEqual(['Tank', 'Tank (2)', 'Tank (3)']);
    });

    test('a failed write says so and saves nothing', async () => {
        await mountTab();
        state.failWrite = true;
        await saveAs('live', 'Tank');
        expect(el('build-note').textContent).toMatch(/could not be written/);
        expect(buildNames()).toEqual([]);
        expect(state.db).toBeUndefined();
    });

    test('add as teammate creates a roster teammate from the build, who can be tried, auras and all', async () => {
        await mountTab();
        await saveAs('live', 'Tank');
        const id = state.db.builds[0].id;
        rowButton(id, 'Add as teammate').click();
        await flush();
        expect(state.db.entries).toHaveLength(1);
        expect(state.db.entries[0]).toMatchObject({ name: 'Tank', source: 'saved build', includeAsBuilt: true });
        expect(tab.root.querySelectorAll('[data-pf-member]')).toHaveLength(1);
        // Try/Always/Never and Auras are there, and the build stays saved
        const member = tab.root.querySelector('[data-pf-member]');
        expect(member.querySelector('[data-pf-choice]')).not.toBeNull();
        expect([...member.querySelectorAll('button')].some((b) => b.textContent.startsWith('Auras'))).toBe(true);
        expect(buildNames()).toEqual(['Tank']);
        // Again: a second teammate from the same build
        rowButton(id, 'Add as teammate').click();
        await flush();
        expect(state.db.entries).toHaveLength(2);
    });

    describe('templates', () => {
        const toggle = () => tab.root.querySelector('[data-pf-templates-toggle]');
        const tplRow = (id) => tab.root.querySelector(`[data-pf-template="${id}"]`);
        const tplAdd = (id) =>
            [...tplRow(id).querySelectorAll('button')].find((b) => b.textContent === 'Add as teammate');

        test('the group sits above the saved builds and starts collapsed', async () => {
            await mountTab();
            expect(toggle()).not.toBeNull();
            expect(tab.root.querySelector('[data-pf-templates-body]')).toBeNull();
            expect(tab.root.querySelectorAll('[data-pf-template]')).toHaveLength(0);
            const templates = el('templates');
            const builds = el('builds');
            // DOCUMENT_POSITION_FOLLOWING: builds comes after templates
            expect(templates.compareDocumentPosition(builds) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        });

        test('opening lists every template by role, with no source text anywhere', async () => {
            await mountTab();
            toggle().click();
            expect(tab.root.querySelectorAll('[data-pf-template]')).toHaveLength(PARTY_TEMPLATES.length);
            const body = tab.root.querySelector('[data-pf-templates-body]').textContent;
            for (const label of ['Ranger', 'Nature', 'Fire', 'Water', 'Tank', 'Melee']) expect(body).toContain(label);
            const t = PARTY_TEMPLATES[0];
            expect(tplRow(t.id).querySelector('span').title).toBe('');
            expect(tplRow(t.id).innerHTML).not.toMatch(/anonymi|live.server|export/i);
            // No rename or delete on a template
            const labels = [...tplRow(t.id).querySelectorAll('button')].map((b) => b.textContent);
            expect(labels).toEqual(['Add as teammate']);
            toggle().click();
            expect(tab.root.querySelectorAll('[data-pf-template]')).toHaveLength(0);
        });

        test('add as teammate makes an ordinary roster entry, twice with distinct names, and no saved build', async () => {
            await mountTab();
            toggle().click();
            const t = PARTY_TEMPLATES[1];
            tplAdd(t.id).click();
            await flush();
            tplAdd(t.id).click();
            await flush();
            expect(state.db.entries).toHaveLength(2);
            expect(state.db.entries[0]).toMatchObject({
                name: templateTeammateName(t),
                source: 'template',
                includeAsBuilt: true,
            });
            expect(state.db.entries[0].gameMode).toBeNull();
            const rows = [...tab.root.querySelectorAll('[data-pf-member]')];
            expect(rows).toHaveLength(2);
            const names = rows.map((r) => r.querySelector('[data-pf-name]').textContent);
            expect(new Set(names).size).toBe(2);
            expect(rows[0].querySelector('[data-pf-choice]')).not.toBeNull();
            expect([...rows[0].querySelectorAll('button')].some((b) => b.textContent.startsWith('Auras'))).toBe(true);
            // Templates never reach the record's builds
            expect(state.db.builds).toEqual([]);
            // Templates stay open and untouched
            expect(tab.root.querySelectorAll('[data-pf-template]')).toHaveLength(PARTY_TEMPLATES.length);
        });
    });

    describe('Match my build', () => {
        const toggle = () => tab.root.querySelector('[data-pf-templates-toggle]');
        const matchBox = () => tab.root.querySelector('[data-pf-match-build]');
        const add = (id) =>
            [...tab.root.querySelector('[data-pf-template="' + id + '"]').querySelectorAll('button')]
                .find((b) => b.textContent === 'Add as teammate')
                .click();
        const tuned = (template, extra = {}) => {
            const dto = structuredClone(template.playerDto);
            dto.meleeLevel = 136;
            dto.equipment['/equipment_types/main_hand'].enhancementLevel = 9;
            return { status: 'ok', dto, k: -3, templateScore: 1234, ownScore: 1250, ...extra };
        };
        const t = () => PARTY_TEMPLATES.find((x) => x.id === 'melee-smash');

        beforeEach(() => {
            state.tune = null;
            state.tuneCalls = [];
            state.selfDTO = { meleeLevel: 136, staminaLevel: 125 };
        });

        test('is on by default with the rule in its tooltip, and the toggle persists across redraws of the list', async () => {
            await mountTab();
            expect(matchBox().checked).toBe(true);
            expect(matchBox().parentElement.title).toMatch(/highest of melee, ranged, magic and defense/);
            matchBox().click();
            expect(matchBox().checked).toBe(false);
            toggle().click();
            expect(matchBox().checked).toBe(false);
        });

        test('a pricing change forgets every solved offset', async () => {
            await mountTab();
            state.tunerCleared = 0;
            tab.onPricingChanged();
            expect(state.tunerCleared).toBe(1);
        });

        test('adding tunes the template to the character and shows its score against theirs', async () => {
            await mountTab();
            state.tune = async (template) => tuned(template);
            toggle().click();
            add(t().id);
            await flush();
            expect(state.tuneCalls[0].levels.meleeLevel).toBe(136);
            const dto = state.db.entries[0].dto;
            expect(dto.meleeLevel).toBe(136);
            expect(dto.equipment['/equipment_types/main_hand'].enhancementLevel).toBe(9);
            expect(dto.guildShrineLevels).toBeDefined();
            const line = tab.root.querySelector('[data-pf-template-score]');
            expect(line.textContent).toBe('score 1.23B ≈ yours 1.25B');
            expect(el('roster-note').textContent).toContain('score 1.23B ≈ yours 1.25B');
        });

        test('switched off, the standard template is added and nothing is scored', async () => {
            await mountTab();
            toggle().click();
            matchBox().click();
            add(t().id);
            await flush();
            expect(state.tuneCalls).toEqual([]);
            expect(state.db.entries[0].dto.equipment).toEqual(t().playerDto.equipment);
            expect(tab.root.querySelector('[data-pf-template-score]')).toBeNull();
        });

        test('no score loaded, or no character build: the standard template and a note that says so', async () => {
            await mountTab();
            toggle().click();
            add(t().id);
            await flush();
            expect(el('roster-note').textContent).toMatch(/build score is not loaded yet/);
            expect(tab.root.querySelector('[data-pf-template-score]').textContent).toMatch(/standard template/);
            state.selfDTO = null;
            state.tuneCalls = [];
            add(t().id);
            await flush();
            expect(state.tuneCalls).toEqual([]);
            expect(state.db.entries).toHaveLength(2);
        });

        test('an aborted match (prices moved twice, a character switch) does not claim only the character changed', async () => {
            await mountTab();
            toggle().click();
            state.tune = async (template) => tuned(template, { status: 'aborted', k: null });
            add(t().id);
            await flush();
            const text = tab.root.querySelector('[data-pf-template-score]').textContent;
            expect(text).toMatch(/prices/);
            expect(text).toMatch(/standard template/);
        });

        test('a build the template cannot reach says which way it is clamped', async () => {
            await mountTab();
            toggle().click();
            state.tune = async (template) =>
                tuned(template, { status: 'clampedLow', templateScore: 2000, ownScore: 500 });
            add(t().id);
            await flush();
            expect(tab.root.querySelector('[data-pf-template-score]').textContent).toMatch(
                /lowest setting scores above/
            );
            state.tune = async (template) =>
                tuned(template, { status: 'clampedHigh', templateScore: 200, ownScore: 5000 });
            add(t().id);
            await flush();
            expect(tab.root.querySelector('[data-pf-template-score]').textContent).toMatch(
                /highest setting scores below/
            );
        });

        test('a match through unpriced gear says it is approximate', async () => {
            await mountTab();
            toggle().click();
            state.tune = async (template) => tuned(template, { status: 'partial' });
            add(t().id);
            await flush();
            expect(tab.root.querySelector('[data-pf-template-score]').textContent).toBe(
                'score 1.23B ≈ yours 1.25B. Some gear is unpriced, so the match is approximate.'
            );
            expect(tab.root.querySelector('[data-pf-template-score]').style.color).not.toBe('');
        });

        test('scores print compactly in coins, not as thousands of separated millions', async () => {
            await mountTab();
            toggle().click();
            state.tune = async (template) => tuned(template, { templateScore: 7344662, ownScore: 1054569399 });
            add(t().id);
            await flush();
            const text = tab.root.querySelector('[data-pf-template-score]').textContent;
            expect(text).toBe('score 7.34T ≈ yours 1.05Q');
            expect(text).not.toMatch(/\d,\d{3}M/);
        });

        test('a clamp through unpriced gear reports both the clamp and the approximation', async () => {
            await mountTab();
            toggle().click();
            const both = (clamp, extra) => async (template) =>
                tuned(template, { status: 'partial', clamp, templateScore: 7344662, ownScore: 1054569399, ...extra });
            state.tune = both('clampedHigh');
            add(t().id);
            await flush();
            const lines = () => [...tab.root.querySelectorAll('[data-pf-template-score]')].map((l) => l.textContent);
            expect(lines()[0]).toBe(
                'score 7.34T ≈ yours 1.05Q. Even the highest setting scores below your build, so the template is ' +
                    'weaker than you. Some gear is unpriced, so the match is approximate.'
            );
            state.tune = both('clampedLow');
            add(t().id);
            await flush();
            const text = lines()[0];
            expect(text).toContain('Even the lowest setting scores above your build');
            expect(text).toContain('Some gear is unpriced, so the match is approximate.');
        });

        test('a match that finishes after the tab was closed and reopened adds nothing and cannot unlock the new match', async () => {
            await mountTab();
            toggle().click();
            const gate = [];
            state.tune = (template) => new Promise((resolve) => gate.push(() => resolve(tuned(template))));
            add(t().id);
            await flush();
            expect(tab._tuning).toBe(true);
            tab.detach();
            tab.mount(container);
            await flush();
            tab.onShow();
            if (!tab.root.querySelector('[data-pf-templates-body]')) toggle().click();
            add(t().id);
            await flush();
            expect(tab._tuning).toBe(true);
            // The first request finishes now: it is dropped, and the second still owns the flag
            gate[0]();
            await flush();
            expect(state.db?.entries ?? []).toHaveLength(0);
            expect(tab._tuning).toBe(true);
            gate[1]();
            await flush();
            expect(tab._tuning).toBe(false);
            expect(state.db.entries).toHaveLength(1);
        });

        test('the note shows the wait for the build score, then the probe count', async () => {
            await mountTab();
            toggle().click();
            const note = el('roster-note');
            let finish;
            state.tune = (template) => new Promise((resolve) => (finish = () => resolve(tuned(template))));
            state.progress = [{ phase: 'score', done: 0, max: 10 }];
            add(t().id);
            await flush();
            expect(note.textContent).toBe('Waiting for your build score…');
            finish();
            await flush();
            state.progress = [{ phase: 'solve', done: 3, max: 10 }];
            add(t().id);
            await flush();
            expect(note.textContent).toBe('Matching the template to your build… 3/10');
            finish();
            await flush();
        });

        test('turned off while matching, the standard template is added', async () => {
            await mountTab();
            toggle().click();
            let finish;
            state.tune = (template) => new Promise((resolve) => (finish = () => resolve(tuned(template))));
            add(t().id);
            await flush();
            matchBox().click();
            finish();
            await flush();
            expect(state.db.entries[0].dto.equipment).toEqual(t().playerDto.equipment);
            expect(tab.root.querySelector('[data-pf-template-score]')).toBeNull();
        });

        test('a character switch while matching adds nothing and leaves no score line for the new character', async () => {
            await mountTab();
            toggle().click();
            state.tune = async (template) => {
                state.charId = 'someone-else';
                return tuned(template);
            };
            add(t().id);
            await flush();
            expect(state.db?.entries ?? []).toHaveLength(0);
            expect(tab.root.querySelector('[data-pf-template-score]')).toBeNull();
            state.charId = 'me';
        });
    });

    test('adding a template resolves its guild shrine levels onto the teammate, and leaves the template alone', async () => {
        await mountTab();
        const toggle = tab.root.querySelector('[data-pf-templates-toggle]');
        toggle.click();
        const t = PARTY_TEMPLATES.find((x) => x.id === 'tank-bulwark');
        [...tab.root.querySelector('[data-pf-template="' + t.id + '"]').querySelectorAll('button')]
            .find((b) => b.textContent === 'Add as teammate')
            .click();
        await flush();
        expect(state.db.entries[0].dto.guildShrineLevels).toEqual({ resolved: t.guildCombatBuffLevels });
        expect(state.db.entries[0].dto.guildCombatBuffs).toEqual([{ from: 'shrine' }]);
        expect(t.playerDto.guildShrineLevels).toBeUndefined();
    });

    test('rename keeps names unique; delete takes two clicks and survives a re-read', async () => {
        await mountTab();
        await saveAs('live', 'Tank');
        await saveAs('live', 'Healer');
        const [tank, healer] = state.db.builds.map((b) => b.id);
        rowButton(healer, 'Rename').click();
        const input = tab.root.querySelector(`[data-pf-build="${healer}"] input`);
        input.value = 'Tank';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        await flush();
        expect(buildNames()).toEqual(['Tank', 'Tank (2)']);

        rowButton(tank, '×').click();
        expect(buildNames()).toHaveLength(2);
        rowButton(tank, 'Delete?').click();
        await flush();
        expect(buildNames()).toEqual(['Tank (2)']);
        expect(state.db.builds.map((b) => b.id)).toEqual([healer]);
        expect(state.db.removed[tank]).toBeGreaterThan(0);

        // The list persists: a fresh tab reads it back
        tab.detach();
        await mountTab();
        expect(buildNames()).toEqual(['Tank (2)']);
    });

    test('a pull that writes the roster brings in builds saved elsewhere', async () => {
        await mountTab();
        state.db = {
            savedAt: 5,
            entries: [],
            builds: [{ id: 'sb-x', name: 'From phone', dto: build(70), addedAt: 1, updatedAt: 1 }],
        };
        announceSyncPullApplied({ settings: ['combatSimPartyRoster'] });
        await flush();
        expect(buildNames()).toEqual(['From phone']);
    });

    test('by-hand picks belong to the build: another build in the same editor slot starts with none', async () => {
        for (const [hrid, name] of [
            ['/abilities/fierce_aura', 'Fierce Aura'],
            ['/abilities/mystic_aura', 'Mystic Aura'],
        ]) {
            state.gameData.abilityDetailMap[hrid] = {
                name,
                isSpecialAbility: true,
                abilityEffects: [{ effectType: '/ability_effect_types/buff', targetType: 'allAllies', buffs: [{}] }],
            };
        }
        state.gameData.levelExperienceTable = Array.from({ length: 201 }, (_, i) => i);
        state.owned = [];
        host._editor.players = [
            { hrid: 'player1', name: 'Milkman', dto: build(90), self: true },
            { hrid: 'player2', name: 'Venaam', dto: build(110) },
        ];
        seedRoster([['a', 'Ann', build(80)]]);
        await mountTab();
        el('self').value = 'editor:player2';
        el('self').dispatchEvent(new Event('change'));
        el('self-auras').checked = true;
        el('self-auras').dispatchEvent(new Event('change'));
        await flush();
        el('self-aura-edit').click();
        tab.root.querySelector('[data-pf-aura-pick="self"]').value = '/abilities/fierce_aura';
        tab.root.querySelector('[data-pf-aura-add="self"]').click();
        await flush();
        expect(el('self-aura-edit').textContent).toBe('You — Auras (1) Close');
        // Someone else is loaded into the same slot
        host._editor.players[1].dto = build(130);
        tab._renderSelfAuras();
        expect(el('self-aura-edit').textContent).toMatch(/^You — Auras$/);
        tab._renderPlan();
        expect(el('plan').textContent).not.toMatch(/Trying 1 aura/);
        // The first build back: its pick returns
        host._editor.players[1].dto = build(110);
        tab._renderSelfAuras();
        expect(el('self-aura-edit').textContent).toMatch(/\(1\)/);
    });

    test('with no usable teammates the aura solo rows run, and a refused plan says refused', async () => {
        for (const [hrid, name] of [
            ['/abilities/fierce_aura', 'Fierce Aura'],
            ['/abilities/mystic_aura', 'Mystic Aura'],
        ]) {
            state.gameData.abilityDetailMap[hrid] = {
                name,
                isSpecialAbility: true,
                abilityEffects: [{ effectType: '/ability_effect_types/buff', targetType: 'allAllies', buffs: [{}] }],
            };
        }
        state.gameData.levelExperienceTable = Array.from({ length: 201 }, (_, i) => i);
        state.owned = [
            { abilityHrid: '/abilities/fierce_aura', level: 20 },
            { abilityHrid: '/abilities/mystic_aura', level: 7 },
        ];
        seedRoster([]);
        state.gameMode = 'standard';
        await mountTab();
        el('self-auras').checked = true;
        el('self-auras').dispatchEvent(new Event('change'));
        await flush();
        expect(el('plan').textContent).toMatch(/^3 quick sims/);
        expect(el('plan').textContent).toMatch(/2 aura variants/);

        seedRoster(Array.from({ length: 12 }, (_, i) => [`m${i}`, `M${i}`, build(60 + i)]));
        state.owned = Array.from({ length: 200 }, (_, i) => ({ abilityHrid: '/abilities/fierce_aura', level: i + 1 }));
        state.owned.push(
            ...Array.from({ length: 200 }, (_, i) => ({ abilityHrid: '/abilities/mystic_aura', level: i + 1 }))
        );
        await tab._reloadRoster();
        const text = el('plan').textContent;
        expect(text).toMatch(/over the/);
        expect(text).not.toMatch(/no aura of yours/);
    });
});

describe('the mark on a profit built from unpriced items (#651 T02)', () => {
    test('a drop left out makes the figure a floor, an expense left out a ceiling, both neither', () => {
        expect(unpricedMark({ unpriced: [] })).toBe('');
        expect(unpricedMark(undefined)).toBe('');
        expect(unpricedMark({ unpriced: ['Gem'], unpricedCost: [] })).toContain('\u2265');
        expect(unpricedMark({ unpriced: ['Gem'], unpricedCost: [] })).toContain('lower bound');
        expect(unpricedMark({ unpriced: ['Coffee'], unpricedCost: ['Coffee'] })).toContain('\u2264');
        expect(unpricedMark({ unpriced: ['Coffee'], unpricedCost: ['Coffee'] })).toContain('upper bound');
        const both = unpricedMark({ unpriced: ['Gem', 'Coffee'], unpricedCost: ['Coffee'] });
        expect(both).toContain('>?<');
        expect(both).toContain('Gem, Coffee');
        // A row read before the cost list existed keeps the floor it always showed
        expect(unpricedMark({ unpriced: ['Gem'] })).toContain('\u2265');
    });
});

describe('roster buttons on a touch screen', () => {
    test('a coarse-pointer sheet sizes the row buttons and wraps the row; the inline look is untouched', async () => {
        seedRoster([['a', 'Ann', build(80)]]);
        await mountTab();
        const sheet = tab.root.querySelector('style');
        expect(sheet.textContent).toContain('@media (pointer: coarse)');
        expect(sheet.textContent).toMatch(/\[data-pf-member\] button,[^}]*min-height: 32px/);
        expect(sheet.textContent).toMatch(/\[data-pf-member\],[^}]*flex-wrap: wrap/);
        expect(sheet.textContent).toMatch(/\[data-pf-name\],[^}]*flex: 1 1 8em !important/);
        // Desktop: the buttons carry no height of their own, so nothing changes without the media query
        const buttons = [...tab.root.querySelectorAll('[data-pf-member="a"] button')];
        expect(buttons.map((b) => b.textContent)).toEqual(['Auras', 'Edit', 'Rename', '×']);
        for (const b of buttons) expect(b.style.minHeight).toBe('');
        expect(tab.root.querySelector('[data-pf-member="a"]').style.flexWrap).toBe('');
    });

    test('the sheet goes with the tab', async () => {
        await mountTab();
        const root = tab.root;
        tab.detach();
        expect(root.isConnected).toBe(false);
        expect(container.querySelector('style')).toBeNull();
    });
});

/**
 * Put you (slot 1) and others in a party. `others` are `[id, name, dto|null]`; a null build is a member whose profile
 * is not loaded.
 */
function setParty(others) {
    state.party = [
        { characterID: 'me', characterName: 'Milkman' },
        ...others.map(([id, name]) => ({ characterID: id, characterName: name })),
    ];
    const players = [{ ...build(90), hrid: 'player1' }];
    const playerInfo = [{ hrid: 'player1', name: 'Milkman' }];
    const missingMemberIds = [];
    others.forEach(([id, name, dto], index) => {
        if (dto) {
            players.push({ ...dto, hrid: `player${index + 2}` });
            playerInfo.push({ hrid: `player${index + 2}`, name });
        } else missingMemberIds.push(id);
    });
    state.built = { players, playerInfo, selfHrid: 'player1', missingMemberIds };
}

const partyRows = () => [...tab.root.querySelectorAll('[data-pf-party-member]')];
const partyChoice = (id) => tab.root.querySelector(`[data-pf-party-choice="${id}"]`);
const firstPassSizes = () => state.calls[0].params.zones.map((z) => z.playerDTOs.length);
const labelOfRow = (row) =>
    resultRows()
        .find((r) => r.dataset.pfRow === row.id)
        ?.querySelector('td:nth-child(2) span')?.textContent;
const pick = (id, value) => {
    partyChoice(id).value = value;
    partyChoice(id).dispatchEvent(new Event('change'));
};
const fireRosterEvent = () => {
    for (const [event, cb] of state.partyListeners) if (event === 'party_roster_updated') cb();
};

describe('include my party', () => {
    async function run() {
        el('top-k').value = '0';
        tab.start();
        await flush();
    }

    test('on by default: a party member shows as Always and is in every party tried', async () => {
        setParty([['c1', 'Captain', build(100)]]);
        await mountTab();
        expect(el('lock-party').value).toBe('my');
        expect(partyRows().map((r) => r.firstChild.textContent)).toEqual(['Captain (in party)']);
        expect(partyChoice('party:c1').value).toBe('always');
        await run();
        // You alone, then You + Captain: no party without Captain, bar the baseline
        expect(firstPassSizes()).toEqual([1, 2]);
        expect(state.calls[0].params.zones[1].playerDTOs[1].magicLevel).toBe(100);
        await finishPass((_z, index) => sim(1000 + index * 100, 100));
        expect(tab.sortedRows().map(labelOfRow).sort()).toEqual(['You + Captain', 'You alone']);
    });

    test('the party rows never reach the saved roster', async () => {
        seedRoster([['a', 'Ann', build(80)]]);
        const before = structuredClone(state.db);
        setParty([['c1', 'Captain', build(100)]]);
        await mountTab();
        pick('party:c1', 'never');
        await run();
        expect(state.db).toEqual(before);
        expect(JSON.stringify(state.db)).not.toContain('Captain');
        // The roster list holds Ann only
        expect([...tab.root.querySelectorAll('[data-pf-member]')].map((r) => r.dataset.pfMember)).toEqual(['a']);
    });

    test('Try and Never are per session choices; Always keeps them in every party', async () => {
        seedRoster([['a', 'Ann', build(80)]]);
        setParty([['c1', 'Captain', build(100)]]);
        await mountTab();
        const sizes = async () => {
            state.calls = [];
            await run();
            const out = firstPassSizes();
            tab.stop();
            await flush();
            return out;
        };
        // Always: You, You + Captain, You + Captain + Ann
        expect(await sizes()).toEqual([1, 2, 3]);
        pick('party:c1', 'try');
        // Try: Captain and Ann may each be left out
        expect((await sizes()).length).toBe(4);
        pick('party:c1', 'never');
        expect(await sizes()).toEqual([1, 2]);
        // Remembered for the session: the row redraws on the pick
        tab._renderPartyRows();
        expect(partyChoice('party:c1').value).toBe('never');
    });

    test('not in a party: a short note, nothing added', async () => {
        await mountTab();
        expect(partyRows()).toHaveLength(0);
        expect(el('party-note').textContent).toBe('You are not in a party.');
    });

    test('before character data has loaded: a loading line, then the party once it has', async () => {
        state.charId = null;
        state.noCharacterData = true;
        await mountTab();
        expect(el('party-note').textContent).toBe('Loading party…');
        expect(el('party-note').textContent).not.toContain('not in a party');
        state.charId = 'me';
        state.noCharacterData = false;
        for (const [event, cb] of state.partyListeners) if (event === 'character_initialized') cb();
        await flush();
        expect(el('party-note').textContent).toBe('You are not in a party.');
    });

    test('a profile that lands long after it was shared is still picked up, and the wait ends with the tab', async () => {
        setParty([['c1', 'Captain', null]]);
        const handlers = [];
        const onSpy = vi.spyOn(webSocketHook, 'on').mockImplementation((type, cb) => handlers.push([type, cb]));
        const offSpy = vi.spyOn(webSocketHook, 'off').mockImplementation(() => {});
        try {
            await mountTab();
            const onProfile = handlers.find(([type]) => type === 'profile_shared')[1];
            expect(partyRows()[0].querySelector('[data-pf-party-missing]')).not.toBeNull();
            onProfile({ profile: { sharableCharacter: { id: 'c1', name: 'Captain' } } });
            await new Promise((r) => setTimeout(r, 350));
            // The write lands well after the first two looks (0 ms and 100 ms) would have given up
            setParty([['c1', 'Captain', build(100)]]);
            await new Promise((r) => setTimeout(r, 1100));
            expect(partyRows()[0].querySelector('[data-pf-party-missing]')).toBeNull();
            expect(partyChoice('party:c1').value).toBe('always');
            tab.detach();
            expect(offSpy).toHaveBeenCalledWith('profile_shared', onProfile);
        } finally {
            onSpy.mockRestore();
            offSpy.mockRestore();
        }
    });

    test('the wait for a shared profile stops after a minute', async () => {
        setParty([['c1', 'Captain', null]]);
        const handlers = [];
        const onSpy = vi.spyOn(webSocketHook, 'on').mockImplementation((type, cb) => handlers.push([type, cb]));
        try {
            await mountTab();
            const onProfile = handlers.find(([type]) => type === 'profile_shared')[1];
            vi.useFakeTimers();
            let builds = 0;
            const realBuilt = state.built;
            Object.defineProperty(state, 'built', {
                configurable: true,
                get: () => {
                    builds++;
                    return realBuilt;
                },
            });
            onProfile({ profile: { sharableCharacter: { id: 'c1', name: 'Captain' } } });
            await vi.advanceTimersByTimeAsync(61000);
            const atCap = builds;
            expect(atCap).toBeGreaterThan(3);
            await vi.advanceTimersByTimeAsync(30000);
            expect(builds).toBe(atCap);
        } finally {
            vi.useRealTimers();
            delete state.built;
            onSpy.mockRestore();
        }
    });

    test("a share for one member does not end the wait for another's profile", async () => {
        setParty([
            ['c1', 'Captain', null],
            ['c2', 'Bosun', null],
        ]);
        const handlers = [];
        const onSpy = vi.spyOn(webSocketHook, 'on').mockImplementation((type, cb) => handlers.push([type, cb]));
        try {
            await mountTab();
            const onProfile = handlers.find(([type]) => type === 'profile_shared')[1];
            onProfile({ profile: { sharableCharacter: { id: 'c1', name: 'Captain' } } });
            onProfile({ profile: { sharableCharacter: { id: 'c2', name: 'Bosun' } } });
            // Bosun's lands at once, which ends Bosun's wait; Captain's lands later
            setParty([
                ['c1', 'Captain', null],
                ['c2', 'Bosun', build(90)],
            ]);
            await new Promise((r) => setTimeout(r, 400));
            setParty([
                ['c1', 'Captain', build(100)],
                ['c2', 'Bosun', build(90)],
            ]);
            await new Promise((r) => setTimeout(r, 1100));
            expect(partyChoice('party:c1').value).toBe('always');
        } finally {
            onSpy.mockRestore();
        }
    });

    test('closing the tab ends a profile wait, so reopening it does not resume the old one', async () => {
        setParty([['c1', 'Captain', null]]);
        const handlers = [];
        const onSpy = vi.spyOn(webSocketHook, 'on').mockImplementation((type, cb) => handlers.push([type, cb]));
        const offSpy = vi.spyOn(webSocketHook, 'off').mockImplementation(() => {});
        try {
            await mountTab();
            const onProfile = handlers.find(([type]) => type === 'profile_shared')[1];
            vi.useFakeTimers();
            let builds = 0;
            const realBuilt = state.built;
            Object.defineProperty(state, 'built', {
                configurable: true,
                get: () => {
                    builds++;
                    return realBuilt;
                },
            });
            onProfile({ profile: { sharableCharacter: { id: 'c1', name: 'Captain' } } });
            await vi.advanceTimersByTimeAsync(1000);
            const root = tab.root;
            tab.detach();
            // Reopened: the tab has a root again before the old wait's next look
            tab.root = root || document.createElement('div');
            await vi.advanceTimersByTimeAsync(1000);
            const afterReopen = builds;
            await vi.advanceTimersByTimeAsync(20000);
            expect(builds).toBe(afterReopen);
        } finally {
            vi.useRealTimers();
            delete state.built;
            onSpy.mockRestore();
            offSpy.mockRestore();
        }
    });

    test('a member whose profile is not loaded is said so and left out, never a blank build', async () => {
        seedRoster([['a', 'Ann', build(80)]]);
        setParty([['c1', 'Captain', null]]);
        await mountTab();
        const row = partyRows()[0];
        expect(row.querySelector('[data-pf-party-missing]')?.textContent).toMatch(/profile not loaded/);
        expect(partyChoice('party:c1')).toBeNull();
        expect(el('plan').textContent).toMatch(/Captain is in your party but their profile is not loaded/);
        await run();
        // Only Ann can join: You, You + Ann
        expect(firstPassSizes()).toEqual([1, 2]);
        expect(state.calls[0].params.zones[1].playerDTOs[1].magicLevel).toBe(80);
    });

    test('with only a member not loaded and no roster there is nothing to run', async () => {
        setParty([['c1', 'Captain', null]]);
        await mountTab();
        await run();
        expect(lastStatus()).toBe('Add teammates to the roster first.');
        expect(state.calls).toHaveLength(0);
    });

    test('a party member who is also a saved teammate runs once, as the party member', async () => {
        seedRoster([['a', 'captain', build(70)]]);
        setParty([['c1', 'Captain', build(100)]]);
        await mountTab();
        expect(partyRows()[0].textContent).toContain('replaces the saved teammate of that name');
        const saved = tab.root.querySelector('[data-pf-member="a"]');
        expect(saved.textContent).toContain('your party member is used instead');
        expect(saved.querySelector('select').disabled).toBe(true);
        await run();
        expect(firstPassSizes()).toEqual([1, 2]);
        expect(state.calls[0].params.zones[1].playerDTOs[1].magicLevel).toBe(100);
        // ...and the saved teammate is still in the record
        expect(state.db.entries.map((e) => e.id)).toEqual(['a']);
    });

    test('more locked members than the zone takes: the zone is skipped with a note, not crashed', async () => {
        setParty([
            ['c1', 'Captain', build(100)],
            ['c2', 'Dawn', build(101)],
            ['c3', 'Eve', build(102)],
        ]);
        await mountTab();
        // Swamp Planet takes 3 players: you and three locked members do not fit
        expect(el('plan').textContent).toMatch(/Captain, Dawn, Eve cannot all fit in a 3-player party here/);
        await run();
        expect(state.calls).toHaveLength(0);
        expect(lastStatus()).toMatch(/Nothing to run/);
    });

    test('turning it off removes the rows and is remembered', async () => {
        setParty([['c1', 'Captain', build(100)]]);
        await mountTab();
        expect(partyRows()).toHaveLength(1);
        el('lock-party').value = 'nobody';
        el('lock-party').dispatchEvent(new Event('change'));
        await flush();
        expect(partyRows()).toHaveLength(0);
        expect(el('party-note').textContent).toBe('');
        expect(state.prefs['combatSimPartyIncludeParty_me']).toBe(false);
        // A later opening reads it back
        tab.detach();
        await mountTab();
        expect(el('lock-party').value).toBe('nobody');
        expect(partyRows()).toHaveLength(0);
    });

    test('a click on the box while the saved switch is still loading wins over the saved value', async () => {
        setParty([['c1', 'Captain', build(100)]]);
        state.prefs['combatSimPartyIncludeParty_me'] = true;
        let release;
        state.includeGate = new Promise((resolve) => (release = resolve));
        try {
            await mountTab();
            el('lock-party').value = 'nobody';
            el('lock-party').dispatchEvent(new Event('change'));
            await flush();
            release();
            await flush();
            expect(el('lock-party').value).toBe('nobody');
            expect(partyRows()).toHaveLength(0);
        } finally {
            state.includeGate = null;
        }
    });

    test('a party member gets aura options to try, kept in memory and never in the saved roster', async () => {
        state.gameData.abilityDetailMap['/abilities/mystic_aura'] = {
            name: 'Mystic Aura',
            isSpecialAbility: true,
            abilityEffects: [{ effectType: '/ability_effect_types/buff', targetType: 'allAllies', buffs: [{}] }],
        };
        state.gameData.levelExperienceTable = Array.from({ length: 201 }, (_, i) => i);
        setParty([['c1', 'Captain', build(100)]]);
        await mountTab();
        expect(el('plan').textContent).toMatch(/^2 quick sims/);
        tab.root.querySelector('[data-pf-party-auras="party:c1"]').click();
        await flush();
        tab.root.querySelector('[data-pf-aura-pick="party:c1"]').value = '/abilities/mystic_aura';
        tab.root.querySelector('[data-pf-aura-level="party:c1"]').value = '30';
        tab.root.querySelector('[data-pf-aura-add="party:c1"]').click();
        await flush();
        // You alone, You + Captain as built, You + Captain with Mystic Aura
        expect(el('plan').textContent).toMatch(/^3 quick sims/);
        expect(tab.root.querySelector('[data-pf-party-auras="party:c1"]').textContent).toBe('Auras (1)');
        expect(state.db).toBeUndefined();
        const writes = Object.keys(state.prefs).filter((k) => !k.startsWith('combatSimParty'));
        expect(writes).toEqual([]);
    });

    test('Edit opens a party member already in the editor on their own tab', async () => {
        setParty([['c1', 'Captain', build(100)]]);
        host._editor.players = [
            { hrid: 'player1', name: 'Me', self: true, dto: build(90) },
            { hrid: 'player2', name: 'Captain', dto: build(100) },
        ];
        host._editor.showPlayer = vi.fn(() => true);
        try {
            await mountTab();
            tab.root.querySelector('[data-pf-party-edit="party:c1"]').click();
            expect(host._editor.showPlayer).toHaveBeenCalledWith('player2');
            expect(host._editor.importPlayers).not.toHaveBeenCalled();
            expect(host._switchTab).toHaveBeenCalledWith('configure');
            expect(el('roster-note').textContent).toMatch(/Captain is open on the Configure tab/);
        } finally {
            delete host._editor.showPlayer;
        }
    });

    test('Edit imports a party member the editor does not hold', async () => {
        setParty([['c1', 'Captain', build(100)]]);
        await mountTab();
        tab.root.querySelector('[data-pf-party-edit="party:c1"]').click();
        const [players, names] = host._editor.importPlayers.mock.calls[0];
        expect(names).toEqual(['Captain']);
        expect(players[0].magicLevel).toBe(100);
        expect(host._switchTab).toHaveBeenCalledWith('configure');
    });

    test('a simulation started elsewhere while the party is being read stops the search from starting', async () => {
        setParty([['c1', 'Captain', build(100)]]);
        await mountTab();
        const refresh = tab._refreshParty.bind(tab);
        tab._refreshParty = async () => {
            await refresh();
            host.isRunning = true;
        };
        try {
            el('top-k').value = '0';
            await tab.start();
            await flush();
            expect(state.calls).toHaveLength(0);
            expect(lastStatus()).toBe('A simulation is already running.');
        } finally {
            host.isRunning = false;
        }
    });

    test('a party change during the search party read runs on the newest party', async () => {
        setParty([['c1', 'Captain', build(100)]]);
        await mountTab();
        setParty([
            ['c1', 'Captain', build(100)],
            ['c2', 'Dawn', build(101)],
        ]);
        const read = tab._readParty.bind(tab);
        let first = true;
        let release;
        tab._readParty = () => {
            const pending = read();
            if (first) {
                first = false;
                // The roster update lands while start() is reading: the listener starts a newer, slower read
                state.builtGate = new Promise((resolve) => (release = resolve));
                fireRosterEvent();
            }
            return pending;
        };
        try {
            el('top-k').value = '0';
            tab.start();
            await flush();
            // start() is still waiting on the newer read: nothing has run on the old party
            expect(state.calls).toHaveLength(0);
            release();
            await flush();
        } finally {
            state.builtGate = null;
        }
        // You alone, then you + Captain + Dawn: never the party as it was before the change
        expect(firstPassSizes()).toEqual([1, 3]);
    });

    test('the party changing while the tab is open redraws', async () => {
        setParty([['c1', 'Captain', build(100)]]);
        await mountTab();
        expect(partyRows()).toHaveLength(1);
        setParty([
            ['c1', 'Captain', build(100)],
            ['c2', 'Dawn', build(101)],
        ]);
        fireRosterEvent();
        await flush();
        expect(partyRows().map((r) => r.dataset.pfPartyMember)).toEqual(['party:c1', 'party:c2']);
        state.party = [{ characterID: 'me', characterName: 'Milkman' }];
        fireRosterEvent();
        await flush();
        expect(partyRows()).toHaveLength(0);
        // The listeners go with the tab
        tab.detach();
        expect(state.partyListeners).toHaveLength(0);
    });
});

describe('you are in every party', () => {
    test('the section and the Copy my build button say so', async () => {
        await mountTab();
        expect(tab.root.textContent).toContain(
            'This player is in every party tried, and every figure below is theirs.'
        );
        expect(tab.root.textContent).not.toContain("Every figure below is this player's own.");
        expect(el('add-self').title).toMatch(/second copy of you/);
    });

    test('result rows, the alias tooltip and the editor status all name you', async () => {
        seedRoster([
            ['a', 'Ann', build(80)],
            ['b', 'Ann copy', build(80)],
        ]);
        await mountTab();
        el('top-k').value = '0';
        tab.start();
        await flush();
        await finishPass((_z, index) => sim(1000 + index * 100, 100));
        const labels = resultRows().map((r) => r.querySelector('td:nth-child(2) span').textContent);
        expect(labels).toContain('You alone');
        expect(labels).toContain('You + Ann');
        expect(labels.every((l) => l.startsWith('You'))).toBe(true);
        const annRow = tab.sortedRows().find((r) => labelOfRow(r) === 'You + Ann');
        tab.root.querySelector(`[data-pf-load="${annRow.id}"]`).click();
        expect(lastStatus()).toBe('Loaded Milkman + Ann into the editor.');
    });
});

describe('saved parties', () => {
    const savedRecord = (parties, removed = {}) => ({ savedAt: 5, parties, removed });
    const savedParty = (id, name, members, updatedAt = 5) => ({ id, name, members, addedAt: 1, updatedAt });
    const savedMember = (name, magic, extra = {}) => ({ name, dto: build(magic), choice: 'always', ...extra });
    const savedRow = (id) => tab.root.querySelector(`[data-pf-saved-party="${id}"]`);
    const savedButton = (id, label) =>
        [...savedRow(id).querySelectorAll('button')].find((b) => b.textContent === label);
    const lockValue = () => el('lock-party').value;
    const lockLabels = () => [...el('lock-party').options].map((o) => o.textContent);
    const choose = async (value) => {
        el('lock-party').value = value;
        el('lock-party').dispatchEvent(new Event('change'));
        await flush();
    };
    const editorWith = (names) => {
        host._editor.players = [
            { hrid: 'player1', name: 'Milkman', dto: build(90), self: true },
            ...names.map((name, i) => ({ hrid: `player${i + 2}`, name, dto: build(100 + i) })),
        ];
    };

    test('save from the editor: members besides you, with the pick and auras of a matching party row', async () => {
        setParty([['c1', 'Ann', build(100)]]);
        editorWith(['Ann', 'Bo']);
        await mountTab();
        pick('party:c1', 'try');
        tab._partyAuras.set('party:c1', {
            auras: [{ hrid: '/abilities/mystic_aura', level: 20 }],
            includeAsBuilt: false,
        });
        el('save-party-open').click();
        // Named after the members until the player types their own
        expect(el('save-party-form').style.display).toBe('flex');
        expect(el('party-name').value).toBe('Ann, Bo');
        el('party-name').value = 'Raid';
        el('save-party').click();
        await flush();
        const [party] = state.savedDb.parties;
        expect(party.name).toBe('Raid');
        expect(party.members.map((m) => [m.name, m.choice])).toEqual([
            ['Ann', 'try'],
            ['Bo', 'always'],
        ]);
        expect(party.members[0].auras).toEqual([{ hrid: '/abilities/mystic_aura', level: 20 }]);
        expect(party.members[0].includeAsBuilt).toBe(false);
        // Never touches the roster record
        expect(state.db).toBeUndefined();
        expect(el('saved-party-note').textContent).toBe('Saved "Raid".');
        expect(savedRow(party.id).querySelector('[data-pf-saved-party-members]').textContent).toBe('Ann, Bo');
        expect(lockLabels()).toEqual(['My party', 'Saved: Raid', 'Nobody']);
    });

    test('every way a save can end: nobody loaded, only you, empty name, duplicate name, write failure, cap', async () => {
        await mountTab();
        host._editor.players = [];
        el('save-party-open').click();
        expect(el('saved-party-note').textContent).toMatch(/Nobody is loaded in the editor/);
        editorWith([]);
        el('save-party-open').click();
        expect(el('saved-party-note').textContent).toMatch(/Only you are in the editor/);
        editorWith(['Ann']);
        el('save-party-open').click();
        el('party-name').value = '  ';
        el('save-party').click();
        await flush();
        expect(el('saved-party-note').textContent).toBe('Not saved: give the party a name.');
        expect(state.savedDb).toBeUndefined();
        el('party-name').value = 'Crew';
        el('save-party').click();
        await flush();
        el('party-name').value = 'crew';
        el('save-party').click();
        await flush();
        expect(state.savedDb.parties).toHaveLength(2);
        expect(el('saved-party-note').textContent).toMatch(/another saved party already has that name/);
        state.failWrite = true;
        el('party-name').value = 'Third';
        el('save-party').click();
        await flush();
        expect(el('saved-party-note').textContent).toMatch(/could not be written/);
        state.failWrite = false;
        state.savedDb.parties = Array.from({ length: 40 }, (_, i) =>
            savedParty(`sp-${i}`, `P${i}`, [savedMember('Ann', 80)])
        );
        await tab._reloadSaved();
        el('party-name').value = 'Over';
        el('save-party').click();
        await flush();
        expect(el('saved-party-note').textContent).toBe('Not saved: at most 40 parties can be saved.');
        expect(state.savedDb.parties).toHaveLength(40);
    });

    test('five other players in the editor are refused, nothing written', async () => {
        editorWith(['A', 'B', 'C', 'D', 'E']);
        await mountTab();
        el('save-party').click();
        await flush();
        expect(el('saved-party-note').textContent).toMatch(/at most 4 besides you/);
        expect(state.savedDb).toBeUndefined();
    });

    test('rename, and a two-click delete', async () => {
        state.savedDb = savedRecord([savedParty('sp-1', 'Raid', [savedMember('Ann', 100)])]);
        await mountTab();
        savedButton('sp-1', 'Rename').click();
        const input = savedRow('sp-1').querySelector('input');
        input.value = 'Dungeon crew';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        await flush();
        expect(state.savedDb.parties[0].name).toBe('Dungeon crew');
        expect(savedRow('sp-1').textContent).toContain('Dungeon crew');
        savedButton('sp-1', '×').click();
        await flush();
        expect(state.savedDb.parties).toHaveLength(1);
        expect(savedButton('sp-1', 'Delete?')).toBeTruthy();
        savedButton('sp-1', 'Delete?').click();
        await flush();
        expect(state.savedDb.parties).toEqual([]);
        expect(state.savedDb.removed['sp-1']).toBeGreaterThan(0);
        expect(savedRow('sp-1')).toBeNull();
    });

    test('lock in: the saved members replace the in-game party as labeled rows with their saved picks', async () => {
        setParty([['c1', 'Captain', build(100)]]);
        state.savedDb = savedRecord([
            savedParty('sp-1', 'Raid', [
                savedMember('Ann', 110, { choice: 'try', auras: [{ hrid: '/abilities/mystic_aura', level: 25 }] }),
                savedMember('Bo', 120),
            ]),
        ]);
        await mountTab();
        expect(partyRows().map((r) => r.firstChild.textContent)).toEqual(['Captain (in party)']);
        savedButton('sp-1', 'Lock in').click();
        await flush();
        expect(lockValue()).toBe('saved:sp-1');
        expect(partyRows().map((r) => r.firstChild.textContent)).toEqual([
            'Ann (saved party: Raid)',
            'Bo (saved party: Raid)',
        ]);
        const [annId, boId] = partyRows().map((r) => r.dataset.pfPartyMember);
        expect(partyChoice(annId).value).toBe('try');
        expect(partyChoice(boId).value).toBe('always');
        expect(tab.root.querySelector(`[data-pf-party-auras="${annId}"]`).textContent).toBe('Auras (1)');
        // Remembered per character as the select's value; nothing reaches the roster
        expect(state.prefs.combatSimPartyIncludeParty_me).toBe('saved:sp-1');
        expect(state.db).toBeUndefined();
        // Every party tried holds Bo (Always); Ann (Try) comes and goes
        el('top-k').value = '0';
        tab.start();
        await flush();
        const zones = state.calls[0].params.zones;
        expect(zones.length).toBeGreaterThan(1);
        expect(zones.every((z) => z.playerDTOs.length === 1 || z.playerDTOs.some((d) => d.magicLevel === 120))).toBe(
            true
        );
        expect(zones.some((z) => z.playerDTOs.some((d) => d.magicLevel === 120))).toBe(true);
    });

    test('a pick made this session on a saved-party row stands over the saved one', async () => {
        state.savedDb = savedRecord([savedParty('sp-1', 'Raid', [savedMember('Ann', 110)])]);
        await mountTab();
        await choose('saved:sp-1');
        const id = partyRows()[0].dataset.pfPartyMember;
        pick(id, 'never');
        await tab._refreshParty();
        expect(partyChoice(id).value).toBe('never');
    });

    test('saved-party members are never written to the roster', async () => {
        state.savedDb = savedRecord([savedParty('sp-1', 'Raid', [savedMember('Ann', 110)])]);
        await mountTab();
        await choose('saved:sp-1');
        pick(partyRows()[0].dataset.pfPartyMember, 'try');
        expect(state.db).toBeUndefined();
    });

    test('the stored pick of a saved party waits for the saved parties to be read', async () => {
        state.savedDb = savedRecord([savedParty('sp-1', 'Raid', [savedMember('Ann', 110)])]);
        state.prefs.combatSimPartyIncludeParty_me = 'saved:sp-1';
        await mountTab();
        expect(lockValue()).toBe('saved:sp-1');
        expect(partyRows().map((r) => r.firstChild.textContent)).toEqual(['Ann (saved party: Raid)']);
        expect(el('party-note').textContent).not.toMatch(/gone/);
    });

    test('a locked-in party deleted elsewhere (a sync pull) falls back to my party with a note', async () => {
        setParty([['c1', 'Captain', build(100)]]);
        state.savedDb = savedRecord([savedParty('sp-1', 'Raid', [savedMember('Ann', 110)])]);
        await mountTab();
        await choose('saved:sp-1');
        state.savedDb = savedRecord([], { 'sp-1': Date.now() });
        announceSyncPullApplied({ settings: ['combatSimSavedParties'] });
        await flush();
        expect(lockValue()).toBe('my');
        expect(partyRows().map((r) => r.firstChild.textContent)).toEqual(['Captain (in party)']);
        expect(el('party-note').textContent).toMatch(/saved party you had locked in is gone/);
    });

    test('deleting the locked-in party here also falls back', async () => {
        setParty([['c1', 'Captain', build(100)]]);
        state.savedDb = savedRecord([savedParty('sp-1', 'Raid', [savedMember('Ann', 110)])]);
        await mountTab();
        await choose('saved:sp-1');
        savedButton('sp-1', '×').click();
        await flush();
        savedButton('sp-1', 'Delete?').click();
        await flush();
        expect(lockValue()).toBe('my');
        expect(partyRows().map((r) => r.firstChild.textContent)).toEqual(['Captain (in party)']);
    });

    test('a member with a malformed build is left out with a note, never a blank build', async () => {
        state.savedDb = savedRecord([
            savedParty('sp-1', 'Raid', [
                savedMember('Ann', 110),
                { name: 'Odd', dto: { equipment: {} }, choice: 'always' },
            ]),
        ]);
        await mountTab();
        expect(savedRow('sp-1').querySelector('[data-pf-saved-party-members]').textContent).toBe(
            'Ann, Odd (cannot be loaded)'
        );
        await choose('saved:sp-1');
        expect(partyRows().map((r) => r.firstChild.textContent)).toEqual(['Ann (saved party: Raid)']);
        expect(el('party-note').textContent).toMatch(/Odd in "Raid" has a build this version cannot run/);
        // Still in the record
        expect(state.savedDb.parties[0].members).toHaveLength(2);
    });

    test('more members than a zone takes shows the existing cannot-all-fit note', async () => {
        state.savedDb = savedRecord([
            savedParty('sp-1', 'Raid', [savedMember('Ann', 110), savedMember('Bo', 111), savedMember('Cy', 112)]),
        ]);
        await mountTab();
        await choose('saved:sp-1');
        // Swamp Planet takes 3 players: you and three locked members do not fit
        expect(el('plan').textContent).toMatch(/Ann, Bo, Cy cannot all fit in a 3-player party here/);
    });

    test('load in editor: you (live) first, then the saved members, then the Configure tab', async () => {
        state.savedDb = savedRecord([savedParty('sp-1', 'Raid', [savedMember('Ann', 110), savedMember('Bo', 120)])]);
        await mountTab();
        savedButton('sp-1', 'Load in editor').click();
        const [players, names, options] = host._editor.loadParty.mock.calls[0];
        expect(names).toEqual(['Milkman', 'Ann', 'Bo']);
        expect(players.map((d) => d.magicLevel)).toEqual([90, 110, 120]);
        expect(options).toMatchObject({ selfIsLive: true, note: 'From the saved party "Raid"' });
        expect(host._switchTab).toHaveBeenCalledWith('configure');
    });

    test('load in editor refuses when nobody can be loaded or the party and you are more than five', async () => {
        state.savedDb = savedRecord([savedParty('sp-bad', 'Bad', [{ name: 'Odd', dto: { equipment: {} } }])]);
        await mountTab();
        savedButton('sp-bad', 'Load in editor').click();
        expect(host._editor.loadParty).not.toHaveBeenCalled();
        expect(el('saved-party-note').textContent).toMatch(/no member this version can load/);
        // The record caps a party at four; a hand-edited one with more is still refused
        const five = ['A', 'B', 'C', 'D', 'E'].map((n, i) => savedMember(n, 100 + i));
        expect(tab._loadSavedPartyInEditor({ name: 'Huge', members: five })).toBe(false);
        expect(el('saved-party-note').textContent).toMatch(/more than 5 players/);
        expect(host._editor.loadParty).not.toHaveBeenCalled();
    });

    test('a stored false from the checkbox era reads as Nobody; true and nothing as My party', async () => {
        setParty([['c1', 'Captain', build(100)]]);
        state.prefs.combatSimPartyIncludeParty_me = false;
        await mountTab();
        expect(lockValue()).toBe('nobody');
        expect(partyRows()).toHaveLength(0);
        tab.detach();
        state.prefs.combatSimPartyIncludeParty_me = true;
        await mountTab();
        expect(lockValue()).toBe('my');
        expect(partyRows()).toHaveLength(1);
        tab.detach();
        delete state.prefs.combatSimPartyIncludeParty_me;
        await mountTab();
        expect(lockValue()).toBe('my');
        expect(PartyFinderTab.lockModeOf('saved:')).toBe('my');
        expect(PartyFinderTab.lockModeOf('whatever')).toBe('my');
    });

    test('My party and Nobody are stored as true / false so an older build still reads them', async () => {
        await mountTab();
        await choose('nobody');
        expect(state.prefs.combatSimPartyIncludeParty_me).toBe(false);
        await choose('my');
        expect(state.prefs.combatSimPartyIncludeParty_me).toBe(true);
    });

    describe('parties a sync fold dropped past the cap', () => {
        const capped = (entries) => ({ ...savedRecord([]), capped: entries });
        const note = () => el('saved-capped');

        test('shown on open though nothing was mounted when the fold ran, and dismissed on this device only', async () => {
            const at = Date.now() - 1000;
            state.savedDb = capped({ x: { name: 'Old crew', at }, y: { name: 'Older crew', at: at - 10 } });
            await mountTab();
            expect(note().style.display).toBe('flex');
            expect(el('saved-capped-text').textContent).toBe(
                'Sync joined two full lists and kept the 40 most recently changed: Old crew, Older crew dropped.'
            );
            el('saved-capped-dismiss').click();
            await flush();
            expect(note().style.display).toBe('none');
            expect(state.seenDb).toEqual({ ids: { combatSimSavedParties: ['x', 'y'] } });
            // The record is never edited by a dismissal, and a reopened tab stays quiet
            expect(Object.keys(state.savedDb.capped)).toEqual(['x', 'y']);
            tab.detach();
            await mountTab();
            expect(note().style.display).toBe('none');
            // A newer eviction shows again
            state.savedDb = capped({ x: { name: 'Old crew', at }, z: { name: 'New crew', at: at + 5 } });
            announceSyncPullApplied({ settings: ['combatSimSavedParties'] });
            await flush();
            expect(el('saved-capped-text').textContent).toContain('New crew');
            expect(el('saved-capped-text').textContent).not.toContain('Old crew');
        });

        test('nothing dropped, or only entries older than 30 days: no note', async () => {
            state.savedDb = capped({ x: { name: 'Ancient', at: Date.now() - 31 * 24 * 60 * 60 * 1000 } });
            await mountTab();
            expect(note().style.display).toBe('none');
        });
    });

    test('a sync pull of the saved parties shows a party another device added', async () => {
        await mountTab();
        expect(savedRow('sp-9')).toBeNull();
        state.savedDb = savedRecord([savedParty('sp-9', 'From phone', [savedMember('Ann', 100)])]);
        announceSyncPullApplied({ settings: ['combatSimSavedParties'] });
        await flush();
        expect(savedRow('sp-9')).not.toBeNull();
        expect(lockLabels()).toContain('Saved: From phone');
    });

    test('a proven deletion of the locked-in party resets the stored pick to My party', async () => {
        setParty([['c1', 'Captain', build(100)]]);
        state.savedDb = savedRecord([savedParty('sp-1', 'Raid', [savedMember('Ann', 110)])]);
        await mountTab();
        await choose('saved:sp-1');
        savedButton('sp-1', '×').click();
        await flush();
        savedButton('sp-1', 'Delete?').click();
        await flush();
        expect(state.prefs.combatSimPartyIncludeParty_me).toBe(true);
    });

    test('picking another saved party while the deleted pick is being reset keeps the new party', async () => {
        state.savedDb = savedRecord([
            savedParty('sp-1', 'Raid', [savedMember('Ann', 110)]),
            savedParty('sp-2', 'Crew', [savedMember('Bea', 120)]),
        ]);
        await mountTab();
        await choose('saved:sp-1');
        let release;
        state.setGate = new Promise((resolve) => (release = resolve));
        savedButton('sp-1', '×').click();
        await flush();
        savedButton('sp-1', 'Delete?').click();
        await flush();
        // The reset write is held; the player picks the other party meanwhile
        await choose('saved:sp-2');
        release();
        await flush();
        expect(lockValue()).toBe('saved:sp-2');
        expect(partyRows().map((r) => r.firstChild.textContent)).toEqual(['Bea (saved party: Crew)']);
    });

    test('a pulled tombstone resets the stored pick', async () => {
        state.savedDb = savedRecord([savedParty('sp-1', 'Raid', [savedMember('Ann', 110)])]);
        await mountTab();
        await choose('saved:sp-1');
        state.savedDb = savedRecord([], { 'sp-1': Date.now() });
        announceSyncPullApplied({ settings: ['combatSimSavedParties'] });
        await flush();
        expect(lockValue()).toBe('my');
        expect(state.prefs.combatSimPartyIncludeParty_me).toBe(true);
    });

    test('a list that merely lacks the party (no tombstone) falls back in memory and leaves the stored pick', async () => {
        state.savedDb = savedRecord([savedParty('sp-1', 'Raid', [savedMember('Ann', 110)])]);
        await mountTab();
        await choose('saved:sp-1');
        state.savedDb = savedRecord([]);
        announceSyncPullApplied({ settings: ['combatSimSavedParties'] });
        await flush();
        expect(lockValue()).toBe('my');
        expect(state.prefs.combatSimPartyIncludeParty_me).toBe('saved:sp-1');
    });

    test('Enter twice, or Enter then Save, while a save is pending makes one party', async () => {
        editorWith(['Ann']);
        await mountTab();
        el('party-name').value = 'Crew';
        el('party-name').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        el('party-name').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        el('save-party').click();
        await flush();
        expect(state.savedDb.parties).toHaveLength(1);
    });

    test('an older read that resolves after a save does not put back the list from before it', async () => {
        editorWith(['Ann']);
        await mountTab();
        let release;
        state.savedGate = new Promise((resolve) => (release = resolve));
        const stale = tab._reloadSaved();
        state.savedGate = null;
        el('party-name').value = 'Crew';
        el('save-party').click();
        await flush();
        expect(tab._saved.parties).toHaveLength(1);
        release();
        await stale;
        await flush();
        expect(tab._saved.parties).toHaveLength(1);
        expect(tab.root.querySelectorAll('[data-pf-saved-party]')).toHaveLength(1);
    });
});
