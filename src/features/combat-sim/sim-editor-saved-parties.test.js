/** @vitest-environment happy-dom
 *
 * Save party / Load party on the Configure tab: Save keeps every loaded player, you included, with their build;
 * Load replaces the roster with a saved one (this tab's, or a Party tab party plus you) and clears every piece of
 * per-player state the old roster had, the way Replace party does.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    charId: 'me',
    gameMode: 'standard',
    selfDTO: null,
    characterData: { character: { name: 'Mill' } },
    party: [],
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterData() {
            return game.characterData;
        },
        getCurrentCharacterId: () => game.charId,
        getCurrentCharacterGameMode: () => game.gameMode,
        getInitClientData: () => ({ itemDetailMap: {}, abilityDetailMap: {} }),
        getItemDetails: () => null,
        getHouseRooms: () => null,
        getLearnedAbilities: () => [],
        getSkills: () => null,
        getEquipment: () => new Map(),
        getPartyMembers: () => ({ members: game.party, source: game.party.length ? 'battle' : 'none' }),
    },
}));

vi.mock('./combat-sim-adapter.js', () => ({
    seedSimPriceCache: (cache) => cache,
    buildGameDataPayload: () => ({ itemDetailMap: {}, abilityDetailMap: {}, houseRoomDetailMap: {} }),
    buildAllPlayerDTOs: async () => ({ players: [], playerInfo: [] }),
    buildPlayerDTO: () => (game.selfDTO ? structuredClone(game.selfDTO) : null),
    parseShykaiImport: () => null,
    buildShykaiExportPlayer: (dto, name) => ({ name, dto }),
    applyLoadoutSnapshotToDTO: () => true,
    getGuildBuffDetailMap: () => ({}),
    guildBuffMaxLevel: () => 20,
    applyGuildBuffLevel: (buffs) => buffs,
    readGuildShrineLevels: () => ({}),
    readGuildShrineCaps: () => ({}),
    readGuildShrineSnapshot: () => ({ levels: {}, capturedAt: null, hydrated: false }),
    recomputeLevelGapDebuffs: () => {},
}));
vi.mock('../combat/loadout-snapshot.js', () => ({
    default: { getAllSnapshots: () => [], resolveEquipment: () => [] },
}));
vi.mock('../../utils/character-key.js', () => ({
    readScoped: async (_base, _store, fallback = null) => fallback,
    writeScoped: async () => {},
}));
vi.mock('../../utils/bundle-bridge.js', () => ({
    marketUndercutAlerts: () => null,
    marketDepthCap: () => null,
    guildMemberSkills: () => null,
    loadoutSnapshot: () => ({ getAllSnapshots: () => [], resolveEquipment: () => [] }),
}));
vi.mock('../../utils/view-loadout.js', () => ({
    VIEW_LOADOUT_CONTEXT: { Party: 'party', GuildTrial: 'guild_trial' },
    isViewLoadoutAvailable: () => true,
    getLoadout: () => null,
    fetchLoadout: async () => null,
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));

// Storage, in memory and keyed; a read can be held open so a change can land while it is out
const db = vi.hoisted(() => ({ values: new Map(), failNext: false, writes: [], hold: null }));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) => {
            if (db.hold) await db.hold;
            return db.values.has(key) ? structuredClone(db.values.get(key)) : fallback;
        },
        update: async (key, mutate) => {
            db.writes.push(key);
            if (db.failNext) {
                db.failNext = false;
                return null;
            }
            const current = db.values.has(key) ? structuredClone(db.values.get(key)) : undefined;
            const next = mutate(current);
            if (next === undefined) return { written: false, value: current };
            db.values.set(key, structuredClone(next));
            return { written: true, value: structuredClone(next) };
        },
    },
}));

const { SimEditor } = await import('./sim-editor.js');
const { SAVED_PARTIES_KEY, SAVED_ROSTERS_KEY, saveParty, saveRoster, loadSavedRosters } =
    await import('./party-saved.js');

const build = (magic, extra = {}) => ({
    equipment: { '/equipment_types/main_hand': { hrid: '/items/rippling_trident', enhancementLevel: 10 } },
    food: [null, null, null],
    drinks: [null, null, null],
    abilities: [null, null, null, null, null],
    houseRooms: {},
    attackLevel: 90,
    meleeLevel: 90,
    rangedLevel: 1,
    magicLevel: magic,
    defenseLevel: 90,
    staminaLevel: 90,
    intelligenceLevel: 90,
    ...extra,
});

const flush = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
};

/** An editor holding five players (two named alike), with you as the second and old per-player state about */
function loadedEditor({ labMode = false, skillingMode = false } = {}) {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const editor = new SimEditor({ editorEl: el, labMode, skillingMode });
    editor.importPlayers(
        [build(101), build(150), build(102), build(103), build(104)],
        ['Ann', 'Mill', 'Ann', 'Bo', 'Cy'],
        [{ slot: 3, itemHrid: '/items/old', itemName: 'Old', itemLocationHrid: null }]
    );
    editor._selfHrid = 'player2';
    editor._missingMembers = ['Ghost'];
    editor._missingMemberIds = ['9'];
    editor._profileStatus = [{ hrid: 'player3', name: 'Ann', found: true }];
    editor._loadoutFetchNote = 'Fetched Bo';
    editor._selectedLoadoutName = 'Bruteforce';
    editor._loadoutAppliedNames = { player2: 'Bruteforce' };
    editor._rosterFromPaste = false;
    editor.renderEditor();
    return { el, editor };
}

