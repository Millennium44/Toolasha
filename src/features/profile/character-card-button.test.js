/** @vitest-environment happy-dom */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const game = vi.hoisted(() => ({
    characterId: 'char-1',
    characterData: { character: { id: 'char-1' } },
    snapshots: [],
    resolveScore: null,
    extraAuras: true,
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: vi.fn((key) => (key === 'characterCard_extraAuras' ? game.extraAuras : true)),
        onSettingChange: vi.fn(),
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterData() {
            return game.characterData;
        },
        getInitClientData: () => ({ itemDetailMap: {} }),
        getCurrentCharacterId: () => game.characterId,
    },
}));
vi.mock('./character-sheet.js', () => ({
    buildCharacterSheetLink: vi.fn(() => 'https://sheet.test/?urpt=x'),
}));
vi.mock('./score-calculator.js', () => ({
    calculateCombatScore: vi.fn(
        () =>
            new Promise((resolve) => {
                game.resolveScore = resolve;
            })
    ),
}));
vi.mock('../combat/loadout-snapshot.js', () => ({
    default: {
        getAllSnapshots: () => game.snapshots,
        resolveEquipment: () => [
            { itemLocationHrid: '/item_locations/main_hand', itemHrid: '/items/sword', enhancementLevel: 3 },
        ],
    },
}));

import loadoutSnapshot from '../combat/loadout-snapshot.js';
import { handleViewCardClick, handleViewCardFromSnapshot } from './character-card-button.js';
import { buildCharacterSheetLink } from './character-sheet.js';

