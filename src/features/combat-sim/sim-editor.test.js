/** @vitest-environment happy-dom
 *
 * Getting back to yourself in the Sim Editor.
 *
 * The Configure tab is easy to fill with strangers: every "+ Import" adds a
 * player and nothing removes them but clicking each × in turn. The two reset
 * buttons are the way back, and what is worth asserting about them is that they
 * read *live* data rather than restoring `_originalDTOs` — that snapshot is
 * whatever was loaded last, which after an import is the strangers themselves.
 *
 * The community-buff ceiling lives here too, because the editor's input is one
 * of the two places that has to agree with the game's Lv20 cap; the other is
 * `MAX_COMMUNITY_BUFF_LEVEL` in upgrade-advisor.js.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { partyLevelGaps } from '../../utils/dungeon-level-gap.js';
import { combatLevel } from '../../utils/combat-level.js';

const game = vi.hoisted(() => ({
    charId: 'me',
    buildHold: null,
    characterData: { character: { id: 'me', name: 'Milkman' } },
    selfDTO: null,
    allPlayers: null,
    /** What the game says the house is now: Map of room hrid → {level} */
    houseRooms: null,
    /** The roster the last `new_battle` named, or null before any fight */
    battleParty: null,
    /** Set per-test to stub what a player DTO exports to */
    buildExport: null,
    /** Set per-test to stub what a pasted "+ Import" text parses to */
    parseImport: null,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterData() {
            return game.characterData;
        },
        getCurrentCharacterId: () => game.charId,
        getInitClientData: () => ({ itemDetailMap: {}, abilityDetailMap: {} }),
        getItemDetails: () => null,
        getHouseRooms: () => game.houseRooms,
        // The same precedence the real one applies: a roster read off a battle
        // beats the one `init_character_data` froze at page load
        getPartyMembers: () => {
            if (game.battleParty) {
                return { members: game.battleParty.map((member) => ({ ...member })), source: 'battle', updatedAt: 1 };
            }
            const slots = game.characterData?.partyInfo?.partySlotMap;
            const members = slots
                ? Object.values(slots)
                      .filter((member) => member?.characterID)
                      .map((member) => ({ characterID: member.characterID, characterName: member.characterName || '' }))
                : [];
            return { members, source: members.length ? 'login' : 'none', updatedAt: null };
        },
    },
}));

// The guild side of the game: what the shrines' buff details are, what this
// character has bought, what the guild has built, and how fresh that reading is
const guild = vi.hoisted(() => ({
    detailMap: {},
    levels: {},
    caps: {},
    snapshot: { capturedAt: null, hydrated: false },
}));

vi.mock('./combat-sim-adapter.js', () => ({
    buildGameDataPayload: () => ({ itemDetailMap: {}, abilityDetailMap: {}, houseRoomDetailMap: {} }),
    buildAllPlayerDTOs: async () => {
        // A build left open, so a test can land a character switch inside one
        if (game.buildHold) await game.buildHold;
        return game.allPlayers;
    },
    buildPlayerDTO: () => (game.selfDTO ? structuredClone(game.selfDTO) : null),
    parseShykaiImport: (text) => (game.parseImport ? game.parseImport(text) : null),
    buildShykaiExportPlayer: (dto, name) => (game.buildExport ? game.buildExport(dto, name) : { name, dto }),
    // The real one returns false for a name no snapshot answers to, which is
    // what the remembered-selection restore leans on
    applyLoadoutSnapshotToDTO: (dto, name) => {
        bridge.applied.push(name);
        const found = bridge.snapshots.some((snap) => snap.name === name);
        // The real function mutates the DTO to match the snapshot; a test that
        // cares whether a legitimate loadout/current-gear difference gets
        // mistaken for a hand edit needs that mutation to actually happen.
        if (found && bridge.mutate) bridge.mutate(dto);
        return found;
    },
    getGuildBuffDetailMap: () => guild.detailMap,
    guildBuffMaxLevel: () => 20,
    applyGuildBuffLevel: (buffs, detail, level) => [
        ...(Array.isArray(buffs) ? buffs : []).filter((buff) => buff?.from !== detail?.hrid),
        { from: detail?.hrid, level },
    ],
    readGuildShrineLevels: () => ({ ...guild.levels }),
    readGuildShrineCaps: () => ({ ...guild.caps }),
    readGuildShrineSnapshot: () => ({ levels: { ...guild.levels }, ...guild.snapshot }),
    // The real one, not a stand-in: the level-gap tests below care about the
    // actual arithmetic, not just that some function got called.
    recomputeLevelGapDebuffs: (players) => {
        const list = Array.isArray(players) ? players.filter(Boolean) : [];
        if (!list.length) return;
        const levelOf = (p) =>
            combatLevel({
                stamina: p.staminaLevel,
                intelligence: p.intelligenceLevel,
                attack: p.attackLevel,
                defense: p.defenseLevel,
                melee: p.meleeLevel,
                ranged: p.rangedLevel,
                magic: p.magicLevel,
            }).exact;
        const gaps = partyLevelGaps(list.map(levelOf));
        list.forEach((player, index) => (player.debuffOnLevelGap = gaps[index] ?? 0));
    },
}));

// This bundle's own (direct-import) copy of the store. In the packaged build it
// is never fed by the websocket, so it answers empty — the bug this guards.
vi.mock('../combat/loadout-snapshot.js', () => ({
    default: { getAllSnapshots: () => [], resolveEquipment: () => [] },
}));

// Per-character settings, in memory: the loadout the editor last simmed with
// lives here, and nothing in this suite is about IndexedDB.
const settings = vi.hoisted(() => ({ values: new Map(), hold: null }));
vi.mock('../../utils/character-key.js', () => ({
    readScoped: async (base, storeName, defaultValue = null) => {
        // A read left open, so a test can land a character switch inside one
        if (settings.hold) await settings.hold;
        return settings.values.has(base) ? settings.values.get(base) : defaultValue;
    },
    writeScoped: async (base, value) => {
        settings.values.set(base, value);
    },
}));

// The fed store lives behind the bundle bridge; the picker must read it there.
const bridge = vi.hoisted(() => ({ snapshots: [], applied: [], mutate: null }));
vi.mock('../../utils/bundle-bridge.js', () => ({
    loadoutSnapshot: () => ({ getAllSnapshots: () => bridge.snapshots, resolveEquipment: () => [] }),
}));

// The game's View Loadout: whether this build has it, and what a fetch answers
const viewLoadout = vi.hoisted(() => ({
    available: false,
    fetches: [],
    result: null,
    captured: {},
    // A reply that must not settle until the test releases it, so a scenario
    // change can be made to land while the fetch is still out
    hang: false,
    pendingResolve: null,
}));
vi.mock('../../utils/view-loadout.js', () => ({
    VIEW_LOADOUT_CONTEXT: { Party: 'party', GuildTrial: 'guild_trial' },
    isViewLoadoutAvailable: () => viewLoadout.available,
    getLoadout: (id, context) => (context === 'party' ? (viewLoadout.captured[id] ?? null) : null),
    fetchLoadout: async (member, context, kind) => {
        viewLoadout.fetches.push({ member, context, kind });
        if (viewLoadout.hang) {
            return new Promise((resolve) => {
                viewLoadout.pendingResolve = () => resolve(viewLoadout.result);
            });
        }
        return viewLoadout.result;
    },
}));

const { SimEditor } = await import('./sim-editor.js');

const emptyDTO = (hrid) => ({
    hrid,
    equipment: {},
    food: [null, null, null],
    drinks: [null, null, null],
    abilities: [null, null, null, null, null],
    houseRooms: {},
    communityBuffLevels: {},
    attackLevel: 1,
    meleeLevel: 1,
    rangedLevel: 1,
    magicLevel: 1,
    defenseLevel: 1,
    staminaLevel: 1,
    intelligenceLevel: 1,
});

const PARTY_BTN = '[data-reset-players="party"]';

/** An editor with two imported strangers loaded and nothing of the player's own */
function editorWithStrangers() {
    const el = document.createElement('div');
    const editor = new SimEditor({ editorEl: el });
    editor.importPlayers([emptyDTO('x'), emptyDTO('y')], ['Stranger A', 'Stranger B']);
    return { el, editor };
}

beforeEach(() => {
    viewLoadout.available = false;
    viewLoadout.fetches = [];
    viewLoadout.result = null;
    viewLoadout.captured = {};
    viewLoadout.hang = false;
    viewLoadout.pendingResolve = null;
    bridge.snapshots = [];
    bridge.applied = [];
    bridge.mutate = null;
    settings.values.clear();
    settings.hold = null;
    guild.detailMap = {};
    guild.levels = {};
    guild.caps = {};
    guild.snapshot = { capturedAt: null, hydrated: false };
    game.charId = 'me';
    game.buildHold = null;
    game.characterData = { character: { id: 'me', name: 'Milkman' } };
    game.battleParty = null;
    game.selfDTO = { ...emptyDTO('player1'), attackLevel: 90, debuffOnLevelGap: 0.3 };
    game.houseRooms = null;
    game.buildExport = null;
    game.parseImport = null;
    game.allPlayers = {
        players: [
            { ...emptyDTO('player1'), attackLevel: 90 },
            { ...emptyDTO('player2'), attackLevel: 70 },
        ],
        playerInfo: [
            { hrid: 'player1', name: 'Milkman' },
            { hrid: 'player2', name: 'Partner' },
        ],
        selfHrid: 'player1',
        missingMembers: [],
    };
});

describe('house rooms follow the game', () => {
    test('a room built after the panel opened is read at the next run', () => {
        const { editor } = editorWithStrangers();
        game.selfDTO.houseRooms = { '/house_rooms/dojo': 2, '/house_rooms/garden': 8 };
        editor.resetToSelf();
        expect(editor.getEditedDTOs().player1.houseRooms['/house_rooms/dojo']).toBe(2);

        // The House tab builds Dojo 3 while the panel is open
        game.houseRooms = new Map([
            ['/house_rooms/dojo', { houseRoomHrid: '/house_rooms/dojo', level: 3 }],
            ['/house_rooms/garden', { houseRoomHrid: '/house_rooms/garden', level: 8 }],
        ]);
        expect(editor.getEditedDTOs().player1.houseRooms['/house_rooms/dojo']).toBe(3);
        expect(editor.getEditedDTOs().player1.houseRooms['/house_rooms/garden']).toBe(8);
    });

    test('a room the user edited by hand is theirs, whatever the game says', () => {
        const { editor } = editorWithStrangers();
        game.selfDTO.houseRooms = { '/house_rooms/dojo': 2 };
        editor.resetToSelf();
        // Hand-edited in the editor to a hypothetical 5
        editor.getEditedDTOs().player1.houseRooms['/house_rooms/dojo'] = 5;

        game.houseRooms = new Map([['/house_rooms/dojo', { houseRoomHrid: '/house_rooms/dojo', level: 3 }]]);
        expect(editor.getEditedDTOs().player1.houseRooms['/house_rooms/dojo']).toBe(5);
    });

    test("a character simmed from their profile keeps their house, not this player's", () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        const stranger = emptyDTO('player1');
        stranger.houseRooms = { '/house_rooms/dojo': 5, '/house_rooms/garden': 3 };
        editor.openWithExternalDTO(stranger, 'Venaam');

        // This player's own house says otherwise
        game.houseRooms = new Map([
            ['/house_rooms/dojo', { houseRoomHrid: '/house_rooms/dojo', level: 2 }],
            ['/house_rooms/garden', { houseRoomHrid: '/house_rooms/garden', level: 8 }],
        ]);

        const rooms = editor.getEditedDTOs().player1.houseRooms;
        expect(rooms['/house_rooms/dojo']).toBe(5);
        expect(rooms['/house_rooms/garden']).toBe(3);
    });
});