const text = (el) => el.textContent.replace(/\s+/g, ' ');

beforeEach(() => {
    db.values = new Map();
    db.failNext = false;
    db.writes = [];
    db.hold = null;
    game.charId = 'me';
    game.gameMode = 'standard';
    game.selfDTO = build(150);
    game.party = [];
    document.body.innerHTML = '';
});

describe('Save party', () => {
    test('keeps every loaded player, you included, in tab order with their builds', async () => {
        const { el, editor } = loadedEditor();
        editor._editedDTOs.player4.magicLevel = 120; // a hand edit is what gets saved
        el.querySelector('#mwi-csim-save-party-btn').click();
        const input = el.querySelector('#mwi-csim-save-party-name');
        input.value = 'Raid crew';
        input.dispatchEvent(new Event('input'));
        el.querySelector('#mwi-csim-save-party-go').click();
        await flush();
        const [roster] = (await loadSavedRosters()).parties;
        expect(roster.name).toBe('Raid crew');
        expect(roster.members.map((m) => [m.name, m.dto.magicLevel])).toEqual([
            ['Ann', 101],
            ['Mill', 150],
            ['Ann', 102],
            ['Bo', 120],
            ['Cy', 104],
        ]);
        // You carry the live character's mode; the others carry none they did not come with
        expect(roster.members.map((m) => m.gameMode)).toEqual([null, 'standard', null, null, null]);
        expect(db.writes).toEqual([SAVED_ROSTERS_KEY]);
        expect(text(el)).toContain('Saved "Raid crew" (5 players).');
        expect(el.querySelector('#mwi-csim-save-party-name')).toBeNull();
        // Saving changes nothing loaded
        expect(editor._editedPlayerInfo).toHaveLength(5);
        expect(editor.getSelfHrid()).toBe('player2');
    });

    test('an empty name is refused before any write; the typed name survives a redraw', async () => {
        const { el, editor } = loadedEditor();
        el.querySelector('#mwi-csim-save-party-btn').click();
        el.querySelector('#mwi-csim-save-party-go').click();
        await flush();
        expect(db.writes).toEqual([]);
        expect(text(el)).toContain('Give the party a name first.');
        const input = el.querySelector('#mwi-csim-save-party-name');
        input.value = 'Half typed';
        input.dispatchEvent(new Event('input'));
        editor.renderEditor();
        expect(el.querySelector('#mwi-csim-save-party-name').value).toBe('Half typed');
    });

    test('a write that fails says so and keeps the form open', async () => {
        const { el, editor } = loadedEditor();
        db.failNext = true;
        editor._savedForm = 'save';
        await editor.saveLoadedRoster('Crew');
        expect(text(el)).toContain('Not saved: the list could not be written.');
        expect(el.querySelector('#mwi-csim-save-party-name')).not.toBeNull();
        expect((await loadSavedRosters()).parties).toEqual([]);
    });

    test('the cap is said as the reason', async () => {
        const { el, editor } = loadedEditor();
        for (let i = 0; i < 40; i++) await saveRoster(`R${i}`, [{ name: 'X', dto: build(1) }]);
        await editor.saveLoadedRoster('One more');
        expect(text(el)).toContain('Not saved: at most 40 parties can be saved here.');
    });

    test('a character switch while the write is out leaves no note on the arriving one', async () => {
        const { el, editor } = loadedEditor();
        const pending = editor.saveLoadedRoster('Crew');
        game.charId = 'other';
        await pending;
        expect(text(el)).not.toContain('Saved "Crew"');
    });

    test('a repeated name is saved and said; a player with a build that cannot run is named and left out', async () => {
        await saveRoster('Crew', [{ name: 'X', dto: build(1) }]);
        const { el, editor } = loadedEditor();
        delete editor._editedDTOs.player5.magicLevel;
        await editor.saveLoadedRoster('crew');
        expect(text(el)).toContain('Saved "crew" (4 players) — another saved party already has that name.');
        expect(text(el)).toContain('Left out (no build that can be saved): Cy.');
        const saved = (await loadSavedRosters()).parties;
        expect(saved).toHaveLength(2);
        expect(saved[1].members.map((m) => m.name)).toEqual(['Ann', 'Mill', 'Ann', 'Bo']);
    });

    test('the outcome line goes once the loaded players are replaced', async () => {
        const { el, editor } = loadedEditor();
        await editor.saveLoadedRoster('Crew');
        expect(text(el)).toContain('Saved "Crew"');
        editor.resetToSelf();
        expect(text(el)).not.toContain('Saved "Crew"');
    });
});

