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

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    characterData: { character: { id: 'me', name: 'Milkman' } },
    selfDTO: null,
    allPlayers: null,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterData() {
            return game.characterData;
        },
        getInitClientData: () => ({ itemDetailMap: {}, abilityDetailMap: {} }),
        getItemDetails: () => null,
    },
}));

vi.mock('./combat-sim-adapter.js', () => ({
    buildGameDataPayload: () => ({ itemDetailMap: {}, abilityDetailMap: {}, houseRoomDetailMap: {} }),
    buildAllPlayerDTOs: async () => game.allPlayers,
    buildPlayerDTO: () => (game.selfDTO ? structuredClone(game.selfDTO) : null),
    parseShykaiImport: () => null,
    applyLoadoutSnapshotToDTO: () => true,
    getGuildBuffDetailMap: () => ({}),
    guildBuffMaxLevel: () => 0,
    applyGuildBuffLevel: (buffs) => buffs,
}));

// This bundle's own (direct-import) copy of the store. In the packaged build it
// is never fed by the websocket, so it answers empty — the bug this guards.
vi.mock('../combat/loadout-snapshot.js', () => ({
    default: { getAllSnapshots: () => [], resolveEquipment: () => [] },
}));

// The fed store lives behind the bundle bridge; the picker must read it there.
const bridge = vi.hoisted(() => ({ snapshots: [] }));
vi.mock('../../utils/bundle-bridge.js', () => ({
    loadoutSnapshot: () => ({ getAllSnapshots: () => bridge.snapshots, resolveEquipment: () => [] }),
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

/** An editor with two imported strangers loaded and nothing of the player's own */
function editorWithStrangers() {
    const el = document.createElement('div');
    const editor = new SimEditor({ editorEl: el });
    editor.importPlayers([emptyDTO('x'), emptyDTO('y')], ['Stranger A', 'Stranger B']);
    return { el, editor };
}

beforeEach(() => {
    bridge.snapshots = [];
    game.characterData = { character: { id: 'me', name: 'Milkman' } };
    game.selfDTO = { ...emptyDTO('player1'), attackLevel: 90, debuffOnLevelGap: 0.3 };
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

    test('a player with no achievement buffs shows no section', () => {
        const editor = new SimEditor({ editorEl: document.createElement('div') });
        expect(editor._renderAchievementsSection({ achievementCombatBuffs: [] })).toBe('');
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
        const dto = { achievementBuffsOff: [] };

        editor._wireEditorEvents(el, dto);
        const dmg = el.querySelector('[data-achievement-buff="/buff_types/damage"]');
        dmg.checked = false;
        dmg.dispatchEvent(new Event('change'));

        expect(dto.achievementBuffsOff).toEqual(['/buff_types/damage']);

        dmg.checked = true;
        dmg.dispatchEvent(new Event('change'));
        expect(dto.achievementBuffsOff).toEqual([]);
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