describe('reset to me', () => {
    test('replaces every imported player with the live character', () => {
        const { editor } = editorWithStrangers();
        expect(editor.getPlayerInfo()).toHaveLength(2);

        expect(editor.resetToSelf()).toBe(true);

        expect(editor.getPlayerInfo()).toEqual([{ hrid: 'player1', name: 'Milkman' }]);
        expect(Object.keys(editor.getEditedDTOs())).toEqual(['player1']);
        expect(editor.getSelfHrid()).toBe('player1');
    });

    test('reads the character now, not the snapshot the import left behind', () => {
        const { editor } = editorWithStrangers();
        // A level-up between opening the panel and pressing the button
        game.selfDTO.attackLevel = 99;

        editor.resetToSelf();

        expect(editor.getEditedDTOs().player1.attackLevel).toBe(99);
    });

    test('a solo character carries no level-gap debuff', () => {
        const { editor } = editorWithStrangers();

        editor.resetToSelf();

        expect(editor.getEditedDTOs().player1.debuffOnLevelGap).toBe(0);
    });

    test('the loadout dropdown goes back to current gear', () => {
        const { editor } = editorWithStrangers();
        editor._selectedLoadoutName = 'Bruteforce';

        editor.resetToSelf();

        expect(editor.getSelectedLoadoutName()).toBe('');
    });

    test('says so rather than blanking when there is no character to read', () => {
        const { el, editor } = editorWithStrangers();
        game.selfDTO = null;

        expect(editor.resetToSelf()).toBe(false);

        el.querySelector('[data-reset-players="self"]').click();
        expect(el.textContent).toContain('No character data available');
    });
});

describe('reset to party', () => {
    test('loads this character and the party members alongside them', async () => {
        const { editor } = editorWithStrangers();

        await editor.resetToParty();

        expect(editor.getPlayerInfo().map((p) => p.name)).toEqual(['Milkman', 'Partner']);
        expect(editor.getSelfHrid()).toBe('player1');
        expect(editor.getSelectedLoadoutName()).toBe('');
    });

    test('a member whose profile was never shared is named, not invented', async () => {
        const { el, editor } = editorWithStrangers();
        game.allPlayers.missingMembers = ['Ghost'];

        await editor.resetToParty();

        expect(el.textContent).toContain('Ghost');
        expect(el.textContent).toContain('shared profile');
        expect(editor.getMissingMembers()).toEqual(['Ghost']);
    });
});

describe('equipment an import could not place', () => {
    /**
     * The parse fails closed on an item the game's own sheet cannot resolve rather
     * than guessing its slot from the export's raw location string. Left to a
     * console warning, a dropped main hand reads on screen as a character who
     * simply fights unarmed.
     */
    const SKIPPED = [
        {
            slot: 1,
            itemHrid: '/items/unknown_blade',
            itemName: 'Unknown Blade',
            itemLocationHrid: '/item_locations/two_hand',
        },
    ];

    test('is named in the editor, not only in the console', () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });

        editor.importPlayers([emptyDTO('x')], ['Stranger A'], SKIPPED);

        expect(el.textContent).toContain('Unknown Blade');
        expect(el.textContent).toContain('Not equipped from the import');
    });

    test('says nothing when every piece resolved', () => {
        const { el } = editorWithStrangers();
        expect(el.textContent).not.toContain('Not equipped from the import');
    });

    /**
     * An import appends its players to whoever is already loaded, so the players
     * the first import brought in are still in the party after a second one. A
     * second import that placed everything must not therefore clear the note
     * about the first import's dropped gear — that is the hole back, silent
     * again, with the affected character still being simmed.
     */
    test("a second import does not clear the first import's note", () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        editor.importPlayers([emptyDTO('x')], ['Stranger A'], SKIPPED);

        editor.importPlayers([emptyDTO('y')], ['Stranger B'], []);

        expect(el.textContent).toContain('Unknown Blade');
    });

    test('the note does not survive a reset to the live character', () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        editor.importPlayers([emptyDTO('x')], ['Stranger A'], SKIPPED);

        editor.resetToSelf();

        expect(el.textContent).not.toContain('Not equipped from the import');
    });
});

describe('the reset buttons', () => {
    test('both sit beside the player chips', () => {
        const { el } = editorWithStrangers();

        expect(el.querySelector('[data-reset-players="self"]')).toBeTruthy();
        expect(el.querySelector('[data-reset-players="party"]')).toBeTruthy();
    });

    test('Reset to Party is disabled, with a reason, when there is no party', () => {
        const { el } = editorWithStrangers();

        const party = el.querySelector('[data-reset-players="party"]');
        expect(party.disabled).toBe(true);
        expect(party.getAttribute('title')).toContain('not in a party');
    });

    test('a party of one is not a party — that is what Reset to Me already does', () => {
        game.characterData.partyInfo = { partySlotMap: { 1: { characterID: 'me' } } };
        const { el, editor } = editorWithStrangers();

        expect(editor.hasPartyData()).toBe(false);
        expect(el.querySelector('[data-reset-players="party"]').disabled).toBe(true);
    });

    test('two filled slots enable it', () => {
        game.characterData.partyInfo = { partySlotMap: { 1: { characterID: 'me' }, 2: { characterID: 'them' } } };
        const { el, editor } = editorWithStrangers();

        expect(editor.hasPartyData()).toBe(true);
        expect(el.querySelector('[data-reset-players="party"]').disabled).toBe(false);
    });

    test('an emptied player list still offers the way back', () => {
        const { el, editor } = editorWithStrangers();
        el.querySelectorAll('[data-remove-player]').forEach((x) => x.click());

        expect(el.textContent).toContain('No players loaded');
        expect(el.querySelector('[data-reset-players="self"]')).toBeTruthy();

        el.querySelector('[data-reset-players="self"]').click();
        expect(editor.getPlayerInfo()).toEqual([{ hrid: 'player1', name: 'Milkman' }]);
    });
});

/**
 * The party the panel offers, and whether it is the party the player is in.
 *
 * The reported bug: a five-person party joined after the page loaded, and the
 * panel still listed the two characters from the previous session — because the
 * only party the client ever states is the one `init_character_data` carried.
 * The roster the last battle named moves, so the panel follows that instead, and
 * says which of the two it is reading.
 */
describe('a party joined after the page loaded', () => {
    test('enables Reset to Party without a reload', () => {
        // Logged in alone, so the frozen login map knows nothing about it
        const { el, editor } = editorWithStrangers();
        expect(editor.hasPartyData()).toBe(false);

        game.battleParty = [
            { characterID: 'me', characterName: 'Milkman' },
            { characterID: 'a', characterName: 'Ally' },
        ];
        editor.renderEditor();

        expect(editor.hasPartyData()).toBe(true);
        expect(el.querySelector(PARTY_BTN).disabled).toBe(false);
    });

    test('beats the stale login party rather than being merged with it', () => {
        game.characterData.partyInfo = {
            partySlotMap: { 1: { characterID: 'me' }, 2: { characterID: 'old' } },
        };
        game.battleParty = [{ characterID: 'me', characterName: 'Milkman' }];
        const { editor } = editorWithStrangers();

        expect(editor.hasPartyData()).toBe(false);
    });

    test('a party left while idle still disables the button once a solo fight lands', () => {
        game.characterData.partyInfo = {
            partySlotMap: { 1: { characterID: 'me' }, 2: { characterID: 'old' } },
        };
        const { el, editor } = editorWithStrangers();
        expect(el.querySelector(PARTY_BTN).disabled).toBe(false);

        game.battleParty = [{ characterID: 'me', characterName: 'Milkman' }];
        editor.renderEditor();

        expect(el.querySelector(PARTY_BTN).disabled).toBe(true);
        expect(el.querySelector(PARTY_BTN).getAttribute('title')).toContain('not in a party');
    });
});

describe('the panel says how fresh its party is', () => {
    test('a list loaded from the login party says so', async () => {
        game.characterData.partyInfo = {
            partySlotMap: { 1: { characterID: 'me' }, 2: { characterID: 'old' } },
        };
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        await editor.initEditor();

        expect(el.textContent).toContain('Party as of when the page loaded');
    });

    test('a list loaded from a battle roster says that instead', async () => {
        game.battleParty = [
            { characterID: 'me', characterName: 'Milkman' },
            { characterID: 'a', characterName: 'Ally' },
        ];
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        await editor.initEditor();

        expect(el.textContent).toContain('Party as of your last fight');
    });

    test('a party that moves under the loaded list is called out', async () => {
        game.characterData.partyInfo = {
            partySlotMap: { 1: { characterID: 'me' }, 2: { characterID: 'old' } },
        };
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        await editor.initEditor();
        expect(el.textContent).not.toContain('has changed since this list was loaded');

        game.battleParty = [
            { characterID: 'me', characterName: 'Milkman' },
            { characterID: 'a', characterName: 'Ally' },
            { characterID: 'b', characterName: 'Buddy' },
        ];

        // What reopening the panel calls — the loaded players are the user's
        // scenario, so the change is reported rather than applied behind them
        expect(editor.refreshFromGame()).toBe(true);
        expect(el.textContent).toContain('has changed since this list was loaded');
        expect(editor.getPlayerInfo()).toHaveLength(2);
    });

    test('a solo character is told nothing, because there is nothing to be stale', () => {
        const { el } = editorWithStrangers();

        expect(el.textContent).not.toContain('Party as of');
        expect(el.textContent).not.toContain('has changed since this list was loaded');
    });

    test('an import is not a party, so it is never accused of drifting from one', () => {
        game.battleParty = [
            { characterID: 'me', characterName: 'Milkman' },
            { characterID: 'a', characterName: 'Ally' },
        ];
        const { el } = editorWithStrangers();

        expect(el.textContent).not.toContain('has changed since this list was loaded');
    });

    test('a member with no shared profile still gets the Not loaded note', async () => {
        game.battleParty = [
            { characterID: 'me', characterName: 'Milkman' },
            { characterID: 'a', characterName: 'Ally' },
        ];
        game.allPlayers = { ...game.allPlayers, missingMembers: ['Ally'] };
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        await editor.initEditor();

        expect(el.textContent).toContain('Not loaded: Ally');
        expect(el.textContent).toContain('shared profile');
    });
});