describe('Load party', () => {
    async function openList(el) {
        el.querySelector('#mwi-csim-load-party-btn').click();
        await flush();
    }

    test('lists both: rosters saved here and Party tab parties (as you plus them)', async () => {
        await saveRoster(
            'Five',
            [1, 2, 3, 4, 5].map((n) => ({ name: `P${n}`, dto: build(100 + n) }))
        );
        await saveParty('Tab party', [{ name: 'Ann', dto: build(101) }]);
        const { el } = loadedEditor();
        await openList(el);
        const t = text(el);
        expect(t).toContain('Saved here');
        expect(t).toContain('P1, P2, P3, P4, P5');
        expect(t).toContain('From the Party tab');
        expect(t).toContain('You, Ann');
        expect(el.querySelectorAll('[data-saved-load]')).toHaveLength(2);
        // Only this tab's rosters can be deleted here; the Party tab keeps its own
        expect(el.querySelectorAll('[data-saved-delete]')).toHaveLength(1);
    });

    test('nothing saved says how to save one', async () => {
        const { el } = loadedEditor();
        await openList(el);
        expect(text(el)).toContain('No saved parties yet.');
    });

    test('a roster replaces every player and clears the old roster state, as Replace party does', async () => {
        await saveRoster(
            'Five',
            ['Me', 'Ann', 'Ann', 'Bo', 'Cy'].map((name, i) => ({ name, dto: build(200 + i) }))
        );
        const { el, editor } = loadedEditor();
        game.party = [
            { characterID: 'me', characterName: 'Mill' },
            { characterID: '7', characterName: 'Zed' },
        ];
        editor.renderEditor();
        // Offered before: the loaded players carry no paste flag
        expect(el.querySelector('[data-fetch-loadout]')).not.toBeNull();
        await openList(el);
        const tokenBefore = editor._scenarioToken;
        el.querySelector('[data-saved-load^="roster:"]').click();
        await flush();
        expect(editor._editedPlayerInfo.map((p) => [p.hrid, p.name])).toEqual([
            ['player1', 'Me'],
            ['player2', 'Ann'],
            ['player3', 'Ann'],
            ['player4', 'Bo'],
            ['player5', 'Cy'],
        ]);
        expect(editor._editedDTOs.player3.magicLevel).toBe(202);
        expect(editor._originalDTOs.player3.magicLevel).toBe(202);
        expect(editor._editedDTOs.player3.hrid).toBe('player3');
        // No row is the live you: the record is account-wide
        expect(editor.getSelfHrid()).toBeNull();
        expect(editor._missingMembers).toEqual([]);
        expect(editor._missingMemberIds).toEqual([]);
        expect(editor._profileStatus).toEqual([]);
        expect(editor._importSkipped).toEqual([]);
        expect(editor._loadoutFetchNote).toBe('');
        expect(editor._selectedLoadoutName).toBe('');
        expect(editor._loadoutAppliedNames).toBeNull();
        expect(editor._rosterEdited).toBe(true);
        expect(editor._rosterFromPaste).toBe(true);
        expect(editor._scenarioToken).toBeGreaterThan(tokenBefore);
        expect(text(el)).toContain('From the saved party "Five"');
        expect(text(el)).toContain('Loaded "Five".');
        // Not the party you are in (Zed is not in it), so Fetch loadout would load that over it
        expect(el.querySelector('[data-fetch-loadout]')).toBeNull();
        expect(el.querySelector('[data-saved-form]')).toBeNull();
    });

    test('a Party tab party loads as you (live) plus its members, in the live mode', async () => {
        await saveParty(
            'Tab four',
            ['Ann', 'Ann', 'Bo', 'Cy'].map((name, i) => ({ name, dto: build(110 + i, { gameMode: 'ironcow' }) }))
        );
        const { el, editor } = loadedEditor();
        await openList(el);
        el.querySelector('[data-saved-load^="party:"]').click();
        await flush();
        expect(editor._editedPlayerInfo.map((p) => p.name)).toEqual(['Mill', 'Ann', 'Ann', 'Bo', 'Cy']);
        expect(editor.getSelfHrid()).toBe('player1');
        expect(editor._editedDTOs.player1.magicLevel).toBe(150);
        expect(editor._editedDTOs.player2.magicLevel).toBe(110);
        expect(editor._editedDTOs.player5.gameMode).toBe('standard');
        expect(editor._missingMembers).toEqual([]);
        expect(editor._rosterEdited).toBe(true);
        expect(editor._rosterFromPaste).toBe(true);
        expect(text(el)).toContain('Loaded "Tab four" with you.');
    });

    test('a Party tab party with no character data loaded is refused and changes nothing', async () => {
        await saveParty('Tab', [{ name: 'Ann', dto: build(110) }]);
        game.selfDTO = null;
        const { el, editor } = loadedEditor();
        await openList(el);
        el.querySelector('[data-saved-load^="party:"]').click();
        await flush();
        expect(text(el)).toContain('No character data available.');
        expect(editor._editedPlayerInfo.map((p) => p.name)).toEqual(['Ann', 'Mill', 'Ann', 'Bo', 'Cy']);
    });

    test('a player whose build cannot run is named and left out; none that can is refused', async () => {
        db.values.set(SAVED_ROSTERS_KEY, {
            savedAt: 1,
            parties: [
                {
                    id: 'sr-a',
                    name: 'Some',
                    members: [
                        { name: 'Ok', dto: build(100) },
                        { name: 'Broken', dto: { equipment: {} } },
                    ],
                    updatedAt: 1,
                },
                { id: 'sr-b', name: 'None', members: [{ name: 'Broken', dto: { equipment: {} } }], updatedAt: 1 },
            ],
            removed: {},
        });
        const { el, editor } = loadedEditor();
        expect(await editor.loadSavedEntry('roster', 'sr-b')).toBe(false);
        expect(text(el)).toContain('"None" has no player this version can load.');
        expect(editor._editedPlayerInfo).toHaveLength(5);
        expect(await editor.loadSavedEntry('roster', 'sr-a')).toBe(true);
        expect(editor._editedPlayerInfo.map((p) => p.name)).toEqual(['Ok']);
        expect(text(el)).toContain('Broken could not be loaded.');
    });

    test('a roster deleted after the list was drawn is said, and the list redrawn without it', async () => {
        const { id } = await saveRoster('Gone', [{ name: 'X', dto: build(1) }]);
        const { el, editor } = loadedEditor();
        await openList(el);
        db.values.set(SAVED_ROSTERS_KEY, { savedAt: 2, parties: [], removed: { [id]: Date.now() } });
        el.querySelector('[data-saved-load^="roster:"]').click();
        await flush();
        await flush();
        expect(text(el)).toContain('That party is no longer saved');
        expect(text(el)).toContain('No saved parties yet.');
        expect(editor._editedPlayerInfo).toHaveLength(5);
    });

    test('players replaced while the read is out win: nothing is loaded over them', async () => {
        const { id } = await saveRoster('Crew', [{ name: 'X', dto: build(1) }]);
        const { editor } = loadedEditor();
        let release;
        db.hold = new Promise((resolve) => (release = resolve));
        const pending = editor.loadSavedEntry('roster', id);
        editor.resetToSelf();
        db.hold = null;
        release();
        expect(await pending).toBe(false);
        expect(editor._editedPlayerInfo.map((p) => p.name)).toEqual(['Mill']);
    });

    test('a character switch while the read is out loads nothing', async () => {
        const { id } = await saveRoster('Crew', [{ name: 'X', dto: build(1) }]);
        const { editor } = loadedEditor();
        let release;
        db.hold = new Promise((resolve) => (release = resolve));
        const pending = editor.loadSavedEntry('roster', id);
        game.charId = 'other';
        db.hold = null;
        release();
        expect(await pending).toBe(false);
        expect(editor._editedPlayerInfo).toHaveLength(5);
    });

    test('a list read that lands after the form was closed does not reopen it', async () => {
        const { el, editor } = loadedEditor();
        let release;
        db.hold = new Promise((resolve) => (release = resolve));
        el.querySelector('#mwi-csim-load-party-btn').click();
        expect(text(el)).toContain('Reading the saved parties');
        el.querySelector('#mwi-csim-saved-cancel').click();
        db.hold = null;
        release();
        await flush();
        expect(el.querySelector('[data-saved-form]')).toBeNull();
        expect(editor._savedLists).toBeNull();
    });

    test('delete asks once, then deletes and redraws the list', async () => {
        await saveRoster('Keep', [{ name: 'X', dto: build(1) }]);
        await saveRoster('Drop', [{ name: 'Y', dto: build(2) }]);
        const { el } = loadedEditor();
        await openList(el);
        const del = () => [...el.querySelectorAll('[data-saved-delete]')][1];
        del().click();
        await flush();
        expect(del().textContent).toBe('Delete?');
        expect((await loadSavedRosters()).parties).toHaveLength(2);
        del().click();
        await flush();
        expect((await loadSavedRosters()).parties.map((p) => p.name)).toEqual(['Keep']);
        expect(text(el)).toContain('Deleted.');
        expect(el.querySelectorAll('[data-saved-load]')).toHaveLength(1);
    });

    test('a delete whose write fails says so and keeps it; one already gone says that', async () => {
        const { id } = await saveRoster('Keep', [{ name: 'X', dto: build(1) }]);
        const { el, editor } = loadedEditor();
        await openList(el);
        db.failNext = true;
        await editor.deleteSavedRoster(id);
        expect(await editor.deleteSavedRoster(id)).toBe(false);
        expect(text(el)).toContain('Could not delete: the list could not be written.');
        expect((await loadSavedRosters()).parties).toHaveLength(1);
        db.values.set(SAVED_ROSTERS_KEY, { savedAt: 2, parties: [], removed: {} });
        await editor.deleteSavedRoster(id);
        expect(await editor.deleteSavedRoster(id)).toBe(false);
        expect(text(el)).toContain('That party was already deleted.');
    });

    test('each roster player keeps the mode they were saved with, the live you among them', async () => {
        await saveRoster('Modes', [
            { name: 'Me', dto: build(150), gameMode: 'ironcow' },
            { name: 'Ann', dto: build(101, { gameMode: 'standard' }) },
        ]);
        game.gameMode = 'standard';
        const { editor } = loadedEditor();
        const [roster] = (await loadSavedRosters()).parties;
        expect(await editor.loadSavedEntry('roster', roster.id)).toBe(true);
        expect(editor._editedDTOs.player1.gameMode).toBe('ironcow');
        expect(editor._editedDTOs.player2.gameMode).toBe('standard');
        // Only hand-edited data mixes modes: kept as it is, and said
        expect(text(editor._editorEl)).toContain(
            'Its players are saved in different game modes (Iron Cow, Standard); each keeps their own for prices and tax.'
        );
    });

    test('a Standard roster loaded on an Iron Cow character keeps Standard and says so', async () => {
        await saveRoster('Std', [
            { name: 'Me', dto: build(150), gameMode: 'standard' },
            { name: 'Ann', dto: build(101, { gameMode: 'standard' }) },
        ]);
        game.gameMode = 'ironcow';
        const { editor } = loadedEditor();
        const [roster] = (await loadSavedRosters()).parties;
        expect(await editor.loadSavedEntry('roster', roster.id)).toBe(true);
        expect(editor._editedDTOs.player1.gameMode).toBe('standard');
        expect(editor._editedDTOs.player2.gameMode).toBe('standard');
        expect(text(editor._editorEl)).toContain(
            "Saved as Standard; you are playing Iron Cow — prices and tax follow the saved players' mode."
        );
    });

    test('a roster in the mode you are playing says nothing about modes', async () => {
        await saveRoster('Same', [{ name: 'Me', dto: build(150), gameMode: 'standard' }]);
        game.gameMode = 'standard';
        const { editor } = loadedEditor();
        const [roster] = (await loadSavedRosters()).parties;
        await editor.loadSavedEntry('roster', roster.id);
        expect(text(editor._editorEl)).toContain('Loaded "Same".');
        expect(text(editor._editorEl)).not.toContain('game mode');
        expect(text(editor._editorEl)).not.toContain('Saved as');
    });

    test('a Party tab party member who cannot run is named and left out', async () => {
        db.values.set(SAVED_PARTIES_KEY, {
            savedAt: 1,
            parties: [
                {
                    id: 'sp-a',
                    name: 'Tab',
                    members: [
                        { name: 'Ann', dto: build(101) },
                        { name: 'Broken', dto: { equipment: {} } },
                    ],
                    updatedAt: 1,
                },
            ],
            removed: {},
        });
        const { el, editor } = loadedEditor();
        expect(await editor.loadSavedEntry('party', 'sp-a')).toBe(true);
        expect(editor._editedPlayerInfo.map((p) => p.name)).toEqual(['Mill', 'Ann']);
        expect(text(el)).toContain('Loaded "Tab" with you. Broken could not be loaded.');
    });
});

describe('where it is offered', () => {
    test('the lab and skilling editors have neither button', () => {
        for (const mode of [{ labMode: true }, { skillingMode: true }]) {
            const { el, editor } = loadedEditor(mode);
            expect(el.querySelector('#mwi-csim-save-party-btn')).toBeNull();
            expect(el.querySelector('#mwi-csim-load-party-btn')).toBeNull();
            expect(editor._offersSavedParties()).toBe(false);
        }
    });

    test('reset closes the form and drops the note', async () => {
        const { el, editor } = loadedEditor();
        el.querySelector('#mwi-csim-load-party-btn').click();
        editor._setSavedNote('something');
        editor.reset();
        expect(editor._savedForm).toBeNull();
        expect(editor._savedNote).toBe('');
        expect(db.values.has(SAVED_PARTIES_KEY)).toBe(false);
    });
});
