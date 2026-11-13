/** @vitest-environment happy-dom
 *
 * The Belt's talisman rows in the Combat Sim editor are editable. The worst outcome is the edit landing on the wrong
 * player (a party member's edit on the local player), or an edit the engine does not see. Each is checked here.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    gameData: null,
    slotted: [],
    testServer: true,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        characterData: { character: { id: 'me', name: 'Me' } },
        getCurrentCharacterId: () => 'me',
        getCurrentActions: () => [],
        getInitClientData: () => ({}),
        getItemDetails: () => null,
        getHouseRooms: () => null,
        getLearnedAbilities: () => [],
        getSkills: () => null,
        getEquipment: () => new Map(),
        getPartyMembers: () => ({ members: [], source: 'none', updatedAt: null }),
        getSlottedTalismans: () => game.slotted.map((t) => structuredClone(t)),
    },
}));
vi.mock('./combat-sim-adapter.js', () => ({
    seedSimPriceCache: (cache) => cache,
    buildGameDataPayload: () => game.gameData,
    buildAllPlayerDTOs: async () => null,
    buildPlayerDTO: () => null,
    parseShykaiImport: () => null,
    buildShykaiExportPlayer: (dto, name) => ({ name, dto }),
    applyLoadoutSnapshotToDTO: () => false,
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
    readScoped: async (_base, _store, defaultValue = null) => defaultValue,
    writeScoped: async () => {},
}));
vi.mock('../../utils/bundle-bridge.js', () => ({
    marketUndercutAlerts: () => null,
    marketDepthCap: () => null,
    guildMemberSkills: () => null,
    loadoutSnapshot: () => ({ getAllSnapshots: () => [], getSnapshotById: () => null, resolveEquipment: () => [] }),
}));
vi.mock('../../utils/view-loadout.js', () => ({
    VIEW_LOADOUT_CONTEXT: { Party: 'party', GuildTrial: 'guild_trial' },
    isViewLoadoutAvailable: () => false,
    getLoadout: () => null,
    fetchLoadout: async () => null,
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../utils/game-server.js', async (importOriginal) => ({
    ...(await importOriginal()),
    isTestServer: () => game.testServer,
}));

const { SimEditor } = await import('./sim-editor.js');
const { default: Player } = await import('./engine/player.js');
const { setGameData } = await import('./engine/game-data.js');
const { BELT_ITEMS, TALISMAN_ENHANCEMENT_TABLE } = await import('../../__fixtures__/talisman-bonuses.js');
const { COMBAT_MODIFIER_DETAILS } = await import('../../__fixtures__/talisman-combat-modifiers.js');

const BELT = '/equipment_types/belt';
const ARMOR = '/talisman_modifiers/armor';
const HASTE = '/talisman_modifiers/ability_haste';
const SKILLING = '/talisman_modifiers/milking_speed';
const worn = (talismans) => talismans.map((t) => ({ ...t, id: 1, talismanTypeHrid: '/talisman_types/combat' }));

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

function dtoWith(hrid, beltHrid, talismans, level = 0) {
    const dto = emptyDTO(hrid);
    if (beltHrid) dto.equipment[BELT] = { hrid: beltHrid, enhancementLevel: level };
    if (talismans) dto.talismans = talismans;
    return dto;
}

function open(dtos) {
    const el = document.createElement('div');
    document.body.append(el);
    const editor = new SimEditor({ editorEl: el });
    editor.importPlayers(
        dtos,
        dtos.map((d) => d.hrid)
    );
    editor._activeEditPlayer = 'player1';
    editor.renderEditor();
    return { el, editor };
}

const rows = (el) => [...el.querySelectorAll('[data-talisman-type]')];
const pick = (select, value) => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
};

beforeEach(() => {
    document.body.innerHTML = '';
    game.testServer = true;
    game.slotted = [];
    game.gameData = {
        itemDetailMap: {
            ...BELT_ITEMS,
            '/items/test_body': { name: 'Body', equipmentDetail: { type: '/equipment_types/body' } },
        },
        abilityDetailMap: {},
        houseRoomDetailMap: {},
        enhancementLevelTotalBonusMultiplierTable: TALISMAN_ENHANCEMENT_TABLE,
        talismanModifierDetailMap: {
            ...COMBAT_MODIFIER_DETAILS,
            [SKILLING]: {
                hrid: SKILLING,
                name: 'Milking Speed',
                talismanTypeHrid: '/talisman_types/skilling',
                targetHrid: '/talisman_modifier_targets/noncombat_stat',
                keys: ['MilkingSpeed'],
                isPercent: true,
                gradeValues: [0.03, 0.045, 0.06, 0.075, 0.09, 0.12],
            },
        },
        talismanInfo: { maxGrade: 6, maxModifierCount: 4 },
        talismansEnabled: true,
    };
});

describe('editable belt talismans', () => {
    test('a large belt with three talismans, a duplicate type across them and a G6, seeded from the player', () => {
        const { el } = open([
            dtoWith(
                'player1',
                '/items/large_talisman_belt',
                worn([
                    { slotIndex: 1, modifiers: [{ hrid: ARMOR, grade: 6 }] },
                    { slotIndex: 2, modifiers: [{ hrid: ARMOR, grade: 2 }] },
                    { slotIndex: 3, modifiers: [{ hrid: HASTE, grade: 1 }] },
                ])
            ),
        ]);
        expect(rows(el).map((s) => s.querySelector('option[selected]').value)).toEqual([ARMOR, ARMOR, HASTE]);
        expect(
            [...el.querySelectorAll('[data-talisman-grade]')].map((s) => s.querySelector('option[selected]').value)
        ).toEqual(['6', '2', '1']);
        expect(el.querySelector('[data-talisman-value="1:0"]').textContent).toBe('+9.6');
        expect(el.querySelectorAll('[data-talisman-add]')).toHaveLength(3);
    });

    test('no belt, and a belt off the test server, show no talisman rows', () => {
        expect(open([dtoWith('player1', null, null)]).el.querySelector('[data-talisman-reset]')).toBeNull();
        game.testServer = false;
        const { el } = open([dtoWith('player1', '/items/large_talisman_belt', null)]);
        expect(el.querySelector('[data-talisman-reset]')).toBeNull();
    });

    test('an empty slot can be given a talisman; a fresh line offers no type already on that talisman', () => {
        const { el, editor } = open([dtoWith('player1', '/items/medium_talisman_belt', null)]);
        expect(el.querySelectorAll('[data-talisman-add]')).toHaveLength(2);
        el.querySelector('[data-talisman-add="2"]').click();
        const dto = editor.getEditedDTOs().player1;
        expect(dto.talismans).toHaveLength(1);
        expect(dto.talismans[0].slotIndex).toBe(2);
        expect(dto.talismans[0].modifiers).toHaveLength(1);
        el.querySelector('[data-talisman-add="2"]').click();
        const types = editor.getEditedDTOs().player1.talismans[0].modifiers.map((m) => m.hrid);
        expect(new Set(types).size).toBe(2);
        // the type list of the first line leaves out the type the second line holds
        const first = rows(el)[0];
        expect([...first.options].map((o) => o.value)).not.toContain(types[1]);
    });

    test('four lines is the limit', () => {
        const { el, editor } = open([dtoWith('player1', '/items/small_talisman_belt', null)]);
        for (let i = 0; i < 6; i++) el.querySelector('[data-talisman-add="1"]')?.click();
        expect(editor.getEditedDTOs().player1.talismans[0].modifiers).toHaveLength(4);
        expect(el.querySelector('[data-talisman-add="1"]').disabled).toBe(true);
    });

    test('changing type and grade edits dto.talismans and the shown value follows the belt power', () => {
        const { el, editor } = open([
            dtoWith(
                'player1',
                '/items/large_talisman_belt',
                worn([{ slotIndex: 1, modifiers: [{ hrid: ARMOR, grade: 1 }] }])
            ),
        ]);
        pick(el.querySelector('[data-talisman-grade="1:0"]'), '6');
        pick(el.querySelector('[data-talisman-type="1:0"]'), HASTE);
        expect(editor.getEditedDTOs().player1.talismans[0].modifiers).toEqual([{ hrid: HASTE, grade: 6 }]);
        // Ability Haste G6 = 4, scaled by the +0 large belt (power 0.2)
        expect(el.querySelector('[data-talisman-value="1:0"]').textContent).toBe('+4.8');
        // belt level rescales the shown value without losing the lines
        const level = el.querySelector('input[data-enhance-slot="/equipment_types/belt"]');
        level.value = '10';
        level.dispatchEvent(new Event('change', { bubbles: true }));
        expect(el.querySelector('[data-talisman-value="1:0"]').textContent).toBe('+5.03');
    });

    test('a belt swapped to fewer slots hides the extra slot but keeps it; the engine ignores it', () => {
        const { el, editor } = open([
            dtoWith(
                'player1',
                '/items/large_talisman_belt',
                worn([
                    { slotIndex: 1, modifiers: [{ hrid: ARMOR, grade: 1 }] },
                    { slotIndex: 3, modifiers: [{ hrid: ARMOR, grade: 6 }] },
                ])
            ),
        ]);
        const dto = editor.getEditedDTOs().player1;
        dto.equipment[BELT] = { hrid: '/items/small_talisman_belt', enhancementLevel: 0 };
        editor.renderEditor();
        expect(rows(el)).toHaveLength(1);
        expect(editor.getEditedDTOs().player1.talismans).toHaveLength(2);
        setGameData({ ...game.gameData, talismansEnabled: true });
        const player = Player.createFromDTO({ ...editor.getEditedDTOs().player1, food: [], drinks: [] });
        player.updateCombatDetails();
        // only the slot-1 G1 armor line (small belt power 0.1) counts
        expect(player.combatDetails.combatStats.armor).toBeCloseTo(COMBAT_MODIFIER_DETAILS[ARMOR].gradeValues[0] * 1.1);
    });

    test('an edit reaches the engine like a real talisman: G6 armor on two talismans adds', () => {
        const { el, editor } = open([
            dtoWith(
                'player1',
                '/items/large_talisman_belt',
                worn([{ slotIndex: 1, modifiers: [{ hrid: ARMOR, grade: 6 }] }])
            ),
        ]);
        el.querySelector('[data-talisman-add="2"]').click();
        pick(el.querySelector('[data-talisman-type="2:0"]'), ARMOR);
        pick(el.querySelector('[data-talisman-grade="2:0"]'), '6');
        setGameData({ ...game.gameData, talismansEnabled: true });
        const player = Player.createFromDTO({ ...editor.getEditedDTOs().player1, food: [], drinks: [] });
        player.updateCombatDetails();
        const g6 = COMBAT_MODIFIER_DETAILS[ARMOR].gradeValues[5];
        expect(player.combatDetails.combatStats.armor).toBeCloseTo(g6 * 2 * 1.2);
    });

    test('removing a line leaves a talisman with no lines; a skilling line already on the talisman is kept', () => {
        const { el, editor } = open([
            dtoWith(
                'player1',
                '/items/large_talisman_belt',
                worn([
                    {
                        slotIndex: 1,
                        modifiers: [
                            { hrid: SKILLING, grade: 3 },
                            { hrid: ARMOR, grade: 1 },
                        ],
                    },
                ])
            ),
        ]);
        expect(rows(el)[0].querySelector('option[selected]').value).toBe(SKILLING);
        el.querySelector('[data-talisman-remove="1:1"]').click();
        el.querySelector('[data-talisman-remove="1:0"]').click();
        expect(editor.getEditedDTOs().player1.talismans[0].modifiers).toEqual([]);
        expect(el.textContent).toContain('No lines');
    });

    test('editing a party member changes that member only', () => {
        const mine = dtoWith(
            'player1',
            '/items/large_talisman_belt',
            worn([{ slotIndex: 1, modifiers: [{ hrid: ARMOR, grade: 1 }] }])
        );
        const theirs = dtoWith(
            'player2',
            '/items/large_talisman_belt',
            worn([{ slotIndex: 1, modifiers: [{ hrid: ARMOR, grade: 1 }] }])
        );
        const { el, editor } = open([mine, theirs]);

        editor._activeEditPlayer = 'player2';
        editor.renderEditor();
        pick(el.querySelector('[data-talisman-grade="1:0"]'), '5');
        const dtos = editor.getEditedDTOs();
        expect(dtos.player2.talismans[0].modifiers[0].grade).toBe(5);
        expect(dtos.player1.talismans[0].modifiers[0].grade).toBe(1);
    });

    test("Reset to Current restores the player's own talismans, per player, and the label notes the edit", () => {
        const start = worn([{ slotIndex: 1, modifiers: [{ hrid: ARMOR, grade: 4 }] }]);
        const { el, editor } = open([
            dtoWith('player1', '/items/large_talisman_belt', start),
            dtoWith('player2', null, null),
        ]);
        expect(el.querySelector('[data-talisman-reset]').disabled).toBe(true);
        pick(el.querySelector('[data-talisman-grade="1:0"]'), '6');
        expect(editor.generateSimLabel('player1')).toContain('Talismans');
        expect(el.querySelector('[data-talisman-reset]').disabled).toBe(false);
        el.querySelector('[data-talisman-reset]').click();
        expect(editor.getEditedDTOs().player1.talismans[0].modifiers[0].grade).toBe(4);
        expect(editor.generateSimLabel('player1')).not.toContain('Talismans');
        // a player who started with none gets none back
        el.querySelector('[data-talisman-add="1"]');
    });

    test('a player built with no talismans field loads and resets to none', () => {
        const { el, editor } = open([dtoWith('player1', '/items/small_talisman_belt', null)]);
        el.querySelector('[data-talisman-add="1"]').click();
        el.querySelector('[data-talisman-reset]').click();
        expect(editor.getEditedDTOs().player1.talismans).toBeUndefined();
        expect(el.querySelectorAll('[data-talisman-type]')).toHaveLength(0);
    });

    test('junk in a saved list (not an array, null records, lines without a hrid) does not break the rows', () => {
        for (const talismans of [
            'x',
            [null, 5],
            [{ slotIndex: 1, modifiers: 'x' }],
            [{ slotIndex: 1, modifiers: [{}] }],
        ]) {
            const { el } = open([dtoWith('player1', '/items/large_talisman_belt', talismans)]);
            expect(el.querySelector('[data-talisman-reset]')).toBeTruthy();
            document.body.innerHTML = '';
        }
    });
});