describe('party profile ages', () => {
    const DAY = 24 * 60 * 60 * 1000;

    test('each loaded member shows how old their cached profile is, and a gearless one is called out', async () => {
        const now = Date.now();
        game.allPlayers = {
            ...game.allPlayers,
            players: [...game.allPlayers.players, { ...emptyDTO('player3'), attackLevel: 60 }],
            playerInfo: [...game.allPlayers.playerInfo, { hrid: 'player3', name: 'Shy' }],
            profileStatus: [
                { hrid: 'player2', name: 'Partner', found: true, capturedAt: now - 3 * DAY, gearless: false },
                { hrid: 'player3', name: 'Shy', found: true, capturedAt: null, gearless: true, hidden: true },
            ],
        };
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        await editor.initEditor();

        expect(el.textContent).toContain('Party profiles:');
        expect(el.textContent).toContain('Partner 3 d old');
        expect(el.textContent).toContain('Shy age unknown');
        expect(el.textContent).toContain('Shy: included with NO gear (their profile hides equipment)');
        expect(el.querySelector('[data-edit-tab="player2"]').getAttribute('title')).toBe('Profile 3 d old');
    });

    test('a member removed from the list takes their note with them', async () => {
        game.allPlayers = {
            ...game.allPlayers,
            profileStatus: [
                { hrid: 'player2', name: 'Partner', found: true, capturedAt: null, gearless: true, hidden: false },
            ],
        };
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        await editor.initEditor();
        expect(el.textContent).toContain('Partner: included with NO gear');

        editor._editedPlayerInfo = editor._editedPlayerInfo.filter((entry) => entry.hrid !== 'player2');
        delete editor._editedDTOs.player2;
        editor.renderEditor();

        expect(el.textContent).not.toContain('Party profiles:');
        expect(editor.getProfileStatus()).toEqual([]);
    });

    test('resetting to self forgets the party notes', async () => {
        game.allPlayers = {
            ...game.allPlayers,
            profileStatus: [{ hrid: 'player2', name: 'Partner', found: true, capturedAt: Date.now(), gearless: false }],
        };
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        await editor.initEditor();
        expect(el.textContent).toContain('Partner 1 min old');

        editor.resetToSelf();
        expect(el.textContent).not.toContain('Party profiles:');
    });
});

describe('community buff levels stop where the game does', () => {
    test('the input offers 20, which is what a maxed buff reads in game', () => {
        const editor = new SimEditor({ editorEl: document.createElement('div'), skillingMode: true });

        const html = editor._renderCommunityBuffsSection({ communityBuffLevels: { experience: 12 } });

        expect(html).toContain('max="20"');
        expect(html).not.toContain('max="30"');
    });

    test('a typed level above the cap is clamped to it', () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el, skillingMode: true });
        el.innerHTML = '<input type="number" data-community-buff="experience" value="30">';
        const dto = { communityBuffLevels: {} };

        editor._wireEditorEvents(el, dto);
        const input = el.querySelector('[data-community-buff]');
        input.dispatchEvent(new Event('change'));

        expect(dto.communityBuffLevels.experience).toBe(20);
        expect(input.value).toBe('20');
    });
});

describe('loadout picker reads the fed store, not this bundle', () => {
    test('renders the dropdown from the bridge store even when this bundle owns an empty copy', () => {
        // The direct import (mocked empty above) is the packaged bundle's own,
        // never-fed copy; a naive read of it hides the picker. The picker must
        // list what the bridge store — the one the websocket feeds — actually has.
        bridge.snapshots = [
            { name: 'Bruteforce', actionTypeHrid: '/action_types/combat' },
            { name: 'Everything', actionTypeHrid: null },
        ];
        const { el } = editorWithStrangers();

        const select = el.querySelector('#mwi-csim-loadout-select');
        expect(select).toBeTruthy();
        expect(select.textContent).toContain('Bruteforce');
        expect(select.textContent).toContain('Everything (All Skills)');
    });

    test('a non-combat loadout is filtered out of the combat picker', () => {
        bridge.snapshots = [{ name: 'Milking', actionTypeHrid: '/action_types/milking' }];
        const { el } = editorWithStrangers();

        // Only a skilling loadout exists, so there is nothing combat to pick.
        expect(el.querySelector('#mwi-csim-loadout-select')).toBeFalsy();
    });

    test('no picker when the fed store has no loadouts at all', () => {
        const { el } = editorWithStrangers();
        expect(el.querySelector('#mwi-csim-loadout-select')).toBeFalsy();
    });
});

/**
 * The Loadout dropdown reset to "Current Gear" every time the panel opened, so a
 * character who sims one build reselected it on every run. The selection is
 * remembered per character and re-applied through the same path a manual pick
 * takes — and only for this character's own DTO.
 */
describe('the editor is built for one character', () => {
    test('a switch inside the DTO build leaves the editor unbuilt rather than holding the wrong gear', async () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });

        let release;
        game.buildHold = new Promise((resolve) => {
            release = resolve;
        });
        const building = editor.initEditor();
        game.charId = 'iron';
        game.buildHold = null;
        release();
        await building;

        // Adopting would have left the departing character's gear, levels and
        // house in the panel, with nothing to rebuild it — and a sim run from
        // there reports another character's numbers as a measurement
        expect(editor._editorInitialized).toBe(false);
        expect(editor._editedDTOs).toBeNull();

        // and the next build, for whoever is current, still works
        await editor.initEditor();
        expect(editor._editorInitialized).toBe(true);
    });

    test('a scenario adopted while a party rebuild is out is not overwritten by it', async () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        await editor.initEditor({ restoreLoadout: false });

        let release;
        game.buildHold = new Promise((resolve) => {
            release = resolve;
        });
        const rebuilding = editor.resetToParty();
        // The user imports players while the party build is still out
        editor.importPlayers([emptyDTO('stranger1')], ['Stranger A']);
        // Keys, not names: the mocked build hands back the very playerInfo array
        // the editor holds, so the import's push would show up in either case
        const importedKeys = Object.keys(editor._editedDTOs).sort();
        game.buildHold = null;
        release();
        await rebuilding;

        expect(importedKeys).toHaveLength(3);
        expect(Object.keys(editor._editedDTOs).sort()).toEqual(importedKeys);
    });

    test('a build with no character logged in either side is still adopted', async () => {
        // The guard compares the id, it does not require one: a pre-login
        // build must not be refused for having none
        game.charId = null;
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });

        await editor.initEditor();

        expect(editor._editorInitialized).toBe(true);
    });
});