function addModal() {
    const modal = document.createElement('div');
    modal.className = 'SharableProfile_modal__2OmCQ';
    document.body.appendChild(modal);
    return modal;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const profile = { profile: { characterName: 'Other', characterSkills: [] } };

describe('character card button', () => {
    beforeEach(() => {
        game.characterId = 'char-1';
        game.snapshots = [];
        game.resolveScore = null;
        game.characterData = { character: { id: 'char-1' } };
        game.extraAuras = true;
        vi.clearAllMocks();
        window.open = vi.fn();
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    test('opens the card when the same modal is still up after the score', async () => {
        addModal();
        const pending = handleViewCardClick(profile);
        await flush();
        game.resolveScore({ total: 123 });
        await pending;
        expect(window.open).toHaveBeenCalledTimes(1);
    });

    test('drops the result when the profile modal closed during the score await', async () => {
        const modal = addModal();
        const pending = handleViewCardClick(profile);
        await flush();
        modal.remove();
        game.resolveScore({ total: 123 });
        await pending;
        expect(window.open).not.toHaveBeenCalled();
    });

    test('drops the result when another profile modal replaced it during the await', async () => {
        const modal = addModal();
        const pending = handleViewCardClick(profile);
        await flush();
        modal.remove();
        addModal();
        game.resolveScore({ total: 123 });
        await pending;
        expect(window.open).not.toHaveBeenCalled();
    });

    test('drops the result when the character switched during the await', async () => {
        addModal();
        const pending = handleViewCardClick(profile);
        await flush();
        game.characterId = 'char-2';
        game.resolveScore({ total: 123 });
        await pending;
        expect(window.open).not.toHaveBeenCalled();
    });

    test('snapshot card is dropped when the character switched during the await', async () => {
        game.snapshots = [{ name: 'Main', equipment: [], abilities: [], food: [], drinks: [] }];
        const pending = handleViewCardFromSnapshot('Main');
        await flush();
        game.characterId = 'char-2';
        game.resolveScore({ total: 1 });
        await pending;
        expect(window.open).not.toHaveBeenCalled();
    });
    test('drops the result when the same modal root now shows a different profile', async () => {
        const modal = addModal();
        const name = document.createElement('div');
        name.className = 'CharacterName_characterName__x';
        name.textContent = 'Alice';
        modal.appendChild(name);
        const pending = handleViewCardClick(profile);
        await flush();
        name.textContent = 'Bob';
        game.resolveScore({ total: 123 });
        await pending;
        expect(window.open).not.toHaveBeenCalled();
    });

    test('snapshot card uses the selected id when two loadouts share a name', async () => {
        const mk = (id, item) => ({
            id,
            name: 'Same',
            equipment: [{ itemLocationHrid: '/item_locations/main_hand', itemHrid: item }],
            abilities: [],
            food: [],
            drinks: [],
        });
        game.snapshots = [mk('a', '/items/first'), mk('b', '/items/second')];
        const resolveEquipment = vi.fn(() => []);
        const origResolve = loadoutSnapshot.resolveEquipment;
        loadoutSnapshot.resolveEquipment = resolveEquipment;
        const pending = handleViewCardFromSnapshot('Same', 'b');
        await flush();
        game.resolveScore({ total: 1 });
        await pending;
        loadoutSnapshot.resolveEquipment = origResolve;
        expect(resolveEquipment).toHaveBeenCalledTimes(1);
        expect(resolveEquipment.mock.calls[0][0].id).toBe('b');
    });

    test('enriches only a verified own shared profile with current learned abilities and loadouts', async () => {
        game.characterData.characterAbilities = [{ abilityHrid: '/abilities/speed_aura', level: 30 }];
        game.characterData.characterLoadoutMap = { 1: { abilityMap: { 1: '/abilities/speed_aura' } } };
        const own = { profile: { sharableCharacter: { id: 'char-1', name: 'Me' }, equippedAbilities: [] } };
        const pending = handleViewCardClick(own);
        game.resolveScore({ total: 123 });
        await pending;
        const [, , card, , , , options] = buildCharacterSheetLink.mock.calls[0];
        expect(card.characterAbilities).toBe(game.characterData.characterAbilities);
        expect(card.characterLoadoutMap).toBe(game.characterData.characterLoadoutMap);
        expect(card.equippedAbilities).toBe(own.profile.equippedAbilities);
        expect(own.profile).not.toHaveProperty('characterAbilities');
        expect(options).toEqual({ includeLoadoutAuras: true });
    });

    test.each(['other', undefined])('never borrows local auras for a shared profile with id %s', async (id) => {
        game.characterData.character.name = 'Same';
        game.characterData.characterAbilities = [{ abilityHrid: '/abilities/speed_aura', level: 99 }];
        game.characterData.characterLoadoutMap = { 1: { abilityMap: { 1: '/abilities/speed_aura' } } };
        const other = { profile: { sharableCharacter: { id, name: 'Same' }, equippedAbilities: [] } };
        const pending = handleViewCardClick(other);
        game.resolveScore({ total: 1 });
        await pending;
        expect(buildCharacterSheetLink.mock.calls[0][2]).toBe(other.profile);
        expect(buildCharacterSheetLink.mock.calls[0][2]).not.toHaveProperty('characterAbilities');
    });

    test('checks the extra-aura setting again after the score await', async () => {
        const pending = handleViewCardClick();
        game.extraAuras = false;
        game.resolveScore({ total: 1 });
        await pending;
        expect(buildCharacterSheetLink.mock.calls[0][6]).toEqual({ includeLoadoutAuras: false });
    });

    test('snapshot exports preserve the current character’s learned/loadout data for extra auras', async () => {
        game.characterData.characterAbilities = [{ abilityHrid: '/abilities/mystic_aura', level: 30 }];
        game.characterData.characterLoadoutMap = { 1: { abilityMap: { 1: '/abilities/mystic_aura' } } };
        game.snapshots = [{ id: 1, name: 'Main', equipment: [], abilities: [], food: [], drinks: [] }];
        const pending = handleViewCardFromSnapshot('Main', 1);
        game.resolveScore({ total: 1 });
        await pending;
        const [, , card, , , , options] = buildCharacterSheetLink.mock.calls[0];
        expect(card.characterAbilities).toBe(game.characterData.characterAbilities);
        expect(card.characterLoadoutMap).toBe(game.characterData.characterLoadoutMap);
        expect(options).toEqual({ includeLoadoutAuras: true });
    });

    test.each([
        ['/action_types/foraging', false],
        ['/action_types/brewing', false],
        ['/action_types/combat', true],
        ['', true],
    ])('a %s loadout card gets extra auras: %s', async (actionTypeHrid, expected) => {
        game.snapshots = [
            { id: 1, name: 'Main', actionTypeHrid, equipment: [], abilities: [], food: [], drinks: [] },
            {
                id: 2,
                name: 'Main',
                actionTypeHrid: '/action_types/combat',
                equipment: [],
                abilities: [],
                food: [],
                drinks: [],
            },
        ];
        const pending = handleViewCardFromSnapshot('Main', 1);
        game.resolveScore({ total: 1 });
        await pending;
        expect(buildCharacterSheetLink.mock.calls[0][6]).toEqual({ includeLoadoutAuras: expected });
    });
});
