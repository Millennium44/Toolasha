/** @vitest-environment happy-dom */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const game = vi.hoisted(() => ({
    characterId: 'char-1',
    characterData: { character: { id: 'char-1' } },
    snapshots: [],
    resolveScore: null,
}));

vi.mock('../../core/config.js', () => ({ default: { getSetting: vi.fn(() => true), onSettingChange: vi.fn() } }));
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
});