describe('the loadout selection is remembered', () => {
    const openEditor = async (options = {}) => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el, ...options });
        await editor.initEditor();
        return { el, editor };
    };

    test('picking one stores it, and the next opening applies it', async () => {
        bridge.snapshots = [{ name: 'Bruteforce', actionTypeHrid: '/action_types/combat' }];
        const first = await openEditor();
        const select = first.el.querySelector('#mwi-csim-loadout-select');
        select.value = 'Bruteforce';
        select.dispatchEvent(new Event('change'));
        await Promise.resolve();

        const { el, editor } = await openEditor();

        expect(editor.getSelectedLoadoutName()).toBe('Bruteforce');
        expect(bridge.applied).toContain('Bruteforce');
        expect(el.querySelector('#mwi-csim-loadout-select').value).toBe('Bruteforce');
    });

    test('a loadout that no longer exists falls back to current gear, silently', async () => {
        settings.values.set('simEditorLoadoutName', 'Deleted');
        bridge.snapshots = [{ name: 'Bruteforce', actionTypeHrid: '/action_types/combat' }];

        const { editor } = await openEditor();

        expect(editor.getSelectedLoadoutName()).toBe('');
    });

    test('a pick whose snapshot is gone is not recorded or remembered', async () => {
        bridge.snapshots = [{ name: 'Bruteforce', actionTypeHrid: '/action_types/combat' }];
        const { el, editor } = await openEditor();
        // Deleted between the render and the pick: the option is still in the DOM
        bridge.snapshots = [];

        const select = el.querySelector('#mwi-csim-loadout-select');
        select.value = 'Bruteforce';
        select.dispatchEvent(new Event('change'));
        await Promise.resolve();

        expect(editor.getSelectedLoadoutName()).toBe('');
        expect(editor.getLoadoutNameFor('player1')).toBe('');
        expect(settings.values.get('simEditorLoadoutName')).toBeUndefined();
    });

    test('a worn loadout that is no longer saved is shown, not passed off as Current Gear', async () => {
        bridge.snapshots = [
            { name: 'Alpha', actionTypeHrid: '/action_types/combat' },
            { name: 'Bravo', actionTypeHrid: '/action_types/combat' },
        ];
        const { el, editor } = await openEditor();
        const pick = async (name) => {
            const select = el.querySelector('#mwi-csim-loadout-select');
            select.value = name;
            select.dispatchEvent(new Event('change'));
            await Promise.resolve();
        };
        await pick('Alpha');

        bridge.snapshots = [{ name: 'Bravo', actionTypeHrid: '/action_types/combat' }];
        editor.renderEditor();

        const select = el.querySelector('#mwi-csim-loadout-select');
        expect(select.querySelector('option[selected]').value).toBe('Alpha');
        expect(select.querySelector('option[selected]').textContent).toBe('Alpha (no longer saved)');
        expect(editor.getLoadoutNameFor('player1')).toBe('Alpha');

        // Another pick from there works as normal and drops the stale entry
        await pick('Bravo');
        expect(editor.getLoadoutNameFor('player1')).toBe('Bravo');
        expect(el.querySelector('#mwi-csim-loadout-select').textContent).not.toContain('no longer saved');
    });

    test('the no-longer-saved entry escapes the name and Current Gear still reverts', async () => {
        const odd = 'A"<b>x';
        bridge.snapshots = [
            { name: odd, actionTypeHrid: '/action_types/combat' },
            { name: 'Bravo', actionTypeHrid: '/action_types/combat' },
        ];
        const { el, editor } = await openEditor();
        editor.applyLoadoutByName(odd);
        bridge.snapshots = [{ name: 'Bravo', actionTypeHrid: '/action_types/combat' }];
        editor.renderEditor();

        const select = el.querySelector('#mwi-csim-loadout-select');
        expect(select.querySelector('option[selected]').value).toBe(odd);
        expect(select.querySelector('b')).toBeNull();

        select.value = '';
        select.dispatchEvent(new Event('change'));
        await Promise.resolve();
        expect(editor.getLoadoutNameFor('player1')).toBe('');
        expect(el.querySelector('#mwi-csim-loadout-select').value).toBe('');
    });

    test('a loadout whose name has a quote and a bracket can be selected and applied', async () => {
        const odd = 'Q"<i>x';
        bridge.snapshots = [{ name: odd, actionTypeHrid: '/action_types/combat' }];
        const { el, editor } = await openEditor();

        const select = el.querySelector('#mwi-csim-loadout-select');
        expect(select.querySelector('i')).toBeNull();
        select.value = odd;
        select.dispatchEvent(new Event('change'));
        await Promise.resolve();

        expect(bridge.applied).toContain(odd);
        expect(editor.getSelectedLoadoutName()).toBe(odd);
    });

    test('the picker stays when every combat loadout was deleted but one is still worn', async () => {
        bridge.snapshots = [{ name: 'Alpha', actionTypeHrid: '/action_types/combat' }];
        const { el, editor } = await openEditor();
        editor.applyLoadoutByName('Alpha');
        bridge.snapshots = [];
        editor.renderEditor();

        const select = el.querySelector('#mwi-csim-loadout-select');
        expect(select).toBeTruthy();
        expect(select.querySelector('option[selected]').textContent).toBe('Alpha (no longer saved)');

        select.value = '';
        select.dispatchEvent(new Event('change'));
        await Promise.resolve();
        expect(editor.getLoadoutNameFor('player1')).toBe('');
        expect(el.querySelector('#mwi-csim-loadout-select')).toBeFalsy();
    });

    test('going back to Current Gear is remembered too', async () => {
        settings.values.set('simEditorLoadoutName', 'Bruteforce');
        bridge.snapshots = [{ name: 'Bruteforce', actionTypeHrid: '/action_types/combat' }];
        const { el, editor } = await openEditor();
        expect(editor.getSelectedLoadoutName()).toBe('Bruteforce');

        const select = el.querySelector('#mwi-csim-loadout-select');
        select.value = '';
        select.dispatchEvent(new Event('change'));
        await Promise.resolve();

        expect(settings.values.get('simEditorLoadoutName')).toBe('');
    });

    test('an imported or profile-simmed stranger keeps their own gear', async () => {
        // `_selfHrid` is null for an external DTO, which is what says the stored
        // loadout is not theirs to wear
        settings.values.set('simEditorLoadoutName', 'Bruteforce');
        bridge.snapshots = [{ name: 'Bruteforce', actionTypeHrid: '/action_types/combat' }];
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        editor.openWithExternalDTO(emptyDTO('them'), 'Stranger');

        await editor._restoreLoadoutMemory();

        expect(editor.getSelectedLoadoutName()).toBe('');
        expect(bridge.applied).toEqual([]);
    });

    test('a switch inside the read leaves the arriving character’s editor alone', async () => {
        settings.values.set('simEditorLoadoutName', 'Bruteforce');
        bridge.snapshots = [{ name: 'Bruteforce', actionTypeHrid: '/action_types/combat' }];
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        await editor.initEditor({ restoreLoadout: false });

        let release;
        settings.hold = new Promise((resolve) => {
            release = resolve;
        });
        const restoring = editor._restoreLoadoutMemory();
        game.charId = 'iron';
        settings.hold = null;
        release();
        await restoring;

        // Applying it would have simmed the arriving character in the departing
        // one's gear, and stored that name as the arriving character's memory
        expect(editor.getSelectedLoadoutName()).toBe('');
        expect(bridge.applied).toEqual([]);
    });

    test('the lab editor drives the dropdown itself and is left out', async () => {
        settings.values.set('simEditorLoadoutName', 'Bruteforce');
        bridge.snapshots = [{ name: 'Bruteforce', actionTypeHrid: '/action_types/combat' }];

        const { editor } = await openEditor({ labMode: true });

        expect(editor.getSelectedLoadoutName()).toBe('');
        expect(bridge.applied).toEqual([]);
    });

    test('Reset to Current forgets it, so the next opening is current gear', async () => {
        settings.values.set('simEditorLoadoutName', 'Bruteforce');
        bridge.snapshots = [{ name: 'Bruteforce', actionTypeHrid: '/action_types/combat' }];
        const { editor } = await openEditor();

        editor.resetToSelf();
        await Promise.resolve();

        expect(settings.values.get('simEditorLoadoutName')).toBe('');
    });

    test('a loadout that legitimately differs from current gear is not marked edited', async () => {
        // The mocked apply mutates the DTO the way the real one would — the
        // loadout's main hand differs from current gear's (none)
        bridge.snapshots = [{ name: 'Bruteforce', actionTypeHrid: '/action_types/combat' }];
        bridge.mutate = (dto) => {
            dto.equipment = {
                ...dto.equipment,
                '/equipment_types/main_hand': { hrid: '/items/steel_sword', enhancementLevel: 5 },
            };
        };
        const { el, editor } = await openEditor();

        const select = el.querySelector('#mwi-csim-loadout-select');
        select.value = 'Bruteforce';
        select.dispatchEvent(new Event('change'));
        await Promise.resolve();

        // Selecting the loadout alone must not read as an edit: the label is
        // just the loadout's name, with no diff appended
        expect(editor.generateSimLabel()).toBe('Bruteforce');
    });

    test('a hand edit made after selecting a loadout still shows in the label', async () => {
        bridge.snapshots = [{ name: 'Bruteforce', actionTypeHrid: '/action_types/combat' }];
        bridge.mutate = (dto) => {
            dto.equipment = {
                ...dto.equipment,
                '/equipment_types/main_hand': { hrid: '/items/steel_sword', enhancementLevel: 5 },
            };
        };
        const { el, editor } = await openEditor();

        const select = el.querySelector('#mwi-csim-loadout-select');
        select.value = 'Bruteforce';
        select.dispatchEvent(new Event('change'));
        await Promise.resolve();

        // A change made after the loadout was applied is a real edit, on top
        // of the loadout the plan was picked from
        editor.getEditedDTOs().player1.attackLevel = 123;

        const label = editor.generateSimLabel();
        expect(label).not.toBe('Bruteforce');
        expect(label).toContain('Bruteforce');
    });

    test('a loadout applied on self is not claimed by another member’s Solo label', async () => {
        // The selection is panel-wide, the application per player: player2
        // never wore it, so its label and metadata must not name it
        bridge.snapshots = [{ name: 'Bruteforce', actionTypeHrid: '/action_types/combat' }];
        bridge.mutate = (dto) => {
            dto.equipment = {
                ...dto.equipment,
                '/equipment_types/main_hand': { hrid: '/items/steel_sword', enhancementLevel: 5 },
            };
        };
        const { el, editor } = await openEditor();

        const select = el.querySelector('#mwi-csim-loadout-select');
        select.value = 'Bruteforce';
        select.dispatchEvent(new Event('change'));
        await Promise.resolve();

        expect(editor.getLoadoutNameFor('player1')).toBe('Bruteforce');
        expect(editor.getLoadoutNameFor('player2')).toBe('');
        expect(editor.generateSimLabel('player2')).not.toContain('Bruteforce');
    });

    test('each player keeps the name of the loadout it actually wore', async () => {
        // A applied on player1, then B on player2: the panel-wide selection
        // says B, but player1's Solo run wore A
        bridge.snapshots = [
            { name: 'Alpha', actionTypeHrid: '/action_types/combat' },
            { name: 'Bravo', actionTypeHrid: '/action_types/combat' },
        ];
        const { el, editor } = await openEditor();
        const pick = async (name) => {
            const select = el.querySelector('#mwi-csim-loadout-select');
            select.value = name;
            select.dispatchEvent(new Event('change'));
            await Promise.resolve();
        };

        await pick('Alpha');
        editor._activeEditPlayer = 'player2';
        await pick('Bravo');

        expect(editor.getLoadoutNameFor('player1')).toBe('Alpha');
        expect(editor.getLoadoutNameFor('player2')).toBe('Bravo');
    });

    test('a Current Gear pick on another tab does not hide a loadout this player still wears', async () => {
        // Alpha applied to player1, then player2's dropdown set to Current
        // Gear: that clears the panel-wide selection but player1's DTO still
        // wears Alpha, so a per-sweep Current Gear pick for player1 must see it
        bridge.snapshots = [{ name: 'Alpha', actionTypeHrid: '/action_types/combat' }];
        const { el, editor } = await openEditor();
        const pick = async (name) => {
            const select = el.querySelector('#mwi-csim-loadout-select');
            select.value = name;
            select.dispatchEvent(new Event('change'));
            await Promise.resolve();
        };

        await pick('Alpha');
        editor._activeEditPlayer = 'player2';
        editor.renderEditor();
        await pick('');

        expect(editor.getSelectedLoadoutName()).toBe('');
        expect(editor.getLoadoutNameFor('player1')).toBe('Alpha');
        expect(editor.getLoadoutNameFor('player2')).toBe('');

        // Back on player1's tab the dropdown shows what that tab wears
        editor._activeEditPlayer = 'player1';
        editor.renderEditor();
        expect(el.querySelector('#mwi-csim-loadout-select').value).toBe('Alpha');
    });

    test('opening an external build forgets the previous scenario’s applied loadouts', async () => {
        // A leftover record for player1 would label the unrelated external
        // build with the old loadout
        bridge.snapshots = [{ name: 'Alpha', actionTypeHrid: '/action_types/combat' }];
        const { el, editor } = await openEditor();
        const select = el.querySelector('#mwi-csim-loadout-select');
        select.value = 'Alpha';
        select.dispatchEvent(new Event('change'));
        await Promise.resolve();
        expect(editor.getLoadoutNameFor('player1')).toBe('Alpha');

        editor.openWithExternalDTO(emptyDTO('them'), 'Stranger');

        expect(editor.getSelectedLoadoutName()).toBe('');
        expect(editor.getLoadoutNameFor('player1')).toBe('');
    });

    test('a player reverted to current gear no longer claims the loadout it dropped', async () => {
        // player1 wears Alpha, goes back to Current Gear, then player2 takes
        // Bravo: the selection is non-empty again, but player1 wears nothing
        bridge.snapshots = [
            { name: 'Alpha', actionTypeHrid: '/action_types/combat' },
            { name: 'Bravo', actionTypeHrid: '/action_types/combat' },
        ];
        const { el, editor } = await openEditor();
        const pick = async (name) => {
            const select = el.querySelector('#mwi-csim-loadout-select');
            select.value = name;
            select.dispatchEvent(new Event('change'));
            await Promise.resolve();
        };

        await pick('Alpha');
        await pick('');
        editor._activeEditPlayer = 'player2';
        await pick('Bravo');

        expect(editor.getLoadoutNameFor('player1')).toBe('');
        expect(editor.getLoadoutNameFor('player2')).toBe('Bravo');
    });

    test('an edit made before selecting a loadout, to a field it does not replace, still shows', async () => {
        // The loadout replaces the main hand; defense is a what-if edit the
        // loadout leaves alone, so it must not be absorbed into the baseline
        // the label diffs against
        bridge.snapshots = [{ name: 'Bruteforce', actionTypeHrid: '/action_types/combat' }];
        bridge.mutate = (dto) => {
            dto.equipment = {
                ...dto.equipment,
                '/equipment_types/main_hand': { hrid: '/items/steel_sword', enhancementLevel: 5 },
            };
        };
        const { el, editor } = await openEditor();

        editor.getEditedDTOs().player1.defenseLevel = 7;

        const select = el.querySelector('#mwi-csim-loadout-select');
        select.value = 'Bruteforce';
        select.dispatchEvent(new Event('change'));
        await Promise.resolve();

        expect(editor.generateSimLabel()).toContain('Defense');
    });
});

/**
 * The panel-wide Loadout dropdown is applied to whichever player is self
 * (or, with no self, the active tab) — see getLoadoutNameFor(). Replacing
 * that same player's build must not leave the dropdown still claiming they
 * wear a loadout the fresh import never had; replacing someone else must
 * leave it alone, since it still describes self's own untouched build.
 */
describe('replacing the loadout-selected player clears the panel-wide selection', () => {
    test('replacing the self player who wears the selected loadout resets it to Current Gear', () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        editor.resetToSelf(); // self = active = player1
        editor._selectedLoadoutName = 'Bruteforce';

        editor.replacePlayer('player1', emptyDTO('ignored'), 'Fresh Build');

        expect(editor.getSelectedLoadoutName()).toBe('');
    });

    test('replacing a different party member leaves the selection alone', () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        editor.importPlayers([emptyDTO('player1'), emptyDTO('player2')], ['A', 'B']);
        editor._selfHrid = 'player1';
        editor._selectedLoadoutName = 'Bruteforce';

        editor.replacePlayer('player2', emptyDTO('ignored'), 'Fresh B');

        expect(editor.getSelectedLoadoutName()).toBe('Bruteforce');
    });

    test('with no self player, replacing the active tab (which the dropdown then applies to) clears it too', () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        editor.importPlayers([emptyDTO('player1'), emptyDTO('player2')], ['A', 'B']);
        // No self — the dropdown applies to whichever tab is active, which
        // importPlayers left on the last-added player
        expect(editor.getSelfHrid()).toBeNull();
        expect(editor.getActiveEditPlayer()).toBe('player2');
        editor._selectedLoadoutName = 'Bruteforce';

        editor.replacePlayer('player2', emptyDTO('ignored'), 'Fresh B');

        expect(editor.getSelectedLoadoutName()).toBe('');
    });
});

/**
 * The same panel-wide-selection hygiene replacePlayer got, for the ×
 * remove-player button: removing whichever player the Loadout dropdown
 * currently applies to (self, or the active tab with no self) must not
 * leave the dropdown claiming a build that no longer exists to wear it.
 */
describe('removing the loadout-selected player clears the panel-wide selection', () => {
    test('removing the self player who wears the selected loadout resets it to Current Gear', () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        editor.resetToSelf(); // self = active = player1
        editor.importPlayers([emptyDTO('player2')], ['B']); // a second player so the roster survives the removal
        editor._selfHrid = 'player1';
        editor._selectedLoadoutName = 'Bruteforce';
        editor.renderEditor();

        el.querySelector('[data-remove-player="player1"]').click();

        expect(editor.getSelectedLoadoutName()).toBe('');
    });

    test('removing a different party member leaves the selection alone', () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        editor.importPlayers([emptyDTO('player1'), emptyDTO('player2')], ['A', 'B']);
        editor._selfHrid = 'player1';
        editor._selectedLoadoutName = 'Bruteforce';
        editor.renderEditor();

        el.querySelector('[data-remove-player="player2"]').click();

        expect(editor.getSelectedLoadoutName()).toBe('Bruteforce');
    });

    test('with no self player, removing the active tab (which the dropdown then applies to) clears it too', () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        editor.importPlayers([emptyDTO('player1'), emptyDTO('player2')], ['A', 'B']);
        expect(editor.getSelfHrid()).toBeNull();
        expect(editor.getActiveEditPlayer()).toBe('player2');
        editor._selectedLoadoutName = 'Bruteforce';

        el.querySelector('[data-remove-player="player2"]').click();

        expect(editor.getSelectedLoadoutName()).toBe('');
    });

    test('removing the last player (emptying the roster) also clears it', () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        editor.resetToSelf(); // self = active = player1, the only player loaded
        editor._selectedLoadoutName = 'Bruteforce';

        el.querySelector('[data-remove-player="player1"]').click();

        expect(editor.getSelectedLoadoutName()).toBe('');
    });
});

/**
 * The self/active guess `wasLoadoutTarget` used to make is wrong once a
 * self-loaded player has switched tabs, applied the loadout to a *different*
 * party member's build there, and switched back — the dropdown then targets
 * that other tab, not self. `getLoadoutNameFor` (backed by
 * `_loadoutAppliedNames`, the map `_applyLoadoutToDTO` actually writes to)
 * knows the real target regardless of which tab is active when the player
 * is later replaced or removed.
 */
describe('the loadout target can be a non-self tab, even with self loaded', () => {
    test('replacing the tab the loadout was actually applied to clears the selection', () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        editor.importPlayers([emptyDTO('player1'), emptyDTO('player2')], ['A', 'B']);
        editor._selfHrid = 'player1';
        bridge.snapshots = [{ name: 'Bruteforce', actionTypeHrid: '/action_types/combat' }];
        // Apply the loadout while player2's tab is active — self stays player1
        editor._activeEditPlayer = 'player2';
        editor.applyLoadoutByName('Bruteforce');
        expect(editor.getLoadoutNameFor('player2')).toBe('Bruteforce');
        // Switch back to self's own tab before replacing player2, as a user
        // checking someone else's build then returning to their own would
        editor._activeEditPlayer = 'player1';

        editor.replacePlayer('player2', emptyDTO('ignored'), 'Fresh B');

        expect(editor.getSelectedLoadoutName()).toBe('');
    });

    test('removing that same tab also clears the selection', () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        editor.importPlayers([emptyDTO('player1'), emptyDTO('player2')], ['A', 'B']);
        editor._selfHrid = 'player1';
        bridge.snapshots = [{ name: 'Bruteforce', actionTypeHrid: '/action_types/combat' }];
        editor._activeEditPlayer = 'player2';
        editor.applyLoadoutByName('Bruteforce');
        editor._activeEditPlayer = 'player1';
        editor.renderEditor();

        el.querySelector('[data-remove-player="player2"]').click();

        expect(editor.getSelectedLoadoutName()).toBe('');
    });

    test('replacing self while the loadout targets the other tab leaves the selection alone', () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        editor.importPlayers([emptyDTO('player1'), emptyDTO('player2')], ['A', 'B']);
        editor._selfHrid = 'player1';
        bridge.snapshots = [{ name: 'Bruteforce', actionTypeHrid: '/action_types/combat' }];
        editor._activeEditPlayer = 'player2';
        editor.applyLoadoutByName('Bruteforce');
        editor._activeEditPlayer = 'player1';

        editor.replacePlayer('player1', emptyDTO('ignored'), 'Fresh A');

        expect(editor.getSelectedLoadoutName()).toBe('Bruteforce');
    });
});

function engineAchievementTypes(dto) {
    const off = new Set(dto.achievementBuffsOff);
    return dto.achievementCombatBuffs.map((b) => b.typeHrid).filter((t) => !off.has(t));
}

describe('achievements section', () => {
    const damage = { typeHrid: '/buff_types/damage', ratioBoost: 0.02 };
    const wisdom = { typeHrid: '/buff_types/wisdom', flatBoost: 0.05 };

    test('lists the detected achievement buffs, all ticked by default', () => {
        const editor = new SimEditor({ editorEl: document.createElement('div') });

        const html = editor._renderAchievementsSection({ achievementCombatBuffs: [damage, wisdom] });

        expect(html).toContain('data-achievement-buff="/buff_types/damage"');
        expect(html).toContain('Damage +2%');
        expect(html).toContain('data-achievement-buff="/buff_types/wisdom"');
        expect(html).toMatch(/data-achievement-buff="\/buff_types\/damage" checked/);
        expect(html).toContain('2 active');
    });

    test('a toggled-off buff renders unchecked and drops the active count', () => {
        const editor = new SimEditor({ editorEl: document.createElement('div') });

        const html = editor._renderAchievementsSection({
            achievementCombatBuffs: [damage, wisdom],
            achievementBuffsOff: ['/buff_types/damage'],
        });

        expect(html).not.toMatch(/data-achievement-buff="\/buff_types\/damage" checked/);
        expect(html).toMatch(/data-achievement-buff="\/buff_types\/wisdom" checked/);
        expect(html).toContain('1 active');
    });

    test('a player with no achievement buffs still gets the scenario section, every tier unticked', () => {
        const editor = new SimEditor({ editorEl: document.createElement('div') });
        const html = editor._renderAchievementsSection({ achievementCombatBuffs: [] });
        expect(html).toContain('data-achievement-mode="custom"');
        expect(html).toContain('0 active');
        expect(html).not.toMatch(/data-achievement-buff="[^"]+" checked/);
    });

    test('a derived import captions itself as derived from achievements', () => {
        const editor = new SimEditor({ editorEl: document.createElement('div') });
        const html = editor._renderAchievementsSection({
            achievementCombatBuffs: [damage, wisdom],
            achievementBuffsOff: ['/buff_types/damage'],
            achievementBuffsDerived: true,
        });
        expect(html).toContain('Derived from their completed achievements — adjust if needed.');
    });

    test('a manual import (no derivation) keeps the "set manually" caption', () => {
        const editor = new SimEditor({ editorEl: document.createElement('div') });
        const html = editor._renderAchievementsSection({
            achievementCombatBuffs: [damage, wisdom],
            achievementBuffsOff: ['/buff_types/damage', '/buff_types/wisdom'],
            achievementBuffsManual: true,
        });
        expect(html).toContain('Not in shared profiles — set manually.');
    });

    test('your own character keeps the live-detected caption', () => {
        const editor = new SimEditor({ editorEl: document.createElement('div') });
        const html = editor._renderAchievementsSection({ achievementCombatBuffs: [damage, wisdom] });
        expect(html).toContain('From your completed achievements. Untick to sim without one.');
    });

    test('the skilling tab hides it', () => {
        const editor = new SimEditor({ editorEl: document.createElement('div'), skillingMode: true });
        expect(editor._renderAchievementsSection({ achievementCombatBuffs: [damage] })).toBe('');
    });

    test('unticking excludes the buff; re-ticking restores it', () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        el.innerHTML =
            '<input type="checkbox" data-achievement-buff="/buff_types/damage" checked>' +
            '<input type="checkbox" data-achievement-buff="/buff_types/wisdom" checked>';
        const dto = { achievementCombatBuffs: [damage, wisdom], achievementBuffsOff: [] };

        editor._wireEditorEvents(el, dto);
        const dmg = el.querySelector('[data-achievement-buff="/buff_types/damage"]');
        dmg.checked = false;
        dmg.dispatchEvent(new Event('change'));

        expect(dto.achievementBuffsOff).toContain('/buff_types/damage');
        expect(dto.achievementBuffsOff).not.toContain('/buff_types/wisdom');
        expect(editor.getAchievementMode(dto)).toBe('custom');

        dmg.checked = true;
        dmg.dispatchEvent(new Event('change'));
        expect(dto.achievementBuffsOff).not.toContain('/buff_types/damage');
    });

    test('Current, None and Custom resolve the buff set from the loaded player', () => {
        const editor = new SimEditor({ editorEl: document.createElement('div') });
        const loaded = { hrid: 'player1', achievementCombatBuffs: [damage], achievementBuffsOff: [] };
        editor._originalDTOs = { player1: loaded };
        const dto = structuredClone(loaded);
        editor._editedDTOs = { player1: dto };
        const granted = () => engineAchievementTypes(dto);

        editor.setAchievementScenario(dto, 'none');
        expect(granted()).toEqual([]);
        expect(editor.getAchievementMode(dto)).toBe('none');

        // Custom from the button starts from what the player has right now
        editor.setAchievementScenario(dto, 'current');
        editor.setAchievementScenario(dto, 'custom');
        expect(granted()).toEqual(['/buff_types/damage']);

        // A tier the player has not finished can be switched on
        editor.setAchievementScenario(dto, 'custom', ['/buff_types/damage', '/buff_types/rare_find']);
        expect(granted().sort()).toEqual(['/buff_types/damage', '/buff_types/rare_find']);

        editor.setAchievementScenario(dto, 'current');
        expect(granted()).toEqual(['/buff_types/damage']);
        expect(dto.achievementScenario).toBeUndefined();
        expect(editor.getAchievementMode(dto)).toBe('current');
    });
});

describe('scrolls section', () => {
    test('offers the combat scrolls and pre-checks the ones the player carries', () => {
        const editor = new SimEditor({ editorEl: document.createElement('div') });

        const html = editor._renderScrollsSection({ scrollBuffs: ['/buff_types/damage'] });

        // DPS/loot scrolls and the two dual-purpose ones (wisdom, rare find)
        expect(html).toContain('data-scroll-buff="/buff_types/damage"');
        expect(html).toContain('data-scroll-buff="/buff_types/attack_speed"');
        expect(html).toContain('data-scroll-buff="/buff_types/critical_rate"');
        expect(html).toContain('data-scroll-buff="/buff_types/wisdom"');
        expect(html).toContain('data-scroll-buff="/buff_types/rare_find"');
        // damage is carried, attack speed is not
        expect(html).toMatch(/data-scroll-buff="\/buff_types\/damage" checked/);
        expect(html).not.toMatch(/data-scroll-buff="\/buff_types\/attack_speed" checked/);
        expect(html).toContain('1 active');
    });

    test('the skilling tab hides it — its scroll picker lives elsewhere', () => {
        const editor = new SimEditor({ editorEl: document.createElement('div'), skillingMode: true });
        expect(editor._renderScrollsSection({ scrollBuffs: [] })).toBe('');
    });

    test('ticking a scroll adds it to the DTO; unticking removes it', () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        el.innerHTML =
            '<input type="checkbox" data-scroll-buff="/buff_types/rare_find">' +
            '<input type="checkbox" data-scroll-buff="/buff_types/wisdom" checked>';
        const dto = { scrollBuffs: ['/buff_types/wisdom'] };

        editor._wireEditorEvents(el, dto);
        const rareFind = el.querySelector('[data-scroll-buff="/buff_types/rare_find"]');
        rareFind.checked = true;
        rareFind.dispatchEvent(new Event('change'));

        expect(dto.scrollBuffs).toContain('/buff_types/rare_find');
        expect(dto.scrollBuffs).toContain('/buff_types/wisdom');

        const wisdom = el.querySelector('[data-scroll-buff="/buff_types/wisdom"]');
        wisdom.checked = false;
        wisdom.dispatchEvent(new Event('change'));

        expect(dto.scrollBuffs).toEqual(['/buff_types/rare_find']);
    });
});

/**
 * Guild shrines in the Configure tab.
 *
 * Two separate numbers live on one row and are easy to confuse: the level
 * *this character* has purchased (the input) and the level the *guild* has
 * built the shrine to (the cap beside it, which is not theirs to set).
 *
 * The freshness half is the reported bug: upgrade the shrines, open the sim,
 * see the old levels, click "Reset to Me", see the new ones. Opening the panel
 * does not rebuild an editor that already exists, so nothing re-read the live
 * levels. It does now — but only for values nobody has edited, because a level
 * typed in by hand is a what-if the user built and has no undo.
 */
describe('guild shrines', () => {
    const FORCE = '/guild_buffs/force_combat';
    const RARITY = '/guild_buffs/rarity_combat';

    const withShrines = () => {
        guild.detailMap = {
            [FORCE]: { hrid: FORCE, shrineHrid: '/guild_shrines/force', isCombat: true, sortIndex: 1 },
            [RARITY]: { hrid: RARITY, shrineHrid: '/guild_shrines/rarity', isCombat: true, sortIndex: 2 },
        };
        guild.levels = { [FORCE]: 3, [RARITY]: 0 };
        guild.caps = { [FORCE]: 9, [RARITY]: 1 };
        game.selfDTO = { ...emptyDTO('player1'), guildShrineLevels: { ...guild.levels }, guildCombatBuffs: [] };
        game.allPlayers.players[0] = { ...game.selfDTO };
    };

    const openEditor = async () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        await editor.initEditor({ restoreLoadout: false });
        return { el, editor };
    };

    /** The "3 / 9" text of one shrine row */
    const row = (el, buffHrid) => el.querySelector(`[data-guild-buff="${buffHrid}"]`)?.parentElement?.textContent;

    describe('the guild’s built level is shown as a cap', () => {
        test('the purchased level reads against what the guild has built', async () => {
            withShrines();
            const { el } = await openEditor();

            expect(el.querySelector(`[data-guild-buff="${FORCE}"]`).value).toBe('3');
            expect(row(el, FORCE)).toContain('/ 9');
            // A shrine the guild built but nobody bought still shows the ceiling
            expect(row(el, RARITY)).toContain('/ 1');
        });

        test('the cap is text, not a second input — it is not the player’s to set', async () => {
            withShrines();
            const { el } = await openEditor();

            expect(el.querySelectorAll('[data-guild-buff]').length).toBe(2);
            const rowEl = el.querySelector(`[data-guild-buff="${FORCE}"]`).parentElement;
            expect(rowEl.querySelectorAll('input').length).toBe(1);
        });

        test('the box can still be typed past the cap — that is the what-if', async () => {
            withShrines();
            const { el } = await openEditor();

            // max is the buff's own ceiling, never the guild's
            expect(el.querySelector(`[data-guild-buff="${FORCE}"]`).getAttribute('max')).toBe('20');
        });

        test('a guild level nobody has heard from shows the purchased level alone', async () => {
            withShrines();
            guild.caps = { [FORCE]: null, [RARITY]: null };
            const { el } = await openEditor();

            expect(el.querySelector(`[data-guild-buff="${FORCE}"]`).value).toBe('3');
            expect(row(el, FORCE)).not.toContain('/');
        });

        test('an imported stranger gets no cap — this client cannot see their guild', async () => {
            withShrines();
            const { el, editor } = await openEditor();
            editor.importPlayers([{ ...emptyDTO('them'), guildShrineLevels: { [FORCE]: 7 } }], ['Stranger']);

            expect(el.querySelector(`[data-guild-buff="${FORCE}"]`).value).toBe('7');
            expect(row(el, FORCE)).not.toContain('/');
        });
    });

    describe('levels follow the game, edits do not', () => {
        test('a shrine bought after the panel opened is read on the next opening', async () => {
            withShrines();
            const { el, editor } = await openEditor();
            expect(el.querySelector(`[data-guild-buff="${FORCE}"]`).value).toBe('3');

            guild.levels = { [FORCE]: 6, [RARITY]: 0 };
            expect(editor.refreshFromGame()).toBe(true);

            expect(el.querySelector(`[data-guild-buff="${FORCE}"]`).value).toBe('6');
            expect(editor.getEditedDTOs().player1.guildShrineLevels[FORCE]).toBe(6);
        });

        test('a deliberately edited level survives — the scenario is the user’s work', async () => {
            withShrines();
            const { el, editor } = await openEditor();

            // "What would Force 9 buy me?"
            const input = el.querySelector(`[data-guild-buff="${FORCE}"]`);
            input.value = '9';
            input.dispatchEvent(new Event('change'));

            // The guild sells them Force 6 in the meantime
            guild.levels = { [FORCE]: 6, [RARITY]: 0 };
            editor.refreshFromGame();

            expect(editor.getEditedDTOs().player1.guildShrineLevels[FORCE]).toBe(9);
            expect(el.querySelector(`[data-guild-buff="${FORCE}"]`).value).toBe('9');
        });

        test('an untouched shrine still follows the game while another is edited', async () => {
            withShrines();
            const { el, editor } = await openEditor();
            const force = el.querySelector(`[data-guild-buff="${FORCE}"]`);
            force.value = '9';
            force.dispatchEvent(new Event('change'));

            guild.levels = { [FORCE]: 6, [RARITY]: 1 };
            editor.refreshFromGame();

            const levels = editor.getEditedDTOs().player1.guildShrineLevels;
            expect(levels[FORCE]).toBe(9);
            expect(levels[RARITY]).toBe(1);
        });

        test('nothing moved means no redraw, so a half-typed edit is not rebuilt', async () => {
            withShrines();
            const { editor } = await openEditor();

            expect(editor.refreshFromGame()).toBe(false);
        });

        test('the engine’s resolved buffs are rebuilt with the level, not just the number', async () => {
            withShrines();
            const { editor } = await openEditor();

            guild.levels = { [FORCE]: 6, [RARITY]: 0 };
            editor.refreshFromGame();

            expect(editor.getEditedDTOs().player1.guildCombatBuffs).toContainEqual({ from: FORCE, level: 6 });
        });

        test('a reading that never arrived does not zero the levels the DTO was built with', async () => {
            withShrines();
            const { editor } = await openEditor();

            guild.levels = {};
            editor.refreshFromGame();

            expect(editor.getEditedDTOs().player1.guildShrineLevels[FORCE]).toBe(3);
        });
    });

    describe('a saved reading says so', () => {
        test('a hydrated reading is labelled, and points at Reset to Me', async () => {
            withShrines();
            guild.snapshot = { capturedAt: Date.parse('2026-09-01T12:00:00Z'), hydrated: true };
            const { el } = await openEditor();

            expect(el.textContent).toContain('saved reading');
            expect(el.textContent).toContain('Reset to Me');
        });

        test('a live reading is not labelled at all', async () => {
            withShrines();
            const { el } = await openEditor();

            expect(el.textContent).not.toContain('saved reading');
        });
    });
});

describe('Fetch a party loadout', () => {
    const FETCH_BTN = '[data-fetch-loadout]';

    beforeEach(() => {
        game.battleParty = [
            { characterID: 'me', characterName: 'Milkman' },
            { characterID: 'a', characterName: 'Ally' },
            { characterID: 'b', characterName: 'Buddy' },
        ];
    });

    test('is not offered on a game build without View Loadout, and nothing is requested', async () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        await editor.initEditor();

        expect(el.querySelector(FETCH_BTN)).toBeNull();
        expect(await editor.fetchPartyMemberLoadout()).toBeNull();
        expect(viewLoadout.fetches).toEqual([]);
    });

    test('names the next member without a capture, and one click asks for that one member only', async () => {
        viewLoadout.available = true;
        viewLoadout.captured = { a: { capturedAt: 1 } };
        viewLoadout.result = { status: 'done', entry: { characterId: 'b', name: 'Buddy', hasLoadout: true } };
        game.allPlayers.profileStatus = [
            {
                hrid: 'player2',
                name: 'Partner',
                found: true,
                capturedAt: Date.now(),
                gearless: false,
                gearSource: 'loadout',
                loadoutCapturedAt: Date.now(),
            },
        ];
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        await editor.initEditor();

        expect(el.querySelector(FETCH_BTN).textContent).toBe("Fetch Buddy's loadout (1/2)");
        el.querySelector(FETCH_BTN).click();
        await vi.waitFor(() => expect(el.textContent).toContain("Fetched Buddy's party loadout."));

        expect(viewLoadout.fetches).toEqual([
            { member: { characterID: 'b', characterName: 'Buddy' }, context: 'party', kind: '' },
        ]);
        expect(el.textContent).toContain('(party loadout,');
        expect(el.querySelector('[data-edit-tab="player2"]').getAttribute('title')).toContain(
            'gear from party loadout'
        );
    });

    test('offers a refetch of the oldest capture once everyone has one', async () => {
        viewLoadout.available = true;
        viewLoadout.captured = { a: { capturedAt: 50 }, b: { capturedAt: 10 } };
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        await editor.initEditor();

        expect(el.querySelector(FETCH_BTN).textContent).toBe("Refetch Buddy's loadout (2/2)");
    });

    test('says so when the member did not answer', async () => {
        viewLoadout.available = true;
        viewLoadout.result = { status: 'no_reply', entry: null };
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        await editor.initEditor();

        const reset = vi.spyOn(editor, 'resetToParty');
        await editor.fetchPartyMemberLoadout();
        expect(el.textContent).toContain("No reply for Ally's loadout.");
        // Nothing arrived, so the user's editor changes stay
        expect(reset).not.toHaveBeenCalled();
    });

    test('a scenario change while the fetch is pending is not overwritten by its reply', async () => {
        // Regression: fetchPartyMemberLoadout's own character-switch guard did
        // not cover the user importing players, resetting to self, or opening
        // an external DTO while the reply was still out — a successful reply
        // called resetToParty() unconditionally and threw the newer scenario away.
        viewLoadout.available = true;
        viewLoadout.hang = true;
        viewLoadout.result = { status: 'done', entry: { characterId: 'a', name: 'Ally', hasLoadout: true } };
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        await editor.initEditor();

        const reset = vi.spyOn(editor, 'resetToParty');
        const fetchPromise = editor.fetchPartyMemberLoadout();

        // The user moves on to a different scenario before the reply lands
        editor.importPlayers([emptyDTO('stranger1')], ['Stranger A']);
        const importedNames = editor._editedPlayerInfo.map((p) => p.name);

        viewLoadout.pendingResolve();
        await fetchPromise;

        expect(reset).not.toHaveBeenCalled();
        // The imported roster is still what is loaded — resetToParty must not
        // have overwritten it with the party the fetch was originally for
        expect(editor._editedPlayerInfo.map((p) => p.name)).toEqual(importedNames);
        // The discarded reply still redraws: the import drew mid-fetch, so its
        // "Fetching…" note and disabled Fetch state must not linger
        expect(el.textContent).not.toContain('Fetching');
        expect(editor._loadoutFetchNote).toBe('');
    });

    test('is not offered solo', async () => {
        viewLoadout.available = true;
        game.battleParty = null;
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        await editor.initEditor();

        expect(el.querySelector(FETCH_BTN)).toBeNull();
    });
});

describe('onRender: the owner follows the roster', () => {
    test('fires after every render, including the one an import makes, and sees the new roster', () => {
        const el = document.createElement('div');
        const seen = [];
        const editor = new SimEditor({
            editorEl: el,
            onRender: () => seen.push((editor.getPlayerInfo() || []).length),
        });

        editor.importPlayers([emptyDTO('x'), emptyDTO('y')], ['Stranger A', 'Stranger B']);
        expect(seen.at(-1)).toBe(2);

        editor.renderEditor();
        expect(seen.length).toBeGreaterThanOrEqual(2);
    });

    test('a listener that throws does not break the editor', () => {
        const el = document.createElement('div');
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const editor = new SimEditor({
            editorEl: el,
            onRender: () => {
                throw new Error('boom');
            },
        });

        expect(() => editor.importPlayers([emptyDTO('x')], ['Stranger A'])).not.toThrow();
        expect(el.innerHTML).not.toBe('');
        error.mockRestore();
    });
});

/**
 * Export: the button next to "+ Import" copies a build in the same format
 * Import accepts, so it round-trips. `buildShykaiExportPlayer` itself (and
 * the round trip through `parseShykaiImport`) is exercised in
 * combat-sim-adapter.test.js; this only checks the editor picks the right
 * player(s), copies the right text, and says so on screen.
 */
describe('Export', () => {
    let writeText;

    beforeEach(() => {
        writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    });

    afterEach(() => {
        delete navigator.clipboard;
    });

    test('copies only the active player, in the format buildShykaiExportPlayer produces', async () => {
        const { editor } = editorWithStrangers(); // x, y imported → active is the last one, player2/"Stranger B"
        game.buildExport = (dto) => ({ marker: dto.hrid });

        await editor._exportActivePlayer();

        expect(writeText).toHaveBeenCalledTimes(1);
        expect(JSON.parse(writeText.mock.calls[0][0])).toEqual({ marker: 'player2' });
    });

    test('shows a confirmation naming the player once copied', async () => {
        const { el, editor } = editorWithStrangers();
        await editor._exportActivePlayer();
        expect(el.textContent).toMatch(/Copied Stranger B'?s build/);
    });

    test('Export Party copies every loaded player, keyed by their slot number', async () => {
        const { editor } = editorWithStrangers();
        game.buildExport = (dto, name) => ({ marker: dto.hrid, name });

        await editor._exportParty();

        expect(writeText).toHaveBeenCalledTimes(1);
        const payload = JSON.parse(writeText.mock.calls[0][0]);
        expect(Object.keys(payload).sort()).toEqual(['1', '2']);
        expect(JSON.parse(payload['1'])).toEqual({ marker: 'player1', name: 'Stranger A' });
        expect(JSON.parse(payload['2'])).toEqual({ marker: 'player2', name: 'Stranger B' });
    });

    test('exports the synced build, not a stale _editedDTOs snapshot (a house room built after the panel opened)', async () => {
        const { editor } = editorWithStrangers();
        game.selfDTO.houseRooms = { '/house_rooms/dojo': 2 };
        editor.resetToSelf();
        // The House tab builds Dojo 3 while the panel is open — getEditedDTOs()
        // folds this in (see the "house rooms follow the game" tests); Export
        // must go through the same sync rather than reading `_editedDTOs` raw.
        game.houseRooms = new Map([['/house_rooms/dojo', { houseRoomHrid: '/house_rooms/dojo', level: 3 }]]);
        game.buildExport = (dto) => ({ houseRooms: dto.houseRooms });

        await editor._exportActivePlayer();

        expect(JSON.parse(writeText.mock.calls[0][0])).toEqual({ houseRooms: { '/house_rooms/dojo': 3 } });
    });

    test('Export Party also exports the synced build for every loaded player', async () => {
        const { editor } = editorWithStrangers();
        game.selfDTO.houseRooms = { '/house_rooms/dojo': 2 };
        editor.resetToSelf();
        game.houseRooms = new Map([['/house_rooms/dojo', { houseRoomHrid: '/house_rooms/dojo', level: 3 }]]);
        game.buildExport = (dto) => ({ houseRooms: dto.houseRooms });

        await editor._exportParty();

        const payload = JSON.parse(writeText.mock.calls[0][0]);
        expect(JSON.parse(payload['1'])).toEqual({ houseRooms: { '/house_rooms/dojo': 3 } });
    });

    test('the Export Party button only appears once more than one player is loaded', () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        editor.importPlayers([emptyDTO('solo')], ['Solo']);
        expect(el.querySelector('#mwi-csim-export-party-btn')).toBeNull();

        editor.importPlayers([emptyDTO('second')], ['Second']);
        expect(el.querySelector('#mwi-csim-export-party-btn')).toBeTruthy();
    });

    test('falls back to showing the export text when the clipboard write fails', async () => {
        // A denied permission or an insecure context rejects rather than being
        // absent; happy-dom has no working document.execCommand either, so the
        // textarea-copy fallback fails too and the last resort must kick in.
        writeText.mockRejectedValue(new Error('denied'));
        const { el, editor } = editorWithStrangers();

        await editor._exportActivePlayer();

        expect(el.textContent).toContain('Could not copy automatically');
        expect(el.querySelector('textarea[readonly]')).toBeTruthy();
    });
});

/**
 * Replacing one party member via import.
 *
 * "+ Import" used to only ever append a new player. This is the other half:
 * put an imported build into an already-loaded slot, in place, without
 * touching anyone else in the party or moving anyone's tab.
 */
describe('replacing one party member via import', () => {
    function fullParty() {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        editor.importPlayers(
            [emptyDTO('a'), emptyDTO('b'), emptyDTO('c'), emptyDTO('d'), emptyDTO('e')],
            ['A', 'B', 'C', 'D', 'E']
        );
        return { el, editor };
    }

    test('keeps the slot position and leaves every other loaded player untouched', () => {
        const { editor } = fullParty();
        const hridsBefore = editor._editedPlayerInfo.map((p) => p.hrid);
        const othersBefore = hridsBefore
            .filter((hrid) => hrid !== 'player3')
            .map((hrid) => structuredClone(editor._editedDTOs[hrid]));

        // Same level as everyone else, so the replacement itself introduces no
        // level-gap recompute for this test to have to account for — that is
        // covered on its own in "level-gap debuffs follow the roster" below.
        const ok = editor.replacePlayer('player3', { ...emptyDTO('ignored'), marker: 'new-build' }, 'Replacement', []);

        expect(ok).toBe(true);
        // Same five slots, same order
        expect(editor._editedPlayerInfo.map((p) => p.hrid)).toEqual(hridsBefore);
        expect(editor._editedPlayerInfo.find((p) => p.hrid === 'player3').name).toBe('Replacement');
        expect(editor._editedDTOs.player3.marker).toBe('new-build');
        expect(editor._editedDTOs.player3.hrid).toBe('player3'); // the imported DTO takes the slot's own hrid

        const othersAfter = hridsBefore.filter((hrid) => hrid !== 'player3').map((hrid) => editor._editedDTOs[hrid]);
        expect(othersAfter).toEqual(othersBefore);
    });

    test('replacing yourself clears selfHrid, so the live house/shrine sync stops touching that slot', () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        editor.resetToSelf();
        expect(editor.getSelfHrid()).toBe('player1');

        editor.replacePlayer('player1', emptyDTO('ignored'), 'Someone Else');

        expect(editor.getSelfHrid()).toBeNull();
    });

    test('refuses a slot that is not currently loaded', () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        expect(editor.replacePlayer('player9', emptyDTO('x'), 'X')).toBe(false);
    });

    test('the import area offers "Replace <name>" for whichever chip is selected', () => {
        const { el } = editorWithStrangers(); // active player is "Stranger B"
        expect(el.textContent).toContain('Replace Stranger B');
    });

    test('clicking Replace puts the pasted build in the active slot only', () => {
        const { el, editor } = editorWithStrangers(); // active: player2 / "Stranger B"
        game.parseImport = () => ({
            players: [{ ...emptyDTO('ignored'), attackLevel: 123 }],
            names: ['Replacement'],
            skipped: [],
        });
        el.querySelector('#mwi-csim-import-text').value = 'whatever';
        el.querySelector('#mwi-csim-import-replace').click();

        expect(editor._editedPlayerInfo.map((p) => p.hrid)).toEqual(['player1', 'player2']);
        expect(editor._editedPlayerInfo[1].name).toBe('Replacement');
        expect(editor._editedDTOs.player2.attackLevel).toBe(123);
        expect(editor._editedDTOs.player1.hrid).toBe('player1');
    });

    test('a multi-player paste attributes skipped equipment to the player actually used, not every pasted slot', () => {
        const { el, editor } = editorWithStrangers(); // active: player2
        game.parseImport = () => ({
            // The first non-empty parsed slot was slot 3 (a party export can
            // start anywhere) — result.players[0] carries that as its hrid.
            players: [{ ...emptyDTO('player3'), attackLevel: 55 }],
            names: ['Replacement'],
            skipped: [
                { slot: 3, itemHrid: '/items/used_slot_drop', itemName: 'Used Slot Drop', itemLocationHrid: null },
                { slot: 5, itemHrid: '/items/other_slot_drop', itemName: 'Other Slot Drop', itemLocationHrid: null },
            ],
        });
        el.querySelector('#mwi-csim-import-text').value = 'whatever';
        el.querySelector('#mwi-csim-import-replace').click();

        // Only the used slot's own skip is attributed to the replaced player;
        // slot 5's (never used here) must not show up as "not equipped" on
        // a player who never carried it. Tagged with the editor's own hrid
        // (player2, the replaced slot), not the pasted export's slot number.
        expect(editor._importSkipped).toEqual([
            {
                slot: 3,
                itemHrid: '/items/used_slot_drop',
                itemName: 'Used Slot Drop',
                itemLocationHrid: null,
                hrid: 'player2',
            },
        ]);
    });

    test("replacing a slot drops that slot's own prior skipped-equipment note", () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        editor.importPlayers(
            [emptyDTO('player1'), emptyDTO('player2')],
            ['A', 'B'],
            [{ slot: 1, itemHrid: '/items/old_blade', itemName: 'Old Blade', itemLocationHrid: null }]
        );
        expect(el.textContent).toContain('Old Blade');

        // A clean replacement of player1 (nothing skipped this time) must not
        // still warn about the build it replaced.
        editor.replacePlayer('player1', emptyDTO('ignored'), 'Fresh A', []);

        expect(el.textContent).not.toContain('Old Blade');
        expect(editor._importSkipped.some((entry) => entry.hrid === 'player1')).toBe(false);
    });

    test("replacing one slot leaves another slot's own skipped-equipment note alone", () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        editor.importPlayers(
            [emptyDTO('player1'), emptyDTO('player2')],
            ['A', 'B'],
            [{ slot: 2, itemHrid: '/items/kept_charm', itemName: 'Kept Charm', itemLocationHrid: null }]
        );

        editor.replacePlayer('player1', emptyDTO('ignored'), 'Fresh A', []);

        expect(el.textContent).toContain('Kept Charm');
        expect(editor._importSkipped.some((entry) => entry.hrid === 'player2')).toBe(true);
    });

    test('clicking "Add as new member" appends instead of replacing', () => {
        const { el, editor } = editorWithStrangers();
        game.parseImport = () => ({ players: [emptyDTO('ignored')], names: ['Newcomer'], skipped: [] });
        el.querySelector('#mwi-csim-import-text').value = 'whatever';
        el.querySelector('#mwi-csim-import-go').click();

        expect(editor._editedPlayerInfo.map((p) => p.name)).toEqual(['Stranger A', 'Stranger B', 'Newcomer']);
    });

    test('a 6th member is refused, not silently dropped, once the party is full', () => {
        const { el, editor } = fullParty();

        const importGo = el.querySelector('#mwi-csim-import-go');
        expect(importGo.disabled).toBe(true);
        expect(importGo.getAttribute('title')).toContain('replace one instead');

        game.parseImport = () => ({ players: [emptyDTO('f')], names: ['F'], skipped: [] });
        el.querySelector('#mwi-csim-import-text').value = 'whatever';
        importGo.click();

        expect(editor._editedPlayerInfo.length).toBe(5);
    });

    test('the in-handler cap check also refuses an import that would push the party over 5', () => {
        // Belt and suspenders on the button's own disabled state: an import
        // bringing more than one player at once (a multi-slot paste) must be
        // capped even from a party that had room for fewer than it delivers.
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        editor.importPlayers([emptyDTO('a'), emptyDTO('b'), emptyDTO('c')], ['A', 'B', 'C']);
        game.parseImport = () => ({
            players: [emptyDTO('d'), emptyDTO('e'), emptyDTO('f')],
            names: ['D', 'E', 'F'],
            skipped: [],
        });
        el.querySelector('#mwi-csim-import-text').value = 'whatever';
        el.querySelector('#mwi-csim-import-go').click();

        expect(editor._editedPlayerInfo.length).toBe(3);
        expect(el.querySelector('#mwi-csim-import-error').textContent).toContain('replace a member instead');
    });
});

/**
 * Level-gap debuffs follow the roster.
 *
 * The debuff is measured against whoever in the party is highest level, so
 * replacing, adding or removing a player can move who that is — and every
 * other member's `debuffOnLevelGap`, computed for the *old* roster, must not
 * survive the change unchanged. This is also the fix for "Export Party →
 * Import drops every penalty": the export carries no `debuffOnLevelGap` at
 * all (parseShykaiImport always inits it to 0), and importPlayers recomputes
 * it fresh from the actually-imported roster's own levels rather than
 * carrying a stale — or, on straight import, entirely absent — value.
 */
describe('level-gap debuffs follow the roster', () => {
    const highLevelDTO = (hrid) => ({ ...emptyDTO(hrid), attackLevel: 100, meleeLevel: 100 });

    test('importing a party recomputes every member — the "Export Party → Import" round trip', () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });

        // As a fresh import always arrives: parseShykaiImport never carries
        // debuffOnLevelGap, so every DTO starts at 0 regardless of what the
        // export (if any) said.
        editor.importPlayers(
            [
                { ...emptyDTO('low'), debuffOnLevelGap: 0 },
                { ...highLevelDTO('high'), debuffOnLevelGap: 0 },
            ],
            ['Low', 'High']
        );

        const low = editor._editedDTOs.player1;
        const high = editor._editedDTOs.player2;
        expect(low.debuffOnLevelGap).toBeLessThan(0);
        expect(high.debuffOnLevelGap).toBe(0);
    });

    test('replacing a player with a much higher level one recomputes the rest of the party', () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        editor.importPlayers([emptyDTO('a'), emptyDTO('b')], ['A', 'B']);
        expect(editor._editedDTOs.player1.debuffOnLevelGap).toBe(0); // equal levels: no gap yet

        editor.replacePlayer('player2', highLevelDTO('ignored'), 'Replacement');

        // player1 is now far below the replacement — the penalty must show
        // up on the untouched player, not just the one that was replaced.
        expect(editor._editedDTOs.player1.debuffOnLevelGap).toBeLessThan(0);
    });

    test('removing the highest-level player lifts the penalty off whoever remains', () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        editor.importPlayers([emptyDTO('low'), highLevelDTO('high')], ['Low', 'High']);
        expect(editor._editedDTOs.player1.debuffOnLevelGap).toBeLessThan(0);

        el.querySelector('[data-remove-player="player2"]').click();

        expect(editor._editedDTOs.player1.debuffOnLevelGap).toBe(0);
    });
});

/**
 * Export, Export Party and the "Replace <name>" import option are all
 * backed by parseShykaiImport / buildShykaiExportPlayer, which only round
 * trips combat fields. The skilling editor's own player carries skilling
 * skill levels, token upgrades and community buff levels that format has no
 * room for — offering any of the three there would silently drop them.
 */
describe('Export/Replace are combat-only and hidden in skillingMode', () => {
    test('the skilling editor offers no Export, Export Party or Replace, but still offers Import', () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el, skillingMode: true });
        editor.resetToSelf();

        expect(el.querySelector('#mwi-csim-export-btn')).toBeNull();
        expect(el.querySelector('#mwi-csim-export-party-btn')).toBeNull();
        expect(el.querySelector('#mwi-csim-import-replace')).toBeNull();
        expect(el.querySelector('#mwi-csim-import-btn')).toBeTruthy();
    });

    test('an ordinary combat editor still offers all three', () => {
        const { el } = editorWithStrangers();

        expect(el.querySelector('#mwi-csim-export-btn')).toBeTruthy();
        expect(el.querySelector('#mwi-csim-export-party-btn')).toBeTruthy();
        expect(el.querySelector('#mwi-csim-import-replace')).toBeTruthy();
    });
});

/**
 * Every hrid this editor hands out must stay inside the 1-5 range Export
 * Party and parseShykaiImport agree on — the parser's own multi-slot loop
 * only ever reads keys "1" through "5", so a player landed on "6" (removing
 * a lower slot, then adding one, used to always continue from max+1) was
 * exported under a key re-import silently ignores, dropping that player.
 */
describe('imported players fill vacant slots, never past 5', () => {
    test('removing a lower slot then adding a member reuses the vacant slot, not max+1', () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        editor.importPlayers(
            [emptyDTO('a'), emptyDTO('b'), emptyDTO('c'), emptyDTO('d'), emptyDTO('e')],
            ['A', 'B', 'C', 'D', 'E']
        );
        el.querySelector('[data-remove-player="player1"]').click();
        expect(editor._editedPlayerInfo.map((p) => p.hrid)).toEqual(['player2', 'player3', 'player4', 'player5']);

        editor.importPlayers([emptyDTO('ignored')], ['Newcomer']);

        // Lands on the vacant player1, not player6
        expect(editor._editedPlayerInfo.map((p) => p.hrid)).toEqual([
            'player2',
            'player3',
            'player4',
            'player5',
            'player1',
        ]);
        expect(editor._editedDTOs.player1.hrid).toBe('player1');
        expect(editor._editedDTOs.player6).toBeUndefined();
    });

    test('a removed player’s notes do not resurface on a newcomer that reuses their slot', () => {
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        // Real parseShykaiImport output names each DTO player<slot> before
        // importPlayers reassigns it — matched here so the skipped entry's
        // slot number tags the right hrid, the same as production.
        editor.importPlayers(
            [emptyDTO('player1'), emptyDTO('player2')],
            ['A', 'B'],
            [{ slot: 1, itemHrid: '/items/old_gear', itemName: 'Old Gear', itemLocationHrid: null }]
        );
        expect(el.textContent).toContain('Old Gear');

        el.querySelector('[data-remove-player="player1"]').click();
        editor.importPlayers([emptyDTO('ignored')], ['Newcomer']); // reuses player1

        expect(editor._editedPlayerInfo.find((p) => p.hrid === 'player1').name).toBe('Newcomer');
        expect(el.textContent).not.toContain('Old Gear');
    });

    test('Export Party writes compacted 1..N keys even after a remove-then-add', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        const el = document.createElement('div');
        const editor = new SimEditor({ editorEl: el });
        editor.importPlayers(
            [emptyDTO('a'), emptyDTO('b'), emptyDTO('c'), emptyDTO('d'), emptyDTO('e')],
            ['A', 'B', 'C', 'D', 'E']
        );
        el.querySelector('[data-remove-player="player1"]').click();
        editor.importPlayers([emptyDTO('ignored')], ['Newcomer']);
        game.buildExport = (dto, name) => ({ name });

        await editor._exportParty();

        const payload = JSON.parse(writeText.mock.calls[0][0]);
        expect(Object.keys(payload).sort()).toEqual(['1', '2', '3', '4', '5']);
        delete navigator.clipboard;
    });
});
